"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createWatcher, createHttpProxy, lineTap, sseTap, parseArgs } = require("../mcp-proxy/memglow-mcp-proxy");

const PROXY = path.join(__dirname, "..", "mcp-proxy", "memglow-mcp-proxy.js");
const FAKE = path.join(__dirname, "fixtures", "fake-mcp-server.js");
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

function receiver() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { got.push(JSON.parse(b)); res.end("{}"); });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("parseArgs", () => {
  assert.deepStrictEqual(parseArgs(["--name", "bm", "--", "uvx", "basic-memory", "mcp"]).cmd, ["uvx", "basic-memory", "mcp"]);
  assert.strictEqual(parseArgs(["--upstream", "http://x/mcp", "--listen", "127.0.0.1:1"]).upstream, "http://x/mcp");
});

test("watcher: matches responses to calls, skips errors, honours MEMGLOW_PROXY_MAP", () => {
  const seen = [];
  const w = createWatcher({ server: "any", onReport: (e) => seen.push(e) });
  w.fromClient([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { identifier: "alice" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_note", arguments: {} } }]);
  w.fromServer({ jsonrpc: "2.0", id: 2, error: { code: 1 } });
  w.fromServer({ jsonrpc: "2.0", id: 99, result: {} });
  w.fromServer({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual([seen[0].tool, seen[0].trusted, seen[0].args.identifier], ["read_note", true, "alice"]);

  process.env.MEMGLOW_PROXY_MAP = JSON.stringify({ lookup: "read", noisy: "ignore" });
  try {
    const s2 = [];
    const w2 = createWatcher({ server: "x", onReport: (e) => s2.push(e) });
    w2.fromClient({ id: "a", method: "tools/call", params: { name: "lookup", arguments: {} } });
    w2.fromClient({ id: "b", method: "tools/call", params: { name: "noisy", arguments: {} } });
    w2.fromServer({ id: "a", result: {} }); w2.fromServer({ id: "b", result: {} });
    assert.deepStrictEqual(s2.map((e) => e.tool), ["read"]);
  } finally { delete process.env.MEMGLOW_PROXY_MAP; }
});

test("taps: split lines and SSE events across chunk boundaries", () => {
  const a = []; const t = lineTap((m) => a.push(m));
  t(Buffer.from('{"x":1}\n{"x"')); t(Buffer.from(':2}\nnot json\n'));
  assert.deepStrictEqual(a, [{ x: 1 }, { x: 2 }]);
  const b = []; const s = sseTap((m) => b.push(m));
  s("event: message\ndata: {\"y\""); s(":1}\n\ndata: {\"y\":2}\r\n\r\n");
  assert.deepStrictEqual(b, [{ y: 1 }, { y: 2 }]);
});

test("stdio proxy: bytes relayed unchanged, ids reported (no content), exit code propagated", async () => {
  const { srv, got, url } = await receiver();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-px-"));
  try {
    const p = spawn(process.execPath, [PROXY, "--name", "basic-memory", "--source", "test", "--", process.execPath, FAKE],
      { env: { ...process.env, MEMGLOW_URL: url, MEMGLOW_TOKEN: "p".repeat(40), MEMGLOW_HOME: home, MEMGLOW_FAKE_MCP: "1" } });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    const exited = new Promise((ok) => p.on("exit", ok));
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "people/bob" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "boom", arguments: {} } },
    ];
    // split one message across two writes: the relay must not care
    const wire = msgs.map((m) => JSON.stringify(m) + "\n").join("");
    p.stdin.write(wire.slice(0, 50)); p.stdin.write(wire.slice(50));
    await waitFor(() => out.split("\n").filter(Boolean).length >= 3);
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines[0], { jsonrpc: "2.0", id: 1, result: { ok: true, ünïcode: "✓" } });
    assert.match(lines[1].result.content[0].text, /secret body text/, "content reaches the client untouched");
    assert.strictEqual(lines[2].error.message, "nope");
    await waitFor(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(got.length, 1, "the failed call is not reported");
    assert.strictEqual(got[0].type, "read");
    assert.strictEqual(got[0].source, "test");
    assert.deepStrictEqual(got[0].ids.sort(), ["alice", "bob"]);
    assert.ok(!JSON.stringify(got).includes("secret"));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "quit" }) + "\n");
    assert.strictEqual(await exited, 7);
  } finally { srv.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("stdio proxy: memglow unreachable does not disturb the relay", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-px-"));
  try {
    const p = spawn(process.execPath, [PROXY, "--", process.execPath, FAKE],
      { env: { ...process.env, MEMGLOW_URL: "http://127.0.0.1:9", MEMGLOW_TOKEN: "p".repeat(40), MEMGLOW_HOME: home, MEMGLOW_FAKE_MCP: "1" } });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_note", arguments: { identifier: "a" } } }) + "\n");
    await waitFor(() => out.includes("\n"));
    assert.strictEqual(JSON.parse(out).id, 5);
    p.stdin.end();
    assert.strictEqual(await new Promise((ok) => p.on("exit", ok)), 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("HTTP proxy: JSON and SSE responses relayed, headers and query forwarded, 502 when upstream is down", async () => {
  const seenUp = [];
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      seenUp.push({ url: req.url, sid: req.headers["mcp-session-id"] });
      const result = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "memory://notes/carol" }] } };
      if (m.id === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
        res.write("event: message\ndata: " + JSON.stringify(result).slice(0, 20));
        setTimeout(() => res.end(JSON.stringify(result).slice(20) + "\n\n"), 20);
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(JSON.stringify(result));
      }
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const reports = [];
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "notes", source: "t", onReport: (e) => reports.push(e) });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const call = (id, name) => fetch(base + "/mcp?x=1", { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s1" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { identifier: "dave" } } }) });
  try {
    const r1 = await call(1, "read_note");
    assert.strictEqual(r1.headers.get("mcp-session-id"), "s1");
    assert.strictEqual((await r1.json()).result.content[0].text, "memory://notes/carol");
    const r2 = await call("sse", "search_notes");
    assert.match(r2.headers.get("content-type"), /event-stream/);
    assert.match(await r2.text(), /^event: message\ndata: \{/);
    await waitFor(() => reports.length >= 2);
    assert.deepStrictEqual(reports.map((e) => e.tool), ["read_note", "search_notes"]);
    assert.deepStrictEqual(seenUp[0], { url: "/mcp?x=1", sid: "s1" });
  } finally {
    upstream.closeAllConnections();
    await new Promise((ok) => upstream.close(ok));
  }
  try {
    const down = await call(9, "read_note");
    assert.strictEqual(down.status, 502);
    assert.strictEqual((await down.json()).error.code, -32000);
  } finally { proxy.closeAllConnections(); proxy.close(); }
});
