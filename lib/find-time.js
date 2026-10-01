"use strict";
/**
 * "Time to find a note" (Memory cost panel): how long, and in how many steps, an assistant goes
 * from a search to the note it then reads — computed from the activity memglow already receives
 * (POST /api/activity, from the MCP proxy or an assistant hook). No new input, no content: note ids,
 * an actor key and times only.
 *
 * Episode rule (pure, `episodes()`): for EACH search, look at the following events of the SAME
 * actor (source + machine + channel of the activity) within WINDOW_MS (2 minutes):
 *   - another search before any read counts as one more step (the search itself is step 1);
 *   - the first read ends the episode: found, delay = read time − search time;
 *   - no read in the window: a "missed" search (the assistant gave up, or answered from the search
 *     results alone — memglow cannot tell those apart, so the panel words it "no read after").
 * Beyond 2 minutes a read is no longer considered a consequence of the search (topic changed).
 * Note: each search opens its own episode, so a run "search, search, read" gives two episodes
 * (2 steps, then 1 step) — the same as the r0zumnik lab this was ported from.
 *
 * Stored in memglow's data folder: <dataDir>/find-time.json (lib/event-log.js), 8 days kept (the
 * panel shows 7), at most 20,000 events. Demo activity is never added (the caller skips it).
 */
const { createEventLog } = require("./event-log");

const WINDOW_MS = 2 * 60 * 1000;
const DAYS = 7;
const KEEP_MS = (DAYS + 1) * 86400000;
const MAX_EVENTS = 20000;
const FILE = "find-time.json";
const TYPES = new Set(["search", "read"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const ACTOR_RE = /^[A-Za-z0-9|_-]{1,80}$/;

/** Actor key of an accepted activity: who did it (same source on the same machine, same channel). */
function actorOf(evt) {
  const a = [evt && evt.source || "agent", evt && evt.machine || "", evt && evt.channel || ""].join("|");
  return ACTOR_RE.test(a) ? a : "agent||";
}

function clean(e) {
  if (!e || typeof e !== "object" || !TYPES.has(e.type) || !Number.isFinite(e.t) || !ACTOR_RE.test(String(e.a || ""))) return null;
  const ids = (Array.isArray(e.ids) ? e.ids : []).filter((x) => ID_RE.test(String(x))).slice(0, 5).map(String);
  if (e.type === "read" && !ids.length) return null; // a read with no known note says nothing
  return { type: e.type, ids, a: String(e.a), t: Math.round(e.t) };
}

/** Median of numbers (null if empty). Does not mutate. */
function median(list) {
  if (!list || !list.length) return null;
  const a = list.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * One episode per search: { t, actor, query: [ids found by the search], found, delayMs, steps, id }.
 * `delayMs`/`steps`/`id` are null when `found` is false. Events need not be sorted.
 */
function episodes(events, windowMs = WINDOW_MS) {
  const ev = (events || []).filter((e) => e && TYPES.has(e.type) && Number.isFinite(e.t)).slice().sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    const s = ev[i];
    if (s.type !== "search") continue;
    let steps = 1, hit = null;
    for (let j = i + 1; j < ev.length; j++) {
      const e = ev[j];
      if (e.t - s.t > windowMs) break;
      if (e.a !== s.a) continue;
      if (e.type === "search") { steps++; continue; }
      hit = e;
      break;
    }
    out.push({
      t: s.t, actor: s.a, query: (s.ids || []).slice(0, 5), found: !!hit,
      delayMs: hit ? hit.t - s.t : null, steps: hit ? steps : null, id: hit ? hit.ids[0] || null : null,
    });
  }
  return out;
}

/**
 * Summary for the panel: { searches, found, medianDelayMs, medianSteps, missedShare, top[] }.
 * top = the 5 slowest or missed searches (missed first, then slowest; ties: most recent first),
 * with TITLES only (`labelOf(id)` → label or null if the note is gone) — never note content.
 * Episodes whose 2-minute window is still open at `now` are left out (not yet known as missed).
 */
function summarize(events, now, labelOf = () => null, windowMs = WINDOW_MS) {
  const eps = episodes(events, windowMs).filter((e) => e.found || now - e.t > windowMs);
  const found = eps.filter((e) => e.found);
  const top = eps.slice().sort((a, b) => {
    const pa = a.found ? a.delayMs : Infinity, pb = b.found ? b.delayMs : Infinity;
    return pa !== pb ? pb - pa : b.t - a.t;
  }).slice(0, 5).map((e) => ({
    t: e.t, found: e.found, delayMs: e.delayMs, steps: e.steps,
    id: e.found ? e.id : null,
    label: e.found ? labelOf(e.id) || null : null,
    // A missed search: the titles of what it did find (up to 3), as a hint of the topic.
    context: e.found ? [] : e.query.map((id) => labelOf(id)).filter(Boolean).slice(0, 3),
  }));
  return {
    windowMs, days: DAYS, searches: eps.length, found: found.length,
    medianDelayMs: median(found.map((e) => e.delayMs)),
    medianSteps: median(found.map((e) => e.steps)),
    missedShare: eps.length ? (eps.length - found.length) / eps.length : null,
    top,
  };
}

/** The persistent store: add(acceptedActivity) and summary(now, labelOf). */
function createFindTime({ dir, now = Date.now } = {}) {
  const log = createEventLog({ dir, file: FILE, keepMs: KEEP_MS, max: MAX_EVENTS, clean, now, label: "time to find a note" });
  return {
    /** evt: an activity accepted by lib/memory.js: { type, ids, source, machine?, channel?, t }. */
    add(evt) {
      if (!evt || !TYPES.has(evt.type)) return null;
      return log.add({ type: evt.type, ids: evt.ids || [], a: actorOf(evt), t: Number.isFinite(evt.t) ? evt.t : now() });
    },
    summary(t = now(), labelOf) { return summarize(log.events(t - DAYS * 86400000), t, labelOf); },
    flush: () => log.flush(),
    version: log.version,
    file: log.file,
    _events: () => log.events(),
  };
}

module.exports = { createFindTime, episodes, summarize, median, actorOf, WINDOW_MS, FILE };
