"use strict";
// Optional, local-first semantic search (lib/store/semantic.js) — opt-in embeddings fused with
// the lexical engine (lib/store/search.js), memory-server/tools.js wiring. No real model: every
// test uses the fake embeddings HTTP server (test/fixtures/fake-embed-server.js), deterministic
// and local. Real-quality numbers against a reachable Ollama are measured by bench/semantic-eval.js
// (generic, no private data) — see that file's own header and the README section "Semantic search
// (optional)".
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createSearch } = require("../lib/store/search");
const { createSemanticSearch, chunkNote, rrf, splitLong, sha1 } = require("../lib/store/semantic");
const { createTools } = require("../memory-server/tools");
const { createRpc } = require("../memory-server/rpc");
const { createFakeEmbedServer } = require("./fixtures/fake-embed-server");

function makeTmpKb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-semantic-kb-"));
  const write = (rel, text) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); return abs; };
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function tmpDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-semantic-data-")); }
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-semantic-home-")); } // never the real ~/.memglow

/** A fully isolated env for createSemanticSearch/createSemanticSearch-backed createTools — no
 * ambient process.env, no real ~/.memglow, a disposable dataDir. */
function isolatedEnv(extra = {}) {
  return { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), ...extra };
}

function setupKb() {
  const kb = makeTmpKb();
  kb.write("memory/transport/vehicles.md", [
    "---", "title: Vehicles", "type: note", "permalink: main/memory/transport/vehicles", "---", "",
    "## Daily commute", "", "Bob drives an automobile to the office every weekday morning.", "",
  ].join("\n"));
  kb.write("memory/office/car-raffle.md", [
    "---", "title: Car Raffle", "type: note", "permalink: main/memory/office/car-raffle", "---", "",
    "## Prize", "", "The office raffled off a toy car as a prize at the holiday party.", "",
  ].join("\n"));
  const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
  return { kb, store, done: () => { store.stop(); kb.cleanup(); } };
}

test("semantic OFF by default: createSemanticSearch({store}) with no config/env is inert", () => {
  const { store, done } = setupKb();
  try {
    const semantic = createSemanticSearch({ store, env: isolatedEnv() });
    assert.strictEqual(semantic.configured(), false);
    // Every method is a safe, synchronous-feeling no-op — no timer, no fs access, no throw.
    assert.deepStrictEqual(Object.keys(semantic).sort(), ["configured", "embedAllOnce", "embedQuery", "mergeAsync", "stats", "start", "stop"].sort());
    semantic.start(); semantic.stop(); // must not throw, must not schedule anything real
  } finally { done(); }
});

test("semantic OFF by default: search() stays byte-identical, even when vector/semantic/hybrid are asked for", () => {
  const { store, done } = setupKb();
  try {
    const engineBare = createSearch(store); // no 2nd argument at all — today's call shape
    const unconfigured = createSemanticSearch({ store, env: isolatedEnv() });
    assert.strictEqual(unconfigured.configured(), false);
    const engineWithInert = createSearch(store, unconfigured);
    assert.strictEqual(engineWithInert.defaultSearchType, "text", "no provider configured: default search_type stays text");
    for (const search_type of ["text", "title", "permalink", "vector", "semantic", "hybrid"]) {
      for (const query of ["automobile", "car", "office party", "main/memory/transport/vehicles"]) {
        const args = { query, search_type, page_size: 10 };
        const a = engineBare.search(args);
        const b = engineWithInert.search(args);
        assert.ok(!a || typeof a.then !== "function", "bare engine never returns a Promise");
        assert.ok(!b || typeof b.then !== "function", "unconfigured semantic engine never turns search() async");
        assert.deepStrictEqual(b, a, `search_type=${search_type} query=${JSON.stringify(query)}`);
      }
    }
  } finally { done(); }
});

