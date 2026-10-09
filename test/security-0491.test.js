"use strict";
// 0.4.9.1 — security fixes from the audit, and two bugs found in production: one regression test
// per item (S1, S2, proxy session keys, multiQuery duplicate, S5, S6, S7, S8).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const L = require("../lib/proxy-levers");
const { createHttpProxy } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer, parseArgs } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { createRulesRelay } = require("../lib/memory-rules");
const { childEnv } = require("../lib/assistant/providers/cli");
const { makeKb } = require("./fixtures/memory-kb");

/** Raw bytes on a fresh TCP connection; resolves with the whole answer text (or "" on reset). */
function raw(port, bytes, waitMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    s.on("data", (c) => { out += c; });
    s.on("error", () => resolve(out));
    s.on("close", () => resolve(out));
    s.write(bytes);
    setTimeout(() => { s.destroy(); resolve(out); }, waitMs).unref();
  });
}

function post(url, body, headers = {}, agent) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const req = http.request(url, { method: "POST", agent, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(data.length), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** A tiny upstream MCP server: hands out session ids on initialize, echoes tools/call. */
async function fakeUpstream() {
  let n = 0;
  const srv = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      let m = null;
      try { m = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { /* not JSON */ }
      const h = { "content-type": "application/json" };
      let out;
      if (m && m.method === "initialize") { h["mcp-session-id"] = "up-" + (++n); out = { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" }, instructions: "upstream" } }; }
      else if (m && m.id != null) out = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
      if (!out) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, h); res.end(JSON.stringify(out));
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

async function listen(server) { await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); return server.address().port; }

test("S1: the HTTP proxy answers 400 to a malformed request-target and keeps serving", async () => {
  const up = await fakeUpstream();
  const proxy = createHttpProxy({ upstream: up.url, name: "x", levers: null, rules: null, onReport: () => {} });
  const port = await listen(proxy);
  try {
    const a = await raw(port, "POST http://[::1 HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}");
    assert.match(a, /^HTTP\/1\.1 400/, "malformed request-target: 400, not a crash");
    const b = await post(`http://127.0.0.1:${port}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    assert.strictEqual(b.status, 200, "still serving afterwards");
  } finally { proxy.closeAllConnections(); proxy.close(); up.close(); }
  // The CLI entry point installs the process-level handlers.
  const src = fs.readFileSync(path.join(__dirname, "..", "mcp-proxy", "memglow-mcp-proxy.js"), "utf8");
  assert.match(src, /process\.on\("uncaughtException"/);
  assert.match(src, /process\.on\("unhandledRejection"/);
});

test("S2: the viewer answers 400 to /api/note/%E0%A4%A and to a malformed request-target, and keeps serving", async () => {
  const { createServer } = require("../server");
  const { createMemory } = require("../lib/memory");
  const { loadConfig } = require("../lib/config");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-s2-"));
  fs.writeFileSync(path.join(dir, "a.md"), "# a\n");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: path.join(dir, ".data"), MEMGLOW_HOME: path.join(dir, ".home"), MEMGLOW_CONFIG: path.join(dir, "none.json") });
  const memory = createMemory({ dir, config, pollMs: 60000 });
  const server = createServer(config, memory);
  const port = await listen(server);
  try {
    const get = (p) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}${p}`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject));
    assert.strictEqual(await get("/api/note/%E0%A4%A"), 400);
    const r = await raw(port, "GET http://[::1 HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(r, /^HTTP\/1\.1 400/);
    assert.strictEqual(await get("/api/note/a"), 200, "still serving");
  } finally { server.closeAllConnections(); server.close(); }
});

test("proxy session keys: stateless requests are keyed per TCP connection, and an initialize's state follows the session id the upstream hands out", async () => {
  const up = await fakeUpstream();
  const seen = [];
  const rules = createRulesRelay({ text: "RULES-TEXT" });
  const spy = {
    clientMessage: (m, sk) => { seen.push(["c", m && m.method, sk]); return rules.clientMessage(m, sk); },
    serverMessage: (m, sk) => rules.serverMessage(m, sk),
    wants: (ids, sk) => rules.wants(ids, sk),
    renameSession: (a, b) => { seen.push(["rename", a, b]); return rules.renameSession(a, b); },
  };
  const proxy = createHttpProxy({ upstream: up.url, name: "x", levers: null, rules: spy, onReport: () => {} });
  const port = await listen(proxy);
  const url = `http://127.0.0.1:${port}/mcp`;
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } } };
  try {
    // Two clients, one after the other: BOTH get the memory rules (the old shared "default"
    // session gave them to the first client only).
    const a1 = new http.Agent({ keepAlive: true, maxSockets: 1 }), a2 = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const r1 = await post(url, init, {}, a1);
    const r2 = await post(url, init, {}, a2);
    assert.match(r1.text, /RULES-TEXT/);
    assert.match(r2.text, /RULES-TEXT/, "the second client gets the rules too");
    assert.ok(seen.some((x) => x[0] === "rename" && /^conn:/.test(x[1]) && x[2] === "sid:" + r1.headers["mcp-session-id"]), "initialize state moved under the upstream's session id");
    // Stateless requests (no Mcp-Session-Id): one key per connection, never "default".
    seen.length = 0;
    await post(url, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "t" } }, {}, a1);
    await post(url, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "t" } }, {}, a2);
    const keys = seen.filter((x) => x[0] === "c").map((x) => x[2]);
    assert.strictEqual(keys.length, 2);
    assert.ok(keys.every((k) => /^conn:/.test(k)), "per-connection keys");
    assert.notStrictEqual(keys[0], keys[1], "two connections, two keys");
    seen.length = 0;
    await post(url, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "t" } }, { "mcp-session-id": "abc" }, a1);
    assert.strictEqual(seen[0][2], "sid:abc", "a session id is the key when sent");
    a1.destroy(); a2.destroy();
  } finally { proxy.closeAllConnections(); proxy.close(); up.close(); }
});

