"use strict";
// Lever 10 (aliases, 0.4.2.3 "query log" + 0.4.2.4 "learned aliases") — lib/learned-aliases.js.
// Pure pieces (significantWords, maskedQuery, learnEntries, matchAlias, forgetMissing) plus the
// one fs-touching wrapper (createAliasStore): atomic write, bounded size, mode 600, independent
// learnAliases/aliases switches, forgetting a deleted note's aliases.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const LA = require("../lib/learned-aliases");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aliases-")); }

test("significantWords: lowercased, stop-words (EN + FR) dropped, < 3 letters dropped, deduped, order kept", () => {
  assert.deepStrictEqual(LA.significantWords("Broker Reconnect Settings"), ["broker", "reconnect", "settings"]);
  assert.deepStrictEqual(LA.significantWords("the quick and the dirty fox"), ["quick", "dirty", "fox"]);
  assert.deepStrictEqual(LA.significantWords("avec les conventions de commit"), ["conventions", "commit"]);
  assert.deepStrictEqual(LA.significantWords("a an id ok go"), [], "every token under 3 letters is dropped");
  assert.deepStrictEqual(LA.significantWords("broker broker RECONNECT reconnect"), ["broker", "reconnect"], "deduped, case-insensitive");
  assert.deepStrictEqual(LA.significantWords(""), []);
  assert.deepStrictEqual(LA.significantWords(null), []);
});

test("significantWords: a secret-looking line is masked BEFORE extraction (never becomes a word)", () => {
  // maskSecrets (lib/memory.js) masks a whole LINE that looks like a secret — so the secret line
  // and the ordinary query text are kept on separate lines here, the way a multi-line paste would.
  const words = LA.significantWords("api_key: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nbroker settings");
  assert.ok(!words.some((w) => w.includes("sk")), "no fragment of the token leaks through");
  assert.ok(words.includes("broker") && words.includes("settings"));
});

test("maskedQuery: masked, whitespace-collapsed, capped", () => {
  assert.strictEqual(LA.maskedQuery("  broker   reconnect  "), "broker reconnect");
  const long = "word ".repeat(100).trim();
  const out = LA.maskedQuery(long, 20);
  assert.strictEqual(out.length, 20);
  assert.ok(out.endsWith("…"));
  assert.strictEqual(LA.maskedQuery(""), "");
});

test("learnEntries: increments an existing (word, note) pair, appends a new one, no-op on nothing to learn", () => {
  let entries = LA.learnEntries([], { note: "n1", words: ["broker", "reconnect"], now: 1 });
  assert.deepStrictEqual(entries.map((e) => [e.word, e.note, e.count, e.last]).sort(), [["broker", "n1", 1, 1], ["reconnect", "n1", 1, 1]].sort());
  entries = LA.learnEntries(entries, { note: "n1", words: ["broker"], now: 2 });
  const broker = entries.find((e) => e.word === "broker" && e.note === "n1");
  assert.strictEqual(broker.count, 2);
  assert.strictEqual(broker.last, 2);
  const same = LA.learnEntries(entries, { note: "", words: ["x"] });
  assert.strictEqual(same, entries, "no note: same array reference");
  const same2 = LA.learnEntries(entries, { note: "n1", words: [] });
  assert.strictEqual(same2, entries, "no words: same array reference");
});

test("learnEntries: bounded — oldest (by `last`) dropped first once over `max`", () => {
  let entries = [];
  for (let i = 0; i < 5; i++) entries = LA.learnEntries(entries, { note: "n" + i, words: ["w" + i], now: i, max: 3 });
  assert.strictEqual(entries.length, 3);
  // the 3 most recent (now=2,3,4) survive; the 2 oldest (now=0,1) are gone
  assert.deepStrictEqual(entries.map((e) => e.note).sort(), ["n2", "n3", "n4"]);
});

test("matchAlias: qualifies at >= 2 matched distinct aliases, OR 1 alias seen >= 2 times — not at 1 alias seen once", () => {
  const entries = [
    { word: "broker", note: "mqtt", count: 1, last: 1 },
    { word: "reconnect", note: "mqtt", count: 1, last: 2 },
    { word: "conventions", note: "git", count: 2, last: 3 },
  ];
  assert.strictEqual(LA.matchAlias(entries, { words: ["broker", "reconnect", "today"] }), "mqtt", "2 distinct matched aliases");
  assert.strictEqual(LA.matchAlias(entries, { words: ["broker"] }), null, "1 alias, seen once: not enough");
  assert.strictEqual(LA.matchAlias(entries, { words: ["conventions", "walkthrough"] }), "git", "1 alias, seen >= 2 times: enough");
  assert.strictEqual(LA.matchAlias(entries, { words: [] }), null);
  assert.strictEqual(LA.matchAlias([], { words: ["broker", "reconnect"] }), null);
});

