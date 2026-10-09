"use strict";
// 0.4.10.0 — activity reports off the request path: the all-in-one server and the standalone
// proxy report in process (fetch, after the answer), never one child process per call, and the
// reports still reach memglow.
const cp = require("child_process");
let spawned = 0;
const realSpawn = cp.spawn;
cp.spawn = function (...a) { spawned++; return realSpawn.apply(this, a); };

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const core = require("../lib/agent-core");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { createWatcher } = require("../mcp-proxy/memglow-mcp-proxy");
const { makeKb } = require("./fixtures/memory-kb");

async function fakeViewer() {
  const got = [];
  const srv = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => { if (req.url === "/api/activity") got.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString()) }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, got, close: () => { srv.closeAllConnections(); srv.close(); } };
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "content-length": data.length, ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(parts).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((ok) => setTimeout(ok, 20)); }
  return true;
}

function setEnv(viewer) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-rep-home-"));
  Object.assign(process.env, { MEMGLOW_HOME: home, MEMGLOW_URL: viewer.url, MEMGLOW_TOKEN: "r".repeat(40), MEMGLOW_MACHINE: "testbox" });
  core.resetReportCache();
  return home;
}

test("all-in-one: every tool call is reported in process, after the answer — no child process", async () => {
  const viewer = await fakeViewer();
  const home = setEnv(viewer);
  const kb = makeKb();
  const env = { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data") };
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false, allInOne: { env, name: "memglow-memory" } });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    const s0 = spawned;
    const init = await post(url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } } });
    const H = { "mcp-session-id": init.headers["mcp-session-id"] };
    const calls = [
      { name: "search_notes", arguments: { query: "garden" } },
      { name: "read_note", arguments: { identifier: "alice" } },
      { name: "search_notes", arguments: { query: "tea", memglow_queries: ["rugby"] } },
      { name: "write_note", arguments: { title: "reported", directory: "memory", content: "hello" } },
    ];
    let id = 1;
    for (const c of calls) {
      const r = await post(url, { jsonrpc: "2.0", id: id++, method: "tools/call", params: c }, H);
      assert.match(r.text, /"result"/);
    }
    assert.ok(await until(() => viewer.got.length >= calls.length), `reports arrived (${viewer.got.length}/${calls.length})`);
    assert.strictEqual(spawned - s0, 0, "no child process spawned");
    const types = viewer.got.map((g) => g.body.type);
    assert.deepStrictEqual(types.sort(), ["read", "search", "search", "write"]);
    for (const g of viewer.got) {
      assert.strictEqual(g.auth, "Bearer " + "r".repeat(40));
      assert.strictEqual(g.body.channel, "memory-server");
      assert.strictEqual(g.body.machine, "testbox");
      assert.ok(typeof g.body.durationMs === "number");
    }
  } finally { server.closeAllConnections(); server.close(); srv.close(); viewer.close(); }
});

test("the proxy's watcher reports in process too, scheduled after the caller's own work", async () => {
  const viewer = await fakeViewer();
  setEnv(viewer);
  try {
    const s0 = spawned;
    const w = createWatcher({ server: "basic-memory" });
    w.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { identifier: "alice" } } });
    w.fromServer({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }] } });
    assert.strictEqual(viewer.got.length, 0, "nothing sent synchronously");
    assert.ok(await until(() => viewer.got.length === 1));
    assert.strictEqual(viewer.got[0].body.channel, "mcp-proxy");
    assert.deepStrictEqual(viewer.got[0].body.ids, ["alice"]);
    assert.strictEqual(spawned - s0, 0);
  } finally { viewer.close(); }
});

test("reportInProcess: settings and token are cached (re-read at most every 30 s); a viewer that is down is harmless", async () => {
  const viewer = await fakeViewer();
  setEnv(viewer);
  let urls = [];
  const fetchImpl = (u) => { urls.push(u); return Promise.resolve({}); };
  core.reportInProcess({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: { identifier: "a" } }, "mcp", { channel: "mcp-proxy", fetchImpl });
  await until(() => urls.length === 1);
  process.env.MEMGLOW_URL = "http://127.0.0.1:1"; // changed: not seen before the cache expires
  core.reportInProcess({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: { identifier: "b" } }, "mcp", { channel: "mcp-proxy", fetchImpl });
  await until(() => urls.length === 2);
  assert.strictEqual(urls[1], viewer.url + "/api/activity", "cached for 30 s");
  core.resetReportCache();
  // A viewer that refuses connections: the send fails silently, nothing throws.
  let failed = 0;
  core.reportInProcess({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: { identifier: "c" } }, "mcp", { channel: "mcp-proxy", onSent: (b, ok) => { if (!ok) failed++; } });
  assert.ok(await until(() => failed === 1, 5000), "failure reported to onSent, nothing thrown");
  viewer.close();
});
