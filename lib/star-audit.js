"use strict";
/**
 * 0.5.4: the star-structure guardian — pure detection (and, for the mechanical cases, a pure fix
 * builder) of where a memory drifts from memglow's hub-and-spoke ("star") layout
 * (docs/hub-and-spoke.md, lib/hub-spoke.js). Rules, the task's own numbering:
 *
 *   R1 the index lists only hubs and standalone notes, never a part (frontmatter `part_of:` set)
 *   R2 every part has frontmatter `part_of: <existing hub>` and a body `Up: [[hub]] …` line
 *   R3 every hub's `## Parts` section lists all its parts (`- [[slug]] — hook`) and nothing whose
 *      `part_of` differs
 *   R4 a part does not list its siblings
 *   R5 no orphan: every non-archive note is either in the index, a part, or linked from a hub's
 *      `## Parts`
 *
 * Built ON TOP of lib/hub-spoke.js's own pure detector (same input shape: `notes = [{id, label,
 * text, folder}]`, `indexId`) — reused, never reimplemented: its `missingUplinks` IS R2's
 * violation, its `missingHubLines` IS half of R3 (a CONFIRMED part a hub forgot to list), its
 * `siblingLines` (the `pure` flag) IS R4. This module adds only what hub-spoke.js has no reason to
 * compute for its own, narrower purpose (a dashboard count): R1 (an index line pointing at a
 * part), the other half of R3 (a hub's `## Parts` naming a note that has no `part_of` at all and
 * no other hub's own list claims it either), and R5 (reachability).
 *
 * `audit()` is pure and deterministic — same input, same issues, every time; no I/O, no AI, no
 * randomness. `fix` is null for the cases that genuinely need judgement (handled by the AI
 * judgement pass further down for R5/an ambiguous R3, never for R1 or R4 — see below) and a small,
 * mechanical descriptor otherwise, turned into an exact file edit by `buildFix()`, applied the
 * same way lib/split-engine.js applies a split plan: through the store/writer, never a hand-rolled
 * write.
 *
 * 0.5.4 (production bug fixes, ADD-only invariant tightened):
 *   - "Declared beats inferred, everywhere automatic": R1/R2/R3(half 1) only ever treat a note as
 *     "a part" for an AUTOMATIC fix when its OWN FRONTMATTER declares `part_of:`/`parent:`
 *     (`declaredPartOfMap()`) — hub-spoke.js's own broader `confirmedHub` ALSO trusts a body
 *     "Up:"/"Part of:"/"Summary:" header line and a purely structural mutual link, which is fine
 *     for the rules that are report-only regardless (R4, R5) but was wrongly driving automatic
 *     fixes here: a production note whose body merely opened with "Up: [[Arthur]] and
 *     [[Florent]]" (ordinary cross-references, no `part_of:` at all) was treated as a declared
 *     part of one of them, and R1 then DELETED its own line from the real index.
 *   - R1 is now report-only (`fix: null`) UNCONDITIONALLY — the worker never removes or rewrites
 *     an index line automatically, whatever confirms the relationship; `buildFix()` still knows
 *     "replace-index-line" for an explicit/manual caller, same as R4's own "remove-line".
 *   - `excludeFolders` (shared with lib/auto-split.js, see structureSettings()) — a folder the
 *     owner wants left whole (a versioned work document, say) is filtered out BEFORE audit() ever
 *     sees it: never scanned, fixed, or reported as an orphan.
 */
const hubSpoke = require("./hub-spoke");
const { splitNote: splitFM, replaceBlock, headingsOf } = require("./store/note-edit");
const aiProvider = require("./ai-provider");
const {
  parsePlan, sanitizeExcludeFolders, underExcluded,
  sanitizeIncludeFolders, underIncluded, effectiveIncludeFolders,
} = require("./auto-split"); // shared with lib/auto-split.js
const { maskSecrets } = require("./memory");
const { createEventLog } = require("./event-log");

const PARTS_HEADING_RE = /^##[ \t]+Parts[ \t]*$/;
const HEADING_RE = /^#{1,6}[ \t]/;

function underArchive(rel, folder) { return typeof rel === "string" && !!folder && (rel === folder || rel.startsWith(folder + "/")); }

/** The raw `## Parts` bullets of one note's text (any case for "Parts" match is NOT attempted —
 * same literal heading this module and lib/split-engine.js both write): { start (body line index
 * of the heading, -1 if none), bullets: [{ lineIndex, target }] }. */
