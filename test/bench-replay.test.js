"use strict";
// bench/replay.js (stage 0.4.2.1b): the free replay harness. Pure pieces (the correctness guard,
// event loading/grouping) exercised with hand-built fixtures first; then the real thing end to
// end against demo/memory and bench/replay-demo.jsonl, so this also pins the demo table's shape.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadEvents, normalizeCalls, portalToCalls, namedConfigs, eachLeverConfigs, runConfig, summarize,
  isReachable, withPermalink, parseArgs, LEVER_NAMES, SHIPPED_DEFAULTS, GAP_MS,
} = require("../bench/replay.js");
const { ARG_FRESH, DEFAULTS: LIB_DEFAULTS } = require("../lib/proxy-levers");

test("SHIPPED_DEFAULTS (bench/replay.js) never silently drifts from lib/proxy-levers.js DEFAULTS", () => {
  for (const name of LEVER_NAMES) assert.strictEqual(SHIPPED_DEFAULTS[name], LIB_DEFAULTS[name], `lever "${name}"`);
});

const ROOT = path.join(__dirname, "..");
const HEAVY_EVENTS = path.join(__dirname, "..", "bench", "replay-heavy.jsonl");
const DEMO_MEMORY = path.join(ROOT, "demo", "memory");
const DEMO_EVENTS = path.join(__dirname, "..", "bench", "replay-demo.jsonl");

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeNotes(entries) {
  const dir = tmpDir("memglow-replay-notes-");
  for (const [rel, text] of Object.entries(entries)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}
const flagsAllOff = () => Object.fromEntries(LEVER_NAMES.map((n) => [n, false]));

// ---------------------------------------------------------------------------------------------
// Correctness guard (isReachable) — pure, hand-built cases.

test("isReachable: delivered in full → reachable, regardless of prior state", () => {
  const upstreamFull = "---\npermalink: a\n---\nbody text";
  const r = isReachable({ deliveredText: "prefix\n" + upstreamFull + "\nsuffix", upstreamFull, previousFullHash: null, baselineHash: null });
  assert.strictEqual(r.reachable, true);
  assert.strictEqual(r.deliveredFull, true);
});

test("isReachable: a stub matching the note's hash from an earlier FULL delivery this session → reachable", () => {
  const upstreamFull = "---\npermalink: a\n---\nbody text";
  const hash = require("../bench/replay.js").sha1(upstreamFull);
  const r = isReachable({ deliveredText: "memglow: unchanged since you read it earlier (stub, no escape hatch mentioned)", upstreamFull, previousFullHash: hash, baselineHash: null });
  assert.strictEqual(r.reachable, true);
  assert.strictEqual(r.deliveredFull, false);
});

test("isReachable: a stub matching the always-loaded baseline hash → reachable", () => {
  const upstreamFull = "---\npermalink: a\n---\nbody text";
  const hash = require("../bench/replay.js").sha1(upstreamFull);
  const r = isReachable({ deliveredText: "memglow: already in your context (no escape hatch mentioned here either)", upstreamFull, previousFullHash: null, baselineHash: hash });
  assert.strictEqual(r.reachable, true);
});

test("isReachable: a stub naming the escape hatch (memglow_fresh) → reachable even with no prior state", () => {
  const upstreamFull = "---\npermalink: a\n---\nbody text";
  const stub = `memglow: short summary. Call again with "${ARG_FRESH}": true for the full note.`;
  const r = isReachable({ deliveredText: stub, upstreamFull, previousFullHash: null, baselineHash: null });
  assert.strictEqual(r.reachable, true);
});

test("isReachable: an artificially broken lever — a stub with none of the three escapes → VIOLATION", () => {
  const upstreamFull = "---\npermalink: a\n---\nbody text that only exists upstream, never relayed";
  const brokenStub = "memglow: here is a short, unjustified summary instead of the note."; // no ARG_FRESH, no hash match
  const r = isReachable({ deliveredText: brokenStub, upstreamFull, previousFullHash: "deadbeef", baselineHash: "cafef00d" });
  assert.strictEqual(r.reachable, false);
  assert.strictEqual(r.deliveredFull, false);
});

// ---------------------------------------------------------------------------------------------
// Event loading: JSONL/array tool-call format, and the portal's own {evenements:[...]} format.

test("loadEvents: a JSONL file of tool calls, in file order, default session filled in", () => {
  const file = path.join(tmpDir("memglow-replay-ev-"), "events.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ session: "s1", tool: "read_note", args: { identifier: "a" }, t: 1 }),
    JSON.stringify({ tool: "search_notes", args: { query: "x" }, t: 2 }), // no session: defaults
  ].join("\n") + "\n");
  const events = loadEvents(file);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].session, "s1");
  assert.strictEqual(events[1].session, "default");
  assert.strictEqual(events[1].tool, "search_notes");
});

