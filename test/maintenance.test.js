"use strict";
// Scheduled maintenance proposals (lib/maintenance.js, 0.4.4.3): detection (ranking, stable ids),
// the store's dismiss persistence, the scheduler's start/stop with an injectable timer, that
// computeMaintenance NEVER writes a note (snapshot of the notes folder), and the HTTP endpoints.
// Memory never applies anything itself: every item only names what an existing assistant
// proposal kind (split/archive/indexTrim) would need to start.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../lib/maintenance");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const { createCounters } = require("../lib/counters");
const { createServer } = require("../server");

const DAY = 86400000;
const NOW = Date.now();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ------------------------------------------------------------------ config.maintenanceEveryHours

test("config.maintenanceEveryHours: default 24, env override, 0 allowed (off), clamped", () => {
  assert.strictEqual(loadConfig({}, os.tmpdir()).maintenanceEveryHours, 24);
  assert.strictEqual(loadConfig({ MEMGLOW_MAINTENANCE_EVERY_HOURS: "6" }, os.tmpdir()).maintenanceEveryHours, 6);
  assert.strictEqual(loadConfig({ MEMGLOW_MAINTENANCE_EVERY_HOURS: "0" }, os.tmpdir()).maintenanceEveryHours, 0, "0 = off, a real value, not ignored");
  assert.strictEqual(loadConfig({ MEMGLOW_MAINTENANCE_EVERY_HOURS: "-5" }, os.tmpdir()).maintenanceEveryHours, 24, "out of range: default");
  assert.strictEqual(loadConfig({ MEMGLOW_MAINTENANCE_EVERY_HOURS: "999999" }, os.tmpdir()).maintenanceEveryHours, 24, "out of range: default");
});

/** A memory folder with: one dormant-ready note (old counters, old body), one over-threshold note,
 * and an index with a long hook line pointing at a note with no description (an index-trim candidate). */
function buildFixture() {
  const dir = tmp("memglow-maint-notes-");
  const fill = (word) => Array.from({ length: 10 }, (_, i) => `${word} line ${i}: a sentence nobody has needed in a long while now.`).join("\n");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "---\ntitle: Index\ntheme: index\n---\n- [[old-project]] — " + "a very long hook that goes on and on about this old project and its many details ".repeat(4) + "\n");
  fs.writeFileSync(path.join(dir, "old-project.md"), `---\ntitle: Old project\ntheme: projects\n---\n## Old plan\n${fill("Plan")}\n\n## Old rules\n${fill("Rule")}\n`);
  const big = "x".repeat(30000);
  fs.writeFileSync(path.join(dir, "big-note.md"), `---\ntitle: Big note\ntheme: knowledge\n---\n## Part one\n${big}\n\n## Part two\n${big}\n`);
  return dir;
}

function buildContext(dir, dataDir, now) {
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 0 });
  memory.scan();
  return { config, memory, now };
}

/** Pre-populates the activity counters so the archive tier has "enough data" and the old-project
 * note counts as dormant (never read/searched/written inside the window, started long ago). */
function ageCounters(dataDir, now) {
  const c = createCounters({ dir: dataDir, now: () => now - 200 * DAY });
  c.add({ type: "read", ids: ["big-note"], t: now - 200 * DAY }); // keeps big-note "recently read" irrelevant to split, but exercises the counters file
  c.flush();
}

// ------------------------------------------------------------------ computeMaintenance: detection

