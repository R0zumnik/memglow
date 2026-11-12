"use strict";
/**
 * Duplicate CANDIDATES — a cheap lexical pre-filter (no AI, no merge, no write; 0.6.0). Pairs of
 * notes whose id/title/description share enough significant words are listed by the structure
 * audit (lib/star-audit.js) as rule "D1 possible duplicate", report-only: a human decides.
 * (Until 0.5.11 an AI confirmed each pair and could auto-merge; that worker was removed in 0.6.0.)
 * The filters below were tuned on real knowledge bases (0.5.5 - 0.5.8): they exist to keep
 * unrelated notes that merely share generic words out of the list.
 */
const { noteWords } = require("./levers/duplicate-hint");
const { significantWords } = require("./learned-aliases");

const MAX_NOTES_CHECKED = 300; // cheap-detection pass, same cap spirit as lib/archive.js's own
// 0.5.5: stricter than lib/levers/duplicate-hint.js's own DUPLICATE_HINT_MIN_SHARED/COVERAGE (2,
// 0.6) — those are tuned for a single write_note advisory hint, not for feeding an AI call;
// tighter here measurably cut unrelated pairs in a real-KB run (module doc above).
const MIN_SHARED = 3;
const MIN_COVERAGE = 0.7;
// 0.5.5 bug fix: words common enough across UNRELATED notes (memglow's own name, generic
// note-taking vocabulary) to drive a false match on their own — dropped from the overlap before
// MIN_SHARED/MIN_COVERAGE are checked. Not a linguistic resource, just the words seen doing this.
const GENERIC_WORDS = new Set([
  "memglow", "project", "projects", "note", "notes", "update", "updates", "log", "logs",
  "entry", "entries", "date", "dated", "day", "days", "week", "weeks", "month", "months",
  "year", "years", "today", "status", "summary", "overview", "general", "misc", "draft",
]);
const DATE_WORD_RE = /^\d{4}(-\d{2}(-\d{2})?)?$|^\d+$/; // a bare number, or a YYYY / YYYY-MM / YYYY-MM-DD token

/** `noteWords(n)` (lib/levers/duplicate-hint.js) with GENERIC_WORDS and any bare-number/date
 * token removed — see the module's own 0.5.5 doc above. */
function significantWordsOf(n) {
  return noteWords(n).filter((w) => !GENERIC_WORDS.has(w) && !DATE_WORD_RE.test(w));
}

/** 0.5.6: the note's own LABEL/title alone (never id/description, both noisier) — same
 * GENERIC_WORDS/date filtering as significantWordsOf() above. */
function titleWordsOf(n) {
  return significantWords(String((n && n.label) || "")).filter((w) => !GENERIC_WORDS.has(w) && !DATE_WORD_RE.test(w));
}

/** 0.5.6: the slug's own leading `word-` segment, lowercased — "feedback-autonomy-x" -> "feedback",
 * "project-memglow-v04-strategy" -> "project". Null when the id carries no "-". */
function familyOf(id) {
  const m = /^([a-z0-9]+)-/.exec(String(id || "").toLowerCase());
  return m ? m[1] : null;
}

// 0.5.6: two different KINDs of note by construction — never paired, whatever words they share.
const NEVER_PAIRED_FAMILIES = [["feedback", "project"]];

function neverPaired(idA, idB) {
  const fa = familyOf(idA), fb = familyOf(idB);
  return NEVER_PAIRED_FAMILIES.some(([x, y]) => (fa === x && fb === y) || (fa === y && fb === x));
}

/** `b` is `a` with a "-" and at least one more character appended — "project-ibs-initiatives-
 * europe" / "project-ibs-initiatives-europe-silvae-market-decks" — never the other way without
 * the hyphen (so "coffee" never "matches" "coffeemaker"). */
function hyphenPrefixed(a, b) {
  return typeof a === "string" && typeof b === "string" && !!a && !!b && b.startsWith(a + "-");
}

/** 0.5.8: `a`/`b` are the same SPLIT FAMILY — a note split into further, more specific notes
 * under/alongside it — and so never "duplicates" of each other, whatever words they share
 * (module doc above): either id is a literal "-"-bounded prefix of the other's (a hub's own slug
 * reused as the start of its parts' slugs), OR both declare the SAME `part_of` AND one id starts
 * with the other's (siblings split from the same parent, sharing its slug as a prefix even
 * without the "-" boundary). Checked before any AI call, same spirit as neverPaired()/the
 * declared-theme guard above — a structural/naming signal beats inferred word overlap. Pure. */
function sameSplitFamily(idA, idB, partOfA, partOfB) {
  if (hyphenPrefixed(idA, idB) || hyphenPrefixed(idB, idA)) return true;
  if (partOfA && partOfB && partOfA === partOfB) {
    if ((idA !== idB) && (String(idB).startsWith(idA) || String(idA).startsWith(idB))) return true;
  }
  return false;
}

