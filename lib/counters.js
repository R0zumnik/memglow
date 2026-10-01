"use strict";
/**
 * Activity counters for Memory cost: per local day, per note, per type (read / search / write).
 *
 * Stored in memglow's own data folder (never in MEMORY_DIR, which memglow only reads):
 *   <dataDir>/activity-counts.json = { version: 1, since: "YYYY-MM-DD", started: "YYYY-MM-DD",
 *     days: { day: { notes: { id: { read, search, write } } } }, last: { id: { read, search, write: "YYYY-MM-DD" } } }
 * Note ids, days and numbers only — never note content. Days older than 90 days are dropped.
 * `since` = first day still covered by `days` (moves with the 90-day purge). `started` = the day
 * counting began, never purged, and `last` = the last day each note was read / found by a search /
 * written, never purged either (one short line per note): the archive tier (lib/archive.js) needs to
 * know that a note has not been read for MORE than 90 days. A file written before `started` existed
 * takes `since` as its start (the best known), and `last` is rebuilt from the days it still has.
 * Writes are grouped (one per burst, 2 s later) and atomic (temporary file, then rename).
 * If the folder cannot be written, counting goes on in memory and a single warning is printed.
 * Activities flagged `demo: true` are not counted (the caller skips them).
 */
const fs = require("fs");
const path = require("path");
const { dayOf, daysBefore } = require("./cost");

const FILE = "activity-counts.json";
const KEEP_DAYS = 90;
const SAVE_DELAY_MS = 2000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ["read", "search", "write"];
const MAX_NOTES_PER_DAY = 5000;
const MAX_LAST = 20000; // notes remembered in `last` (one short line each)

function createCounters({ dir, now = Date.now } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  let days = {};
  let since = null;
  let started = null;
  let last = {};
  let timer = null;
  let warned = false;
  let version = 0; // bumped on every counted activity (Memory cost cache key, server.js)
  let lastVersion = 0;

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        if (DAY_RE.test(String(raw.since || ""))) since = raw.since;
        for (const [day, v] of Object.entries(raw.days || {})) {
          if (!DAY_RE.test(day) || !v || typeof v.notes !== "object" || !v.notes) continue;
          const o = { notes: {} };
          for (const [id, c] of Object.entries(v.notes)) {
            if (!ID_RE.test(id) || !c || typeof c !== "object") continue;
            o.notes[id] = {};
            for (const k of TYPES) o.notes[id][k] = Number.isFinite(c[k]) && c[k] > 0 ? Math.floor(c[k]) : 0;
          }
          days[day] = o;
        }
        if (DAY_RE.test(String(raw.started || ""))) started = raw.started;
        if (raw.last && typeof raw.last === "object") {
          for (const [id, l] of Object.entries(raw.last)) {
            if (!ID_RE.test(id) || !l || typeof l !== "object") continue;
            const o = {};
            for (const k of TYPES) if (DAY_RE.test(String(l[k] || ""))) o[k] = l[k];
            if (Object.keys(o).length) last[id] = o;
          }
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") warn(`cannot read ${file} (${e.message}); starting from zero`);
    }
  }
  if (!since) since = Object.keys(days).sort()[0] || dayOf(now());
  if (!started || started > since) started = since;
  // `last` rebuilt from the kept days (older files had none; the most recent day wins).
  for (const [day, o] of Object.entries(days)) {
    for (const [id, c] of Object.entries(o.notes)) {
      for (const k of TYPES) {
        if (!(c[k] > 0)) continue;
        const l = last[id] || (last[id] = {});
        if (!l[k] || l[k] < day) l[k] = day;
      }
    }
  }

  function warn(msg) {
    if (warned) return;
    warned = true;
    console.warn("memglow: memory cost counters: " + msg);
  }
  function purge(t) {
    const oldest = daysBefore(t, KEEP_DAYS - 1);
    for (const day of Object.keys(days)) if (day < oldest) delete days[day];
    if (since < oldest) since = oldest;
  }
  function save() {
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, since, started, days, last }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      warn(`cannot write in ${dir} (${e.message}); counting in memory only`);
    }
  }
  function schedule() {
    if (timer || !file) return;
    timer = setTimeout(save, SAVE_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  return {
    /** Counts one accepted activity: { type, ids, t }. */
    add(evt) {
      if (!evt || !TYPES.includes(evt.type) || !Array.isArray(evt.ids)) return;
      const t = Number.isFinite(evt.t) ? evt.t : now();
      const day = dayOf(t);
      const o = days[day] || (days[day] = { notes: {} });
      for (const id of evt.ids) {
        if (!ID_RE.test(String(id))) continue;
        let c = o.notes[id];
        if (!c) {
          if (Object.keys(o.notes).length >= MAX_NOTES_PER_DAY) continue;
          c = o.notes[id] = { read: 0, search: 0, write: 0 };
        }
        c[evt.type]++;
        if (last[id] || Object.keys(last).length < MAX_LAST) {
          const l = last[id] || (last[id] = {});
          if (!l[evt.type] || l[evt.type] < day) { l[evt.type] = day; lastVersion++; }
        }
      }
      version++;
      purge(t);
      schedule();
    },
    days() { return days; },
    version() { return version; },
    since() { return since; },
    /** First day of counting (never purged). */
    started() { return started; },
    /** { id: { read?, search?, write?: "YYYY-MM-DD" } }: last day of each kind of activity, per note. */
    last() { return last; },
    /** Bumped only when a `last` day changes (at most once per note, type and day): a cache key. */
    lastVersion() { return lastVersion; },
    /** Writes pending changes now (tests, shutdown). */
    flush() { if (timer) { clearTimeout(timer); save(); } },
    file,
  };
}

/**
 * Write de-duplication. One write can be seen twice: reported by an assistant hook
 * (POST /api/activity) AND seen by the poller when the note body changes on disk. Some writes are
 * ONLY seen on disk (an assistant without a hook, an edit by hand): they must count too. Rule, per
 * note, within ±`windowMs` (15 s):
 *   - body change seen with no recent reported write → counted (source "file") and remembered;
 *   - write reported AFTER a counted body change → not counted again;
 *   - body change seen AFTER a reported (counted) write → not counted.
 * Pure (time is passed in), so testable. Demo activity never goes through here (never counted).
 */
function createWriteDedup(windowMs = 15000) {
  const reported = new Map(); // note → time of the last reported (and counted) write
  const onDisk = new Map();   // note → time of a write counted from a body change
  function purge(t) {
    for (const m of [reported, onDisk]) for (const [k, v] of m) if (Math.abs(t - v) > windowMs) m.delete(k);
  }
  return {
    /** A note body changed on disk. True if it must be counted (as a "file" write). */
    changed(id, t) {
      purge(t);
      if (reported.has(id)) { reported.delete(id); return false; }
      onDisk.set(id, t);
      return true;
    },
    /** A reported write on `ids`: returns the ids to count (those not already counted from disk). */
    reported(ids, t) {
      purge(t);
      const count = [];
      for (const id of ids || []) {
        if (onDisk.has(id)) { onDisk.delete(id); continue; }
        reported.set(id, t);
        count.push(id);
      }
      return count;
    },
    _state: () => ({ reported: [...reported.keys()], onDisk: [...onDisk.keys()] }),
  };
}

module.exports = { createCounters, createWriteDedup, FILE, KEEP_DAYS };