test("loadEvents: a plain JSON array works the same as JSONL", () => {
  const file = path.join(tmpDir("memglow-replay-ev-"), "events.json");
  fs.writeFileSync(file, JSON.stringify([{ session: "s1", tool: "read_note", args: { identifier: "a" } }]));
  const events = loadEvents(file);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].tool, "read_note");
});

test("portalToCalls: lecture → read_note, recherche → search_notes carrying ids, ecriture → edit_note", () => {
  const calls = portalToCalls([
    { type: "lecture", ids: ["note-a"], source: "nas", t: 1000 },
    { type: "recherche", ids: ["note-a", "note-b"], source: "nas", t: 2000 },
    { type: "ecriture", ids: ["note-a"], source: "nas", t: 3000 },
  ]);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[0], { session: "nas-1", tool: "read_note", args: { identifier: "note-a" }, t: 1000 });
  assert.strictEqual(calls[1].tool, "search_notes");
  assert.deepStrictEqual(calls[1].args.ids, ["note-a", "note-b"]);
  assert.strictEqual(calls[2].tool, "edit_note");
  assert.strictEqual(calls[1].session, "nas-1");
  assert.strictEqual(calls[2].session, "nas-1"); // same session: under 30 min, same source
});

test("portalToCalls: a new session starts on a source change, or on a silence over GAP_MS", () => {
  const calls = portalToCalls([
    { type: "lecture", ids: ["a"], source: "nas", t: 0 },
    { type: "lecture", ids: ["b"], source: "mac", t: 10 }, // source changed
    { type: "lecture", ids: ["c"], source: "mac", t: 10 + GAP_MS + 1 }, // long silence, same source
  ]);
  assert.strictEqual(calls[0].session, "nas-1");
  assert.strictEqual(calls[1].session, "mac-2");
  assert.strictEqual(calls[2].session, "mac-3");
});

// ---------------------------------------------------------------------------------------------
// End to end: runConfig against a small hand-built memory folder.

test("runConfig: off vs defaults vs +dedupe on a same-session re-read — dedupe only saves tokens when it fires, never a violation", () => {
  const body = "Some note body. ".repeat(20);
  const dir = writeNotes({ "a.md": `---\ntitle: a\ntheme: knowledge\n---\n${body}` });
  const events = normalizeCalls([
    { session: "s1", tool: "read_note", args: { identifier: "a" } },
    { session: "s1", tool: "read_note", args: { identifier: "a" } }, // same note, same session: dedupe can fire
  ]);
  const off = runConfig(flagsAllOff(), events, { memoryDir: dir, alwaysLoaded: [] });
  const withDedupe = runConfig({ ...flagsAllOff(), dedupe: true }, events, { memoryDir: dir, alwaysLoaded: [] });
  assert.strictEqual(off.violations, 0);
  assert.strictEqual(withDedupe.violations, 0);
  assert.ok(withDedupe.tokensTotal < off.tokensTotal, "dedupe must have shortened the second read");
});

