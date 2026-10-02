"use strict";
// Hub-and-spoke detection (lib/hub-spoke.js): pure, no fs, no AI. Fixtures below are plain data —
// { id, label, text, folder } records, the same shape lib/assistant/tidy.js and server.js build
// from lib/memory.js (`text` = the note's FULL raw content, frontmatter included).
//
// CONSERVATIVE BY DESIGN (see the long comment at the top of lib/hub-spoke.js): a hub/spoke
// relationship is only ever confirmed through an explicit marker (frontmatter `part_of`/`parent`,
// or a header-line phrasing near the top of the body) or, failing that, a narrow structural
// fallback that additionally requires same folder and a closed incoming-link set. Mutual links
// between independent notes — a person's profile, their family, a feedback note, a reference note
// all citing each other — must NEVER make one of them the "hub" of another: that was the exact
// bug this rewrite fixes (found by running the first version on a real 72-note memory, where it
// invented 33 "hubs" where there were really 4, including turning the user's own profile note into
// a sub-note of an unrelated feedback note).
const test = require("node:test");
const assert = require("node:assert");
const { detect, isPureSiblingLine, parseLines, declaredHubOf } = require("../lib/hub-spoke");

const note = (id, label, folder, text) => ({ id, label, folder, text });
const fm = (body, extra) => "---\ntitle: " + body.split("\n")[0].slice(0, 20) + "\n" + (extra || "") + "---\n" + body;

// ---------------------------------------------------------------------------------------------
// declaredHubOf(): the explicit-marker lookup on its own, every accepted phrasing and some that
// must NOT match.

test("declaredHubOf: frontmatter part_of / parent, quoted or bare, wins over everything else", () => {
  assert.strictEqual(declaredHubOf("---\npart_of: project-x\n---\nBody mentioning [[something-else]].\n"), "project-x");
  assert.strictEqual(declaredHubOf("---\nparent: \"project-x\"\n---\nBody.\n"), "project-x");
  assert.strictEqual(declaredHubOf("---\npart_of: [[project-x]]\n---\nBody.\n"), "project-x");
});

test("declaredHubOf: header-line phrasings near the top of the body", () => {
  assert.strictEqual(declaredHubOf("Part of the project notes, split on 2026-10-02 from [[project-x]] (grew too large).\n"), "project-x");
  assert.strictEqual(declaredHubOf("> Split on 2026-10-02 (part 2/3) from [[project-x]]. More text.\n"), "project-x");
  assert.strictEqual(declaredHubOf("Some intro.\n\nSummary: [[project-x]].\n"), "project-x");
  assert.strictEqual(declaredHubOf("Up: [[project-x]]\n\nDetails below.\n"), "project-x");
});

test("declaredHubOf: a 'part of'/'summary' deep in the text, or far from the top, is not a declaration", () => {
  assert.strictEqual(declaredHubOf("This note discusses, as part of a broader plan, [[project-x]] and other things.\n"), null);
  const farDown = "Line 1.\nLine 2.\nLine 3.\nLine 4.\nLine 5.\nLine 6.\nPart of [[project-x]].\n";
  assert.strictEqual(declaredHubOf(farDown), null, "past the first few lines: not scanned");
  assert.strictEqual(declaredHubOf("No marker here, just [[a]] and [[b]].\n"), null);
  assert.strictEqual(declaredHubOf(""), null);
});

// ---------------------------------------------------------------------------------------------
// detect(): explicit markers are trusted outright — a confirmed hub, its findings, and a
// stand-alone note mentioned alongside it in the index that must NEVER be touched.

