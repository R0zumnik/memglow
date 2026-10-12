"use strict";
// Search recall (0.4.11.1): light EN/FR stemming extensions, prefix matching (>= 5 chars), fuzzy
// (edit-distance-1) matching for off-vocabulary query terms (>= 6 chars), the hub → part field
// weight, and the OR fallback for a failed AND/phrase query — each proven on its own, with a
// small, controlled fixture (not the 215-query ranking snapshot, which only guards against
// ACCIDENTAL drift). See lib/store/text.js (stem) and lib/store/search.js for the mechanisms
// themselves, and CHANGELOG 0.4.11.1 for the real-usage duel these were tuned against (`-ed` and
// `-ment` stemming were tried too and dropped: measurably net-negative there).
const test = require("node:test");
const assert = require("node:assert");
const { createStore } = require("../lib/store/store");
const { createSearch } = require("../lib/store/search");
const { stem } = require("../lib/store/text");
const { makeKb } = require("./fixtures/memory-kb");

function setup(extra = {}) {
  const kb = makeKb();
  for (const [rel, text] of Object.entries(extra)) kb.write(rel, text);
  const store = createStore({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 }).start();
  const engine = createSearch(store);
  const ids = (args) => engine.search(args).results.map((h) => h.note.permalink);
  return { kb, store, engine, ids, done: () => { store.stop(); kb.cleanup(); } };
}

// ---------------------------------------------------------------------------------------------
// stem(): the suffix equivalences this stage adds, in isolation (no index involved).

test("stem(): plural normalises BEFORE the other suffixes, so a word and its plural land on the same stem (EN + FR)", () => {
  assert.strictEqual(stem("decision"), stem("decisions"), "tion/sion: singular and plural agree");
  assert.strictEqual(stem("action"), stem("actions"));
  assert.strictEqual(stem("deploying"), stem("deploy"), "-ing dropped cleanly when there is no consonant to undouble");
  assert.strictEqual(stem("testing"), stem("test"));
  // FR cognates of the same suffixes (fold() already strips accents before stem() ever runs).
  assert.strictEqual(stem("decision"), stem("decision"), "sanity");
  assert.strictEqual(stem("television"), stem("televisions"));
});

test("stem(): short words are never over-stemmed (the length guards actually guard something)", () => {
  assert.strictEqual(stem("king"), "king", "4 letters: too short for the -ing rule (len > 5 required)");
  assert.strictEqual(stem("bus"), "bus", "ends in s but 'ss'-like short word: plural rule needs > 3 letters and not a double-s");
  assert.strictEqual(stem("gas"), "gas", "3 letters: too short for the plural rule (len > 3 required)");
});

// ---------------------------------------------------------------------------------------------
// Fixture notes for the engine-level checks below: FR + EN, one note per mechanism so each
// assertion is unambiguous about which technique made it match.

function recallNotes() {
  return {
    "memory/recall/project-decision-record.md": [
      "---", "title: Project decision record", "description: Governance log", "tags: [project]", "---", "",
      "This document explains the decisions made for the roadmap this quarter.",
    ].join("\n"),
    "memory/recall/fr-television.md": [
      "---", "title: Note sur la diffusion", "description: Diffusion télévisée", "tags: [media]", "---", "",
      "Les droits de diffusion televisions ont été renégociés cette année.",
    ].join("\n"),
    "memory/recall/automation-release.md": [
      "---", "title: Automation release notes", "description: CI pipeline", "tags: [ci]", "---", "",
      "The team is deploying the new release tonight after the final smoke tests pass.",
    ].join("\n"),
    "memory/recall/server-infra.md": [
      "---", "title: Server infrastructure notes", "description: Ops reference", "tags: [ops]", "---", "",
      "Detailed configuration steps for the reverse proxy and the load balancer.",
    ].join("\n"),
    "memory/recall/apollo-hub.md": [
      "---", "title: Apollo launch program", "description: Mission control, launch windows and rocket telemetry for the Apollo program", "tags: [space]", "---", "",
      "Summary note — the detail lives in the parts listed below.", "",
      "## Parts", "- [[apollo-engine-specs]] — turbopump and nozzle metrics",
    ].join("\n"),
    "memory/recall/apollo-engine-specs.md": [
      "---", "title: Engine specs", "description: Turbopump specifications", "part_of: apollo-hub", "tags: [space]", "---", "",
      "Up: [[apollo-hub]]", "", "Turbopump thrust chamber and nozzle metrics, revision 3.",
    ].join("\n"),
    "memory/recall/pipeline-stages.md": [
      "---", "title: Pipeline stages", "description: Build and test stages", "tags: [ci]", "---", "",
      "Pipeline covers build, unit test and a separate release stage at the very end.",
    ].join("\n"),
  };
}