test("matchAlias: excludes notes already in the results, and notes `noteExists` rejects; deterministic tie-break", () => {
  const entries = [
    { word: "broker", note: "mqtt", count: 1, last: 1 },
    { word: "reconnect", note: "mqtt", count: 1, last: 1 },
    { word: "broker", note: "other", count: 1, last: 1 },
    { word: "reconnect", note: "other", count: 1, last: 1 },
  ];
  assert.strictEqual(LA.matchAlias(entries, { words: ["broker", "reconnect"], exclude: new Set(["mqtt"]) }), "other");
  assert.strictEqual(LA.matchAlias(entries, { words: ["broker", "reconnect"], noteExists: (n) => n !== "mqtt" }), "other");
  // Both tied (2 matched, maxCount 1 each): the lexicographically smaller note id wins, deterministically.
  assert.strictEqual(LA.matchAlias(entries, { words: ["broker", "reconnect"] }), "mqtt");
});

test("forgetMissing: drops entries for notes that no longer exist; same array reference when nothing changes", () => {
  const entries = [{ word: "a", note: "n1", count: 1, last: 1 }, { word: "b", note: "n2", count: 1, last: 1 }];
  const kept = LA.forgetMissing(entries, (n) => n === "n1");
  assert.deepStrictEqual(kept.map((e) => e.note), ["n1"]);
  const same = LA.forgetMissing(kept, () => true);
  assert.strictEqual(same, kept);
  assert.strictEqual(LA.forgetMissing(entries, null), entries, "not a function: unchanged");
});

