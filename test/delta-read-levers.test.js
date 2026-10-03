"use strict";
// Lever 13 (deltaRead, 0.4.3 "cross-session delta reads") — integration through
// lib/proxy-levers.js `createLevers` (clientMessage/serverMessage), same lightweight pattern as
// test/negative-cache-levers.test.js: a real `createNoteIndex` over a tiny temp notes folder, but
// hand-crafted upstream answers (the TEXT a read "returns" is whatever the test hands
// serverMessage, independent of what is really on disk — exactly like every other lever test
// here), plus a real `createDeltaReadStore` so the cross-session ledger is genuinely exercised.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../lib/proxy-levers");
const D = require("../lib/delta-read");

function makeNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-dr-lev-"));
  const notes = path.join(root, "notes");
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), s); };
  w("knowledge/incident.md", "---\ntitle: Incident Log\ntheme: knowledge\n---\n# Intro\nhello\n\n## Section A\nalpha\n");
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
    MEMGLOW_PROXY_DELTA_READ: "1",
    ...env,
  });
  const index = L.createNoteIndex(cfg);
  const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
  const deltaReadStore = D.createDeltaReadStore(cfg);
  const engine = L.createLevers({ config: cfg, index, savings, deltaReadStore, serverName: "basic-memory" });
  return { cfg, index, engine, deltaReadStore, dataDir: fx.data };
}

