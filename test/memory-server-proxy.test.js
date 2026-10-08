"use strict";
// memglow memory server (stage 0.4.5.1) behind the memglow MCP proxy (createHttpProxy, upstream =
// this server): search, multiQuery (`memglow_queries`), read_note and alreadyLoaded keep working.
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

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

async function setup(env = {}) {
  const kb = makeKb();
  // An index note long enough for lever 8's stub to be worth it.
  kb.write("memory/MEMORY.md", "---\ntitle: MEMORY\ntype: note\npermalink: main/memory/memory\n---\n\n# Memory index\n\n- [[alice]] — Alice, a friend\n- [[Garden Project]] — the garden\n\n" + "Context paragraph about the household and its projects. ".repeat(30));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-ms-proxy-"));
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const upstream = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const cfg = L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_MEMORY_DIR: kb.root, MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_POLL_MS: "60000", ...env });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }), serverName: "basic-memory" });
  let upstreamCalls = 0;
  upstream.on("request", (req) => { if (req.method === "POST") upstreamCalls++; });
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "basic-memory", onReport: () => {}, levers: engine, rules: null });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${proxy.address().port}/mcp`;
  const post = async (body, headers = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, headers: r.headers, json: await r.json() };
  };
  return {
    kb, srv, url, post, upstreamCalls: () => upstreamCalls,
    done: () => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); srv.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("through the proxy (legacy session): tools/list gains memglow_queries, search + multiQuery merge, read_note, alreadyLoaded stub", async () => {
  const s = await setup({ MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_MULTI_QUERY: "1" });
  try {
    const init = await s.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } } });
    const sid = init.headers.get("mcp-session-id");
    assert.ok(sid, "the server's session id reaches the client through the proxy");
    const H = { "mcp-session-id": sid };
    const list = await s.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, H);
    const sn = list.json.result.tools.find((t) => t.name === "search_notes");
    assert.ok(sn.inputSchema.properties.memglow_queries, "proxy lever 9 advertises memglow_queries on our search tool");

    // Plain search: relayed unchanged.
    const plain = await s.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden" } } }, H);
    assert.match(plain.json.result.content[0].text, /^# Search Results: garden\n\*project: main\*\n\n### Garden Project\n- permalink: main\/memory\/projects\/garden-project/);

    // multiQuery: one call per phrasing upstream, ONE merged answer, built from our own blocks.
    const before = s.upstreamCalls();
    const mq = await s.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_notes", arguments: { query: "tea", memglow_queries: ["rugby stade"] } } }, H);
    assert.strictEqual(s.upstreamCalls() - before, 2, "two upstream calls (one per phrasing)");
    const merged = mq.json.result.content[0].text;
    assert.strictEqual(mq.json.id, 3);
    assert.match(merged, /### Alice Martin\n- permalink: main\/memory\/people\/alice/, "hit of phrasing 1");
    assert.match(merged, /### Rugby Club\n- permalink: main\/memory\/projects\/rugby-club/, "hit of phrasing 2");
    assert.ok(!/memglow: merged results/.test(merged), "tier A: our plain-text blocks are merged as is");
    assert.match(merged, /^# Search Results: tea\n\*project: main\*\n\n### /, "the first phrasing's header stays on top");
    assert.match(merged, /\n\n---\n\*1 result \| page 1, page_size 10\*$/, "…and its footer at the bottom");
    assert.strictEqual((merged.match(/^# Search Results/gm) || []).length, 1, "other phrasings' headers dropped");
    assert.deepStrictEqual(mq.json.result.structuredContent, { result: merged }, "the FastMCP text wrap stays in step");

    // read_note: a normal note comes back in full.
    const bob = await s.post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_note", arguments: { identifier: "main/memory/people/bob" } } }, H);
    assert.strictEqual(bob.json.result.content[0].text, fs.readFileSync(path.join(s.kb.root, "memory/people/bob.md"), "utf8"));
    // alreadyLoaded: the index note (MEMORY) is stubbed, memglow_fresh gets it back.
    const idx = await s.post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_note", arguments: { identifier: "MEMORY" } } }, H);
    assert.match(idx.json.result.content[0].text, /^memglow: "MEMORY" \(≈\d+ tokens\) is already in your context/);
    const fresh = await s.post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_note", arguments: { identifier: "MEMORY", memglow_fresh: true } } }, H);
    assert.match(fresh.json.result.content[0].text, /^---\ntitle: MEMORY/);
  } finally { s.done(); }
});

test("through the proxy (MCP 2026-07-28 per-request mode): multiQuery sub-calls carry _meta and get answered", async () => {
  const s = await setup({ MEMGLOW_PROXY_MULTI_QUERY: "1" });
  try {
    const H = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "search_notes" };
    const mq = await s.post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden", memglow_queries: ["windows endings"] }, _meta: META } }, H);
    const text = mq.json.result.content[0].text;
    assert.match(text, /^# Search Results: garden\n/);
    assert.match(text, /main\/memory\/projects\/garden-project/);
    assert.match(text, /main\/memory\/notes\/crlf/);
    const read = await s.post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_note", arguments: { identifier: "alice" }, _meta: META } }, { ...H, "mcp-name": "read_note" });
    assert.strictEqual(read.json.result.resultType, "complete");
    assert.match(read.json.result.content[0].text, /^---\ntitle: Alice Martin/);
  } finally { s.done(); }
});
