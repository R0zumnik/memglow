"use strict";
// memglow memory server (stage 0.4.5.1) — transports: Streamable HTTP (legacy sessions and the
// MCP 2026-07-28 per-request mode), SSE-only clients, batches, errors, concurrency; stdio; CLI.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { READ_ONLY_MESSAGE } = require("../memory-server/tools");
const { makeKb } = require("./fixtures/memory-kb");

const CLI = path.join(__dirname, "..", "memory-server", "memglow-memory-server.js");
const BIN = path.join(__dirname, "..", "bin", "memglow.js");
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (!(await fn()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 30)); return fn(); };

async function start(opts = {}) {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, watch: opts.watch || false, pollMs: opts.pollMs || 0, maxFileBytes: 200 * 1024 });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = (body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const callTool = async (name, args, headers = { "mcp-protocol-version": "2026-07-28" }) => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } }, headers);
    return (await r.json()).result;
  };
  return { kb, srv, server, url, post, callTool, done: () => { server.closeAllConnections(); server.close(); srv.close(); kb.cleanup(); } };
}

test("HTTP legacy session: initialize → Mcp-Session-Id, notifications/initialized → 202, tools/list and tools/call with the session", async () => {
  const s = await start();
  try {
    const r = await s.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/json/);
    const sid = r.headers.get("mcp-session-id");
    assert.match(sid, /^[0-9a-f]{32}$/);
    const init = await r.json();
    assert.strictEqual(init.result.protocolVersion, "2025-06-18");
    assert.strictEqual(init.result.serverInfo.name, "memglow-memory");
    assert.ok(init.result.capabilities.tools);
    assert.ok(!("resultType" in init.result), "legacy answers stay legacy-shaped");
    assert.match(init.result.instructions, /read-only/);
    const n = await s.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
    assert.strictEqual(n.status, 202);
    assert.strictEqual(await n.text(), "");
    const list = await (await s.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" })).json();
    assert.strictEqual(list.result.tools.length, 21);
    const call = await (await s.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden" } } }, { "mcp-session-id": sid })).json();
    assert.strictEqual(call.id, 3);
    assert.match(call.result.content[0].text, /^# Search Results: garden/);
    // 2025-11-25 is accepted too; an unknown version falls back to the latest legacy one.
    assert.strictEqual((await (await s.post({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25" } })).json()).result.protocolVersion, "2025-11-25");
    assert.strictEqual((await (await s.post({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json()).result.protocolVersion, "2025-11-25");
    // An unknown/expired session id is not rejected (a restarted server keeps serving its clients).
    const stale = await s.post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_note", arguments: { identifier: "bob" } } }, { "mcp-session-id": "deadbeef" });
    assert.strictEqual(stale.status, 200);
    assert.match((await stale.json()).result.content[0].text, /Bob plays rugby/);
    assert.strictEqual((await fetch(s.url, { method: "DELETE", headers: { "mcp-session-id": sid } })).status, 200);
  } finally { s.done(); }
});

test("HTTP MCP 2026-07-28 per-request mode: no initialize, version in header and _meta; lenient without _meta", async () => {
  const s = await start();
  try {
    const r = await s.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { identifier: "alice" }, _meta: META } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "read_note" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("mcp-session-id"), null, "no session in per-request mode");
    const j = await r.json();
    assert.strictEqual(j.result.resultType, "complete");
    assert.match(j.result.content[0].text, /^---\ntitle: Alice Martin/);
    // _meta alone (no header), and neither (lenient).
    const viaMeta = await (await s.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } })).json();
    assert.strictEqual(viaMeta.result.resultType, "complete");
    assert.strictEqual(viaMeta.result.tools.length, 21);
    const bare = await (await s.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_notes", arguments: { query: "alice" } } })).json();
    assert.match(bare.result.content[0].text, /### Alice Martin/);
    const disc = await (await s.post({ jsonrpc: "2.0", id: 4, method: "server/discover", params: { _meta: META } }, { "mcp-protocol-version": "2026-07-28" })).json();
    assert.ok(disc.result.supportedVersions.includes("2026-07-28"));
    const init = await s.post({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2026-07-28" } });
    assert.strictEqual(init.headers.get("mcp-session-id"), null);
    assert.strictEqual((await init.json()).result.protocolVersion, "2026-07-28");
  } finally { s.done(); }
});

test("HTTP: Accept text/event-stream only → one SSE event; batches; errors; GET 405; healthz", async () => {
  const s = await start();
  try {
    const sse = await s.post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden" } } }, { accept: "text/event-stream" });
    assert.match(sse.headers.get("content-type"), /^text\/event-stream/);
    const body = await sse.text();
    assert.match(body, /^event: message\ndata: \{.*\}\n\n$/s);
    assert.strictEqual(JSON.parse(body.split("\n")[1].slice(6)).id, 9);
    const batch = await (await s.post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])).json();
    assert.deepStrictEqual(batch.map((m) => m.id), [1, 2]);
    assert.strictEqual((await s.post([{ jsonrpc: "2.0", method: "notifications/initialized" }])).status, 202);
    const parse = await s.post("{not json");
    assert.strictEqual(parse.status, 400);
    assert.strictEqual((await parse.json()).error.code, -32700);
    assert.strictEqual((await (await s.post({ jsonrpc: "2.0", id: 1, method: "nope/nope" })).json()).error.code, -32601);
    assert.strictEqual((await (await s.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).json()).error.code, -32602);
    assert.strictEqual((await s.post({ jsonrpc: "2.0", id: 1, result: {} })).status, 202, "a client response needs no answer");
    const get = await fetch(s.url);
    assert.strictEqual(get.status, 405);
    assert.match(get.headers.get("allow"), /POST/);
    assert.strictEqual((await fetch(s.url.replace("/mcp", "/other"), { method: "POST", body: "{}" })).status, 404);
    const h = await (await fetch(s.url.replace("/mcp", "/healthz"))).json();
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.notes, 9);
    const w = await s.callTool("write_note", { title: "x", content: "y", directory: "z" });
    assert.strictEqual(w.isError, true);
    assert.strictEqual(w.content[0].text, READ_ONLY_MESSAGE);
  } finally { s.done(); }
});

test("concurrency: 20 parallel searches all complete, even while another client's upload is stalled mid-body", async () => {
  const s = await start();
  try {
    // A client that sends half a request and stalls: nothing may wait behind it.
    const port = s.server.address().port;
    const stalled = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", "content-length": "500" } });
    stalled.on("error", () => {});
    stalled.write('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"search_notes",');
    const queries = ["garden", "rugby", "alice", "réseau", "tomate", "stade", "bob", "friend", "tea", "box",
      "garden -rugby", '"vegetable garden"', "courg", "orleans", "club", "maison", "zebra", "windows", "readme", "memory"];
    const t0 = Date.now();
    const results = await Promise.all(queries.map((q, i) => s.post({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "search_notes", arguments: { query: q } } }).then((r) => r.json())));
    const wall = Date.now() - t0;
    assert.strictEqual(results.length, 20);
    results.forEach((r, i) => { assert.strictEqual(r.id, i); assert.ok(!r.result.isError); });
    assert.ok(results.every((r) => /^(# Search Results|No results found)/.test(r.result.content[0].text)));
    assert.ok(wall < 10000, `20 searches in ${wall} ms`);
    stalled.destroy();
  } finally { s.done(); }
});

test("HTTP: a file changed on disk is served fresh (watch)", async () => {
  const s = await start({ watch: true, pollMs: 200 });
  try {
    s.kb.write("memory/people/carol.md", "---\ntitle: Carol\n---\nCarol grows pumpkins.\n");
    const ok = await waitFor(async () => /### Carol/.test((await s.callTool("search_notes", { query: "pumpkins" })).content[0].text));
    assert.ok(ok, "new note searchable within the refresh window");
    fs.writeFileSync(path.join(s.kb.root, "memory/people/carol.md"), "---\ntitle: Carol\n---\nCarol grows melons now.\n");
    assert.ok(await waitFor(async () => /melons/.test((await s.callTool("read_note", { identifier: "Carol" })).content[0].text)));
  } finally { s.done(); }
});

function rpcOverStdio(args, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let buf = "";
    const want = messages.filter((m) => typeof m === "string" || m.id !== undefined).length; // a junk line gets a parse error
    const timer = setTimeout(() => { child.kill(); reject(new Error("stdio timeout; got " + JSON.stringify(out))); }, 20000);
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length >= want) { clearTimeout(timer); child.stdin.end(); child.kill(); resolve(out); }
      }
    });
    child.on("error", reject);
    for (const m of messages) child.stdin.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
  });
}

test("stdio transport (CLI --stdio, and `memglow memory-server`): initialize, notification, calls, parse error", async () => {
  const kb = makeKb();
  try {
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "bob" } } },
      "not json",
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "edit_note", arguments: { identifier: "bob", operation: "append", content: "x" } } },
    ];
    for (const args of [[CLI, "--stdio", "--root", kb.root, "--quiet", "--no-watch"], [BIN, "memory-server", "--root", kb.root, "--quiet"]]) {
      const out = await rpcOverStdio(args, msgs);
      assert.strictEqual(out[0].result.protocolVersion, "2025-06-18");
      assert.match(out[1].result.content[0].text, /Bob plays rugby/);
      assert.strictEqual(out[2].error.code, -32700);
      assert.strictEqual(out[3].result.content[0].text, READ_ONLY_MESSAGE);
    }
  } finally { kb.cleanup(); }
});

test("CLI --listen: serves /mcp; --help; bad option", async () => {
  const kb = makeKb();
  const child = spawn(process.execPath, [CLI, "--root", kb.root, "--listen", "127.0.0.1:0", "--read-only"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    assert.ok(await waitFor(() => /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.test(err), 15000), err);
    assert.match(err, /10 notes indexed/);
    const url = /listening on (http:\/\/\S+)/.exec(err)[1];
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_memory_projects", arguments: {} } }) });
    assert.match((await r.json()).result.content[0].text, /^Available projects:\n- main \(local\)/);
    const help = await new Promise((ok) => { const c = spawn(process.execPath, [CLI, "--help"]); let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("close", (code) => ok({ o, code })); });
    assert.strictEqual(help.code, 0);
    assert.match(help.o, /--listen HOST:PORT/);
    const bad = await new Promise((ok) => { const c = spawn(process.execPath, [CLI, "--bogus"]); c.on("close", (code) => ok(code)); });
    assert.strictEqual(bad, 2);
  } finally { child.kill(); kb.cleanup(); }
});
