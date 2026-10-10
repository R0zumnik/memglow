// 0.4.10.8 — a search with `memglow_queries` must keep `result.resultType` (MCP 2026-07-28 requires it
// on every result) and the other top-level fields of the server's own result. Bug seen in production
// from the Mac's Claude Code: "missing required resultType — servers implementing protocol revision
// 2026-07-28 MUST include it".
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const L = require("../lib/proxy-levers");
const { createHttpProxy, setupLevers, setupRules } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { makeKb } = require("./fixtures/memory-kb");

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const MODERN = { "mcp-protocol-version": "2026-07-28" };

function env(home) {
  return { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_PROXY_MULTI_QUERY: "1" };
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(data.length), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        const line = text.trim().split("\n").filter((l) => l.trim()).pop().replace(/^data: /, "");
        resolve(JSON.parse(line));
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

const search = (args, meta) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: args, ...(meta ? { _meta: meta } : {}) } });

async function setups() {
  const kb = makeKb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-rt-"));
  const e = env(home);
  // All-in-one (production): one process, levers in-process.
  const aio = createMemoryServer({ root: kb.root, readOnly: true, watch: false, pollMs: 0, fsync: false, allInOne: { env: e, name: "memglow-memory", onReport: () => {} } });
  const aioHttp = createHttpServer({ rpc: aio.rpc, store: aio.store });
  await new Promise((ok) => aioHttp.listen(0, "127.0.0.1", ok));
  // Proxy → plain memory server.
  const plain = createMemoryServer({ root: kb.root, readOnly: true, watch: false, pollMs: 0, fsync: false });
  const up = createHttpServer({ rpc: plain.rpc, store: plain.store });
  await new Promise((ok) => up.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${up.address().port}/mcp`, name: "memglow-memory", onReport: () => {}, levers: setupLevers(e, "memglow-memory"), rules: setupRules(e) });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  return {
    targets: { "all-in-one": `http://127.0.0.1:${aioHttp.address().port}/mcp`, "proxy → server": `http://127.0.0.1:${proxy.address().port}/mcp` },
    close() {
      for (const s of [aioHttp, up, proxy]) { s.closeAllConnections(); s.close(); }
      aio.close(); plain.close();
      fs.rmSync(home, { recursive: true, force: true });
      kb.cleanup && kb.cleanup();
    },
  };
}

test("mergeSearchResults keeps resultType, isError and _meta of the first phrasing's result (both tiers)", () => {
  const idx = L.createNoteIndex(L.proxyConfig({ MEMGLOW_MEMORY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "memglow-rt-empty-")) }));
  const r = (t) => ({ content: [{ type: "text", text: t }], isError: false, resultType: "complete", _meta: { k: 1 } });
  const merged = L.mergeSearchResults(idx, [r("### A\npermalink: x/a\n- match: a"), r("### B\npermalink: x/b\n- match: b")]);
  assert.ok(merged, "merged");
  assert.strictEqual(merged.resultType, "complete");
  assert.strictEqual(merged.isError, false);
  assert.deepStrictEqual(merged._meta, { k: 1 });
  assert.match(merged.content[0].text, /### A/);
});

test("search_notes + memglow_queries keeps result.resultType on MCP 2026-07-28 (header only, as in the bug report; and _meta), both set-ups", async () => {
  const s = await setups();
  try {
    for (const [label, url] of Object.entries(s.targets)) {
      const cases = [
        ["header, plain", search({ query: "garden" }), MODERN],
        ["header, memglow_queries", search({ query: "garden", memglow_queries: ["rugby stade", "tea"] }), MODERN],
        ["_meta, memglow_queries", search({ query: "garden", memglow_queries: ["rugby stade"] }, META), {}],
      ];
      for (const [name, body, headers] of cases) {
        const j = await post(url, body, headers);
        assert.ok(j.result, `${label} / ${name}: result present (${JSON.stringify(j).slice(0, 200)})`);
        assert.strictEqual(j.result.resultType, "complete", `${label} / ${name}: resultType`);
        assert.ok(Array.isArray(j.result.content) && j.result.content.length, `${label} / ${name}: content`);
        if (name.includes("memglow_queries")) assert.ok("isError" in j.result, `${label} / ${name}: isError kept`);
      }
    }
  } finally { s.close(); }
});
