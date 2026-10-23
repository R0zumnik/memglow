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
const { estimateTokens } = require("../lib/cost");

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

test("matchHub: tier 3, word match needs >= 2 distinct non-generic shared words (0.5.1.4 hardening)", () => {
  const { entries, notesById } = fixture();
  // "nas", "home" and "lab" all overlap with hub-nas's title/description — a clear, multi-word match.
  const r = MC.matchHub({ cwd: "/home/x/nas-home-lab", coreMap: {}, entries, notesById });
  assert.strictEqual(r.matchedBy, "words");
  assert.deepStrictEqual(r.hubIds, ["hub-nas"]);
});

test("matchHub: tier 3, a SINGLE shared word is never enough on its own, generic or not (0.5.1.4)", () => {
  const { entries, notesById } = fixture();
  // Only "nas" overlaps (one word) — below the minimum score, and no exact segment match either.
  const r = MC.matchHub({ cwd: "/home/x/projects/nas-cluster", coreMap: {}, entries, notesById });
  assert.deepStrictEqual(r, { hubIds: [], matchedBy: "none" });
});

test("matchHub: tier 3, an exact whole-path-segment match to the hub's own id wins even with a single word (0.5.1.4)", () => {
  const { entries, notesById } = fixture();
  const r = MC.matchHub({ cwd: "/home/x/projects/hub-nas", coreMap: {}, entries, notesById });
  assert.deepStrictEqual(r, { hubIds: ["hub-nas"], matchedBy: "words" });
});

test("matchHub: tier 3, generic path words alone (the cold-review bug: /home/florent/dev/app) never match", () => {
  const entries = [{ id: "app-review", hook: "App review: periodic review of installed apps" }, { id: "hub-nas", hook: "Home NAS hub" }];
  const notesById = new Map([["app-review", { title: "App review" }], ["hub-nas", { title: "NAS" }]]);
  assert.deepStrictEqual(MC.matchHub({ cwd: "/home/florent/dev/app", entries, notesById }), { hubIds: [], matchedBy: "none" });
  // The documented generic fallback case: a fully generic cwd never matches anything.
  assert.deepStrictEqual(MC.matchHub({ cwd: "/home/node/workspace", entries, notesById }), { hubIds: [], matchedBy: "none" });
});

test("matchHub: tier 3, a tie between two equally-scored candidates is ambiguous → no match (0.5.1.4, 'clear winner' gate)", () => {
  const entries = [{ id: "acme-one", hook: "hook" }, { id: "acme-two", hook: "hook" }];
  const notesById = new Map([["acme-one", { title: "Acme One", description: "ecommerce rebuild project" }], ["acme-two", { title: "Acme Two", description: "ecommerce rebuild project" }]]);
  assert.deepStrictEqual(MC.matchHub({ cwd: "/home/x/acme-ecommerce-rebuild", entries, notesById }), { hubIds: [], matchedBy: "none" });
});

