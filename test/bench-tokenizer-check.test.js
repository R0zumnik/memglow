"use strict";
// bench/tokenizer-check.js (stage 0.4.1 of the v0.5 engine roadmap): the pure pieces (loading,
// grouping, bucketing) with hand-built fixture records, never the real bench/results/*.jsonl (so
// this test is not tied to whatever happens to be recorded there). `noteSizes()` is exercised once,
// for real: it only spawns the free, deterministic bench/generate.js, no network, no model call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadRecords, actualInputTokens, summarize, byKind, byNoteSize, bucketOf, noteSizes, defaultFiles, findNote, SIZE_BUCKETS,
} = require("../bench/tokenizer-check.js");
const { estimateTokens } = require("../lib/cost");

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rec(over) {
  return {
    id: "q01", kind: "small", exit: 0, subtype: "success", toolResultChars: 400,
    tokens: { input: 10, output: 50, cacheCreate: 1000, cacheRead: 2000 },
    ...over,
  };
}

test("actualInputTokens: input + cacheCreate + cacheRead (session-total, see the file's caveat)", () => {
  assert.strictEqual(actualInputTokens(rec({ tokens: { input: 5, output: 1, cacheCreate: 100, cacheRead: 200 } })), 305);
  assert.strictEqual(actualInputTokens({ tokens: {} }), 0);
  assert.strictEqual(actualInputTokens({}), 0);
});

test("loadRecords: only exit-0/success runs with the two fields this script needs; bad JSON lines skipped, missing files skipped", () => {
  const dir = tmpDir("memglow-tokcheck-");
  fs.writeFileSync(path.join(dir, "a.jsonl"), [
    JSON.stringify(rec({ id: "q01" })),
    JSON.stringify(rec({ id: "q02", exit: 1, subtype: "error_during_execution" })), // not a success: dropped
    JSON.stringify({ exit: 0, subtype: "success" }), // no tokens/toolResultChars: dropped
    "not json",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "b.jsonl"), JSON.stringify(rec({ id: "q03" })) + "\n");
  const records = loadRecords([path.join(dir, "a.jsonl"), path.join(dir, "b.jsonl"), path.join(dir, "missing.jsonl")]);
  assert.deepStrictEqual(records.map((r) => r.id), ["q01", "q03"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("summarize: mean estimate/actual/ratio/gap over a bucket of records, estimate = estimateTokens(toolResultChars)", () => {
  const recs = [rec({ toolResultChars: 400, tokens: { input: 0, output: 0, cacheCreate: 1000, cacheRead: 0 } }), rec({ toolResultChars: 800, tokens: { input: 0, output: 0, cacheCreate: 2000, cacheRead: 0 } })];
  const s = summarize("x", recs);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.meanEstimate, (estimateTokens(400) + estimateTokens(800)) / 2);
  assert.strictEqual(s.meanActual, 1500);
  assert.ok(s.meanRatio > 0 && s.meanRatio < 1, "estimate is always a fraction of session-total actual");
});

test("summarize: a run with zero actual tokens is excluded from the ratio (never a division by zero) but still counted in n", () => {
  const s = summarize("x", [rec({ tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 } })]);
  assert.strictEqual(s.n, 1);
  assert.strictEqual(s.meanRatio, null);
});

test("byKind: one row per kind, sorted, each averaged independently", () => {
  const records = [rec({ id: "q01", kind: "small" }), rec({ id: "q08", kind: "large" }), rec({ id: "q02", kind: "small" })];
  const rows = byKind(records);
  assert.deepStrictEqual(rows.map((r) => r.label), ["large", "small"]);
  assert.strictEqual(rows.find((r) => r.label === "small").n, 2);
});

test("bucketOf: ascending size buckets, the last one catches everything above the second-to-last ceiling", () => {
  assert.strictEqual(bucketOf(0), SIZE_BUCKETS[0].label);
  assert.strictEqual(bucketOf(199), SIZE_BUCKETS[0].label);
  assert.strictEqual(bucketOf(200), SIZE_BUCKETS[0].label);
  assert.strictEqual(bucketOf(201), SIZE_BUCKETS[1].label);
  assert.strictEqual(bucketOf(1000000), SIZE_BUCKETS[SIZE_BUCKETS.length - 1].label);
});

test("byNoteSize: grouped by the holder note's size, questions with no known size (e.g. kind \"none\") excluded", () => {
  const records = [rec({ id: "q01" }), rec({ id: "q02" }), rec({ id: "q21" })]; // q21: no holder note (kind "none")
  const sizes = new Map([["q01", 50], ["q02", 6000]]);
  const rows = byNoteSize(records, sizes);
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes("< 200 tokens"));
  assert.ok(labels.includes("> 5,000 tokens"));
  assert.strictEqual(rows.reduce((sum, r) => sum + r.n, 0), 2, "the unsized question (q21) is excluded, not silently zeroed");
});

test("defaultFiles: lists bench/results/*.jsonl (real folder, real files already committed there)", () => {
  const files = defaultFiles();
  assert.ok(files.length > 0, "bench/results/ ships at least one *.jsonl");
  assert.ok(files.every((f) => f.endsWith(".jsonl")));
});

test("noteSizes: regenerates the deterministic test memory (no network, no model call) and sizes real holder notes", () => {
  const sizes = noteSizes();
  assert.ok(sizes.get("q01") > 0, "q01's holder note (project-kestrel) has a measured size");
  assert.ok(!sizes.has("q21"), "q21 is kind \"none\": no holder note to size");
});

test("findNote: basename match, recursive, null when absent", () => {
  const dir = tmpDir("memglow-tokcheck-findnote-");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "hello.md"), "hi");
  assert.strictEqual(findNote(dir, "hello"), path.join(dir, "sub", "hello.md"));
  assert.strictEqual(findNote(dir, "nope"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
