"use strict";
// SessionStart hook (hooks/memglow-session-core.js): calls memory_core and prints the hook JSON
// (hookSpecificOutput.additionalContext) — and, above everything else, FAILS OPEN on any problem
// reaching/using memory_core (server down, bad token, malformed answer, timeout): the short
// UNREACHABLE_MESSAGE is printed instead (0.5.10 — never the whole index, and never nothing),
// exit 0, never a broken session. parseBody/gitHint are tested directly; the rest is end-to-end,
// as a real subprocess.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { parseBody, gitHint, remainingFetchTimeoutMs, MIN_FETCH_TIMEOUT_MS, EXIT_MARGIN_MS, HARD_TIMEOUT_MS, UNREACHABLE_MESSAGE } = require("../hooks/memglow-session-core");
const { makeKb } = require("./fixtures/memory-kb");

const HOOK = path.join(__dirname, "..", "hooks", "memglow-session-core.js");

function run(env, stdin = "") {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

// ---------------------------------------------------------------------------------------------
// parseBody / gitHint (exported helpers)

test("parseBody: plain JSON", () => {
  assert.deepStrictEqual(parseBody('{"a":1}', "application/json"), { a: 1 });
});

test("parseBody: one SSE 'event: message' frame", () => {
  const sse = "event: message\ndata: {\"a\":2}\n\n";
  assert.deepStrictEqual(parseBody(sse, "text/event-stream"), { a: 2 });
});

test("parseBody: empty / malformed → null, never throws", () => {
  assert.strictEqual(parseBody("", "application/json"), null);
  assert.strictEqual(parseBody("not json", "application/json"), null);
  assert.strictEqual(parseBody("event: message\ndata: not json\n\n", "text/event-stream"), null);
});

test("remainingFetchTimeoutMs: accounts for time ALREADY spent (stdin+git), not a fixed '-300ms' guess (0.5.1.4)", () => {
  // The function is remainingFetchTimeoutMs(nowFn) = max(MIN, HARD_TIMEOUT_MS - (nowFn() - START_MS)
  // - EXIT_MARGIN_MS). Two calls `EXTRA` ms apart, both well clear of the floor, must differ by
  // exactly `EXTRA` — this holds regardless of the module's own (unexported, real) START_MS, so
  // the test needs no knowledge of it.
  const base = Date.now();
  const EXTRA = 1100; // worst case: 300ms stdin + 800ms git, already spent before the fetch
  const atBase = remainingFetchTimeoutMs(() => base);
  const afterSpending = remainingFetchTimeoutMs(() => base + EXTRA);
  assert.ok(atBase > MIN_FETCH_TIMEOUT_MS + EXTRA, "pick a base far enough from the floor for this assertion to be meaningful");
  assert.strictEqual(atBase - afterSpending, EXTRA, "every ms already spent on stdin/git comes straight off the fetch's own timeout");
  // The old code ignored stdin+git entirely (a fixed HARD_TIMEOUT_MS - 300): once EXTRA (1100ms)
  // alone exceeds that fixed margin, the new, accounting-aware value must be smaller.
  const oldFixedGuess = Math.max(500, HARD_TIMEOUT_MS - 300);
  assert.ok(afterSpending < oldFixedGuess, "the fix leaves materially less time for the fetch once stdin+git are accounted for");
});

test("remainingFetchTimeoutMs: never below MIN_FETCH_TIMEOUT_MS, however much time has already passed", () => {
  const base = Date.now();
  assert.strictEqual(remainingFetchTimeoutMs(() => base + HARD_TIMEOUT_MS * 10), MIN_FETCH_TIMEOUT_MS);
});

test("gitHint: a non-repo folder (or a missing git binary) returns \"\", never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-nogit-"));
  try { assert.strictEqual(gitHint(dir), ""); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// Fail-open (0.5.10): every one of these must print the short UNREACHABLE_MESSAGE as
// additionalContext — never nothing, and never anything resembling the full memory index (this
// hook has no code path that reads the index note directly, so that can never actually happen;
// the check is a regression guard, not a close call).

/** Every fail-open assertion shares this shape: exit 0, the hook JSON, exactly UNREACHABLE_MESSAGE
 * as additionalContext, and nothing index-shaped in it. */
function assertUnreachable(r) {
  assert.strictEqual(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.strictEqual(parsed.hookSpecificOutput.additionalContext, UNREACHABLE_MESSAGE);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /# Memory index|## Index|Expand:/, "never the whole index, even a hint of its own shape");
}

test("fail open (0.5.10): no server listening at all", async () => {
  const r = await run({ MEMGLOW_MEMORY_URL: "http://127.0.0.1:1", MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "1200" }, "{}");
  assertUnreachable(r);
});

test("fail open (0.5.10): malformed stdin JSON", async () => {
  const r = await run({ MEMGLOW_MEMORY_URL: "http://127.0.0.1:1", MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "1200" }, "not json at all");
  assertUnreachable(r);
});

test("fail open (0.5.10): no stdin at all", async () => {
  const r = await run({ MEMGLOW_MEMORY_URL: "http://127.0.0.1:1", MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "1200" });
  assertUnreachable(r);
});

test("fail open (0.5.10): the hard timeout always wins, even against a server that never answers", async () => {
  const srv = require("http").createServer(() => { /* never responds */ });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const t0 = Date.now();
    const r = await run({ MEMGLOW_MEMORY_URL: url, MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "1000" }, "{}");
    assertUnreachable(r);
    assert.ok(Date.now() - t0 < 4000, "the fetch's own AbortSignal, not the test runner's own patience, ended this");
  } finally { srv.close(); }
});

test("fail open (0.5.10): wrong bearer token (401) against a real memory server", async () => {
  const kb = makeKb();
  const memSrv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const httpSrv = createHttpServer({ rpc: memSrv.rpc, store: memSrv.store, token: "the-real-token-0123456789" });
  await new Promise((ok) => httpSrv.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${httpSrv.address().port}`;
    const r = await run({ MEMGLOW_MEMORY_URL: url, MEMGLOW_MEMORY_TOKEN: "wrong-token", MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "2000" }, "{}");
    assertUnreachable(r);
  } finally { httpSrv.closeAllConnections(); httpSrv.close(); memSrv.close(); kb.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// The success path, end to end: a real memory server, the real hook script, real stdin.

test("end to end: prints hookSpecificOutput.additionalContext from a real memory_core answer", async () => {
  const kb = makeKb();
  const memSrv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const httpSrv = createHttpServer({ rpc: memSrv.rpc, store: memSrv.store });
  await new Promise((ok) => httpSrv.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${httpSrv.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hook-cwd-"));
    const payload = JSON.stringify({ cwd: dir, hook_event_name: "SessionStart" });
    const r = await run({ MEMGLOW_MEMORY_URL: url, MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "2500" }, payload);
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Memory core"));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Expand:"));
  } finally { httpSrv.closeAllConnections(); httpSrv.close(); memSrv.close(); kb.cleanup(); }
});

test("end to end: a correct bearer token from MEMGLOW_MEMORY_TOKEN_FILE works", async () => {
  const kb = makeKb();
  const memSrv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const httpSrv = createHttpServer({ rpc: memSrv.rpc, store: memSrv.store, token: "file-token-0123456789abcdef" });
  await new Promise((ok) => httpSrv.listen(0, "127.0.0.1", ok));
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hook-token-"));
  const tokenFile = path.join(tokenDir, "token");
  fs.writeFileSync(tokenFile, "file-token-0123456789abcdef\n");
  try {
    const url = `http://127.0.0.1:${httpSrv.address().port}`;
    const r = await run({ MEMGLOW_MEMORY_URL: url, MEMGLOW_MEMORY_TOKEN_FILE: tokenFile, MEMGLOW_MEMORY_CORE_TIMEOUT_MS: "2500" }, "{}");
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.out);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Memory core"));
  } finally { httpSrv.closeAllConnections(); httpSrv.close(); memSrv.close(); kb.cleanup(); fs.rmSync(tokenDir, { recursive: true, force: true }); }
});
