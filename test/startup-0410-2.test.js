"use strict";
// 0.4.10.2 — startup: the port opens before the notes folder is loaded and indexed; a request
// meanwhile waits for it (never fails, never sees a half-loaded folder); the load and the
// warm-up run in setImmediate chunks.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createStore } = require("../lib/store/store");
const { makeKb: makeSynthetic } = require("../bench/responsiveness");

function corpus(n) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-start-")); makeSynthetic(root, n); return root; }

test("deferStart: createMemoryServer returns at once; requests before ready wait and get the full answer", async () => {
  const root = corpus(300);
  const t0 = Date.now();
  const srv = createMemoryServer({ root, watch: false, pollMs: 0, deferStart: true });
  const createMs = Date.now() - t0;
  try {
    assert.strictEqual(srv.isReady(), false, "not loaded yet");
    assert.strictEqual(srv.store.stats().loaded, false);
    // A search sent right away: answered once loaded, with every note there.
    const pending = srv.rpc.handleAny({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "rugby", page_size: 1000, output_format: "json" } } }, {});
    assert.ok(pending && typeof pending.then === "function", "waits for the ready promise");
    // The event loop is not blocked meanwhile.
    let ticks = 0;
    const iv = setInterval(() => ticks++, 1);
    const r = await pending;
    clearInterval(iv);
    assert.ok(srv.isReady());
    const j = JSON.parse(r.result.content[0].text);
    const full = createMemoryServer({ root, watch: false, pollMs: 0 });
    const ref = JSON.parse(full.tools.call("search_notes", { query: "rugby", page_size: 1000, output_format: "json" }).content[0].text);
    full.close();
    assert.ok(j.results.length > 10, "found many");
    assert.deepStrictEqual(j.results.map((x) => x.permalink), ref.results.map((x) => x.permalink), "same answer as a fully loaded server");
    assert.ok(ticks > 3, `the event loop kept turning during the load (${ticks} ticks)`);
    assert.ok(createMs < 200, `returned in ${createMs} ms`);
  } finally { srv.close(); }
});

test("startAsync: a read before the chunked load ends gets the plain synchronous scan", async () => {
  const root = corpus(120);
  const store = createStore({ root, watch: false, pollMs: 0 });
  const p = store.startAsync();
  assert.strictEqual(store.loaded(), false);
  const n = store.notes().length; // plain scan, right now
  assert.ok(n >= 120, `${n} notes`);
  await p;
  assert.strictEqual(store.notes().length, n, "the async load gave way, nothing lost or doubled");
  store.stop();
});

test("the CLI listens before the warm-up ends: /healthz answers while the folder is still loading", { timeout: 60000 }, async () => {
  const root = corpus(600);
  const p = spawn(process.execPath, [path.join(__dirname, "..", "memory-server", "memglow-memory-server.js"), "--root", root, "--listen", "127.0.0.1:0", "--no-watch", "--poll-ms", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  try {
    const port = await new Promise((ok, ko) => { p.stderr.on("data", (c) => { err += c; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(err); if (m) ok(Number(m[1])); }); p.on("exit", () => ko(new Error(err))); });
    const listenedBeforeIndexed = !/notes indexed/.test(err);
    const get = () => new Promise((ok, ko) => http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => { const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => ok(JSON.parse(Buffer.concat(b)))); }).on("error", ko));
    const h = await get();
    assert.strictEqual(h.ok, true);
    // A search: never fails, whatever the timing.
    const r = await new Promise((ok, ko) => {
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "rugby" } } });
      const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(data) } }, (res) => { const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => ok(Buffer.concat(b).toString())); });
      req.on("error", ko); req.end(data);
    });
    assert.match(r, /### /);
    assert.ok(listenedBeforeIndexed, "the listening line came before the indexed line:\n" + err);
  } finally { p.kill(); }
});
