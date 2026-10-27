"use strict";
// lib/auto-split.js — the built-in auto-split worker: debounce (idle minutes), the periodic scan,
// skip rules (index / archive / memglow_split: false), change-detection abort, the one retry on a
// refused plan, and "inert without a configured/available AI provider". The AI is always a tiny
// injected `aiRun` here — never a real network call or a real `claude` binary.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const auto = require("../lib/auto-split");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeSrv(notes, autoSplit) {
  const root = tmp("memglow-auto-split-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, autoSplit: { enabled: false, ...autoSplit } });
  return { root, srv, cleanup: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const BODY_SECTIONS = ["## Alpha", "Alpha text.", "", "## Beta", "Beta text.", ""].join("\n");
function bigNote(extra = "") {
  return ["---", "title: big", "theme: knowledge", "---", "", "Intro.", "", BODY_SECTIONS, "padding ".repeat(400) + extra].join("\n");
}

test("autoSplitSettings: off by default, env MEMGLOW_AUTO_SPLIT=1 turns it on, bad values fall back to defaults", () => {
  const off = auto.autoSplitSettings({}, {});
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.thresholdTokens, auto.DEFAULTS.thresholdTokens);
  const on = auto.autoSplitSettings({}, { MEMGLOW_AUTO_SPLIT: "1" });
  assert.strictEqual(on.enabled, true);
  const explicitOff = auto.autoSplitSettings({ enabled: true }, { MEMGLOW_AUTO_SPLIT: "0" });
  assert.strictEqual(explicitOff.enabled, false, "env MEMGLOW_AUTO_SPLIT=0 wins over the config file");
  const badProvider = auto.autoSplitSettings({ provider: "not-a-thing" }, {});
  assert.strictEqual(badProvider.provider, "", "an unknown provider id is dropped, never passed through");
  const anthropicDefault = auto.autoSplitSettings({ provider: "anthropic" }, {});
  assert.strictEqual(anthropicDefault.model, "claude-haiku-4-5");
  const claudeCodeDefault = auto.autoSplitSettings({ provider: "claude-code" }, {});
  assert.strictEqual(claudeCodeDefault.model, "haiku");
});

test("worker: disabled is inert — noteWritten/tick/start are all no-ops, no timers", () => {
  const w = auto.createAutoSplitWorker({ store: {}, writer: {}, config: { enabled: false } });
  assert.strictEqual(w.inert, true);
  w.start(); w.noteWritten(["x.md"]); w.stop();
  assert.strictEqual(w.pendingCount(), 0);
});

test("worker: enabled but no provider configured — stays inert (one log line), never calls the AI", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, { enabled: true, thresholdTokens: 200 });
  try {
    let aiCalls = 0;
    const logs = [];
    const w = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200, idleMinutes: 0 }, log: (s) => logs.push(s), aiRun: async () => { aiCalls++; return { ok: false, error: "should not be called" }; } });
    await w.runScan();
    assert.strictEqual(w.pendingCount(), 1, "the big note was queued by the scan");
    await w.tick();
    assert.strictEqual(aiCalls, 0, "no provider configured: the AI is never called");
    assert.ok(logs.some((l) => /no AI provider is configured/.test(l)));
  } finally { cleanup(); }
});

test("worker: debounce — a note just written is not split until idleMinutes have passed", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    let now = Date.parse("2026-01-01T00:00:00Z");
    let aiCalls = 0;
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 30, provider: "anthropic", apiKeyEnv: "FAKE" },
      env: { FAKE: "k" },
      aiRun: async () => { aiCalls++; return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "Alpha", sections: ["Alpha"] }] }) }; },
    });
    w.noteWritten(["memory/big.md"]);
    assert.strictEqual(w.pendingCount(), 1);
    await w.tick();
    assert.strictEqual(aiCalls, 0, "still fresh: not idle yet");
    assert.strictEqual(w.pendingCount(), 1, "stays queued, to be retried later");
    now += 31 * 60000;
    await w.tick();
    assert.strictEqual(aiCalls, 1, "idle long enough: the AI is called");
    assert.strictEqual(w.pendingCount(), 0, "done, dropped from the queue");
    const events = w.recentEvents();
    assert.ok(events.some((e) => e.kind === "split"));
  } finally { cleanup(); }
});

