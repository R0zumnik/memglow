"use strict";
// lib/duplicate-candidates.js — the lexical pre-filter kept from the old AI duplicates worker (0.6.0).
const test = require("node:test");
const assert = require("node:assert");
const dup = require("../lib/duplicate-candidates");

test("findDuplicatePairs: cheap title/description overlap, deduped, ranked", () => {
  const notes = [
    { id: "coffee-a", label: "Espresso Grind Timing Notes", description: "Grind size and timing notes for espresso brewing" },
    { id: "coffee-b", label: "Espresso Grind Timing Guide", description: "Grind size and timing guide for espresso brewing" },
    { id: "unrelated-note", label: "Unrelated Note", description: "garden watering schedule" },
  ];
  const pairs = dup.findDuplicatePairs(notes);
  assert.ok(pairs.some((p) => [p.a, p.b].sort().join() === ["coffee-a", "coffee-b"].sort().join()));
  assert.ok(!pairs.some((p) => p.a === "unrelated-note" || p.b === "unrelated-note"));
});

test("findDuplicatePairs (0.5.5 bug fix): tighter than the duplicateHint lever's own thresholds — a weak, merely-generic overlap no longer matches", () => {
  // feedback-autonomy-and-safety vs project-memglow-v04-strategy (the real-KB false positive):
  // generic words only ("notes", "project", "feedback") never clear MIN_SHARED/MIN_COVERAGE now.
  const notes = [
    { id: "feedback-autonomy-and-safety", label: "Feedback: autonomy and safety", description: "Notes on project feedback about autonomy and safety concerns" },
    { id: "project-memglow-v04-strategy", label: "Project memglow v0.4 strategy", description: "Notes on project roadmap and release strategy" },
  ];
  const pairs = dup.findDuplicatePairs(notes);
  assert.deepStrictEqual(pairs, []);
});

test("findDuplicatePairs (0.5.5 bug fix): ignores generic words (memglow, project, note, dates, bare numbers) in the overlap — the real-KB false positive no longer matches even with those words shared", () => {
  const notes = [
    { id: "feedback-autonomy-and-safety", label: "Feedback: autonomy and safety", description: "Notes on the memglow project, dated 2026-09-01, entry 2" },
    { id: "project-memglow-v04-strategy", label: "Project memglow v0.4 strategy", description: "Notes on the memglow project, dated 2026-09-02, entry 3" },
  ];
  // Every shared word here ("notes", "memglow", "project", "dated", the dates/numbers) is
  // generic — with them filtered out, there is nothing left to share.
  assert.deepStrictEqual(dup.findDuplicatePairs(notes), []);
});

test("findDuplicatePairs (0.5.5 bug fix): requires the SAME declared theme when BOTH notes set one — a strong word overlap is not enough across declared themes", () => {
  const notes = [
    { id: "reference-ha-automations", label: "Home Assistant Automations Reference", description: "Automation triggers and conditions reference", theme: "home-assistant" },
    { id: "project-automations-journal", label: "Automations Journal Project", description: "Automation triggers and conditions, project journal", theme: "project" },
  ];
  assert.deepStrictEqual(dup.findDuplicatePairs(notes), [], "different declared themes: excluded outright, whatever the word overlap");
  // 0.5.6: same theme is no longer enough on its own either — their titles only share
  // "automations" (1 word), so the SAME declared subtheme is what now clears the pair.
  const sameTheme = notes.map((n) => ({ ...n, theme: "home-assistant", subtheme: "automations" }));
  assert.strictEqual(dup.findDuplicatePairs(sameTheme).length, 1, "same theme + same subtheme: the pair is found as before");
  const sameThemeNoSubtheme = notes.map((n) => ({ ...n, theme: "home-assistant" }));
  assert.deepStrictEqual(dup.findDuplicatePairs(sameThemeNoSubtheme), [], "0.5.6: same theme alone, no subtheme match and < 2 shared title words — no longer enough");
});

test("findDuplicatePairs (0.5.6 bug fix): a feedback/* note is NEVER paired with a project/* one, whatever they share", () => {
  const notes = [
    { id: "feedback-autonomy-boundaries", label: "Autonomy boundaries feedback", description: "Florent's feedback on autonomy, scope and decision boundaries for the project", theme: "work", subtheme: "process" },
    { id: "project-memglow-v04-strategy", label: "Autonomy boundaries project strategy", description: "Strategy notes on autonomy, scope and decision boundaries for the project", theme: "work", subtheme: "process" },
  ];
  // Both the same declared theme AND subtheme, and a strong title overlap — every other gate
  // would pass this pair; the feedback/project family guard alone must still rule it out.
  assert.deepStrictEqual(dup.findDuplicatePairs(notes), []);
  assert.strictEqual(dup.familyOf("feedback-autonomy-boundaries"), "feedback");
  assert.strictEqual(dup.familyOf("project-memglow-v04-strategy"), "project");
  assert.strictEqual(dup.neverPaired("feedback-autonomy-boundaries", "project-memglow-v04-strategy"), true);
});

