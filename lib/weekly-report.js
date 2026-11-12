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
 * worker's own `logEvent()` call sites). 0.5.9: lib/star-audit.js (the "structure" worker) now
 * logs its own AI judgement pass too — "ai-call" per fresh decision actually obtained, "ai-failed"
 * per candidate that never got a usable one, and one aggregated "cache-reused" event per AI pass
 * that had any cache hit at all — so `aiCalls`/`cachedVerdicts`/`errors` below finally cover all
 * four workers, not just auto-split/archive/duplicates (this module's own former "known
 * limitation": structure logged every applied fix — deterministic R1-R3 or AI-judged R4/R6 — as
 * the same "fix" kind, with nothing of its own for an AI call, a cache hit or a failure).
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
 * `{ autoSplitEvents, structureEvents, archiveEvents, duplicateCandidates }` — each worker's own
 * event array (and the current D1 candidate count) (any order; already time-filtered by the caller). Missing/malformed arrays are
 * treated as empty, never thrown on. Returns `{ notesSplit, structureFixes,
 * structureFixesByKind, sectionsArchived, duplicatesFound, aiCalls, cachedVerdicts, errors }`.
 */
function buildWeeklyReport({ autoSplitEvents = [], structureEvents = [], archiveEvents = [], duplicateCandidates = 0 } = {}) {
  const as = Array.isArray(autoSplitEvents) ? autoSplitEvents : [];
  const st = Array.isArray(structureEvents) ? structureEvents : [];
  const ar = Array.isArray(archiveEvents) ? archiveEvents : [];

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

  // 0.6.0: the AI duplicates worker is gone — this is the number of D1 "possible duplicate" pairs the
  // structure audit currently lists (report-only), not an event count.
  const duplicatesFound = Number.isFinite(duplicateCandidates) && duplicateCandidates > 0 ? Math.floor(duplicateCandidates) : 0;

  // AI calls actually made (fresh, not from the verdict cache): every terminal kind a worker
  // logs only after asking its AI provider something, minus the ones that double-log the same
  // call ("merge-skipped" always accompanies the "duplicate"/"merged" kind already counted).
  // 0.5.9: "ai-call"/"ai-failed" (lib/star-audit.js's own R5/R3/R4/R6 judgement passes) counted
  // the same way — a failed call is still a call that was made, same spirit as "auth-error" etc.
  // counting toward both aiCalls and errors below for the other three workers.
  const aiCalls =
    countBy(as, ["split", "split-failed", "split-aborted", "auth-error"]) +
    countBy(st, ["ai-call", "ai-failed"]) +
    countBy(ar, ["archived", "left", "ask-failed", "archive-aborted", "archive-failed", "auth-error"]);

  const cachedVerdicts = sumLeadingInt(st, "cache-reused", CACHED_RE) + sumLeadingInt(ar, "cache-reused", CACHED_RE);

  const errors =
    countBy(as, ["auth-error", "split-failed"]) +
    countBy(st, ["ai-failed"]) +
    countBy(ar, ["auth-error", "ask-failed", "archive-failed"]);

  return { notesSplit, structureFixes, structureFixesByKind, sectionsArchived, duplicatesFound, aiCalls, cachedVerdicts, errors };
}

module.exports = { buildWeeklyReport, weeklyReportSince, DAY_MS };
