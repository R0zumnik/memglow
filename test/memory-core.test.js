"use strict";
// Per-project core loading (lib/memory-core.js): matching order (coreMap > frontmatter > word
// match > caller's top-read fallback), budget truncation, and config/env reading. Pure unit
// tests on matchHub()/buildMemoryCore() directly — the memory-server tool-level wiring
// (memory_core / memory_index_level) is covered by test/memory-server-core.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const MC = require("../lib/memory-core");
const { parseIndexTree } = require("../lib/index-tree");

const INDEX = [
  "## Work",
  "- [[hub-acme]] — Acme project hub",
  "- [[note-standalone]] — a standalone note",
  "## Home",
  "- [[hub-nas]] — Home NAS hub",
].join("\n");

function fixture() {
  const tree = parseIndexTree(INDEX);
  const entries = tree.groups.flatMap((g) => g.entries);
  const notesById = new Map([
    ["hub-acme", { title: "Acme Storefront", description: "e-commerce rebuild", frontmatter: { project_paths: ["/home/x/work/acme/*"], repo: "acme-storefront" }, raw: "hub-acme note body" }],
    ["hub-nas", { title: "NAS project", description: "home lab NAS", frontmatter: {}, raw: "hub-nas note body" }],
    ["note-standalone", { title: "Standalone", description: "", frontmatter: {}, raw: "standalone body" }],
  ]);
  return { tree, entries, notesById };
}

// ---------------------------------------------------------------------------------------------
// matchHub(): order of precedence

test("matchHub: tier 1, coreMap wins outright, even over a frontmatter/word match that would otherwise fire", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({
    cwd: "/home/x/work/acme/storefront",
    coreMap: { "/home/x/work/acme/*": "hub-nas" }, // deliberately a DIFFERENT hub than frontmatter/words would pick
    entries, notesById,
  });
  assert.deepStrictEqual(r, { hubIds: ["hub-nas"], matchedBy: "coreMap" });
});

test("matchHub: tier 2, frontmatter project_paths (glob) when no coreMap matches", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/home/x/work/acme/storefront", coreMap: {}, entries, notesById });
  assert.deepStrictEqual(r, { hubIds: ["hub-acme"], matchedBy: "frontmatter" });
});

test("matchHub: tier 2, frontmatter repo: hint, matched against a project hint (not cwd)", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/somewhere/unrelated", projectHints: ["git@github.com:me/acme-storefront.git"], coreMap: {}, entries, notesById });
  assert.strictEqual(r.matchedBy, "frontmatter");
  assert.deepStrictEqual(r.hubIds, ["hub-acme"]);
});

test("matchHub: tier 3, word match on the cwd's own folder name when nothing else matches", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/home/x/projects/nas-homelab", coreMap: {}, entries, notesById });
  assert.strictEqual(r.matchedBy, "words");
  assert.deepStrictEqual(r.hubIds, ["hub-nas"]);
});

test("matchHub: no match at all → empty hubIds, matchedBy 'none'", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/var/tmp/completely-unrelated-zzz", coreMap: {}, entries, notesById });
  assert.deepStrictEqual(r, { hubIds: [], matchedBy: "none" });
});

test("matchHub: coreMap and frontmatter project_paths both accept a leading \"~\" (home folder), like lib/always-loaded.js's alwaysLoaded entries", () => {
  const home = os.homedir();
  const tree = parseIndexTree(INDEX);
  const entries = tree.groups.flatMap((g) => g.entries);
  const notesById = new Map([["hub-acme", { title: "Acme", frontmatter: { project_paths: ["~/work/acme/*"] } }]]);
  const cwd = path.join(home, "work", "acme", "storefront");
  const r1 = MC.matchHub({ cwd, coreMap: {}, entries, notesById });
  assert.deepStrictEqual(r1, { hubIds: ["hub-acme"], matchedBy: "frontmatter" });
  const r2 = MC.matchHub({ cwd, coreMap: { "~/work/acme/*": "hub-acme" }, entries, notesById: new Map() });
  assert.deepStrictEqual(r2, { hubIds: ["hub-acme"], matchedBy: "coreMap" });
});

test("matchHub: a bad coreMap glob is skipped, not thrown, and matching falls through to the next tier", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/home/x/work/acme/storefront", coreMap: { "[": "hub-nas" }, entries, notesById });
  assert.strictEqual(r.matchedBy, "frontmatter");
});

// ---------------------------------------------------------------------------------------------
// sanitizeCoreMap / readCoreMap

test("sanitizeCoreMap: keeps only string→slug-shaped entries, drops the rest, caps the count", () => {
  assert.deepStrictEqual(MC.sanitizeCoreMap(null), {});
  assert.deepStrictEqual(MC.sanitizeCoreMap({ "/a/*": "hub-a", bad1: 42, bad2: "has spaces!", "": "hub-x" }), { "/a/*": "hub-a" });
  const many = {};
  for (let i = 0; i < MC.CORE_MAP_MAX_ENTRIES + 20; i++) many["/p" + i + "/*"] = "hub-" + i;
  assert.strictEqual(Object.keys(MC.sanitizeCoreMap(many)).length, MC.CORE_MAP_MAX_ENTRIES);
});

