"use strict";
/**
 * 0.5.4: the zero-loss note-splitting engine — an INTERNAL module, not an MCP tool. An AI (the
 * memglow `split_plan` tool's own caller, deciding by hand, or memglow's own auto-split worker,
 * lib/auto-split.js, deciding on its own) picks HOW to split a note; this module applies that
 * decision safely and deterministically, and reproduces the hub-and-spoke convention exactly:
 *
 *   - The ORIGINAL note becomes the hub: same file, same slug, frontmatter kept BYTE-FOR-BYTE.
 *     Body = kept lines (its intro and any lines the plan keeps), then an optional AI-written
 *     summary, then a `## Parts` section, one line per part: `- [[part-slug]] — hook`. If the hub
 *     already has `## Parts`, new lines are appended to it.
 *   - Each part is a new note in the SAME directory: title, type: note, permalink (same scheme as
 *     write_note), name, theme/subtheme (or sous_theme — whichever key the hub itself uses)
 *     copied from the hub, description (from the plan), part_of: <hub>, tags copied from the hub.
 *     Body: `Up: [[<hub>]] — split on <date>: <description>.` then the moved content.
 *   - If the hub is ITSELF already a part (`part_of: X` in its own frontmatter), new parts get
 *     `part_of: X`, `Up: [[X]]`, and their bullet lines go to X's own `## Parts` instead — the hub
 *     being split does not grow a `## Parts` of its own (lib/hub-spoke.js's convention: a spoke
 *     never lists siblings).
 *
 * A plan: { parts: [{ slug, description, hook?, sections: [heading, …], lines?: [line, …] }],
 *           hub_summary?, dry_run? }
 *   - sections: exact heading TEXT (any level, "##".."######"); the WHOLE section (its heading
 *     plus everything up to the next heading of the same or a higher level — so its own
 *     subsections move with it) is moved. Must be found exactly once in the note, and never
 *     claimed by two parts (including by nesting: a part cannot take "## Foo" while another takes
 *     its own "### Bar" subsection).
 *   - lines: exact lines (after trimEnd) NOT already covered by a moved section — content that
 *     sits loose (the intro, or any paragraph not under a heading). Must be found exactly once
 *     among the lines no section already claims.
 *
 * Validated BEFORE anything is written: every reference resolved and unambiguous, no section or
 * line assigned twice, slugs kebab and free, resulting parts non-empty — and, as a hard final
 * check, zero loss: every non-empty line (trimEnd) of the original body must appear at least as
 * many times in hub+parts as it did before. Refused otherwise, with the missing lines named.
 */
const { headingsOf, splitNote: splitFM, buildNote } = require("./store/note-edit");
const { generatePermalink } = require("./store/permalink");
const { estimateTokens } = require("./cost");

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PARTS = 20;

/** Lines of a frontmatter block that decide a note's group — copied verbatim, same cut as
 * lib/assistant/proposal.js's groupLines() (theme / subtheme / its French alias sous_theme). */
function groupLines(fm) {
  return String(fm || "").split(/\r?\n/).filter((l) => /^\s*(theme|subtheme|sous_theme):/.test(l));
}

/** "my-note-api" → "My Note Api". 0.5.4: no longer used for a part's own `title:` (that is now
 * always the slug itself, byte for byte — memglow's own convention, see buildPartText()) — kept,
 * exported, for any caller that still wants a human-readable guess from a bare slug. */
function titleFromSlug(slug) {
  return slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || slug;
}

/** Lowercase kebab-case, accents stripped, anything else collapsed to "-"; never empty. */
function kebabify(s) {
  const base = String(s == null ? "" : s).trim().toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "part";
}

/**
 * 0.5.4: the AI-given slug, forced into memglow's own naming convention — a plan's slug MUST
 * start with "<hub id>-" (an AI asked for a bare "initiatives-silvae" under hub
 * "initiatives-0-synthese-initiatives-design-spec" in production, unprefixed; the PROMPT already
 * asked for the prefix — this is the engine's own guarantee, never relying on the AI alone) — and
 * must not collide with any existing note or another part already placed earlier in this same
 * plan. `hubId` empty/falsy (a pure computeSplit() call with no hub context) skips the prefixing
 * step outright. `used` (a Set of lowercased slugs, MUTATED): every slug this function hands out
 * is added to it before returning, so a second part asking for the same name in the same plan
 * gets its own, deduped suffix instead of silently colliding.
 */
