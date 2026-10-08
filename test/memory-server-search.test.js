"use strict";
// memglow memory server (stage 0.4.5.1) — search engine sanity: accents, title vs body, phrases,
// boolean operators, prefixes, search types, filters, pagination, determinism.
const test = require("node:test");
const assert = require("node:assert");
const { createStore } = require("../lib/store/store");
const { createSearch, parseQuery } = require("../lib/store/search");
const { makeKb } = require("./fixtures/memory-kb");

function setup(extra = {}) {
  const kb = makeKb();
  for (const [rel, text] of Object.entries(extra)) kb.write(rel, text);
  const store = createStore({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 }).start();
  const engine = createSearch(store);
  const ids = (args) => engine.search(args).results.map((h) => h.note.permalink);
  return { kb, store, engine, ids, done: () => { store.stop(); kb.cleanup(); } };
}

test("query parsing: phrases, AND/OR/NOT, -word, prefix*, tag:", () => {
  const q = parseQuery('garden "vegetable garden" -rugby NOT tea a AND b tom* tag:home OR x');
  const byRaw = Object.fromEntries(q.clauses.map((c) => [c.raw, c]));
  assert.strictEqual(byRaw.garden.mode, "should");
  assert.strictEqual(byRaw["vegetable garden"].mode, "must");
  assert.ok(byRaw["vegetable garden"].strictPhrase);
  assert.strictEqual(byRaw.rugby.mode, "not");
  assert.strictEqual(byRaw.tea.mode, "not");
  assert.strictEqual(byRaw.a, undefined, "stop-word dropped");
  assert.strictEqual(byRaw.b.mode, "must");
  assert.ok(byRaw["tom*"].prefix);
  assert.deepStrictEqual(q.tags, ["home"]);
  assert.strictEqual(byRaw.x.mode, "should");
});

test("FR accents fold both ways; stop-words ignored; plural stems", () => {
  const s = setup();
  try {
    assert.deepStrictEqual(s.ids({ query: "reseau" }), ["main/memory/notes/reseau-maison"]);
    assert.deepStrictEqual(s.ids({ query: "RÉSEAU" }), ["main/memory/notes/reseau-maison"]);
    assert.strictEqual(s.ids({ query: "été" })[0], "main/memory/projects/garden-project");
    assert.strictEqual(s.ids({ query: "ete" })[0], "main/memory/projects/garden-project");
    assert.strictEqual(s.ids({ query: "le réseau de la maison" })[0], "main/memory/notes/reseau-maison", "stop-words do not dilute");
    assert.ok(s.ids({ query: "tomate" }).includes("main/memory/projects/garden-project"), "singular finds plural");
  } finally { s.done(); }
});

test("ranking: the title beats the body; an exact title wins; more query words covered ranks higher", () => {
  const s = setup();
  try {
    const garden = s.ids({ query: "garden" });
    assert.strictEqual(garden[0], "main/memory/projects/garden-project", "title match first");
    assert.ok(garden.includes("main/memory/projects/rugby-club"), "body-only match still found");
    assert.strictEqual(s.ids({ query: "Rugby Club" })[0], "main/memory/projects/rugby-club");
    const rs = s.ids({ query: "rugby stade" });
    assert.deepStrictEqual(rs.slice(0, 2).sort(), ["main/memory/people/bob", "main/memory/projects/rugby-club"]);
    assert.strictEqual(s.ids({ query: "alice" })[0], "main/memory/people/alice");
  } finally { s.done(); }
});

test("phrases, NOT / -word, AND, prefix", () => {
  const s = setup();
  try {
    assert.deepStrictEqual(s.ids({ query: '"vegetable garden"' }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ query: '"garden vegetable"' }), [], "word order matters inside quotes");
    const notRugby = s.ids({ query: "garden -rugby" });
    assert.ok(notRugby.length && !notRugby.includes("main/memory/projects/rugby-club"));
    assert.deepStrictEqual(s.ids({ query: "garden NOT rugby" }), notRugby);
    assert.deepStrictEqual(s.ids({ query: "garden AND stade" }), ["main/memory/projects/rugby-club"]);
    assert.ok(s.ids({ query: "garden OR zebra" }).includes("main/memory/notes/bad-yaml"));
    assert.ok(s.ids({ query: "courg" }).includes("main/memory/projects/garden-project"), "implicit prefix (3+ chars)");
    assert.ok(s.ids({ query: "court*" }).length === 0);
    assert.deepStrictEqual(s.ids({ query: "tag:friend" }), ["main/memory/people/alice"]);
  } finally { s.done(); }
});

