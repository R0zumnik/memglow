"use strict";
/**
 * WEEKLY MAINTENANCE REPORT (0.5.8): aggregates the last 7 days of the four maintenance workers'
 * own event logs (lib/event-log.js — auto-split-log.json, structure-log.json, auto-archive-log.
 * json, auto-duplicates-log.json; each worker's own `recentEvents(since)`) into a small set of
 * counts: notes split, structure fixes (by rule), sections archived, real duplicates found, AI
 * calls made, cached verdicts reused, errors. Surfaced in GET /api/maintenance's `weekly`
 * (memory-server/http.js), memory_core's one-line summary (memory-server/tools.js), and the
 * control panel's maintenance card (public/control.js).
 *
 * Pure: events in, counts out. The caller reads each worker's own `recentEvents(since)` (`since`
 * = `weeklyReportSince()`) and hands the four arrays here — this module never touches a clock,
 * a file or a worker itself, so it is trivially testable with synthetic event arrays.
 *
 * Every count below is read off the EXISTING event kinds each worker already logs (see each
 * worker's own `logEvent()` call sites) — no new instrumentation. Known limitation:
 * lib/star-audit.js (the "structure" worker) logs every applied fix — deterministic (R1-R3) or
 * AI-judged (R4/R6) — as the same "fix" kind, with no event of its own for an AI call, a cache
 * hit or a failure; `aiCalls`/`cachedVerdicts`/`errors` below can therefore only ever reflect
 * auto-split/archive/duplicates, never structure's own (occasional) AI judgement calls.
 */

const DAY_MS = 86400000;

/** 7 days before `now` (ms epoch) — the window every count below is meant to be pre-filtered to
 * (the caller passes this as `recentEvents(since)`; this module does not re-filter by time). */
function weeklyReportSince(now = Date.now()) {
  return now - 7 * DAY_MS;
}

/** The event's own leading "<rule> — ..." token (lib/star-audit.js's own `detail` format for a
 * "fix" event), or "other" when the detail does not start that way. */
function ruleOf(detail) {
  const s = String(detail || "");
  const i = s.indexOf(" — ");
  const head = (i < 0 ? s : s.slice(0, i)).trim();
  return head || "other";
}

function countBy(events, kinds) {
  const set = new Set(kinds);
  let n = 0;
  for (const e of events) if (e && set.has(e.kind)) n++;
  return n;
}

/** Sums the leading integer of every event of `kind` whose `detail` matches `re` (`re`'s first
 * capture group) — an event of that kind with no parseable number still counts as 1 (a single
 * occurrence), never silently dropped. */
function sumLeadingInt(events, kind, re) {
  let n = 0;
  for (const e of events) {
    if (!e || e.kind !== kind) continue;
    const m = re.exec(String(e.detail || ""));
    n += m ? Math.max(0, parseInt(m[1], 10) || 0) : 1;
  }
  return n;
}

const SECTIONS_RE = /^(\d+)\s+section/;
const CACHED_RE = /^(\d+)\s+cached/;

/**
 * `{ autoSplitEvents, structureEvents, archiveEvents, duplicatesEvents }` — each worker's own
 * event array (any order; already time-filtered by the caller). Missing/malformed arrays are
 * treated as empty, never thrown on. Returns `{ notesSplit, structureFixes,
 * structureFixesByKind, sectionsArchived, duplicatesFound, aiCalls, cachedVerdicts, errors }`.
 */
function buildWeeklyReport({ autoSplitEvents = [], structureEvents = [], archiveEvents = [], duplicatesEvents = [] } = {}) {
  const as = Array.isArray(autoSplitEvents) ? autoSplitEvents : [];
  const st = Array.isArray(structureEvents) ? structureEvents : [];
  const ar = Array.isArray(archiveEvents) ? archiveEvents : [];
  const du = Array.isArray(duplicatesEvents) ? duplicatesEvents : [];

  const notesSplit = countBy(as, ["split"]);

  const structureFixesByKind = {};
  let structureFixes = 0;
  for (const e of st) {
    if (!e || e.kind !== "fix") continue;
    structureFixes++;
    const r = ruleOf(e.detail);
    structureFixesByKind[r] = (structureFixesByKind[r] || 0) + 1;
  }

  const sectionsArchived = sumLeadingInt(ar, "archived", SECTIONS_RE);

  // "duplicate" (not merged) and "merged" (merged) are mutually exclusive per confirmed pair
  // (lib/auto-duplicates.js scanOnce()) and, together, are the ONLY two kinds logged for a
  // decision.duplicate === true verdict — a real duplicate found this week, cached or not.
  const duplicatesFound = countBy(du, ["duplicate", "merged"]);

  // AI calls actually made (fresh, not from the verdict cache): every terminal kind a worker
  // logs only after asking its AI provider something, minus the ones that double-log the same
  // call ("merge-skipped" always accompanies the "duplicate"/"merged" kind already counted).
  const aiCalls =
    countBy(as, ["split", "split-failed", "split-aborted", "auth-error"]) +
    countBy(ar, ["archived", "left", "ask-failed", "archive-aborted", "archive-failed", "auth-error"]) +
    countBy(du, ["duplicate", "not-duplicate", "merged", "ask-failed", "auth-error"]);

  const cachedVerdicts = sumLeadingInt(ar, "cache-reused", CACHED_RE) + sumLeadingInt(du, "cache-reused", CACHED_RE);

  const errors =
    countBy(as, ["auth-error", "split-failed"]) +
    countBy(ar, ["auth-error", "ask-failed", "archive-failed"]) +
    countBy(du, ["auth-error", "ask-failed", "merge-failed"]);

  return { notesSplit, structureFixes, structureFixesByKind, sectionsArchived, duplicatesFound, aiCalls, cachedVerdicts, errors };
}

module.exports = { buildWeeklyReport, weeklyReportSince, DAY_MS };