function partsBulletsOf(text) {
  const { body } = hubSpoke.splitFrontmatter(text);
  const lines = String(body || "").split(/\r?\n/);
  const start = lines.findIndex((l) => PARTS_HEADING_RE.test(l.trim()));
  if (start < 0) return { start: -1, bullets: [] };
  const bullets = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (HEADING_RE.test(l)) break;
    const m = /^\s*-\s*\[\[([^\]|#]+)/.exec(l);
    if (m) bullets.push({ lineIndex: i, target: m[1].trim() });
  }
  return { start, bullets };
}

function hasPartOfKey(text) {
  const { fm } = hubSpoke.splitFrontmatter(text);
  return /^\s*part_of\s*:/im.test(fm || "");
}

/**
 * 0.5.4 bug fix: `head` (the frontmatter fences, ending in its OWN "\n") joined with a new `body`
 * that may — or may not — already start with ITS OWN leading blank line (every buildFix() case
 * below builds `body` from the original note's own lines, which usually does). Naively doing
 * `head + "\n" + body` on top of a body that already opened with a blank line inserted a SECOND
 * one: a scan that changed nothing nearby near the top of a note still left it byte-different
 * (reported: two stray blank lines appeared near the top of an index after an UNRELATED fix
 * elsewhere in it). Stripping body's own leading blank(s) first and always adding exactly one
 * back is idempotent regardless of which shape `body` arrives in.
 */
function joinHeadBody(head, body) {
  const h = head.endsWith("\n") ? head : head + "\n";
  const b = String(body || "").replace(/^[ \t]*\n+/, "");
  return b ? h + "\n" + b : h;
}

/**
 * 0.5.4 bug fix: which notes DECLARE a hub via their OWN FRONTMATTER only (`part_of:`/`parent:`
 * — never a body "Up:"/"Part of:"/"Summary:" header line, and never hub-spoke's structural
 * mutual-link inference): id -> hub id, resolved against known notes the same way hub-spoke.js
 * resolves its own (case-insensitive). "Declared beats inferred, everywhere automatic": a note
 * merely carrying an "Up: [[Something]]"-shaped line near its top (reported: it named two
 * unrelated notes, keyestudio's own cross-references) is NOT thereby "a part" for any automatic
 * ADD — hub-spoke's own broader `confirmedHub` (which DOES trust that body marker, and DOES infer
 * purely from a mutual link) stays fine for the rules that are report-only regardless (R4, R5
 * below never apply a fix anyway) but must never decide R1/R2/R3's automatic ones.
 */
function declaredPartOfMap(records, byId, byLowerId, indexId) {
  const map = new Map();
  for (const n of records) {
    if (n.id === indexId) continue;
    const raw = hubSpoke.declaredHubOfFrontmatter(n.text);
    if (!raw) continue;
    const hit = byId.has(raw) ? raw : byLowerId.get(String(raw).toLowerCase());
    if (hit && hit !== n.id && hit !== indexId) map.set(n.id, hit);
  }
  return map;
}

/**
 * audit({ notes, indexId, archiveFolder }) → [{ rule: "R1".."R5", note: <id>, fix: {…}|null,
 * detail? }], sorted by rule then note id (deterministic order, never depends on Map/object
 * iteration). `notes` = [{ id, label, text, folder }] (same records lib/hub-spoke.js's own
 * `detect()` and mcp-server/memglow-mcp.js's `memory_health` already build from the store/memory);
 * notes whose `id`/`rel` sits under `archiveFolder` are never flagged (R5 only checks this
 * directly — R1-R4 already only ever concern notes hub-spoke.js's own structural rules confirm,
 * which never include an archived note unless it genuinely still links in).
 */
function audit({ notes = [], indexId = null, archiveFolder = "archive" } = {}) {
  const records = (notes || []).filter((n) => n && typeof n.id === "string");
  const byId = new Map(records.map((n) => [n.id, n]));
  const byLowerId = new Map(records.map((n) => [n.id.toLowerCase(), n.id]));
  const resolve = (raw) => (byId.has(raw) ? raw : byLowerId.get(String(raw || "").toLowerCase()) || null);

  const base = hubSpoke.detect({ notes: records, indexId });
  const { confirmedHub, outgoing, linesById } = base._internal;
  // 0.5.4: the narrower, frontmatter-only notion of "is a part" — see declaredPartOfMap()'s own
  // doc above. Every AUTOMATIC fix below (R1, R2, R3 half 1) checks against THIS, never against
  // hub-spoke's own broader `confirmedHub` directly.
  const declaredOnly = declaredPartOfMap(records, byId, byLowerId, indexId);
  const issues = [];

  // R2 — a DECLARED part (frontmatter part_of) with no link back to its hub at all (hub-spoke's
  // missingUplinks, filtered to the declared-only relationship).
  for (const { hub, note } of base.missingUplinks) {
    if (declaredOnly.get(note) !== hub) continue;
    issues.push({ rule: "R2", note, fix: { type: "add-up-line", note, hub } });
  }

  // R3 (half 1) — a DECLARED part the hub does not (yet) list back (hub-spoke's missingHubLines,
  // same filter).
  for (const { hub, note } of base.missingHubLines) {
    if (declaredOnly.get(note) !== hub) continue;
    issues.push({ rule: "R3", note: hub, fix: { type: "append-hub-parts-line", hub, part: note } });
  }

  // R4 — a part's own body naming >= 2 of its siblings. 0.5.4: reported, never fixed automatically —
  // the maintenance worker only ever ADDS lines/keys (Up, part_of, ## Parts, index lines); deleting
  // a note's own line, even a pure sibling-link line, stays a human/AI decision. buildFix still
  // knows "remove-line" for an explicit caller.
  for (const sl of base.siblingLines) {
    issues.push({ rule: "R4", note: sl.note, lineIndex: sl.lineIndex, fix: null, detail: sl.pure ? "a line made only of sibling links (removable by hand)" : "links sit inside prose, not a removable line alone" });
  }

  // R1 — the index links to a DECLARED part (frontmatter part_of only — a note merely INFERRED
  // as a part from a body marker or a structural mutual link is not, by this stricter rule, "a
  // part" the index should not be listing — reported: two such notes were wrongly deleted from a
  // real index because they only ever carried an "Up:"-shaped cross-reference line, never a
  // frontmatter `part_of:`). 0.5.4: report-only regardless — the worker never removes or rewrites
  // an index line automatically; `fix` is always null. `part`/`hub`/`lineIndex`/`hubAlreadyListed`
  // stay on the issue itself (same shape as R4's own report-only fields) for an explicit/manual
  // caller that still wants to build the "replace-index-line" fix by hand.
  if (indexId && byId.has(indexId)) {
    const indexOut = outgoing.get(indexId) || new Set();
    const indexLines = linesById.get(indexId) || [];
    for (const p of [...indexOut].sort()) {
      const hub = declaredOnly.get(p);
      if (!hub || hub === indexId) continue;
      const li = indexLines.findIndex((l) => l.links.includes(p));
      issues.push({
        rule: "R1", note: indexId, fix: null, part: p, hub, lineIndex: li >= 0 ? li : null, hubAlreadyListed: indexOut.has(hub),
        detail: `"${p}" declares part_of: "${hub}" but is still listed in the index (never auto-removed)`,
      });
    }
  }

  // R3 (half 2) — a hub's own "## Parts" names a note with NO part_of at all. Only fixed
  // automatically when exactly ONE hub's list claims it (two claiming the same note is left for
  // review: picking the "right" one needs judgement, not a coin flip). Skipped when the target
  // already declares SOME part_of (hasPartOfKey/declaredOnly — pointing elsewhere is still its
  // own, separate, ambiguity, not auto-fixed here either).
  const claimedBy = new Map(); // target id -> Set(hub id)
  for (const n of records) {
    const { bullets } = partsBulletsOf(n.text);
    for (const b of bullets) {
      const target = resolve(b.target);
      if (!target || target === n.id) continue;
      if (!claimedBy.has(target)) claimedBy.set(target, new Set());
      claimedBy.get(target).add(n.id);
    }
  }
  for (const target of [...claimedBy.keys()].sort()) {
    const hubs = claimedBy.get(target);
    const targetNote = byId.get(target);
    if (!targetNote || declaredOnly.has(target) || hasPartOfKey(targetNote.text)) continue;
    if (hubs.size === 1) issues.push({ rule: "R3", note: target, fix: { type: "add-part-of", note: target, hub: [...hubs][0] } });
    else issues.push({ rule: "R3", note: target, fix: null, detail: `claimed by ${hubs.size} hubs' own "## Parts": ${[...hubs].sort().join(", ")}` });
  }

  // R5 — reachable = linked from the index, a confirmed part, or named in ANY note's "## Parts"
  // (confirmed or not — R5 explicitly allows that looser link as enough).
  const reachable = new Set();
  if (indexId) for (const t of outgoing.get(indexId) || []) reachable.add(t);
  for (const id of confirmedHub.keys()) reachable.add(id);
  for (const t of claimedBy.keys()) reachable.add(t);
  for (const n of records) {
    if (n.id === indexId) continue;
    if (underArchive(n.id, archiveFolder) || underArchive(n.folder ? n.folder + "/x" : "", archiveFolder)) continue;
    if (reachable.has(n.id)) continue;
    issues.push({ rule: "R5", note: n.id, fix: null, detail: "not in the index, not a part, not named in any hub's \"## Parts\"" });
  }

  issues.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.note < b.note ? -1 : a.note > b.note ? 1 : 0));
  return issues;
}

