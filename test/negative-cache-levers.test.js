"use strict";
// Levers 11 (negativeCache) and 12 (indexHint), 0.4.2.6 — integration through lib/proxy-levers.js
// `createLevers` (clientMessage/serverMessage), the same light-weight, no-process-spawn pattern
// test/mcp-proxy-levers.test.js already uses for lever 10's "never duplicated" test: a real
// `createNoteIndex` over a tiny temp notes folder, but hand-crafted upstream answers (no need for
// the fake MCP fixture's own search-matching logic).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../lib/proxy-levers");
const NC = require("../lib/negative-cache");

function makeNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-negl-"));
  const notes = path.join(root, "notes");
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), s); };
  w("people/carol.md", "---\ntitle: Carol\ndescription: Carol card\ntheme: people\n---\nCarol body SECRETBODY-carol.\n");
  w("MEMORY.md", "---\ntitle: MEMORY\ndescription: Index\n---\n# Memory index\n\n- [[carol]] — Carol card, roster assignment sheet owner\n");
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
    MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0",
    MEMGLOW_PROXY_NEGATIVE_CACHE: "1",
    ...env,
  });
  const index = L.createNoteIndex(cfg);
  const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
  const negativeCacheStore = NC.createNegativeCacheStore(cfg);
  const engine = L.createLevers({ config: cfg, index, savings, negativeCacheStore, serverName: "basic-memory" });
  return { cfg, index, engine, negativeCacheStore };
}

