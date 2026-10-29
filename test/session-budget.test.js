"use strict";
// Lever 18 (sessionBudgetTokens, "session memory budget", 0.5.6, lib/levers/session-budget.js) —
// the pure helpers directly, then the integration through lib/proxy-levers.js `createLevers`
// (clientMessage/serverMessage), same lightweight pattern as test/state-view-levers.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../lib/proxy-levers");
const sb = require("../lib/levers/session-budget");

// ------------------------------------------------------------------ pure helpers

test("budgetNotice: one short line naming the used/budget tokens", () => {
  const line = sb.budgetNotice(2500, 2000);
  assert.match(line, /^memglow: this session has read ≈2500 tokens of memory \(budget 2000\)/);
  assert.match(line, /search_notes/);
});

test("shortenOverBudget: fails open (null) when the text is not actually over maxTokens", () => {
  assert.strictEqual(sb.shortenOverBudget("short text", { maxTokens: 2000 }), null);
});

test("shortenOverBudget: fails open (null) when the text has no heading at all", () => {
  const big = "padding ".repeat(2000); // no heading anywhere, well over the default threshold
  assert.strictEqual(sb.shortenOverBudget(big, { maxTokens: 100 }), null);
});

test("shortenOverBudget: keeps the lead + its own \"## Parts\" section when present, plus a hint naming memglow_section", () => {
  const text = "Intro line.\n\n## Parts\n- [[a]] — a\n- [[b]] — b\n\n## Other\n" + "padding ".repeat(200);
  const r = sb.shortenOverBudget(text, { maxTokens: 50, label: "hub-x", tool: "read_note" });
  assert.ok(r);
  assert.match(r.kept, /Intro line\./);
  assert.match(r.kept, /## Parts/);
  assert.match(r.kept, /\[\[a\]\]/);
  assert.doesNotMatch(r.kept, /## Other/);
  assert.match(r.hint, /"hub-x"/);
  assert.match(r.hint, /memglow_section/);
  assert.match(r.hint, /memglow_fresh/);
  assert.ok(r.keptTokens < r.respTokens);
});

test("shortenOverBudget: no \"## Parts\" — keeps the lead + the FIRST heading's own section", () => {
  const text = "Intro.\n\n## Alpha\nAlpha body.\n\n## Beta\n" + "padding ".repeat(200);
  const r = sb.shortenOverBudget(text, { maxTokens: 50 });
  assert.ok(r);
  assert.match(r.kept, /Intro\./);
  assert.match(r.kept, /## Alpha/);
  assert.match(r.kept, /Alpha body\./);
  assert.doesNotMatch(r.kept, /## Beta/);
});

// ------------------------------------------------------------------ integration (createLevers)

function makeNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-session-budget-"));
  const notes = path.join(root, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  return { root, notes, home, data };
}

function setup(fx, env = {}) {
  const cfg = L.proxyConfig({
    MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data,
    MEMGLOW_LARGE_NOTE_TOKENS: "100000", MEMGLOW_PROXY_MULTI_QUERY: "0",
    MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0", MEMGLOW_PROXY_DEDUPE: "0",
    ...env,
  });
  const index = L.createNoteIndex(cfg);
  const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
  const engine = L.createLevers({ config: cfg, index, savings, serverName: "basic-memory" });
  return { cfg, index, engine, savings };
}

function call(engine, sid, id, tool, args) {
  engine.clientMessage({ id, method: "tools/call", params: { name: tool, arguments: args } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}
const read = (engine, sid, id, identifier) => call(engine, sid, id, "read_note", { identifier });
const search = (engine, sid, id, query) => call(engine, sid, id, "search_notes", { query });

test("sessionBudgetTokens: off by default — no notice, no tally, relayed unchanged", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const r = read(engine, "s1", 1, "note-a")("Intro.\n\n## Alpha\nAlpha body.\n");
    assert.strictEqual(r.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: under budget — relayed unchanged (tallied silently)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "5000" });
    const r = read(engine, "s1", 1, "note-a")("Intro.\n\n## Alpha\nAlpha body.\n");
    assert.strictEqual(r.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: the answer that CROSSES the budget is relayed unchanged; every FURTHER read/search then gets a one-line notice (never blocked)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "10" });
    const first = read(engine, "s1", 1, "note-a")("A small first note, already over the tiny 10-token budget on its own.");
    assert.strictEqual(first.changed, false, "not yet over budget WHEN this answer was being prepared");
    const second = search(engine, "s1", 2, "whatever")("Some search result text, plenty of tokens in it too.");
    assert.strictEqual(second.changed, true, "now over budget: every further answer is prefixed");
    assert.match(second.msg.result.content[0].text, /^memglow: this session has read/);
    assert.match(second.msg.result.content[1].text, /Some search result text/, "the real answer still follows, never dropped");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: a different session key starts with its own, separate budget", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "10" });
    read(engine, "s1", 1, "note-a")("Enough text to blow straight through the tiny 10-token budget."); // crosses it
    const tiny = "hi";
    const s1Again = read(engine, "s1", 2, "note-a")(tiny);
    const s2First = read(engine, "s2", 3, "note-a")(tiny);
    assert.match(s1Again.msg.result.content[0].text, /^memglow: this session has read/, "s1 is over its own budget now");
    assert.strictEqual(s2First.changed, false, "a fresh session key, never over its own budget yet");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: once over budget, a full single-note read still over ~2000 tokens is ALSO shortened to intro + \"## Parts\"/first section + a hint", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "10" });
    read(engine, "s1", 1, "note-a")("A small first note, already over the tiny 10-token budget on its own."); // crosses the budget
    const bigNote = "Intro.\n\n## Parts\n- [[a]] — a\n- [[b]] — b\n\n## Other\n" + "padding ".repeat(2500);
    const r = read(engine, "s1", 2, "note-b")(bigNote); // now over budget: this gets the heavy treatment
    assert.strictEqual(r.changed, true);
    const texts = r.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 3, "notice + kept + hint");
    assert.match(texts[0], /^memglow: this session has read/);
    assert.match(texts[1], /## Parts/);
    assert.doesNotMatch(texts[1], /## Other/);
    assert.match(texts[2], /memglow_section/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: NEVER shortens a build_context (multi-note) answer — notice only", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "10" });
    read(engine, "s1", 1, "note-a")("A small first note, already over the tiny 10-token budget on its own."); // crosses the budget
    const bigNote = "Intro.\n\n## Parts\n- [[a]] — a\n\n## Other\n" + "padding ".repeat(2500);
    const r = call(engine, "s1", 2, "build_context", { identifier: "note-b" })(bigNote);
    assert.strictEqual(r.changed, true);
    const texts = r.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2, "notice + the FULL original text, never cut");
    assert.match(texts[0], /^memglow: this session has read/);
    assert.strictEqual(texts[1], bigNote, "build_context is never shortened by this lever");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("sessionBudgetTokens: never breaks a read entirely even on a pathological answer (write tools untouched; errors relay as-is)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_SESSION_BUDGET: "1" });
    read(engine, "s1", 1, "note-a")("anything"); // crosses the (tiny) budget
    // An error answer is never touched by any lever (checked before dispatch) — still relayed.
    engine.clientMessage({ id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "note-b" } } }, "s1");
    const err = engine.serverMessage({ id: 2, error: { code: -1, message: "boom" } }, "s1");
    assert.strictEqual(err.changed, false);
    assert.strictEqual(err.msg.error.message, "boom");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ config

test("proxyConfig: sessionBudgetTokens is 0 (off) by default; MEMGLOW_PROXY_SESSION_BUDGET sets it; anyLever() reflects it", () => {
  const fx = makeNotes();
  try {
    const off = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data });
    assert.strictEqual(off.sessionBudgetTokens, 0);
    // Every OTHER lever explicitly off: a clean baseline to show sessionBudgetTokens alone is
    // what flips anyLever() (sizeWarning is ON by default, so the bare `off` config above is not
    // itself a "no lever at all" baseline).
    const noneAtAll = L.proxyConfig({
      MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data,
      MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_MULTI_QUERY: "0",
      MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0",
    });
    assert.strictEqual(L.anyLever(noneAtAll), false);
    const on = { ...noneAtAll, sessionBudgetTokens: 3000 };
    assert.strictEqual(L.anyLever(on), true);
    const onViaEnv = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_PROXY_SESSION_BUDGET: "3000" });
    assert.strictEqual(onViaEnv.sessionBudgetTokens, 3000);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
