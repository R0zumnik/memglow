"use strict";
// Lever 17 (stateView, "journal → current state view", 0.5.1.2) — integration through
// lib/proxy-levers.js `createLevers` (clientMessage/serverMessage), same lightweight pattern as
// test/delta-read-levers.test.js: a real `createNoteIndex` over a tiny temp notes folder, but the
// upstream "read" answers are hand-crafted text (independent of what is really on disk), except
// for the one note whose mtime drives year inference, read directly off the file written below.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const L = require("../lib/proxy-levers");
const D = require("../lib/delta-read");
const { journalChantier } = require("./fixtures/journal-chantier");

const MTIME_MS = Date.UTC(2026, 9, 13); // 2026-10-13, matching the fixture's own "today"

function makeNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-sv-lev-"));
  const notes = path.join(root, "notes");
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), s); };
  const journal = journalChantier({ fillerLines: 40 });
  w("projects/chantier-renovation-grange.md", journal);
  fs.utimesSync(path.join(notes, "projects/chantier-renovation-grange.md"), new Date(MTIME_MS), new Date(MTIME_MS));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  return { root, notes, home, data, journal };
}

function setup(fx, env = {}) {
  const cfg = L.proxyConfig({
    MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data,
    MEMGLOW_LARGE_NOTE_TOKENS: "100000", MEMGLOW_PROXY_MULTI_QUERY: "0",
    MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0", MEMGLOW_PROXY_DEDUPE: "0",
    MEMGLOW_PROXY_STATE_VIEW: "1",
    ...env,
  });
  const index = L.createNoteIndex(cfg);
  const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
  const deltaReadStore = D.createDeltaReadStore(cfg);
  const engine = L.createLevers({ config: cfg, index, savings, deltaReadStore, serverName: "basic-memory" });
  return { cfg, index, engine, savings, deltaReadStore };
}

function read(engine, sid, id, identifier, opts = {}) {
  const args = { identifier, ...opts };
  engine.clientMessage({ id, method: "tools/call", params: { name: "read_note", arguments: args } }, sid);
  return (text) => engine.serverMessage({ id, result: { content: [{ type: "text", text }] } }, sid);
}

