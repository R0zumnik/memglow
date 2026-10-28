"use strict";
// lib/auto-archive.js — PRUNE STALE → ARCHIVE (0.5.5, Part A): moveSections' pure partition is
// covered in test/split-engine.test.js; this file covers the worker (settings, scope reuse,
// idle, outline/[S#] resolution, create-vs-append, "left" verdicts, re-ask suppression).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const archive = require("../lib/auto-archive");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeSrv(notes, cfg) {
  const root = tmp("memglow-auto-archive-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, archive: { enabled: false, ...cfg } });
  return { root, srv, cleanup: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const NOTE = ["---", "title: ops", "theme: knowledge", "---", "",
  "## Current status", "Still going.", "",
  "## 2020-01-01 Old incident", "This is old.", "Resolved long ago.", "",
].join("\n");

test("archiveSettings: off by default, env MEMGLOW_AUTO_ARCHIVE=1 turns it on", () => {
  const off = archive.archiveSettings({}, {});
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.keepDays, archive.DEFAULTS.keepDays);
  const on = archive.archiveSettings({}, { MEMGLOW_AUTO_ARCHIVE: "1" });
  assert.strictEqual(on.enabled, true);
  const explicitOff = archive.archiveSettings({ enabled: true }, { MEMGLOW_AUTO_ARCHIVE: "0" });
  assert.strictEqual(explicitOff.enabled, false);
});

test("outline: [S#] ids, levels and the MOST RECENT date found IN THE HEADING LINE ONLY (never the body)", () => {
  const out = archive.outline("## 2020-01-01 Old incident\nResolved.\n\n## Current\nStill going.\n");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].date, "2020-01-01");
  assert.strictEqual(out[1].date, null);
  const multi = archive.outline("## Revised 2020-01-01, then 2024-06-15, then 2026-09-01\nBody.\n");
  assert.strictEqual(multi[0].date, "2026-09-01", "several dates IN THE HEADING: the latest wins, not the first");
  // 0.5.5 bug fix (fourth real-KB run): a date cited in the BODY is content, not the section's
  // own age — a heading with no date of its own stays date-less, however old the body reads.
  const bodyDates = archive.outline("## Firmware staged (sha256 verified on both sides)\nReleased 2025-04-03, then 2026-03-28; staged today.\n");
  assert.strictEqual(bodyDates[0].date, null, "the heading itself has no date — body dates never count");
});

test("resolveIndices: \"S<n>\" ids resolve to 0-based INDICES (never heading text), in outline order; unknown/duplicate ids dropped", () => {
  const heads = archive.outline("## Alpha\nx\n\n## Beta\ny\n");
  assert.deepStrictEqual(archive.resolveIndices(["S2", "S9", "Alpha", "S2"], heads), [1, 0]);
});

test("resolveIndices: a heading that appears TWICE can still be picked by index (0.5.5 bug fix — text-based lookup used to be ambiguous)", () => {
  const heads = archive.outline("## Status\nFirst.\n\n## Status\nSecond.\n");
  assert.strictEqual(heads.length, 2, "two identically-worded headings");
  assert.deepStrictEqual(archive.resolveIndices(["S2"], heads), [1]);
  // An exact-text fallback (no "S#" prefix) is only accepted when it names exactly ONE heading —
  // ambiguous here, so it resolves to nothing rather than guessing.
  assert.deepStrictEqual(archive.resolveIndices(["Status"], heads), []);
});

test("worker: disabled is inert", () => {
  const w = archive.createArchiveWorker({ store: {}, writer: {}, config: { enabled: false } });
  assert.strictEqual(w.inert, true);
  w.start(); w.stop();
});

