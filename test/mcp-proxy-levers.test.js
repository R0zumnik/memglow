"use strict";
// v0.4 MCP proxy levers (lib/proxy-levers.js), end to end through the stdio proxy and a fake
// basic-memory-like upstream (test/fixtures/fake-memory-mcp.js), plus unit tests of the pieces.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { lineRelay, sseRelay, createHttpProxy } = require("../mcp-proxy/memglow-mcp-proxy");
const L = require("../lib/proxy-levers");

const PROXY = path.join(__dirname, "..", "mcp-proxy", "memglow-mcp-proxy.js");
const FAKE = path.join(__dirname, "fixtures", "fake-memory-mcp.js");

const BIG_SECTIONS = ["Context", "Decisions", "Open questions"];
function makeNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-lv-"));
  const notes = path.join(root, "notes");
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), s); };
  w("people/alice.md", "---\ntitle: Alice\ndescription: Who Alice is\ntheme: people\nsubtheme: friends\n---\nAlice body SECRETBODY-alice, see [[bob]].\n" + "Alice details. ".repeat(80) + "\n");
  w("people/bob.md", "---\ntitle: Bob\ndescription: Bob card\ntheme: people\nsubtheme: friends\n---\nBob body SECRETBODY-bob.\n");
  w("people/carol.md", "---\ntitle: Carol\ndescription: Carol card\ntheme: people\nsubtheme: friends\n---\nCarol body SECRETBODY-carol.\n");
  const big = "Intro line SECRETBODY-big.\n\n" + BIG_SECTIONS.map((t, i) => `## ${t}\n\n` + `Paragraph ${i} SECRETBODY-big `.repeat(120) + "\n\n").join("");
  w("projects/big.md", "---\ntitle: Big plan\ndescription: A big project note\ntheme: projects\nsubtheme: plans\n---\n" + big);
  w("MEMORY.md", "# Index\n[[alice]] [[big]]\n");
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  fs.mkdirSync(home);
  return { root, notes, home, data, log: path.join(root, "args.log") };
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); out[path.relative(dir, p)] = fs.readFileSync(p, "utf8") + "|" + st.mtimeMs; } } };
  walk(dir);
  return out;
}

