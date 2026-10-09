"use strict";
/**
 * Negative cache + index hint (0.4.2.6 "negative cache + the index already answers", MCP proxy
 * lever `negativeCache`; the `indexHint` lever lives in lib/proxy-levers.js itself — it only
 * needs the note index, not this file).
 *
 * The owner's own usage log: 12 of 40 searches led to NO READ AT ALL — not a wrong note, not a
 * slow pick, nothing opened afterwards. The next time the same question comes up, the model
 * searches again and, if memory has not changed, gets exactly the same nothing. This module lets
 * the proxy remember, PRIVATELY and LOCALLY, which of its own past searches (identified by their
 * significant words — lib/learned-aliases.js `significantWords`, reused unchanged by the caller,
 * never re-derived here) were followed by no read at all in the same session, and say so on a
 * later, same-shaped search — WITHOUT ever hiding the server's own answer: the hint is one line
 * ADDED, the results are always relayed right after, untouched (correctness over cleverness, the
 * same rule as every other lever in lib/proxy-levers.js).
 *
 * "The memory has not changed since" is checked with a FINGERPRINT — the number of notes plus
 * the latest `mtime` among them (memoryFingerprint below) — cheap, derived straight from the note
 * index's own graph cache (no new read of any note), and deliberately GLOBAL: any write anywhere
 * bumps it, which is exactly "invalidate on any write". A cached "futile" entry whose fingerprint
 * no longer matches the live one is never surfaced again (lookupFutileEntry), and is dropped
 * outright the next time anything is recorded or looked up (forgetStaleEntries) — not because
 * that ONE query is known to be answered now, but because memglow can no longer vouch for
 * "nothing changed" for ANY of them. Same caution as a stale alias forgotten once its note
 * disappears (lib/learned-aliases.js forgetMissing), just coarser-grained on purpose: one global
 * number is enough to answer "has anything changed", and cheap enough to check on every search.
 *
 * On disk: one small, atomic, bounded, mode-600 file, `negative-cache.json`, next to
 * `learned-aliases.json` in memglow's data folder — `{ version: 1, entries: [{ words, last,
 * fingerprint }, ...] }`, at most `max` entries (default 1,000), oldest (by `last`) dropped
 * first. `words` is kept only so the entry can be found again (normalizedKey) and is never shown
 * to anyone; the hint text itself carries no query text at all, only a date.
 *
 * Split pure/impure, same house style as lib/learned-aliases.js:
 *   normalizedKey, memoryFingerprint, recordFutileEntries, lookupFutileEntry,
 *   forgetStaleEntries                                             — pure, no fs.
 *   createNegativeCacheStore                                       — the only fs code.
 */
const fs = require("fs");
const path = require("path");

const MAX_ENTRIES_DEFAULT = 1000;

/** The same (already significant) words, sorted and joined — order-independent, so two
 * phrasings that reduce to the same word set share one entry. Pure. */
function normalizedKey(words) {
  return Array.isArray(words) ? words.slice().sort().join(" ") : "";
}

/**
 * A cheap, global stand-in for "has anything in the memory changed": the number of notes, plus
 * the latest `mtime` among them (lib/memory.js `publicNode`'s own field — already read-only
 * metadata this module never re-reads from disk itself). Pure; `nodes` is whatever
 * `createNoteIndex`'s own graph cache holds (an array of `{ mtime, ... }`); a missing or
 * non-numeric `mtime` counts as 0.
 */
function memoryFingerprint(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let maxMtime = 0, sumMtime = 0, sumTokens = 0;
  for (const n of list) {
    const m = Number(n && n.mtime);
    if (Number.isFinite(m)) { if (m > maxMtime) maxMtime = m; sumMtime += m; }
    const t = Number(n && n.tokens);
    if (Number.isFinite(t)) sumTokens += t;
  }
  // The size sum matters as much as the dates: a write landing in the same millisecond as the
  // previous one (fast machines, CI) leaves every mtime unchanged but still changes the size.
  return list.length + ":" + sumTokens + ":" + Math.round(maxMtime) + ":" + Math.round(sumMtime);
}

function isValidEntry(e) {
  return !!e && typeof e === "object" && Array.isArray(e.words) && e.words.length
    && e.words.every((w) => typeof w === "string" && w)
    && typeof e.fingerprint === "string" && e.fingerprint
    && Number.isFinite(e.last);
}

/**
 * Records `words` as "futile" (no read followed it within the window) at `fingerprint` — a new
 * entry, or the existing one for the same normalized key overwritten with the new `fingerprint`
 * and `last` (a search that goes unread again later, even against a changed memory, is still
 * worth remembering as futile again, under the new fingerprint). Bounded to `max` entries,
 * oldest by `last` dropped first. Pure: returns the SAME array reference when there is nothing
 * to record (no words, or no fingerprint).
 */
