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

test("outline: [S#] ids, levels and the MOST RECENT date found (not merely the first)", () => {
  const out = archive.outline("## 2020-01-01 Old incident\nResolved.\n\n## Current\nStill going.\n");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].date, "2020-01-01");
  assert.strictEqual(out[1].date, null);
  const multi = archive.outline("## Log\nStarted 2020-01-01, revisited 2024-06-15, closed 2026-09-01.\n");
  assert.strictEqual(multi[0].date, "2026-09-01", "the latest date wins, not the first");
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
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
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
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "also closed" }) }),
    });
    await w2.scanOnce();
    const archiveText2 = fs.readFileSync(path.join(root, "memory/ops-archive.md"), "utf8");
    assert.match(archiveText2, /Old incident/, "the first archived section is still there (append, never overwrite)");
    assert.match(archiveText2, /Another old thing/);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker (0.5.5 bug fix): a note with TWO IDENTICAL headings — archiving works by index, never refused as ambiguous", async () => {
  const dupHeadingNote = ["---", "title: dup", "theme: knowledge", "---", "",
    "## Status", "Current and fine, " + "word ".repeat(100), "",
    "## Status", "2020-01-01: an old, closed incident. " + "word ".repeat(100), "",
  ].join("\n");
  const { srv, cleanup } = makeSrv({ "memory/dup.md": dupHeadingNote }, { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "closed, second Status section" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, ["memory/dup.md"]);
    const srcText = fs.readFileSync(path.join(srv.store.root, "memory/dup.md"), "utf8");
    assert.match(srcText, /Current and fine/, "the FIRST \"## Status\" (index 0 / S1) stays");
    assert.doesNotMatch(srcText, /old, closed incident/, "the SECOND \"## Status\" (index 1 / S2) moved, by index, not by text");
    const archiveText = fs.readFileSync(path.join(srv.store.root, "memory/dup-archive.md"), "utf8");
    assert.match(archiveText, /old, closed incident/);
  } finally { cleanup(); }
});

test("worker (0.5.5 bug fix): minTokens — never archives a handful of lines into a brand-new note", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }); // default minTokens: 400
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, // minTokens defaults to 400
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
  const { srv, cleanup } = makeSrv({ "memory/ops2.md": recent }, { enabled: true, idleMinutes: 0, keepDays: 60, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    // now() fixed at 2026-10-29 — the incident (2026-10-01) is 28 days old, well under keepDays.
    const now = () => Date.parse("2026-10-29T00:00:00Z");
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" }, now,
      config: { enabled: true, idleMinutes: 0, keepDays: 60, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "AI mistakenly thinks this is old" }) }),
    });
    const applied = await w.scanOnce();
    assert.deepStrictEqual(applied, [], "code-enforced keepDays overrides the AI's own (wrong) answer");
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/ops2.md"), "utf8"), recent);
  } finally { cleanup(); }
});

test("worker (0.5.5): \"left\" verdicts are cached by CONTENT HASH across a worker restart — a daily scan of an unchanged note costs no AI call past the first", async () => {
  const dataDir = tmp("memglow-auto-archive-cache-");
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const aiRun = async () => { calls++; return { ok: true, text: JSON.stringify({ sections: [], reason: "nothing obsolete" }) }; };
    // minTokens: 0 — this test is about the restart cache, not the size pre-filter (its own test
    // covers that); NOTE's ~15-token old section would otherwise never clear the pre-filter at all.
    const w1 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w1.scanOnce();
    w1.stop(); // flushes the cache to disk
    assert.strictEqual(calls, 1);

    // A BRAND NEW worker instance (simulating a process restart), same data dir, same content.
    const w2 = archive.createArchiveWorker({ store: srv.store, writer: srv.writer, env: { FAKE: "k" }, dataDir, config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, aiRun });
    await w2.scanOnce();
    assert.strictEqual(calls, 1, "cached across the restart: no new AI call for unchanged content");
  } finally { cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("worker: the AI finds nothing obsolete — left alone, nothing written, and never re-asked again until the note itself changes", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    // minTokens: 0 — about re-ask suppression, not the size pre-filter.
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
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
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, minTokens: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
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
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const logs = [];
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" }, log: (s) => logs.push(s),
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, // default minTokens: 400
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
  const { srv, cleanup } = makeSrv(notesFiles, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, // maxChecksPerScan defaults to 5
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
  }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    const seen = [];
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, maxChecksPerScan: 1, provider: "anthropic", apiKeyEnv: "FAKE" }, // only ONE AI call allowed
      aiRun: async (prompt) => { seen.push(prompt); return { ok: true, text: JSON.stringify({ sections: [], reason: "x" }) }; },
    });
    await w.scanOnce();
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0], /"big-old"/, "the bigger old-tokens candidate is asked first when the budget only allows one");
  } finally { cleanup(); }
});