test("multiQuery merge: the same note found by two phrasings is listed ONCE, even when the note index cannot resolve it (production duplicate)", () => {
  // Shaped like the real all-in-one output: header, `### ` hit blocks with permalink /
  // external_id / score / match lines (scores and matches differ per phrasing), a multi-chunk hit
  // (an excerpt with blank lines, basic-memory style), the "---" footer, and a related section
  // after it. The roadmap note's FILE is named differently from its permalink, so the levers'
  // note index (keyed by file name) cannot resolve it — the old code then keyed it by its whole
  // block text, which differs per phrasing, and listed it twice.
  const byId = new Map([["other-note", { id: "other-note", label: "Other" }], ["third", { id: "third", label: "Third" }], ["memglow-v05-engine-roadmap", { id: "memglow-v05-engine-roadmap", label: "Roadmap" }], ["four", { id: "four", label: "Four" }], ["five", { id: "five", label: "Five" }]]);
  const idx = { resolve: (r) => { const b = String(r).split("/").pop(); return byId.has(b) ? b : null; }, note: (id) => byId.get(id) || null };
  const hit = (title, pl, score, match) => `### ${title}\n- permalink: ${pl}\n- external_id: 0000-${score}\n- score: ${score}\n- match: ${match}`;
  const RM = "main/memory/projects/project-memglow-v05-engine-roadmap";
  const p0 = ["# Search Results: memglow roadmap", "*project: main*", "",
    hit("project-memglow-v05-engine-roadmap", RM, "12.0000", "the v0.5 engine roadmap"), "",
    hit("Other", "main/memory/other-note", "3.0000", "first part of an excerpt") + "\n\nsecond part of the same excerpt", "",
    "---", "*2 results | page 1, page_size 10*", "", "## Related", "- permalink: " + RM].join("\n");
  const p1 = ["# Search Results: v0.5 engine", "*project: main*", "",
    hit("Third", "main/memory/third", "9.0000", "a third note"), "",
    hit("Other", "main/memory/other-note", "4.5000", "another excerpt"), "",
    hit("project-memglow-v05-engine-roadmap", RM, "2.0000", "engine plan, later"), "",
    hit("Four", "main/memory/four", "1.5000", "four"), "",
    hit("Five", "main/memory/five", "1.0000", "five"), "",
    "---", "*5 results | page 1, page_size 10*"].join("\n");
  const wrap = (t) => ({ content: [{ type: "text", text: t }], structuredContent: { result: t } });
  const merged = L.mergeSearchResults(idx, [wrap(p0), wrap(p1)]);
  const text = merged.content[0].text;
  const count = (text.match(/permalink: main\/memory\/projects\/project-memglow-v05-engine-roadmap/g) || []).length;
  assert.strictEqual(count, 1, "the roadmap note appears once:\n" + text);
  assert.strictEqual((text.match(/^### Other/gm) || []).length, 1, "other-note once");
  assert.match(text, /second part of the same excerpt/, "a multi-chunk hit stays whole");
  assert.match(text, /^# Search Results: memglow roadmap/, "the first phrasing's header kept");
  assert.match(text, /\*2 results \| page 1, page_size 10\*/, "its footer kept");
  assert.strictEqual(merged.structuredContent.result, text);
});

test("S5: a proxy request body over 10 MB is answered 413 and dropped, never truncated and relayed", async () => {
  let relayed = 0;
  const upSrv = http.createServer((req, res) => { relayed++; req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await listen(upSrv);
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upSrv.address().port}/mcp`, name: "x", levers: null, rules: null, onReport: () => {} });
  const port = await listen(proxy);
  try {
    const big = "x".repeat(10 * 1024 * 1024 + 10);
    // Declared length over the cap.
    const r1 = await post(`http://127.0.0.1:${port}/mcp`, big).catch((e) => ({ status: "error " + e.code }));
    assert.strictEqual(r1.status, 413);
    // Chunked, no declared length.
    const r2 = await new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", () => resolve("reset"));
      for (let i = 0; i < 11; i++) req.write("y".repeat(1024 * 1024));
      req.end();
    });
    assert.strictEqual(r2, 413);
    assert.strictEqual(relayed, 0, "nothing relayed upstream");
  } finally { proxy.closeAllConnections(); proxy.close(); upSrv.closeAllConnections(); upSrv.close(); }
});

test("S6: read_content serves text and image types only, unless --serve-files any", async () => {
  const kb = makeKb();
  fs.writeFileSync(path.join(kb.root, "secret.sqlite"), "SQLITE");
  fs.writeFileSync(path.join(kb.root, "run.sh"), "#!/bin/sh\necho hi\n");
  fs.writeFileSync(path.join(kb.root, "noext"), "plain");
  fs.writeFileSync(path.join(kb.root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(kb.root, "data.json"), "{\"a\":1}");
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  const rc = (p) => srv.tools.call("read_content", { path: p });
  try {
    for (const p of ["secret.sqlite", "run.sh", "noext"]) assert.strictEqual(rc(p).isError, true, p + " refused");
    for (const p of ["pic.png", "data.json", "memory/people/alice.md"]) assert.strictEqual(rc(p).isError, false, p + " served");
    assert.match(rc("secret.sqlite").content[0].text, /--serve-files any/);
  } finally { srv.close(); }
  const any = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, serveFiles: "any" });
  try { assert.strictEqual(any.tools.call("read_content", { path: "secret.sqlite" }).isError, false, "--serve-files any: old behaviour"); }
  finally { any.close(); }
  assert.strictEqual(parseArgs(["--serve-files", "any"]).serveFiles, "any");
  assert.strictEqual(parseArgs([]).serveFiles, "text");
});

test("S7: a CLI provider's child never sees memglow's memory-server settings or any token / password / secret / key variable", () => {
  const env = childEnv({
    PATH: "/bin", HOME: "/h", LANG: "C",
    MEMGLOW_MEMORY_TOKEN: "t", MEMGLOW_MEMORY_ROOT: "/kb", MEMGLOW_TOKEN: "x", MEMGLOW_PASSWORD: "p",
    GITHUB_TOKEN: "g", DB_PASSWORD: "d", AWS_SECRET_ACCESS_KEY: "a", OPENAI_API_KEY: "o", MY_KEY_FILE: "k", some_secret: "s",
    CLAUDE_CODE_OAUTH_TOKEN: "c", ANTHROPIC_API_KEY: "ak",
  });
  for (const k of ["MEMGLOW_MEMORY_TOKEN", "MEMGLOW_MEMORY_ROOT", "MEMGLOW_TOKEN", "MEMGLOW_PASSWORD", "GITHUB_TOKEN", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "MY_KEY_FILE", "some_secret"]) assert.ok(!(k in env), k + " stripped");
  for (const k of ["PATH", "HOME", "LANG"]) assert.ok(k in env, k + " kept");
  // Claude Code's own sign-in variables are what the claude-code provider needs to run at all.
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "c");
  assert.strictEqual(env.ANTHROPIC_API_KEY, "ak");
});

test("S8: a new note file gets mode 0660 by default (not 0666 & ~umask); an existing file keeps its mode", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-s8-"));
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "memory", "old.md"), "# old\n");
  fs.chmodSync(path.join(root, "memory", "old.md"), 0o604);
  const old = process.umask(0o002);
  try {
    const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, chownToParent: false });
    const w = await srv.tools.call("write_note", { title: "fresh", directory: "memory", content: "hello" });
    assert.strictEqual(w.isError, false, JSON.stringify(w));
    assert.strictEqual(fs.statSync(path.join(root, "memory", "fresh.md")).mode & 0o777, 0o660);
    const e = await srv.tools.call("edit_note", { identifier: "old", operation: "append", content: "x" });
    assert.strictEqual(e.isError, false, JSON.stringify(e));
    assert.strictEqual(fs.statSync(path.join(root, "memory", "old.md")).mode & 0o777, 0o604, "existing file keeps its mode");
    srv.close();
  } finally { process.umask(old); }
  assert.strictEqual(parseArgs([]).fileMode, null, "no explicit mode: new files 0660, existing keep theirs");
  assert.strictEqual(parseArgs(["--file-mode", "0664"]).fileMode, 0o664);
});
