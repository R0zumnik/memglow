"use strict";
// lib/verdict-cache.js — the generic content-hash-keyed verdict cache shared by
// auto-archive/auto-duplicates/star-audit (0.5.5).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVerdictCache, sha1 } = require("../lib/verdict-cache");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-verdict-cache-")); }

test("get/set round-trip, persists to disk atomically, mode 600", () => {
  const dir = tmpDir();
  try {
    const c = createVerdictCache({ dataDir: dir, file: "x.json" });
    assert.strictEqual(c.get("k"), undefined);
    c.set("k", { action: "keep" });
    assert.deepStrictEqual(c.get("k"), { action: "keep" });
    c.flush();
    const file = path.join(dir, "x.json");
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(raw.entries.k.v, { action: "keep" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a fresh cache re-reads a previously flushed file (survives a restart)", () => {
  const dir = tmpDir();
  try {
    const c1 = createVerdictCache({ dataDir: dir, file: "x.json" });
    c1.set("k", "left");
    c1.flush();
    const c2 = createVerdictCache({ dataDir: dir, file: "x.json" });
    assert.strictEqual(c2.get("k"), "left");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("key() hashes its parts together; order-sensitive (callers sort first for an unordered pair)", () => {
  const c = createVerdictCache({});
  assert.strictEqual(c.key("a", "b"), c.key("a", "b"));
  assert.notStrictEqual(c.key("a", "b"), c.key("b", "a"));
  assert.strictEqual(c.key("a", "b"), sha1("a\0b"));
});

test("without dataDir: still cached for this process's own lifetime (in-memory), but never written to disk, never throws", () => {
  const c = createVerdictCache({});
  c.set("k", "v");
  assert.strictEqual(c.get("k"), "v", "in-memory caching still helps within one process run");
  c.flush(); // a no-op: no file path, nothing to write
});

test("bounded to max, oldest (by set time) dropped first", () => {
  let t = 0;
  const c = createVerdictCache({ max: 3, now: () => t });
  for (let i = 0; i < 5; i++) { t = i; c.set("k" + i, i); }
  assert.strictEqual(c.size(), 3);
  assert.strictEqual(c.get("k0"), undefined);
  assert.strictEqual(c.get("k1"), undefined);
  assert.strictEqual(c.get("k4"), 4);
});

test("a malformed or missing file on disk is treated as empty, never throws", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "x.json"), "{not json");
    const c = createVerdictCache({ dataDir: dir, file: "x.json" });
    assert.strictEqual(c.size(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("0.5.5 bug fix: set() writes to disk SYNCHRONOUSLY — the file is correct immediately, with no flush() call at all (robust against an abrupt process exit)", () => {
  const dir = tmpDir();
  try {
    const c = createVerdictCache({ dataDir: dir, file: "x.json" });
    c.set("k", "left");
    // No flush() here on purpose.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "x.json"), "utf8"));
    assert.strictEqual(raw.entries.k.v, "left");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
