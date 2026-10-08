"use strict";
// memglow memory server (stage 0.4.5.2, writes enabled) behind the memglow MCP proxy: write_note
// and edit_note answers go through untouched, the duplicateHint lever (enabled) adds its line,
// sizeWarning sees the fresh size of a note a write just made large, and alreadyLoaded stops
// stubbing a note once a write changed it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../lib/proxy-levers");
const { createHttpProxy } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { makeKb } = require("./fixtures/memory-kb");

async function setup(env = {}) {
  const kb = makeKb();
  kb.write("memory/MEMORY.md", "---\ntitle: MEMORY\ntype: note\npermalink: main/memory/memory\n---\n\n# Memory index\n\n- [[alice]] — Alice, a friend\n- [[Garden Project]] — the garden\n\n" + "Context paragraph about the household and its projects. ".repeat(30));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-msw-proxy-"));
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false });
  const upstream = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const cfg = L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_MEMORY_DIR: kb.root, MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_POLL_MS: "60000", ...env });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }), serverName: "basic-memory" });
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "basic-memory", onReport: () => {}, levers: engine, rules: null });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${proxy.address().port}/mcp`;
  let id = 100;
  const post = async (body, headers = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, headers: r.headers, json: await r.json() };
  };
  const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } } });
  const H = { "mcp-session-id": init.headers.get("mcp-session-id") };
  const call = async (name, args) => (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, H)).json.result.content.map((c) => c.text);
  return {
    kb, srv, call,
    done: () => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); srv.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("through the proxy: write_note / edit_note answers relayed; duplicateHint adds its line for an existing title", async () => {
  const s = await setup({ MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const fresh = await s.call("write_note", { title: "Kayak weekend", directory: "memory/projects", content: "Plan the kayak weekend." });
    assert.strictEqual(fresh.length, 1, "a new subject: no hint");
    assert.match(fresh[0], /^# Created note\nproject: main\nfile_path: memory\/projects\/Kayak weekend\.md\npermalink: main\/memory\/projects\/kayak-weekend\n/);
    const dup = await s.call("write_note", { title: "Alice Martin", directory: "memory/friends", content: "Another Alice note." });
    assert.strictEqual(dup.length, 2);
    assert.match(dup[0], /^# Created note\n/, "the server's own answer first, untouched");
    assert.match(dup[1], /^memglow: a note with this title already exists: \[\[alice\]\] — this write_note may replace or duplicate it; prefer edit_note\.$/);
    const ed = await s.call("edit_note", { identifier: "Kayak weekend", operation: "append", content: "\n- [gear] two paddles" });
    assert.strictEqual(ed.length, 1);
    assert.match(ed[0], /^# Edited note \(append\)\n/);
    const read = await s.call("read_note", { identifier: "main/memory/projects/kayak-weekend" });
    assert.match(read[0], /two paddles$/, "read right after the write sees it");
  } finally { s.done(); }
});

test("through the proxy: sizeWarning uses the fresh size of the note a write just made large", async () => {
  const s = await setup({ MEMGLOW_LARGE_NOTE_TOKENS: "200" });
  try {
    const small = await s.call("write_note", { title: "growing-note", directory: "memory/notes", content: "short" });
    assert.strictEqual(small.length, 1, "small: no warning");
    const big = await s.call("edit_note", { identifier: "growing-note", operation: "append", content: "word ".repeat(400) });
    assert.strictEqual(big.length, 2);
    const size = fs.statSync(path.join(s.kb.root, "memory/notes/growing-note.md")).size;
    assert.match(big[0], new RegExp(`^⚠ memglow: this note is now ≈${Math.ceil(size / 4)} tokens \\(threshold 200\\)`));
    assert.match(big[1], /^# Edited note \(append\)/);
  } finally { s.done(); }
});

test("through the proxy: alreadyLoaded stubs the index note, and stops once a write changed it", async () => {
  const s = await setup({ MEMGLOW_PROXY_ALREADY_LOADED: "1" });
  try {
    await s.call("read_note", { identifier: "bob" }); // some activity first (rule 2)
    const stub = await s.call("read_note", { identifier: "MEMORY" });
    assert.match(stub[0], /^memglow: "MEMORY" \(≈\d+ tokens\) is already in your context/);
    const w = await s.call("edit_note", { identifier: "MEMORY", operation: "append", content: "\n- [[Kayak weekend]] — new entry" });
    assert.match(w[0], /^# Edited note \(append\)/);
    const after = await s.call("read_note", { identifier: "MEMORY" });
    assert.match(after[0], /^---\ntitle: MEMORY/, "full text, not the stub");
    assert.match(after[0], /new entry$/);
    assert.match(after[after.length - 1], /has changed since the start of this session/);
  } finally { s.done(); }
});