test("matchHub: tier 3, 'match only hubs' — with hubIds known, a plain standalone note is never proposed, even on a strong word match", () => {
  const entries = [{ id: "standalone-note", hook: "hook" }];
  const notesById = new Map([["standalone-note", { title: "Standalone Note" }]]);
  assert.strictEqual(MC.matchHub({ cwd: "/home/x/standalone-note", entries, notesById }).matchedBy, "words", "fallback (hub status unknown): still matches");
  assert.deepStrictEqual(MC.matchHub({ cwd: "/home/x/standalone-note", entries, notesById, hubIds: new Set() }), { hubIds: [], matchedBy: "none" });
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

// 0.5.1.4 (cold-review NO-GO fix #2): never cut inside a fenced code block, the final size
// (notice included) must fit the budget whenever that is at all achievable, and a mandatory
// `keepSuffix` (buildMemoryCore's escape hatch) must always survive, verbatim, as plain text.

test("truncateToBudget: never leaves an unterminated ``` fence, across a sweep of budgets straddling the fence", () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const text = [pad(8), "```js", pad(6), pad(6), pad(6), "```", pad(8), "```", pad(4), "```", pad(10)].join("\n");
  const full = estimateTokens(text);
  for (let b = 5; b <= full + 5; b += 3) {
    const r = MC.truncateToBudget(text, b);
    const fenceLines = (r.text.match(/```/g) || []).length;
    assert.strictEqual(fenceLines % 2, 0, `budget ${b}: an odd number of \`\`\` markers means an unterminated fence — text:\n${r.text}`);
  }
});

test("truncateToBudget: a fence right at the cut point is removed WHOLE, never left half-open (cut before it, not a fabricated closer)", () => {
  const text = ["intro line here", "```", "code line one", "code line two", "```", "final outro line"].join("\n");
  const r = MC.truncateToBudget(text, estimateTokens(text) - 1); // forces cutting right at the trailing fence
  assert.doesNotMatch(r.text, /```/); // the whole fenced block was dropped, not half of it
  assert.match(r.text, /^intro line here/);
});

test("truncateToBudget: keepSuffix (the escape hatch) always survives verbatim, as plain text, even under a budget smaller than the notice itself", () => {
  const text = Array.from({ length: 12 }, (_, i) => `padding word ${i} `.repeat(6)).join("\n");
  const suffix = "\n\n---\nExpand: read_note or memory_index_level.";
  const tiny = MC.truncateToBudget(text, 1, { keepSuffix: suffix });
  assert.ok(tiny.cut);
  assert.ok(tiny.text.endsWith(suffix), "the escape hatch survives even a hopeless budget");
  assert.ok(!/```/.test(suffix), "sanity: the escape hatch itself is never fenced");
});

test("truncateToBudget: the FINAL text (notice + keepSuffix included) stays <= budgetTokens for every budget at or above what is achievable", () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const text = Array.from({ length: 12 }, (_, i) => `${pad(6)}-line${i}`).join("\n");
  const suffix = "\n\n---\nExpand: read_note or memory_index_level.";
  const minimum = estimateTokens(MC.truncateToBudget(text, 1, { keepSuffix: suffix }).text); // the unavoidable floor
  const full = estimateTokens(text + suffix);
  for (let b = minimum; b <= full + 20; b += 3) {
    const r = MC.truncateToBudget(text, b, { keepSuffix: suffix });
    assert.ok(estimateTokens(r.text) <= b, `budget ${b}: got ${estimateTokens(r.text)} tokens`);
    assert.ok(r.text.endsWith(suffix), `budget ${b}: the escape hatch must still be there`);
  }
});

test("truncateToBudget: below the unavoidable floor, still never throws, still keeps the suffix and at least one line", () => {
  const text = "a single very long line ".repeat(50);
  const suffix = "\n\n---\nExpand: read_note or memory_index_level.";
  const r = MC.truncateToBudget(text, 1, { keepSuffix: suffix });
  assert.ok(r.cut);
  assert.ok(r.text.endsWith(suffix));
  assert.ok(r.text.length > 0);
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

test("buildMemoryCore: respects budget_tokens end to end — and the escape hatch survives even a hopeless budget (0.5.1.4)", () => {
  const { tree, entries, notesById } = fixture();
  // 15 is below even the mandatory footer's own size: the floor is "unavoidable", not a bug —
  // the escape hatch (read_note / memory_index_level) is never one of the lines that get cut.
  const tiny = MC.buildMemoryCore({ cwd: "/home/x/work/acme/storefront", tree, entries, notesById, coreMap: {}, budgetTokens: 15 });
  assert.ok(tiny.meta.truncated);
  assert.match(tiny.text, /memory_index_level/, "the escape hatch is never sacrificed to the budget");

  // A realistic, achievable budget: the guarantee is a real one here (no slack needed).
  const budgetTokens = 120;
  const reasonable = MC.buildMemoryCore({ cwd: "/home/x/work/acme/storefront", tree, entries, notesById, coreMap: {}, budgetTokens });
  assert.ok(reasonable.meta.tokensUsed <= budgetTokens, `${reasonable.meta.tokensUsed} should fit the ${budgetTokens}-token budget`);
  assert.match(reasonable.text, /memory_index_level/);
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

// ---------------------------------------------------------------------------------------------
// accountingSummary (0.5.3): proxy-savings.json is the preferred source (same reader the Memory
// cost panel / Settings → Control already use for it, lib/levers/accounting.js's
// readClientSavings), falling back to the OLD file (activity-counts.json) when it has nothing.

test("accountingSummary: no dataDir → null, never throws", () => {
  assert.strictEqual(MC.accountingSummary({ dataDir: null }), null);
  assert.strictEqual(MC.accountingSummary({}), null);
});

test("accountingSummary: neither file present, or both empty → null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-"));
  assert.strictEqual(MC.accountingSummary({ dataDir: dir }), null, "no files at all");
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({ version: 1, days: {} }));
  assert.strictEqual(MC.accountingSummary({ dataDir: dir }), null, "an empty proxy-savings.json");
});

test("accountingSummary: reads proxy-savings.json — per-lever tokens/calls, last 7 days, newest-saving-first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-"));
  const now = Date.now();
  const day = (n) => { const d = new Date(now - n * 86400000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({
    version: 1,
    days: {
      [day(1)]: { dedupe: 300, dedupeCalls: 3, alreadyLoaded: 900, alreadyLoadedCalls: 4, clients: { "claude-code": { tokens: 500, calls: 10 } } },
      [day(3)]: { toc: 50, tocCalls: 1 },
      [day(40)]: { dedupe: 99999, dedupeCalls: 99 }, // outside the 7-day window: ignored
    },
  }));
  const summary = MC.accountingSummary({ dataDir: dir, now });
  assert.match(summary, /^memglow: proxy accounting, last 7 days/);
  // alreadyLoaded (900) saved more than dedupe (300): named first.
  assert.match(summary, /alreadyLoaded ≈900t\/4.*dedupe ≈300t\/3.*toc ≈50t\/1/);
  assert.match(summary, /≈500 tokens relayed to 1 client/);
  assert.ok(!summary.includes("99999"), "the 40-day-old entry is outside the 7-day window");
});

