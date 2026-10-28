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
    { id: "coffee-brewing-tips", label: "Coffee Brewing Tips", description: "espresso grind size timing" },
    { id: "espresso-grind-notes", label: "Espresso Grind Notes", description: "espresso grind size timing extraction" },
    { id: "unrelated-note", label: "Unrelated Note", description: "garden watering schedule" },
  ];
  const pairs = dup.findDuplicatePairs(notes);
  assert.ok(pairs.some((p) => [p.a, p.b].sort().join() === ["coffee-brewing-tips", "espresso-grind-notes"].sort().join()));
  assert.ok(!pairs.some((p) => p.a === "unrelated-note" || p.b === "unrelated-note"));
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
