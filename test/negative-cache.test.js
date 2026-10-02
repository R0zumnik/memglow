"use strict";
// Lever 11 (negativeCache, 0.4.2.6 "negative cache + the index already answers") —
// lib/negative-cache.js. Pure pieces (normalizedKey, memoryFingerprint, recordFutileEntries,
// lookupFutileEntry, forgetStaleEntries) plus the one fs-touching wrapper
// (createNegativeCacheStore): atomic write, bounded size, mode 600, invalidation on write.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const NC = require("../lib/negative-cache");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-negcache-")); }

test("normalizedKey: order-independent, sorted and joined; non-array -> empty string", () => {
  assert.strictEqual(NC.normalizedKey(["broker", "reconnect"]), "broker reconnect");
  assert.strictEqual(NC.normalizedKey(["reconnect", "broker"]), "broker reconnect", "same key regardless of order");
  assert.strictEqual(NC.normalizedKey([]), "");
  assert.strictEqual(NC.normalizedKey(null), "");
});

test("memoryFingerprint: note count + latest mtime; missing/non-numeric mtime treated as 0", () => {
  assert.strictEqual(NC.memoryFingerprint([{ mtime: 10 }, { mtime: 30 }, { mtime: 20 }]), "3:30");
  assert.strictEqual(NC.memoryFingerprint([]), "0:0");
  assert.strictEqual(NC.memoryFingerprint([{}, { mtime: "x" }]), "2:0");
  assert.strictEqual(NC.memoryFingerprint(null), "0:0");
  // A new note bumps the count even if its mtime isn't the largest; a changed note's later
  // mtime bumps the fingerprint even if the count stays the same — both are "invalidate on write".
  const before = NC.memoryFingerprint([{ mtime: 10 }, { mtime: 20 }]);
  assert.notStrictEqual(NC.memoryFingerprint([{ mtime: 10 }, { mtime: 20 }, { mtime: 5 }]), before, "count changed");
  assert.notStrictEqual(NC.memoryFingerprint([{ mtime: 10 }, { mtime: 99 }]), before, "latest mtime changed");
});

test("recordFutileEntries: new entry, overwritten by the same normalized key regardless of word order, no-op on nothing to record", () => {
  let entries = NC.recordFutileEntries([], { words: ["broker", "reconnect"], fingerprint: "1:100", now: 1 });
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0], { words: ["broker", "reconnect"], fingerprint: "1:100", last: 1 });

  // Same normalized key (reordered words) overwrites in place, does not duplicate.
  entries = NC.recordFutileEntries(entries, { words: ["reconnect", "broker"], fingerprint: "2:200", now: 2 });
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].fingerprint, "2:200");
  assert.strictEqual(entries[0].last, 2);

  const same = NC.recordFutileEntries(entries, { words: [], fingerprint: "3:300" });
  assert.strictEqual(same, entries, "no words: same array reference");
  const same2 = NC.recordFutileEntries(entries, { words: ["x"], fingerprint: "" });
  assert.strictEqual(same2, entries, "no fingerprint: same array reference");
});

test("recordFutileEntries: bounded — oldest (by `last`) dropped first once over `max`", () => {
  let entries = [];
  for (let i = 0; i < 5; i++) entries = NC.recordFutileEntries(entries, { words: ["w" + i], fingerprint: "f", now: i, max: 3 });
  assert.strictEqual(entries.length, 3);
  assert.deepStrictEqual(entries.map((e) => e.words[0]).sort(), ["w2", "w3", "w4"]);
});

test("lookupFutileEntry: matches only when BOTH the normalized key AND the fingerprint match — 'the memory has not changed since'", () => {
  const entries = [{ words: ["broker", "reconnect"], fingerprint: "1:100", last: 5 }];
  assert.deepStrictEqual(NC.lookupFutileEntry(entries, ["reconnect", "broker"], "1:100"), entries[0], "same words, any order, same fingerprint: matched");
  assert.strictEqual(NC.lookupFutileEntry(entries, ["broker", "reconnect"], "1:101"), null, "fingerprint changed: never surfaced");
  assert.strictEqual(NC.lookupFutileEntry(entries, ["broker"], "1:100"), null, "different word set: no match");
  assert.strictEqual(NC.lookupFutileEntry(entries, [], "1:100"), null);
  assert.strictEqual(NC.lookupFutileEntry([], ["broker", "reconnect"], "1:100"), null);
});

