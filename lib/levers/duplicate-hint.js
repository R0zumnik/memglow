"use strict";
/**
 * MCP proxy levers — levers 14 (duplicateHint) and 15 (slugHint) (0.4.12.4 split of
 * lib/proxy-levers.js, see that file's own top comment).
 */
const path = require("path");
const { significantWords } = require("../learned-aliases");
const { generatePermalink, sanitizeForFilename } = require("../store/permalink");
const { block, oneLine } = require("./responses");

// ---------------------------------------------------------------------------------------------
// Lever 14 — duplicateHint: see the module's top comment. Pure helpers, testable alone: none of
// them touches `index.resolve`/`index.allNotes`/`index.isArchive` directly — the caller
// (duplicateHintFor, right below) does that and passes already-filtered data in.

const DUPLICATE_HINT_MIN_SHARED = 2;
const DUPLICATE_HINT_COVERAGE = 0.6;
const DUPLICATE_HINT_MAX_CANDIDATES = 2;

/** Significant words of a note's OWN identifying text (id + label + description) — the SAME
 * helper (EN+FR stop-words, secret-masked, >= 3 characters, lib/learned-aliases.js
 * significantWords) used for the title's own words, so a French title can match a French note
 * and an English one an English note, symmetrically. */
function noteWords(note) {
  return significantWords([note && note.id, note && note.label, note && note.description].filter(Boolean).join(" "));
}

/**
 * Candidate notes a `write_note`'s `title` is a likely duplicate of — conservative on purpose (a
 * false hint costs more than a missed one, see the module's top comment): a note only qualifies
 * when it shares >= DUPLICATE_HINT_MIN_SHARED of `titleWords` (significantWords(title), computed
 * by the caller) AND those shared words cover >= DUPLICATE_HINT_COVERAGE of `titleWords` itself —
 * a title with fewer than 2 significant words can never match anything, by construction (nothing
 * specific enough to compare). `notes` is a plain [{ id, label, description, tokens }] array,
 * already filtered by the caller (duplicateHintFor excludes index notes and notes in the archive
 * folder before calling this). Ranked by shared-word count (desc), then note size (desc — a
 * tie-break only, never a size preference), then id (for a deterministic order); capped to
 * DUPLICATE_HINT_MAX_CANDIDATES. Pure, never throws on malformed input.
 */
function duplicateHintCandidates(titleWords, notes) {
  if (!Array.isArray(titleWords) || titleWords.length < DUPLICATE_HINT_MIN_SHARED) return [];
  const titleSet = new Set(titleWords);
  const need = Math.max(DUPLICATE_HINT_MIN_SHARED, Math.ceil(titleWords.length * DUPLICATE_HINT_COVERAGE));
  const scored = [];
  for (const n of notes || []) {
    if (!n || typeof n.id !== "string" || !n.id) continue;
    const words = new Set(noteWords(n));
    let shared = 0;
    for (const w of titleSet) if (words.has(w)) shared++;
    if (shared >= DUPLICATE_HINT_MIN_SHARED && shared >= need) scored.push({ id: n.id, shared, tokens: Number(n.tokens) || 0 });
  }
  scored.sort((a, b) => b.shared - a.shared || b.tokens - a.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, DUPLICATE_HINT_MAX_CANDIDATES).map((s) => s.id);
}

/**
 * The one advisory block duplicateHint ever adds — exact (one id) or similar (1-2 ids, already
 * ranked by duplicateHintCandidates). Labels pass through `oneLine` (secret-masked, capped) like
 * every other lever's own text here; never a note's body.
 */
