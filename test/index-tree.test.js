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

test("renderLevel level 0/1 with hubIds: a group WITH a confirmed hub lists only that hub", () => {
  const tree = parseIndexTree(GROUPED);
  const hubIds = new Set(["hub-a", "hub-b"]);
  const l0 = renderLevel(tree, 0, { hubIds });
  assert.strictEqual(l0, "Work: hub-a\nFamily: hub-b");
});

test("renderLevel 0.5.1.4: a group with NO confirmed hub falls back to its own entries (never silent), capped with +N more", () => {
  const tree = parseIndexTree(GROUPED); // Family has 3 entries, cap (ENTRY_CAP) is 4: no "+more" needed here
  const l1 = renderLevel(tree, 1, { hubIds: new Set() }); // no confirmed hub anywhere
  assert.strictEqual(l1, "## Work\n- hub-a\n- note-a1\n\n## Family\n- hub-b\n- note-b1\n- note-b2");
  const l0 = renderLevel(tree, 0, { hubIds: new Set() });
  assert.strictEqual(l0, "Work: hub-a, note-a1\nFamily: hub-b, note-b1, note-b2");
});

test("renderLevel 0.5.1.4: a group's entry list beyond ENTRY_CAP is capped, with a trailing +N more (level 0 and level 1)", () => {
  const { ENTRY_CAP } = require("../lib/index-tree");
  const lines = ["## Big"];
  for (let i = 0; i < ENTRY_CAP + 3; i++) lines.push(`- [[note-${i}]] — hook ${i}`);
  const tree = parseIndexTree(lines.join("\n"));
  const l0 = renderLevel(tree, 0);
  assert.strictEqual(l0, `Big: ${Array.from({ length: ENTRY_CAP }, (_, i) => `note-${i}`).join(", ")}, +3 more`);
  const l1 = renderLevel(tree, 1);
  assert.match(l1, /- \+3 more$/);
  assert.strictEqual(l1.split("\n").length, 1 + ENTRY_CAP + 1); // heading + capped entries + "+N more"
});

test("renderLevel: titleOf() maps an entry's link target to a display title", () => {
  const tree = parseIndexTree(GROUPED);
  const titleOf = (id) => ({ "hub-a": "Hub A (nice title)" }[id] || id);
  const l0 = renderLevel(tree, 0, { titleOf, hubIds: new Set(["hub-a"]) });
  // Family has no confirmed hub: falls back to its own entries (titleOf has no mapping for them,
  // so they render as their bare id — this exercises the id-fallback half of titleOf, not just hub-a's).
  assert.strictEqual(l0, "Work: Hub A (nice title)\nFamily: hub-b, note-b1, note-b2");
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

// ---------------------------------------------------------------------------------------------
// 0.5.1.4 regression: coverage (no group ever renders silent) and boundedness (~300 tokens) when
// hub-spoke confirms NO hub anywhere — the realistic case against a real, conservatively-detected
// memory, per the cold reviewer's NO-GO.

test("0.5.1.4: level 0 on synthetic-index-70.md, with hub-spoke confirming ZERO hubs anywhere, stays ≈300 tokens and names every group", () => {
  const text = fs.readFileSync(path.join(__dirname, "fixtures", "synthetic-index-70.md"), "utf8");
  const tree = parseIndexTree(text);
  const l0 = renderLevel(tree, 0, { hubIds: new Set() }); // the worst case: detection ran and found nothing
  const tokens = estimateTokens(l0);
  assert.ok(tokens <= 300, `level 0 (${tokens} tokens) should stay close to the ~300-token target even with zero confirmed hubs`);
  const byLine = l0.split("\n");
  assert.strictEqual(byLine.length, tree.groups.length, "one line per group, none dropped");
  for (const line of byLine) assert.doesNotMatch(line, /^[^:]+$/, "every group lists SOMETHING, never just its bare label");
});