test("createAliasStore: learn() is a no-op unless learnAliases is on; match() is a no-op unless aliases is on; independent", () => {
  const dir = tmpDir();
  try {
    const learnOnly = LA.createAliasStore({ dataDir: dir, learnAliases: true, aliases: false });
    learnOnly.learn("mqtt", ["broker", "reconnect"]);
    learnOnly.flush();
    assert.strictEqual(learnOnly.match(["broker", "reconnect"]), null, "aliases off: never surfaces what was learned");
    // A second store, aliases-only, reads what the first one persisted and CAN surface it.
    const useOnly = LA.createAliasStore({ dataDir: dir, learnAliases: false, aliases: true });
    assert.strictEqual(useOnly.match(["broker", "reconnect"]), "mqtt");
    useOnly.learn("mqtt", ["extra"]);
    useOnly.flush();
    const reread = LA.createAliasStore({ dataDir: dir, learnAliases: true, aliases: true });
    assert.strictEqual(reread.match(["extra"]), null, "learnAliases off on the use-only store: nothing new was recorded");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createAliasStore: disabled entirely without a data folder, or with both switches off — available() false, never throws", () => {
  const off = LA.createAliasStore({ dataDir: null, learnAliases: true, aliases: true });
  assert.strictEqual(off.available(), false);
  off.learn("n", ["a", "b"]);
  assert.strictEqual(off.match(["a", "b"]), null);
  const dir = tmpDir();
  try {
    const bothOff = LA.createAliasStore({ dataDir: dir, learnAliases: false, aliases: false });
    assert.strictEqual(bothOff.available(), false);
    bothOff.learn("n", ["a", "b"]);
    bothOff.flush();
    assert.ok(!fs.existsSync(path.join(dir, "learned-aliases.json")), "nothing written: neither switch asked for the store");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createAliasStore: atomic write, mode 600, bounded to `aliasesMax`, forgets a deleted note's aliases", () => {
  const dir = tmpDir();
  try {
    const store = LA.createAliasStore({ dataDir: dir, learnAliases: true, aliases: true, aliasesMax: 3 });
    for (let i = 0; i < 5; i++) store.learn("note" + i, ["word" + i]);
    store.flush();
    const file = path.join(dir, "learned-aliases.json");
    assert.ok(fs.existsSync(file));
    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.version, 1);
    assert.strictEqual(raw.entries.length, 3, "bounded to aliasesMax");
    assert.ok(!fs.existsSync(file + "." + process.pid + ".tmp"), "temp file renamed away, not left behind");

    // "Forget an alias whose note no longer exists": forgetMissing + flush rewrites the file.
    const survivors = new Set(raw.entries.map((e) => e.note)).size;
    store.forgetMissing(() => false); // every note "deleted"
    store.flush();
    const raw2 = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw2.entries.length, 0, `all ${survivors} remaining entries forgotten`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createAliasStore: a malformed or missing file on disk is treated as empty, never throws", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "learned-aliases.json"), "{not json");
    const store = LA.createAliasStore({ dataDir: dir, learnAliases: true, aliases: true });
    assert.strictEqual(store.size(), 0);
    assert.strictEqual(store.match(["anything", "words"]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ 0.5.5 (E — usage-aware search)

test("computeUsageBoosts: decays over halfLifeDays, sums matching words per note, capped", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const entries = [
    { word: "broker", note: "note-a", count: 1, last: now }, // today: full weight
    { word: "reconnect", note: "note-a", count: 1, last: now - 30 * 86400000 }, // one half-life: half weight
    { word: "unrelated", note: "note-b", count: 100, last: now }, // never matched: note-b absent
  ];
  const boosts = LA.computeUsageBoosts(entries, { words: ["broker", "reconnect"], now, halfLifeDays: 30, cap: 10 });
  assert.ok(boosts.has("note-a"));
  assert.ok(!boosts.has("note-b"), "a note with no matching word is simply absent, never a zero entry");
  assert.ok(Math.abs(boosts.get("note-a") - 1.5) < 0.01, `expected ≈1.5 (1 + 0.5), got ${boosts.get("note-a")}`);
});

test("computeUsageBoosts: capped — a huge learned count never produces an unbounded boost", () => {
  const now = Date.now();
  const entries = [{ word: "broker", note: "note-a", count: 10000, last: now }];
  const boosts = LA.computeUsageBoosts(entries, { words: ["broker"], now, cap: 1 });
  assert.strictEqual(boosts.get("note-a"), 1);
});

test("computeUsageBoosts: no words, no entries, or no match at all → an empty Map, never throws", () => {
  assert.strictEqual(LA.computeUsageBoosts([], { words: ["x"] }).size, 0);
  assert.strictEqual(LA.computeUsageBoosts([{ word: "x", note: "n", count: 1, last: Date.now() }], { words: [] }).size, 0);
  assert.strictEqual(LA.computeUsageBoosts(null, { words: ["x"] }).size, 0);
});

test("usageBoostSettings: enabled by default (a true no-op without data — see createAliasStore.usageBoosts), env/config can force it off", () => {
  assert.strictEqual(LA.usageBoostSettings({}, {}).enabled, true);
  assert.strictEqual(LA.usageBoostSettings({ enabled: false }, {}).enabled, false);
  assert.strictEqual(LA.usageBoostSettings({}, { MEMGLOW_SEARCH_USAGE_BOOST: "0" }).enabled, false);
  assert.strictEqual(LA.usageBoostSettings({ enabled: false }, { MEMGLOW_SEARCH_USAGE_BOOST: "1" }).enabled, true, "env wins");
  assert.strictEqual(LA.usageBoostSettings({}, {}).halfLifeDays, LA.USAGE_BOOST_HALF_LIFE_DAYS_DEFAULT);
  assert.strictEqual(LA.usageBoostSettings({}, {}).cap, LA.USAGE_BOOST_CAP_DEFAULT);
});

test("createAliasStore.usageBoosts: read-only (learnAliases/aliases both false), gated by cfg.usageBoost, empty store is a true no-op", () => {
  const dir = tmpDir();
  try {
    const writer = LA.createAliasStore({ dataDir: dir, learnAliases: true, aliases: false });
    writer.learn("note-a", ["broker", "reconnect"]);
    writer.flush();

    // A reader that never learns/injects, only reads, from the SAME data folder.
    const reader = LA.createAliasStore({ dataDir: dir, learnAliases: false, aliases: false, usageBoost: true });
    assert.ok(reader.available());
    const boosts = reader.usageBoosts(["broker"]);
    assert.ok(boosts.get("note-a") > 0);

    // cfg.usageBoost off: always an empty Map, never throws.
    const off = LA.createAliasStore({ dataDir: dir, learnAliases: false, aliases: false, usageBoost: false });
    assert.strictEqual(off.usageBoosts(["broker"]).size, 0);

    // A fresh install (no file at all yet): a true no-op.
    const dir2 = tmpDir();
    try {
      const empty = LA.createAliasStore({ dataDir: dir2, usageBoost: true });
      assert.strictEqual(empty.usageBoosts(["broker"]).size, 0);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