test("findDuplicatePairs (0.5.6 bug fix): two project/* notes sharing only the broad theme 'project' (and, here, an identical masked-secret placeholder — both mention tokens/secrets so maskSecrets collapses their whole id+label+description line the same way, a real false-positive source on its own), different subthemes and no real title overlap, are no longer paired", () => {
  const notes = [
    { id: "project-memglow-v04-strategy", label: "Memglow v0.4 strategy", description: "Strategy covering memglow api token rotation and secrets handling for the project", theme: "project", subtheme: "memglow" },
    { id: "project-r0zumnik-hub-bento-shares-secrets", label: "R0zumnik hub bento shares and secrets", description: "How the r0zumnik project hub shares bento config and secrets handling", theme: "project", subtheme: "r0zumnik" },
  ];
  // Sanity: the pre-existing (theme/word-overlap) gates alone DO still pass this pair — both
  // notes' own content masks to the identical secret placeholder, a 100% "overlap" on its own.
  const sameSubtheme = notes.map((n) => ({ ...n, subtheme: "shared-infra" }));
  assert.strictEqual(dup.findDuplicatePairs(sameSubtheme).length, 1, "same subtheme: the older gates alone already pass this pair");
  // With their REAL, different subthemes and titles that share nothing, the new guard excludes it.
  assert.deepStrictEqual(dup.findDuplicatePairs(notes), [], "different subthemes, no title overlap: no longer paired");
});

test("findDuplicatePairs (0.5.8 bug fix): never pairs two notes of the same split family — one slug is a '-'-bounded prefix of the other's", () => {
  const notes = [
    { id: "project-ibs-initiatives-europe", label: "IBS initiatives Europe", description: "IBS initiatives for Europe" },
    { id: "project-ibs-initiatives-europe-silvae-market-decks", label: "IBS initiatives Europe Silvae", description: "IBS initiatives for Europe Silvae" },
  ];
  // Sanity: every pre-existing gate here (shared words, coverage, title overlap) already
  // passes this pair on its own — only the new split-family guard rules it out.
  assert.deepStrictEqual(dup.findDuplicatePairs(notes), []);
  assert.strictEqual(dup.sameSplitFamily("project-ibs-initiatives-europe", "project-ibs-initiatives-europe-silvae-market-decks"), true);
  assert.strictEqual(dup.sameSplitFamily("coffee-a", "coffee-abc"), false, "no '-' boundary: not a split family by id alone");
});

test("findDuplicatePairs (0.5.8 bug fix): never pairs two notes sharing the same declared part_of when one slug starts with the other's (even without a '-' boundary)", () => {
  const withPartOf = [
    { id: "alpha", label: "Alpha project beta notes shared", description: "Alpha project beta notes shared", partOf: "hub-x" },
    { id: "alphabeta", label: "Alpha project beta notes shared extra", description: "Alpha project beta notes shared extra", partOf: "hub-x" },
  ];
  assert.deepStrictEqual(dup.findDuplicatePairs(withPartOf), [], "same part_of + slug-prefix: excluded");
  const noPartOf = withPartOf.map((n) => ({ ...n, partOf: null }));
  assert.strictEqual(dup.findDuplicatePairs(noPartOf).length, 1, "without a shared part_of, the id-prefix alone (no '-' boundary) is NOT enough to exclude");
  const differentPartOf = [{ ...withPartOf[0], partOf: "hub-x" }, { ...withPartOf[1], partOf: "hub-y" }];
  assert.strictEqual(dup.findDuplicatePairs(differentPartOf).length, 1, "different part_of: not the same split family either");
});

test("significantWordsOf: drops GENERIC_WORDS and bare numbers/dates, keeps everything else", () => {
  const words = dup.significantWordsOf({ id: "x", label: "Espresso memglow 2026-09-01 Project Notes", description: "42 grind" });
  assert.ok(words.includes("espresso") && words.includes("grind"));
  assert.ok(!words.includes("memglow") && !words.includes("project") && !words.includes("notes"));
  assert.ok(!words.some((w) => /^\d+$/.test(w) || /^\d{4}-\d{2}-\d{2}$/.test(w)));
});