function normalizeSlug(raw, hubId, existingLower, used) {
  let base = kebabify(raw);
  const hubLower = String(hubId || "").toLowerCase();
  if (hubLower && base !== hubLower && !base.startsWith(hubLower + "-")) {
    // 0.5.4: the AI often repeats the hub's own tail ("garden-log-2026-jan-may" for hub
    // "project-garden-log-2026") — drop the longest leading run that equals the hub's trailing
    // words, so the prefix is not doubled ("project-garden-log-2026-jan-may").
    const hw = hubLower.split("-"), bw = base.split("-");
    for (let k = Math.min(hw.length, bw.length - 1); k > 0; k--) {
      if (hw.slice(-k).join("-") === bw.slice(0, k).join("-")) { base = bw.slice(k).join("-"); break; }
    }
    base = kebabify(hubLower + "-" + base);
  }
  if (!base) base = hubLower || "part";
  const taken = (s) => (existingLower && existingLower.has(s)) || (used && used.has(s));
  let slug = base, i = 1;
  while (taken(slug)) { i++; slug = base + "-" + i; }
  if (used) used.add(slug);
  return slug;
}

/** "YYYY-MM-DD" of a timestamp, local calendar day (same cut as lib/maintenance.js's dated items). */
function dateOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Headings of `body` (lib/store/note-edit.js's headingsOf, code-fence-aware, ATX + setext),
 * widened with `end`: the next heading of the SAME OR A HIGHER level, so "## Foo" carries its own
 * "### Bar" subsections with it — the one nuance lib/cost.js's flat sectionsOf() does not give
 * (it cuts at every heading, parent or not); this is the nested cut the split plan's "sections"
 * rely on, the same one lib/store/note.js's own `note.sections` already computes for the search
 * index (independently re-derived here so this module stays usable on a bare string, no store
 * record required).
 */
function sectionSpans(body) {
  const heads = headingsOf(body);
  return heads.map((h, i) => {
    let end = body.length;
    for (let j = i + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].start; break; }
    return { level: h.level, text: h.text, start: h.start, end };
  });
}

/**
 * The pure partition: given a note's BODY (frontmatter already removed, LF line endings) and a
 * plan, decides exactly which lines go to the hub and which to each part — or refuses with
 * `errors`. Never touches a file. → { ok, errors, hubKept, parts: [{ slug, description, hook,
 * content }] }. `hubId` (the note being split) and `existingLower` (a Set of every other known
 * note id/slug, lowercased) drive the slug normalisation above — both optional: without them, a
 * caller gets the slug kebab-ified but never hub-prefixed or deduped against the store (a bare
 * computeSplit() unit test, with no hub/store context at all).
 */