test("worker: create-vs-append, zero-loss, and idempotent re-ask suppression — full round trip", async () => {
  const root = tmp("memglow-auto-archive-kb2-");
  const abs = path.join(root, "memory/ops.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, NOTE);
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, archive: { enabled: false } });
  try {
    let calls = 0;
    // minTokens: 0 — this test is about create-vs-append/zero-loss, not the size floor (its own
    // dedicated test below uses the tiny default-size fixture on purpose).
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed incident" }) }; },
    });
    await w.scanOnce();
    assert.strictEqual(calls, 1);
    const srcText = fs.readFileSync(abs, "utf8");
    assert.match(srcText, /Archived sections: see \[\[ops-archive\]\]\./);
    assert.doesNotMatch(srcText, /Old incident/);
    const archiveText = fs.readFileSync(path.join(root, "memory/ops-archive.md"), "utf8");
    assert.match(archiveText, /Old incident/);
    assert.match(archiveText, /Resolved long ago\./);
    assert.match(archiveText, /part_of: ops/);

    // A further archivable note, appended to the SAME existing archive note (never overwritten).
    fs.appendFileSync(abs, "\n## 2020-02-02 Another old thing\nAlso old.\n");
    srv.store.refreshNote && srv.store.refreshNote("memory/ops.md");
    const w2 = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "also closed" }) }),
    });
    await w2.scanOnce();
    const archiveText2 = fs.readFileSync(path.join(root, "memory/ops-archive.md"), "utf8");
    assert.match(archiveText2, /Old incident/, "the first archived section is still there (append, never overwrite)");
    assert.match(archiveText2, /Another old thing/);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker (0.5.5 bug fix): TWO IDENTICAL headings, BOTH with a heading date — archiving works by index, never refused as ambiguous", async () => {
  // Both headings are byte-identical ("## 2020-01-01 Status") — moveSections() (text-based)
  // would refuse this outright as ambiguous; moveSectionsByIndex() picks the SECOND one (S2)
  // by position alone. Each heading carries its own date (the new heading-only rule), so both
  // are independently eligible — this test is about the index resolution, not keepDays.
  const dupHeadingNote = ["---", "title: dup", "theme: knowledge", "---", "",
    "## 2020-01-01 Status", "Still relevant today, " + "word ".repeat(100), "",
    "## 2020-01-01 Status", "An old, closed incident. " + "word ".repeat(100), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/dup.md": dupHeadingNote }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed, second Status section" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, ["memory/dup.md"]);
    const srcText = fs.readFileSync(path.join(srv.store.root, "memory/dup.md"), "utf8");
    assert.match(srcText, /Still relevant today/, "the FIRST \"## 2020-01-01 Status\" (index 0 / S1) stays");
    assert.doesNotMatch(srcText, /old, closed incident/, "the SECOND \"## 2020-01-01 Status\" (index 1 / S2) moved, by index, not by text");
    const archiveText = fs.readFileSync(path.join(srv.store.root, "memory/dup-archive.md"), "utf8");
    assert.match(archiveText, /old, closed incident/);
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): minTokens — never archives a handful of lines into a brand-new note", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }); // default minTokens: 400
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, // minTokens defaults to 400
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed incident" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "the ≈15-token section never clears the 400-token floor");
    assert.strictEqual(fs.existsSync(path.join(srv.store.root, "memory/ops-archive.md")), false, "no new note created for it");
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/ops.md"), "utf8"), NOTE, "source left untouched");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): keepDays is enforced IN CODE — a section dated more recently than the cutoff is never archived, whatever the AI answered", async () => {
  const recent = ["---", "title: ops2", "theme: knowledge", "---", "",
    "## Current status", "Still going. " + "word ".repeat(200), "",
    "## 2026-10-01 Recent incident", "28 days ago — not old enough for a 60-day keepDays. " + "word ".repeat(200), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/ops2.md": recent }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], keepDays: 60, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    // now() fixed at 2026-10-29 — the incident (2026-10-01) is 28 days old, well under keepDays.
    const now = () => Date.parse("2026-10-29T00:00:00Z");
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" }, now,
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], keepDays: 60, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "AI mistakenly thinks this is old" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "code-enforced keepDays overrides the AI's own (wrong) answer");
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/ops2.md"), "utf8"), recent);
  } finally { cleanup(); }
});

test("worker (0.5.5): \"left\" verdicts are cached by CONTENT HASH across a worker restart — a daily scan of an unchanged note costs no AI call past the first", async () => {
  const dataDir = tmp("memglow-auto-archive-cache-");
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const aiRun = async () => { calls++; return { ok: true, text: JSON.stringify({ sections: [], reason: "nothing obsolete" }) }; };
    // minTokens: 0 — this test is about the restart cache, not the size pre-filter (its own test
    // covers that); NOTE's ~15-token old section would otherwise never clear the pre-filter at all.
    const w1 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w1.scanOnce();
    w1.stop(); // flushes the cache to disk
    assert.strictEqual(calls, 1);

    // A BRAND NEW worker instance (simulating a process restart), same data dir, same content.
    const w2 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w2.scanOnce();
    assert.strictEqual(calls, 1, "cached across the restart: no new AI call for unchanged content");
  } finally { cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("worker: the AI finds nothing obsolete — left alone, nothing written, and never re-asked again until the note itself changes", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    // minTokens: 0 — about re-ask suppression, not the size pre-filter.
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: [], reason: "nothing obsolete" }) }; },
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(calls, 1);
    await w.scanOnce();
    assert.strictEqual(calls, 1, "the note did not change since: never re-asked");
  } finally { cleanup(); }
});