/**
 * Lever 15 (slugHint, 0.4.10.9) — the one advisory line for a `write_note` whose title is not a
 * kebab slug ("chantier-eau-cave", lower-case ASCII words joined by "-"), or whose directory is
 * the notes root itself ("", "/", "memory", or the notes folder's own name). null when neither.
 * The suggested slug is the one `--kebab-filenames` would give the file (accents transliterated).
 */
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function slugHintFor(args, memoryDir) {
  if (!args || typeof args.title !== "string" || !args.title.trim()) return null;
  const title = args.title.trim();
  const rawDir = typeof args.directory === "string" ? args.directory : typeof args.folder === "string" ? args.folder : "";
  const dir = rawDir.replace(/\\/g, "/").trim().replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const rootNames = new Set(["", ".", "memory"]);
  if (memoryDir) rootNames.add(path.basename(memoryDir).toLowerCase());
  const atRoot = rootNames.has(dir);
  const isSlug = KEBAB_SLUG_RE.test(title);
  if (isSlug && !atRoot) return null;
  let slug = "";
  try { slug = generatePermalink(sanitizeForFilename(title)).replace(/\//g, "-").replace(/\./g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""); } catch { slug = ""; }
  const where = atRoot ? " in a memory/<folder>/ directory" : "";
  if (!isSlug) return block(`memglow: title "${oneLine(title, 100)}" is not a kebab slug — prefer "${slug || "a-kebab-slug"}"${where} (title = kebab slug, file = slug.md).`);
  return block(`memglow: note "${title}" was written directly in the notes root folder — prefer a memory/<folder>/ directory.`);
}

function duplicateHintBlock(index, exactId, similarIds) {
  if (exactId) {
    return block(`memglow: a note with this title already exists: [[${exactId}]] — this write_note may replace or duplicate it; prefer edit_note.`);
  }
  if (Array.isArray(similarIds) && similarIds.length) {
    const parts = similarIds.map((id) => {
      const n = index && typeof index.note === "function" ? index.note(id) : null;
      return n ? `[[${id}]] (${oneLine(n.label, 80)})` : `[[${id}]]`;
    });
    return block(`memglow: a note on this subject already exists — ${parts.join("; ")}. Prefer edit_note on it (append / replace_section) over a new note.`);
  }
  return null;
}

/**
 * Lever 14 (duplicateHint) for one `write_note` call's own arguments — `{ exact: id }` when the
 * title itself (or its kebab slug, or its label — whatever `index.resolve` already matches, same
 * helper every other lever uses) names an EXISTING note; `{ similar: [id, ...] }` (1-2 ids) when
 * it does not but is close enough to one or two (duplicateHintCandidates); or null when there is
 * nothing to warn about (no usable `title`, no match either way). Exact wins outright over
 * similar — a title that already IS a note's own name is a stronger signal than a handful of
 * shared words, and showing both would just be noisier. Index notes and notes in the archive
 * folder never count for the SIMILAR rule; an exact match bypasses that filter entirely (resolve()
 * does not special-case either kind, and nor does this). Called from `oneFromClient`, BEFORE the
 * write reaches the server — `index` still reflects the memory as it was before this very call.
 */
function duplicateHintFor(index, args) {
  const title = args && typeof args.title === "string" ? args.title.trim() : "";
  if (!title || !index) return null;
  const exact = index.resolve(title);
  if (exact) return { exact };
  const titleWords = significantWords(title);
  if (titleWords.length < DUPLICATE_HINT_MIN_SHARED) return null;
  const all = typeof index.allNotes === "function" ? index.allNotes() : [];
  const isArchive = typeof index.isArchive === "function" ? index.isArchive : () => false;
  const notes = all.filter((n) => n && n.theme !== "index" && !isArchive(n.id));
  const similar = duplicateHintCandidates(titleWords, notes);
  return similar.length ? { similar } : null;
}



module.exports = {
  DUPLICATE_HINT_MIN_SHARED, DUPLICATE_HINT_COVERAGE, DUPLICATE_HINT_MAX_CANDIDATES,
  noteWords, duplicateHintCandidates, duplicateHintBlock, duplicateHintFor,
  KEBAB_SLUG_RE, slugHintFor,
};
