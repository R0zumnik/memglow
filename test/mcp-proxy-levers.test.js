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
  // MEMGLOW_RULES=0: memglow's built-in memory rules are a separate, independent layer (ON by
  // default) — this test is about the LEVERS being off, see memory-rules.test.js for the rules.
  const off = { MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_SEARCH_DETAILS: "false", MEMGLOW_PROXY_SUGGESTIONS: "off", MEMGLOW_PROXY_HIDE_UNSUPPORTED: "0", MEMGLOW_RULES: "0" };
  const c = start(fx, off);
  const d = start(fx, {}, { direct: true });
  try {
    const seq = [["initialize", { clientInfo: { name: "claude-code", version: "2.1.283" } }], ["tools/list", {}],
      ["tools/call", { name: "read_note", arguments: { identifier: "big" } }],
      ["tools/call", { name: "search_notes", arguments: { query: "body" } }], ["tools/call", { name: "read_note", arguments: { identifier: "alice" } }]];
    for (const [m, p] of seq) { await c.rpc(m, p); await d.rpc(m, p); }
    assert.deepStrictEqual(c.lines, d.lines);
    const list = JSON.parse(c.lines[1]);
    assert.ok(list.result.tools.some((t) => t.name === "search"), "hideUnsupportedTools off: basic-memory's ChatGPT tools still listed");
  } finally { await c.close(); await d.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("hideUnsupportedTools (opt-in): basic-memory's search/fetch hidden per client session, never for OpenAI's, never for an unknown client", async () => {
  const fx = makeNotes();
  const on = { MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1" };
  const names = (list) => list.result.tools.map((t) => t.name).sort();

  // Claude Code: not the OpenAI MCP client → search/fetch hidden, everything else untouched.
  const c1 = start(fx, on);
  try {
    await c1.rpc("initialize", { clientInfo: { name: "claude-code", version: "2.1.283" } });
    const list1 = await c1.rpc("tools/list", {});
    assert.deepStrictEqual(names(list1), ["build_context", "edit_note", "list_directory", "read_note", "search_notes", "write_note"]);
  } finally { await c1.close(); }

  // OpenAI's own MCP client (basic-memory's exact label, client_info_is_openai_mcp()): never hidden.
  const c2 = start(fx, on);
  try {
    await c2.rpc("initialize", { clientInfo: { name: "openai-mcp", version: "1.0" } });
    const list2 = await c2.rpc("tools/list", {});
    assert.ok(names(list2).includes("search") && names(list2).includes("fetch"), "OpenAI MCP client keeps both tools");
  } finally { await c2.close(); }

  // A versioned OpenAI client ("openai-mcp/<version>") — same prefix rule basic-memory itself uses.
  const c3 = start(fx, on);
  try {
    await c3.rpc("initialize", { clientInfo: { title: "openai-mcp/2.0" } });
    const list3 = await c3.rpc("tools/list", {});
    assert.ok(names(list3).includes("search") && names(list3).includes("fetch"), "openai-mcp/2.0 (via title) keeps both tools");
  } finally { await c3.close(); }

  // No clientInfo at all (never initialized, or an empty one): unknown → cautious → hide nothing.
  const c4 = start(fx, on);
  try {
    const list4 = await c4.rpc("tools/list", {});
    assert.ok(names(list4).includes("search") && names(list4).includes("fetch"), "unknown client: nothing hidden");
  } finally { await c4.close(); }
  const c5 = start(fx, on);
  try {
    await c5.rpc("initialize", { clientInfo: {} });
    const list5 = await c5.rpc("tools/list", {});
    assert.ok(names(list5).includes("search") && names(list5).includes("fetch"), "clientInfo with no name/title: unknown, nothing hidden");
  } finally { await c5.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("hideUnsupportedTools: a hidden tool called anyway is still relayed to the real server, no fabricated error", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1" });
  try {
    await c.rpc("initialize", { clientInfo: { name: "claude-code" } });
    const list = await c.rpc("tools/list", {});
    assert.ok(!list.result.tools.some((t) => t.name === "search"), "hidden from the list");
    const r = await c.call("search", { query: "hello" });
    assert.ok(!r.result.isError, "the call itself still succeeds, untouched");
    assert.match(texts(r)[0], /^search-called:\{"query":"hello"\}$/, "reached the real upstream handler, no proxy-made error");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("hideUnsupportedTools: config override replaces the default table (not a merge)", async () => {
  const fx = makeNotes();
  fs.writeFileSync(path.join(fx.home, "memglow.config.json"), JSON.stringify({
    memoryDir: fx.notes,
    proxy: { hideUnsupportedTools: true, unsupportedTools: { "basic-memory": { list_directory: ["claude-code"] } } },
  }));
  const names = (list) => list.result.tools.map((t) => t.name).sort();

  const allowed = start(fx, {});
  try {
    await allowed.rpc("initialize", { clientInfo: { name: "claude-code" } });
    const list = await allowed.rpc("tools/list", {});
    assert.ok(names(list).includes("list_directory"), "claude-code is in the overridden allow list: kept");
    assert.ok(names(list).includes("search") && names(list).includes("fetch"), "default basic-memory entry replaced, not merged: search/fetch no longer gated");
  } finally { await allowed.close(); }

  const other = start(fx, {});
  try {
    await other.rpc("initialize", { clientInfo: { name: "cursor" } });
    const list = await other.rpc("tools/list", {});
    assert.ok(!names(list).includes("list_directory"), "cursor is not in the overridden allow list: hidden");
  } finally { await other.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
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

test("per-client accounting: baseline tokens relayed per read, tallied per client bucket, BEFORE dedupe/toc shorten the answer", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", { clientInfo: { name: "claude-code", version: "2.1.283" } });
    const full = rawNote(fx, "people/alice");
    const fullTokens = Math.ceil(Buffer.byteLength(full, "utf8") / 4);
    await c.call("read_note", { identifier: "alice" }); // full delivery
    const stub = texts(await c.call("read_note", { identifier: "people/alice" })); // dedupe stub: a few tokens only
    assert.match(stub[0], /unchanged/);
    await c.close();
    const sv = JSON.parse(fs.readFileSync(path.join(fx.data, "proxy-savings.json"), "utf8"));
    const day = Object.values(sv.days)[0];
    assert.ok(day.clients && day.clients["claude-code"], JSON.stringify(sv));
    assert.strictEqual(day.clients["claude-code"].calls, 2, "both reads counted, even the shortened one");
    // the SECOND call's baseline is the full note's size again (pre-dedupe), not the tiny stub that was actually sent
    assert.ok(day.clients["claude-code"].tokens >= fullTokens * 2 - 2, JSON.stringify(day.clients));
  } finally {
    await c.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("per-client accounting: unknown client (no clientInfo sent) and an unlisted MCP client each get their own bucket", async () => {
  const fx = makeNotes();
  const c = start(fx); // one process (one file writer): no initialize yet, so clientInfo starts null
  try {
    await c.call("read_note", { identifier: "alice" }); // clientInfo still unset: "unknown"
    await c.rpc("initialize", { clientInfo: { title: "SomeFutureTool/9.0" } });
    await c.call("read_note", { identifier: "bob" });
    await c.close();
    const sv = JSON.parse(fs.readFileSync(path.join(fx.data, "proxy-savings.json"), "utf8"));
    const day = Object.values(sv.days)[0];
    assert.strictEqual(day.clients.unknown.calls, 1, JSON.stringify(day.clients));
    assert.strictEqual(day.clients["SomeFutureTool/9.0"].calls, 1, JSON.stringify(day.clients));
  } finally {
    await c.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("clientBucket: known MCP client ids/labels matched case-insensitively, unlisted raw name kept, no name/title = unknown", () => {
  assert.strictEqual(L.clientBucket({ name: "Cursor" }), "cursor");
  assert.strictEqual(L.clientBucket({ name: "CLAUDE-CODE" }), "claude-code");
  assert.strictEqual(L.clientBucket({ title: "GitHub Copilot" }), "copilot");
  assert.strictEqual(L.clientBucket({ name: "some-other-tool" }), "some-other-tool");
  assert.strictEqual(L.clientBucket({ name: "  " }), "unknown");
  assert.strictEqual(L.clientBucket(null), "unknown");
  assert.strictEqual(L.clientBucket({ name: "x".repeat(200) }).length, 60, "capped");
});

test("readClientSavings: sums `clients` across the window, ignores other days and malformed entries, null without a data folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-readclients-"));
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
  const tooOld = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({
    version: 1,
    days: {
      [today]: { clients: { "claude-code": { tokens: 100, calls: 2 } } },
      [yesterday]: { clients: { "claude-code": { tokens: 50, calls: 1 }, cursor: { tokens: 10, calls: 1 } } },
      [tooOld]: { clients: { cursor: { tokens: 99999, calls: 99 } } }, // outside the 7-day window: ignored
      "not-a-day": { clients: { x: "not an object" } }, // malformed: ignored without throwing
    },
  }));
  const r = L.readClientSavings(dir, { now, windowDays: 7 });
  assert.deepStrictEqual(r, { days: 7, byClient: { "claude-code": { tokens: 150, calls: 3 }, cursor: { tokens: 10, calls: 1 } } });
  assert.strictEqual(L.readClientSavings(null), null, "no data folder at all: null, not a throw");
  assert.deepStrictEqual(L.readClientSavings(path.join(dir, "does-not-exist")), { days: 7, byClient: {} }, "unreadable file: empty, still valid");
  fs.rmSync(dir, { recursive: true, force: true });
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

/** Overwrites the test fixture's index note with enough text that its stub (lever 8) is shorter than it. */
function growIndex(fx) {
  fs.writeFileSync(path.join(fx.notes, "MEMORY.md"), "# Index\n[[alice]] [[big]]\n\n" + "Paragraph about the project context. ".repeat(40));
}

test("alreadyLoaded (opt-in): the index note is stubbed every read while unchanged, memglow_fresh bypasses it, other notes and multi-note tools are untouched, savings counted", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", {});
    const list = await c.rpc("tools/list", {});
    const rn = list.result.tools.find((t) => t.name === "read_note");
    assert.strictEqual(rn.inputSchema.properties.memglow_fresh.type, "boolean", "lever 8 alone is enough to advertise memglow_fresh");
    assert.ok(!rn.inputSchema.properties.memglow_section, "lever 8 never adds memglow_section (that one is lever 5's)");
    assert.ok(!list.result.tools.find((t) => t.name === "build_context").inputSchema.properties.memglow_fresh, "multi-note tools untouched");

    const full = rawNote(fx, "MEMORY");
    const stub = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(stub.length, 1);
    assert.match(stub[0], /^memglow: "MEMORY" \(≈\d+ tokens\) is already in your context — it is loaded at the start of every session and has not changed since this session began \(sha [0-9a-f]{8}\)\. Use it from there\. To get the full text anyway, call again with "memglow_fresh": true\.$/);
    assert.ok(!stub[0].includes("Paragraph about"), "no body in the stub");

    // Unlike dedupe (second+ read only), every read of an unchanged always-loaded note is stubbed.
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "MEMORY" })), stub);

    // Escape hatch: memglow_fresh gives the real content back.
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "MEMORY", memglow_fresh: true })), [full]);
    const logged = fs.readFileSync(fx.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(logged.every((e) => !("memglow_fresh" in e.args)), "memglow_fresh never reaches the server");

    // A note that is neither the index nor a configured `alwaysLoaded` entry is never touched.
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice" })), [rawNote(fx, "people/alice")]);

    // Multi-note tools never get the stub, even for the index note.
    const ctx = texts(await c.call("build_context", { url: "memory://MEMORY" }));
    assert.ok(ctx.some((t) => t.includes("Paragraph about")), "build_context (multi-note) is never shortened by lever 8");
  } finally {
    await c.close();
    assert.match(c.stderr(), /memglow-mcp-proxy: alreadyLoaded saved ≈\d+ tokens on MEMORY/);
    const sv = JSON.parse(fs.readFileSync(path.join(fx.data, "proxy-savings.json"), "utf8"));
    const day = Object.values(sv.days)[0];
    assert.ok(day.alreadyLoaded > 0 && day.alreadyLoadedCalls >= 2, JSON.stringify(sv));
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("alreadyLoaded (opt-in): a resolved `alwaysLoaded` config entry is stubbed too; an entry that is not a note is simply ignored", async () => {
  const fx = makeNotes();
  fs.writeFileSync(path.join(fx.home, "memglow.config.json"), JSON.stringify({ alwaysLoaded: ["projects/big.md", "/etc/some-other-tool/AGENTS.md"] }));
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_LARGE_NOTE_TOKENS: "100000" });
  try {
    await c.rpc("initialize", {});
    const stub = texts(await c.call("read_note", { identifier: "big" }));
    assert.strictEqual(stub.length, 1);
    assert.match(stub[0], /^memglow: "Big plan" \(≈\d+ tokens\) is already in your context/);
    assert.ok(!stub[0].includes("SECRETBODY"));
    // A note that is not listed (and not the index) is never touched.
    assert.deepStrictEqual(texts(await c.call("read_note", { identifier: "alice" })), [rawNote(fx, "people/alice")]);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded (opt-in): a note changed since the session began is never stubbed — full content, with a one-line note; a fresh session re-captures the baseline", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", {});
    assert.strictEqual(texts(await c.call("read_note", { identifier: "MEMORY" })).length, 1, "unchanged: stubbed");

    fs.writeFileSync(path.join(fx.notes, "MEMORY.md"), "# Index\n[[alice]] [[big]] [[carol]]\n\nSomething NEW was added.\n");
    const changed = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(changed.length, 2);
    assert.strictEqual(changed[0], rawNote(fx, "MEMORY"), "full, current content — never a stub for a changed note");
    assert.match(changed[1], /^memglow: "MEMORY" was already in your context at the start of this session, but it has changed since the start of this session \(now sha [0-9a-f]{8}\) — shown in full\.$/);

    // Still "changed" on a further read of the same session: the baseline is not updated mid-session.
    const again = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(again.length, 2);
    assert.match(again[1], /has changed since the start of this session/);

    // A new session (re-`initialize`) captures a fresh baseline: the new content is "unchanged" again.
    await c.rpc("initialize", {});
    assert.strictEqual(texts(await c.call("read_note", { identifier: "MEMORY" })).length, 1, "new session, new baseline: stubbed again");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded: off by default — the index note is delivered in full, exactly as every other lever would be", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    const t = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.ok(t.some((x) => x.includes("Paragraph about")), "full content still delivered, lever 8 is off by default");
    assert.ok(!t.some((x) => x.includes("already in your context")));
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded: a lever failure (fileHash throwing on the live check) never breaks the relay", () => {
  const cfg = { ...L.proxyConfig({ MEMGLOW_HOME: os.tmpdir(), MEMGLOW_CONFIG: path.join(os.tmpdir(), "none.json") }), alreadyLoaded: true, readTools: ["read_note"], multiNoteTools: [] };
  let calls = 0;
  const idx = {
    resolve: (r) => (r === "MEMORY" ? "MEMORY" : null),
    note: (id) => (id === "MEMORY" ? { id: "MEMORY", label: "MEMORY", theme: "index", tokens: 999 } : null),
    related: () => [], afterWrite() {}, isArchive: () => false, archiveEntries: () => [],
    alwaysLoadedIds: () => new Set(["MEMORY"]),
    fileHash() { calls++; if (calls === 1) return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; throw new Error("disk exploded"); },
  };
  const e = L.createLevers({ config: cfg, index: idx, savings: { add() {}, addClient() {} } });
  e.clientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }); // baseline captured here (call #1)
  e.clientMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "MEMORY" } } });
  const msg = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "permalink: MEMORY\n" + "z".repeat(4000) }] } };
  assert.deepStrictEqual(e.serverMessage(msg), { msg, changed: false }, "the live fileHash check (call #2) throws: relay unchanged");
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