test("chunkNote: one chunk per section, stable content hash, splits a long section", () => {
  const { store, done } = setupKb();
  try {
    const vehicles = store.notes().find((n) => n.title === "Vehicles");
    const chunks = chunkNote(vehicles);
    assert.strictEqual(chunks.length, 1, "one heading ⇒ one chunk");
    assert.ok(chunks[0].key.startsWith(vehicles.permalink + "#"));
    assert.strictEqual(chunkNote(vehicles)[0].hash, chunks[0].hash, "re-chunking the same note object is deterministic");

    // A long single section splits into several chunks, each within the configured cap.
    const long = "## Everything\n\n" + Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} repeats itself to pad the section out. `.repeat(6)).join("\n\n");
    const { createStore: cs2 } = require("../lib/store/store");
    const kb2 = makeTmpKb();
    kb2.write("memory/long.md", "---\ntitle: Long\npermalink: main/memory/long\n---\n\n" + long);
    const store2 = cs2({ root: kb2.root, watch: false, pollMs: 0 }).start();
    try {
      const note = store2.notes().find((n) => n.title === "Long");
      const parts = chunkNote(note);
      assert.ok(parts.length > 1, "a section well over the token cap splits into several chunks");
      for (const p of parts) assert.ok(p.text.length <= 1700, "each split part stays close to the cap");
      assert.strictEqual(new Set(parts.map((p) => p.key)).size, parts.length, "every split part gets its own key");
    } finally { store2.stop(); kb2.cleanup(); }
  } finally { done(); }
});

test("splitLong/sha1: pure helpers", () => {
  const parts = splitLong("a".repeat(100) + "\n\n" + "b".repeat(100), 120);
  assert.ok(parts.every((p) => p.length <= 120));
  assert.strictEqual(sha1("x"), sha1("x"));
  assert.notStrictEqual(sha1("x"), sha1("y"));
});

test("rrf: Reciprocal Rank Fusion fuses two ranked key lists by the documented formula", () => {
  const k = 60;
  const lexical = ["a", "b", "c"];
  const vector = ["c", "a", "z"];
  const fused = rrf(lexical, vector, k);
  const expected = new Map();
  lexical.forEach((key, i) => expected.set(key, (expected.get(key) || 0) + 1 / (k + i + 1)));
  vector.forEach((key, i) => expected.set(key, (expected.get(key) || 0) + 1 / (k + i + 1)));
  const sortedExpected = [...expected.entries()].sort((a, b) => b[1] - a[1]);
  assert.deepStrictEqual(fused.map((f) => f.key), sortedExpected.map((e) => e[0]));
  for (const f of fused) assert.ok(Math.abs(f.score - expected.get(f.key)) < 1e-12);
  // "a" (rank 1 lexically, rank 2 by vector) edges out "c" (rank 3 lexically, rank 1 by vector) —
  // RRF's 1/(k+rank) curve means a rank-1 appearance is worth only a little more than a rank-2 or
  // rank-3 one at k=60, so being in BOTH lists near the top beats being #1 in just one of them.
  assert.strictEqual(fused[0].key, "a");
  // A key present in only one list still gets a (smaller) fused score — never dropped.
  assert.ok(fused.some((f) => f.key === "b"));
  assert.ok(fused.some((f) => f.key === "z"));
});

test("incremental re-embedding: only changed/new chunks are re-embedded; removed ones are pruned; the cache survives a restart", async () => {
  const { kb, store, done } = setupKb();
  const server = await createFakeEmbedServer();
  const dataDir = tmpDataDir();
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: dataDir, MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "ollama" };
  try {
    const semantic = createSemanticSearch({ store, env, autostart: false });
    assert.strictEqual(semantic.configured(), true);
    await semantic.embedAllOnce();
    const chunksTotal = store.notes().reduce((n, note) => n + chunkNote(note).length, 0);
    assert.strictEqual(server.requests, chunksTotal, "first pass embeds every chunk once");
    assert.strictEqual(semantic.stats().chunks, chunksTotal);

    const before = server.requests;
    await semantic.embedAllOnce();
    assert.strictEqual(server.requests, before, "nothing changed: no new embedding calls");

    // Change ONE note's body: only ITS chunk(s) should be re-embedded.
    kb.write("memory/transport/vehicles.md", [
      "---", "title: Vehicles", "type: note", "permalink: main/memory/transport/vehicles", "---", "",
      "## Daily commute", "", "Bob now drives an electric automobile to the office every weekday morning.", "",
    ].join("\n"));
    store.scan();
    await semantic.embedAllOnce();
    assert.strictEqual(server.requests, before + 1, "exactly the one changed chunk was re-embedded");

    // Remove a note entirely: its chunk is pruned from the vector store.
    fs.rmSync(path.join(kb.root, "memory/office/car-raffle.md"));
    store.scan();
    const beforePrune = semantic.stats().chunks;
    await semantic.embedAllOnce();
    assert.ok(semantic.stats().chunks < beforePrune, "the removed note's chunk(s) were pruned");
    const requestsAfterPrune = server.requests;

    // A brand-new engine over the SAME dataDir loads the cache from disk — no provider call.
    const reloaded = createSemanticSearch({ store, env, autostart: false });
    assert.strictEqual(reloaded.stats().chunks, semantic.stats().chunks);
    assert.strictEqual(server.requests, requestsAfterPrune, "loading the persisted cache never calls the provider");
  } finally { await server.close(); done(); }
});

test("query timeout falls back to plain lexical ranking (hybrid === text when the provider is too slow)", async () => {
  const { store, done } = setupKb();
  const server = await createFakeEmbedServer({ delayMs: 500 });
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "ollama" };
  try {
    const semantic = createSemanticSearch({ store, env, autostart: false });
    const lexical = createSearch(store, null);
    const docs = createSearch(store).index().docs;
    // A 20ms budget against a 500ms-delayed fake server: embedQuery must return null (never
    // throw, never hang past its own timeout), and mergeAsync falls back to the lexical hits
    // completely unchanged.
    const timedOut = await semantic.mergeAsync({ type: "hybrid", query: "automobile", lexicalHits: lexical.search({ query: "automobile", search_type: "text" }).results, docs, timeoutMs: 20 });
    const plain = lexical.search({ query: "automobile", search_type: "text" }).results;
    assert.deepStrictEqual(timedOut, plain, "a timed-out query embedding falls back to the unchanged lexical hits");
    assert.strictEqual(await semantic.embedQuery("automobile", { timeoutMs: 20 }), null, "embedQuery itself also resolves null on a timeout, never throws");
  } finally { await server.close(); done(); }
});

test("provider down: logs once, keeps serving lexical, recovers automatically", async () => {
  const { store, done } = setupKb();
  const server = await createFakeEmbedServer({ failing: true });
  const logs = [];
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "ollama" };
  try {
    const semantic = createSemanticSearch({ store, env, autostart: false, log: (s) => logs.push(s) });
    await semantic.embedAllOnce();
    assert.strictEqual(semantic.stats().down, true);
    assert.strictEqual(logs.length, 1, "the provider-down condition is logged once");
    await semantic.embedAllOnce();
    assert.strictEqual(logs.length, 1, "still once — not once per pass");
    const engine = createSearch(store, semantic);
    const plain = createSearch(store, null).search({ query: "automobile", search_type: "text" });
    const merged = await engine.search({ query: "automobile", search_type: "hybrid" });
    assert.deepStrictEqual(merged, plain, "a down provider degrades to plain lexical results");
    assert.strictEqual(logs.length, 1, "embedQuery's own failure reuses the same once-per-process warning");

    // The provider recovering clears the flag.
    server.setFailing(false);
    await semantic.embedAllOnce();
    assert.strictEqual(semantic.stats().down, false);
  } finally { await server.close(); done(); }
});

test("vector/semantic ranking finds a note lexical search cannot (synonym folding), hybrid keeps both", async () => {
  // Its own small corpus (not setupKb()'s): "bicycle" is never a stop-word in either language,
  // unlike "car" (French "because") — picked on purpose to keep this test's intent unambiguous.
  const kb = makeTmpKb();
  kb.write("memory/office/bike-raffle.md", [
    "---", "title: Bike Raffle", "type: note", "permalink: main/memory/office/bike-raffle", "---", "",
    "## Prize", "", "The office raffled off a toy bicycle as a prize at the holiday party.", "",
  ].join("\n"));
  kb.write("memory/transport/pedal-vehicles.md", [
    "---", "title: Pedal Vehicles", "type: note", "permalink: main/memory/transport/pedal-vehicles", "---", "",
    "## Commute", "", "Bob rides his bike to the office every weekday morning.", "",
  ].join("\n"));
  const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
  const server = await createFakeEmbedServer();
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "ollama" };
  try {
    const semantic = createSemanticSearch({ store, env, autostart: false });
    await semantic.embedAllOnce();
    const engine = createSearch(store, semantic);
    const lexical = createSearch(store, null);

    const lexicalTitles = lexical.search({ query: "bicycle", search_type: "text" }).results.map((h) => h.note.title);
    assert.ok(lexicalTitles.includes("Bike Raffle"), "literal word match");
    assert.ok(!lexicalTitles.includes("Pedal Vehicles"), "lexical search has no notion that \"bike\" means \"bicycle\"");

    const vectorResult = await engine.search({ query: "bicycle", search_type: "vector" });
    const vectorTitles = vectorResult.results.map((h) => h.note.title);
    assert.ok(vectorTitles.includes("Pedal Vehicles"), "the embedding provider's synonym folding (bicycle≈bike) surfaces it");

    const hybridResult = await engine.search({ query: "bicycle", search_type: "hybrid" });
    const hybridTitles = hybridResult.results.map((h) => h.note.title);
    assert.ok(hybridTitles.includes("Pedal Vehicles") && hybridTitles.includes("Bike Raffle"), "RRF keeps both the lexical and the vector-only hit");
  } finally { await server.close(); store.stop(); kb.cleanup(); }
});

test("default search_type becomes hybrid only once a provider is configured, end to end through search_notes", async () => {
  const { kb, store, done } = setupKb();
  const server = await createFakeEmbedServer();
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "ollama" };
  try {
    const configured = createSemanticSearch({ store, env, autostart: false });
    await configured.embedAllOnce();
    const toolsOff = createTools({ store, semantic: null });
    const toolsOn = createTools({ store, semantic: configured });
    assert.strictEqual(toolsOff.engine.defaultSearchType, "text");
    assert.strictEqual(toolsOn.engine.defaultSearchType, "hybrid");

    const offResult = toolsOff.call("search_notes", { query: "automobile" });
    assert.ok(!offResult || typeof offResult.then !== "function", "unconfigured: search_notes stays synchronous");

    const onResult = toolsOn.call("search_notes", { query: "automobile" });
    assert.ok(onResult && typeof onResult.then === "function", "configured + no explicit search_type ⇒ hybrid ⇒ a Promise");
    const resolved = await onResult;
    assert.strictEqual(resolved.isError, false);
    assert.ok(resolved.content[0].text.includes("Vehicles"), "the default hybrid search still finds the note");

    // Full RPC round-trip (the way a real client calls it) — proves the Promise plumbing already
    // used for write tools (memory-server/rpc.js) carries search_notes' async path just as well,
    // which is also what keeps multiQuery (lib/proxy-levers.js lever 9) working unmodified: it
    // treats every sub-call's answer as "maybe a Promise" already.
    const rpc = createRpc({ tools: toolsOn });
    const out = rpc.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "automobile" } } }, {});
    assert.ok(out && typeof out.then === "function");
    const rpcResolved = await out;
    assert.strictEqual(rpcResolved.jsonrpc, "2.0");
    assert.ok(rpcResolved.result.content[0].text.includes("Vehicles"));
  } finally { await server.close(); done(); }
});

test("openai-compatible provider shape works the same way as ollama's", async () => {
  const { store, done } = setupKb();
  const server = await createFakeEmbedServer();
  const env = { MEMGLOW_HOME: tmpHome(), MEMGLOW_DATA_DIR: tmpDataDir(), MEMGLOW_SEMANTIC_URL: server.url, MEMGLOW_SEMANTIC_MODEL: "fake-model", MEMGLOW_SEMANTIC_PROVIDER: "openai" };
  try {
    const semantic = createSemanticSearch({ store, env, autostart: false });
    assert.strictEqual(semantic.configured(), true);
    await semantic.embedAllOnce();
    assert.ok(server.requests > 0);
    assert.strictEqual(semantic.stats().chunks, store.notes().reduce((n, note) => n + chunkNote(note).length, 0));
  } finally { await server.close(); done(); }
});

test("search.semantic config file section (not env) also turns it on — allowCwd:false trust boundary respected", () => {
  const { store, done } = setupKb();
  try {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ search: { semantic: { provider: "ollama", url: "http://127.0.0.1:1", model: "m" } } }));
    const semantic = createSemanticSearch({ store, env: { MEMGLOW_HOME: home }, autostart: false });
    assert.strictEqual(semantic.configured(), true);
    // A ./memglow.config.json in the CURRENT (possibly untrusted) folder must be ignored (same
    // trust boundary as lib/levers/config.js's proxyConfig — allowCwd:false everywhere here).
    const cwdWithConfig = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-semantic-cwd-"));
    fs.writeFileSync(path.join(cwdWithConfig, "memglow.config.json"), JSON.stringify({ search: { semantic: { provider: "openai", url: "http://attacker.example", model: "m" } } }));
    const untrustedHome = tmpHome();
    const semantic2 = createSemanticSearch({ store, env: { MEMGLOW_HOME: untrustedHome }, cwd: cwdWithConfig, autostart: false });
    assert.strictEqual(semantic2.configured(), false, "a cwd memglow.config.json is never read by the memory server");
    fs.rmSync(cwdWithConfig, { recursive: true, force: true });
  } finally { done(); }
});