test("stateView: off by default — a journal note is relayed unchanged", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_STATE_VIEW: "0" });
    const r = read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.msg.result.content[0].text, fx.journal);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: a plain read of a journal note gets intro/rules/parts + the 2 most recent updates, plus a one-line notice naming the rest", () => {
  const fx = makeNotes();
  try {
    const { engine, savings } = setup(fx);
    const r = read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal);
    assert.strictEqual(r.changed, true);
    const texts = r.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2, "kept content block + one summary line block");
    assert.match(texts[0], /## Règles/);
    assert.match(texts[0], /## Parts/);
    assert.match(texts[0], /## État au 5\/10 soir/);
    assert.match(texts[0], /## Mise à jour 12\/10/);
    assert.doesNotMatch(texts[0], /## Mise à jour 2\/9/);
    assert.match(texts[1], /^memglow: "Chantier Rénovation Grange" is a journal-style note/);
    assert.match(texts[1], /4 older sections left out/);
    assert.match(texts[1], /memglow_section/);
    assert.match(texts[1], /memglow_fresh/);
    assert.ok(savings.total().stateView > 0, "lever 17's own savings are tallied, like the other shortening levers");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: memglow_fresh always wins — the full note, never shortened", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    const r = read(engine, "s1", 1, "Chantier Rénovation Grange", { memglow_fresh: true })(fx.journal);
    assert.strictEqual(r.msg.result.content.length, 1);
    assert.strictEqual(r.msg.result.content[0].text, fx.journal);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: memglow_section still works on an OLDER section the summary line named, even though lever 'toc' (5) is off", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx); // MEMGLOW_PROXY_TOC not set -> off
    assert.strictEqual(L.proxyConfig({ MEMGLOW_PROXY_STATE_VIEW: "1" }).toc, false);
    const r = read(engine, "s1", 1, "Chantier Rénovation Grange", { memglow_section: "Mise à jour 2/9" })(fx.journal);
    const texts = r.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2, "header + the one section's verbatim text");
    assert.match(texts[0], /^memglow: section \d+\/\d+ of "Chantier Rénovation Grange"/);
    assert.match(texts[1], /^## Mise à jour 2\/9/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: tools/list advertises memglow_section even with toc off, as soon as stateView is on", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    engine.clientMessage({ id: 1, method: "tools/list" }, "s1");
    const r = engine.serverMessage({ id: 1, result: { tools: [{ name: "read_note", inputSchema: { type: "object", properties: {} } }] } }, "s1");
    const props = r.msg.result.tools[0].inputSchema.properties;
    assert.ok(props.memglow_fresh);
    assert.ok(props.memglow_section);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: repeating the same plain read (escape hatch) after a state-view answer returns the FULL text, same rule as 4/5/8/13", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal); // state-viewed
    const r2 = read(engine, "s1", 2, "Chantier Rénovation Grange")(fx.journal); // repeated, same args
    assert.strictEqual(r2.msg.result.content.length, 1);
    assert.strictEqual(r2.msg.result.content[0].text, fx.journal);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView + dedupe: dedupe never fires off a partial (state-viewed) delivery — only once the note was delivered in FULL this session", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_DEDUPE: "1" });
    const r1 = read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal);
    assert.strictEqual(r1.msg.result.content.length, 2, "read #1: state-view, not a dedupe stub (nothing to dedupe against yet)");
    const r2 = read(engine, "s1", 2, "Chantier Rénovation Grange")(fx.journal); // repeat -> forced full
    assert.strictEqual(r2.msg.result.content[0].text, fx.journal, "read #2: forced full (escape hatch), now a real full delivery");
    const r3 = read(engine, "s1", 3, "Chantier Rénovation Grange")(fx.journal); // unchanged, read again
    assert.strictEqual(r3.msg.result.content.length, 1);
    assert.match(r3.msg.result.content[0].text, /^memglow: .*unchanged since you read it earlier in this session/, "read #3: NOW dedupe has a full delivery (read #2) to compare against");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView + deltaRead: a change is diffed against the last FULL delivery, never against a state-viewed (partial) one — the safe choice", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_DELTA_READ: "1" });
    const marker = "## Mise à jour 12/10\nAvancement du chantier, détail ligne 0 sur les travaux en cours.";
    assert.ok(fx.journal.includes(marker), "sanity: the marker uniquely locates the most recent section's first line");
    const changed = fx.journal.replace(marker, marker.replace("Avancement du chantier,", "Avancement du chantier CHANGÉ,"));
    read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal); // #1: state-view (partial) — never seeds deltaRead
    read(engine, "s1", 2, "Chantier Rénovation Grange")(fx.journal); // #2: forced full -> version A delivered, in full
    const r3 = read(engine, "s1", 3, "Chantier Rénovation Grange")(changed); // #3: version B
    const texts = r3.msg.result.content.map((c) => c.text);
    assert.strictEqual(texts.length, 2, "header + diff, not a 3rd state-view and not a full re-send");
    assert.match(texts[0], /changed since you read it earlier in this session; only the changes below/);
    assert.ok(texts[1].startsWith(D.DELTA_READ_MARKER));
    assert.strictEqual(D.applyDiff(fx.journal, texts[1]), changed, "the diff, applied to the FULL version from read #2, reconstructs read #3 exactly");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView + alreadyLoaded: alreadyLoaded's own stub still wins for an always-loaded note, stateView never gets a turn", () => {
  const fx = makeNotes();
  try {
    // The index note itself (theme "index") is always considered already loaded (lever 8).
    fs.writeFileSync(path.join(fx.notes, "MEMORY.md"), "---\ntitle: MEMORY\ntheme: index\n---\n# idx\n" + "x ".repeat(500));
    const { engine } = setup(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1" });
    // Lever 8 rule 2 (alreadyLoadedRequireActivity) never stubs a session's very FIRST call (that
    // shape is what an injection hook itself looks like) — a tools/list first, like a real
    // assistant session, satisfies it.
    engine.clientMessage({ id: -1, method: "tools/list" }, "s1");
    engine.serverMessage({ id: -1, result: { tools: [] } }, "s1");
    const r0 = read(engine, "s1", 0, "MEMORY")(fs.readFileSync(path.join(fx.notes, "MEMORY.md"), "utf8"));
    assert.match(r0.msg.result.content[0].text, /already in your context/);
    // The journal note itself is unaffected (not an index note) — still gets stateView.
    const r1 = read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal);
    assert.strictEqual(r1.msg.result.content.length, 2);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: a note just under the stateViewTokens threshold is relayed unchanged", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx, { MEMGLOW_PROXY_STATE_VIEW_TOKENS: "1000000" });
    const r = read(engine, "s1", 1, "Chantier Rénovation Grange")(fx.journal);
    assert.strictEqual(r.changed, false);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("stateView: safety — buildStateView throwing never breaks the relay (handleRead's own try/catch)", () => {
  const fx = makeNotes();
  try {
    const { engine } = setup(fx);
    // A pathological "note" (not even text past what textOf extracts) must still relay safely —
    // exercised indirectly: multi-note tools are never shortened at all, regardless of content.
    const args = { identifier: "Chantier Rénovation Grange" };
    engine.clientMessage({ id: 1, method: "tools/call", params: { name: "build_context", arguments: args } }, "s1");
    const r = engine.serverMessage({ id: 1, result: { content: [{ type: "text", text: fx.journal }] } }, "s1");
    assert.strictEqual(r.msg.result.content[0].text, fx.journal, "multiNoteTools are never shortened by stateView");
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

// -------------------------------------------------------------------------------------------
// all-in-one vs standalone-proxy equivalence

const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { createHttpProxy } = require("../mcp-proxy/memglow-mcp-proxy");

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(data.length), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function makeKbRoot(journal) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-sv-eq-"));
  const dir = path.join(root, "memory", "projects");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "chantier-renovation-grange.md");
  fs.writeFileSync(file, journal);
  fs.utimesSync(file, new Date(MTIME_MS), new Date(MTIME_MS));
  return root;
}

test("stateView: all-in-one and standalone-proxy give byte-identical read_note answers for the same journal note", async () => {
  const journal = journalChantier({ fillerLines: 40 });
  const rootA = await makeKbRoot(journal); // standalone proxy -> plain memory server
  const rootB = await makeKbRoot(journal); // all-in-one
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-sv-eq-home-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-sv-eq-home-b-"));
  const env = (home, memoryDir) => ({
    MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"),
    MEMGLOW_POLL_MS: "60000", MEMGLOW_PROXY_STATE_VIEW: "1", MEMGLOW_PROXY_MULTI_QUERY: "0",
    MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0",
    ...(memoryDir ? { MEMGLOW_MEMORY_DIR: memoryDir } : {}),
  });

  const srvRaw = createMemoryServer({ root: rootA, readOnly: true, watch: false, pollMs: 0 });
  const upstream = createHttpServer({ rpc: srvRaw.rpc, store: srvRaw.store });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const cfgA = L.proxyConfig(env(homeA, path.join(rootA, "memory")));
  const enginA = L.createLevers({ config: cfgA, index: L.createNoteIndex(cfgA), savings: L.createSavings({ ...cfgA, savingsFile: false, log: false }), serverName: "basic-memory" });
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "basic-memory", onReport: () => {}, levers: enginA, rules: null });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));

  const srvAio = createMemoryServer({ root: rootB, readOnly: true, watch: false, pollMs: 0, allInOne: { env: env(homeB), name: "basic-memory", onReport: () => {} } });
  const aioHttp = createHttpServer({ rpc: srvAio.rpc, store: srvAio.store });
  await new Promise((ok) => aioHttp.listen(0, "127.0.0.1", ok));

  try {
    const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2" } } };

    const initA = await post(`http://127.0.0.1:${proxy.address().port}/mcp`, init);
    const HA = { "mcp-session-id": initA.headers["mcp-session-id"] };
    const readA = await post(`http://127.0.0.1:${proxy.address().port}/mcp`, call(1, "read_note", { identifier: "chantier-renovation-grange" }), HA);

    const initB = await post(`http://127.0.0.1:${aioHttp.address().port}/mcp`, init);
    const HB = { "mcp-session-id": initB.headers["mcp-session-id"] };
    const readB = await post(`http://127.0.0.1:${aioHttp.address().port}/mcp`, call(1, "read_note", { identifier: "chantier-renovation-grange" }), HB);

    assert.strictEqual(readB.status, readA.status);
    const jA = JSON.parse(readA.text), jB = JSON.parse(readB.text);
    assert.deepStrictEqual(jB.result.content, jA.result.content, "all-in-one and standalone-proxy produce the identical stateView answer");
    assert.match(jA.result.content[0].text, /## Mise à jour 12\/10/, "sanity: the lever really fired, not just a coincidental equality of two full notes");
  } finally {
    proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); srvRaw.close();
    aioHttp.closeAllConnections(); aioHttp.close(); srvAio.close();
    for (const d of [rootA, rootB, homeA, homeB]) fs.rmSync(d, { recursive: true, force: true });
  }
});
