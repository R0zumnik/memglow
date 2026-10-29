"use strict";
// lib/auto-duplicates.js — DUPLICATES (0.5.5, Part B): cheap pair detection (reusing
// lib/levers/duplicate-hint.js), AI confirmation, report-only default, optional autoMerge with
// the "never across different hubs" rule and the merge zero-loss check.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const dup = require("../lib/auto-duplicates");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeSrv(notes, cfg) {
  const root = tmp("memglow-auto-dup-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, duplicates: { enabled: false, ...cfg } });
  return { root, srv, cleanup: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

// noteWords() (lib/levers/duplicate-hint.js) looks at id + title + description — NEVER the body
// — so the fixtures below give each note a REALISTIC, overlapping title/description (cheap
// metadata-only detection, by design: see the module's own doc).
function note(title, description, frontmatterExtra, body) {
  return `---\ntitle: ${title}\ndescription: ${description}\ntheme: knowledge\n${frontmatterExtra}---\n\n${body}\n`;
}

test("duplicatesSettings: off by default, env MEMGLOW_AUTO_DUPLICATES=1 / MEMGLOW_AUTO_DUPLICATES_MERGE=1", () => {
  const off = dup.duplicatesSettings({}, {});
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.autoMerge, false);
  const on = dup.duplicatesSettings({}, { MEMGLOW_AUTO_DUPLICATES: "1" });
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.autoMerge, false, "autoMerge is its own, separate flag");
  const merge = dup.duplicatesSettings({ enabled: true }, { MEMGLOW_AUTO_DUPLICATES_MERGE: "1" });
  assert.strictEqual(merge.autoMerge, true);
});

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

test("parseDecision: validates shape, rejects a missing/invalid keep", () => {
  assert.deepStrictEqual(dup.parseDecision('{"duplicate":true,"keep":"a","reason":"same topic"}'), { duplicate: true, keep: "a", reason: "same topic" });
  assert.throws(() => dup.parseDecision('{"duplicate":true,"keep":"c"}'));
  assert.throws(() => dup.parseDecision("not json"));
});

test("hubOf: null when no declared part_of", () => {
  assert.strictEqual(dup.hubOf({ frontmatter: {} }), null);
  assert.strictEqual(dup.hubOf({ frontmatter: { part_of: "hub" } }), "hub");
});

test("worker: disabled is inert", () => {
  const w = dup.createDuplicatesWorker({ store: {}, config: { enabled: false } });
  assert.strictEqual(w.inert, true);
  w.start(); w.stop();
});

test("worker: default behaviour is REPORT ONLY — a confirmed duplicate is listed in status().reported, no file is touched", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing", "", "Body A."),
    "memory/coffee-b.md": note("Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing", "", "Body B."),
  }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = dup.createDuplicatesWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ duplicate: true, keep: "a", reason: "same subject" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "report only: nothing applied");
    const st = w.status();
    assert.strictEqual(st.reported.length, 1);
    assert.strictEqual(st.reported[0].duplicate, true);
    assert.strictEqual(st.reported[0].merged, false);
  } finally { cleanup(); }
});

test("worker: autoMerge true + SAME declared hub — merges (ADD-only heading + verbatim body), stub keeps its own frontmatter, zero-loss", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/hub.md": note("Hub", "The hub", "", "## Parts\n- [[coffee-a]] — a\n- [[coffee-b]] — b\n"),
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing", "part_of: hub\n", "Espresso grind size and timing notes."),
    "memory/coffee-b.md": note("Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing", "part_of: hub\n", "Espresso grind size and timing notes, extended with more detail."),
  }, { enabled: true, autoMerge: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = dup.createDuplicatesWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, autoMerge: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ duplicate: true, keep: "a", reason: "same subject" }) }),
    });
    const applied = await w.scanOnce();
    assert.strictEqual(applied.length, 1);
    // findDuplicatePairs' own (a, b) order is a detail (token-size/alphabetical) — the AI's
    // "keep" answer is relative to THAT pair order, so resolve which file actually ended up kept
    // vs. merged-away from status().reported rather than assuming "a" means the literal file
    // "coffee-a".
    const st = w.status();
    assert.strictEqual(st.reported.length, 1);
    const entry = st.reported[0];
    const keptId = entry.keep === "a" ? entry.a : entry.b;
    const otherId = entry.keep === "a" ? entry.b : entry.a;
    const keptText = fs.readFileSync(path.join(srv.store.root, `memory/${keptId}.md`), "utf8");
    assert.match(keptText, new RegExp(`## Merged from \\[\\[${otherId}\\]\\]`));
    assert.match(keptText, /extended with more detail/, "the other note's body was appended verbatim (zero-loss)");
    assert.match(keptText, /Espresso grind size and timing notes\./, "the kept note's OWN original body is still there");
    const stubText = fs.readFileSync(path.join(srv.store.root, `memory/${otherId}.md`), "utf8");
    assert.match(stubText, /^---\n/, "the stub keeps its own frontmatter");
    assert.match(stubText, /part_of: hub/);
    assert.match(stubText, new RegExp(`Merged into \\[\\[${keptId}\\]\\]\\.`));
    assert.doesNotMatch(stubText, /extended with more detail/, "the content itself moved out of the stub");
  } finally { cleanup(); }
});

