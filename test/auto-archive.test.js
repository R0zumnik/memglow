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

test("outline: [S#] ids, levels and any date found", () => {
  const out = archive.outline("## 2020-01-01 Old incident\nResolved.\n\n## Current\nStill going.\n");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].date, "2020-01-01");
  assert.strictEqual(out[1].date, null);
});

test("resolveIds: \"S<n>\" ids resolve to real heading text, in outline order; unknown ids dropped", () => {
  const body = "## Alpha\nx\n\n## Beta\ny\n";
  assert.deepStrictEqual(archive.resolveIds(["S2", "S9", "Alpha"], body), ["Beta", "Alpha"]);
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
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
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
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: true, text: JSON.stringify({ sections: ["S2"], reason: "also closed" }) }),
    });
    await w2.scanOnce();
    const archiveText2 = fs.readFileSync(path.join(root, "memory/ops-archive.md"), "utf8");
    assert.match(archiveText2, /Old incident/, "the first archived section is still there (append, never overwrite)");
    assert.match(archiveText2, /Another old thing/);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker: the AI finds nothing obsolete — left alone, nothing written, and never re-asked again until the note itself changes", async () => {
  const { srv, cleanup } = makeSrv({ "memory/ops.md": NOTE }, { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" });
  try {
    let calls = 0;
    const w = archive.createArchiveWorker({
      store: srv.store, writer: srv.writer, env: { FAKE: "k" },
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
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
      config: { enabled: true, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      aiRun: async () => ({ ok: false, error: "401 unauthorized: invalid api key" }),
    });
    await w.scanOnce();
    const st = w.status();
    assert.ok(st.lastError && /unauthorized/i.test(st.lastError.message));
  } finally { cleanup(); }
});
