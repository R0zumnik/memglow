"use strict";
/**
 * Learned aliases (0.4.2.3 "query log" + 0.4.2.4 "learned aliases", MCP proxy lever `aliases`).
 *
 * The owner's own real usage log: the note finally read was the proxy's 1st search result only
 * 7 times out of 28, and not among the results AT ALL 13 times out of 28 (found instead via the
 * index or a link) — so the very next similar search fails again, the same way. This module lets
 * the proxy learn, PRIVATELY and LOCALLY, which of the assistant's own words actually lead to
 * which note, from its own past searches in THIS proxy's sessions — and use that the next time a
 * similar search would otherwise come up empty-handed for that note.
 *
 * Nothing here is ever sent anywhere: this file has no network code at all, and no note body is
 * ever read or stored — only lowercased WORDS from the assistant's own query text, and note ids.
 * The query text itself is masked with the existing secret masking (lib/memory.js maskSecrets)
 * BEFORE any word is extracted, so a pasted token or password-looking line never becomes a
 * "word", and is additionally capped to a short length for whatever short-lived, in-memory log a
 * caller keeps of it (maskedQuery below) — this module itself never stores the raw query text.
 *
 * On disk: one small, atomic, bounded, mode-600 file, `learned-aliases.json` in memglow's data
 * folder — `{ version: 1, entries: [{ word, note, count, last }, ...] }`, at most `max` entries
 * (default 2,000; a (word, note) pair, not a search), oldest (by `last`) dropped first.
 *
 * Split pure/impure, same house style as lib/proxy-levers.js:
 *   significantWords, maskedQuery, learnEntries, matchAlias, forgetMissing  — pure, no fs.
 *   createAliasStore                                                       — the only fs code.
 */
const fs = require("fs");
const path = require("path");
const { maskSecrets } = require("./memory");

const MAX_ENTRIES_DEFAULT = 2000;
const WORD_RE = /[\p{L}\p{N}]+/gu;

// Small, deliberately short stop-word lists (English + French) — just enough to drop words that
// cannot possibly identify ONE note ("the", "and", "avec", "dans"...). Not a linguistic resource.
const STOP_WORDS = new Set([
  // English
  "the", "and", "for", "are", "was", "were", "this", "that", "with", "from", "have", "has",
  "had", "not", "but", "you", "your", "all", "any", "can", "how", "what", "when", "where",
  "which", "who", "why", "will", "would", "could", "should", "about", "into", "over", "under",
  "than", "then", "them", "they", "their", "there", "here", "out", "off", "its", "our", "ours",
  "yours", "been", "being", "does", "did", "doing", "get", "got", "just", "like", "make",
  "made", "more", "most", "some", "such", "only", "own", "same", "too", "very", "again", "once",
  "also", "each", "few", "other", "now", "new", "old",
  // French
  "les", "des", "une", "dans", "pour", "avec", "sans", "sur", "sous", "plus", "mais", "donc",
  "car", "ont", "est", "sont", "été", "etre", "être", "avoir", "que", "qui", "quoi", "dont",
  "cette", "ces", "ses", "son", "leur", "leurs", "nos", "notre", "votre", "vos", "tout", "tous",
  "toute", "toutes", "comme", "aussi", "alors", "depuis", "entre", "vers", "chez", "deja",
  "déjà", "fait", "faire", "comment", "pourquoi", "quand", "meme", "même", "peu", "tres", "très",
]);

/** Masks lines that look like a secret (lib/memory.js) BEFORE extraction, lowercases, keeps only
 * Unicode letters/digits runs of 3+ characters, drops stop-words, dedups (order preserved). */