/** issues → { fixable, needsReview, byRule: { R1..R5: count } } — the one line memory_core /
 * the control panel can show ("structure: N issues"). */
function summarize(issues) {
  const byRule = {};
  let fixable = 0, needsReview = 0;
  for (const i of issues) {
    byRule[i.rule] = (byRule[i.rule] || 0) + 1;
    if (i.fix) fixable++; else needsReview++;
  }
  return { total: issues.length, fixable, needsReview, byRule };
}

/**
 * buildFix(fix, byId) → { rel, before, after } — the EXACT new text of the one note a mechanical
 * fix touches (byId: Map(id -> { id, label, text, folder, rel? }), same records audit() took;
 * `rel` falls back to `id` when a record carries no separate `rel`). Pure: no fs. Returns null
 * when the fix cannot be built (a note referenced no longer exists — the caller re-read since).
 */
function buildFix(fix, byId) {
  if (!fix) return null;
  const relOf = (n) => (n && (n.rel || n.id));
  if (fix.type === "add-up-line") {
    const n = byId.get(fix.note);
    if (!n) return null;
    const { block, head, body } = splitFM(n.text);
    const up = `Up: [[${fix.hub}]] — part of ${fix.hub}.\n\n`;
    const already = /^\s*Up:\s*\[\[/im.test(String(body || "").split(/\r?\n/).slice(0, 5).join("\n"));
    if (already) return null;
    const newBody = up + String(body || "").replace(/^\s*\n+/, "");
    const after = block == null ? newBody : joinHeadBody(head, newBody);
    return { rel: relOf(n), before: n.text, after };
  }
  if (fix.type === "append-hub-parts-line") {
    const hub = byId.get(fix.hub), part = byId.get(fix.part);
    if (!hub || !part) return null;
    const { block, head, body } = splitFM(hub.text);
    const b = String(body || "");
    const { start, bullets } = partsBulletsOf(hub.text);
    if (bullets.some((x) => x.target === fix.part || x.target.toLowerCase() === fix.part.toLowerCase())) return null; // already there
    const hook = fix.hook || part.description || part.label || fix.part;
    const line = `- [[${fix.part}]] — ${hook}`;
    const lines = b.split(/\r?\n/);
    let newBody;
    if (start < 0) {
      const trimmed = b.replace(/\s+$/, "");
      newBody = (trimmed ? trimmed + "\n\n" : "") + "## Parts\n" + line + "\n";
    } else {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) if (HEADING_RE.test(lines[i])) { end = i; break; }
      const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
      const after = lines.slice(end).join("\n");
      newBody = before + "\n" + line + "\n" + (after ? "\n" + after.replace(/^\s+/, "") : "");
    }
    const after2 = block == null ? newBody : joinHeadBody(head, newBody);
    return { rel: relOf(hub), before: hub.text, after: after2 };
  }
  if (fix.type === "remove-line") {
    const n = byId.get(fix.note);
    if (!n) return null;
    const { block, head, body } = splitFM(n.text);
    const lines = String(body || "").split(/\r?\n/);
    if (fix.lineIndex < 0 || fix.lineIndex >= lines.length) return null;
    lines.splice(fix.lineIndex, 1);
    const newBody = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    const after = block == null ? newBody : joinHeadBody(head, newBody);
    return { rel: relOf(n), before: n.text, after };
  }
  if (fix.type === "add-part-of") {
    const n = byId.get(fix.note);
    if (!n) return null;
    const { block, head, body } = splitFM(n.text);
    if (block == null) return null; // no frontmatter at all: nothing safe to merge a key into here
    if (/^\s*part_of\s*:/im.test(block)) return null; // already has one (race since audit() ran)
    const newBlock = block.replace(/\s*$/, "") + "\npart_of: " + fix.hub;
    const after = replaceBlock(head, block, newBlock) + body;
    return { rel: relOf(n), before: n.text, after };
  }
  if (fix.type === "replace-index-line") {
    const idx = byId.get(fix.index);
    if (!idx || fix.lineIndex == null) return null;
    const { block, head, body } = splitFM(idx.text);
    const lines = String(body || "").split(/\r?\n/);
    if (fix.lineIndex < 0 || fix.lineIndex >= lines.length) return null;
    const line = lines[fix.lineIndex];
    if (fix.hubAlreadyListed) {
      lines.splice(fix.lineIndex, 1);
    } else {
      const re = new RegExp("\\[\\[" + escapeRe(fix.part) + "(?:[#|][^\\]]*)?\\]\\]", "i");
      if (!re.test(line)) return null;
      lines[fix.lineIndex] = line.replace(re, `[[${fix.hub}]]`);
    }
    const newBody = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    const after = block == null ? newBody : joinHeadBody(head, newBody);
    return { rel: relOf(idx), before: idx.text, after };
  }
  // 0.5.4: an AI's "attach" decision for an R5 orphan / a note two hubs' own "## Parts" both
  // list (see judgeIssues() below) — ADD-only, same as every fix above: a missing `part_of:` key
  // and a missing `Up:` line, never a deletion. The hub's own bullet is a SEPARATE
  // "append-hub-parts-line" fix (it touches a different file).
  if (fix.type === "attach") {
    const n = byId.get(fix.note);
    if (!n) return null;
    const { block, head, body } = splitFM(n.text);
    if (block == null) return null; // no frontmatter at all: nothing safe to merge a key into here
    if (/^\s*part_of\s*:/im.test(block)) return null; // already confirmed (race since audit() ran)
    const newBlock = block.replace(/\s*$/, "") + "\npart_of: " + fix.hub;
    const newHead = replaceBlock(head, block, newBlock);
    const bodyStr = String(body || "");
    const alreadyUp = /^\s*Up:\s*\[\[/im.test(bodyStr.split(/\r?\n/).slice(0, 5).join("\n"));
    const newBody = (alreadyUp ? "" : `Up: [[${fix.hub}]] — part of ${fix.hub}.\n\n`) + bodyStr.replace(/^\s*\n+/, "");
    const after = joinHeadBody(newHead, newBody);
    return { rel: relOf(n), before: n.text, after };
  }
  // 0.5.4: an AI's "index" decision — one new bullet at the end of an EXISTING index section
  // (never a new section, never touching any other line of the index).
  if (fix.type === "append-index-section-line") {
    const idx = byId.get(fix.index);
    if (!idx) return null;
    const { block, head, body } = splitFM(idx.text);
    const lines = String(body || "").split(/\r?\n/);
    let start = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(lines[i]);
      if (m && m[2].trim() === fix.section) { start = i; level = m[1].length; break; }
    }
    if (start < 0) return null; // the section named is not (or no longer) a heading of the index
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#{1,6})[ \t]+/.exec(lines[i]);
      if (m && m[1].length <= level) { end = i; break; }
    }
    const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
    const after2 = lines.slice(end).join("\n");
    const line = `- [[${fix.note}]] — ${fix.hook}`;
    const newBody = before + "\n" + line + "\n" + (after2 ? "\n" + after2.replace(/^\s+/, "") : "");
    const afterFull = block == null ? newBody : joinHeadBody(head, newBody);
    return { rel: relOf(idx), before: idx.text, after: afterFull };
  }
  return null;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------------------------------------------------------------------------------------------
// Apply + a small periodic worker — same spirit as lib/auto-split.js (store/writer, one write at
// a time, never the index note / archive folder), OFF by default (`structure.enabled` / env
// MEMGLOW_AUTO_STRUCTURE=1). Only the DETERMINISTIC fixes above are ever applied automatically;
// an issue with `fix: null` (an orphan with no obvious hub, two hubs claiming one note, …) is
// listed but never acted on by this stage — that needs an AI's judgement, not yet wired here (see
// module doc).

function intBound(v, def, min, max) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; }

function structureSettings(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const envOn = String(env.MEMGLOW_AUTO_STRUCTURE || "").toLowerCase();
  const aiRaw = a.ai && typeof a.ai === "object" ? a.ai : {};
  const envAiOn = String(env.MEMGLOW_STRUCTURE_AI || "").toLowerCase();
  const archiveFolder = typeof a.archiveFolder === "string" && a.archiveFolder.trim() ? a.archiveFolder.trim() : "archive";
  const excludeFoldersRaw = typeof env.MEMGLOW_EXCLUDE_FOLDERS === "string" && env.MEMGLOW_EXCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_EXCLUDE_FOLDERS.split(",") : a.excludeFolders;
  const includeFoldersRaw = typeof env.MEMGLOW_INCLUDE_FOLDERS === "string" && env.MEMGLOW_INCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_INCLUDE_FOLDERS.split(",") : a.includeFolders;
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    scanHours: intBound(a.scanHours, 24, 0, 168),
    maxFixesPerScan: intBound(a.maxFixesPerScan, 10, 1, 1000),
    archiveFolder, // kept: back-compat / display only, and audit()'s own single-folder R5 check
    // 0.5.4: shared with lib/auto-split.js's own autoSplit.excludeFolders (same env var, same
    // archiveFolder alias/resolution) — a versioned work document excluded from auto-split stays
    // excluded from the structure guardian too (never scanned/fixed, never flagged as an orphan).
    excludeFolders: sanitizeExcludeFolders(excludeFoldersRaw, archiveFolder),
    // 0.5.4 bug fix (SCOPE): same shared includeFolders as autoSplit — null (not explicitly set)
    // defaults, at scan time, to the folder holding the index note (liveNotes() below), so a KB
    // root that also carries one-way-synced, unrelated content (project docs, a workspace mirror)
    // never has either worker wander outside the memory itself.
    includeFolders: sanitizeIncludeFolders(includeFoldersRaw),
    // 0.5.4: the AI-judgement pass (R5 orphans, a note >=2 hubs' own "## Parts" both claim) — off
    // unless BOTH structure.ai.enabled and a provider resolve (lib/ai-provider.js); the provider
    // fields themselves are shared with autoSplit's own (lib/ai-provider.js's
    // providerFieldsFrom() — same env vars, same per-provider defaults), so one key/provider
    // choice can power both features unless this section overrides it.
    ai: {
      enabled: envAiOn === "1" || envAiOn === "true" ? true : envAiOn === "0" || envAiOn === "false" ? false : aiRaw.enabled === true,
      maxDecisionsPerScan: intBound(aiRaw.maxDecisionsPerScan, 10, 1, 1000),
      timeoutMs: intBound(env.MEMGLOW_AI_TIMEOUT_MS || aiRaw.timeoutMs, 180000, 1000, 600000),
      ...aiProvider.providerFieldsFrom(aiRaw, env),
    },
  };
}