function markedNotes() {
  return [
    note("index", "Index", "", [
      "# Memory index",
      "- [[project-x]]: summary of the project.",
      "- [[project-x-api]]: the API part (redundant with project-x).",
      "- [[standalone-note]]: a note on its own.",
    ].join("\n")),
    note("project-x", "Project X", "work", [
      "Summary of project X.",
      "- [[project-x-api]]: the API design.",
      "- [[project-x-infra]]: infrastructure notes.",
    ].join("\n")),
    note("project-x-api", "Project X — API", "work", fm([
      "The API design.",
      "Back to [[project-x]].",
      "Siblings: [[project-x-infra]], [[project-x-orphan]]",
    ].join("\n"), "part_of: project-x\n")),
    note("project-x-infra", "Project X — infra", "work", fm([
      "Infrastructure notes.",
      "Back to [[project-x]].",
      "As discussed in [[project-x-api]] and [[project-x-orphan]], the deploy pipeline reuses the same cluster.",
    ].join("\n"), "part_of: project-x\n")),
    // Declared via frontmatter (not a header line, which would itself be a [[link]] to the hub
    // and defeat this very test): confirmed as a sub-note, but its body never links back.
    note("project-x-orphan", "Project X — orphan", "work", fm("Never adds the body back-link (missing uplink).", "part_of: project-x\n")),
    note("project-x-unlisted", "Project X — unlisted", "work", "Part of [[project-x]].\n\nThe hub never lists this one (missing hub line)."),
    note("standalone-note", "Standalone note", "misc", [
      "Just a note on its own, no hub.",
      "Mentions [[project-x-infra]] once, in passing — a legitimate cross-link that must stay.",
    ].join("\n")),
  ];
}

test("hub-spoke: an explicit marker (part_of / header line) confirms the hub, no structural proof needed", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.strictEqual(r.hubs.length, 1);
  const hub = r.hubs[0];
  assert.strictEqual(hub.id, "project-x");
  assert.deepStrictEqual(hub.subNotes, ["project-x-api", "project-x-infra", "project-x-orphan", "project-x-unlisted"].sort());
});

test("hub-spoke: (b) index entry for a confirmed sub-note of an already-listed hub is redundant", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.deepStrictEqual(r.indexRedundant, [{ note: "project-x-api", hub: "project-x" }]);
});

test("hub-spoke: a stand-alone note listed in the index STAYS, even though it cross-links a sub-note", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.ok(!r.indexRedundant.some((x) => x.note === "standalone-note"));
  assert.ok(!r.hubs.some((h) => h.id === "standalone-note"));
});

test("hub-spoke: (c) a pure 'Siblings:' line among CONFIRMED siblings is flagged pure", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  const line = r.siblingLines.find((l) => l.note === "project-x-api");
  assert.ok(line, "expected a sibling line on project-x-api");
  assert.strictEqual(line.pure, true);
  assert.deepStrictEqual(line.links.sort(), ["project-x-infra", "project-x-orphan"].sort());
});

test("hub-spoke: (c) sibling links inside real prose are ambiguous (pure: false, needs an AI)", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  const line = r.siblingLines.find((l) => l.note === "project-x-infra" && /discussed in/.test(l.text));
  assert.ok(line, "expected the prose sibling line on project-x-infra");
  assert.strictEqual(line.pure, false);
});

test("hub-spoke: a single in-text cross-link to one other note, from a note with no hub of its own, is never flagged", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.ok(!r.siblingLines.some((l) => l.note === "standalone-note"));
});

test("hub-spoke: (d) a marked sub-note that never links back gets a missing uplink", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.deepStrictEqual(r.missingUplinks, [{ hub: "project-x", note: "project-x-orphan" }]);
});

test("hub-spoke: (e) a marked sub-note the hub never lists gets a missing hub line", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.deepStrictEqual(r.missingHubLines, [{ hub: "project-x", note: "project-x-unlisted" }]);
});

test("hub-spoke: counts summarise every finding, for a dashboard or the MCP server", () => {
  const r = detect({ notes: markedNotes(), indexId: "index" });
  assert.deepStrictEqual(r.counts, {
    hubs: 1, indexRedundant: 1, siblingLines: 2, pureSiblingLines: 1, missingUplinks: 1, missingHubLines: 1,
  });
});