function significantWords(text) {
  const masked = maskSecrets(String(text || ""));
  const seen = new Set();
  const out = [];
  for (const m of masked.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length < 3 || STOP_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Masked, whitespace-collapsed query text, capped to `max` characters — for whatever short-lived
 * in-memory per-session log a caller keeps (lib/proxy-levers.js `s.lastSearch`); never written to
 * disk by this module. */
function maskedQuery(text, max = 200) {
  const t = maskSecrets(String(text || "")).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t;
}

function isValidEntry(e) {
  return !!e && typeof e === "object" && typeof e.word === "string" && e.word
    && typeof e.note === "string" && e.note
    && Number.isFinite(e.count) && e.count > 0
    && Number.isFinite(e.last);
}

/**
 * Learns `words` as aliases of `note`: for each word, a matching (word, note) entry has its count
 * incremented and `last` refreshed, else a new entry (count 1) is appended. Bounded to `max`
 * entries overall (a (word, note) pair, not a search) — oldest by `last` dropped first. Pure:
 * returns a NEW array, or the SAME array reference when there was nothing to learn (no note, no
 * words), so a caller can cheaply tell "nothing changed" with `===`.
 */
function learnEntries(entries, { note, words, now = Date.now(), max = MAX_ENTRIES_DEFAULT } = {}) {
  if (!note || !Array.isArray(words) || !words.length) return entries || [];
  const out = (entries || []).slice();
  for (const w of words) {
    const i = out.findIndex((e) => e.word === w && e.note === note);
    if (i >= 0) out[i] = { ...out[i], count: out[i].count + 1, last: now };
    else out.push({ word: w, note, count: 1, last: now });
  }
  if (out.length > max) {
    out.sort((a, b) => a.last - b.last); // oldest first
    out.splice(0, out.length - max); // drop the oldest, keep the rest in (now oldest-first) order
  }
  return out;
}

/**
 * The single best-matching learned note for `words`, or null. A note QUALIFIES when the query's
 * words match at least 2 of its distinct learned aliases, OR exactly 1 alias that was itself
 * learned (seen) at least 2 times. Notes in `exclude` (already in this search's own results) or
 * that `noteExists` rejects (its note no longer exists — see forgetMissing) are never candidates.
 * Ties: more matched words first, then the highest single alias count, then the note id (so the
 * result is deterministic). Pure.
 */
function matchAlias(entries, { words, exclude, noteExists } = {}) {
  if (!Array.isArray(words) || !words.length || !Array.isArray(entries) || !entries.length) return null;
  const wordSet = new Set(words);
  const scores = new Map(); // note -> { matched: Set<word>, maxCount }
  for (const e of entries) {
    if (!wordSet.has(e.word)) continue;
    if (exclude && exclude.has(e.note)) continue;
    if (noteExists && !noteExists(e.note)) continue;
    let sc = scores.get(e.note);
    if (!sc) { sc = { matched: new Set(), maxCount: 0 }; scores.set(e.note, sc); }
    sc.matched.add(e.word);
    if (e.count > sc.maxCount) sc.maxCount = e.count;
  }
  const candidates = [];
  for (const [note, sc] of scores) {
    if (sc.matched.size >= 2 || sc.maxCount >= 2) candidates.push({ note, matched: sc.matched.size, maxCount: sc.maxCount });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.matched - a.matched || b.maxCount - a.maxCount || (a.note < b.note ? -1 : a.note > b.note ? 1 : 0));
  return candidates[0].note;
}

/** Drops entries for notes `existsFn` says no longer exist ("forget an alias whose note no longer
 * exists"). Pure; returns the SAME array reference when nothing changed. */
function forgetMissing(entries, existsFn) {
  if (typeof existsFn !== "function" || !Array.isArray(entries) || !entries.length) return entries || [];
  const out = entries.filter((e) => existsFn(e.note));
  return out.length === entries.length ? entries : out;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/**
 * The only fs-touching piece: `learned-aliases.json` in `cfg.dataDir`, loaded once, written back
 * atomically (temp file + rename, mode 600) at most once every 2 seconds while there is something
 * new to save (same debounce shape as createSavings in lib/proxy-levers.js). Never throws — a
 * write failure just means this session's learning is not persisted, the relay is never affected.
 *
 * `cfg.learnAliases` gates `learn()` (0.4.2.3: nothing is recorded when off); `cfg.aliases` gates
 * `match()` (0.4.2.4: nothing already learned is ever surfaced when off) — independent switches,
 * so learning can keep running quietly while injection is paused, or vice versa (using only what
 * was already learned before injection was turned on, while recording stays paused).
 */
function createAliasStore(cfg = {}) {
  const dataDir = cfg.dataDir;
  const max = Number.isFinite(cfg.aliasesMax) && cfg.aliasesMax > 0 ? Math.floor(cfg.aliasesMax) : MAX_ENTRIES_DEFAULT;
  const enabled = !!(dataDir && (cfg.learnAliases || cfg.aliases));
  const file = enabled ? path.join(dataDir, "learned-aliases.json") : null;
  let entries = [];
  if (file) {
    const raw = readJson(file);
    if (raw && Array.isArray(raw.entries)) entries = raw.entries.filter(isValidEntry);
  }
  let timer = null, dirty = false;
  function save() {
    timer = null;
    if (!file || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* best effort: learning is never allowed to break the relay */ }
  }
  function schedule() {
    dirty = true;
    if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
  }
  return {
    available: () => !!file,
    /** Learns `words` as aliases of `note` (a no-op when `cfg.learnAliases` is off, or there is
     * no data folder at all). */
    learn(note, words, now = Date.now()) {
      if (!cfg.learnAliases || !file) return;
      const before = entries;
      entries = learnEntries(entries, { note, words, now, max });
      if (entries !== before) schedule();
    },
    /** The best learned candidate for `words`, or null (a no-op → null when `cfg.aliases` is
     * off, or there is no data folder at all). */
    match(words, exclude, noteExists) {
      if (!cfg.aliases || !file) return null;
      return matchAlias(entries, { words, exclude, noteExists });
    },
    /** Drops entries for notes `existsFn` no longer finds — cheap (≤ `max` entries), meant to be
     * called opportunistically (e.g. once per search) rather than on a schedule of its own. */
    forgetMissing(existsFn) {
      const before = entries;
      entries = forgetMissing(entries, existsFn);
      if (entries !== before) schedule();
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    size: () => entries.length,
    file,
  };
}

module.exports = {
  MAX_ENTRIES_DEFAULT, STOP_WORDS,
  significantWords, maskedQuery, learnEntries, matchAlias, forgetMissing, createAliasStore,
};