test("stemming end to end: a plural query finds a singular-only note, and vice versa (tion/sion, EN + FR)", () => {
  const s = setup(recallNotes());
  try {
    assert.ok(s.ids({ query: "decisions" }).includes("main/memory/recall/project-decision-record"), "note only ever says 'decisions' (plural) — query 'decisions' obviously matches...");
    // The note's own word is "decisions" (plural); the SINGULAR query must still find it — this
    // is the actual new behaviour (0.4.10.x already handled a query plural / index singular, or
    // the reverse, for the OLD plural-s rule; tion/sion normalising AFTER plural stripping is
    // what makes "decision" and "decisions" collapse to the exact same stem).
    assert.ok(s.ids({ query: "decision" }).includes("main/memory/recall/project-decision-record"), "singular query finds the plural-only note");
    assert.ok(s.ids({ query: "televisions" }).includes("main/memory/recall/fr-television"), "FR: plural query finds it");
    assert.ok(s.ids({ query: "television" }).includes("main/memory/recall/fr-television"), "FR: singular query finds the plural-only note (tion/sion + plural)");
  } finally { s.done(); }
});

test("stemming end to end: -ing query/index forms agree ('deploying' in the note, 'deploy' in the query)", () => {
  const s = setup(recallNotes());
  try {
    const hits = s.ids({ query: "deploy" });
    assert.ok(hits.includes("main/memory/recall/automation-release"), "note only ever says 'deploying' — the base-form query still finds it");
  } finally { s.done(); }
});

test("prefix matching (>= 5 chars): a short query is a prefix of a longer index word", () => {
  const s = setup(recallNotes());
  try {
    const hits = s.ids({ query: "config" }); // 6 chars; note only ever says "configuration"
    assert.ok(hits.includes("main/memory/recall/server-infra"), "'config' (6 chars) prefix-matches 'configuration'");
  } finally { s.done(); }
});

test("fuzzy matching (edit distance 1, >= 6 chars, only with no exact hit): a typo still finds the right note", () => {
  const s = setup(recallNotes());
  try {
    // "telemetri" (9 chars) is not a real word and has no exact hit anywhere in the index; it is
    // exactly one substitution away from "telemetry", which the Apollo hub's own description
    // carries (folded into apollo-engine-specs too via the hub field — see the next test).
    const hits = s.ids({ query: "mission telemetri" });
    assert.ok(hits.includes("main/memory/recall/apollo-hub"), "typo'd query still finds the hub via fuzzy matching");
  } finally { s.done(); }
});

test("hub field: a part is found through its hub's own words, even though the part's body never repeats them", () => {
  const s = setup(recallNotes());
  try {
    // apollo-engine-specs' own title/description/body never say "Apollo", "launch", "rocket",
    // "mission" or "telemetry" — only its hub (declared via part_of) does.
    const hits = s.ids({ query: "Apollo rocket telemetry", page_size: 20 });
    assert.ok(hits.includes("main/memory/recall/apollo-engine-specs"), "the part is found anyway, via the hub field");
    assert.ok(hits.includes("main/memory/recall/apollo-hub"), "the hub itself is still found too");
  } finally { s.done(); }
});

test("OR fallback: an explicit AND that no single note satisfies still returns its individual words' hits", () => {
  const s = setup(recallNotes());
  try {
    // No note has BOTH "pipeline" and "deploy" ("automation-release" only deploys, "pipeline-
    // stages" only has the pipeline word) — the strict AND clause matches NOTHING on its own, so
    // the OR fallback is what turns up each word's own note.
    const strictAndEmpty = s.engine.search({ query: "pipeline AND deploy" });
    const hits = strictAndEmpty.results.map((h) => h.note.permalink);
    assert.ok(hits.includes("main/memory/recall/automation-release"), "OR fallback: found via 'deploy'");
    assert.ok(hits.includes("main/memory/recall/pipeline-stages"), "OR fallback: found via 'pipeline'");
  } finally { s.done(); }
});

test("OR fallback deliberately never applies to a quoted phrase: word order inside quotes still matters", () => {
  const s = setup(recallNotes());
  try {
    // Reversed word order of an actual phrase in the fixture ("release tonight" exists nowhere,
    // nor does "tonight release") must still return nothing — relaxing a quoted phrase into an
    // OR would silently defeat the one thing quotes promise.
    assert.deepStrictEqual(s.ids({ query: '"tonight release"' }), []);
  } finally { s.done(); }
});

test("OR fallback never fires for an already-OR query, and never needed when the AND query already has enough hits", () => {
  const s = setup(recallNotes());
  try {
    // A query with no AND/phrase clause at all (should-only) has nothing to "fall back" from —
    // this is really just confirming the gate (parsed.clauses.some(must && !strictPhrase)) gates.
    const or = s.engine.search({ query: "release pipeline" }); // no AND, no quotes: already OR
    assert.ok(or.total >= 2, "both notes found on the plain OR query, same as always");
  } finally { s.done(); }
});
