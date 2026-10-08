"use strict";
// "Trim the index" (lib/index-trim.js) — pure planner. Shortens an over-length index hook only when
// the dropped text is provably still reachable (the note's own description/body, or a new
// `description:` line this same plan would also write); otherwise the line is left exactly as is.
const test = require("node:test");
const assert = require("node:assert");
const it_ = require("../lib/index-trim");
const { planIndexTrim, candidateTargets, shortenHook, detailKept, setDescription, LINE_RE } = it_;

// `lineNo` in a plan is relative to the index note's BODY (frontmatter stripped) — same convention
// as lib/hub-spoke.js / lib/assistant/tidy.js. These two helpers let a test find "that" line and
// check "that" hook's length without re-deriving the module's own cutting logic.
function bodyLinesOf(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (m ? text.slice(m[0].length) : text).split(/\r?\n/);
}
function hookLenOf(reconstructedLine) {
  const m = LINE_RE.exec(reconstructedLine);
  return m ? m[4].length : -1;
}

// ---- shortenHook: the deterministic cut itself ----

test("shortenHook: cuts at the last clause boundary that keeps the result between 20 and maxChars", () => {
  const hook = "Project long: build the pipeline, ship the dashboard, and write the docs";
  const kept = shortenHook(hook, 40);
  assert.strictEqual(kept, "Project long: build the pipeline");
  assert.ok(kept.length <= 40 && kept.length >= 20);
  // The spec's own example: a long hook with an em-dash clause near the end.
  const real = "memglow: open-source product from the Memory tab, github.com/R0zumnik/memglow — releases, publishing, diffusion, backlog";
  const keptReal = shortenHook(real, 90);
  assert.strictEqual(keptReal, "memglow: open-source product from the Memory tab, github.com/R0zumnik/memglow — releases");
  assert.ok(keptReal.length <= 90);
});

test("shortenHook: falls back to the last word boundary when no clause separator qualifies", () => {
  const hook = "This is a long hook without any punctuation at all that just keeps going and going";
  const kept = shortenHook(hook, 30);
  assert.strictEqual(kept, "This is a long hook without");
  assert.ok(kept.length <= 30);
  assert.ok(!/[,;:(]/.test(kept), "no clause separator was available to cut at");
});

test("shortenHook: a single word longer than maxChars is hard-cut, no ellipsis", () => {
  const kept = shortenHook("Supercalifragilisticexpialidocioussupercalifragilisticexpialidocious and more words after", 20);
  assert.strictEqual(kept, "Supercalifragilistic");
  assert.strictEqual(kept.length, 20);
  assert.ok(!kept.includes("…") && !kept.includes("..."));
});

// ---- detailKept: the loss check ----

test("detailKept: true when nothing significant was dropped, or the haystack has ≥80% of the dropped words", () => {
  assert.strictEqual(detailKept("", "anything"), true, "nothing dropped");
  assert.strictEqual(detailKept("and the", "anything"), true, "only stop-words/short words dropped");
  assert.strictEqual(detailKept("ship v2, write docs, and plan the launch", "needs a longer hook: ship v2, write docs, and plan the launch event"), true);
  assert.strictEqual(detailKept("ship v2, write docs, and plan the launch", "a completely unrelated sentence about gardening"), false);
  assert.strictEqual(detailKept("something", null), false);
  assert.strictEqual(detailKept("something", ""), false);
});

// ---- candidateTargets: which notes a caller must read ----

test("candidateTargets: only single-link bullet/hook lines, never a multi-link or prose line", () => {
  const text = [
    "- [[a]] — short",
    "- [[b]] and [[c]] — too many links",
    "Prose mentioning [[d]] in passing",
    "- [[e]] — another one",
    "## Heading, not a bullet",
  ].join("\n");
  assert.deepStrictEqual(candidateTargets(text).sort(), ["a", "e"]);
});

// ---- setDescription: the note-side edit ----

test("setDescription: inserts one description line, the rest of an existing frontmatter untouched", () => {
  const before = "---\ntitle: alpha\ntheme: projects\n---\nBody text.\n";
  const after = setDescription(before, "Full original hook text", "\n");
  assert.strictEqual(after, "---\ntitle: alpha\ntheme: projects\ndescription: \"Full original hook text\"\n---\nBody text.\n");
});

test("setDescription: a note with no frontmatter at all gets a brand new one", () => {
  const after = setDescription("Just a body, no frontmatter at all.\n", "Full original hook", "\n");
  assert.strictEqual(after, "---\ndescription: \"Full original hook\"\n---\n\nJust a body, no frontmatter at all.\n");
});

test("setDescription: YAML-safe quoting of a hook containing a quote or backslash", () => {
  const after = setDescription("---\ntitle: x\n---\nBody.\n", 'A "quoted" word and a \\backslash', "\n");
  assert.match(after, /description: "A \\"quoted\\" word and a \\\\backslash"/);
});

// ---- planIndexTrim: the whole plan, every scenario in one realistic fixture ----

function fixture() {
  const indexText = [
    "---",
    "title: MEMORY",
    "---",
    "",
    "# Memory index",
    "- [[alpha]] — Alpha note on its own, nothing more to say about it here",
    "- [[beta]] — This beta project needs a longer hook: ship v2, write docs, and plan the launch event",
    "- [[gamma]] — Gamma handles: backups, snapshots, restores, and the nightly off-site sync job for storage",
    "- [[delta]] — Delta already has a totally different short description that does not cover this at all extra words",
    "- [[zeta]] — unresolved note target here with a hook long enough to exceed the limit for testing purposes yes",
    "- [[alpha]] and [[gamma]] are linked — a multi-link sentence that should remain untouched no matter its length at all",
    "See [[beta]] in passing, this is prose not a bullet candidate line at all and quite long too for good measure",
    "- [[alpha]] — short one, untouched",
  ].join("\n") + "\n";
  const notes = [
    { id: "alpha", rel: "alpha.md", text: "---\ntitle: alpha\n---\nAlpha body, nothing relevant.\n" },
    { id: "beta", rel: "beta.md", text: "---\ntitle: beta\ndescription: \"This beta project needs a longer hook: ship v2, write docs, and plan the launch event\"\n---\nBeta body.\n" },
    { id: "gamma", rel: "gamma.md", text: "---\ntitle: gamma\n---\nGamma body talks about backups, snapshots, restores and the nightly off-site sync job already.\n" },
    { id: "delta", rel: "delta.md", text: "---\ntitle: delta\ndescription: \"A totally different short description\"\n---\nDelta body has nothing about extra words either.\n" },
  ];
  return { indexText, notes };
}

test("planIndexTrim: a short line is left untouched (not even reported)", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  assert.ok(!plan.lines.some((l) => l.id === "alpha" && l.before.includes("short one")));
  assert.ok(!plan.skipped.some((s) => indexText.split("\n")[s.lineNo] && indexText.split("\n")[s.lineNo].includes("short one")));
});