/**
 * Cheap candidate PAIRS among `notes` ([{id,label,description,theme?,tokens}]) — reuses
 * lib/levers/duplicate-hint.js's own noteWords() (the id+label+description significant-word
 * extractor), filtered through significantWordsOf() above (GENERIC_WORDS, bare numbers/dates
 * dropped), and computes its OWN, stricter overlap directly: >= MIN_SHARED significant words in
 * common AND covering >= MIN_COVERAGE of the SHORTER side's own word count (0.5.5: tighter than
 * the proxy lever's own thresholds — module doc above). 0.5.5 bug fix: a pair whose two notes
 * BOTH declare a `theme` and it differs is excluded outright, before the word overlap is even
 * computed — same "declared beats inferred, never guess across an explicit boundary" spirit as
 * lib/star-audit.js's hub-attach guard. Deduped (a,b) == (b,a), ranked by shared-word count then
 * combined size, capped to MAX_NOTES_CHECKED notes checked (biggest first — same bias as
 * lib/archive.js's own detection cap). 0.5.6: ALSO requires — on top of every check above — the
 * SAME declared `subtheme` when BOTH notes set one, OR a title-word overlap of >= 2 significant
 * words (module doc above); and NEVER pairs a `feedback-*` id with a `project-*` one. 0.5.8: ALSO
 * never pairs two notes of the same split family (sameSplitFamily() above) — `notes` may carry an
 * optional `partOf` (the note's own declared `part_of`, trimmed) for that check; absent, only the
 * id-prefix half of the rule can fire. Pure.
 */
function findDuplicatePairs(notes) {
  const pool = (notes || []).filter((n) => n && n.id).sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, MAX_NOTES_CHECKED);
  const wordsOf = new Map(pool.map((n) => [n.id, new Set(significantWordsOf(n))]));
  const titleWordsOfMap = new Map(pool.map((n) => [n.id, new Set(titleWordsOf(n))]));
  const themeOf = new Map(pool.map((n) => [n.id, n.theme || null]));
  const subthemeOf = new Map(pool.map((n) => [n.id, n.subtheme || null]));
  const partOfOf = new Map(pool.map((n) => [n.id, n.partOf || null]));
  const pairs = [];
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i], wa = wordsOf.get(a.id);
    if (wa.size < MIN_SHARED) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j], wb = wordsOf.get(b.id);
      if (wb.size < MIN_SHARED) continue;
      if (neverPaired(a.id, b.id)) continue; // 0.5.6: a feedback/* note is never paired with a project/* one
      if (sameSplitFamily(a.id, b.id, partOfOf.get(a.id), partOfOf.get(b.id))) continue; // 0.5.8: same split family
      const ta = themeOf.get(a.id), tb = themeOf.get(b.id);
      if (ta && tb && ta !== tb) continue; // 0.5.5 bug fix: different declared themes, never a pair
      let shared = 0;
      for (const w of wa) if (wb.has(w)) shared++;
      if (shared < MIN_SHARED) continue;
      const coverage = shared / Math.min(wa.size, wb.size);
      if (coverage < MIN_COVERAGE) continue;
      // 0.5.6 bug fix: same broad theme is not enough on its own (module doc above) — also
      // require the same declared subtheme (when both set it) OR a real title-word overlap.
      const sa = subthemeOf.get(a.id), sb = subthemeOf.get(b.id);
      const sameSubtheme = !!sa && !!sb && sa === sb;
      if (!sameSubtheme) {
        const ta2 = titleWordsOfMap.get(a.id), tb2 = titleWordsOfMap.get(b.id);
        let titleOverlap = 0;
        for (const w of ta2) if (tb2.has(w)) titleOverlap++;
        if (titleOverlap < 2) continue;
      }
      pairs.push({ a: a.id, b: b.id, shared, score: Math.round(coverage * 100) / 100, tokens: (a.tokens || 0) + (b.tokens || 0) });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared || y.tokens - x.tokens || (x.a + x.b < y.a + y.b ? -1 : 1));
  return pairs;
}

module.exports = { findDuplicatePairs, significantWordsOf, titleWordsOf, familyOf, neverPaired, sameSplitFamily, GENERIC_WORDS, MAX_NOTES_CHECKED };

/**
 * Old `maintenance.duplicates` config (enabled / ai provider / autoMerge …) and its env switches
 * (MEMGLOW_AUTO_DUPLICATES, MEMGLOW_AUTO_DUPLICATES_MERGE) are still ACCEPTED, then ignored: one
 * log line, never a crash. Returns that line, or null when the setup never named any of it.
 */
function ignoredDuplicatesNote(raw, env = {}) {
  const set = (v) => v != null && v !== "";
  const inCfg = raw && typeof raw === "object" && Object.keys(raw).length > 0;
  const inEnv = set(env.MEMGLOW_AUTO_DUPLICATES) || set(env.MEMGLOW_AUTO_DUPLICATES_MERGE);
  if (!inCfg && !inEnv) return null;
  return "memglow: ignored: maintenance.duplicates (AI confirmation and autoMerge removed in 0.6.0) — possible duplicates are now reported as structure rule D1, report-only";
}
module.exports.ignoredDuplicatesNote = ignoredDuplicatesNote;
