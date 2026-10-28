"use strict";
/**
 * 0.5.5: a small, generic, content-hash-keyed verdict cache — shared by lib/auto-archive.js
 * ("left" verdicts: nothing clearly obsolete, or filtered to nothing by keepDays/minTokens),
 * lib/auto-duplicates.js (duplicate/not-duplicate verdicts) and lib/star-audit.js (R4 keep/remove
 * verdicts). Once the AI has answered for a key derived from the CONTENT of the note(s) involved
 * (sha1 of the raw text — any edit changes the key on its own, no bookkeeping needed), the SAME
 * scan tier never asks again until that content changes: a daily/periodic scan of an otherwise-
 * quiet KB costs no AI calls at all past the first pass.
 *
 * One small, atomic, bounded (`max`, default 5000 entries; oldest by `t` dropped first), mode-600
 * JSON file per caller (`file`), in memglow's own data folder. `dataDir`/`file` are optional:
 * without them, the cache still works for this ONE process's own lifetime (in-memory only), it
 * simply never persists to disk — never required, same "best effort" spirit as
 * lib/learned-aliases.js's own store.
 *
 * This cache answers "did the AI already decide, for this exact content?" — it is NOT a TTL: a
 * verdict that depended on "today" (lib/auto-archive.js's keepDays, say) is reconsidered only
 * when the note's own content changes, not when enough days pass on their own. That is the
 * explicit trade-off asked for (never re-ask an UNCHANGED note), not an oversight.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX = 5000;

function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** createVerdictCache({ dataDir, file, max, now }) → { key(...parts), get(key), set(key, v),
 * flush(), size() }. `key()` hashes its parts together (order-independent callers should sort
 * first themselves, e.g. two note hashes for a PAIR — see lib/auto-duplicates.js). */
function createVerdictCache({ dataDir, file, max = DEFAULT_MAX, now = Date.now } = {}) {
  const filePath = dataDir && file ? path.join(dataDir, file) : null;
  const entries = new Map(); // key -> { v, t }
  if (filePath) {
    const raw = readJson(filePath);
    if (raw && raw.entries && typeof raw.entries === "object") {
      for (const [k, e] of Object.entries(raw.entries)) {
        if (e && typeof e === "object" && "v" in e && Number.isFinite(e.t)) entries.set(k, e);
      }
    }
  }
  let dirty = false, timer = null;
  function save() {
    timer = null;
    if (!filePath || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const obj = { version: 1, entries: Object.fromEntries(entries) };
      const tmp = filePath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch { /* best effort: a cache miss is always safe, just re-asks */ }
  }
  function schedule() {
    dirty = true;
    if (filePath && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
  }
  return {
    sha1,
    key: (...parts) => sha1(parts.join("\0")),
    get(key) { const e = entries.get(key); return e ? e.v : undefined; },
    set(key, v) {
      entries.set(key, { v, t: now() });
      if (entries.size > max) {
        const sorted = [...entries.entries()].sort((a, b) => a[1].t - b[1].t);
        for (const [k] of sorted.slice(0, entries.size - max)) entries.delete(k);
      }
      schedule();
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    size: () => entries.size,
  };
}

module.exports = { createVerdictCache, sha1 };