test("worker: a refused plan is retried once with the engine's errors, then gives up and logs", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    let now = Date.parse("2026-01-01T01:00:00Z");
    const prompts = [];
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
      aiRun: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-nope", description: "d", sections: ["Does not exist"] }] }) }; },
    });
    w.noteWritten(["memory/big.md"]);
    await w.tick();
    assert.strictEqual(prompts.length, 2, "exactly one retry");
    assert.match(prompts[1], /Your last answer was refused/);
    assert.match(prompts[1], /found 0 time/);
    const events = w.recentEvents();
    assert.ok(events.some((e) => e.kind === "split-failed"));
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/big.md"), "utf8"), bigNote(), "nothing written on failure");
  } finally { cleanup(); }
});

test("worker: change-detection abort — the note changing between AI call and apply cancels the split", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    const now = Date.now();
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
      aiRun: async () => {
        // The note changes WHILE the AI is "thinking" (simulated by writing here).
        fs.writeFileSync(path.join(srv.store.root, "memory/big.md"), bigNote("extra line written mid-flight"));
        srv.store.refreshNote("memory/big.md");
        return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "d", sections: ["Alpha"] }] }) };
      },
    });
    w.noteWritten(["memory/big.md"]);
    await w.tick();
    const events = w.recentEvents();
    assert.ok(events.some((e) => e.kind === "split-aborted"), "aborted, not split or failed");
    assert.strictEqual(fs.existsSync(path.join(srv.store.root, "memory/big-alpha.md")), false);
  } finally { cleanup(); }
});

test("worker: skip rules — index note, archive folder, and memglow_split: false are never queued", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/MEMORY.md": "---\ntitle: MEMORY\ntype: index\n---\n\n" + "padding ".repeat(400),
    "memory/archive/old.md": "---\ntitle: old\n---\n\n" + "padding ".repeat(400),
    "memory/opted-out.md": "---\ntitle: opted-out\nmemglow_split: false\n---\n\n" + "padding ".repeat(400),
    "memory/normal.md": bigNote(),
  }, {});
  try {
    const w = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200, archiveFolder: "memory/archive" } });
    await w.runScan();
    // Only "memory/normal.md" (not the index note, not archived, not opted out) is queued.
    assert.strictEqual(w.pendingCount(), 1);
    // noteWritten() itself must immediately drop (never queue) every skip-rule match.
    const w2 = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200, archiveFolder: "memory/archive" } });
    w2.noteWritten(["memory/MEMORY.md", "memory/archive/old.md", "memory/opted-out.md", "memory/normal.md"]);
    assert.strictEqual(w2.pendingCount(), 1);
  } finally { cleanup(); }
});

test("worker: excludeFolders (0.5.4) — a list of folder prefixes, shared setting, archiveFolder kept as a one-item alias, a versioned-document folder is left whole", async () => {
  // archiveFolder alone still becomes a one-item excludeFolders list.
  const alias = auto.autoSplitSettings({ archiveFolder: "memory/archive" }, {});
  assert.deepStrictEqual(alias.excludeFolders, ["memory/archive"]);
  // excludeFolders, explicit, wins outright over archiveFolder (never merged).
  const explicit = auto.autoSplitSettings({ archiveFolder: "memory/archive", excludeFolders: ["memory/work", "memory/project/x"] }, {});
  assert.deepStrictEqual(explicit.excludeFolders, ["memory/work", "memory/project/x"]);
  // default, neither given.
  assert.deepStrictEqual(auto.autoSplitSettings({}, {}).excludeFolders, ["archive"]);
  // env override (comma list).
  assert.deepStrictEqual(auto.autoSplitSettings({}, { MEMGLOW_EXCLUDE_FOLDERS: "a, b ,c" }).excludeFolders, ["a", "b", "c"]);

  const { srv, cleanup } = makeSrv({
    "memory/project/work/ibs/initiatives/0-synthese-initiatives/design-spec.md": bigNote("versioned work document, never auto-split"),
    "memory/normal.md": bigNote(),
  }, {});
  try {
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer,
      config: { enabled: true, thresholdTokens: 200, excludeFolders: ["memory/project/work/ibs/initiatives"] },
    });
    await w.runScan();
    assert.strictEqual(w.pendingCount(), 1, "only normal.md — the versioned work document is excluded");
    w.noteWritten(["memory/project/work/ibs/initiatives/0-synthese-initiatives/design-spec.md"]);
    assert.strictEqual(w.pendingCount(), 1, "a write to it is not queued either");
  } finally { cleanup(); }
});