/** `store` notes → the `{id, label, text, folder}` records audit()/hub-spoke.js expect. */
function recordsFrom(notes) {
  return notes.map((n) => ({ id: n.slug || n.base, label: n.title, text: n.raw, folder: n.dir || "", rel: n.rel, description: n.description }));
}

/** The first `indexNote` candidate (titles tried in order) that resolves, or null. */
function indexIdOf(store, indexNote = ["MEMORY", "index"]) {
  for (const name of indexNote) { const n = store.resolve(name); if (n) return n.slug || n.base; }
  return null;
}

async function applyDeterministicFixes({ store, writer, issues, max = 10, log = () => {} }) {
  const byId = new Map(recordsFrom(store.notes()).map((r) => [r.id, r]));
  let applied = 0;
  const results = [];
  for (const issue of issues) {
    if (applied >= max || !issue.fix) continue;
    const built = buildFix(issue.fix, byId);
    if (!built || built.after === built.before) continue;
    const rel = built.rel;
    try {
      const t = await writer.target(rel);
      if (!t.stat) continue; // the note vanished since audit() ran
      const st = await writer.writeAtomic(t.abs, built.after, t.stat);
      store.noteWritten(t.rel, built.after, st);
      writer.wrote([t.rel]);
      applied++;
      results.push({ rule: issue.rule, note: issue.note, rel, fix: issue.fix.type });
      log(`memglow structure: ${issue.rule} — ${issue.fix.type} on ${rel}`);
    } catch (e) { log(`memglow structure: fixing ${rel} failed: ${e.message}`); }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// AI judgement (0.5.4) — for the two cases star-audit.js's own deterministic rules refuse to
// guess at: an R5 orphan (no obvious hub) and an R3 note two (or more) hubs' own "## Parts" both
// list. The AI gets the note (masked, like lib/auto-split.js's own prompt), the candidate hubs
// (slug + description) and the index's own section headings, and answers
// {"action":"attach","hub":…,"hook":…} | {"action":"index","section":…,"hook":…} |
// {"action":"leave"} — validated, then applied with the ADD-only fixes above (never a deletion).

const JUDGE_SYSTEM = [
  "You decide what to do with ONE orphaned or ambiguous note of an AI assistant's Markdown memory, laid out hub-and-spoke: a few hub notes, each listing its \"parts\" under a \"## Parts\" heading; an index note listing hubs and stand-alone notes under a few \"## Section\" headings.",
  "Answer with ONE JSON object and nothing else (no prose, no code fence):",
  "{\"action\":\"attach\",\"hub\":\"...\",\"hook\":\"...\"} — this note truly belongs under one of the listed hubs as one of its parts. \"hub\" must be EXACTLY one of the listed hub ids. \"hook\" is a short English clause for that hub's own \"- [[slug]] — hook\" line.",
  "{\"action\":\"index\",\"section\":\"...\",\"hook\":\"...\"} — this note stands on its own and belongs in the index instead. \"section\" must be EXACTLY one of the listed index section headings. \"hook\" is a short English clause for its own index line.",
  "{\"action\":\"leave\"} — neither fits with real confidence. Never guess: leaving it is always safe, a wrong attachment is not.",
  "Never invent a hub id or a section heading that is not listed below.",
].join("\n");

/** The candidate hubs (confirmed hubs, plus a stand-alone note the index itself already links to
 * — a valid "attach" target either way) and the index's own level-2 section headings, from the
 * SAME hub-spoke detection audit() uses. → { hubs: [{id,label,description}], sections: [string] }. */
function candidatesFor(notes, indexId, byId) {
  const base = hubSpoke.detect({ notes, indexId });
  const hubIds = new Set(base.hubs.map((h) => h.id));
  if (indexId && byId.has(indexId)) {
    for (const t of base._internal.outgoing.get(indexId) || []) {
      if (!base._internal.confirmedHub.has(t)) hubIds.add(t);
    }
  }
  const hubs = [...hubIds].sort().map((id) => { const n = byId.get(id); return { id, label: n && n.label, description: n && n.description }; });
  let sections = [];
  if (indexId && byId.has(indexId)) {
    const { body } = hubSpoke.splitFrontmatter(byId.get(indexId).text);
    sections = headingsOf(String(body || "")).filter((h) => h.level === 2).map((h) => h.text);
  }
  return { hubs, sections };
}

function buildJudgePrompt(note, hubs, sections) {
  const masked = maskSecrets(note.text);
  const { body } = hubSpoke.splitFrontmatter(masked);
  const lines = String(body || "").split(/\r?\n/).slice(0, 40).join("\n");
  return [
    `Note: "${note.label || note.id}" (id: ${note.id})`,
    note.description ? `Description: ${note.description}` : "",
    "First lines:",
    lines || "(empty)",
    "",
    "Candidate hubs (id — description):",
    ...(hubs.length ? hubs.map((h) => `- ${h.id} — ${h.description || h.label || ""}`) : ["(none known)"]),
    "",
    "Index sections:",
    ...(sections.length ? sections.map((s) => `- ${s}`) : ["(no index, or no sections in it)"]),
  ].filter((l) => l !== "").join("\n");
}

/** `null` when valid, else a short reason (fed back to the AI for its one retry). */
function validateDecision(d, { validHubs, validSections }) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "the answer is not a JSON object";
  if (d.action === "leave") return null;
  if (d.action === "attach") {
    if (typeof d.hub !== "string" || !validHubs.has(d.hub)) return `"hub" must be exactly one of the listed hub ids, got ${JSON.stringify(d.hub)}`;
    if (typeof d.hook !== "string" || !d.hook.trim()) return '"hook" is required (a short English clause)';
    return null;
  }
  if (d.action === "index") {
    if (typeof d.section !== "string" || !validSections.has(d.section)) return `"section" must be exactly one of the listed index sections, got ${JSON.stringify(d.section)}`;
    if (typeof d.hook !== "string" || !d.hook.trim()) return '"hook" is required (a short English clause)';
    return null;
  }
  return `unknown "action" ${JSON.stringify(d.action)} (expected attach, index or leave)`;
}

/** Applies one validated decision — ADD-only, through the store/writer, same as every other fix. */
async function applyDecision({ store, writer, note, decision, indexId, byId, log }) {
  if (decision.action === "leave") { log(`memglow structure: AI left "${note.id}" as is`); return []; }
  const results = [];
  const write = async (built) => {
    if (!built || built.after === built.before) return false;
    const t = await writer.target(built.rel);
    if (!t.stat) return false; // vanished since audit() ran
    const st = await writer.writeAtomic(t.abs, built.after, t.stat);
    store.noteWritten(t.rel, built.after, st);
    writer.wrote([t.rel]);
    return true;
  };
  if (decision.action === "attach") {
    const built1 = buildFix({ type: "attach", note: note.id, hub: decision.hub }, byId);
    if (await write(built1)) {
      byId.set(note.id, { ...byId.get(note.id), text: built1.after });
      results.push({ rule: "AI", note: note.id, rel: built1.rel, fix: "attach" });
    }
    const built2 = buildFix({ type: "append-hub-parts-line", hub: decision.hub, part: note.id, hook: decision.hook }, byId);
    if (await write(built2)) results.push({ rule: "AI", note: decision.hub, rel: built2.rel, fix: "append-hub-parts-line" });
    log(`memglow structure: AI attached "${note.id}" to "${decision.hub}" (${results.length} file(s) changed)`);
    return results;
  }
  if (decision.action === "index") {
    const built = buildFix({ type: "append-index-section-line", index: indexId, section: decision.section, note: note.id, hook: decision.hook }, byId);
    if (await write(built)) {
      results.push({ rule: "AI", note: note.id, rel: built.rel, fix: "append-index-section-line" });
      log(`memglow structure: AI indexed "${note.id}" under "${decision.section}"`);
    }
    return results;
  }
  return results;
}

/**
 * judgeIssues({ store, writer, project, cfg, env, dataDir, log, indexId, notes, issues, aiRun }) —
 * up to cfg.ai.maxDecisionsPerScan R5/ambiguous-R3 issues, one AI call each (one retry on an
 * invalid/unparseable answer), applied with ADD-only fixes. `aiRun` (tests): a fake
 * `(prompt) => Promise<{ok,text,error}>`, bypassing the real provider entirely. Returns the
 * applied-fix array, as always, with an extra `.authError` property (0.5.4 bug fix) set when a
 * bad credential (never fixed by retrying) stopped the REST of this call's candidates outright —
 * the caller (createStructureWorker below) turns that into a persistent `lastError`.
 */
async function judgeIssues({ store, writer, cfg, env, dataDir, log, indexId, notes, issues, aiRun }) {
  const byId = new Map(recordsFrom(store.notes()).map((r) => [r.id, r]));
  const { hubs, sections } = candidatesFor(notes, indexId, byId);
  const validHubs = new Set(hubs.map((h) => h.id));
  const validSections = new Set(sections);
  const candidates = issues.filter((i) => !i.fix && (i.rule === "R5" || (i.rule === "R3" && typeof i.detail === "string" && i.detail.startsWith("claimed by"))));
  const results = [];
  let n = 0;
  for (const issue of candidates) {
    if (n >= cfg.ai.maxDecisionsPerScan) break;
    const note = byId.get(issue.note);
    if (!note) continue;
    n++;
    const prompt = buildJudgePrompt(note, hubs, sections);
    let decision = null, err = null, authError = false;
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {
      const p = attempt ? `${prompt}\n\nYour last answer was refused: ${err}. Answer again with the full JSON object.` : prompt;
      let ai;
      try {
        ai = aiRun ? await aiRun(p) : await aiProvider.run(cfg.ai, { system: JUDGE_SYSTEM, prompt: p, timeoutMs: cfg.ai.timeoutMs }, { dataDir, env });
      } catch (e) { ai = { ok: false, error: e.message }; }
      if (!ai || !ai.ok) {
        err = (ai && ai.error) || "the AI provider failed";
        // A bad credential is never fixed by a retry with error feedback (that is for an
        // invalid/unparseable answer, not an auth failure) — stop at once.
        if (aiProvider.isAuthError(err)) { authError = true; break; }
        continue;
      }
      let parsed;
      try { parsed = parsePlan(ai.text); } catch (e) { err = e.message; continue; }
      const verr = validateDecision(parsed, { validHubs, validSections });
      if (verr) { err = verr; continue; }
      decision = parsed;
    }
    if (authError) {
      results.authError = err;
      log(`memglow structure: AI judgement stopped for this scan — auth error: ${err}`);
      break; // never hammer the provider once per remaining candidate
    }
    if (!decision) { log(`memglow structure: AI judgement for "${issue.note}" failed: ${err}`); continue; }
    const applied = await applyDecision({ store, writer, note, decision, indexId, byId, log });
    results.push(...applied);
  }
  return results;
}

function createStructureWorker({ store, writer, config, env = process.env, dataDir = null, log = () => {}, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, indexNote = ["MEMORY", "index"], aiRun = null }) {
  const cfg = structureSettings(config, env);
  const events = createEventLog({ dir: dataDir, file: "structure-log.json", keepMs: 90 * 86400000, max: 500, now, label: "structure", clean: (e) => (e && typeof e.t === "number" && typeof e.kind === "string" ? { t: e.t, kind: e.kind, note: String(e.note || "").slice(0, 200), detail: String(e.detail || "").slice(0, 500) } : null) });
  let lastScanAt = null;
  let lastSummary = { total: 0, fixable: 0, needsReview: 0, byRule: {} };
  // 0.5.4 bug fix: a bad credential seen by the AI judgement pass is never fixed by retrying —
  // kept here (cleared only by a restart, once the key/token is actually fixed) so every later
  // scan's AI pass skips outright instead of hammering the provider once per candidate.
  let lastError = null;
  /** `/api/maintenance` (memory-server/http.js) and memory_core's own status line. */
  function status() {
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return {
      enabled: !!cfg.enabled, ai: { enabled: !!cfg.ai.enabled, provider: cfg.ai.provider, model: cfg.ai.model }, issues: lastSummary, lastScanAt, nextScanAt,
      lastError: lastError ? { t: lastError.t, message: lastError.message } : null,
    };
  }
  if (!cfg.enabled || !writer || !store) return { start() {}, stop() {}, scanOnce: async () => [], recentEvents: () => [], status, inert: true };
  let timer = null;
  let warnedNoAiProvider = false;
  /** Every note this worker is allowed to look at at all — excludeFolders and `memglow_split:
   * false` notes are filtered out BEFORE audit() ever sees them (never reported, never fixed,
   * never counted as an orphan), same two opt-outs lib/auto-split.js's own candidate() honours. */
  function liveNotes() {
    const includeFolders = effectiveIncludeFolders(cfg, store, indexNote);
    return recordsFrom(store.notes().filter((n) =>
      underIncluded(n.rel, includeFolders) && !underExcluded(n.rel, cfg.excludeFolders) && !(n.frontmatter && n.frontmatter.memglow_split === false)));
  }
  /**
   * Applying one fix can surface another (adding `part_of:` to a loose note confirms it, which
   * then needs its own `Up:` line too) — rounds re-run audit() against the freshly written store
   * until a round changes nothing or the scan's own fix budget runs out, so one `scanOnce()`
   * already converges: a second, separate scan then finds nothing left (idempotence). The AI
   * judgement pass (0.5.4), when `structure.ai.enabled` AND a provider is configured, runs once
   * more after that, against whatever R5/ambiguous-R3 issues are still standing. Every applied fix
   * (deterministic or AI) is logged, and the issues left at the end of the scan are cached for
   * `status()` (memory_core, `/api/maintenance`) without re-running audit() on every call.
   */
  async function scanOnce() {
    lastScanAt = now();
    const applied = [];
    let budget = cfg.maxFixesPerScan;
    for (let round = 0; round < 5 && budget > 0; round++) {
      const indexId = indexIdOf(store, indexNote);
      const notes = liveNotes();
      const issues = audit({ notes, indexId, archiveFolder: cfg.archiveFolder });
      const r = await applyDeterministicFixes({ store, writer, issues, max: budget, log });
      if (!r.length) break;
      applied.push(...r);
      budget -= r.length;
    }
    if (cfg.ai.enabled && !lastError) {
      const d = aiRun ? { available: true } : aiProvider.detect(cfg.ai, { dataDir, env });
      if (!d.available) {
        if (!warnedNoAiProvider) { warnedNoAiProvider = true; log(`memglow structure: structure.ai is enabled, but no AI provider is available (${d.reason || "unknown reason"}) — staying inert for judgement calls`); }
      } else {
        const indexId = indexIdOf(store, indexNote);
        const notes = liveNotes();
        const issues = audit({ notes, indexId, archiveFolder: cfg.archiveFolder });
        const r = await judgeIssues({ store, writer, cfg, env, dataDir, log, indexId, notes, issues, aiRun });
        if (r.authError) lastError = { t: now(), message: String(r.authError).slice(0, 300) };
        applied.push(...r);
      }
    }
    for (const a of applied) events.add({ t: now(), kind: "fix", note: a.note, detail: `${a.rule} — ${a.fix} on ${a.rel}` });
    const indexId = indexIdOf(store, indexNote);
    const notes = liveNotes();
    lastSummary = summarize(audit({ notes, indexId, archiveFolder: cfg.archiveFolder }));
    return applied;
  }
  function start() {
    scanOnce().catch((e) => log(`memglow structure: scan failed: ${e.message}`));
    if (cfg.scanHours > 0) {
      const ms = Math.min(cfg.scanHours * 3600000, 2147483647);
      timer = setIntervalFn(() => { scanOnce().catch(() => {}); }, ms);
      if (timer && timer.unref) timer.unref();
    }
  }
  function stop() { if (timer) clearIntervalFn(timer); timer = null; events.flush(); }
  return { start, stop, scanOnce, recentEvents: (since) => events.events(since), status, inert: false };
}

module.exports = {
  audit, summarize, buildFix, partsBulletsOf, PARTS_HEADING_RE, joinHeadBody, declaredPartOfMap,
  structureSettings, applyDeterministicFixes, createStructureWorker, recordsFrom, indexIdOf,
  candidatesFor, buildJudgePrompt, validateDecision, applyDecision, judgeIssues, JUDGE_SYSTEM,
};
