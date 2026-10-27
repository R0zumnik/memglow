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
 * randomness. `fix` is null for the cases that genuinely need judgement (an orphan with no
 * candidate hub, a note two hubs' `## Parts` both list, which index section a hub belongs under,
 * hook wording) — NOT decided here (a future pass would ask the same pluggable AI provider
 * lib/auto-split.js already uses, the same way, with the same one-retry discipline; this stage
 * ships detection only for those, not an automatic decision) — and a small, mechanical descriptor
 * otherwise, turned into an exact file edit by `buildFix()`, applied the same way
 * lib/split-engine.js applies a split plan: through the store/writer, never a hand-rolled write.
 */
const hubSpoke = require("./hub-spoke");
const { splitNote: splitFM, replaceBlock } = require("./store/note-edit");

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
  const issues = [];

  // R2 — a confirmed part with no link back to its hub at all (hub-spoke's missingUplinks).
  for (const { hub, note } of base.missingUplinks) {
    issues.push({ rule: "R2", note, fix: { type: "add-up-line", note, hub } });
  }

  // R3 (half 1) — a confirmed part the hub does not (yet) list back (hub-spoke's missingHubLines).
  for (const { hub, note } of base.missingHubLines) {
    issues.push({ rule: "R3", note: hub, fix: { type: "append-hub-parts-line", hub, part: note } });
  }

  // R4 — a part's own body naming >= 2 of its siblings. 0.5.4: reported, never fixed automatically —
  // the maintenance worker only ever ADDS lines/keys (Up, part_of, ## Parts, index lines); deleting
  // a note's own line, even a pure sibling-link line, stays a human/AI decision. buildFix still
  // knows "remove-line" for an explicit caller.
  for (const sl of base.siblingLines) {
    issues.push({ rule: "R4", note: sl.note, lineIndex: sl.lineIndex, fix: null, detail: sl.pure ? "a line made only of sibling links (removable by hand)" : "links sit inside prose, not a removable line alone" });
  }

  // R1 — the index links to a confirmed part. Fix: point that line at the part's hub instead (or
  // drop the line outright when the hub is already listed there too).
  if (indexId && byId.has(indexId)) {
    const indexOut = outgoing.get(indexId) || new Set();
    const indexLines = linesById.get(indexId) || [];
    for (const p of [...indexOut].sort()) {
      const hub = confirmedHub.get(p);
      if (!hub || hub === indexId) continue;
      const li = indexLines.findIndex((l) => l.links.includes(p));
      issues.push({ rule: "R1", note: indexId, fix: { type: "replace-index-line", index: indexId, part: p, hub, lineIndex: li >= 0 ? li : null, hubAlreadyListed: indexOut.has(hub) } });
    }
  }

  // R3 (half 2) — a hub's own "## Parts" names a note with NO part_of at all. Only fixed
  // automatically when exactly ONE hub's list claims it (two claiming the same note is left for
  // review: picking the "right" one needs judgement, not a coin flip).
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
    if (!targetNote || confirmedHub.has(target) || hasPartOfKey(targetNote.text)) continue;
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
    const after = block == null ? newBody : (head.endsWith("\n") ? head : head + "\n") + "\n" + newBody;
    return { rel: relOf(n), before: n.text, after };
  }
  if (fix.type === "append-hub-parts-line") {
    const hub = byId.get(fix.hub), part = byId.get(fix.part);
    if (!hub || !part) return null;
    const { block, head, body } = splitFM(hub.text);
    const b = String(body || "");
    const { start, bullets } = partsBulletsOf(hub.text);
    if (bullets.some((x) => x.target === fix.part || x.target.toLowerCase() === fix.part.toLowerCase())) return null; // already there
    const hook = (part.description || part.label || fix.part);
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
    const after2 = block == null ? newBody : (head.endsWith("\n") ? head : head + "\n") + "\n" + newBody;
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
    const after = block == null ? newBody : (head.endsWith("\n") ? head : head + "\n") + "\n" + newBody;
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
    const after = block == null ? newBody : (head.endsWith("\n") ? head : head + "\n") + "\n" + newBody;
    return { rel: relOf(idx), before: idx.text, after };
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
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    scanHours: intBound(a.scanHours, 24, 0, 168),
    maxFixesPerScan: intBound(a.maxFixesPerScan, 10, 1, 1000),
    archiveFolder: typeof a.archiveFolder === "string" && a.archiveFolder.trim() ? a.archiveFolder.trim() : "archive",
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

function createStructureWorker({ store, writer, config, env = process.env, dataDir = null, log = () => {}, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, indexNote = ["MEMORY", "index"] }) {
  const cfg = structureSettings(config, env);
  if (!cfg.enabled || !writer || !store) return { start() {}, stop() {}, scanOnce: async () => [], inert: true };
  let timer = null;
  /**
   * Applying one fix can surface another (adding `part_of:` to a loose note confirms it, which
   * then needs its own `Up:` line too) — rounds re-run audit() against the freshly written store
   * until a round changes nothing or the scan's own fix budget runs out, so one `scanOnce()`
   * already converges: a second, separate scan then finds nothing left (idempotence).
   */
  async function scanOnce() {
    const applied = [];
    let budget = cfg.maxFixesPerScan;
    for (let round = 0; round < 5 && budget > 0; round++) {
      const indexId = indexIdOf(store, indexNote);
      const notes = recordsFrom(store.notes());
      const issues = audit({ notes, indexId, archiveFolder: cfg.archiveFolder });
      const r = await applyDeterministicFixes({ store, writer, issues, max: budget, log });
      if (!r.length) break;
      applied.push(...r);
      budget -= r.length;
    }
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
  function stop() { if (timer) clearIntervalFn(timer); timer = null; }
  return { start, stop, scanOnce, inert: false };
}

module.exports = {
  audit, summarize, buildFix, partsBulletsOf, PARTS_HEADING_RE,
  structureSettings, applyDeterministicFixes, createStructureWorker, recordsFrom, indexIdOf,
};