function computeSplit(body, plan, { hubId = "", existingLower = null } = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, errors: ["the plan must be an object"] };
  const partsIn = Array.isArray(plan.parts) ? plan.parts : null;
  if (!partsIn || !partsIn.length) return { ok: false, errors: ['"parts" must be a non-empty list'] };
  if (partsIn.length > MAX_PARTS) return { ok: false, errors: [`"parts" must have at most ${MAX_PARTS} items`] };
  if (plan.hub_summary != null && typeof plan.hub_summary !== "string") errors.push('"hub_summary" must be a string');

  const spans = sectionSpans(body);
  const usedSpans = []; // { start, end, slug }
  const usedLineOffsets = new Set();
  const seenSlug = new Set();
  const perSlug = new Map(); // slug -> { description, hook, spans: [{start,end}], lineOffsets: [n] }
  const order = [];

  const bodyLines = body.split("\n");
  const lineOffsets = [];
  { let o = 0; for (const l of bodyLines) { lineOffsets.push(o); o += l.length + 1; } }
  const lineIndexOfOffset = new Map(lineOffsets.map((o, idx) => [o, idx]));

  partsIn.forEach((p, i) => {
    const n = i + 1;
    if (!p || typeof p !== "object" || Array.isArray(p)) { errors.push(`part ${n} is not an object`); return; }
    if (typeof p.slug !== "string" || !p.slug.trim()) { errors.push(`part ${n}: "slug" is required`); return; }
    // 0.5.4: normalised (kebab, hub-prefixed, deduped) rather than rejected — see normalizeSlug().
    const slug = normalizeSlug(p.slug, hubId, existingLower, seenSlug);
    if (typeof p.description !== "string" || !p.description.trim()) { errors.push(`part ${n} ("${slug}"): "description" is required`); return; }
    const sections = Array.isArray(p.sections) ? p.sections : [];
    const linesWanted = Array.isArray(p.lines) ? p.lines : [];
    if (!sections.length && !linesWanted.length) { errors.push(`part ${n} ("${slug}"): no "sections" or "lines" given — it would be empty`); return; }
    order.push(slug);
    const mySpans = [];
    for (const want of sections) {
      const w = String(want == null ? "" : want);
      const hits = spans.filter((h) => h.text === w);
      if (hits.length !== 1) { errors.push(`part "${slug}": heading "${w}" found ${hits.length} time(s) in the note (must be exactly once)`); continue; }
      const h = hits[0];
      const overlap = usedSpans.find((s) => s.start < h.end && h.start < s.end);
      if (overlap) { errors.push(`part "${slug}": heading "${w}" overlaps a section already assigned to "${overlap.slug}"`); continue; }
      mySpans.push({ start: h.start, end: h.end });
      usedSpans.push({ start: h.start, end: h.end, slug });
    }
    const myLineOffsets = [];
    for (const want of linesWanted) {
      const w = String(want == null ? "" : want).replace(/\s+$/, "");
      const candidates = [];
      for (const off of lineOffsets) {
        const idx = lineIndexOfOffset.get(off);
        const raw = bodyLines[idx];
        const insideSpan = usedSpans.some((s) => off >= s.start && off < s.end) || mySpans.some((s) => off >= s.start && off < s.end);
        if (!insideSpan && !usedLineOffsets.has(off) && raw.replace(/\s+$/, "") === w) candidates.push(off);
      }
      if (candidates.length !== 1) { errors.push(`part "${slug}": line ${JSON.stringify(w.length > 60 ? w.slice(0, 60) + "…" : w)} found ${candidates.length} eligible time(s) outside any moved section (must be exactly once)`); continue; }
      myLineOffsets.push(candidates[0]);
      usedLineOffsets.add(candidates[0]);
    }
    perSlug.set(slug, { description: p.description.trim(), hook: typeof p.hook === "string" ? p.hook.trim() : "", spans: mySpans, lineOffsets: myLineOffsets });
  });

  if (errors.length) return { ok: false, errors };

  /** [startLineIdx, endLineIdx) covering a char range that starts/ends on line boundaries
   * (true of every heading span, and of body.length). */
  function lineRangeOf(start, end) {
    let si = lineIndexOfOffset.get(start);
    if (si == null) { si = 0; for (let k = 0; k < lineOffsets.length; k++) if (lineOffsets[k] <= start) si = k; }
    const ei = end >= body.length ? bodyLines.length : (lineIndexOfOffset.get(end) ?? bodyLines.length);
    return [si, ei];
  }

  const removedLineIdx = new Set();
  const partLineIdx = new Map();
  for (const slug of order) {
    const info = perSlug.get(slug);
    const idxs = new Set();
    for (const s of info.spans) { const [a, b] = lineRangeOf(s.start, s.end); for (let k = a; k < b; k++) idxs.add(k); }
    for (const off of info.lineOffsets) { const idx = lineIndexOfOffset.get(off); if (idx != null) idxs.add(idx); }
    for (const idx of idxs) removedLineIdx.add(idx);
    partLineIdx.set(slug, [...idxs].sort((a, b) => a - b));
  }

  const hubKept = bodyLines.filter((_, idx) => !removedLineIdx.has(idx)).join("\n").replace(/\s+$/, "");
  const parts = order.map((slug) => {
    const info = perSlug.get(slug);
    const idxs = partLineIdx.get(slug);
    const content = idxs.map((i) => bodyLines[i]).join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
    return { slug, description: info.description, hook: info.hook, content };
  });
  for (const p of parts) if (!p.content.trim()) errors.push(`part "${p.slug}": would be empty (its sections/lines hold nothing but blank lines)`);
  if (errors.length) return { ok: false, errors };

  // Hard zero-loss check: every non-empty (trimEnd) line of the original body must appear in
  // hub+parts at least as many times as before. Not merely trusted from the partition above (a
  // future change to it, or a bug, must still be caught here rather than silently lose text).
  const countLines = (text) => {
    const m = new Map();
    for (const l of text.split("\n")) { const t = l.replace(/\s+$/, ""); if (!t.trim()) continue; m.set(t, (m.get(t) || 0) + 1); }
    return m;
  };
  const before = countLines(body);
  const after = countLines([hubKept, ...parts.map((p) => p.content)].join("\n"));
  const missing = [];
  for (const [l, c] of before) {
    const have = after.get(l) || 0;
    for (let k = have; k < c; k++) missing.push(l);
  }
  if (missing.length) {
    errors.push(`zero-loss check failed: ${missing.length} line(s) of the original note would be lost, e.g.: ` +
      missing.slice(0, 5).map((l) => JSON.stringify(l.length > 80 ? l.slice(0, 80) + "…" : l)).join(", "));
    return { ok: false, errors };
  }

  return { ok: true, errors: [], hubKept, parts };
}

