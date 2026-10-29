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

test("worker (0.5.6 bug fix): idleMinutes 0 is 'always idle' even when now() lands BEFORE the moment noteWritten() recorded (fast clock/filesystem rounding) — age is never negative", async () => {
  const { srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    let now = Date.parse("2026-01-01T00:00:00Z");
    let aiCalls = 0;
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" },
      env: { FAKE: "k" },
      aiRun: async () => { aiCalls++; return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "Alpha", sections: ["Alpha"] }] }) }; },
    });
    w.noteWritten(["memory/big.md"]); // pending.set(rel, now()) at `now`
    now -= 1; // 0.5.6: a later now() call lands a fraction of a ms BEFORE the recorded moment
    await w.tick();
    assert.strictEqual(aiCalls, 1, "idleMinutes 0: eligible regardless of a negative age");
  } finally { cleanup(); }
});

test("worker (0.5.4 bug fix): a note found by the periodic SCAN waits idleMinutes from its own file mtime, not from when the scan ran", async () => {
  const now0 = Date.parse("2026-02-01T12:00:00Z");
  // Case A: modified 5 minutes before "now" — not eligible yet, not even 24 more minutes later;
  // eligible once 30 full minutes have passed since that mtime.
  {
    const { root, srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
    try {
      const abs = path.join(root, "memory/big.md");
      const mtime = (now0 - 5 * 60000) / 1000;
      fs.utimesSync(abs, mtime, mtime);
      srv.store.scan();
      let now = now0, aiCalls = 0;
      const w = auto.createAutoSplitWorker({
        store: srv.store, writer: srv.writer, now: () => now,
        config: { enabled: true, thresholdTokens: 200, idleMinutes: 30, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
        aiRun: async () => { aiCalls++; return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "d", sections: ["Alpha"] }] }) }; },
      });
      await w.runScan();
      assert.strictEqual(w.pendingCount(), 1);
      await w.tick();
      assert.strictEqual(aiCalls, 0, "5 minutes old: not idle yet (scan just ran, but that is not the clock that matters)");
      now += 24 * 60000; // 29 minutes since mtime
      await w.tick();
      assert.strictEqual(aiCalls, 0, "still short of the full 30 minutes since the file's own mtime");
      now += 2 * 60000; // 31 minutes since mtime
      await w.tick();
      assert.strictEqual(aiCalls, 1, "now idle long enough since the real last edit");
    } finally { cleanup(); }
  }
  // Case B: modified 2 hours before "now" (the common case for most of an established KB on
  // every restart) — already idle, eligible on the very first tick after the scan.
  {
    const { root, srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
    try {
      const abs = path.join(root, "memory/big.md");
      const mtime = (now0 - 2 * 3600000) / 1000;
      fs.utimesSync(abs, mtime, mtime);
      srv.store.scan();
      let aiCalls = 0;
      const w = auto.createAutoSplitWorker({
        store: srv.store, writer: srv.writer, now: () => now0,
        config: { enabled: true, thresholdTokens: 200, idleMinutes: 30, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
        aiRun: async () => { aiCalls++; return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "d", sections: ["Alpha"] }] }) }; },
      });
      await w.runScan();
      await w.tick();
      assert.strictEqual(aiCalls, 1, "2 hours old: already idle, eligible at once");
    } finally { cleanup(); }
  }
});

test("worker (0.5.4): runScan() re-seeing an already-pending note (a recent write) keeps the LATER of the write clock and the file's mtime", async () => {
  const { root, srv, cleanup } = makeSrv({ "memory/big.md": bigNote() }, {});
  try {
    const abs = path.join(root, "memory/big.md");
    let now = Date.parse("2026-02-01T12:00:00Z");
    let aiCalls = 0;
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 30, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
      aiRun: async () => { aiCalls++; return { ok: true, text: JSON.stringify({ parts: [{ slug: "big-alpha", description: "d", sections: ["Alpha"] }] }) }; },
    });
    // A write just registered it (since = now, very fresh) — but the file's mtime on disk is
    // from HOURS ago (a write that predates this worker's own clock reference, or a filesystem
    // that updates mtime lazily). runScan() re-seeing it must keep the FRESH ("now") signal, not
    // let the older mtime make it look idle sooner than it really is.
    const oldMtime = (now - 3 * 3600000) / 1000;
    fs.utimesSync(abs, oldMtime, oldMtime);
    srv.store.scan();
    w.noteWritten(["memory/big.md"]);
    await w.runScan();
    now += 60000; // 1 minute later: nowhere near 30 minutes since the WRITE
    await w.tick();
    assert.strictEqual(aiCalls, 0, "the write's own fresh timestamp must win, not the stale mtime");
    now += 30 * 60000; // now 31 minutes since the write
    await w.tick();
    assert.strictEqual(aiCalls, 1, "idle long enough since the write");
  } finally { cleanup(); }
});