test("planIndexTrim: heading, prose and multi-link lines are left untouched, not even listed", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const bodyLines = bodyLinesOf(indexText);
  const touchedLineNos = new Set(plan.lines.map((l) => l.lineNo).concat(plan.skipped.map((s) => s.lineNo)));
  bodyLines.forEach((l, i) => {
    if (/^#/.test(l) || /^See \[\[/.test(l) || /\]\] and \[\[/.test(l)) assert.ok(!touchedLineNos.has(i), `line ${i} (${JSON.stringify(l)}) must be untouched`);
  });
  assert.ok(bodyLines.some((l) => /^#/.test(l)) && bodyLines.some((l) => /^See \[\[/.test(l)), "sanity: the fixture really has a heading and a prose line");
});

test("planIndexTrim: an unresolved link is skipped with a reason, the line stays exactly as is", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const bodyLines = bodyLinesOf(indexText);
  const zetaLine = bodyLines.findIndex((l) => l.includes("[[zeta]]"));
  assert.deepStrictEqual(plan.skipped.find((s) => s.lineNo === zetaLine), { lineNo: zetaLine, reason: "unresolved link" });
  assert.ok(!plan.lines.some((l) => l.id === "zeta"));
  assert.strictEqual(bodyLinesOf(plan.indexAfter)[zetaLine], bodyLines[zetaLine]);
});

test("planIndexTrim: detail already in the note's description → kept, the note itself is never touched", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const line = plan.lines.find((l) => l.id === "beta");
  assert.strictEqual(line.keptInNote, "description");
  assert.ok(hookLenOf(line.after) <= 40 && hookLenOf(line.after) >= 0);
  assert.ok(line.after.length < line.before.length);
  assert.ok(!plan.movedDescriptions.some((m) => m.id === "beta"));
});

test("planIndexTrim: detail already in the note's body (no description) → kept, the note itself is never touched", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const line = plan.lines.find((l) => l.id === "gamma");
  assert.strictEqual(line.keptInNote, "body");
  assert.ok(!plan.movedDescriptions.some((m) => m.id === "gamma"));
});

