"use strict";
// Cache-stable always-loaded prefix (0.4.4.4, lib/always-loaded.js): a stable hash of the index
// text + rendered memory-rules text, how often it actually changed over 7/30 days
// (<dataDir>/prefix-history.json), the tip only when it changed often, the "share stable" measure,
// and the end-to-end wiring (server.js's Memory cost, mcp-server's memory_health, read-only).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AL = require("../lib/always-loaded");
const { loadConfig } = require("../lib/config");
const { createMemory } = require("../lib/memory");
const memoryRules = require("../lib/memory-rules");
const { createServer } = require("../server");
const { createContext, HANDLERS } = require("../mcp-server/memglow-mcp");

const DAY = 86400000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------------------------------------
// prefixHash / createPrefixHistory / prefixStatus (pure-ish: only prefix-history.json)

test("prefixHash: stable, changes when either the index text or the rules text changes", () => {
  const h1 = AL.prefixHash("index A", "rules A");
  const h2 = AL.prefixHash("index A", "rules A");
  assert.strictEqual(h1, h2);
  assert.notStrictEqual(AL.prefixHash("index B", "rules A"), h1);
  assert.notStrictEqual(AL.prefixHash("index A", "rules B"), h1);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test("createPrefixHistory: only an actual change is logged; changesLast7d/30d count transitions, not the bootstrap", () => {
  const dir = tmp("memglow-prefix-hist-");
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const hist = AL.createPrefixHistory({ dir, now: () => now });
  hist.record("aaaa1111aaaa1111"); // bootstrap: not a "change"
  assert.deepStrictEqual(hist.summary(now), { changesLast7d: 0, changesLast30d: 0 });
  hist.record("aaaa1111aaaa1111"); // same hash again: no-op
  assert.deepStrictEqual(hist.summary(now), { changesLast7d: 0, changesLast30d: 0 });
  now += DAY;
  hist.record("bbbb2222bbbb2222"); // a real change
  assert.deepStrictEqual(hist.summary(now), { changesLast7d: 1, changesLast30d: 1 });
  now += 10 * DAY;
  hist.record("cccc3333cccc3333"); // another change, 11 days after the first
  assert.deepStrictEqual(hist.summary(now), { changesLast7d: 1, changesLast30d: 2 }, "the first change fell out of the 7-day window");
  // Persists and reloads.
  const reloaded = AL.createPrefixHistory({ dir, now: () => now });
  assert.deepStrictEqual(reloaded.summary(now), { changesLast7d: 1, changesLast30d: 2 });
});

test("prefixStatus: the tip appears only once the prefix changed often this week", () => {
  const dir = tmp("memglow-prefix-tip-");
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  let s = AL.prefixStatus({ dataDir: dir, indexText: "idx-0", rulesText: "r", now: () => now });
  assert.strictEqual(s.tip, "", "bootstrap: no tip yet");
  for (let i = 1; i <= AL.PREFIX_TIP_THRESHOLD; i++) {
    now += DAY;
    s = AL.prefixStatus({ dataDir: dir, indexText: "idx-" + i, rulesText: "r", now: () => now });
  }
  assert.strictEqual(s.changesLast7d, AL.PREFIX_TIP_THRESHOLD);
  assert.match(s.tip, /changed \d+ times this week/);
  assert.match(s.tip, /prompt caching/);
});

test("shareStable: 1 for identical text, 0 for a changed FIRST line, partial for a later change", () => {
  assert.strictEqual(AL.shareStable("same", "same"), 1);
  assert.strictEqual(AL.shareStable("", ""), 1);
  assert.strictEqual(AL.shareStable("abc", "xbc"), 0, "the very first character already differs");
  const before = "abcdefghij";
  const after = "abcdeXghij"; // first 5 characters unchanged
  assert.strictEqual(AL.shareStable(before, after), 0.5);
  assert.strictEqual(AL.shareStable(before, before + "more"), 1, "before is a literal prefix of after");
});

// ---------------------------------------------------------------------------------------------
// Measurement: the share of the prefix stable between two consecutive scans of demo/memory

test("measurement: two consecutive scans of demo/memory give the exact same prefix (share = 1)", () => {
  const config = loadConfig({ MEMORY_DIR: path.join(__dirname, "..", "demo", "memory") });
  function prefixTextOnce() {
    const memory = createMemory({ dir: config.memoryDir, config });
    const idx = memory.costNotes().find((n) => n.theme === "index");
    const indexText = fs.readFileSync(path.join(config.memoryDir, idx.rel), "utf8");
    const rulesText = memoryRules.rulesTextFor(config, {});
    return indexText + "\u0000" + rulesText;
  }
  const scan1 = prefixTextOnce();
  const scan2 = prefixTextOnce(); // a second, fully independent createMemory() + rescan
  assert.strictEqual(AL.shareStable(scan1, scan2), 1, "nothing changed on disk between the two scans");
  assert.strictEqual(AL.prefixHash(scan1.split("\u0000")[0], scan1.split("\u0000")[1]), AL.prefixHash(scan2.split("\u0000")[0], scan2.split("\u0000")[1]));
});

// ---------------------------------------------------------------------------------------------
// Wiring: server.js's Memory cost, mcp-server's memory_health (read-only)

test("server.js: GET /api/cost exposes alwaysLoaded.prefix (hash, changes, tip) and records it in the data folder", async () => {
  const dir = tmp("memglow-prefix-srv-notes-");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "---\ntheme: index\n---\n- [[a]] — hook\n");
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntheme: knowledge\n---\nbody");
  const dataDir = tmp("memglow-prefix-srv-data-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const c = await (await fetch(base + "/api/cost")).json();
    assert.match(c.alwaysLoaded.prefix.hash, /^[0-9a-f]{16}$/);
    assert.strictEqual(typeof c.alwaysLoaded.prefix.changesLast7d, "number");
    assert.strictEqual(c.alwaysLoaded.prefix.tip, "", "just one scan: not 'often'");
    assert.ok(fs.existsSync(path.join(dataDir, "prefix-history.json")));
  } finally { server.close(); }
});

test("mcp-server: memory_health's prefix is read-only (never writes the data folder)", () => {
  const dir = tmp("memglow-prefix-mcp-notes-");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "---\ntheme: index\n---\n- [[a]] — hook\n");
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntheme: knowledge\n---\nbody");
  const dataDir = tmp("memglow-prefix-mcp-data-");
  const ctx = createContext({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir });
  const r = HANDLERS.memory_health(ctx);
  assert.match(r.data.prefix.hash, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(fs.readdirSync(dataDir), [], "memory_health never writes memglow's own data folder either");
});