test("worker (0.5.4 bug fix): an auth error stops the rest of the scan at once (never retried, never hammered per candidate) and surfaces in status().lastError", async () => {
  const { srv, cleanup } = makeSrv({ "memory/a.md": bigNote(), "memory/b.md": bigNote("b") }, {});
  try {
    let now = Date.parse("2026-03-01T00:00:00Z");
    let aiCalls = 0;
    const w = auto.createAutoSplitWorker({
      store: srv.store, writer: srv.writer, now: () => now,
      config: { enabled: true, thresholdTokens: 200, idleMinutes: 0, provider: "anthropic", apiKeyEnv: "FAKE" }, env: { FAKE: "k" },
      aiRun: async () => { aiCalls++; return { ok: false, error: "Failed to authenticate. API Error: 401 Invalid bearer token" }; },
    });
    w.noteWritten(["memory/a.md", "memory/b.md"]);
    assert.strictEqual(w.pendingCount(), 2);
    await w.tick();
    assert.strictEqual(aiCalls, 1, "no retry for an auth error — it is never going to fix itself");
    assert.ok(w.status().lastError, "surfaced in status()");
    assert.match(w.status().lastError.message, /401|bearer token/);
    assert.strictEqual(typeof w.status().lastError.t, "number");
    // The rest of this scan (the second candidate) is never even attempted.
    now += 60000;
    await w.tick();
    await w.tick();
    assert.strictEqual(aiCalls, 1, "stopped for good: every later tick is a no-op once a bad credential was seen");
    assert.strictEqual(w.pendingCount(), 2, "both notes stay queued (informative), neither is dropped nor split");
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

test("underIncluded / sanitizeIncludeFolders / defaultIncludeFolders: no restriction by default, explicit list, index-note-folder default", () => {
  // underIncluded: null/empty folders = everything in scope (opposite default from underExcluded).
  assert.strictEqual(auto.underIncluded("workspace/doc.md", null), true);
  assert.strictEqual(auto.underIncluded("workspace/doc.md", []), true);
  assert.strictEqual(auto.underIncluded("memory/MEMORY.md", ["memory"]), true);
  assert.strictEqual(auto.underIncluded("memory/sub/x.md", ["memory"]), true);
  assert.strictEqual(auto.underIncluded("workspace/doc.md", ["memory"]), false);
  assert.strictEqual(auto.underIncluded("memoryish/x.md", ["memory"]), false, "\"memoryish\" must not match the \"memory\" prefix");

  assert.strictEqual(auto.sanitizeIncludeFolders(null), null);
  assert.strictEqual(auto.sanitizeIncludeFolders([]), null);
  assert.deepStrictEqual(auto.sanitizeIncludeFolders(["/memory/", "memory"]), ["memory"], "trimmed and deduped");

  const fakeStore = { resolve: (name) => (name === "MEMORY" ? { dir: "memory" } : null) };
  assert.deepStrictEqual(auto.defaultIncludeFolders(fakeStore, ["MEMORY", "index"]), ["memory"]);
  const rootIndexStore = { resolve: (name) => (name === "MEMORY" ? { dir: "" } : null) };
  assert.strictEqual(auto.defaultIncludeFolders(rootIndexStore, ["MEMORY", "index"]), null, "the index note at the KB root means everything is in scope");
  const noIndexStore = { resolve: () => null };
  assert.strictEqual(auto.defaultIncludeFolders(noIndexStore, ["MEMORY", "index"]), null);

  assert.deepStrictEqual(auto.effectiveIncludeFolders({ includeFolders: ["a", "b"] }, fakeStore, ["MEMORY"]), ["a", "b"], "an explicit includeFolders always wins outright over the index-note default");
});

test("worker (0.5.4 bug fix): SCOPE — a KB root with memory/ (the memory, with its index note) plus one-way-synced workspace/ and infra-acces/ folders — only memory/ is ever touched or flagged, by default (no includeFolders needed)", async () => {
  const { root, srv, cleanup } = makeSrv({
    "memory/MEMORY.md": "---\ntitle: MEMORY\ntype: index\n---\n\n" + "padding ".repeat(400),
    "memory/normal.md": bigNote(),
    "workspace/doc.md": bigNote(),
    "infra-acces/x.md": bigNote(),
  }, {});
  try {
    const w = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200 }, indexNote: ["MEMORY", "index"] });
    await w.runScan();
    assert.strictEqual(w.pendingCount(), 1, "only memory/normal.md — workspace/ and infra-acces/ are out of scope entirely");
    w.noteWritten(["workspace/doc.md", "infra-acces/x.md", "memory/normal.md"]);
    assert.strictEqual(w.pendingCount(), 1, "a write to the synced docs is not queued either");

    // An explicit includeFolders widens (or narrows) the scope outright.
    const w2 = auto.createAutoSplitWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, thresholdTokens: 200, includeFolders: ["workspace"] }, indexNote: ["MEMORY", "index"] });
    await w2.runScan();
    assert.strictEqual(w2.pendingCount(), 1, "explicit includeFolders wins: only workspace/ now");
  } finally { cleanup(); }
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

test("resolveSectionRefs: section ids and masked headings map to the real heading text (0.5.4.2, seen in production)", () => {
  const { resolveSectionRefs, buildPrompt } = require("../lib/auto-split");
  const raw = "---\ntitle: n\n---\n\nIntro.\n\n## Plain one\n\nA.\n\n## Fix token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\nB.\n\n## Third\n\nC.\n";
  const prompt = buildPrompt({ raw, title: "n", slug: "n" }, { thresholdTokens: 5000 });
  assert.match(prompt, /\[S1\] ## Plain one/);
  assert.match(prompt, /\[S2\] ## .*line hidden/); // the secret-looking heading is masked in what the AI sees
  assert.doesNotMatch(prompt, /sk-ant-api03/);
  const masked = /\[S2\] ## (.*) \(≈/.exec(prompt)[1];
  const plan = { parts: [{ slug: "a", description: "d", sections: ["S2", "S3"] }, { slug: "b", description: "d", sections: [masked, "Plain one", "Unknown"] }] };
  const out = resolveSectionRefs(plan, raw);
  assert.deepStrictEqual(out.parts[0].sections, ["Fix token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Third"]);
  assert.deepStrictEqual(out.parts[1].sections, ["Fix token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Plain one", "Unknown"]);
});
