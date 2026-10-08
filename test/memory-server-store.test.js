"use strict";
// memglow memory server (stage 0.4.5.1) — parsing and the note store: frontmatter edge cases,
// observations/relations, malformed files, identifier resolution, freshness.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parseYaml, splitFrontmatter } = require("../lib/store/frontmatter");
const { parseNote } = require("../lib/store/note");
const { createStore } = require("../lib/store/store");
const { parseTimeframe } = require("../lib/store/timeframe");
const { fold, terms, slugify, stableId } = require("../lib/store/text");
const { makeKb } = require("./fixtures/memory-kb");

const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); return fn(); };

test("frontmatter: scalars, quotes, folded quoted lines, flow and block lists, nested maps, block scalars", () => {
  const { data, error } = parseYaml([
    "title: 'It''s a title'",
    'quoted: "a \\"b\\" \\u00e9"',
    "description: 'Decision: memglow becomes the memory server",
    "  itself, and basic-memory is dropped.'",
    "plain: one line",
    "  continued here",
    "tags: [a, 'b c', \"d\"]",
    "list:",
    "- x",
    "- y",
    "indented:",
    "  - p",
    "  - q",
    "metadata:",
    "  type: reference",
    "  deep:",
    "    n: 2",
    "flag: true",
    "none: null",
    "num: 42",
    "text: |",
    "  line 1",
    "  line 2",
    "folded: >",
    "  a",
    "  b",
    "empty:",
  ].join("\n"));
  assert.strictEqual(error, null);
  assert.strictEqual(data.title, "It's a title");
  assert.strictEqual(data.quoted, 'a "b" é');
  assert.strictEqual(data.description, "Decision: memglow becomes the memory server itself, and basic-memory is dropped.");
  assert.strictEqual(data.plain, "one line continued here");
  assert.deepStrictEqual(data.tags, ["a", "b c", "d"]);
  assert.deepStrictEqual(data.list, ["x", "y"]);
  assert.deepStrictEqual(data.indented, ["p", "q"]);
  assert.deepStrictEqual(data.metadata, { type: "reference", deep: { n: 2 } });
  assert.strictEqual(data.flag, true);
  assert.strictEqual(data.none, null);
  assert.strictEqual(data.num, 42);
  assert.strictEqual(data.text, "line 1\nline 2\n");
  assert.strictEqual(data.folded, "a b\n");
  assert.strictEqual(data.empty, null);
});

test("frontmatter: broken YAML never throws and keeps the readable top-level keys", () => {
  const r = parseYaml("title: Broken\n  nonsense: [unclosed\n: : :\ntype: note");
  assert.ok(r.error);
  assert.strictEqual(r.data.title, "Broken");
  assert.strictEqual(r.data.type, "note");
  assert.deepStrictEqual(parseYaml("").data, {});
  assert.deepStrictEqual(parseYaml("- just\n- a list").data, {});
  // No frontmatter, an empty one, CRLF.
  assert.strictEqual(splitFrontmatter("no frontmatter").block, null);
  assert.strictEqual(splitFrontmatter("---\n---\nbody").body, "body");
  assert.strictEqual(splitFrontmatter("---\r\ntitle: x\r\n---\r\nbody").body, "body");
});

test("parseNote: title/permalink/type defaults, sections, observations, relations, code ignored", () => {
  const text = [
    "---", "title: Alice", "tags: a, b", "---", "",
    "Intro with [[Bob]] and [[Carol|alias]] and [[Dan#section]].", "",
    "## Facts", "- [fact] Lives in Paris #city (since 2020)", "- [ ] not an observation", "- [link](x.md) — not one either",
    "### Sub", "text", "## Relations", "- knows [[Bob]]", "- part of [[Team]]", "- **Bold**: [[Eve]] is a plain link",
    "```", "# not a heading", "- [fact] not an observation", "[[not-a-link]]", "```",
    "`[[inline-code]]`",
  ].join("\n");
  const n = parseNote({ rel: "people/alice.md", text, project: "main" });
  assert.strictEqual(n.title, "Alice");
  assert.strictEqual(n.permalink, "main/people/alice", "generated permalink = project/path");
  assert.strictEqual(n.type, "note");
  assert.deepStrictEqual(n.tags, ["a", "b"]);
  assert.deepStrictEqual(n.sections.map((s) => [s.heading, s.level]), [["Facts", 2], ["Sub", 3], ["Relations", 2]]);
  const facts = n.sections[0];
  assert.ok(facts.end > n.sections[1].start, "a section includes its sub-sections");
  assert.deepStrictEqual(n.observations.map((o) => [o.category, o.content, o.tags, o.context]), [["fact", "Lives in Paris", ["city"], "since 2020"]]);
  assert.deepStrictEqual(n.relations.map((r) => r.type + ">" + r.target).sort(),
    ["knows>Bob", "links_to>Bob", "links_to>Carol", "links_to>Dan", "links_to>Eve", "part_of>Team"].sort());
  assert.ok(!n.links.includes("not-a-link") && !n.links.includes("inline-code"));
  // Frontmatter permalink wins; no title → file name.
  const m = parseNote({ rel: "x/My File.md", text: "---\npermalink: /custom/link/\n---\nbody", project: "main" });
  assert.strictEqual(m.permalink, "custom/link");
  assert.strictEqual(m.title, "My File");
  assert.strictEqual(parseNote({ rel: "x/Été Été.md", text: "" }).permalink, "main/x/ete-ete");
});