test("computeMaintenance: archive + split + indexTrim items, ranked by gainTokens, stable ids", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-data-");
  ageCounters(dataDir, NOW);
  const { config, memory } = buildContext(dir, dataDir, NOW);
  const r1 = M.computeMaintenance({ memory, config, dataDir, now: NOW });
  assert.ok(r1.items.length >= 2, "at least a split and an indexTrim item");
  const kinds = r1.items.map((i) => i.kind);
  assert.ok(kinds.includes("split"), "big-note is over the large-note threshold");
  assert.ok(kinds.includes("indexTrim"), "the index has a long hook with no description on its target");
  // Ranked by gain, descending (ties broken by id).
  for (let i = 1; i < r1.items.length; i++) assert.ok(r1.items[i - 1].gainTokens >= r1.items[i].gainTokens, "ranked by gain");
  // Stable ids: a second, independent computation gives the exact same ids (same kind + target).
  const { memory: memory2 } = buildContext(dir, dataDir, NOW);
  const r2 = M.computeMaintenance({ memory: memory2, config, dataDir, now: NOW + 1000 });
  assert.deepStrictEqual(r1.items.map((i) => i.id).sort(), r2.items.map((i) => i.id).sort(), "same inputs: same ids");
  // Every id is a hash of kind + target (lib/maintenance.js's own convention).
  for (const it of r1.items) assert.strictEqual(it.id, M.itemId(it.kind, it.target));
});

test("computeMaintenance: readOnly never touches the data folder (mcp-server's own use)", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-data-");
  ageCounters(dataDir, NOW);
  const before = fs.readdirSync(dataDir).sort();
  const { config, memory } = buildContext(dir, dataDir, NOW);
  M.computeMaintenance({ memory, config, dataDir, now: NOW, readOnly: true });
  assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), before, "readOnly: nothing written to the data folder");
});

test("computeMaintenance: never writes a note (snapshot of the notes folder, before and after)", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-data-");
  ageCounters(dataDir, NOW);
  const snap = () => fs.readdirSync(dir).sort().map((f) => {
    const full = path.join(dir, f);
    return [f, fs.statSync(full).mtimeMs, fs.readFileSync(full, "utf8")];
  });
  const before = snap();
  const { config, memory } = buildContext(dir, dataDir, NOW);
  M.computeMaintenance({ memory, config, dataDir, now: NOW });
  M.computeMaintenance({ memory, config, dataDir, now: NOW, readOnly: true });
  assert.deepStrictEqual(snap(), before, "no note file changed");
});

test("computeMaintenance: no largeNoteTokens/indexTrim data: an empty memory gives no item, no throw", () => {
  const dir = tmp("memglow-maint-empty-");
  const dataDir = tmp("memglow-maint-data-");
  const { config, memory } = buildContext(dir, dataDir, NOW);
  const r = M.computeMaintenance({ memory, config, dataDir, now: NOW });
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.generatedAt, NOW);
});

// ------------------------------------------------------------------ store: dismiss persistence

test("createMaintenanceStore: write() filters dismissed ids; dismiss() persists across reloads", () => {
  const dataDir = tmp("memglow-maint-store-");
  const store = M.createMaintenanceStore({ dir: dataDir });
  const items = [
    { id: "split-aaaaaaaaaaaaaaaa", kind: "split", title: "A", why: "", gainTokens: 10, target: "a" },
    { id: "split-bbbbbbbbbbbbbbbb", kind: "split", title: "B", why: "", gainTokens: 20, target: "b" },
  ];
  store.write({ generatedAt: NOW, items });
  assert.strictEqual(store.read().items.length, 2);
  store.dismiss(items[0].id);
  assert.deepStrictEqual(store.read().items.map((i) => i.id), [items[1].id], "dismissed id removed right away");
  // A fresh store instance (simulating a restart) still has it dismissed, and a rescan excludes it.
  const reloaded = M.createMaintenanceStore({ dir: dataDir });
  assert.ok(reloaded.dismissedIds().has(items[0].id));
  reloaded.write({ generatedAt: NOW + 1, items });
  assert.deepStrictEqual(reloaded.read().items.map((i) => i.id), [items[1].id], "a rescan never brings a dismissed item back");
});

test("createMaintenanceStore: survives a missing/corrupt data folder (in-memory only, never throws)", () => {
  const store = M.createMaintenanceStore({ dir: null });
  assert.deepStrictEqual(store.read(), { generatedAt: null, items: [] });
  store.write({ generatedAt: NOW, items: [{ id: "x-0000000000000000", kind: "split", title: "t", why: "", gainTokens: 1, target: "t" }] });
  assert.strictEqual(store.read().items.length, 1);
  store.dismiss("x-0000000000000000");
  assert.strictEqual(store.read().items.length, 0);
});

