// 0.5.0 review: hubHint never treats the index note or an archived note as a hub, and never
// recommends an archived part (same exclusions as duplicateHint).
const test = require("node:test");
const assert = require("node:assert");
const { hubPartsFor } = require("../lib/levers/hub-hint");

function fakeIndex(notes) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  return {
    note: (id) => byId.get(id) || null,
    noteText: (id) => (byId.get(id) || {}).text || null,
    allNotes: () => notes,
    resolve: (ref) => (byId.has(ref) ? ref : null),
    isArchive: (id) => !!(byId.get(id) || {}).archived,
  };
}

test("hubHint: an archived part is never recommended, a live one still is", () => {
  const idx = fakeIndex([
    { id: "hub", label: "hub", text: "# Hub\n\n## Parts\n- [[live-part]] — current\n- [[old-part]] — old\n" },
    { id: "live-part", label: "live-part", text: "Up: [[hub]]\n" },
    { id: "old-part", label: "old-part", archived: true, text: "Up: [[hub]]\n" },
  ]);
  assert.deepStrictEqual(hubPartsFor(idx, "hub").map((p) => p.id), ["live-part"]);
});

test("hubHint: the index note and an archived note are never hubs", () => {
  const idx = fakeIndex([
    { id: "MEMORY", label: "MEMORY", theme: "index", text: "# Index\n\n## Parts\n- [[a]] — a\n" },
    { id: "a", label: "a", text: "---\npart_of: MEMORY\n---\n" },
    { id: "arch-hub", label: "arch-hub", archived: true, text: "## Parts\n- [[a]] — a\n" },
  ]);
  assert.deepStrictEqual(hubPartsFor(idx, "MEMORY"), []);
  assert.deepStrictEqual(hubPartsFor(idx, "arch-hub"), []);
});

test("hubHint: the part_of fallback skips archived declarers", () => {
  const idx = fakeIndex([
    { id: "hub", label: "hub", text: "# Hub, no parts list\n" },
    { id: "p1", label: "p1", text: "---\npart_of: hub\n---\n" },
    { id: "p2", label: "p2", archived: true, text: "---\npart_of: hub\n---\n" },
  ]);
  assert.deepStrictEqual(hubPartsFor(idx, "hub").map((p) => p.id), ["p1"]);
});