test("FastMCP text wrapper (structuredContent { result }): kept equal to the annotated text, so clients that show it see the levers", async () => {
  const fx = makeNotes();
  const c = start(fx, { FAKE_WRAP: "1", MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_TOC: "1" });
  try {
    const sc = (r) => r.result.structuredContent.result;
    const joined = (r) => texts(r).join("\n\n");
    // Lever 3 (suggestions) on a plain read: both views carry the suffix.
    const a = await c.call("read_note", { identifier: "alice" });
    assert.match(sc(a), /memglow: related notes: Bob/);
    assert.strictEqual(sc(a), joined(a));
    assert.ok(sc(a).includes("SECRETBODY-alice"), "upstream text still there, untouched");
    // Lever 4 (dedupe) now applies to wrapped answers too; the wrapper says the same as content.
    const a2 = await c.call("read_note", { identifier: "alice" });
    assert.match(sc(a2), /is unchanged since you read it earlier/);
    assert.ok(!sc(a2).includes("SECRETBODY-alice"));
    assert.strictEqual(sc(a2), joined(a2));
    // Lever 5 (toc) on the large note.
    const b = await c.call("read_note", { identifier: "big" });
    assert.match(sc(b), /only its outline is shown/);
    assert.strictEqual(sc(b), joined(b));
    // Lever 2 (search details).
    const s = await c.call("search_notes", { query: "carol" });
    assert.match(sc(s), /memglow: notes in these results/);
    assert.strictEqual(sc(s), joined(s));
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("FastMCP text wrapper: recognised strictly", () => {
  // A wrapper whose text differs from content, or with another key, is not a wrapper: left alone.
  const cfg = L.proxyConfig({ MEMGLOW_HOME: os.tmpdir(), MEMGLOW_CONFIG: path.join(os.tmpdir(), "none.json"), MEMGLOW_PROXY_DEDUPE: "1" });
  const idx = { resolve: () => null, note: () => null, related: () => [], afterWrite() {}, isArchive: () => false, archiveEntries: () => [] };
  const e = L.createLevers({ config: cfg, index: idx, savings: { add() {} } });
  const call = (id, sc) => {
    e.clientMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_note", arguments: { identifier: "x" } } });
    return e.serverMessage({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "body ".repeat(400) }], structuredContent: sc } });
  };
  call(1, { result: "different" });
  assert.strictEqual(call(2, { result: "different" }).changed, false, "not a wrapper: never deduplicated");
  call(3, { result: "body ".repeat(400), extra: 1 });
  assert.strictEqual(call(4, { result: "body ".repeat(400), extra: 1 }).changed, false);
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
    alwaysLoaded: ["  CLAUDE.md  ", "", "bad\u0001name", "a".repeat(600), ...Array.from({ length: 25 }, (_, i) => "f" + i)],
    proxy: { dedupe: true, suggestions: false, suggestionsMax: 99, readTools: ["read_note"], alreadyLoaded: true },
  }));
  try {
    const c = L.proxyConfig({ MEMGLOW_HOME: fx.home });
    assert.deepStrictEqual([c.sizeWarning, c.searchDetails, c.suggestions, c.dedupe, c.toc], [true, true, false, true, false]);
    assert.strictEqual(c.suggestionsMax, 3, "out of range → default");
    assert.deepStrictEqual(c.readTools, ["read_note"]);
    assert.strictEqual(c.largeNoteTokens, 3000);
    assert.strictEqual(c.memoryDir, fx.notes);
    assert.strictEqual(c.alreadyLoaded, true);
    assert.ok(c.alwaysLoaded.includes("CLAUDE.md"), "trimmed");
    assert.ok(!c.alwaysLoaded.some((s) => s.includes("\u0001")), "control characters rejected");
    assert.ok(!c.alwaysLoaded.includes("a".repeat(600)), "over-long entry rejected");
    assert.strictEqual(c.alwaysLoaded.length, 20, "capped at 20");
    const e = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_PROXY_DEDUPE: "0", MEMGLOW_PROXY_TOC: "yes", MEMGLOW_PROXY_SEARCH_TOOLS: "find,lookup", MEMGLOW_PROXY_ALREADY_LOADED: "0" });
    assert.deepStrictEqual([e.dedupe, e.toc, e.alreadyLoaded], [false, true, false]);
    assert.deepStrictEqual(e.searchTools, ["find", "lookup"]);
    assert.strictEqual(L.anyLever({ ...e, sizeWarning: false, searchDetails: false, suggestions: false, dedupe: false, toc: false }), false);
    const def = L.proxyConfig({ MEMGLOW_HOME: path.join(fx.root, "nowhere") });
    assert.deepStrictEqual([def.sizeWarning, def.searchDetails, def.suggestions, def.dedupe, def.toc, def.alreadyLoaded], [true, true, true, false, false, false]);
    assert.deepStrictEqual(def.alwaysLoaded, [], "no config file: nothing always-loaded beyond the index");
    assert.strictEqual(def.memoryDir, null);
    assert.strictEqual(L.anyLever({ alreadyLoaded: true }), true, "alreadyLoaded alone is enough to turn levers on");
    // hideUnsupportedTools: off by default, basic-memory's search/fetch gated to openai-mcp by default.
    assert.strictEqual(def.hideUnsupportedTools, false);
    assert.deepStrictEqual(def.unsupportedTools, L.DEFAULT_UNSUPPORTED_TOOLS);
    assert.deepStrictEqual(def.unsupportedTools["basic-memory"], { search: ["openai-mcp"], fetch: ["openai-mcp"] });
    const hid = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1" });
    assert.strictEqual(hid.hideUnsupportedTools, true);
    assert.strictEqual(L.anyLever({ hideUnsupportedTools: true }), true, "hideUnsupportedTools alone is enough to turn levers on");
    // A malformed or empty override falls back to the default table, not to an empty one.
    fs.writeFileSync(path.join(fx.home, "memglow.config.json"), JSON.stringify({ proxy: { unsupportedTools: "nope" } }));
    assert.deepStrictEqual(L.proxyConfig({ MEMGLOW_HOME: fx.home }).unsupportedTools, L.DEFAULT_UNSUPPORTED_TOOLS);
    // A real override fully replaces the table (checked end to end in the proxy test above too).
    fs.writeFileSync(path.join(fx.home, "memglow.config.json"), JSON.stringify({ proxy: { unsupportedTools: { other: { x: ["y"] } } } }));
    assert.deepStrictEqual(L.proxyConfig({ MEMGLOW_HOME: fx.home }).unsupportedTools, { other: { x: ["y"] } });
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("hideUnsupportedTools: client-matching helpers mirror basic-memory's client_info_is_openai_mcp()", () => {
  assert.strictEqual(L.clientInfoKnown(null), false);
  assert.strictEqual(L.clientInfoKnown({}), false);
  assert.strictEqual(L.clientInfoKnown({ name: "  " }), false);
  assert.strictEqual(L.clientInfoKnown({ name: "claude-code" }), true);
  assert.strictEqual(L.clientInfoKnown({ title: "x" }), true);
  const allow = [L.OPENAI_MCP_CLIENT_NAME];
  assert.strictEqual(L.clientInfoAllowed({ name: "openai-mcp" }, allow), true);
  assert.strictEqual(L.clientInfoAllowed({ name: "OpenAI-MCP" }, allow), true, "case-insensitive");
  assert.strictEqual(L.clientInfoAllowed({ name: "  openai-mcp  " }, allow), true, "trimmed");
  assert.strictEqual(L.clientInfoAllowed({ name: "openai-mcp/1.2.3" }, allow), true, "versioned prefix");
  assert.strictEqual(L.clientInfoAllowed({ title: "openai-mcp" }, allow), true, "title also checked");
  assert.strictEqual(L.clientInfoAllowed({ name: "openai-mcp-but-not-really" }, allow), false, "no slash: not a prefix match");
  assert.strictEqual(L.clientInfoAllowed({ name: "claude-code" }, allow), false);
  assert.strictEqual(L.clientInfoAllowed(null, allow), false);
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

test("hideUnsupportedTools over HTTP: two simultaneous sessions (Claude Code and ChatGPT) each get their own tools/list, no cross-talk", async () => {
  const fx = makeNotes();
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1" });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }), serverName: "basic-memory" });
  const TOOLS = [{ name: "read_note" }, { name: "search_notes" }, { name: "search" }, { name: "fetch" }];
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      const body = m.method === "tools/list"
        ? JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } })
        : JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "basic-memory", onReport: () => {}, levers: engine });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}/mcp`;
  const post = (sid, method, params, id = 1) => fetch(base, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.json());
  const names = (r) => r.result.tools.map((t) => t.name).sort();
  try {
    // Two different clients, two different Mcp-Session-Id values, initialized concurrently…
    await Promise.all([
      post("sess-claude", "initialize", { clientInfo: { name: "claude-code", version: "2.1.283" } }),
      post("sess-chatgpt", "initialize", { clientInfo: { name: "openai-mcp" } }),
    ]);
    // …then both ask for tools/list at the same time: no cross-session effect either way.
    const [listClaude, listChatgpt] = await Promise.all([post("sess-claude", "tools/list", {}), post("sess-chatgpt", "tools/list", {})]);
    assert.deepStrictEqual(names(listClaude), ["read_note", "search_notes"], "Claude Code session: search/fetch hidden");
    assert.deepStrictEqual(names(listChatgpt), ["fetch", "read_note", "search", "search_notes"], "ChatGPT session: untouched");
    // Repeat tools/list on the Claude Code session again: still filtered, unaffected by the other session.
    const again = await post("sess-claude", "tools/list", {});
    assert.deepStrictEqual(names(again), ["read_note", "search_notes"]);
  } finally {
    upstream.closeAllConnections(); upstream.close();
    proxy.closeAllConnections(); proxy.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
