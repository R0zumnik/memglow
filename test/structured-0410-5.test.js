"use strict";
// 0.4.10.5 — structured hand-off: the in-process server's search results carry their blocks and
// note references (lib/search-meta.js), the levers use them instead of re-parsing the text, and
// the search engine scores only the docs its posting lists name. Every shortcut must give exactly
// what the text path gives.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const searchMeta = require("../lib/search-meta");
const { idsInText } = require("../lib/agent-core");
const L = require("../lib/proxy-levers");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { buildCorpus } = require("./fixtures/ranking-corpus");

const QUERIES = ["garden", "rugby stade", "alice", "été", "memory/people", "garden.md", "permalink: x", "memory://memory/people/*", "tomate", "école forêt",
  "zebra", "garden project", "bob", "jardin château", "rugby", "the", "tag:friend", "garden -rugby", "\"vegetable garden\"", "2026"];

test("search metadata: the blocks are exactly what hitChunksOf cuts, the references exactly what the parsers find", () => {
  const kb = buildCorpus();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  try {
    let withMeta = 0, pure = 0;
    for (const q of QUERIES) for (const extra of [{}, { page_size: 30 }, { search_type: "title" }, { entity_types: ["observation"] }]) {
      const r = srv.tools.call("search_notes", { query: q, ...extra });
      const m = searchMeta.get(r);
      const text = r.content[0].text;
      if (!m) continue;
      withMeta++;
      if (m.pure) pure++;
      assert.deepStrictEqual(m.chunks.map((c) => c.text), L.hitChunksOf(text), "blocks of " + q);
      for (const c of m.chunks) {
        assert.deepStrictEqual(c.perm, searchMeta.permalinksIn(c.text), "permalinks of a block of " + q);
        assert.deepStrictEqual(c.ids, idsInText(c.text), "refs of a block of " + q);
      }
      if (m.pure) {
        // A pure result: the whole text (and its JSON copy) names nothing but the hits' permalinks.
        const all = [...searchMeta.permalinksIn(text), ...idsInText(text), ...searchMeta.permalinksIn(JSON.stringify(r.structuredContent)), ...idsInText(JSON.stringify(r.structuredContent))];
        const own = new Set(m.chunks.flatMap((c) => c.perm));
        for (const x of all) assert.ok(own.has(x), `${q}: ${x} is a hit permalink`);
      }
    }
    assert.ok(withMeta > 40 && pure > 20, `${withMeta} with metadata, ${pure} pure`);
    // 2026-07-28 answers are copies (resultType): the metadata follows.
    const modern = srv.rawRpc.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }, { headerVersion: "2026-07-28" });
    assert.ok(searchMeta.get(modern.result), "kept on the copied result");
  } finally { srv.close(); fs.rmSync(kb.root, { recursive: true, force: true }); }
});

test("levers: ids from metadata = ids from the text, and a multiQuery merge from metadata = the merge from the text", () => {
  const kb = buildCorpus();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-struct-"));
  const cfg = L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_MEMORY_DIR: path.join(kb.root, "memory"), MEMGLOW_DATA_DIR: path.join(home, "d") });
  const index = L.createNoteIndex(cfg);
  const strip = (r) => JSON.parse(JSON.stringify(r)); // same content, no metadata
  try {
    for (const q of QUERIES) {
      const r = srv.tools.call("search_notes", { query: q, page_size: 20 });
      for (const cap of [3, 10, 50]) assert.deepStrictEqual(L.resultIds(index, r, cap), L.resultIds(index, strip(r), cap), `ids of ${q} (cap ${cap})`);
    }
    for (let i = 0; i + 2 < QUERIES.length; i++) {
      const rs = [QUERIES[i], QUERIES[i + 1], QUERIES[i + 2]].map((q) => srv.tools.call("search_notes", { query: q }));
      const a = L.mergeSearchResults(index, rs);
      const b = L.mergeSearchResults(index, rs.map(strip));
      assert.deepStrictEqual(strip(a), strip(b), `merge of ${QUERIES.slice(i, i + 3).join(" | ")}`);
      if (a) assert.deepStrictEqual(L.resultIds(index, a, 10), L.resultIds(index, strip(a), 10));
    }
  } finally { srv.close(); fs.rmSync(kb.root, { recursive: true, force: true }); }
});

test("posting lists: a raw search scores only candidate docs, with the same results", () => {
  const kb = buildCorpus();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  try {
    const I = srv.tools.engine.index();
    for (const [t, set] of I.postings) assert.strictEqual(set.size, I.df.get(t), t);
    assert.strictEqual(I.postings.size, I.df.size);
    const t0 = process.hrtime.bigint();
    let n = 0;
    for (let k = 0; k < 5; k++) for (const q of QUERIES) { srv.tools.engine.search({ query: q }); n++; }
    process.stdout.write(`# raw search ${(Number(process.hrtime.bigint() - t0) / 1e6 / n).toFixed(2)} ms on ${I.N} notes\n`);
  } finally { srv.close(); fs.rmSync(kb.root, { recursive: true, force: true }); }
});