test("accountingSummary: no per-lever savings, but client traffic alone is enough to report something", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-"));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({
    version: 1, days: { [today]: { clients: { "claude-code": { tokens: 1200, calls: 6 } } } },
  }));
  const summary = MC.accountingSummary({ dataDir: dir });
  assert.match(summary, /no per-lever savings yet/);
  assert.match(summary, /≈1200 tokens relayed to 1 client/);
});

test("accountingSummary: falls back to the OLD file (activity-counts.json) when proxy-savings.json has nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-"));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "activity-counts.json"), JSON.stringify({
    version: 1, since: today, started: today,
    days: { [today]: { notes: { "hub-nas": { read: 3, search: 2, write: 0 } } } }, last: {},
  }));
  const summary = MC.accountingSummary({ dataDir: dir });
  assert.match(summary, /^memglow: 5 read\/search\/write event\(s\) recorded in the last 7 days \(no proxy-savings\.json yet\)\.$/);
});

test("accountingSummary: proxy-savings.json wins outright over activity-counts.json when BOTH are present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-"));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "activity-counts.json"), JSON.stringify({
    version: 1, since: today, started: today, days: { [today]: { notes: { x: { read: 99, search: 0, write: 0 } } } }, last: {},
  }));
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({ version: 1, days: { [today]: { dedupe: 10, dedupeCalls: 1 } } }));
  const summary = MC.accountingSummary({ dataDir: dir });
  assert.match(summary, /^memglow: proxy accounting/);
  assert.ok(!summary.includes("99"), "the old file is never even consulted once the new one has data");
});

test("buildMemoryCore: no match, no top-read hubs, but proxy-savings.json has real data → a savings summary, never the old 'no accounting data' wording", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-core-"));
  const today = new Date().toISOString().slice(0, 10);
  // Real savings, but note ids topReadHubs would never surface a "most read" hub from this file
  // alone (proxy-savings.json carries no per-note counts at all).
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({
    version: 1, days: { [today]: { alreadyLoaded: 450, alreadyLoadedCalls: 2 } },
  }));
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/nowhere/zzz", tree, entries, notesById, coreMap: {}, dataDir: dir });
  assert.strictEqual(built.meta.matchedBy, "none");
  assert.strictEqual(built.meta.usedTopRead, false, "proxy-savings.json alone never resolves a hub id to show in full");
  assert.match(built.text, /No project hub matched for this folder/);
  assert.ok(!built.text.includes("no accounting data is available yet"), "there plainly IS accounting data — just not of the per-note kind");
  assert.match(built.text, /memglow: proxy accounting, last 7 days — alreadyLoaded ≈450t\/2/);
});

test("buildMemoryCore: no match and a dataDir with truly nothing in either file → the honest 'no accounting data' wording, unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-core-empty-"));
  const { tree, entries, notesById } = fixture();
  const built = MC.buildMemoryCore({ cwd: "/nowhere/zzz", tree, entries, notesById, coreMap: {}, dataDir: dir });
  assert.match(built.text, /no accounting data is available yet/);
});