test("runConfig: a changed-file case is never stubbed — the read right after an edit returns the full new text", () => {
  const dir = writeNotes({ "a.md": "---\ntitle: a\ntheme: knowledge\n---\nOriginal body.\n" });
  const events = normalizeCalls([
    { session: "s1", tool: "read_note", args: { identifier: "a" } },
    { session: "s1", tool: "edit_note", args: { identifier: "a", operation: "append", content: "Added line, now different.\n" } },
    { session: "s1", tool: "read_note", args: { identifier: "a" } },
  ]);
  // dedupe AND alreadyLoaded both on: if either wrongly stubbed the post-edit read, the guard would catch it.
  const flags = { ...flagsAllOff(), dedupe: true, alreadyLoaded: true };
  const res = runConfig(flags, events, { memoryDir: dir, alwaysLoaded: ["a"] });
  assert.strictEqual(res.violations, 0, JSON.stringify(res.violationDetails));
});

test("runConfig: an unresolved note (never on disk) is skipped by the guard, not a false violation", () => {
  const dir = writeNotes({ "a.md": "---\ntitle: a\n---\nbody\n" });
  const events = normalizeCalls([{ session: "s1", tool: "read_note", args: { identifier: "does-not-exist" } }]);
  const res = runConfig(flagsAllOff(), events, { memoryDir: dir, alwaysLoaded: [] });
  assert.strictEqual(res.violations, 0);
  assert.strictEqual(res.calls, 1);
});

// ---------------------------------------------------------------------------------------------
// The demo table itself: off vs defaults vs +alreadyLoaded over demo/memory + bench/replay-demo.jsonl.

test("demo replay: +alreadyLoaded gives a positive saving on the repeated index reads, with 0 violations everywhere", () => {
  const events = loadEvents(DEMO_EVENTS);
  assert.ok(events.length >= 10, "the demo events file should have a handful of calls across 3 sessions");
  const configs = namedConfigs([["alreadyLoaded"]]);
  const results = configs.map((c) => ({ key: c.key, label: c.label, ...runConfig(c.flags, events, { memoryDir: DEMO_MEMORY, alwaysLoaded: [] }) }));
  const rows = summarize(results);
  for (const r of rows) assert.strictEqual(r.violations, 0, `${r.key}: ${JSON.stringify(r.violationDetails)}`);

  const off = rows.find((r) => r.key === "off");
  const already = rows.find((r) => r.key === "+alreadyLoaded");
  assert.ok(already.tokensTotal < off.tokensTotal, "alreadyLoaded must cut tokens below the off baseline (repeated index reads stubbed)");
  assert.ok(already.savingsAbs > 0 && already.savingsPct > 0);
});

test("withPermalink: adds a permalink line right after the frontmatter fence, matching basic-memory's own convention", () => {
  const out = withPermalink("---\ntitle: x\n---\nbody\n", "folder/x");
  assert.strictEqual(out, "---\npermalink: folder/x\ntitle: x\n---\nbody\n");
});

// ---------------------------------------------------------------------------------------------
// Stage 0.4.2.2 "lean defaults": defaults must never cost more than off, on the demo replay.

test("demo replay: defaults never cost more tokens than off (0.4.2.2 target), 0 violations", () => {
  const events = loadEvents(DEMO_EVENTS);
  const configs = namedConfigs([]);
  const results = configs.map((c) => ({ key: c.key, label: c.label, ...runConfig(c.flags, events, { memoryDir: DEMO_MEMORY, alwaysLoaded: [] }) }));
  const rows = summarize(results);
  for (const r of rows) assert.strictEqual(r.violations, 0, `${r.key}: ${JSON.stringify(r.violationDetails)}`);
  const off = rows.find((r) => r.key === "off");
  const defaults = rows.find((r) => r.key === "defaults");
  assert.ok(defaults.tokensTotal <= off.tokensTotal, `defaults (${defaults.tokensTotal}) must be <= off (${off.tokensTotal})`);
});