test("text helpers: accent folding, stop-words, stems, slugs, stable ids", () => {
  assert.strictEqual(fold("Été Œuvre Straße"), "ete oeuvre strasse");
  assert.deepStrictEqual(terms("Les réseaux de la maison"), ["reseau", "maison"]);
  assert.deepStrictEqual(terms("The notes and the libraries"), ["note", "library"]);
  assert.strictEqual(slugify("docs/My Feature (v2).md"), "docs/my-feature-v2");
  assert.strictEqual(stableId("a"), stableId("a"));
  assert.match(stableId("a"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("timeframes", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.strictEqual(parseTimeframe("7d", now), now - 7 * 86400000);
  assert.strictEqual(parseTimeframe("24h", now), now - 86400000);
  assert.strictEqual(parseTimeframe("2 weeks", now), now - 14 * 86400000);
  assert.strictEqual(parseTimeframe("3 days ago", now), now - 3 * 86400000);
  assert.strictEqual(parseTimeframe("last week", now), now - 7 * 86400000);
  assert.ok(parseTimeframe("yesterday", now) < now - 86400000 + 1);
  assert.strictEqual(new Date(parseTimeframe("2026-01-01", now)).getFullYear(), 2026);
  assert.strictEqual(new Date(parseTimeframe("January 5, 2026", now)).getDate(), 5);
  assert.strictEqual(parseTimeframe("gibberish words", now), null);
});

test("store: indexes the fixture, skips non-UTF-8 / too-large / hidden files without crashing, survives BOM, CRLF and bad YAML", () => {
  const kb = makeKb();
  const store = createStore({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 }).start();
  try {
    const rels = store.notes().map((n) => n.rel).sort();
    assert.ok(!rels.includes("memory/notes/latin1.md"), "not UTF-8: skipped");
    assert.ok(!rels.includes("memory/notes/huge.md"), "too large: skipped");
    assert.ok(!rels.some((r) => r.startsWith(".git")), "hidden folders skipped");
    assert.strictEqual(rels.length, 9);
    const warns = store.stats().warnings.map((w) => w.file).sort();
    assert.deepStrictEqual(warns, ["memory/notes/bad-yaml.md", "memory/notes/huge.md", "memory/notes/latin1.md"]);
    const crlf = store.resolve("Windows Note");
    assert.ok(crlf, "BOM + CRLF note is indexed");
    assert.strictEqual(crlf.sections[0].heading, "Heading CRLF");
    assert.deepStrictEqual(crlf.links, ["bob"]);
    assert.strictEqual(store.resolve("main/memory/notes/bad-yaml").title, "Broken Yaml");
  } finally { store.stop(); kb.cleanup(); }
});

test("identifier resolution: permalink (with/without project), memory:// URL, path, title, slug; null on a miss", () => {
  const kb = makeKb();
  const store = createStore({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 }).start();
  try {
    const alice = "memory/people/alice.md";
    for (const id of ["main/memory/people/alice", "memory/people/alice", "memory://main/memory/people/alice", "memory://memory/people/alice",
      "memory/people/alice.md", "/memory/people/alice.md", "Alice Martin", "alice martin", "alice", "ALICE"]) {
      const n = store.resolve(id);
      assert.ok(n, `resolves ${id}`);
      assert.strictEqual(n.rel, alice, id);
    }
    assert.strictEqual(store.resolve("bob").rel, "memory/people/bob.md", "a note without frontmatter: title = file name");
    assert.strictEqual(store.resolve("main/memory/notes/reseau-maison").rel, "memory/notes/réseau-maison.md", "accented file name → folded permalink");
    assert.strictEqual(store.resolve("Réseau maison").rel, "memory/notes/réseau-maison.md");
    assert.strictEqual(store.resolve("reseau maison").rel, "memory/notes/réseau-maison.md", "title, accents folded");
    assert.strictEqual(store.resolve("main/docs/readme").rel, "docs/readme.md", "generated permalink for a note without one");
    assert.strictEqual(store.resolve("no-such-note"), null);
    assert.strictEqual(store.resolve("../etc/passwd"), null);
    assert.strictEqual(store.safePath("../../etc/passwd"), null, "path traversal refused");
    // Link graph: [[Garden Project]] (a title) resolves; incoming edges are known.
    const g = store.graph();
    const out = g.outgoing.get(alice).map((e) => `${e.type}>${e.to && e.to.rel}`).sort();
    assert.deepStrictEqual(out, ["knows>memory/people/bob.md", "works_with>memory/projects/garden-project.md"]);
    assert.ok(g.incoming.get(alice).some((e) => e.from.rel === "memory/people/bob.md"));
  } finally { store.stop(); kb.cleanup(); }
});

test("freshness: a file changed, added or deleted on disk is visible within the refresh window (watch, and poll alone)", async () => {
  for (const mode of [{ watch: true, pollMs: 0 }, { watch: false, pollMs: 150 }]) {
    const kb = makeKb();
    const store = createStore({ root: kb.root, maxFileBytes: 200 * 1024, ...mode }).start();
    try {
      assert.strictEqual(store.resolve("Alice Martin").status, "active");
      const v0 = store.version();
      const p = path.join(kb.root, "memory/people/alice.md");
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: active", "status: away"));
      assert.ok(await waitFor(() => store.resolve("Alice Martin").status === "away"), `edit seen (${JSON.stringify(mode)})`);
      assert.ok(store.version() > v0);
      kb.write("memory/new-note.md", "---\ntitle: Brand New\n---\nfresh words: kiwi");
      assert.ok(await waitFor(() => !!store.resolve("Brand New")), "new file seen");
      fs.unlinkSync(path.join(kb.root, "memory/people/bob.md"));
      assert.ok(await waitFor(() => !store.resolve("main/memory/people/bob")), "deleted file gone");
    } finally { store.stop(); kb.cleanup(); }
  }
});
