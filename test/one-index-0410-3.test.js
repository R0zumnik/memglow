"use strict";
// 0.4.10.3 — one index: in all-in-one mode the levers' note index is fed from the store (no second
// scan), lever 8 hashes the in-memory text, a write is an incremental update (search df/vocab
// too), and the store's link graph is built lazily.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createStoreMemory } = require("../memory-server/store-memory");
const { createStore } = require("../lib/store/store");
const { buildIndex } = require("../lib/store/search");
const { createMemory } = require("../lib/memory");
const L = require("../lib/proxy-levers");
const { makeKb } = require("./fixtures/memory-kb");
const { makeKb: makeSynthetic } = require("../bench/responsiveness");

const call = (srv, name, args, id = 1) => srv.rawRpc.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, {});
const strip = (g) => ({ nodes: g.nodes, links: g.links });

function leverEnv(home) {
  return { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_DUPLICATE_HINT: "1", MEMGLOW_POLL_MS: "60000" };
}

test("all-in-one: the levers' note index reads the store — same graph as lib/memory.js, before and after writes", async () => {
  const kb = makeKb();
  makeSynthetic(path.join(kb.root, "memory", "synthetic"), 60);
  fs.writeFileSync(path.join(kb.root, "memory", "bom-note.md"), "﻿---\ntitle: Bom note\ndescription: with a BOM\n---\n\nBody [[alice]].\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-oneidx-"));
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false, allInOne: { env: leverEnv(home), name: "memglow-memory", onReport: () => {} } });
  try {
    const mem = srv.aio.lv.index._memory();
    assert.strictEqual(mem.fromStore, true, "fed from the store, not lib/memory.js");
    const cfg = srv.aio.lv.config;
    const ref = () => createMemory({ dir: path.join(kb.root, "memory"), config: cfg.memory, pollMs: 0 });
    assert.deepStrictEqual(strip(mem.graph()), strip(ref().graph()), "same nodes and links as a lib/memory.js scan");
    // Lever 8's hash: the in-memory text, byte-identical to the file (BOM included).
    for (const id of ["alice", "bom-note", "MEMORY"]) {
      const disk = crypto.createHash("sha1").update(fs.readFileSync(path.join(kb.root, "memory", mem.fileOf(id)))).digest("hex");
      assert.strictEqual(srv.aio.lv.index.fileHash(id), disk, id);
    }
    // Writes: the index follows at once, without a rescan; a frontmatter-only change keeps the
    // body-change date, as lib/memory.js does.
    const m0 = mem.graph().nodes.find((n) => n.id === "alice").mtime;
    await new Promise((ok) => setTimeout(ok, 20));
    let r = await call(srv, "edit_note", { identifier: "alice", operation: "find_replace", find_text: "Alice is a friend", content: "Alice is a friend", expected_replacements: 1, metadata: { status: "busy" } });
    assert.strictEqual(r.result.isError, false, JSON.stringify(r));
    assert.strictEqual(mem.graph().nodes.find((n) => n.id === "alice").mtime, m0, "frontmatter-only change: same mtime");
    r = await call(srv, "write_note", { title: "brand-new", directory: "memory/ideas", content: "Links to [[bob]] and [[alice]]." });
    assert.strictEqual(r.result.isError, false);
    assert.ok(srv.aio.lv.index.note("brand-new"), "a new note is known at once");
    srv.aio.lv.index.afterWrite();
    const g = strip(mem.graph()), want = ref();
    want.scan();
    const wg = strip(want.graph());
    // lib/memory.js scanned fresh sees alice's new file mtime (no previous scan to compare with).
    const norm = (x) => ({ nodes: x.nodes.map((n) => ({ ...n, mtime: n.id === "alice" ? 0 : n.mtime })), links: x.links });
    assert.deepStrictEqual(norm(g), norm(wg));
  } finally { srv.close(); kb.cleanup(); }
});