/** Appends `bulletLines` to an existing "## Parts" section of `body` (level 2, exact text
 * "Parts" — the one this module itself always writes), or creates it at the end. */
function appendPartsBullets(body, bulletLines) {
  const additions = bulletLines.join("\n");
  const heads = headingsOf(body);
  const h = heads.find((x) => x.level === 2 && x.text === "Parts");
  if (!h) {
    const base = body.replace(/\s+$/, "");
    return (base ? base + "\n\n" : "") + "## Parts\n" + additions + "\n";
  }
  let end = body.length;
  for (const x of heads) if (x.start > h.start && x.level <= 2) { end = x.start; break; }
  const before = body.slice(0, end).replace(/\s+$/, "");
  const after = body.slice(end).replace(/^\s+/, "");
  return before + "\n" + additions + "\n" + (after ? "\n" + after : "");
}

/**
 * The hub's new body: kept lines, then the optional AI summary, then (unless `skipOwnParts` — the
 * hub is itself a part, see module doc) its `## Parts` bullets, appended to an existing section.
 */
function composeHubBody({ hubKept, hubSummary, bulletLines, skipOwnParts }) {
  let body = hubKept;
  if (hubSummary && hubSummary.trim()) body = (body ? body.replace(/\s+$/, "") + "\n\n" : "") + hubSummary.trim() + "\n";
  if (!skipOwnParts) body = appendPartsBullets(body, bulletLines);
  return body.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

/** One part's bullet line for a hub's `## Parts` section. */
function bulletFor(slug, part) {
  const hook = part.hook || part.description;
  return `- [[${slug}]]` + (hook ? ` — ${hook}` : "");
}

/**
 * One part's full text (frontmatter + body). `hub` = { id, fm (raw frontmatter text, no fences),
 * folder }, `partOfId` = the frontmatter `part_of:` value to write (the hub itself, or its own
 * parent X when the hub is already a part), `upId` = the id the body's "Up:" line points to (same
 * as partOfId in every case this module builds), `project`, `permalinkOf(rel)`.
 */
function buildPartText({ hub, slug, part, partOfId, upId, now, permalinkOf }) {
  const rel = (hub.folder ? hub.folder + "/" : "") + slug + ".md";
  const permalink = permalinkOf(rel);
  const group = groupLines(hub.fm);
  const groupValues = {};
  for (const l of group) {
    const m = /^\s*(theme|subtheme|sous_theme)\s*:\s*(.*)$/.exec(l);
    if (m) groupValues[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const fm = {
    // 0.5.4: title == slug, byte for byte — memglow's own convention (matches the file name, the
    // `name:` key below, and every `[[slug]]` link to it); never a Title-Cased guess.
    title: slug,
    type: "note",
    permalink,
    name: slug,
    ...groupValues,
    description: part.description,
    part_of: partOfId,
  };
  if (Array.isArray(hub.tags) && hub.tags.length) fm.tags = hub.tags;
  const upLine = `Up: [[${upId}]] — split on ${dateOf(now)}: ${part.description}.`;
  const body = `${upLine}\n\n${part.content}\n`;
  return { rel, text: buildNote(fm, body) };
}

// ---------------------------------------------------------------------------------------------
// Apply: wires the pure logic above to a memory-server store + writer (memory-server/store-
// memory.js / memory-server/writer.js), the same pair write_note/edit_note use — so indexing,
// kebab file names, permalinks, watchers and fsync mode all behave identically. Not exposed as an
// MCP tool (0.5.4 direction): called directly by lib/auto-split.js, and by split_plan's own
// preview when it wants to show exact file contents rather than just a token-count proposal.

const fs = require("fs");

/** A permalink not already declared by another file (same rule as write-tools.js's own). */
function uniquePermalink(store, permalink, rel) {
  const g = store.graph();
  const taken = (p) => (g.byPermalink.get(p.toLowerCase()) || []).some((n) => n.rel !== rel && n.permalink.toLowerCase() === p.toLowerCase());
  if (!taken(permalink)) return permalink;
  for (let i = 1; i < 10000; i++) if (!taken(`${permalink}-${i}`)) return `${permalink}-${i}`;
  return permalink;
}

class SplitError extends Error {}

/**
 * splitNote({ store, writer, project, identifier, plan, threshold, now, dryRun }) →
 *   { ok: true, dryRun, hub: { rel, tokens }, parts: [{ slug, rel, tokens }], warnings: [string] }
 *   | { ok: false, errors: [string] }
 * Everything is validated before anything is written (computeSplit, above, plus slug-freedom and
 * resolution checks here); parts are written first, the hub last — a part write failing deletes
 * whichever parts this call already wrote and reports, leaving the hub and the grandparent (when
 * the hub is itself a part) untouched.
 */
async function splitNote({ store, writer, project, identifier, plan, threshold = 0, now = Date.now(), dryRun = false }) {
  if (!writer) return { ok: false, errors: ["this memory server is read-only: split_apply (like write_note) needs --read-write"] };
  const hub = store.resolve(identifier);
  if (!hub) return { ok: false, errors: [`Note not found: ${JSON.stringify(identifier)}`] };
  if (store.refreshNote) store.refreshNote(hub.rel);
  const fresh = store.resolve(identifier) || hub;

  const { block: hubBlock, head: hubHead, body: hubBody } = splitFM(fresh.raw);
  // 0.5.4: hubId/existingLower drive computeSplit()'s own slug normalisation (kebab, "<hub>-"
  // prefixed, deduped against every other known note) — never trusting the AI's slug as given.
  const hubId = fresh.slug || fresh.base;
  const existingLower = new Set(store.notes().map((n) => String(n.slug || n.base || "").toLowerCase()).filter(Boolean));
  const r = computeSplit(hubBody == null ? "" : hubBody, plan, { hubId, existingLower });
  if (!r.ok) return { ok: false, errors: r.errors };
  if (typeof plan.hub_summary === "string" && plan.hub_summary.length > 20000) return { ok: false, errors: ['"hub_summary" is too large'] };

  const folder = fresh.dir || "";
  const permalinkOf = (rel) => uniquePermalink(store, `${project}/${generatePermalink(rel)}`, rel);

  // Slug freedom: a part's file must not already exist (as a note, or as an untracked file).
  const errors = [];
  const planned = r.parts.map((p) => ({ ...p, rel: writer ? writer.canonicalRel((folder ? folder + "/" : "") + p.slug + ".md") : (folder ? folder + "/" : "") + p.slug + ".md" }));
  for (const p of planned) {
    if (store.resolve(p.rel) || store.resolve(p.slug)) errors.push(`part "${p.slug}": "${p.rel}" already names an existing note`);
  }
  if (errors.length) return { ok: false, errors };

  // The hub's own hub-and-spoke chain: if it is ITSELF a part (frontmatter `part_of:`), new parts
  // point to its parent, and their bullet lines go to the PARENT's "## Parts", not the hub's own
  // (module doc). The parent is resolved the same way write_note resolves any identifier; when it
  // cannot be (a stale/typo'd part_of), the hub is treated as its own root — never a hard error,
  // since the split itself is still perfectly safe either way.
  let grandparent = null;
  const hubPartOf = fresh.frontmatter && typeof fresh.frontmatter.part_of === "string" ? fresh.frontmatter.part_of.trim() : "";
  if (hubPartOf) grandparent = store.resolve(hubPartOf);
  const partOfId = grandparent ? grandparent.id || grandparent.permalink || hubPartOf : fresh.id || fresh.permalink;
  // `id` is not a store/note.js field (the store keys by `rel`/permalink); the frontmatter
  // `part_of:`/the body's `Up:` line are written as the note's OWN slug (its base name), the same
  // value a hub-spoke marker elsewhere in memglow (lib/hub-spoke.js) already expects and resolves.
  const idOf = (n) => n.slug || n.base;
  const upTarget = grandparent ? idOf(grandparent) : idOf(fresh);
  const partOfValue = grandparent ? idOf(grandparent) : idOf(fresh);

  const hubRecord = { id: idOf(fresh), fm: hubBlock || "", folder, tags: fresh.tags };
  const bulletLines = planned.map((p) => bulletFor(p.slug, p));
  const partTexts = planned.map((p) => buildPartText({ hub: hubRecord, slug: p.slug, part: p, partOfId: partOfValue, upId: upTarget, now, permalinkOf }));

  const hubNewBody = composeHubBody({ hubKept: r.hubKept, hubSummary: plan.hub_summary, bulletLines, skipOwnParts: !!grandparent });
  let hubHeadOut = hubHead;
  if (hubBlock == null) hubHeadOut = ""; // no frontmatter at all: nothing to preserve, body only
  else if (!hubHeadOut.endsWith("\n")) hubHeadOut += "\n";
  const hubNewText = hubBlock == null ? hubNewBody : hubHeadOut + "\n" + hubNewBody;

  const grandparentNewText = grandparent
    ? (() => {
        const { head: gHead, block: gBlock, body: gBody } = splitFM(grandparent.raw);
        const gNewBody = appendPartsBullets(gBody == null ? "" : gBody, bulletLines);
        let h = gHead;
        if (!h.endsWith("\n")) h += "\n";
        return gBlock == null ? gNewBody : h + "\n" + gNewBody;
      })()
    : null;

  const sizes = {
    hub: estimateTokens(hubNewText),
    parts: partTexts.map((p, i) => ({ slug: planned[i].slug, tokens: estimateTokens(p.text) })),
  };
  const warnings = [];
  if (threshold > 0) for (const p of sizes.parts) if (p.tokens > threshold) warnings.push(`part "${p.slug}" is still ≈${p.tokens} tokens, over the ${threshold}-token threshold`);

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      hub: { rel: fresh.rel, tokens: sizes.hub, preview: hubNewText },
      parts: partTexts.map((p, i) => ({ slug: planned[i].slug, rel: p.rel, tokens: sizes.parts[i].tokens, preview: p.text })),
      grandparent: grandparent ? { rel: grandparent.rel, tokens: estimateTokens(grandparentNewText) } : null,
      warnings,
    };
  }

  // Write parts first (brand-new files: a failure here is cleaned up — the files this very call
  // created are removed again, never trashed, since nothing of the user's existed at that path a
  // moment ago); the hub (and the grandparent, when there is one) only once every part succeeded.
  const written = [];
  try {
    for (let i = 0; i < partTexts.length; i++) {
      const p = partTexts[i];
      const t = await writer.target(p.rel);
      if (t.stat) throw new SplitError(`part "${planned[i].slug}": "${p.rel}" already exists`);
      const st = await writer.writeAtomic(t.abs, p.text, null);
      store.noteWritten(t.rel, p.text, st);
      written.push(t.rel);
    }
  } catch (e) {
    for (const rel of written) {
      try { const t = await writer.target(rel); await fs.promises.unlink(t.abs); store.noteRemoved(rel); } catch { /* best effort */ }
    }
    writer.fail();
    return { ok: false, errors: [`writing a part failed, no part was kept: ${e.message}`] };
  }
  writer.wrote(written);

  if (grandparent) {
    const t = await writer.target(grandparent.rel);
    const st = await writer.writeAtomic(t.abs, grandparentNewText, t.stat);
    store.noteWritten(t.rel, grandparentNewText, st);
    writer.wrote([t.rel]);
  }

  const ht = await writer.target(fresh.rel);
  const hst = await writer.writeAtomic(ht.abs, hubNewText, ht.stat);
  store.noteWritten(ht.rel, hubNewText, hst);
  writer.wrote([ht.rel]);

  return {
    ok: true, dryRun: false,
    hub: { rel: fresh.rel, tokens: sizes.hub },
    parts: partTexts.map((p, i) => ({ slug: planned[i].slug, rel: p.rel, tokens: sizes.parts[i].tokens })),
    grandparent: grandparent ? { rel: grandparent.rel } : null,
    warnings,
  };
}

/**
 * 0.5.5: moveSections(body, sectionHeadings) — the pure partition PRUNE STALE → ARCHIVE (A) needs:
 * given a note's BODY and a list of exact heading texts (found via outline() ids, same [S1]
 * convention as lib/auto-split.js's own prompt), returns the body with those whole sections
 * removed (`kept`) and their verbatim content (`moved`), or refuses with `errors` — same
 * exactly-once / no-overlap rules as computeSplit()'s own section matching above, and the SAME
 * hard zero-loss check (every non-empty line of the original body must appear, same count, in
 * kept+moved) — never trusted from the partition alone. Unlike computeSplit(), there is only ever
 * ONE destination (an archive note, new or existing) — no slugs, no hub bullets, no "lines"
 * support (archiving targets whole sections only). Never touches a file.
 */
function moveSections(body, sectionHeadings) {
  if (!Array.isArray(sectionHeadings) || !sectionHeadings.length) return { ok: false, errors: ["no sections given"] };
  const errors = [];
  const spans = sectionSpans(body);
  const chosen = [];
  for (const want of sectionHeadings) {
    const w = String(want == null ? "" : want);
    const hits = spans.filter((h) => h.text === w);
    if (hits.length !== 1) { errors.push(`heading ${JSON.stringify(w)} found ${hits.length} time(s) in the note (must be exactly once)`); continue; }
    const h = hits[0];
    const overlap = chosen.find((c) => c.start < h.end && h.start < c.end);
    if (overlap) { errors.push(`heading ${JSON.stringify(w)} overlaps a section already chosen`); continue; }
    chosen.push(h);
  }
  if (errors.length) return { ok: false, errors };
  chosen.sort((a, b) => a.start - b.start);

  const bodyLines = body.split("\n");
  const lineOffsets = []; { let o = 0; for (const l of bodyLines) { lineOffsets.push(o); o += l.length + 1; } }
  const lineIndexOfOffset = new Map(lineOffsets.map((o, idx) => [o, idx]));
  function lineRangeOf(start, end) {
    let si = lineIndexOfOffset.get(start);
    if (si == null) { si = 0; for (let k = 0; k < lineOffsets.length; k++) if (lineOffsets[k] <= start) si = k; }
    const ei = end >= body.length ? bodyLines.length : (lineIndexOfOffset.get(end) ?? bodyLines.length);
    return [si, ei];
  }
  const removedIdx = new Set();
  for (const h of chosen) { const [a, b] = lineRangeOf(h.start, h.end); for (let k = a; k < b; k++) removedIdx.add(k); }
  const kept = bodyLines.filter((_, idx) => !removedIdx.has(idx)).join("\n").replace(/\s+$/, "");
  const movedIdx = [...removedIdx].sort((a, b) => a - b);
  const moved = movedIdx.map((i) => bodyLines[i]).join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
  if (!moved.trim()) return { ok: false, errors: ["the chosen sections hold nothing but blank lines"] };

  // Hard zero-loss check, same cut as computeSplit()'s own (never trusted from the partition
  // above alone — a future change to it, or a bug, must still be caught here).
  const countLines = (text) => {
    const m = new Map();
    for (const l of text.split("\n")) { const t = l.replace(/\s+$/, ""); if (!t.trim()) continue; m.set(t, (m.get(t) || 0) + 1); }
    return m;
  };
  const before = countLines(body);
  const after = countLines(kept + "\n" + moved);
  const missing = [];
  for (const [l, c] of before) { const have = after.get(l) || 0; for (let k = have; k < c; k++) missing.push(l); }
  if (missing.length) {
    return { ok: false, errors: [`zero-loss check failed: ${missing.length} line(s) of the original note would be lost, e.g.: ` +
      missing.slice(0, 5).map((l) => JSON.stringify(l.length > 80 ? l.slice(0, 80) + "…" : l)).join(", ")] };
  }
  return { ok: true, errors: [], kept, moved };
}

/**
 * 0.5.5: greedyEnginePlan(body, { hubId, existingLower, chunkTokens, maxParts }) — Part D's "one
 * heuristic": the SAME deterministic grouping `split_plan` (mcp-server/memglow-mcp.js) now uses,
 * built and VALIDATED through this engine (computeSplit above) rather than a second, independent
 * packer (lib/cost.js's flat packSections stays for split_plan's own back-compat "sections"/
 * "split" fields — see that tool's module doc). Groups CONSECUTIVE top-level sections (the
 * note's own minimum heading level — a "## Foo" always carries its own "### Bar" subsections,
 * never splitting a section's own text apart) greedily until ~`chunkTokens`. Returns `null` when
 * there are no headings, or fewer than 2 groups would result (nothing useful to propose) — never
 * a hard error for a plain caller; computeSplit()'s own validation (zero-loss, slug freedom) still
 * runs, and a failure there is returned as `{ ok: false, errors }` instead of being swallowed.
 */
function greedyEnginePlan(body, { hubId = "", existingLower = null, chunkTokens = 1500, maxParts = MAX_PARTS } = {}) {
  const spans = sectionSpans(body).filter((s) => s.text);
  if (!spans.length) return null;
  const minLevel = Math.min(...spans.map((s) => s.level));
  const top = spans.filter((s) => s.level === minLevel);
  if (!top.length) return null;
  const groups = [];
  let cur = [], curTokens = 0;
  for (const s of top) {
    const t = estimateTokens(body.slice(s.start, s.end));
    if (cur.length && curTokens + t > chunkTokens) { groups.push(cur); cur = []; curTokens = 0; }
    cur.push(s);
    curTokens += t;
  }
  if (cur.length) groups.push(cur);
  if (groups.length < 2) return null; // nothing to usefully split by this heuristic
  const used = new Set();
  const parts = groups.slice(0, maxParts).map((g, i) => {
    const titles = g.map((s) => s.text);
    const slug = normalizeSlug(`part-${i + 1}`, hubId, existingLower, used);
    return { slug, description: `Part ${i + 1}: ${titles.join(", ")}`.slice(0, 300), hook: titles[0], sections: titles.slice() };
  });
  const r = computeSplit(body, { parts }, { hubId, existingLower });
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, errors: [], parts: parts.map((p) => ({ slug: p.slug, description: p.description, hook: p.hook, sections: p.sections })) };
}

module.exports = { normalizeSlug,
  KEBAB_RE, MAX_PARTS, SplitError,
  groupLines, titleFromSlug, dateOf, sectionSpans, computeSplit,
  appendPartsBullets, composeHubBody, bulletFor, buildPartText,
  estimateTokens, splitFM, splitNote, moveSections, greedyEnginePlan,
};
