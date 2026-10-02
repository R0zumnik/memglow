"use strict";
// Hub-and-spoke detection (lib/hub-spoke.js): pure, no fs, no AI. Fixtures below are plain data —
// { id, label, body } records, the same shape lib/assistant/tidy.js builds from lib/memory.js.
const test = require("node:test");
const assert = require("node:assert");
const { detect, isPureSiblingLine, parseLines } = require("../lib/hub-spoke");

/** A small memory: one real hub ("project-x") with three sub-notes, a stand-alone note, and the
 * index listing the hub, one of its sub-notes directly (redundant) and the stand-alone note. */
function baseNotes() {
  return [
    {
      id: "index", label: "Index",
      body: [
        "# Memory index",
        "- [[project-x]]: summary of the project.",
        "- [[project-x-api]]: the API part (should not be here too — covered by project-x).",
        "- [[standalone-note]]: a note on its own.",
      ].join("\n"),
    },
    {
      id: "project-x", label: "Project X",
      body: [
        "Summary of project X.",
        "- [[project-x-api]]: the API design.",
        "- [[project-x-infra]]: infrastructure notes.",
        "- [[project-x-orphan]]: never links back (missing uplink).",
      ].join("\n"),
    },
    {
      id: "project-x-api", label: "Project X — API",
      body: [
        "The API design.",
        "Back to [[project-x]].",
        "Siblings: [[project-x-orphan]], [[project-x-unlisted]]",
      ].join("\n"),
    },
    {
      id: "project-x-infra", label: "Project X — infra",
      body: [
        "Infrastructure notes.",
        "Back to [[project-x]].",
        "As discussed in [[project-x-orphan]] and [[project-x-unlisted]], the deploy pipeline reuses the same cluster.",
      ].join("\n"),
    },
    {
      // Never links back to project-x: triggers (d) missingUplinks, and project-x already lists it.
      id: "project-x-orphan", label: "Project X — orphan",
      body: ["Some content with no backlink at all."].join("\n"),
    },
    {
      // Links to the hub, but the hub does not list it: triggers (e) missingHubLines.
      id: "project-x-unlisted", label: "Project X — unlisted",
      body: ["This note is about project X.", "See [[project-x]] for the summary."].join("\n"),
    },
    {
      id: "standalone-note", label: "Standalone note",
      body: ["Just a note on its own, no hub.", "Mentions [[project-x-infra]] once, in passing."].join("\n"),
    },
  ];
}

test("hub-spoke: detects the hub and its sub-notes (>= 2 mutual links)", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.strictEqual(r.hubs.length, 1);
  const hub = r.hubs[0];
  assert.strictEqual(hub.id, "project-x");
  // Every note connected either way is a sub-note, even one-directional stragglers.
  assert.deepStrictEqual(hub.subNotes, ["project-x-api", "project-x-infra", "project-x-orphan", "project-x-unlisted"].sort());
});

test("hub-spoke: (b) index entry for a sub-note of an already-listed hub is redundant", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.deepStrictEqual(r.indexRedundant, [{ note: "project-x-api", hub: "project-x" }]);
});

test("hub-spoke: a stand-alone note listed in the index STAYS (no hub relation)", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.ok(!r.indexRedundant.some((x) => x.note === "standalone-note"));
});

test("hub-spoke: (c) a pure 'Siblings:' line is flagged pure (safe to delete deterministically)", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  const line = r.siblingLines.find((l) => l.note === "project-x-api");
  assert.ok(line, "expected a sibling line on project-x-api");
  assert.strictEqual(line.pure, true);
  assert.deepStrictEqual(line.links.sort(), ["project-x-orphan", "project-x-unlisted"].sort());
});

test("hub-spoke: (c) sibling links inside real prose are ambiguous (pure: false, needs an AI)", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  const line = r.siblingLines.find((l) => l.note === "project-x-infra" && /discussed in/.test(l.text));
  assert.ok(line, "expected the prose sibling line on project-x-infra");
  assert.strictEqual(line.pure, false);
});

test("hub-spoke: a single in-text cross-link to one other note is never flagged", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  // standalone-note mentions project-x-infra once, one-directional, in passing: not a sibling line
  // (that rule needs >= 2 links on the line), and the mention alone is not enough to make it a
  // mutual, hub-worthy relationship. It generates no finding at all — this cross-link is legitimate
  // and must stay exactly as written.
  assert.ok(!r.siblingLines.some((l) => l.note === "standalone-note"));
  assert.strictEqual(r.hubs.some((h) => h.id === "standalone-note" || h.id === "project-x-infra"), false);
});

test("hub-spoke: (d) a sub-note the hub lists but which never links back gets a missing uplink", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.deepStrictEqual(r.missingUplinks, [{ hub: "project-x", note: "project-x-orphan" }]);
});

test("hub-spoke: (e) a sub-note that links to the hub but is never listed gets a missing hub line", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.deepStrictEqual(r.missingHubLines, [{ hub: "project-x", note: "project-x-unlisted" }]);
});

test("hub-spoke: counts summarise every finding, for a dashboard or the MCP server", () => {
  const r = detect({ notes: baseNotes(), indexId: "index" });
  assert.deepStrictEqual(r.counts, {
    hubs: 1,
    indexRedundant: 1,
    siblingLines: 2,
    pureSiblingLines: 1,
    missingUplinks: 1,
    missingHubLines: 1,
  });
});

test("hub-spoke: a note needs >= 2 mutual links to count as a hub (one is just a normal link)", () => {
  const notes = [
    { id: "a", label: "A", body: "Links to [[b]]." },
    { id: "b", label: "B", body: "Links back to [[a]]." },
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 0);
});

test("hub-spoke: links inside fenced or inline code are ignored, and line numbering survives a fence", () => {
  const notes = [
    { id: "hub", label: "Hub", body: "Intro.\n\n```\n[[not-a-real-link]]\nmore code\n```\n\n- [[a]]\n- [[b]]" },
    { id: "a", label: "A", body: "Back to [[hub]]." },
    { id: "b", label: "B", body: "Back to [[hub]]." },
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 1);
  assert.deepStrictEqual(r.hubs[0].subNotes, ["a", "b"]);
});

test("hub-spoke: an unknown indexId or empty notes never throws", () => {
  assert.doesNotThrow(() => detect({ notes: [], indexId: "index" }));
  assert.doesNotThrow(() => detect({ notes: baseNotes(), indexId: "does-not-exist" }));
  assert.doesNotThrow(() => detect({}));
});

test("isPureSiblingLine: labels, bullets and separators are all tolerated", () => {
  assert.strictEqual(isPureSiblingLine("Siblings: [[a]], [[b]]"), true);
  assert.strictEqual(isPureSiblingLine("- See also: [[a]] · [[b]]"), true);
  assert.strictEqual(isPureSiblingLine("**Related:** [[a]] and [[b]]"), true);
  assert.strictEqual(isPureSiblingLine("This note and [[a]] and [[b]] share a root cause."), false);
});

test("parseLines: one entry per physical line, links filtered later by the caller", () => {
  const lines = parseLines("a\n[[b]]\nc");
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines[1].links, ["b"]);
});

test("hub-spoke: determinism — same input twice gives byte-identical output", () => {
  const a = detect({ notes: baseNotes(), indexId: "index" });
  const b = detect({ notes: baseNotes(), indexId: "index" });
  const strip = (r) => JSON.stringify(r, (k, v) => (k === "_internal" ? undefined : v));
  assert.strictEqual(strip(a), strip(b));
});