// ---------------------------------------------------------------------------------------------
// Structural fallback: accepted only when mutual AND same folder AND a closed incoming set, and
// with at least 2 such sub-notes. No marker anywhere in this fixture.

test("hub-spoke structural fallback: mutual links, same folder, closed incoming set, >= 2 sub-notes", () => {
  const notes = [
    note("hub", "Hub", "proj", "Summary.\n- [[hub-a]]\n- [[hub-b]]"),
    note("hub-a", "Hub A", "proj", "Back to [[hub]]. See also [[hub-b]]."),
    note("hub-b", "Hub B", "proj", "Back to [[hub]]."),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 1);
  assert.deepStrictEqual(r.hubs[0].subNotes, ["hub-a", "hub-b"]);
});

test("hub-spoke structural fallback: REJECTED when the sub-note is in a different folder", () => {
  const notes = [
    note("hub", "Hub", "proj", "Summary.\n- [[hub-a]]\n- [[hub-b]]"),
    note("hub-a", "Hub A", "proj", "Back to [[hub]]."),
    note("hub-b", "Hub B", "elsewhere", "Back to [[hub]]."),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 0, "hub-b's folder differs: no structural hub at all (only 1 same-folder candidate left)");
});

test("hub-spoke structural fallback: REJECTED when an outside note also links to a candidate sub-note", () => {
  const notes = [
    note("hub", "Hub", "proj", "Summary.\n- [[hub-a]]\n- [[hub-b]]"),
    note("hub-a", "Hub A", "proj", "Back to [[hub]]."),
    note("hub-b", "Hub B", "proj", "Back to [[hub]]."),
    // An independent note citing hub-b: hub-b's incoming set is no longer closed to {hub, hub-a, hub-b}.
    note("outsider", "Outsider", "other", "See [[hub-b]] for details."),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 0, "hub-b is cited from outside the group: the whole candidate group is rejected");
});

test("hub-spoke structural fallback: REJECTED with only one mutual, same-folder candidate", () => {
  const notes = [
    note("hub", "Hub", "proj", "Summary.\n- [[hub-a]]"),
    note("hub-a", "Hub A", "proj", "Back to [[hub]]."),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 0, "one mutual link alone proves nothing");
});

test("hub-spoke: mutual links between independent, richly cross-linked notes are NEVER a hub (the bug this rewrite fixes)", () => {
  // Two "people" notes that happen to link to each other twice over, from different folders and
  // each also cited from elsewhere — exactly the shape that wrongly became a "hub" before.
  const notes = [
    note("user-a", "User A", "user", "Mentions [[user-b]] and [[feedback-x]]."),
    note("user-b", "User B", "user", "Mentions [[user-a]] and [[reference-y]]."),
    note("feedback-x", "Feedback X", "feedback", "Cites [[user-a]]."),
    note("reference-y", "Reference Y", "reference", "Cites [[user-b]]."),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 0);
  assert.deepStrictEqual(r.indexRedundant, []);
  assert.deepStrictEqual(r.missingUplinks, []);
  assert.deepStrictEqual(r.missingHubLines, []);
});

// ---------------------------------------------------------------------------------------------
// Regression (synthetic, no owner text): ~10 stand-alone notes that cross-link each other heavily
// across several folders (profile / family / feedback / reference, mirroring a real memory's
// shape), plus ONE real hub with 3 explicitly marked parts in its own folder. Expected: only that
// hub is found, and not a single stand-alone note is ever touched.

