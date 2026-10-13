"use strict";
// Lever 17 (stateView, "journal → current state view", 0.5.1.2) — pure unit tests of
// lib/levers/state-view.js: no fs, no createLevers, just extractHeadingDate/inferYears/
// classifySections/buildStateView against hand-built markdown text. Integration through
// lib/proxy-levers.js (memglow_fresh/memglow_section, alreadyLoaded/dedupe/deltaRead, the
// all-in-one vs proxy equivalence) is test/state-view-levers.test.js.
const test = require("node:test");
const assert = require("node:assert");
const SV = require("../lib/levers/state-view");
const { journalChantier } = require("./fixtures/journal-chantier");

const DAY_MS = 86400000;
const filler = (n, tag) => Array.from({ length: n }, (_, i) => `detail line ${tag || ""} ${i} about the works here.`).join(" ") + "\n";

function note(sections, { intro = "Suivi.", undated = [] } = {}) {
  const lines = ["---", "title: Journal Test", "theme: projects", "---", "", intro, ""];
  for (const u of undated) lines.push(`## ${u.title}`, u.body || "undated content here", "");
  for (const s of sections) lines.push(`## ${s.title}`, s.body || filler(40, s.title), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// extractHeadingDate: FR / EN / mixed formats

test("extractHeadingDate: ISO, DD/MM/YYYY, DD/MM, FR 'D mon.', EN 'Mon D, YYYY'", () => {
  assert.deepStrictEqual(SV.extractHeadingDate("Chantier en cours (2026-10-11)"), { year: 2026, month: 10, day: 11 });
  assert.deepStrictEqual(SV.extractHeadingDate("0.4.10.7 in production (2026-10-12)"), { year: 2026, month: 10, day: 12 });
  assert.deepStrictEqual(SV.extractHeadingDate("as of 12/10/2026"), { year: 2026, month: 10, day: 12 });
  assert.deepStrictEqual(SV.extractHeadingDate("Mise à jour 12/10"), { year: null, month: 10, day: 12 });
  assert.deepStrictEqual(SV.extractHeadingDate("État au 5/10 soir"), { year: null, month: 10, day: 5 });
  assert.deepStrictEqual(SV.extractHeadingDate("12 oct."), { year: null, month: 10, day: 12 });
  assert.deepStrictEqual(SV.extractHeadingDate("5 novembre 2026"), { year: 2026, month: 11, day: 5 });
  assert.deepStrictEqual(SV.extractHeadingDate("Update Oct 12, 2026"), { year: 2026, month: 10, day: 12 });
  assert.deepStrictEqual(SV.extractHeadingDate("as of October 12"), { year: null, month: 10, day: 12 });
});

test("extractHeadingDate: no date at all, or out-of-range numbers, -> null (never guesses)", () => {
  assert.strictEqual(SV.extractHeadingDate("Règles"), null);
  assert.strictEqual(SV.extractHeadingDate("Parts"), null);
  assert.strictEqual(SV.extractHeadingDate("Objectifs 2026"), null);
  assert.strictEqual(SV.extractHeadingDate("v1.2.3 release notes"), null);
  assert.strictEqual(SV.extractHeadingDate("13/13"), null, "month 13 is not a month");
  assert.strictEqual(SV.extractHeadingDate("32/1"), null, "day 32 is not a day");
});

// ---------------------------------------------------------------------------------------------
// inferYears: mtime anchor, document order, year wraparound

test("inferYears: a single yearless date anchored just before mtime keeps the anchor's own year", () => {
  const mtimeMs = Date.UTC(2026, 9, 13); // 2026-10-13
  const [d] = SV.inferYears([{ year: null, month: 10, day: 12 }], mtimeMs);
  assert.strictEqual(d.year, 2026);
});

test("inferYears: a yearless date that would be AFTER mtime falls back to the previous year", () => {
  const mtimeMs = Date.UTC(2026, 9, 13); // 2026-10-13
  const [d] = SV.inferYears([{ year: null, month: 10, day: 15 }], mtimeMs); // 15 Oct > 13 Oct
  assert.strictEqual(d.year, 2025);
});

test("inferYears: document order resolves a December→January wrap across two yearless dates", () => {
  const mtimeMs = Date.UTC(2027, 0, 10); // 2027-01-10
  const [dec, jan] = SV.inferYears([{ year: null, month: 12, day: 28 }, { year: null, month: 1, day: 5 }], mtimeMs);
  assert.strictEqual(jan.year, 2027, "the later (document-order) heading sits in the anchor's own year");
  assert.strictEqual(dec.year, 2026, "the earlier heading, read backward from January, falls into the PREVIOUS year");
  assert.ok(dec.ts < jan.ts);
});

test("inferYears: an explicit year is always trusted, and anchors anything still earlier", () => {
  const mtimeMs = Date.UTC(2026, 9, 13);
  const [a, b] = SV.inferYears([{ year: null, month: 10, day: 2 }, { year: 2025, month: 10, day: 20 }], mtimeMs);
  assert.strictEqual(b.year, 2025, "explicit year kept as is");
  assert.strictEqual(a.year, 2025, "the yearless date before it is anchored on ITS year, not mtime's");
});

// ---------------------------------------------------------------------------------------------
// buildStateView: detection + composition

const MTIME = Date.UTC(2026, 9, 13); // "today" per the task's own system date, 2026-10-13

test("buildStateView: a journal-shaped FR note keeps intro + undated + 2 most recent dated sections, names the rest", () => {
  const text = note(
    [
      { title: "Mise à jour 2/9" }, { title: "État au 10/9 soir" }, { title: "Mise à jour 20/9" },
      { title: "Chantier en cours (2026-09-28)" }, { title: "État au 5/10 soir" }, { title: "Mise à jour 12/10" },
    ],
    { undated: [{ title: "Règles", body: "Toujours couper l'électricité." }, { title: "Parts", body: "- [[a]] — x" }] },
  );
  const sv = SV.buildStateView(text, { mtimeMs: MTIME, label: "Chantier", tool: "read_note" });
  assert.ok(sv, "qualifies as journal-like");
  assert.match(sv.kept, /## Règles/);
  assert.match(sv.kept, /## Parts/);
  assert.match(sv.kept, /## État au 5\/10 soir/);
  assert.match(sv.kept, /## Mise à jour 12\/10/);
  assert.doesNotMatch(sv.kept, /## Mise à jour 2\/9/, "an older section is not sent in full");
  assert.doesNotMatch(sv.kept, /## Mise à jour 20\/9/);
  assert.strictEqual(sv.olderCount, 4);
  assert.strictEqual(sv.recentCount, 2);
  assert.match(sv.summary, /^memglow: "Chantier" is a journal-style note/);
  assert.match(sv.summary, /4 older sections left out/);
  assert.match(sv.summary, /"Mise à jour 2\/9"/);
  assert.match(sv.summary, /"Chantier en cours \(2026-09-28\)"/);
  assert.match(sv.summary, /memglow_section/);
  assert.match(sv.summary, /memglow_fresh/);
  assert.ok(sv.savedTokens > 0.3 * sv.respTokens, "never hides silently AND actually saves something");
});

test("buildStateView: EN journal headings ('Update', 'as of') work the same way", () => {
  const text = note([
    { title: "Update 2026-09-02" }, { title: "as of 2026-09-10" }, { title: "Update 2026-09-20" },
    { title: "as of Sep 28, 2026" }, { title: "Status 10/5" }, { title: "Update 12/10" },
  ]);
  const sv = SV.buildStateView(text, { mtimeMs: MTIME, label: "Site log" });
  assert.ok(sv);
  assert.strictEqual(sv.datedCount, 6);
  assert.match(sv.kept, /## Update 12\/10/);
});

test("buildStateView: mixed FR/EN headings in the same note are all recognised", () => {
  const text = note([
    { title: "Mise à jour 2/9" }, { title: "Update 2026-09-10" }, { title: "État au 20/9 soir" },
    { title: "Chantier en cours (2026-09-28)" }, { title: "as of 5/10" }, { title: "Mise à jour 12/10" },
  ]);
  const sv = SV.buildStateView(text, { mtimeMs: MTIME });
  assert.ok(sv);
  assert.strictEqual(sv.datedCount, 6);
});

test("buildStateView: ordering — the 2 MOST RECENT are picked by actual DATE value, not by position in the file", () => {
  // Explicit years throughout (so year inference/chaining is not a factor here): the true most
  // recent date (2026-10-12) sits in the MIDDLE of the document, and the true second-most-recent
  // (2026-10-05) is NOT the last heading either.
  const text = note([
    { title: "Mise à jour (2026-09-02)" },
    { title: "Mise à jour (2026-10-12)" }, // most recent overall, but 2nd in the file
    { title: "État au (2026-09-10)" },
    { title: "Mise à jour (2026-09-20)" },
    { title: "Chantier en cours (2026-09-28)" },
    { title: "État au (2026-10-05)" }, // 2nd most recent overall, but LAST in the file
  ]);
  const sv = SV.buildStateView(text, { mtimeMs: MTIME });
  assert.ok(sv);
  assert.match(sv.kept, /## Mise à jour \(2026-10-12\)/, "the true latest date is kept, wherever it sits in the file");
  assert.match(sv.kept, /## État au \(2026-10-05\)/, "the true second-latest date is kept too");
  assert.doesNotMatch(sv.kept, /## Mise à jour \(2026-09-20\)/, "an older-by-date section is left out even if it sits later in the file than a kept one");
  assert.strictEqual(sv.olderCount, 4);
});

// ---------------------------------------------------------------------------------------------
// Fail-open cases

test("buildStateView: fails open (null) below the token threshold even with enough dated sections", () => {
  const text = note([{ title: "1/9", body: "short" }, { title: "2/9", body: "short" }, { title: "3/9", body: "short" }]);
  assert.strictEqual(SV.buildStateView(text, { mtimeMs: MTIME, minTokens: 1500 }), null);
});

test("buildStateView: fails open with fewer than 3 dated sections", () => {
  const text = note([{ title: "Mise à jour 2/9" }, { title: "Mise à jour 12/10" }], { undated: [{ title: "Règles" }] });
  assert.strictEqual(SV.buildStateView(text, { mtimeMs: MTIME, minTokens: 50 }), null);
});

test("buildStateView: fails open when headings carry no parseable date at all (plain prose headings)", () => {
  const text = note([{ title: "Premiers travaux" }, { title: "Suite du chantier" }, { title: "Derniers ajustements" }]);
  assert.strictEqual(SV.buildStateView(text, { mtimeMs: MTIME, minTokens: 50 }), null);
});

test("buildStateView: fails open when the saving would be under the minimum ratio", () => {
  // 3 dated sections, but almost everything is in the 2 kept "recent" ones: dropping the one
  // older section barely moves the needle.
  const text = note([
    { title: "Mise à jour 1/9", body: "tiny old entry" },
    { title: "Mise à jour 1/10", body: filler(200, "recent-a") },
    { title: "Mise à jour 12/10", body: filler(200, "recent-b") },
  ]);
  assert.strictEqual(SV.buildStateView(text, { mtimeMs: MTIME, minTokens: 50 }), null);
});

test("buildStateView: fails open on an empty/blank note", () => {
  assert.strictEqual(SV.buildStateView("", { mtimeMs: MTIME, minTokens: 10 }), null);
  assert.strictEqual(SV.buildStateView(null, { mtimeMs: MTIME, minTokens: 10 }), null);
});

// ---------------------------------------------------------------------------------------------
// The synthetic FR fixture (building-site log)

test("the synthetic FR fixture (journal-chantier) qualifies and keeps the 2 most recent updates", () => {
  const text = journalChantier({ fillerLines: 40 });
  const sv = SV.buildStateView(text, { mtimeMs: MTIME, label: "Chantier Rénovation Grange", tool: "read_note" });
  assert.ok(sv, "the fixture is shaped like a qualifying journal note");
  assert.match(sv.kept, /## Règles/);
  assert.match(sv.kept, /## Parts/);
  assert.match(sv.kept, /## État au 5\/10 soir/);
  assert.match(sv.kept, /## Mise à jour 12\/10/);
  assert.strictEqual(sv.olderCount, 4);
  assert.ok(sv.savedTokens > 0.3 * sv.respTokens);
  assert.ok(!/adresse réelle|nom de famille/.test(text), "no private data in the fixture");
});
