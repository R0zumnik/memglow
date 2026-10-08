"use strict";
// memglow memory server — stage 0.4.5.1b review fixes, one regression test each (items 1-12).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { parseTimeframe } = require("../lib/store/timeframe");
const { globToRegExp } = require("../lib/store/text");
const { makeKb } = require("./fixtures/memory-kb");

const CLI = path.join(__dirname, "..", "memory-server", "memglow-memory-server.js");
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

async function serve(opts = {}, kb = makeKb()) {
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store, ...opts });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const post = (body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { kb, srv, server, port, url, post, done: () => { server.closeAllConnections(); server.close(); srv.close(); kb.cleanup(); } };
}
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
    let out = "";
    sock.on("data", (d) => { out += d; });
    sock.on("close", () => resolve(out));
    sock.on("error", () => resolve(out));
    setTimeout(() => sock.destroy(), 3000);
  });
}

test("fix 1: a malformed request-target answers 400 and never kills the server", async () => {
  const s = await serve();
  try {
    const out = await rawRequest(s.port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(out, /^HTTP\/1\.1 400/);
    const r = await s.post(call("read_note", { identifier: "bob" }));
    assert.strictEqual(r.status, 200, "still serving");
  } finally { s.done(); }
});

test("fix 2: symlinks leaving the root, dot-files and non-regular files are never indexed nor read", async () => {
  const kb = makeKb();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.md"), "---\ntitle: Outside Secret\n---\nplatypus outside\n");
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(kb.root, "memory/evil.md"));
    fs.symlinkSync(outside, path.join(kb.root, "memory/outdir"));
    fs.symlinkSync("/proc/self/environ", path.join(kb.root, "memory/environ.txt"));
    fs.symlinkSync(path.join(kb.root, "memory/people/bob.md"), path.join(kb.root, "memory/bob-link.md"));
    kb.write(".git/config", "[core]\n");
    kb.write("memory/.hidden/x.md", "hidden");
    const s = await serve({}, kb);
    const tool = async (name, args) => (await (await s.post(call(name, args))).json()).result;
    try {
      assert.ok(!s.srv.store.notes().some((n) => n.rel === "memory/evil.md"), "outside symlink not indexed");
      assert.ok(s.srv.store.notes().some((n) => n.rel === "memory/bob-link.md"), "a symlink to a note inside the root is fine");
      assert.match((await tool("search_notes", { query: "platypus" })).content[0].text, /^No results/);
      assert.match((await tool("read_note", { identifier: "Outside Secret" })).content[0].text, /^# Note Not Found/);
      for (const p of ["memory/evil.md", "memory/outdir/secret.md", "memory/environ.txt", ".git/config", "memory/.hidden/x.md", "memory/people", "../../etc/passwd"]) {
        const r = await tool("read_content", { path: p });
        assert.strictEqual(r.isError, true, p);
        assert.ok(!/platypus|core/.test(r.content[0].text), p);
      }
      assert.strictEqual((await tool("read_content", { path: "memory/bob-link.md" })).isError, false);
      assert.match((await tool("basic_memory_diagnostics", {})).content[0].text, /memory\/evil\.md: symlink pointing outside the root/);
    } finally { s.done(); }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test("fix 3: Origin allowlist (DNS rebinding) and optional bearer token", async () => {
  const s = await serve({ allowOrigins: ["http://localhost:3000"], token: "s3cret" });
  try {
    const auth = { authorization: "Bearer s3cret" };
    assert.strictEqual((await s.post(call("list_memory_projects", {}), { ...auth, origin: "http://evil.example" })).status, 403);
    assert.strictEqual((await s.post(call("list_memory_projects", {}), { ...auth, origin: "http://localhost:3000" })).status, 200);
    assert.strictEqual((await s.post(call("list_memory_projects", {}), auth)).status, 200, "no Origin (CLI/MCP clients): allowed");
    assert.strictEqual((await s.post(call("list_memory_projects", {}))).status, 401);
    assert.strictEqual((await s.post(call("list_memory_projects", {}), { authorization: "Bearer nope" })).status, 401);
    assert.strictEqual((await fetch(s.url.replace("/mcp", "/healthz"))).status, 200, "healthz needs no token");
  } finally { s.done(); }
  const d = await serve();
  try {
    assert.strictEqual((await d.post(call("list_memory_projects", {}), { origin: "http://localhost:3000" })).status, 403, "default: no Origin allowed");
    assert.strictEqual((await d.post(call("list_memory_projects", {}))).status, 200);
  } finally { d.done(); }
});

test("fix 4: stdio flushes a large answer completely before exiting on end of input", async () => {
  const kb = makeKb();
  try {
    const big = "0123456789abcdef".repeat(7 * 65536); // 7 MB
    kb.write("docs/big.txt", big);
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [CLI, "--stdio", "--quiet", "--no-watch", "--root", kb.root]);
      const parts = [];
      c.stdout.on("data", (d) => parts.push(d));
      c.on("error", reject);
      c.on("close", () => resolve(Buffer.concat(parts).toString("utf8")));
      c.stdin.end(JSON.stringify(call("read_content", { path: "docs/big.txt" })) + "\n");
    });
    const msg = JSON.parse(out.trim());
    assert.strictEqual(msg.result.structuredContent.text.length, big.length);
  } finally { kb.cleanup(); }
});