test("worker: autoMerge true but NO declared hub (or different hubs) — never auto-merges, reports only", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing", "", "Body A."),
    "memory/coffee-b.md": note("Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing", "", "Body B, extended."),
  }, { enabled: true, autoMerge: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = dup.createDuplicatesWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, autoMerge: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ duplicate: true, keep: "a", reason: "same subject" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "no declared hub on either side: never auto-merged");
    const st = w.status();
    assert.strictEqual(st.reported.length, 1);
    assert.strictEqual(st.reported[0].merged, false);
    const untouchedB = fs.readFileSync(path.join(srv.store.root, "memory/coffee-b.md"), "utf8");
    assert.match(untouchedB, /Body B, extended\./, "never rewritten");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): maxChecksPerScan caps AI CALLS themselves (default 5), independent of maxActionsPerScan/autoMerge", async () => {
  const notesFiles = {};
  const names = ["alpha", "beta", "gamma", "delta"]; // C(4,2) = 6 candidate pairs, all strongly overlapping
  for (const n of names) {
    notesFiles[`memory/coffee-${n}.md`] = note(`Espresso Grind Timing ${n}`, "Grind size and timing for espresso brewing", "", `Body of ${n}.`);
  }
  const { srv, cleanup } = makeSrv(notesFiles, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = dup.createDuplicatesWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, // maxChecksPerScan defaults to 5
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ duplicate: false, keep: "a", reason: "related but distinct" }) }; },
    });
    await w.scanOnce();
    assert.ok(calls <= 5, `expected at most 5 AI calls (maxChecksPerScan), got ${calls}`);
    assert.strictEqual(calls, 5, "6 candidate pairs exist: the cap actually bites");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): a parent/child (part_of) pair is excluded before any AI call, even with strong title/description overlap", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/hub.md": note("Espresso Grind Timing Hub", "Grind size and timing for espresso brewing", "", "## Parts\n- [[coffee-a]] — a\n"),
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing for espresso brewing", "part_of: hub\n", "Body A."),
  }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = dup.createDuplicatesWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ duplicate: true, keep: "a", reason: "x" }) }; },
    });
    await w.scanOnce();
    assert.strictEqual(calls, 0, "hub.md and its own part coffee-a: never treated as a duplicate pair");
  } finally { cleanup(); }
});

test("worker (0.5.5): every verdict is cached by the PAIR's content hash across a worker restart", async () => {
  const dataDir = tmp("memglow-auto-dup-cache-");
  const { srv, cleanup } = makeSrv({
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing", "", "Body A."),
    "memory/coffee-b.md": note("Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing", "", "Body B."),
  }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const aiRun = async () => { calls++; return { ok: true, text: JSON.stringify({ duplicate: false, keep: "a", reason: "related but distinct" }) }; };
    const w1 = dup.createDuplicatesWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w1.scanOnce();
    w1.stop();
    assert.strictEqual(calls, 1);

    const w2 = dup.createDuplicatesWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    const st2 = w2.status();
    assert.strictEqual(st2.reported.length, 0, "the cache does not pre-populate reported — only a fresh scan does");
    await w2.scanOnce();
    assert.strictEqual(calls, 1, "cached across the restart: no new AI call for the unchanged pair");
    assert.strictEqual(w2.status().reported.length, 1, "but the cached verdict is still reported this scan");
  } finally { cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
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

test("significantWordsOf: drops GENERIC_WORDS and bare numbers/dates, keeps everything else", () => {
  const words = dup.significantWordsOf({ id: "x", label: "Espresso memglow 2026-09-01 Project Notes", description: "42 grind" });
  assert.ok(words.includes("espresso") && words.includes("grind"));
  assert.ok(!words.includes("memglow") && !words.includes("project") && !words.includes("notes"));
  assert.ok(!words.some((w) => /^\d+$/.test(w) || /^\d{4}-\d{2}-\d{2}$/.test(w)));
});

test("worker (0.5.5 bug fix): cache hits are SILENT — no per-pair log line, but one summary line per scan", async () => {
  const dataDir = tmp("memglow-auto-dup-silent-");
  const { srv, cleanup } = makeSrv({
    "memory/coffee-a.md": note("Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing", "", "Body A."),
    "memory/coffee-b.md": note("Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing", "", "Body B."),
  }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const aiRun = async () => ({ ok: true, text: JSON.stringify({ duplicate: false, keep: "a", reason: "related but distinct" }) });
    const w1 = dup.createDuplicatesWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w1.scanOnce();
    w1.stop();

    const logs = [];
    const w2 = dup.createDuplicatesWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, log: (s) => logs.push(s), config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w2.scanOnce();
    assert.ok(!logs.some((l) => /not-duplicate/.test(l)), "no per-pair log line for a cache hit");
    assert.ok(logs.some((l) => /1 cached verdict reused/.test(l)), "one summary line for the scan");
    assert.strictEqual(w2.status().reported.length, 1, "the panel/API still reflects the current scan");
  } finally { cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