/** Starts the proxy (or the fake alone with direct: true) and returns a tiny JSON-RPC client. */
function start(fx, env = {}, { direct = false } = {}) {
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) if (k.startsWith("MEMGLOW_") || k === "MEMORY_DIR") delete baseEnv[k];
  const fullEnv = {
    ...baseEnv, MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_URL: "http://127.0.0.1:9",
    MEMGLOW_LARGE_NOTE_TOKENS: "1000", MEMGLOW_POLL_MS: "500", MEMGLOW_FAKE_MCP: "1", FAKE_NOTES_DIR: fx.notes, FAKE_ARGS_LOG: fx.log, ...env,
  };
  const args = direct ? [FAKE] : [PROXY, "--name", "basic-memory", "--", process.execPath, FAKE];
  const p = spawn(process.execPath, args, { env: fullEnv });
  let out = "", err = "";
  const lines = [];
  const waiters = new Map();
  p.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1);
      lines.push(line);
      const m = JSON.parse(line);
      if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  p.stderr.on("data", (d) => (err += d));
  let n = 0;
  const exited = new Promise((ok) => p.on("exit", ok));
  return {
    lines, stderr: () => err,
    rpc(method, params) {
      const id = ++n;
      return new Promise((ok, ko) => {
        const t = setTimeout(() => ko(new Error("timeout " + method)), 8000);
        waiters.set(id, (m) => { clearTimeout(t); ok(m); });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    call(name, args) { return this.rpc("tools/call", { name, arguments: args }); },
    async close() { p.stdin.end(); return exited; },
  };
}
const texts = (r) => r.result.content.map((c) => c.text);
const rawNote = (fx, rel) => fs.readFileSync(path.join(fx.notes, rel + ".md"), "utf8").replace(/^---\n/, `---\npermalink: ${rel}\n`);

test("defaults: size warning prefix, related-notes suffix, upstream content untouched, once per session", async () => {
  const fx = makeNotes();
  const c = start(fx);
  try {
    await c.rpc("initialize", {});
    const list = await c.rpc("tools/list", {});
    assert.ok(!JSON.stringify(list).includes("memglow_"), "levers 4/5 off: tools/list untouched");

    const a = await c.call("read_note", { identifier: "people/alice" });
    const ta = texts(a);
    assert.strictEqual(ta[0], rawNote(fx, "people/alice"), "upstream text first and byte-identical");
    assert.strictEqual(ta.length, 2);
    assert.match(ta[1], /^memglow: related notes: Bob `bob` \(≈\d+ tokens\)/);
    assert.match(ta[1], /Carol `carol`/, "same sub-theme");
    assert.ok(!ta[1].includes("SECRETBODY"), "never a body in suggestions");

    const b = await c.call("read_note", { identifier: "big" });
    const tb = texts(b);
    assert.match(tb[0], /^⚠ memglow: this note is ≈\d+ tokens \(threshold 1000\)\. Consider offering the user to split it into smaller notes within the same theme "Projects"; memglow's `split_plan` tool can propose sections\.$/);
    assert.strictEqual(tb[1], rawNote(fx, "projects/big"));
    const again = texts(await c.call("read_note", { identifier: "big" }));
    assert.strictEqual(again[0], rawNote(fx, "projects/big"), "warned only once per note and session");
    await c.rpc("initialize", {});
    assert.match(texts(await c.call("read_note", { identifier: "big" }))[0], /^⚠ memglow/, "a new session warns again");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("richer search results: compact metadata block appended, never bodies", async () => {
  const fx = makeNotes();
  const c = start(fx);
  try {
    const r = await c.call("search_notes", { query: "body" });
    const t = texts(r);
    assert.strictEqual(t.length, 2);
    assert.ok(t[0].includes("SECRETBODY"), "the upstream snippet itself is relayed as is");
    const block = t[1];
    assert.match(block, /^memglow: notes in these results/);
    assert.match(block, /- Alice `alice` · People\/friends · ≈\d+ tokens · Who Alice is/);
    assert.match(block, /- Big plan `big` · Projects\/plans · ≈\d+ tokens \(large\) · A big project note/);
    assert.ok(!block.includes("SECRETBODY"));
    const none = await c.call("search_notes", { query: "zzz-nothing" });
    assert.deepStrictEqual(texts(none), ["No results"], "nothing recognised: response untouched");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("write crossing the threshold is flagged; unknown tools and errors pass through unchanged", async () => {
  const fx = makeNotes();
  const c = start(fx);
  const d = start(fx, {}, { direct: true });
  try {
    const small = texts(await c.call("edit_note", { identifier: "carol", operation: "append", content: "short" }));
    assert.strictEqual(small.length, 1, "still small: no warning");
    const w = texts(await c.call("edit_note", { identifier: "carol", operation: "append", content: "x".repeat(6000) }));
    assert.match(w[0], /^⚠ memglow: this note is now ≈\d+ tokens \(threshold 1000\)\..*"People"/);
    assert.match(w[1], /^# Edited note/);
    const w2 = texts(await c.call("edit_note", { identifier: "carol", operation: "append", content: "y" }));
    assert.strictEqual(w2.length, 1, "once per note and session");

    for (const [name, args] of [["list_directory", {}], ["boom", {}], ["read_note", { identifier: "nope" }]]) {
      const before = c.lines.length, beforeD = d.lines.length;
      await c.call(name, args); await d.call(name, args);
      assert.strictEqual(c.lines[before].replace(/"id":\d+/, ""), d.lines[beforeD].replace(/"id":\d+/, ""), name + " relayed byte for byte");
    }
  } finally { await c.close(); await d.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("all levers off: every response line is byte-identical to the upstream's", async () => {
  const fx = makeNotes();
  const off = { MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_SEARCH_DETAILS: "false", MEMGLOW_PROXY_SUGGESTIONS: "off" };
  const c = start(fx, off);
  const d = start(fx, {}, { direct: true });
  try {
    const seq = [["tools/list", {}], ["tools/call", { name: "read_note", arguments: { identifier: "big" } }],
      ["tools/call", { name: "search_notes", arguments: { query: "body" } }], ["tools/call", { name: "read_note", arguments: { identifier: "alice" } }]];
    for (const [m, p] of seq) { await c.rpc(m, p); await d.rpc(m, p); }
    assert.deepStrictEqual(c.lines, d.lines);
  } finally { await c.close(); await d.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("session dedupe (opt-in): unchanged re-read shortened, repeat or memglow_fresh gives it back, savings counted", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    const list = await c.rpc("tools/list", {});
    const rn = list.result.tools.find((t) => t.name === "read_note");
    assert.strictEqual(rn.inputSchema.properties.memglow_fresh.type, "boolean");
    assert.ok(!rn.inputSchema.required.includes("memglow_fresh"));
    assert.ok(!list.result.tools.find((t) => t.name === "build_context").inputSchema.properties.memglow_fresh, "multi-note tools untouched");
    assert.ok(!list.result.tools.find((t) => t.name === "search_notes").inputSchema.properties.memglow_fresh);

    const full = rawNote(fx, "people/alice");
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice" })), [full]);
    const stub = texts(await c.call("read_note", { identifier: "people/alice" }));
    assert.strictEqual(stub.length, 1);
    assert.match(stub[0], /^memglow: "Alice" is unchanged since you read it earlier in this session \(≈\d+ tokens saved\)/);
    assert.match(stub[0], /"memglow_fresh": true/);
    assert.ok(!stub[0].includes("SECRETBODY"));
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice" })), [full], "the read after a short answer is full");
    assert.match(texts(await c.call("read_note", { identifier: "alice" }))[0], /unchanged/);
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice", memglow_fresh: true })), [full]);
    const logged = fs.readFileSync(fx.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(logged.every((e) => !("memglow_fresh" in e.args)), "memglow_* arguments never reach the server");

    await c.call("edit_note", { identifier: "alice", operation: "append", content: "\nnew fact" });
    const changed = texts(await c.call("read_note", { identifier: "alice" }));
    assert.match(changed[0], /new fact/, "changed note: full content again");
    await c.close();
    assert.match(c.stderr(), /memglow-mcp-proxy: dedupe saved ≈\d+ tokens on alice/);
    const sv = JSON.parse(fs.readFileSync(path.join(fx.data, "proxy-savings.json"), "utf8"));
    const day = Object.values(sv.days)[0];
    assert.ok(day.dedupe > 0 && day.dedupeCalls === 2, JSON.stringify(sv));
  } finally {
    await c.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("table of contents first (opt-in): outline, one section verbatim, full on demand", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_TOC: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    const list = await c.rpc("tools/list", {});
    assert.strictEqual(list.result.tools.find((t) => t.name === "read_note").inputSchema.properties.memglow_section.type, "string");
    const full = rawNote(fx, "projects/big");
    const toc = texts(await c.call("read_note", { identifier: "big" }));
    assert.strictEqual(toc.length, 1);
    assert.match(toc[0], /^⚠ memglow: this note is ≈\d+ tokens/m, "the size warning leads the outline");
    assert.match(toc[0], /only its outline is shown/);
    assert.match(toc[0], /Description: A big project note/);
    assert.match(toc[0], /2\. ## Context \(≈\d+ tokens\)\n3\. ## Decisions/);
    assert.ok(!toc[0].includes("SECRETBODY") && !toc[0].includes("Paragraph"), "no body in the outline");

    const sec = texts(await c.call("read_note", { identifier: "big", memglow_section: "Decisions" }));
    assert.match(sec[0], /^memglow: section 3\/4 of "Big plan"/);
    const start3 = full.indexOf("## Decisions"), end3 = full.indexOf("## Open questions");
    assert.strictEqual(sec[1], full.slice(start3, end3), "the section is a verbatim slice of the upstream answer");
    assert.strictEqual(texts(await c.call("read_note", { identifier: "big", memglow_section: "4" }))[1], full.slice(end3));
    assert.match(texts(await c.call("read_note", { identifier: "big", memglow_section: "Nope" }))[0], /Section "Nope" was not found/);
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "big" })), [full], "repeat after a short answer: full");
    assert.match(texts(await c.call("read_note", { identifier: "big" }))[0], /outline/);
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "big", memglow_fresh: true })), [full]);
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice" })), [rawNote(fx, "people/alice")], "small notes are never cut");
  } finally {
    await c.close();
    assert.match(c.stderr(), /toc saved ≈\d+ tokens on big/);
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("levers 4/5 never touch structuredContent answers; the proxy writes nothing in the notes folder", async () => {
  const fx = makeNotes();
  const before = snapshot(fx.notes);
  const c = start(fx, { MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_TOC: "1", MEMGLOW_PROXY_READ_TOOLS: "read_note,structured_read,build_context" });
  try {
    const s1 = await c.call("structured_read", { identifier: "big" });
    const s2 = await c.call("structured_read", { identifier: "big" });
    for (const r of [s1, s2]) assert.ok(r.result.structuredContent && r.result.content.some((x) => x.text.includes("SECRETBODY-big")));
    for (const id of ["alice", "alice", "big", "bob"]) await c.call("read_note", { identifier: id });
    await c.call("build_context", { url: "memory://projects/big" });
    await c.call("search_notes", { query: "body" });
  } finally { await c.close(); }
  assert.deepStrictEqual(snapshot(fx.notes), before, "notes folder unchanged");
  assert.deepStrictEqual(fs.existsSync(fx.data) ? fs.readdirSync(fx.data) : [], ["proxy-savings.json"]);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test("note index: cached — no rescan per call", () => {
  const fx = makeNotes();
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_POLL_MS: "60000" });
  const idx = L.createNoteIndex(cfg);
  const orig = fs.readdirSync;
  let calls = 0;
  fs.readdirSync = function (...a) { calls++; return orig.apply(this, a); };
  try {
    idx.resolve("alice");
    const first = calls;
    assert.ok(first > 0, "first lookup scans");
    for (let i = 0; i < 300; i++) { idx.resolve("people/bob"); idx.related("alice", 3, new Set()); idx.note("big"); }
    assert.strictEqual(calls, first, "no folder walk during the poll interval");
  } finally { fs.readdirSync = orig; fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("config: file `proxy` key, env overrides, clamping", () => {
  const fx = makeNotes();
  fs.writeFileSync(path.join(fx.home, "memglow.config.json"), JSON.stringify({
    memoryDir: fx.notes, largeNoteTokens: 3000,
    proxy: { dedupe: true, suggestions: false, suggestionsMax: 99, readTools: ["read_note"] },
  }));
  try {
    const c = L.proxyConfig({ MEMGLOW_HOME: fx.home });
    assert.deepStrictEqual([c.sizeWarning, c.searchDetails, c.suggestions, c.dedupe, c.toc], [true, true, false, true, false]);
    assert.strictEqual(c.suggestionsMax, 3, "out of range → default");
    assert.deepStrictEqual(c.readTools, ["read_note"]);
    assert.strictEqual(c.largeNoteTokens, 3000);
    assert.strictEqual(c.memoryDir, fx.notes);
    const e = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_PROXY_DEDUPE: "0", MEMGLOW_PROXY_TOC: "yes", MEMGLOW_PROXY_SEARCH_TOOLS: "find,lookup" });
    assert.deepStrictEqual([e.dedupe, e.toc], [false, true]);
    assert.deepStrictEqual(e.searchTools, ["find", "lookup"]);
    assert.strictEqual(L.anyLever({ ...e, sizeWarning: false, searchDetails: false, suggestions: false, dedupe: false, toc: false }), false);
    const def = L.proxyConfig({ MEMGLOW_HOME: path.join(fx.root, "nowhere") });
    assert.deepStrictEqual([def.sizeWarning, def.searchDetails, def.suggestions, def.dedupe, def.toc], [true, true, true, false, false]);
    assert.strictEqual(def.memoryDir, null);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("engine: no notes folder → levers needing metadata stay silent; a failing lever never breaks the relay", () => {
  const cfg = L.proxyConfig({ MEMGLOW_HOME: path.join(os.tmpdir(), "memglow-none-" + process.pid), MEMGLOW_LARGE_NOTE_TOKENS: "200" });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }) });
  engine.clientMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: {} } });
  const res = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "permalink: people/alice" }] } };
  assert.deepStrictEqual(engine.serverMessage(res), { msg: res, changed: false });
  // a large unknown note still gets the size warning (estimated from the answer itself), without a theme
  engine.clientMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "x" } } });
  const big = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "z".repeat(4000) }] } };
  const r = engine.serverMessage(big);
  assert.match(r.msg.result.content[0].text, /^⚠ memglow: this note is ≈1000 tokens \(threshold 200\)\. Consider offering the user to split it into smaller notes; /);
  assert.strictEqual(r.msg.result.content[1], big.result.content[0]);
  // a server-to-client request reusing one of our ids is not mistaken for the answer
  engine.clientMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_note", arguments: { identifier: "y" } } });
  const srvReq = { jsonrpc: "2.0", id: 4, method: "sampling/createMessage", params: {} };
  assert.deepStrictEqual(engine.serverMessage(srvReq), { msg: srvReq, changed: false });
  assert.strictEqual(engine.serverMessage({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "w".repeat(4000) }] } }).changed, true);
  const broken = L.createLevers({ config: cfg, index: { resolve() { throw new Error("x"); } }, savings: { add() {} } });
  broken.clientMessage({ id: 3, method: "tools/call", params: { name: "read_note", arguments: { identifier: "x" } } });
  const m = { id: 3, result: { content: [{ type: "text", text: "hi" }] } };
  assert.deepStrictEqual(broken.serverMessage(m), { msg: m, changed: false });
});

