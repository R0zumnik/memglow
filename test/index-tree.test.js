"use strict";
// Index tree (lib/index-tree.js): deterministic, no AI, built from the index note's own heading
// structure and its "- [[slug]] — hook" bullet lines (lib/index-trim.js's LINE_RE, reused so both
// modules agree on what counts as an index entry).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parseIndexTree, renderLevel, groupMatches } = require("../lib/index-tree");
const { estimateTokens } = require("../lib/cost");

const GROUPED = [
  "---", "title: MEMORY", "---", "",
  "# Memory index", "",
  "## Work", "",
  "- [[hub-a]] — Hub A: a project with a very long hook sentence describing lots of detail",
  "- [[note-a1]] — a standalone note under Work",
  "",
  "## Family", "",
  "- [[hub-b]] — Hub B: another project",
  "- [[note-b1]] — a standalone note under Family",
  "- [[note-b2]] — another standalone note under Family",
  "",
].join("\n");

test("parseIndexTree: splits into top groups by the shallowest heading level, bullets land in the group they follow", () => {
  const tree = parseIndexTree(GROUPED);
  assert.strictEqual(tree.groups.length, 2);
  assert.strictEqual(tree.groups[0].title, "Work");
  assert.deepStrictEqual(tree.groups[0].entries.map((e) => e.id), ["hub-a", "note-a1"]);
  assert.strictEqual(tree.groups[1].title, "Family");
  assert.deepStrictEqual(tree.groups[1].entries.map((e) => e.id), ["hub-b", "note-b1", "note-b2"]);
  // Each group's raw block is byte-identical to its slice of the original body.
  assert.match(tree.groups[0].raw, /^## Work/);
  assert.match(tree.groups[1].raw, /^## Family/);
});

test("parseIndexTree: no heading at all → one ungrouped group covering every bullet", () => {
  const flat = "---\ntitle: MEMORY\n---\n\n# Memory index\n\n- [[a]] — hook a\n- [[b]] — hook b\n";
  const tree = parseIndexTree(flat);
  assert.strictEqual(tree.groups.length, 1);
  assert.strictEqual(tree.groups[0].title, null);
  assert.deepStrictEqual(tree.groups[0].entries.map((e) => e.id), ["a", "b"]);
});

test("parseIndexTree: the bullet's OWN [[link]] (the first one) is the entry id, even if its hook text mentions another [[link]] in passing", () => {
  const text = "## Work\n\n- [[hub-a]] — see also [[other]] for context\n- [[note-a1]] — fine\n";
  const tree = parseIndexTree(text);
  assert.deepStrictEqual(tree.groups[0].entries.map((e) => e.id), ["hub-a", "note-a1"]);
});

test("renderLevel level 2 with no `group`: the index exactly as stored, byte-identical", () => {
  const tree = parseIndexTree(GROUPED);
  assert.strictEqual(renderLevel(tree, 2), GROUPED);
});

test("renderLevel level 2 with `group`: just that one group's own raw block", () => {
  const tree = parseIndexTree(GROUPED);
  const out = renderLevel(tree, 2, { group: "Family" });
  assert.strictEqual(out, tree.groups[1].raw);
  assert.doesNotMatch(out, /Work/);
});

test("renderLevel level 0/1 with no hubIds: every entry counts (the honest fallback when hub/part status is unknown)", () => {
  const tree = parseIndexTree(GROUPED);
  const l0 = renderLevel(tree, 0);
  assert.match(l0, /Work: hub-a, note-a1/);
  assert.match(l0, /Family: hub-b, note-b1, note-b2/);
  const l1 = renderLevel(tree, 1);
  assert.match(l1, /## Work\n- hub-a\n- note-a1/);
});

test("renderLevel level 0/1 with hubIds: only confirmed hubs are listed, per group — a group with none lists none", () => {
  const tree = parseIndexTree(GROUPED);
  const hubIds = new Set(["hub-a", "hub-b"]);
  const l0 = renderLevel(tree, 0, { hubIds });
  assert.strictEqual(l0, "Work: hub-a\nFamily: hub-b");
  const l1 = renderLevel(tree, 1, { hubIds: new Set() }); // no confirmed hub anywhere
  assert.strictEqual(l1, "## Work\n\n## Family");
});

test("renderLevel: titleOf() maps an entry's link target to a display title", () => {
  const tree = parseIndexTree(GROUPED);
  const titleOf = (id) => ({ "hub-a": "Hub A (nice title)" }[id] || id);
  const l0 = renderLevel(tree, 0, { titleOf, hubIds: new Set(["hub-a"]) });
  assert.strictEqual(l0, "Work: Hub A (nice title)\nFamily");
});

test("groupMatches: case/accent-insensitive, substring allowed", () => {
  const tree = parseIndexTree(GROUPED);
  assert.ok(groupMatches(tree.groups[0], "work"));
  assert.ok(groupMatches(tree.groups[0], "WORK"));
  assert.ok(!groupMatches(tree.groups[1], "work"));
});

test("hooks are never present at level 0 or level 1 (no AI summarisation — purely dropped text)", () => {
  const tree = parseIndexTree(GROUPED);
  for (const level of [0, 1]) {
    const out = renderLevel(tree, level);
    assert.doesNotMatch(out, /very long hook sentence/);
  }
  assert.match(renderLevel(tree, 2), /very long hook sentence/);
});

// ---------------------------------------------------------------------------------------------
// Measurement: demo/memory and the committed synthetic fixture (test/fixtures/synthetic-index-70.md)

test("measurement: demo/memory/MEMORY.md — level 0 tokens vs the full index", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "demo", "memory", "MEMORY.md"), "utf8");
  const tree = parseIndexTree(text);
  const full = estimateTokens(text);
  const l0 = estimateTokens(renderLevel(tree, 0));
  assert.ok(l0 <= full, `level 0 (${l0}) must never exceed the full index (${full})`);
});

test("measurement: synthetic-index-70.md (8 groups, ~70 lines, no private data) — level 0 stays well under the full index", () => {
  const text = fs.readFileSync(path.join(__dirname, "fixtures", "synthetic-index-70.md"), "utf8");
  const tree = parseIndexTree(text);
  assert.strictEqual(tree.groups.length, 8);
  const full = estimateTokens(text);
  const l0 = estimateTokens(renderLevel(tree, 0));
  const l1 = estimateTokens(renderLevel(tree, 1));
  assert.ok(l0 < full, `level 0 (${l0}) should be well under the full index (${full})`);
  assert.ok(l0 <= l1, "level 0 (one compact line per group) must never be bigger than level 1's block form");
});