test("fix 5: a declared permalink always wins over a path-derived one; declared collisions are deterministic and reported", async () => {
  const kb = makeKb();
  kb.write("memory/x/foo.md", "---\ntitle: Foo\npermalink: main/memory/x/bar\n---\nfoo body\n");
  kb.write("memory/x/bar.md", "---\ntitle: Bar\n---\nbar body\n");
  kb.write("memory/y/one.md", "---\ntitle: One\npermalink: main/dup\n---\n");
  kb.write("memory/y/two.md", "---\ntitle: Two\npermalink: main/dup\n---\n");
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  try {
    assert.strictEqual(srv.store.resolve("main/memory/x/bar").rel, "memory/x/foo.md");
    assert.strictEqual(srv.store.resolve("memory://memory/x/bar").rel, "memory/x/foo.md");
    assert.strictEqual(srv.store.resolve("memory/x/bar.md").rel, "memory/x/bar.md", "the other note stays reachable by path");
    assert.strictEqual(srv.store.resolve("main/dup").rel, "memory/y/one.md", "first in (permalink, path) order");
    assert.deepStrictEqual(srv.store.collisions().map((c) => [c.permalink, c.winner, c.files]), [["main/dup", "memory/y/one.md", ["memory/y/one.md", "memory/y/two.md"]]]);
    assert.match(srv.tools.call("basic_memory_diagnostics", {}).content[0].text, /main\/dup: memory\/y\/one\.md, memory\/y\/two\.md → serves memory\/y\/one\.md/);
    // fix 11: same permalink, distinct ids per file.
    const [one, two] = ["memory/y/one.md", "memory/y/two.md"].map((r) => srv.store.notes().find((n) => n.rel === r));
    assert.notStrictEqual(one.external_id, two.external_id);
    assert.notStrictEqual(one.entity_id, two.entity_id);
  } finally { srv.close(); kb.cleanup(); }
});

test("fix 6: globs are matched without backtracking blow-up", () => {
  const evil = "*a".repeat(40) + "b";
  const t0 = Date.now();
  assert.strictEqual(globToRegExp(evil).test("a".repeat(20000)), false);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(globToRegExp("main/*/x-*").test("MAIN/a/b/x-1"));
  assert.ok(!globToRegExp("*.md", { slashStar: false }).test("a/b.md"));
  const kb = makeKb();
  kb.write("memory/" + "a".repeat(150) + ".md", "x");
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  try {
    const t1 = Date.now();
    srv.tools.call("search_notes", { query: "main/" + evil, search_type: "permalink" });
    srv.tools.call("build_context", { url: "memory://" + evil });
    srv.tools.call("list_directory", { dir_name: "/memory", file_name_glob: evil });
    assert.ok(Date.now() - t1 < 2000, `took ${Date.now() - t1} ms`);
  } finally { srv.close(); kb.cleanup(); }
});

