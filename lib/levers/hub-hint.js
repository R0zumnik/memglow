"use strict";
/**
 * MCP proxy levers — lever 16, hubHint (0.4.12.4 split of lib/proxy-levers.js, see that file's
 * own top comment).
 */
const { sectionSpans } = require("../cost");
const { significantWords } = require("../learned-aliases");
const { declaredHubOf } = require("../hub-spoke");
const { block, oneLine } = require("./responses");

// ---------------------------------------------------------------------------------------------
// Lever 16 — hubHint: see the module's top comment. Pure-ish helpers (only `index.noteText`/
// `index.resolve`/`index.note`/`index.allNotes` are consulted, never a write), testable with a
// fake index.

const HUB_HINT_EDIT_OPS = new Set(["append", "prepend", "insert_before_section", "insert_after_section"]);
const HUB_HINT_MAX_PARTS = 4;
// "- [[slug]] — hook" (or "* slug) : hook", "1. [[slug]] - hook"…): a bullet/numbered line naming
// one note, with an optional "hook" after a dash/colon separator (em/en dash, hyphen or colon).
const PARTS_LINE_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s*\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*(?:[-–—:]\s*(.*))?$/;

/** The bullet lines of a note's own "## Parts" section (any heading level, case-insensitive
 * title match) — [{ ref, hook }], ref = the raw [[link]] target, hook = the text after the dash/
 * colon ("" when there is none). [] when there is no such section, or `text` is empty. */
function parsePartsSection(text) {
  if (!text) return [];
  let spans;
  try { spans = sectionSpans(text); } catch { return []; }
  const span = spans.find((s) => s.title && s.title.trim().toLowerCase() === "parts");
  if (!span) return [];
  const out = [];
  for (const line of text.slice(span.start, span.end).split(/\r?\n/)) {
    const m = PARTS_LINE_RE.exec(line);
    if (m) out.push({ ref: m[1].trim(), hook: (m[2] || "").trim() });
  }
  return out;
}

/**
 * Lever 16 (hubHint) — the parts of hub `hubId`: [{ id, hook }], hook = "" when there is none to
 * show. Two ways to find them, EITHER is enough (the hub's own "## Parts" list, when non-empty,
 * is trusted outright — it is the authoritative, owner-maintained list; the frontmatter scan
 * below is a fallback for a hub that has no such heading yet, not a merge, so a part freshly
 * declared but not yet listed is still found when there is no list at all to contradict it):
 *  - the hub's own "## Parts" bullet lines, resolved through `index.resolve` when possible (a
 *    non-kebab or stale reference falls back to the raw ref itself, deduplicated by whatever
 *    string ends up naming it);
 *  - failing that, any OTHER note whose frontmatter declares `part_of`/`parent` this hub — the
 *    same marker lib/hub-spoke.js's declaredHubOf() trusts outright, matched case-insensitively
 *    against the hub's own id AND label (so a part naming the hub by its title still counts).
 * [] when the hub's own text cannot be read, or neither way finds anything.
 */
function hubPartsFor(index, hubId) {
  // Same exclusions as duplicateHint: the index note is never a hub to hint about, and archived
  // notes are never a hub nor a part to recommend (0.5.0 review).
  const isArchive = typeof index.isArchive === "function" ? index.isArchive : () => false;
  const noteOf = (id) => (typeof index.note === "function" ? index.note(id) : null);
  const excluded = (id) => { const n = noteOf(id); return isArchive(id) || !!(n && n.theme === "index"); };
  if (excluded(hubId)) return [];
  const parts = new Map(); // id (or raw ref) -> hook
  const hubText = typeof index.noteText === "function" ? index.noteText(hubId) : null;
  for (const { ref, hook } of parsePartsSection(hubText)) {
    const id = (typeof index.resolve === "function" && index.resolve(ref)) || ref;
    if (id && id !== hubId && !parts.has(id) && !isArchive(id)) parts.set(id, hook);
  }
  if (parts.size) return [...parts.entries()].map(([id, hook]) => ({ id, hook }));
  const hub = noteOf(hubId);
  const hubLabel = hub && hub.label ? String(hub.label).trim().toLowerCase() : "";
  const all = typeof index.allNotes === "function" ? index.allNotes() : [];
  for (const n of all) {
    if (!n || n.id === hubId || parts.has(n.id) || excluded(n.id)) continue;
    const text = typeof index.noteText === "function" ? index.noteText(n.id) : null;
    // Cheap pre-filter: only notes that mention a part marker are parsed.
    const declared = text && /\b(part_of|parent)\s*:/.test(text) ? declaredHubOf(text) : null;
    if (!declared) continue;
    const dl = declared.trim().toLowerCase();
    if (dl === hubId.toLowerCase() || (hubLabel && dl === hubLabel)) parts.set(n.id, "");
  }
  return [...parts.entries()].map(([id, hook]) => ({ id, hook }));
}

/**
 * Lever 16 (hubHint) for one qualifying write (see HUB_HINT_EDIT_OPS / the module's top comment):
 * ranks `hubPartsFor(index, hubId)`'s parts by shared significant words with `addedText` (best
 * match first — "If the added text clearly matches one part… name it first"), then builds the
 * one advisory block. null when the hub has no parts at all.
 */
function hubHintFor(index, hubId, addedText) {
  const parts = hubPartsFor(index, hubId);
  if (!parts.length) return null;
  const addedWords = new Set(significantWords(addedText));
  const scored = parts.map((p) => {
    const n = typeof index.note === "function" ? index.note(p.id) : null;
    const topic = p.hook || (n && (n.description || n.label)) || "";
    let shared = 0;
    if (addedWords.size) { const tw = significantWords(topic); for (const w of tw) if (addedWords.has(w)) shared++; }
    return { id: p.id, topic, shared };
  });
  scored.sort((a, b) => b.shared - a.shared);
  const shown = scored.slice(0, HUB_HINT_MAX_PARTS);
  const more = scored.length > shown.length ? "…" : "";
  const hub = typeof index.note === "function" ? index.note(hubId) : null;
  const hubLabel = hub ? oneLine(hub.label, 60) : hubId;
  const named = shown.map((p) => `[[${p.id}]]${p.topic ? ` (${oneLine(p.topic, 60)})` : ""}`);
  return block(`memglow: "${hubLabel}" is a hub — add detail to one of its parts instead: ${named.join(", ")}${more}`);
}



module.exports = { HUB_HINT_EDIT_OPS, HUB_HINT_MAX_PARTS, parsePartsSection, hubPartsFor, hubHintFor };
