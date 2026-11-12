"use strict";
// lib/weekly-report.js (0.5.8): WEEKLY MAINTENANCE REPORT — aggregates the four maintenance
// workers' own event logs into a small set of counts. Pure (events in, counts out), so every
// test here hands it synthetic event arrays directly — never a real worker or a clock.
const test = require("node:test");
const assert = require("node:assert");
const { buildWeeklyReport, weeklyReportSince, DAY_MS } = require("../lib/weekly-report");

test("buildWeeklyReport: empty/missing arrays — every count 0, never throws", () => {
  assert.deepStrictEqual(buildWeeklyReport({}), {
    notesSplit: 0, structureFixes: 0, structureFixesByKind: {}, sectionsArchived: 0, duplicatesFound: 0, aiCalls: 0, cachedVerdicts: 0, errors: 0,
  });
  assert.deepStrictEqual(buildWeeklyReport(), buildWeeklyReport({}));
  // Malformed input (not arrays): treated as empty, never thrown.
  assert.deepStrictEqual(buildWeeklyReport({ autoSplitEvents: "nope", structureEvents: null, archiveEvents: 42, duplicatesEvents: undefined }), buildWeeklyReport({}));
});

test("buildWeeklyReport: notesSplit — counts auto-split 'split' events only", () => {
  const autoSplitEvents = [
    { t: 1, kind: "split", note: "a", detail: "2 part(s): a-1, a-2" },
    { t: 2, kind: "split", note: "b", detail: "3 part(s): b-1, b-2, b-3" },
    { t: 3, kind: "split-aborted", note: "c", detail: "changed mid-decision" },
    { t: 4, kind: "auth-error", note: null, detail: "bad key" },
  ];
  const wk = buildWeeklyReport({ autoSplitEvents });
  assert.strictEqual(wk.notesSplit, 2);
  assert.strictEqual(wk.aiCalls, 4, "every one of the four kinds here followed an actual AI call attempt");
  assert.strictEqual(wk.errors, 1, "split-failed/auth-error would count; here only auth-error does (split-aborted is not an error)");
});

test("buildWeeklyReport: structureFixes/structureFixesByKind — groups 'fix' events by their leading rule token", () => {
  const structureEvents = [
    { t: 1, kind: "fix", note: "a", detail: "R2 — moved under hub-x on projects/a.md" },
    { t: 2, kind: "fix", note: "b", detail: "R2 — moved under hub-x on projects/b.md" },
    { t: 3, kind: "fix", note: "c", detail: "R4 — heading demoted on projects/c.md" },
    { t: 4, kind: "fix", note: "d", detail: "no-dash-here" }, // malformed detail: bucketed as "other"
  ];
  const wk = buildWeeklyReport({ structureEvents });
  assert.strictEqual(wk.structureFixes, 4);
  assert.deepStrictEqual(wk.structureFixesByKind, { R2: 2, R4: 1, "no-dash-here": 1 });
  // This fixture has only "fix" events (no "ai-call"/"ai-failed"/"cache-reused" of its own) —
  // see the next test for structure's own AI-judgement counting (0.5.9).
  assert.strictEqual(wk.aiCalls, 0);
  assert.strictEqual(wk.errors, 0);
});

test("buildWeeklyReport: structure's own AI judgement pass (0.5.9) — 'ai-call'/'ai-failed' count toward aiCalls (a failure is still a call made), 'ai-failed' alone toward errors, 'cache-reused' toward cachedVerdicts", () => {
  const structureEvents = [
    { t: 1, kind: "ai-call", note: "a", detail: "attach" },
    { t: 2, kind: "ai-call", note: "b", detail: "R4: remove" },
    { t: 3, kind: "ai-failed", note: "c", detail: "the AI provider failed" },
    { t: 4, kind: "ai-failed", note: null, detail: "R6 auth error: bad key" },
    { t: 5, kind: "cache-reused", note: null, detail: "5 cached verdicts reused" },
    { t: 6, kind: "fix", note: "a", detail: "AI — attach on projects/a.md" },
  ];
  const wk = buildWeeklyReport({ structureEvents });
  assert.strictEqual(wk.aiCalls, 4, "2 ai-call + 2 ai-failed: every one followed an actual AI call");
  assert.strictEqual(wk.errors, 2, "only the 2 ai-failed count as errors");
  assert.strictEqual(wk.cachedVerdicts, 5);
  assert.strictEqual(wk.structureFixes, 1, "the 'fix' event is unaffected, counted as always");
});

test("buildWeeklyReport: sectionsArchived — sums the leading section count of 'archived' events; cachedVerdicts/errors from archive's own kinds", () => {
  const archiveEvents = [
    { t: 1, kind: "archived", note: "old-incident", detail: "2 section(s) → old-incident-archive: stale" },
    { t: 2, kind: "archived", note: "another", detail: "1 section(s) → another-archive: stale" },
    { t: 3, kind: "left", note: "fresh-note", detail: "nothing clearly obsolete" },
    { t: 4, kind: "ask-failed", note: "x", detail: "timeout" },
    { t: 5, kind: "cache-reused", note: null, detail: "7 cached verdicts reused" },
  ];
  const wk = buildWeeklyReport({ archiveEvents });
  assert.strictEqual(wk.sectionsArchived, 3, "2 + 1 sections, not 2 events");
  assert.strictEqual(wk.aiCalls, 4, "archived x2 + left + ask-failed: every one followed a fresh AI call");
  assert.strictEqual(wk.cachedVerdicts, 7);
  assert.strictEqual(wk.errors, 1, "only ask-failed is an error here");
});

test("buildWeeklyReport (0.6.0): duplicatesFound is the number of D1 possible-duplicate candidates, never an AI event count", () => {
  assert.strictEqual(buildWeeklyReport({ duplicateCandidates: 3 }).duplicatesFound, 3);
  assert.strictEqual(buildWeeklyReport({ duplicateCandidates: -1 }).duplicatesFound, 0);
  assert.strictEqual(buildWeeklyReport({ duplicateCandidates: "x" }).duplicatesFound, 0);
  // an old caller still passing duplicatesEvents is simply ignored: no AI calls, no errors counted from it
  const wk = buildWeeklyReport({ duplicatesEvents: [{ t: 1, kind: "duplicate" }, { t: 2, kind: "auth-error" }] });
  assert.deepStrictEqual([wk.duplicatesFound, wk.aiCalls, wk.errors], [0, 0, 0]);
});

test("buildWeeklyReport: a full week across all four workers combines additively", () => {
  const wk = buildWeeklyReport({
    autoSplitEvents: [{ t: 1, kind: "split", note: "a", detail: "2 part(s): a-1, a-2" }],
    structureEvents: [
      { t: 1, kind: "fix", note: "a", detail: "R2 — moved on a.md" },
      { t: 2, kind: "fix", note: "b", detail: "R2 — moved on b.md" },
      { t: 3, kind: "fix", note: "c", detail: "R2 — moved on c.md" },
    ],
    archiveEvents: [],
    duplicatesEvents: [],
  });
  assert.deepStrictEqual(wk, {
    notesSplit: 1, structureFixes: 3, structureFixesByKind: { R2: 3 }, sectionsArchived: 0, duplicatesFound: 0, aiCalls: 1, cachedVerdicts: 0, errors: 0,
  });
});

test("weeklyReportSince: exactly 7 days (DAY_MS * 7) before `now`", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.strictEqual(weeklyReportSince(now), now - 7 * DAY_MS);
  assert.strictEqual(weeklyReportSince(now), now - 604800000);
});