test("forgetStaleEntries: drops every entry whose fingerprint no longer matches — invalidate on any write (global, not per-note)", () => {
  const entries = [
    { words: ["a"], fingerprint: "1:100", last: 1 },
    { words: ["b"], fingerprint: "1:100", last: 2 },
    { words: ["c"], fingerprint: "1:999", last: 3 },
  ];
  const kept = NC.forgetStaleEntries(entries, "1:100");
  assert.deepStrictEqual(kept.map((e) => e.words[0]), ["a", "b"], "only the matching fingerprint survives");
  const same = NC.forgetStaleEntries(kept, "1:100");
  assert.strictEqual(same, kept, "nothing changed: same array reference");
  assert.strictEqual(NC.forgetStaleEntries(entries, ""), entries, "no fingerprint given: unchanged");
});

test("createNegativeCacheStore: disabled without a data folder, or with the switch off — available() false, never throws", () => {
  const off1 = NC.createNegativeCacheStore({ dataDir: null, negativeCache: true });
  assert.strictEqual(off1.available(), false);
  off1.recordFutile(["a"], "1:1");
  assert.strictEqual(off1.lookup(["a"], "1:1"), null);

  const dir = tmpDir();
  try {
    const off2 = NC.createNegativeCacheStore({ dataDir: dir, negativeCache: false });
    assert.strictEqual(off2.available(), false);
    off2.recordFutile(["a"], "1:1");
    off2.flush();
    assert.ok(!fs.existsSync(path.join(dir, "negative-cache.json")), "switch off: nothing written at all");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createNegativeCacheStore: records, looks up (keep results — this never hides anything, it is purely additive at the call site), persists atomically, mode 600, bounded", () => {
  const dir = tmpDir();
  try {
    const store = NC.createNegativeCacheStore({ dataDir: dir, negativeCache: true, negativeCacheMax: 3 });
    assert.strictEqual(store.lookup(["broker", "reconnect"], "1:100"), null, "nothing recorded yet");
    store.recordFutile(["broker", "reconnect"], "1:100");
    const hit = store.lookup(["reconnect", "broker"], "1:100");
    assert.ok(hit && Number.isFinite(hit.last), "found by its normalized key, any word order");

    for (let i = 0; i < 5; i++) store.recordFutile(["w" + i], "1:100");
    store.flush();
    const file = path.join(dir, "negative-cache.json");
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.version, 1);
    assert.strictEqual(raw.entries.length, 3, "bounded to negativeCacheMax");
    assert.ok(!fs.existsSync(file + "." + process.pid + ".tmp"), "temp file renamed away, not left behind");

    // Re-reading from a fresh store picks up what was persisted.
    const reread = NC.createNegativeCacheStore({ dataDir: dir, negativeCache: true });
    assert.strictEqual(reread.size(), 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createNegativeCacheStore: invalidation on write — a fingerprint change (any write, anywhere) drops EVERY entry, not just the one note that changed", () => {
  const dir = tmpDir();
  try {
    const store = NC.createNegativeCacheStore({ dataDir: dir, negativeCache: true });
    store.recordFutile(["broker", "reconnect"], "3:100");
    store.recordFutile(["unrelated", "query"], "3:100");
    assert.ok(store.lookup(["broker", "reconnect"], "3:100"));
    assert.ok(store.lookup(["unrelated", "query"], "3:100"));

    // A write anywhere bumps the fingerprint (lib/proxy-levers.js computes it from note count +
    // latest mtime) — looked up again under the NEW fingerprint, neither is surfaced.
    assert.strictEqual(store.lookup(["broker", "reconnect"], "3:200"), null);
    assert.strictEqual(store.lookup(["unrelated", "query"], "3:200"), null);

    // forgetStale (called opportunistically on every search/write in lib/proxy-levers.js) prunes
    // the now-stale entries outright, rather than just silently failing to match forever.
    store.forgetStale("3:200");
    store.flush();
    assert.strictEqual(store.size(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createNegativeCacheStore: a malformed or missing file on disk is treated as empty, never throws", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "negative-cache.json"), "{not json");
    const store = NC.createNegativeCacheStore({ dataDir: dir, negativeCache: true });
    assert.strictEqual(store.size(), 0);
    assert.strictEqual(store.lookup(["anything"], "1:1"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