test("all-in-one: the first read no longer scans the folder a second time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-oneidx-read-"));
  makeSynthetic(root, 265);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-oneidx-h-"));
  const reads = [];
  const real = fs.readFileSync;
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, allInOne: { env: leverEnv(home), name: "memglow-memory", onReport: () => {} } });
  fs.readFileSync = function (p, ...a) { if (String(p).startsWith(root)) reads.push(String(p)); return real.call(fs, p, ...a); };
  try {
    const init = srv.rpc.handleAny({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } } }, { sessionKey: "s" });
    assert.ok(init.result);
    const t0 = process.hrtime.bigint();
    const r = srv.rpc.handleAny({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { identifier: "MEMORY" } } }, { sessionKey: "s" });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(r.result && !r.result.isError);
    assert.strictEqual(reads.length, 0, "no note file read: " + reads.slice(0, 3).join(", "));
    process.stdout.write(`# first read after initialize: ${ms.toFixed(1)} ms\n`);
  } finally { fs.readFileSync = real; srv.close(); }
});

test("search index: an incremental update after writes is exactly a full rebuild (df, vocab, lengths)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-oneidx-df-"));
  makeSynthetic(root, 120);
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false });
  try {
    const engine = srv.tools.engine;
    const check = (label) => {
      const inc = engine.index();
      const full = buildIndex(srv.store.notes());
      assert.strictEqual(inc.N, full.N, label);
      assert.strictEqual(inc.totalLen, full.totalLen, label);
      assert.strictEqual(inc.avgLen, full.avgLen, label);
      assert.deepStrictEqual(inc.vocab, full.vocab, label + " vocab");
      assert.deepStrictEqual([...inc.df.entries()].sort(), [...full.df.entries()].sort(), label + " df");
      assert.deepStrictEqual(inc.docs.map((d) => d.note.rel), full.docs.map((d) => d.note.rel), label + " docs order");
    };
    check("start");
    const ops = [
      ["write_note", { title: "zzqx unique words", directory: "memory/new", content: "brandnewterm anotherfreshterm garden" }],
      ["edit_note", { identifier: "zzqx unique words", operation: "find_replace", find_text: "brandnewterm", content: "replacedterm" }],
      ["edit_note", { identifier: "zzqx unique words", operation: "append", content: "\nmore text with école été" }],
      ["move_note", { identifier: "zzqx unique words", destination_path: "memory/moved/zzqx.md" }],
      ["delete_note", { identifier: "memory/moved/zzqx.md" }],
    ];
    for (const [name, args] of ops) {
      const r = await call(srv, name, args);
      assert.strictEqual(r.result.isError, false, name + " " + JSON.stringify(r));
      check(name);
    }
    // A search right after a write: the incremental update keeps it fast.
    await call(srv, "write_note", { title: "timing note", directory: "memory/new", content: "rugby timing" });
    let t0 = process.hrtime.bigint();
    engine.search({ query: "rugby stade" });
    const afterWrite = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    engine.search({ query: "rugby stade" });
    const steady = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(`# search right after a write ${afterWrite.toFixed(2)} ms, steady ${steady.toFixed(2)} ms\n`);
    assert.ok(afterWrite - steady < 25, `first search after a write costs ${(afterWrite - steady).toFixed(1)} ms extra`);
  } finally { srv.close(); }
});

test("store: the link graph is built lazily (graph()), resolution maps right away", () => {
  const kb = makeKb();
  try {
    const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
    assert.ok(store.resolve("alice"));
    const g = store.graph();
    assert.ok(g.outgoing instanceof Map && g.incoming instanceof Map);
    assert.ok((g.incoming.get("memory/people/bob.md") || []).length >= 1, "alice knows bob");
  } finally { kb.cleanup(); }
});

test("store memory: only for an index folder inside the store's root; createNoteIndex keeps lib/memory.js otherwise", () => {
  const kb = makeKb();
  try {
    const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
    assert.strictEqual(createStoreMemory({ store, memoryDir: os.tmpdir(), config: {} }), null);
    assert.ok(createStoreMemory({ store, memoryDir: path.join(kb.root, "memory"), config: {} }));
    const cfg = L.proxyConfig({ MEMGLOW_HOME: kb.root, MEMGLOW_CONFIG: path.join(kb.root, "none.json"), MEMGLOW_MEMORY_DIR: path.join(kb.root, "memory") });
    assert.ok(!L.createNoteIndex(cfg)._memory().fromStore, "the standalone proxy keeps its own index");
  } finally { kb.cleanup(); }
});