test("planIndexTrim: no description at all → the note also gets one (full original hook), frontmatter otherwise byte-identical", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const line = plan.lines.find((l) => l.id === "alpha" && l.keptInNote === "moved");
  assert.ok(line, "alpha's longer line was moved");
  const moved = plan.movedDescriptions.find((m) => m.id === "alpha");
  assert.ok(moved);
  const before = notes.find((n) => n.id === "alpha").text;
  assert.strictEqual(moved.before, before);
  assert.strictEqual(moved.after, "---\ntitle: alpha\ndescription: \"Alpha note on its own, nothing more to say about it here\"\n---\nAlpha body, nothing relevant.\n");
  // Byte-identical except for the one inserted line.
  assert.strictEqual(moved.after.replace('description: "Alpha note on its own, nothing more to say about it here"\n', ""), before);
});

test("planIndexTrim: a different, insufficient description → skipped, nothing written anywhere", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const deltaLine = bodyLinesOf(indexText).findIndex((l) => l.includes("[[delta]]"));
  assert.deepStrictEqual(plan.skipped.find((s) => s.lineNo === deltaLine), { lineNo: deltaLine, reason: "detail not in note" });
  assert.ok(!plan.lines.some((l) => l.id === "delta"));
  assert.ok(!plan.movedDescriptions.some((m) => m.id === "delta"));
});

test("planIndexTrim: tokensBefore/tokensAfter cover the WHOLE index note, after is smaller", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  assert.ok(plan.tokensBefore > plan.tokensAfter);
  const { estimateTokens } = require("../lib/cost");
  assert.strictEqual(plan.tokensBefore, estimateTokens(indexText));
  assert.strictEqual(plan.tokensAfter, estimateTokens(plan.indexAfter));
});

test("planIndexTrim: a custom tokenize function is used instead of the default estimator", () => {
  const { indexText, notes } = fixture();
  const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
  const plan = planIndexTrim({ indexText, notes, maxChars: 40, tokenize: words });
  assert.strictEqual(plan.tokensBefore, words(indexText));
  assert.strictEqual(plan.tokensAfter, words(plan.indexAfter));
});

test("planIndexTrim: idempotent — planning the already-trimmed output (and updated notes) finds nothing left to do", () => {
  const { indexText, notes } = fixture();
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  const notes2 = notes.map((n) => {
    const moved = plan.movedDescriptions.find((m) => m.id === n.id);
    return moved ? { ...n, text: moved.after } : n;
  });
  const plan2 = planIndexTrim({ indexText: plan.indexAfter, notes: notes2, maxChars: 40 });
  assert.strictEqual(plan2.lines.length, 0, "nothing left to shorten");
  // The two lines left untouched the first time (an unresolved link, an insufficient description)
  // are still exactly as untouched the second time — same reasons, same line numbers.
  assert.deepStrictEqual(plan2.skipped, plan.skipped);
  assert.strictEqual(plan2.indexAfter, plan.indexAfter);
});

// ---- French text with accents ----

test("planIndexTrim: French text with accents — cut and loss-check both Unicode-aware", () => {
  const indexText = [
    "# Index",
    "- [[projet-maison]] — Projet maison : rénover la cuisine, repeindre le salon, et finir la terrasse cet été",
  ].join("\n") + "\n";
  const notes = [
    { id: "projet-maison", rel: "projet-maison.md", text: "---\ntitle: projet-maison\ndescription: \"Projet maison : rénover la cuisine, repeindre le salon, et finir la terrasse cet été\"\n---\nRien de plus à ajouter.\n" },
  ];
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  assert.strictEqual(plan.lines.length, 1);
  const line = plan.lines[0];
  assert.strictEqual(line.keptInNote, "description");
  assert.ok(hookLenOf(line.after) <= 40 && hookLenOf(line.after) >= 0);
  assert.ok(/rénover/.test(line.after), "accented word kept intact, not mangled by the cut");
});

// ---- Windows line endings ----

test("planIndexTrim: Windows (CRLF) line endings are preserved end to end", () => {
  const indexText = [
    "# Index",
    "- [[alpha]] — Alpha needs a hook long enough to exceed the forty character limit here",
    "- [[beta]] — short",
  ].join("\r\n") + "\r\n";
  const notes = [
    { id: "alpha", rel: "alpha.md", text: "---\r\ntitle: alpha\r\n---\r\nNothing relevant in the body at all.\r\n" },
  ];
  const plan = planIndexTrim({ indexText, notes, maxChars: 40 });
  assert.ok(plan.indexAfter.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(plan.indexAfter), "every newline stays \\r\\n, none turned into a bare \\n");
  assert.strictEqual(plan.movedDescriptions[0].after.includes("\r\n"), true);
  assert.ok(!/[^\r]\n/.test(plan.movedDescriptions[0].after));
});