test("worker: an auth error stops the scan and is surfaced in status().lastError, never retried", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: false, error: "401 unauthorized: invalid api key" }),
    });
    await w.scanOnce();
    const st = w.status();
    assert.ok(st.lastError && /unauthorized/i.test(st.lastError.message));
  } finally { cleanup(); }
});

test("oldSectionsTotal: sums only TOP-LEVEL sections (disjoint, never double-counted) whose latest date is <= cutoff", () => {
  const heads = archive.outline("## 2020-01-01 Old\nword ".padEnd(0) + "\n\n### Sub (nested, same old date)\n2020-01-01 too.\n\n## 2026-10-01 Recent\nStill fresh.\n");
  // top-level only: level-2 headings "Old" (old) and "Recent" (not old); the level-3 "Sub" is
  // skipped by the top-level filter (its own old date would otherwise double-count with "Old"'s).
  const total = archive.oldSectionsTotal(heads, "2026-08-29");
  const oldTop = heads.find((h) => h.level === 2 && h.date === "2020-01-01");
  assert.strictEqual(total, oldTop.tokens, "only the top-level \"Old\" section counts, not its nested Sub too");
});

test("worker (0.5.5 bug fix): the AI-free pre-filter skips a note with nothing old+big enough — SILENTLY, zero AI calls", async () => {
  // Same tiny fixture every other test in this file uses: a ~15-token old section never clears
  // the default minTokens (400) — the second real-KB bug: the AI used to be asked anyway.
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const logs = [];
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" }, log: (s) => logs.push(s),
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, // default minTokens: 400
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: ["S2"], reason: "x" }) }; },
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(calls, 0, "pre-filtered out before any AI call");
    assert.deepStrictEqual(logs, [], "skipped silently — no log line at all");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): maxChecksPerScan caps the AI CALLS themselves (default 5), independent of maxActionsPerScan", async () => {
  const big = (label, date) => ["---", `title: ${label}`, "theme: knowledge", "---", "",
    "## Current status", "Still going. " + "word ".repeat(150), "",
    `## ${date} Old incident`, "Closed long ago. " + "word ".repeat(500), "",
  ].join("\n");
  const notesFiles = {};
  for (let i = 0; i < 7; i++) notesFiles[`memory/ops${i}.md`] = big(`ops${i}`, "2020-01-01");
  const { srv, cleanup } = makeSrv(notesFiles, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, // maxChecksPerScan defaults to 5
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: [], reason: "nothing obsolete after all" }) }; },
    });
    await w.scanOnce();
    assert.ok(calls <= 5, `expected at most 5 AI calls (maxChecksPerScan), got ${calls}`);
    assert.strictEqual(calls, 5, "7 eligible notes exist: the cap actually bites");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): eligible candidates are ordered by old-tokens DESCENDING — the capped budget spends calls on the biggest gain first", async () => {
  const noteWith = (label, oldWords) => ["---", `title: ${label}`, "theme: knowledge", "---", "",
    "## Current status", "Still going.", "",
    "## 2020-01-01 Old incident", "word ".repeat(oldWords), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({
    "memory/small-old.md": noteWith("small-old", 150), // clears minTokens, smaller old-tokens total
    "memory/big-old.md": noteWith("big-old", 400), // clears minTokens, bigger old-tokens total
  }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const seen = [];
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], maxChecksPerScan: 1, provider: "anthropic", apiKeyEnv: "FAKE" }, // only ONE AI call allowed
      aiRun: async (prompt) => { seen.push(prompt); return { ok: true, text: JSON.stringify({ sections: [], reason: "x" }) }; },
    });
    await w.scanOnce();
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0], /"big-old"/, "the bigger old-tokens candidate is asked first when the budget only allows one");
  } finally { cleanup(); }
});

test("archiveSettings (0.5.5 bug fix): includeFolders defaults to [\"memory/project\"] — never feedback/, user/, reference/ — configurable via maintenance.archive.includeFolders", () => {
  assert.deepStrictEqual(archive.archiveSettings({}, {}).includeFolders, archive.DEFAULT_INCLUDE_FOLDERS);
  assert.deepStrictEqual(archive.archiveSettings({}, {}).includeFolders, ["memory/project"]);
  assert.deepStrictEqual(archive.archiveSettings({ includeFolders: ["memory/custom"] }, {}).includeFolders, ["memory/custom"]);
  assert.deepStrictEqual(archive.archiveSettings({}, { MEMGLOW_INCLUDE_FOLDERS: "memory/other" }).includeFolders, ["memory/other"]);
});