test("heavy synthetic replay (60 calls, 4 sessions, realistic repeats): defaults never cost more tokens than off, 0 violations", () => {
  const events = loadEvents(HEAVY_EVENTS);
  assert.ok(events.length >= 50, "the heavy events file should be a lot bigger than the demo one");
  const configs = namedConfigs([]);
  const results = configs.map((c) => ({ key: c.key, label: c.label, ...runConfig(c.flags, events, { memoryDir: DEMO_MEMORY, alwaysLoaded: [] }) }));
  const rows = summarize(results);
  for (const r of rows) assert.strictEqual(r.violations, 0, `${r.key}: ${JSON.stringify(r.violationDetails)}`);
  const off = rows.find((r) => r.key === "off");
  const defaults = rows.find((r) => r.key === "defaults");
  assert.ok(defaults.tokensTotal <= off.tokensTotal, `defaults (${defaults.tokensTotal}) must be <= off (${off.tokensTotal})`);
});

// ---------------------------------------------------------------------------------------------
// --each: one configuration per lever, isolated against "off".

test("eachLeverConfigs: one row per lever, each with every OTHER lever off", () => {
  const configs = eachLeverConfigs();
  assert.deepStrictEqual(configs.map((c) => c.key), LEVER_NAMES.map((n) => "alone:" + n));
  for (const c of configs) {
    const onCount = Object.values(c.flags).filter(Boolean).length;
    assert.strictEqual(onCount, 1, `${c.key}: exactly one lever on`);
  }
});

test("demo replay: per-lever breakdown — searchDetails/suggestions only ADD tokens alone, dedupe/alreadyLoaded only SAVE, the rest are no-ops on this file", () => {
  const events = loadEvents(DEMO_EVENTS);
  const off = { key: "off", flags: flagsAllOff() };
  const results = [off, ...eachLeverConfigs()].map((c) => ({ key: c.key, label: c.label || c.key, ...runConfig(c.flags, events, { memoryDir: DEMO_MEMORY, alwaysLoaded: [] }) }));
  const rows = summarize(results); // baseline "off" present in `results`, so savingsAbs is a real number
  for (const r of rows) assert.strictEqual(r.violations, 0, `${r.key}: ${JSON.stringify(r.violationDetails)}`);
  const delta = (name) => -rows.find((r) => r.key === "alone:" + name).savingsAbs; // positive = adds
  assert.ok(delta("searchDetails") > 0, "searchDetails alone adds tokens on the demo file");
  assert.ok(delta("suggestions") > 0, "suggestions alone adds tokens on the demo file");
  assert.ok(delta("dedupe") < 0, "dedupe alone saves tokens on the demo file");
  assert.ok(delta("alreadyLoaded") < 0, "alreadyLoaded alone saves tokens on the demo file");
  for (const name of ["sizeWarning", "indexWarning", "toc", "archiveHint", "hideUnsupportedTools"]) {
    assert.ok(delta(name) === 0, `${name}: nothing on this file triggers it`); // "=== 0" to accept -0 too
  }
});

// ---------------------------------------------------------------------------------------------
// CLI: parseArgs — unknown flags are an error, "--memory" aliases "--memory-dir", "--each" parses.

test("parseArgs: --memory is an alias for --memory-dir (used to be silently ignored)", () => {
  const withAlias = parseArgs(["--memory", "/tmp/notes"]);
  const withReal = parseArgs(["--memory-dir", "/tmp/notes"]);
  assert.strictEqual(withAlias.memoryDir, withReal.memoryDir);
  assert.deepStrictEqual(withAlias.unknown, []);
});

test("parseArgs: an unrecognised flag is recorded as unknown, not silently dropped", () => {
  const o = parseArgs(["--bogus", "x"]);
  assert.deepStrictEqual(o.unknown, ["--bogus", "x"]);
});

test("parseArgs: --each parses to a boolean, off by default", () => {
  assert.strictEqual(parseArgs([]).each, false);
  assert.strictEqual(parseArgs(["--each"]).each, true);
});