test("search types: title (exact > prefix > contains), permalink (exact, prefix, glob), memory:// → permalink", () => {
  const s = setup({ "memory/projects/garden-tools.md": "---\ntitle: Garden Tools\n---\nspade\n" });
  try {
    assert.deepStrictEqual(s.ids({ query: "Garden", search_type: "title" }), ["main/memory/projects/garden-tools", "main/memory/projects/garden-project"], "both start with it; the closer (shorter) title first");
    assert.deepStrictEqual(s.ids({ query: "Garden Project", search_type: "title" })[0], "main/memory/projects/garden-project", "exact title first");
    assert.deepStrictEqual(s.ids({ query: "garden project", search_type: "title" }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ query: "tools", search_type: "title" }), ["main/memory/projects/garden-tools"]);
    assert.deepStrictEqual(s.ids({ query: "main/memory/people/alice", search_type: "permalink" }), ["main/memory/people/alice"]);
    assert.deepStrictEqual(s.ids({ query: "memory/people/alice", search_type: "permalink" }), ["main/memory/people/alice"]);
    assert.deepStrictEqual(s.ids({ query: "memory/people", search_type: "permalink" }), ["main/memory/people/alice", "main/memory/people/bob"]);
    assert.deepStrictEqual(s.ids({ query: "main/memory/projects/garden-*", search_type: "permalink" }), ["main/memory/projects/garden-project", "main/memory/projects/garden-tools"]);
    assert.deepStrictEqual(s.ids({ query: "memory://memory/people/*" }), ["main/memory/people/alice", "main/memory/people/bob"]);
    for (const t of ["vector", "semantic", "hybrid"]) assert.deepStrictEqual(s.ids({ query: "garden", search_type: t }), s.ids({ query: "garden" }), t + " = lexical");
  } finally { s.done(); }
});

test("filters: note_types, tags, status, metadata_filters (incl. operators, note_type alias), after_date, filter-only", () => {
  const s = setup();
  try {
    assert.deepStrictEqual(s.ids({ query: "garden", note_types: ["project"] }).sort(), ["main/memory/projects/garden-project", "main/memory/projects/rugby-club"]);
    assert.deepStrictEqual(s.ids({ query: "garden", tags: ["home"] }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ query: "garden", tags: "garden,home" }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ status: "done" }), ["main/memory/projects/rugby-club"], "filter-only search");
    assert.deepStrictEqual(s.ids({ metadata_filters: { status: "in-progress" } }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ metadata_filters: { "metadata.priority": { $gte: 2 } } }), ["main/memory/projects/garden-project"]);
    assert.deepStrictEqual(s.ids({ metadata_filters: { "metadata.priority": { $gt: 2 } } }), []);
    assert.deepStrictEqual(s.ids({ metadata_filters: { note_type: "person" } }), ["main/memory/people/alice"]);
    assert.deepStrictEqual(s.ids({ metadata_filters: { status: ["done", "active"] } }).sort(), ["main/memory/people/alice", "main/memory/projects/rugby-club"]);
    assert.deepStrictEqual(s.ids({ metadata_filters: { tags: { $in: ["friend"] } } }), ["main/memory/people/alice"]);
    const recent = s.ids({ query: "garden", after_date: "7d" });
    assert.ok(!recent.includes("main/memory/projects/rugby-club"), "rugby-club is 40 days old");
    assert.ok(recent.includes("main/memory/projects/garden-project"));
  } finally { s.done(); }
});

test("observations and relations as results; categories filter", () => {
  const s = setup();
  try {
    const obs = s.engine.search({ query: "tea", entity_types: ["observation"] }).results;
    assert.strictEqual(obs.length, 1);
    assert.strictEqual(obs[0].kind, "observation");
    assert.strictEqual(obs[0].observation.category, "preference");
    const cats = s.engine.search({ categories: ["fact"] }).results;
    assert.deepStrictEqual(cats.map((h) => h.observation.content), ["Alice lives in Orléans"]);
    const rels = s.engine.search({ query: "bob", entity_types: ["relation"] }).results;
    assert.ok(rels.some((h) => h.kind === "relation" && h.relation.type === "knows"));
  } finally { s.done(); }
});

test("pagination and determinism (score, then permalink)", () => {
  const extra = {};
  for (let i = 0; i < 25; i++) extra[`memory/bulk/same-${String(i).padStart(2, "0")}.md`] = "---\ntitle: Bulk\n---\nidentical words about kumquat\n";
  const s = setup(extra);
  try {
    const all = s.engine.search({ query: "kumquat", page_size: 100 });
    assert.strictEqual(all.total, 25);
    assert.deepStrictEqual(all.results.map((h) => h.note.permalink), [...all.results.map((h) => h.note.permalink)].sort(), "equal scores → permalink order");
    const p1 = s.engine.search({ query: "kumquat", page: 1, page_size: 10 });
    const p3 = s.engine.search({ query: "kumquat", page: 3, page_size: 10 });
    assert.strictEqual(p1.results.length, 10);
    assert.ok(p1.has_more);
    assert.strictEqual(p3.results.length, 5);
    assert.ok(!p3.has_more);
    assert.deepStrictEqual(p3.results.map((h) => h.note.permalink), all.results.slice(20).map((h) => h.note.permalink));
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(s.ids({ query: "garden rugby alice" }), s.ids({ query: "garden rugby alice" }));
    const snip = s.engine.search({ query: "arrosage" }).results[0].match;
    assert.match(snip, /arrosage le soir/);
    assert.ok(!snip.includes("\n"), "snippet is one line");
  } finally { s.done(); }
});