function search(engine, sid, id, query) {
  engine.clientMessage({ id, method: "tools/call", params: { name: "search_notes", arguments: { query } } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}
function read(engine, sid, id, identifier) {
  engine.clientMessage({ id, method: "tools/call", params: { name: "read_note", arguments: { identifier } } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}
function write(engine, sid, id, identifier) {
  engine.clientMessage({ id, method: "tools/call", params: { name: "edit_note", arguments: { identifier, operation: "append", content: "" } } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}

test("negativeCache: a search superseded by another search (no read in between) is recorded futile; a LATER search with the same significant words gets the hint PREPENDED — results are always kept, never hidden", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    search(engine, sid, 1, "roster assignment sheet")("No results");
    // Superseded by another search, no read in between: "roster assignment sheet" is now futile.
    search(engine, sid, 2, "docker")("No results");

    const r3 = search(engine, sid, 3, "roster assignment sheet")("No results");
    assert.strictEqual(r3.changed, true);
    assert.strictEqual(r3.msg.result.content.length, 2);
    assert.match(r3.msg.result.content[0].text, /^memglow: this search found nothing you used last time \(\d{4}-\d{2}-\d{2}\); the memory has not changed since\.$/);
    assert.strictEqual(r3.msg.result.content[1].text, "No results", "the upstream's own answer is still relayed, unchanged, right after — never hidden");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("negativeCache: a read within the window redeems the search — a later identical search gets NO hint", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    search(engine, sid, 1, "roster assignment sheet")("No results");
    read(engine, sid, 2, "carol")("Carol body SECRETBODY-carol.");
    const r3 = search(engine, sid, 3, "roster assignment sheet")("No results");
    assert.strictEqual(r3.changed, false, "redeemed by the read: never recorded futile, so nothing to hint");
    assert.strictEqual(r3.msg.result.content.length, 1);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("negativeCache: a write between the two searches invalidates the cached verdict (fingerprint changed) — no hint", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    search(engine, sid, 1, "roster assignment sheet")("No results");
    search(engine, sid, 2, "docker")("No results"); // supersedes 1: recorded futile under today's fingerprint

    // A REAL write on disk — the fingerprint is note count + latest mtime, read straight off
    // disk, so it must actually change for this to mean anything.
    fs.appendFileSync(path.join(fx.notes, "people", "carol.md"), "\nMore.\n");
    write(engine, sid, 3, "carol")("# Edited note (append)\npermalink: people/carol");

    const r4 = search(engine, sid, 4, "roster assignment sheet")("No results");
    assert.strictEqual(r4.changed, false, "memory changed since: the stale verdict is never surfaced");
    assert.strictEqual(r4.msg.result.content.length, 1);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("negativeCache: the hint carries no query text at all — just a date, nothing that could leak a secret-looking query", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const sid = "s1";
    search(engine, sid, 1, "api_key sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")("No results");
    search(engine, sid, 2, "docker")("No results");
    const r3 = search(engine, sid, 3, "api_key sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")("No results");
    assert.strictEqual(r3.changed, true);
    assert.ok(!r3.msg.result.content[0].text.includes("sk-a"), "no fragment of the query, let alone a token, appears in the hint");
    assert.ok(!r3.msg.result.content[0].text.toLowerCase().includes("api_key"));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("negativeCache: off entirely — nothing is ever recorded or hinted, even across identical searches", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0" });
    const sid = "s1";
    search(engine, sid, 1, "roster assignment sheet")("No results");
    search(engine, sid, 2, "docker")("No results");
    const r3 = search(engine, sid, 3, "roster assignment sheet")("No results");
    assert.strictEqual(r3.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("negativeCache: a lever failure (a broken index/store) never breaks the relay", () => {
  const cfg = L.proxyConfig({ MEMGLOW_HOME: path.join(os.tmpdir(), "memglow-negl-broken-" + process.pid), MEMGLOW_PROXY_NEGATIVE_CACHE: "1" });
  const broken = L.createLevers({
    config: cfg, index: { resolve() { throw new Error("x"); }, note() { throw new Error("x"); }, fingerprint() { throw new Error("x"); } },
    savings: { add() {}, addClient() {} },
    negativeCacheStore: { available: () => true, recordFutile() { throw new Error("x"); }, lookup() { throw new Error("x"); }, forgetStale() { throw new Error("x"); } },
  });
  broken.clientMessage({ id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "x" } } });
  const m = { id: 1, result: { content: [{ type: "text", text: "No results" }] } };
  assert.deepStrictEqual(broken.serverMessage(m), { msg: m, changed: false });
});

// ---------------------------------------------------------------------------------------------
// Lever 12 — indexHint

test("indexHint: a search whose own results are ONLY the index note gets a suffix pointing to the matching index line(s) — never replaces the content", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0", MEMGLOW_PROXY_INDEX_HINT: "1" });
    const sid = "s1";
    const upstreamText = "### MEMORY\npermalink: MEMORY\nsnippet: s";
    const r = search(engine, sid, 1, "memory index")(upstreamText);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.msg.result.content[0].text, upstreamText, "original content kept, untouched, first");
    assert.strictEqual(r.msg.result.content.length, 2);
    assert.match(r.msg.result.content[1].text, /^memglow: the index already says:\n- /);
    assert.match(r.msg.result.content[1].text, /memory index/i);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("indexHint: no match in the index's own text — nothing added (never a bare 'says:' line)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0", MEMGLOW_PROXY_INDEX_HINT: "1" });
    const sid = "s1";
    const upstreamText = "### MEMORY\npermalink: MEMORY\nsnippet: s";
    const r = search(engine, sid, 1, "xylophone parade")(upstreamText);
    assert.strictEqual(r.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("indexHint: reading the index right after a search, with alreadyLoaded off, gets a suffix grepped from the SAME search's words", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0", MEMGLOW_PROXY_INDEX_HINT: "1" });
    const sid = "s1";
    search(engine, sid, 1, "roster assignment sheet")("No results");
    const r2 = read(engine, sid, 2, "MEMORY")("# Memory index\n\n- [[carol]] — Carol card, roster assignment sheet owner\n");
    assert.strictEqual(r2.changed, true);
    const texts = r2.msg.result.content.map((c) => c.text);
    assert.ok(texts.some((t) => t.startsWith("memglow: the index already says:")));
    assert.ok(texts.some((t) => t.includes("roster assignment sheet owner")));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("indexHint: no recent search at all — reading the index adds nothing", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0", MEMGLOW_PROXY_INDEX_HINT: "1" });
    const sid = "s1";
    const r1 = read(engine, sid, 1, "MEMORY")("# Memory index\n\n- [[carol]] — Carol card, roster assignment sheet owner\n");
    assert.strictEqual(r1.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("indexHint: alreadyLoaded on — the read-case never fires (that read is already handled by lever 8's own stub)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_NEGATIVE_CACHE: "0", MEMGLOW_PROXY_INDEX_HINT: "1", MEMGLOW_PROXY_ALREADY_LOADED: "1" });
    const sid = "s1";
    engine.clientMessage({ id: 0, method: "initialize", params: {} }, sid); // captures lever 8's baseline
    search(engine, sid, 1, "roster assignment sheet")("No results");
    const r2 = read(engine, sid, 2, "MEMORY")("# Memory index\n\n- [[carol]] — Carol card, roster assignment sheet owner\n");
    // Lever 8 stubs this read instead (same file, unchanged since session start): no indexHint text.
    assert.ok(!r2.msg.result.content.some((c) => c.text.startsWith("memglow: the index already says:")));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