test("fix 7, 8, 10: query size cap; tool names never hit Object.prototype; build_context depth 0", async () => {
  const s = await serve();
  try {
    const t = s.srv.tools;
    const long = t.call("search_notes", { query: "x".repeat(2001) });
    assert.strictEqual(long.isError, true);
    assert.match(long.content[0].text, /query too long: 2001 characters \(maximum 2000\)/);
    const many = t.call("search_notes", { query: Array.from({ length: 65 }, (_, i) => "w" + i).join(" ") });
    assert.match(many.content[0].text, /too many words: 65 \(maximum 64\)/);
    assert.strictEqual(t.call("search_notes", { query: "garden rugby" }).isError, false);
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.strictEqual(t.call(name, {}), null, name);
      const j = await (await s.post(call(name, {}))).json();
      assert.strictEqual(j.error.code, -32602, name);
    }
    const d0 = JSON.parse(t.call("build_context", { url: "alice", depth: 0, output_format: "json" }).content[0].text);
    assert.strictEqual(d0.metadata.depth, 0);
    assert.deepStrictEqual(d0.results[0].related_results, []);
    assert.strictEqual(JSON.parse(t.call("build_context", { url: "alice", output_format: "json" }).content[0].text).metadata.depth, 1, "default still 1");
  } finally { s.done(); }
});

test("fix 9: timeframes \"30s\" and a bare number (days)", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.strictEqual(parseTimeframe("30s", now), now - 30000);
  assert.strictEqual(parseTimeframe("7", now), now - 7 * 86400000);
  assert.strictEqual(parseTimeframe("1.5", now), now - 1.5 * 86400000);
  assert.strictEqual(parseTimeframe("45m", now), now - 45 * 60000);
});

test("fix 12: an oversized body is refused early (413, connection dropped); unsupported protocol versions get a proper error", async () => {
  const s = await serve();
  try {
    // Declared too large: answered before any body is read.
    const out = await rawRequest(s.port, "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 20000000\r\n\r\n{");
    assert.match(out, /^HTTP\/1\.1 413/);
    // Chunked, growing past the limit: the server stops reading and closes the connection long
    // before the 40 MB are sent (whether this raw client still gets to read the 413 before the
    // reset is a TCP race — Node's own servers behave the same — so only the drop is asserted).
    const t0 = Date.now();
    const chunked = await new Promise((resolve) => {
      const sock = net.connect(s.port, "127.0.0.1");
      let got = "", stop = false;
      sock.on("data", (d) => { got += d; });
      sock.on("close", () => { stop = true; resolve({ got, sent }); });
      sock.on("error", () => { stop = true; });
      sock.write("POST /mcp HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n");
      const piece = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = () => { if (stop || sent > 40) return; sent++; sock.write(piece.length.toString(16) + "\r\n"); sock.write(piece); sock.write("\r\n", () => setImmediate(pump)); };
      pump();
      setTimeout(() => sock.destroy(), 8000);
    });
    assert.ok(chunked.sent < 30, `server stopped reading (${chunked.sent} MB sent)`);
    assert.ok(chunked.got === "" || /^HTTP\/1\.1 413/.test(chunked.got));
    assert.ok(Date.now() - t0 < 8000, "connection dropped by the server");
    assert.strictEqual((await s.post(call("read_note", { identifier: "bob" }))).status, 200, "still serving");
    // Unsupported MCP-Protocol-Version header → HTTP 400; in _meta → JSON-RPC error.
    const h = await s.post(call("search_notes", { query: "x" }), { "mcp-protocol-version": "2099-01-01" });
    assert.strictEqual(h.status, 400);
    const hj = await h.json();
    assert.strictEqual(hj.error.code, -32602);
    assert.ok(hj.error.data.supported.includes("2026-07-28"));
    const m = await (await s.post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_notes", arguments: { query: "x" }, _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } })).json();
    assert.strictEqual(m.id, 5);
    assert.match(m.error.message, /Unsupported protocol version: 2099-01-01/);
    assert.strictEqual((await s.post(call("search_notes", { query: "x" }), { "mcp-protocol-version": "2025-06-18" })).status, 200, "a supported legacy version is fine");
  } finally { s.done(); }
});