function read(engine, sid, id, identifier, opts = {}) {
  const args = { identifier, ...opts };
  engine.clientMessage({ id, method: "tools/call", params: { name: "read_note", arguments: args } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}

const V0 = "---\ntitle: Incident Log\ntheme: knowledge\n---\n# Intro\nhello\n\n## Section A\nalpha\n" + "filler line\n".repeat(60);
const V1 = V0.replace("alpha\n", "alpha CHANGED\n");

test("deltaRead: the FIRST read of a note in a session is always full, never a header (nothing to compare against yet)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const r = read(engine, "s1", 1, "Incident Log")(V0);
    assert.strictEqual(r.changed, false, "nothing added or replaced on a brand new client+note");
    assert.strictEqual(r.msg.result.content.length, 1);
    assert.strictEqual(r.msg.result.content[0].text, V0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 2: re-read in the SAME session after the note changed -> only a diff, reconstructable from the first read's text", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    read(engine, sid, 1, "Incident Log")(V0); // version A, delivered in full
    const r2 = read(engine, sid, 2, "Incident Log")(V1); // version B
    assert.strictEqual(r2.changed, true);
    const texts = r2.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2);
    assert.match(texts[0], /changed since you read it earlier in this session; only the changes below/);
    assert.match(texts[0], /memglow_fresh/);
    assert.ok(texts[1].startsWith(D.DELTA_READ_MARKER));
    assert.strictEqual(D.applyDiff(V0, texts[1]), V1, "the diff, applied to version A, reconstructs version B exactly");
    assert.ok((texts[0] + texts[1]).length < V1.length, "the diff delivery is smaller than a full re-send");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 2: repeating the call (escape hatch) after a diff delivery returns the FULL text again", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    read(engine, sid, 1, "Incident Log")(V0);
    read(engine, sid, 2, "Incident Log")(V1); // diff delivered
    const r3 = read(engine, sid, 3, "Incident Log")(V1); // same call, repeated
    assert.strictEqual(r3.msg.result.content.length, 1);
    assert.strictEqual(r3.msg.result.content[0].text, V1, "repeating the read -> full content, same rule as 4/5/8");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 2: unchanged re-read (dedupe off) just delivers the same full text again — no diff machinery for 'nothing changed'", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    read(engine, sid, 1, "Incident Log")(V0);
    const r2 = read(engine, sid, 2, "Incident Log")(V0); // unchanged
    assert.strictEqual(r2.msg.result.content.length, 1);
    assert.strictEqual(r2.msg.result.content[0].text, V0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 2: a near-total rewrite falls back to the FULL text (diff would be > 60% of the note)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    read(engine, sid, 1, "Incident Log")(V0);
    const rewritten = V0.split("\n").map((l, i) => (i % 2 === 0 ? l + " totally rewritten" : l)).join("\n");
    const r2 = read(engine, sid, 2, "Incident Log")(rewritten);
    assert.strictEqual(r2.msg.result.content.length, 1, "no header+diff pair: just the full note");
    assert.strictEqual(r2.msg.result.content[0].text, rewritten);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 1: a NEW session's first read of a note that changed since THIS CLIENT last read it gets a one-line header, naming the changed section", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    read(engine, "s1", 1, "Incident Log")(V0); // session 1: first ever read, no header, ledger now V0
    const r2 = read(engine, "s2", 2, "Incident Log")(V1); // session 2: first read, note is now V1
    assert.strictEqual(r2.changed, true);
    const texts = r2.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2, "header ADDED before the still-full content, never replacing it");
    assert.match(texts[0], /^memglow: changed since your last read on \d{4}-\d{2}-\d{2} — sections changed: Section A$/);
    assert.strictEqual(texts[1], V1, "still the FULL current note — mechanism 1 never shortens");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 1: no header when nothing changed since this client's last read, even across sessions", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    read(engine, "s1", 1, "Incident Log")(V0);
    const r2 = read(engine, "s2", 2, "Incident Log")(V0); // unchanged
    assert.strictEqual(r2.msg.result.content.length, 1);
    assert.strictEqual(r2.msg.result.content[0].text, V0);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 1: a within-session diff delivery updates the ledger too — the NEXT session does not re-flag what this client already saw", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    read(engine, "s1", 1, "Incident Log")(V0);
    read(engine, "s1", 2, "Incident Log")(V1); // within-session diff: ledger now V1 too
    const r3 = read(engine, "s2", 3, "Incident Log")(V1); // new session, still V1: nothing new
    assert.strictEqual(r3.msg.result.content.length, 1, "no header: this client already saw V1 (via the diff)");
    assert.strictEqual(r3.msg.result.content[0].text, V1);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead mechanism 1: persisted across a brand new engine/store pointed at the same data folder", () => {
  const fx = makeNotes();
  try {
    const { engine: engine1, deltaReadStore: store1 } = setup(fx);
    read(engine1, "s1", 1, "Incident Log")(V0);
    store1.flush();

    const { engine: engine2 } = setup(fx); // a fresh engine/store, same dataDir: a process restart
    const r2 = read(engine2, "s2", 2, "Incident Log")(V1);
    const texts = r2.msg.result.content.map((c) => c.text);
    assert.match(texts[0], /^memglow: changed since your last read/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead: off by default, and a no-op end to end when the switch is off", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_DELTA_READ: "0" });
    read(engine, "s1", 1, "Incident Log")(V0);
    const r2 = read(engine, "s2", 2, "Incident Log")(V1);
    assert.strictEqual(r2.changed, false);
    assert.strictEqual(r2.msg.result.content.length, 1);
    assert.strictEqual(r2.msg.result.content[0].text, V1);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("deltaRead: safety — a deltaReadStore that throws on every call never breaks the relay (apply()'s own try/catch)", () => {
  const fx = makeNotes();
  try {
    const cfg = L.proxyConfig({
      MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data,
      MEMGLOW_LARGE_NOTE_TOKENS: "100000", MEMGLOW_PROXY_MULTI_QUERY: "0",
      MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0", MEMGLOW_PROXY_DEDUPE: "0",
      MEMGLOW_PROXY_DELTA_READ: "1",
    });
    const index = L.createNoteIndex(cfg);
    const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
    const brokenStore = { available: () => true, get() { throw new Error("boom"); }, set() { throw new Error("boom"); } };
    const engine = L.createLevers({ config: cfg, index, savings, deltaReadStore: brokenStore, serverName: "basic-memory" });
    const r = read(engine, "s1", 1, "Incident Log")(V0);
    assert.strictEqual(r.msg.result.content[0].text, V0, "the upstream answer is still relayed, unchanged, despite the broken store");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
