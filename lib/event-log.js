"use strict";
/**
 * A small, bounded, time-ordered event log kept in memglow's own data folder (never in the notes
 * folder). Used by "Time to find a note" (lib/find-time.js) and "Memory engine speed"
 * (lib/engine-speed.js): both need the SEQUENCE of recent events, which the per-day counters of
 * lib/counters.js deliberately do not keep.
 *
 *   <dataDir>/<file> = { version: 1, events: [ ... ] }
 *
 * Events older than `keepMs` are dropped, at most `max` are kept (oldest first out). Each event goes
 * through `clean(evt)` on add AND on load (a hand-edited or corrupt file cannot inject anything):
 * it returns a sanitised copy, or null to skip. Writes are grouped (2 s after a burst) and atomic
 * (temporary file, then rename). Without a folder, or if it cannot be written, the log lives in
 * memory only and a single warning is printed. Never throws.
 */
const fs = require("fs");
const path = require("path");

const SAVE_DELAY_MS = 2000;

function createEventLog({ dir, file, keepMs, max, clean, now = Date.now, label = file }) {
  const full = dir && file ? path.join(dir, file) : null;
  let events = [];
  let timer = null;
  let warned = false;
  let version = 0;

  function warn(msg) {
    if (warned) return;
    warned = true;
    console.warn(`memglow: ${label}: ${msg}`);
  }
  function purge(t) {
    const oldest = t - keepMs;
    let i = 0;
    while (i < events.length && events[i].t < oldest) i++;
    if (i) events = events.slice(i);
    if (events.length > max) events = events.slice(events.length - max);
  }
  if (full) {
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      if (raw && Array.isArray(raw.events)) {
        events = raw.events.map((e) => { try { return clean(e); } catch { return null; } }).filter(Boolean).sort((a, b) => a.t - b.t);
        purge(now());
      }
    } catch (e) {
      if (e.code !== "ENOENT") warn(`cannot read ${full} (${e.message}); starting from zero`);
    }
  }
  function save() {
    timer = null;
    if (!full) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = full + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, events }), { mode: 0o600 });
      fs.renameSync(tmp, full);
    } catch (e) {
      warn(`cannot write in ${dir} (${e.message}); kept in memory only`);
    }
  }

  return {
    /** Adds one event (sanitised by `clean`); returns the stored copy or null. */
    add(evt) {
      let e = null;
      try { e = clean(evt); } catch { e = null; }
      if (!e) return null;
      // Usually appended in order; an out-of-order time is inserted at its place.
      if (!events.length || events[events.length - 1].t <= e.t) events.push(e);
      else { let i = events.length; while (i > 0 && events[i - 1].t > e.t) i--; events.splice(i, 0, e); }
      purge(Math.max(now(), e.t));
      version++;
      if (full && !timer) { timer = setTimeout(save, SAVE_DELAY_MS); if (timer.unref) timer.unref(); }
      return e;
    },
    /** Events with t ≥ since (all by default), oldest first. Do not mutate. */
    events(since = -Infinity) {
      if (since === -Infinity) return events;
      let i = 0;
      while (i < events.length && events[i].t < since) i++;
      return events.slice(i);
    },
    version: () => version,
    /** Writes pending changes now (tests, shutdown). */
    flush() { if (timer) { clearTimeout(timer); save(); } },
    file: full,
  };
}

module.exports = { createEventLog };