test("underExcluded / sanitizeExcludeFolders: exact folder match, nested prefix match, never a partial name match, deduped", () => {
  assert.strictEqual(auto.underExcluded("archive/old.md", ["archive"]), true);
  assert.strictEqual(auto.underExcluded("archive/sub/old.md", ["archive"]), true);
  assert.strictEqual(auto.underExcluded("archived/old.md", ["archive"]), false, "\"archived\" must not match the \"archive\" prefix");
  assert.strictEqual(auto.underExcluded("notes/x.md", ["archive"]), false);
  assert.strictEqual(auto.underExcluded("a/x.md", ["a", "b"]), true);
  assert.deepStrictEqual(auto.sanitizeExcludeFolders(["a", "a", "b"], null), ["a", "b"]);
  assert.deepStrictEqual(auto.sanitizeExcludeFolders([], null), auto.DEFAULT_EXCLUDE_FOLDERS);
  assert.deepStrictEqual(auto.sanitizeExcludeFolders(["/a/", "b//"], null), ["a", "b"], "leading/trailing slashes trimmed");
});

test("worker: a real end-to-end split through the injected aiRun — the note is actually split on disk", async () => {
  const { root, srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, project: "main",
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 0, provider: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "x" },
      aiRun: async () => ({ ok: true, text: "```json\n" + JSON.stringify({ hub_summary: "Split.", parts: [{ slug: "big-alpha", description: "Alpha part", hook: "alpha stuff", sections: ["Alpha"] }, { slug: "big-beta", description: "Beta part", sections: ["Beta"] }] }) + "\n```" }),
    });
    w.noteWritten(["memory/big.md"]);
    await w.tick();
    assert.ok(fs.existsSync(path.join(root, "memory/big-alpha.md")));
    assert.ok(fs.existsSync(path.join(root, "memory/big-beta.md")));
    const hub = fs.readFileSync(path.join(root, "memory/big.md"), "utf8");
    assert.match(hub, /Split\./);
    assert.match(hub, /## Parts\n- \[\[big-alpha\]\] — alpha stuff\n- \[\[big-beta\]\] — Beta part/);
  } finally { cleanup(); }
});

test("buildPrompt: masks secret-looking lines and lists sections with token estimates", () => {
  const n = { title: "t", slug: "t", base: "t", raw: "---\ntitle: t\n---\n\nIntro.\napi_key: abcdefghijklmnop12345\n\n## A\nBody.\n" };
  const prompt = auto.buildPrompt(n, { thresholdTokens: 100 });
  assert.doesNotMatch(prompt, /abcdefghijklmnop12345/);
  assert.match(prompt, /# A \(≈\d+ tokens\)/);
});

test("parsePlan: strips a ```json fence and finds the object even with leading prose", () => {
  const p = auto.parsePlan("Sure, here it is:\n```json\n{\"parts\":[{\"slug\":\"x\"}]}\n```\n");
  assert.deepStrictEqual(p, { parts: [{ slug: "x" }] });
  assert.throws(() => auto.parsePlan("not json at all"));
});

test("worker: status() — never the key, reports provider/model/pending/lastScan even when disabled", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    const off = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: false, provider: "anthropic" }, env: {} });
    const s0 = off.status();
    assert.strictEqual(s0.enabled, false);
    assert.strictEqual(s0.provider, "anthropic");
    assert.strictEqual(s0.keySet, false);
    assert.strictEqual(s0.lastScanAt, null);
    assert.ok(!JSON.stringify(s0).toLowerCase().includes("sk-"));

    const on = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "a-fake-key" } });
    on.noteWritten(["memory/big.md"]);
    await on.runScan();
    const s1 = on.status();
    assert.strictEqual(s1.enabled, true);
    assert.strictEqual(s1.keySet, true);
    assert.ok(s1.pendingCount >= 0);
    assert.strictEqual(typeof s1.lastScanAt, "number");
    assert.strictEqual(s1.nextScanAt, s1.lastScanAt + auto.DEFAULTS.scanHours * 3600000);
  } finally { cleanup(); }
});