// ------------------------------------------------------------------ scheduler: injectable timer

test("createScheduler: runs once at start; schedules a repeat only when everyHours > 0 (injectable timer)", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-sched-");
  const { config, memory } = buildContext(dir, dataDir, NOW);
  const store = M.createMaintenanceStore({ dir: dataDir });
  const scheduled = [];
  const setIntervalFn = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  const cleared = [];
  const clearIntervalFn = (id) => cleared.push(id);
  const sched = M.createScheduler({ memory, config, dataDir, everyHours: 1, store, now: () => NOW, setIntervalFn, clearIntervalFn });
  sched.start();
  assert.ok(store.read().generatedAt, "the start-up scan ran right away, synchronously");
  assert.strictEqual(scheduled.length, 1, "one repeat scheduled");
  assert.strictEqual(scheduled[0].ms, 3600 * 1000);
  sched.stop();
  assert.deepStrictEqual(cleared, [1]);
});

test("createScheduler: everyHours 0 still runs once at start, but schedules no repeat", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-sched0-");
  const { config, memory } = buildContext(dir, dataDir, NOW);
  const store = M.createMaintenanceStore({ dir: dataDir });
  let calls = 0;
  const setIntervalFn = () => { calls++; return 1; };
  const sched = M.createScheduler({ memory, config, dataDir, everyHours: 0, store, now: () => NOW, setIntervalFn, clearIntervalFn: () => {} });
  sched.start();
  assert.ok(store.read().generatedAt, "ran once");
  assert.strictEqual(calls, 0, "no repeat scheduled");
});

test("createScheduler: a firing tick rescans and keeps dismissed items out", () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-sched2-");
  const { config, memory } = buildContext(dir, dataDir, NOW);
  const store = M.createMaintenanceStore({ dir: dataDir });
  let tick = null;
  const sched = M.createScheduler({ memory, config, dataDir, everyHours: 1, store, now: () => NOW, setIntervalFn: (fn) => { tick = fn; return 1; }, clearIntervalFn: () => {} });
  sched.start();
  const id = store.read().items[0].id;
  store.dismiss(id);
  assert.ok(typeof tick === "function");
  tick(); // simulate the interval firing
  assert.ok(!store.read().items.some((i) => i.id === id), "dismissed item stays dismissed across a rescan");
});

// ------------------------------------------------------------------ HTTP endpoints

function startServer(dir, dataDir) {
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test("GET /api/maintenance; POST /api/maintenance/dismiss (CSRF, validation, persistence)", async () => {
  const dir = buildFixture();
  const dataDir = tmp("memglow-maint-http-");
  const { server, base } = await startServer(dir, dataDir);
  try {
    const r = await (await fetch(base + "/api/maintenance")).json();
    assert.ok(Array.isArray(r.items) && r.items.length > 0);
    const id = r.items[0].id;

    // No CSRF header: refused, nothing changes.
    const noHeader = await fetch(base + "/api/maintenance/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    assert.strictEqual(noHeader.status, 403);

    // Bad id shape: refused.
    const bad = await fetch(base + "/api/maintenance/dismiss", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Memglow": "1", Origin: base }, body: JSON.stringify({ id: "nope" }),
    });
    assert.strictEqual(bad.status, 400);

    // Proper request: dismissed, and GET reflects it right away.
    const ok1 = await fetch(base + "/api/maintenance/dismiss", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Memglow": "1", Origin: base }, body: JSON.stringify({ id }),
    });
    assert.strictEqual(ok1.status, 200);
    const after = await (await fetch(base + "/api/maintenance")).json();
    assert.ok(!after.items.some((i) => i.id === id));

    // Persists on disk.
    assert.ok(fs.existsSync(path.join(dataDir, M.DISMISSED_FILE)));
  } finally { server.close(); }
});