test("lineRelay keeps untouched lines byte for byte (multi-byte split, CRLF, partial tail); sseRelay rewrites one event", () => {
  const out = [];
  const r = lineRelay((b) => out.push(Buffer.from(b)), (m) => (m.x === 2 ? JSON.stringify({ x: 20 }) : null));
  const wire = Buffer.from('{"x":1,"s":"é✓"}\r\n{"x":2}\nnot json\n{"tail"', "utf8");
  for (let i = 0; i < wire.length; i += 3) r.push(wire.subarray(i, i + 3));
  r.end();
  assert.strictEqual(Buffer.concat(out).toString("utf8"), '{"x":1,"s":"é✓"}\r\n{"x":20}\nnot json\n{"tail"');
  const raw = [];
  const big = lineRelay((b) => raw.push(Buffer.from(b)), () => "never", 10);
  big.push(Buffer.from('{"a":"0123456789abc"}')); big.push(Buffer.from('\n{"b":1}\n'));
  assert.strictEqual(Buffer.concat(raw).toString(), '{"a":"0123456789abc"}\nnever\n', "over-long line relayed raw");

  const ev = [];
  const s = sseRelay((t) => ev.push(t), (m) => (m.id === 2 ? JSON.stringify({ id: 2, ok: true }) : null));
  s.push(Buffer.from('event: message\ndata: {"id":1}\r\n\r\nevent: message\nid: 7\ndata: {"id"'));
  s.push(Buffer.from(':2}\n\n: ping\n\n'));
  s.end();
  assert.strictEqual(ev.join(""), 'event: message\ndata: {"id":1}\r\n\r\nevent: message\nid: 7\ndata: {"id":2,"ok":true}\n\n: ping\n\n');
});