test("readCoreMap: MEMGLOW_MEMORY_CORE_MAP (JSON env) wins over the config file", () => {
  const r = MC.readCoreMap({ MEMGLOW_MEMORY_CORE_MAP: JSON.stringify({ "/x/*": "hub-x" }) }, "/tmp");
  assert.deepStrictEqual(r, { "/x/*": "hub-x" });
});

test("readCoreMap: malformed env JSON falls through to {} (never throws)", () => {
  const r = MC.readCoreMap({ MEMGLOW_MEMORY_CORE_MAP: "not json", MEMGLOW_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "memglow-coremap-")) }, "/tmp");
  assert.deepStrictEqual(r, {});
});

test("readCoreMap: reads memglow.config.json's coreMap key via MEMGLOW_CONFIG (never a ./memglow.config.json in the notes folder)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-coremap-cfg-"));
  const file = path.join(dir, "memglow.config.json");
  fs.writeFileSync(file, JSON.stringify({ coreMap: { "/y/*": "hub-y" } }));
  const r = MC.readCoreMap({ MEMGLOW_CONFIG: file }, "/tmp");
  assert.deepStrictEqual(r, { "/y/*": "hub-y" });
});

// ---------------------------------------------------------------------------------------------
// truncateToBudget / buildMemoryCore

test("truncateToBudget: under budget is untouched", () => {
  const r = MC.truncateToBudget("one\ntwo\nthree", 1000);
  assert.deepStrictEqual(r, { text: "one\ntwo\nthree", cut: false, cutLines: 0 });
});

test("truncateToBudget: cuts whole lines off the end, says what was cut, never drops the first line", () => {
  const big = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(20)).join("\n");
  const r = MC.truncateToBudget(big, 50);
  assert.ok(r.cut);
  assert.ok(r.cutLines > 0);
  assert.match(r.text, /^line 0 /);
  assert.match(r.text, /cut \d+ line\(s\) to fit the 50-token budget/);
});

test("buildMemoryCore: no match and no dataDir → says so plainly, still returns the compact index", () => {
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/nowhere/zzz", tree, entries, notesById, coreMap: {}, hubIds: new Set(["hub-acme", "hub-nas"]) });
  assert.strictEqual(built.meta.matchedBy, "none");
  assert.strictEqual(built.meta.usedTopRead, false);
  assert.match(built.text, /No project hub matched/);
  assert.match(built.text, /Work: Acme Storefront/);
});

test("buildMemoryCore: a match includes the matched hub's FULL note text", () => {
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/home/x/work/acme/storefront", tree, entries, notesById, coreMap: {} });
  assert.strictEqual(built.meta.matchedBy, "frontmatter");
  assert.deepStrictEqual(built.meta.hubIds, ["hub-acme"]);
  assert.match(built.text, /hub-acme note body/);
  assert.match(built.text, /memory_index_level/);
});

test("buildMemoryCore: respects budget_tokens end to end", () => {
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/home/x/work/acme/storefront", tree, entries, notesById, coreMap: {}, budgetTokens: 15 });
  assert.ok(built.meta.truncated);
  assert.ok(built.meta.tokensUsed <= 15 + 40, "a little slack for the cut notice itself, still clearly bounded");
});

test("topReadHubs: no dataDir → [] (best-effort, never throws)", () => {
  assert.deepStrictEqual(MC.topReadHubs({ entries: [{ id: "a" }], dataDir: null }), []);
});

test("topReadHubs: ranks by total read+search count, limited to ids the index actually lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-topread-"));
  fs.writeFileSync(path.join(dir, "activity-counts.json"), JSON.stringify({
    version: 1, since: "2026-01-01", started: "2026-01-01",
    days: {
      "2026-01-01": { notes: { "hub-acme": { read: 5, search: 1, write: 0 }, "hub-nas": { read: 1, search: 0, write: 0 }, "not-in-index": { read: 99, search: 0, write: 0 } } },
    },
    last: {},
  }));
  const entries = [{ id: "hub-acme" }, { id: "hub-nas" }, { id: "note-standalone" }];
  const r = MC.topReadHubs({ entries, dataDir: dir, limit: 3 });
  assert.deepStrictEqual(r, ["hub-acme", "hub-nas"]); // "not-in-index" is never returned
});

test("buildMemoryCore: no match but accounting data available → falls back to the top-read hubs, labelled as such", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-topread-core-"));
  fs.writeFileSync(path.join(dir, "activity-counts.json"), JSON.stringify({
    version: 1, since: "2026-01-01", started: "2026-01-01",
    days: { "2026-01-01": { notes: { "hub-nas": { read: 3, search: 0, write: 0 } } } }, last: {},
  }));
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/nowhere/zzz", tree, entries, notesById, coreMap: {}, dataDir: dir });
  assert.strictEqual(built.meta.matchedBy, "none");
  assert.strictEqual(built.meta.usedTopRead, true);
  assert.deepStrictEqual(built.meta.hubIds, ["hub-nas"]);
  assert.match(built.text, /most-read/);
  assert.match(built.text, /hub-nas note body/);
});
