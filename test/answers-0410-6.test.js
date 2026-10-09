"use strict";
// 0.4.10.6 — shorter answers: search_notes TEXT output without external_id, a 120-character
// match excerpt (none when it only repeats the title), a shorter footer; --no-structured-read for
// read_note. The levers still find every hit's note in the new format.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer, parseArgs } = require("../memory-server/memglow-memory-server");
const { idsInText } = require("../lib/agent-core");
const L = require("../lib/proxy-levers");
const searchMeta = require("../lib/search-meta");
const { makeKb } = require("./fixtures/memory-kb");

function kb() {
  const k = makeKb();
  const long = "Le jardin potager demande un arrosage régulier le soir, surtout en été quand il fait très chaud, et les tomates aiment beaucoup le compost bien mûr que nous préparons à l'automne avec les feuilles mortes du grand chêne.";
  k.write("memory/notes/potager.md", "---\ntitle: potager-notes\n---\n\n# potager-notes\n\n- " + long + "\n");
  return k;
}

test("search_notes text: no external_id (json keeps it), match ≤ 120 chars around the query, none when it repeats the title, short footer", () => {
  const k = kb();
  const srv = createMemoryServer({ root: k.root, watch: false, pollMs: 0 });
  try {
    const t = srv.tools.call("search_notes", { query: "compost", page_size: 5 }).content[0].text;
    assert.ok(!/external_id/.test(t));
    const m = /- match: (.*)/.exec(t.split("### potager-notes")[1] || "");
    assert.ok(m, t);
    assert.ok(m[1].length <= 120, m[1].length + ": " + m[1]);
    assert.match(m[1], /compost/, "the excerpt keeps the query word");
    const j = JSON.parse(srv.tools.call("search_notes", { query: "compost", output_format: "json" }).content[0].text);
    assert.ok(j.results[0].external_id, "json keeps external_id");
    // A query that only finds the "# potager-notes" heading line: no match line repeating the title.
    const t2 = srv.tools.call("search_notes", { query: "potager-notes" }).content[0].text;
    const blk = t2.split("\n\n").find((b) => b.startsWith("### potager-notes"));
    assert.ok(blk && !/- match:/.test(blk), blk);
    assert.match(t2, /\n---\n\*\d+ results?\*$/);
  } finally { srv.close(); k.cleanup(); }
});

test("--no-structured-read: read_note's text answer carries the note once", () => {
  const k = kb();
  const a = createMemoryServer({ root: k.root, watch: false, pollMs: 0 });
  const b = createMemoryServer({ root: k.root, watch: false, pollMs: 0, structuredRead: false });
  try {
    const ra = a.tools.call("read_note", { identifier: "alice" }), rb = b.tools.call("read_note", { identifier: "alice" });
    assert.deepStrictEqual(ra.structuredContent, { result: ra.content[0].text }, "default: FastMCP copy, as before");
    assert.ok(!("structuredContent" in rb), "no copy");
    assert.strictEqual(rb.content[0].text, ra.content[0].text);
    assert.ok("structuredContent" in b.tools.call("read_note", { identifier: "alice", output_format: "json" }), "json answers unchanged");
  } finally { a.close(); b.close(); k.cleanup(); }
  assert.strictEqual(parseArgs(["--no-structured-read"]).structuredRead, false);
  assert.strictEqual(parseArgs([], { MEMGLOW_MEMORY_STRUCTURED_READ: "0" }).structuredRead, false);
  assert.strictEqual(parseArgs([]).structuredRead, true);
});

test("the levers still resolve every hit of the new format (permalinksIn / idsInText, resultIds, searchDetails)", async () => {
  const k = kb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-short-"));
  const env = { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "d"), MEMGLOW_PROXY_SEARCH_DETAILS: "1" };
  const srv = createMemoryServer({ root: k.root, watch: false, pollMs: 0, allInOne: { env, name: "memglow-memory", onReport: () => {} } });
  try {
    const index = srv.aio.lv.index;
    for (const q of ["garden", "rugby", "compost", "alice", "tea"]) {
      const r = srv.tools.call("search_notes", { query: q });
      const text = r.content[0].text;
      const perms = (text.match(/^- permalink: (.+)$/gm) || []).map((l) => l.slice(13));
      const fromParsers = idsInText(text);
      for (const p of perms) assert.ok(fromParsers.includes(p) || searchMeta.permalinksIn(text).includes(p), p);
      const want = [...new Set(perms.map((p) => index.resolve(p)).filter(Boolean))];
      assert.deepStrictEqual(L.resultIds(index, JSON.parse(JSON.stringify(r)), 50), want, "text path: " + q);
      assert.deepStrictEqual(L.resultIds(index, r, 50), want, "metadata path: " + q);
    }
    const out = srv.rpc.handleAny({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "garden" } } }, { sessionKey: "s" });
    const all = out.result.content.map((c) => c.text).join("\n");
    assert.match(all, /memglow: notes in these results/, "searchDetails still lists the notes");
    assert.match(all, /`garden-project`/);
  } finally { srv.close(); k.cleanup(); }
});

test("tokens per 10-hit search: the new text vs the 0.4.10.5 layout of the same hits", () => {
  const k = makeKb();
  for (let i = 0; i < 30; i++) k.write(`memory/bulk/garden-note-${i}.md`, `---\ntitle: garden-note-${i}\n---\n\n# garden-note-${i}\n\n- ${"Le jardin et le potager du garden, avec un arrosage du soir et des tomates, ".repeat(3)} ligne ${i}\n- autre ligne sur le garden ${i}\n`);
  const srv = createMemoryServer({ root: k.root, watch: false, pollMs: 0 });
  try {
    const r = srv.tools.engine.search({ query: "garden arrosage", page_size: 10 });
    const oldText = ["# Search Results: garden arrosage", "*project: main*", ""].concat(...r.results.map((h) => [`### ${h.note.title}`, `- permalink: ${h.note.permalink}`, `- external_id: ${h.note.external_id}`, `- score: ${h.score.toFixed(4)}`, ...(h.match ? [`- match: ${h.match.replace(/\s+/g, " ").slice(0, 200)}`] : []), ""]))
      .concat("---", `*10 results | page 1, page_size 10 | more available*`).join("\n");
    const newText = srv.tools.call("search_notes", { query: "garden arrosage", page_size: 10 }).content[0].text;
    const tok = (s) => Math.ceil(Buffer.byteLength(s) / 4);
    const cut = 1 - tok(newText) / tok(oldText);
    process.stdout.write(`# tokens per 10-hit search: ${tok(oldText)} → ${tok(newText)} (−${Math.round(cut * 100)} %)\n`);
    assert.ok(cut >= 0.3, `−${Math.round(cut * 100)} %`);
  } finally { srv.close(); k.cleanup(); }
});