function recordFutileEntries(entries, { words, fingerprint, now = Date.now(), max = MAX_ENTRIES_DEFAULT } = {}) {
  if (!Array.isArray(words) || !words.length || !fingerprint) return entries || [];
  const key = normalizedKey(words);
  const out = (entries || []).slice();
  const i = out.findIndex((e) => normalizedKey(e.words) === key);
  const entry = { words: words.slice().sort(), fingerprint, last: now };
  if (i >= 0) out[i] = entry; else out.push(entry);
  if (out.length > max) {
    out.sort((a, b) => a.last - b.last); // oldest first
    out.splice(0, out.length - max); // drop the oldest, keep the rest
  }
  return out;
}

/**
 * The entry matching `words`, ONLY when its stored `fingerprint` still equals the CURRENT
 * `fingerprint` — "the memory has not changed since" — else null, never surfaced (same caution
 * as a stale alias, see the module's top comment). Pure.
 */
function lookupFutileEntry(entries, words, fingerprint) {
  if (!Array.isArray(words) || !words.length || !fingerprint || !Array.isArray(entries) || !entries.length) return null;
  const key = normalizedKey(words);
  const e = entries.find((x) => normalizedKey(x.words) === key);
  return e && e.fingerprint === fingerprint ? e : null;
}

/**
 * Drops every entry whose `fingerprint` no longer matches the live one — "invalidate on any
 * write". The fingerprint is global, so one write drops ALL of them at once, on purpose: once
 * anything changed, memglow can no longer vouch for "nothing changed" for any of them, not just
 * the one note that was written. Pure; same array reference when nothing changed.
 */
function forgetStaleEntries(entries, fingerprint) {
  if (!Array.isArray(entries) || !entries.length || !fingerprint) return entries || [];
  const out = entries.filter((e) => e.fingerprint === fingerprint);
  return out.length === entries.length ? entries : out;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/**
 * The only fs-touching piece: `negative-cache.json` in `cfg.dataDir`, loaded once, written back
 * atomically (temp file + rename, mode 600) at most once every 2 seconds while there is
 * something new to save — same debounce shape as lib/learned-aliases.js `createAliasStore`.
 * Never throws — a write failure just means this hint is not persisted, the relay is never
 * affected.
 *
 * A single switch, `cfg.negativeCache`, gates both recording and using it (unlike the `aliases`
 * lever's two independent switches, lib/learned-aliases.js): this feature is only ever a
 * one-line, never-hides-anything nudge, so there is no "quietly keep learning while the hint is
 * paused" case worth a second knob for here.
 */
function createNegativeCacheStore(cfg = {}) {
  const dataDir = cfg.dataDir;
  const max = Number.isFinite(cfg.negativeCacheMax) && cfg.negativeCacheMax > 0 ? Math.floor(cfg.negativeCacheMax) : MAX_ENTRIES_DEFAULT;
  const enabled = !!(dataDir && cfg.negativeCache);
  const file = enabled ? path.join(dataDir, "negative-cache.json") : null;
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
    } catch { /* best effort: this hint is never allowed to break the relay */ }
  }
  function schedule() {
    dirty = true;
    if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
  }
  return {
    available: () => !!file,
    /** Records `words` as futile at `fingerprint` (a no-op when `cfg.negativeCache` is off, or
     * there is no data folder at all). */
    recordFutile(words, fingerprint, now = Date.now()) {
      if (!file) return;
      const before = entries;
      entries = recordFutileEntries(entries, { words, fingerprint, now, max });
      if (entries !== before) schedule();
    },
    /** The matching entry, only if `fingerprint` still matches what was recorded, else null (a
     * no-op → null when `cfg.negativeCache` is off, or there is no data folder at all). */
    lookup(words, fingerprint) {
      if (!file) return null;
      return lookupFutileEntry(entries, words, fingerprint);
    },
    /** Drops every entry whose fingerprint no longer matches `fingerprint` — cheap (<= `max`
     * entries), meant to be called opportunistically (on every search and every write) rather
     * than on a schedule of its own. */
    forgetStale(fingerprint) {
      if (!file) return;
      const before = entries;
      entries = forgetStaleEntries(entries, fingerprint);
      if (entries !== before) schedule();
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    size: () => entries.length,
    file,
  };
}

module.exports = {
  MAX_ENTRIES_DEFAULT,
  normalizedKey, memoryFingerprint, recordFutileEntries, lookupFutileEntry, forgetStaleEntries, createNegativeCacheStore,
};