test("HTTP proxy with levers: JSON answer gets the suffix with a correct Content-Length; SSE answer rewritten", async () => {
  const fx = makeNotes();
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "1000" });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }) });
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      const result = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "permalink: people/alice\nhello" }] } };
      if (m.id === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: message\ndata: " + JSON.stringify(result) + "\n\n");
      } else {
        const body = JSON.stringify(result);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      }
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "notes", onReport: () => {}, levers: engine });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}/mcp`;
  const call = (id, name, args) => fetch(base, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s9" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  try {
    const r1 = await call(1, "read_note", { identifier: "alice" });
    const body = await r1.text();
    assert.strictEqual(Number(r1.headers.get("content-length")), Buffer.byteLength(body));
    const j = JSON.parse(body);
    assert.strictEqual(j.result.content[0].text, "permalink: people/alice\nhello");
    assert.match(j.result.content[1].text, /^memglow: related notes: Bob `bob`/);
    const r2 = await call("sse", "search_notes", { query: "x" });
    const t2 = await r2.text();
    assert.match(t2, /^event: message\ndata: \{/);
    const data = JSON.parse(t2.split("\n").find((l) => l.startsWith("data: ")).slice(6));
    assert.match(data.result.content[1].text, /Alice `alice` · People\/friends/);
    const r3 = await call(3, "list_directory", {});
    assert.deepStrictEqual((await r3.json()).result.content, [{ type: "text", text: "permalink: people/alice\nhello" }], "other tools untouched");
  } finally {
    upstream.closeAllConnections(); upstream.close();
    proxy.closeAllConnections(); proxy.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