test("worker (0.5.5 bug fix): default scope — a feedback/ note is never a candidate, even with an old+big section; a memory/project/ note still is", async () => {
  const feedbackNote = ["---", "title: feedback-x", "theme: feedback", "---", "",
    "## Current status", "Still going.", "",
    "## 2020-01-01 Old incident", "word ".repeat(500), "",
  ].join("\n");
  const root = tmp("memglow-auto-archive-scope-");
  const feedbackAbs = path.join(root, "memory/feedback/feedback-x.md");
  const projectAbs = path.join(root, "memory/project/ops.md");
  fs.mkdirSync(path.dirname(feedbackAbs), { recursive: true }); fs.writeFileSync(feedbackAbs, feedbackNote);
  fs.mkdirSync(path.dirname(projectAbs), { recursive: true }); fs.writeFileSync(projectAbs, NOTE);
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, archive: { enabled: false } });
  try {
    let calls = 0;
    // No includeFolders given: the new default (["memory/project"]) applies.
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed" }) }; },
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, ["memory/project/ops.md"], "only the memory/project/ note is in scope by default");
    assert.strictEqual(fs.readFileSync(feedbackAbs, "utf8"), feedbackNote, "feedback/ untouched");
    assert.strictEqual(calls, 1, "only one AI call: the feedback/ note was never even a candidate");
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker (0.5.5 bug fix): maxShare (default 0.7) — never moves more than this share of the note's own body, even if minTokens/keepDays both clear", async () => {
  const mostlyOld = ["---", "title: journal", "theme: project", "---", "",
    "## Current status", "A little still active. " + "word ".repeat(20), "",
    "## 2020-01-01 Old log", "word ".repeat(500), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/project/journal.md": mostlyOld }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, // maxShare defaults to 0.7
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "the old section is ~96% of the body — over maxShare, never archived");
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/project/journal.md"), "utf8"), mostlyOld);
    assert.strictEqual(fs.existsSync(path.join(srv.store.root, "memory/project/journal-archive.md")), false);
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): maxShare allows a section that is a smaller, genuine fraction of the body", async () => {
  const mostlyCurrent = ["---", "title: journal2", "theme: project", "---", "",
    "## Current status", "word ".repeat(500), "",
    "## 2020-01-01 Old log", "word ".repeat(100), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/project/journal2.md": mostlyCurrent }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, minTokens: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, ["memory/project/journal2.md"], "~17% of the body: well under maxShare");
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix, fourth real-KB run): a heading with NO date, whose body cites old dates, is NEVER eligible — even if the AI picks it", async () => {
  const firmwareNote = ["---", "title: project-zigbee-coordinator-firmware", "theme: project", "---", "",
    "## Firmware staged (sha256 verified on both sides)",
    "Released 2025-04-03, then 2026-03-28; staged and verified today. " + "word ".repeat(200), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/project/firmware.md": firmwareNote }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      // minTokens left at its 0.7-default-adjacent default (not 0): the point is that the
      // pre-filter finds NOTHING with a heading date at all (oldTokens stays 0), regardless of
      // minTokens's own value.
      config: { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => { calls++; return { ok: true, text: JSON.stringify({ sections: ["S1"], reason: "looks old from the cited dates" }) }; },
    });
    const applied = await w.scanOnce();
    assert.strictEqual(calls, 0, "the AI-free pre-filter already finds nothing with a heading date — never even asks");
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/project/firmware.md"), "utf8"), firmwareNote, "untouched — body-cited dates never make a dateless heading eligible");
    assert.strictEqual(fs.existsSync(path.join(srv.store.root, "memory/project/firmware-archive.md")), false);
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): cache hits are SILENT — no per-note log line, but one summary line per scan", async () => {
  const dataDir = tmp("memglow-auto-archive-silent-");
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const aiRun = async () => ({ ok: true, text: JSON.stringify({ sections: [], reason: "nothing obsolete" }) });
    // minTokens: 0 — NOTE's own old section is tiny; this test needs the AI actually asked (and
    // its "left" verdict cached), not pre-filtered out before ever reaching it.
    const w1 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, minTokens: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w1.scanOnce();
    w1.stop();

    const logs = [];
    const w2 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, log: (s) => logs.push(s), config: { enabled: true, idleMinutes: 0, minTokens: 0, includeFolders: ["memory"], provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w2.scanOnce();
    assert.ok(!logs.some((l) => /\bleft\b/.test(l)), "no per-note \"left\" log line for a cache hit");
    assert.ok(logs.some((l) => /1 cached verdict reused/.test(l)), "one summary line for the scan");
  } finally { cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