function denseStandaloneAndOneRealHub() {
  const notes = [];
  // A ring of 10 independent notes across 4 "areas", each linking to its neighbour and to one or
  // two notes elsewhere in the ring — ordinary content cross-links, no markers, no structure.
  const ring = [
    ["user-profile", "user"], ["user-family", "user"], ["user-partner", "user"],
    ["feedback-style", "feedback"], ["feedback-autonomy", "feedback"], ["feedback-safety", "feedback"],
    ["reference-admin", "reference"], ["reference-network", "reference"],
    ["project-travel", "misc"], ["project-finance", "misc"],
  ];
  ring.forEach(([id, folder], i) => {
    const next = ring[(i + 1) % ring.length][0];
    const prev = ring[(i - 1 + ring.length) % ring.length][0];
    notes.push(note(id, id, folder, `About ${id}. See [[${next}]] and, for background, [[${prev}]].`));
  });
  // The index lists every stand-alone note AND the real hub.
  const indexLines = ["# Index"].concat(ring.map(([id]) => `- [[${id}]]: about ${id}.`), ["- [[project-real-hub]]: the only real hub."]);
  notes.push(note("index", "Index", "", indexLines.join("\n")));
  // One real hub, 3 marked parts, its own folder — untouched by the ring above.
  notes.push(note("project-real-hub", "Project (real hub)", "realhub", "Summary.\n- [[project-real-hub-a]]\n- [[project-real-hub-b]]\n- [[project-real-hub-c]]"));
  notes.push(note("project-real-hub-a", "Part A", "realhub", fm("Part A content.\nBack to [[project-real-hub]].", "part_of: project-real-hub\n")));
  notes.push(note("project-real-hub-b", "Part B", "realhub", fm("Part B content.\nBack to [[project-real-hub]].", "part_of: project-real-hub\n")));
  notes.push(note("project-real-hub-c", "Part C", "realhub", fm("Part C content.\nBack to [[project-real-hub]].", "part_of: project-real-hub\n")));
  return notes;
}

test("regression: a dense ring of stand-alone notes never becomes a hub; only the one real, marked hub is found", () => {
  const r = detect({ notes: denseStandaloneAndOneRealHub(), indexId: "index" });
  assert.strictEqual(r.hubs.length, 1, "exactly one hub: " + JSON.stringify(r.hubs.map((h) => h.id)));
  assert.strictEqual(r.hubs[0].id, "project-real-hub");
  assert.deepStrictEqual(r.hubs[0].subNotes, ["project-real-hub-a", "project-real-hub-b", "project-real-hub-c"]);
  // Zero index removals among the ring notes — only the hub's own 3 parts are even eligible, and
  // none of them is separately listed in the index (so nothing is redundant there either).
  assert.deepStrictEqual(r.indexRedundant, []);
  assert.deepStrictEqual(r.missingUplinks, []);
  assert.deepStrictEqual(r.missingHubLines, []);
  assert.deepStrictEqual(r.siblingLines, []);
});

// ---------------------------------------------------------------------------------------------
// Smaller invariants carried over from the line-parsing layer (unchanged by the hub/spoke rewrite).

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

test("hub-spoke: links inside fenced or inline code are ignored", () => {
  const notes = [
    note("hub", "Hub", "", fm("Intro.\n\n```\n[[not-a-real-link]]\nmore code\n```\n\n- [[a]]\n- [[b]]", "part_of: nothing\n")),
    note("a", "A", "", fm("Back to [[hub]].", "part_of: hub\n")),
    note("b", "B", "", fm("Back to [[hub]].", "part_of: hub\n")),
  ];
  const r = detect({ notes, indexId: null });
  assert.strictEqual(r.hubs.length, 1);
  assert.deepStrictEqual(r.hubs[0].subNotes, ["a", "b"]);
});

test("hub-spoke: an unknown indexId or empty notes never throws", () => {
  assert.doesNotThrow(() => detect({ notes: [], indexId: "index" }));
  assert.doesNotThrow(() => detect({ notes: markedNotes(), indexId: "does-not-exist" }));
  assert.doesNotThrow(() => detect({}));
});

test("hub-spoke: determinism — same input twice gives byte-identical output", () => {
  const a = detect({ notes: markedNotes(), indexId: "index" });
  const b = detect({ notes: markedNotes(), indexId: "index" });
  const strip = (r) => JSON.stringify(r, (k, v) => (k === "_internal" ? undefined : v));
  assert.strictEqual(strip(a), strip(b));
});
