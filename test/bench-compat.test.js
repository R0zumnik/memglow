"use strict";
// bench/compat.js (stage 0.4.5.1): the A/B compatibility + speed harness, run against two memglow
// memory servers over the demo notes (A = B, so every read is identical and every overlap is 1),
// then against a server whose answers differ, to see the differences reported.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const http = require("http");
const { compare, permalinksOf, shapeDiff } = require("../bench/compat");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");

const DEMO = path.join(__dirname, "..", "demo", "memory");
const CALLS = require("../bench/compat-calls.example.json");

async function serve() {
  const srv = createMemoryServer({ root: DEMO, watch: false, pollMs: 0 });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => { server.closeAllConnections(); server.close(); srv.close(); } };
}

test("permalinksOf / shapeDiff", () => {
  assert.deepStrictEqual(permalinksOf("# Search Results: x\n\n### a\n- permalink: main/a\n- score: 1\n\n### b\n- permalink: main/b"), ["main/a", "main/b"]);
  assert.deepStrictEqual(permalinksOf(JSON.stringify({ results: [{ permalink: "p1" }, { id: "p2" }] })), ["p1", "p2"]);
  assert.ok(shapeDiff("# Search Results: a\n- permalink: x", "# Search Results: b\n- permalink: y").same);
  const d = shapeDiff("### t\n- permalink: x\n- score: 1", "### t\n- permalink: x");
  assert.deepStrictEqual(d.onlyA, ["- score:"]);
});

test("compare: the same server twice → identical reads, overlap 1, same shapes (legacy and modern modes)", async () => {
  const A = await serve(), B = await serve();
  try {
    for (const mode of ["modern", "legacy"]) {
      const r = await compare({ a: A.url, b: B.url, calls: CALLS, k: 10, mode });
      assert.strictEqual(r.summary.calls, CALLS.length);
      assert.strictEqual(r.summary.errorsA, 0);
      assert.strictEqual(r.summary.errorsB, 0);
      const reads = r.rows.filter((x) => "identical" in x);
      assert.ok(reads.length >= 4 && reads.every((x) => x.identical), mode);
      const searches = r.rows.filter((x) => "overlap" in x);
      assert.ok(searches.every((x) => x.overlap === 1), mode);
      assert.ok(r.rows.every((x) => x.shape.same), mode);
      assert.ok(r.rows.find((x) => x.label === "search: docker networking").top1Same);
    }
  } finally { A.close(); B.close(); }
});

test("compare: differences are reported (text, overlap, shape, errors); write tools are never sent", async () => {
  const A = await serve();
  const fake = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const m = JSON.parse(b);
      const name = m.params && m.params.name;
      const text = name === "search_notes" ? "# Search Results\n\n### other\n- permalink: main/other\n\n---\n*1 result*" : name === "read_note" ? "something else" : "x";
      const out = "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } }) + "\n\n";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(out);
    });
  });
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  try {
    const calls = [
      { tool: "search_notes", arguments: { query: "docker networking" } },
      { tool: "read_note", arguments: { identifier: "client-northwind" } },
      { tool: "write_note", arguments: { title: "x", content: "y", directory: "z" } },
    ];
    const r = await compare({ a: A.url, b: `http://127.0.0.1:${fake.address().port}/mcp`, calls });
    assert.strictEqual(r.rows[0].overlap, 0);
    assert.deepStrictEqual(r.rows[0].onlyB, ["main/other"]);
    assert.ok(!r.rows[0].shape.same);
    assert.strictEqual(r.rows[1].identical, false);
    assert.strictEqual(r.rows[1].firstDifference.line, 1);
    assert.match(r.rows[2].skipped, /never sent/);
    assert.strictEqual(r.summary.calls, 2);
  } finally { A.close(); fake.closeAllConnections(); fake.close(); }
});
