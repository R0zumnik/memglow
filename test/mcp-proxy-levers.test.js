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
const LA = require("../lib/learned-aliases");

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

// Lever 14 (duplicateHint) — its own small fixture: a note with an id that differs from its label
// (exact-match "kebab slug" vs "label" has to be tested against two different strings), a French
// one (significantWords is EN+FR), an unrelated decoy, and a note inside the archive folder whose
// own words would otherwise match — on purpose, to prove the exclusion actually does something.
function makeDuplicateNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-dup-"));
  const notes = path.join(root, "notes");
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(notes, rel)), { recursive: true }); fs.writeFileSync(path.join(notes, rel), s); };
  w("projects/project-ha-climate.md", "---\ntitle: Heating and climate\ndescription: Thermostat schedules, zones and heating preferences for the house\ntheme: projects\nsubtheme: climate\n---\nHeating body SECRETBODY-climate.\n");
  w("projects/project-chauffage.md", "---\ntitle: Chauffage et climatisation\ndescription: Réglages du chauffage et de la climatisation pour la maison\ntheme: projects\nsubtheme: climate\n---\nChauffage body SECRETBODY-chauffage.\n");
  w("projects/grocery.md", "---\ntitle: Grocery list\ndescription: Weekly shopping\ntheme: projects\nsubtheme: home\n---\nGrocery body.\n");
  w("archive/old-heating.md", "---\ntitle: Old heating notes\ndescription: Archived heating climate notes from last winter\ntheme: projects\nsubtheme: climate\n---\nArchived body.\n");
  w("MEMORY.md", "---\ntitle: Index\ndescription: Heating and climate quick links, grocery shopping\n---\n# Index\n[[project-ha-climate]]\n");
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  fs.mkdirSync(home);
  return { root, notes, home, data, log: path.join(root, "args.log") };
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

test("defaults (0.4.2.2): only sizeWarning fires — searchDetails/suggestions are opt-in, once per note/session", async () => {
  const fx = makeNotes();
  // multiQuery (0.4.2.2b) is on by default but is a lever of its own — see the dedicated
  // multiQuery tests below; turned off here so this test stays about levers 1-8 only.
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0" });
  try {
    await c.rpc("initialize", {});
    const list = await c.rpc("tools/list", {});
    assert.ok(!JSON.stringify(list).includes("memglow_"), "levers 4/5 off: tools/list untouched");

    const a = await c.call("read_note", { identifier: "people/alice" });
    const ta = texts(a);
    assert.strictEqual(ta[0], rawNote(fx, "people/alice"), "upstream text first and byte-identical");
    assert.strictEqual(ta.length, 1, "suggestions is off by default since 0.4.2.2: no suffix");

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

test("suggestions (opt-in, MEMGLOW_PROXY_SUGGESTIONS=1): related-notes suffix, upstream content untouched, once per note per session", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_SUGGESTIONS: "1" });
  try {
    const a = await c.call("read_note", { identifier: "people/alice" });
    const ta = texts(a);
    assert.strictEqual(ta[0], rawNote(fx, "people/alice"), "upstream text first and byte-identical");
    assert.strictEqual(ta.length, 2);
    assert.match(ta[1], /^memglow: related notes: Bob `bob` \(≈\d+ tokens\)/);
    assert.match(ta[1], /Carol `carol`/, "same sub-theme");
    assert.ok(!ta[1].includes("SECRETBODY"), "never a body in suggestions");

    // Re-reading the SAME note again this session: suggestions already shown once, not repeated
    // (stage 0.4.2.2 shortening) — the upstream content is still delivered in full either way.
    const again = texts(await c.call("read_note", { identifier: "people/alice" }));
    assert.strictEqual(again.length, 1, "suggestions shown once per note per session");
    assert.strictEqual(again[0], rawNote(fx, "people/alice"));
    await c.rpc("initialize", {});
    assert.strictEqual(texts(await c.call("read_note", { identifier: "people/alice" })).length, 2, "a new session suggests again");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("searchDetails (opt-in, MEMGLOW_PROXY_SEARCH_DETAILS=1): compact metadata block appended, never bodies; a note already read in full this session gets no row at all", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_SEARCH_DETAILS: "1" });
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

    // Now read "alice" in full, then search again: she gets no teaser row at all (her real content
    // is already in context), the others keep theirs but without repeating the description.
    await c.call("read_note", { identifier: "alice" });
    const r2 = await c.call("search_notes", { query: "body" });
    const block2 = texts(r2)[1];
    assert.ok(!block2.includes("`alice`"), "alice already read in full this session: no row");
    assert.match(block2, /- Big plan `big` · Projects\/plans · ≈\d+ tokens \(large\)$/m, "big: no description, already shown once");
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
  const off = { MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_SEARCH_DETAILS: "false", MEMGLOW_PROXY_SUGGESTIONS: "off", MEMGLOW_PROXY_HIDE_UNSUPPORTED: "0", MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_RULES: "0" };
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
    // 0.4.3.1 rule 2: a `tools/list` first, like any real assistant session — otherwise this
    // read (the session's very first call) looks exactly like an injection hook's and is never
    // stubbed; see the dedicated rule-2 tests below for that case on its own.
    await c.rpc("tools/list", {});
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
    await c.rpc("tools/list", {}); // 0.4.3.1 rule 2: prior activity, so this read can still be stubbed
    const stub0 = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(stub0.length, 1, "unchanged: stubbed");
    assert.match(stub0[0], /already in your context/);

    fs.writeFileSync(path.join(fx.notes, "MEMORY.md"), "# Index\n[[alice]] [[big]] [[carol]]\n\nSomething NEW was added.\n");
    const changed = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(changed.length, 2);
    assert.strictEqual(changed[0], rawNote(fx, "MEMORY"), "full, current content — never a stub for a changed note");
    assert.match(changed[1], /^memglow: "MEMORY" was already in your context at the start of this session, but it has changed since the start of this session \(now sha [0-9a-f]{8}\) — shown in full\.$/);

    // Still "changed" on a further read of the same session: the baseline is not updated mid-session.
    const again = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(again.length, 2);
    assert.match(again[1], /has changed since the start of this session/);

    // A new session (re-`initialize`) captures a fresh baseline: the new content is "unchanged"
    // again (not literally re-stubbed here — growIndex's long body is gone, replaced above by a
    // few words shorter than the stub text itself, so lever 8's own "stub only if it is shorter"
    // guard declines either way — but it is no longer flagged "changed", which is what this part
    // of the test is really checking).
    await c.rpc("initialize", {});
    await c.rpc("tools/list", {}); // rule 2: prior activity, in case this content were long enough to stub
    assert.strictEqual(texts(await c.call("read_note", { identifier: "MEMORY" })).length, 1, "new session, new baseline: no longer flagged as changed");
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

test("alreadyLoaded 0.4.3.1 rule 1 (alreadyLoadedExemptClients): a session whose clientInfo matches the exempt list never gets the stub, even as its very FIRST call — this is the injection-hook shape", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", { clientInfo: { name: "session-start-hook", version: "1" } });
    // No tools/list, no other call first — read_note is this session's very first message, the
    // exact shape of a SessionStart hook injecting the index. Exempt by name (default list
    // includes "hook"): full text anyway, never a stub.
    const t = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.ok(t.some((x) => x.includes("Paragraph about")), "exempt client: full text even as the first call");
    assert.ok(!t.some((x) => x.includes("already in your context")));
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded 0.4.3.1 rule 2 (alreadyLoadedRequireActivity, default on): an unnamed client's very first call is never stubbed either, but a later read in the SAME session is", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", { clientInfo: { name: "claude-code", version: "2.1.283" } }); // not on the exempt list
    const first = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.ok(first.some((x) => x.includes("Paragraph about")), "first call of the session, no prior activity: never stubbed");
    assert.ok(!first.some((x) => x.includes("already in your context")));

    // Same note, read again — this time there WAS a prior tool call (the read above): stubbed.
    const second = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(second.length, 1);
    assert.match(second[0], /already in your context/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded 0.4.3.1 rule 2: a `tools/list` before the read counts as prior activity too", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  try {
    await c.rpc("initialize", {});
    await c.rpc("tools/list", {});
    const t = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(t.length, 1);
    assert.match(t[0], /already in your context/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded 0.4.3.1: MEMGLOW_PROXY_ALREADY_LOADED_REQUIRE_ACTIVITY=0 drops rule 2 — an unnamed client's first-ever call is stubbed again", async () => {
  const fx = makeNotes();
  growIndex(fx);
  const c = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_PROXY_ALREADY_LOADED_REQUIRE_ACTIVITY: "0" });
  try {
    await c.rpc("initialize", { clientInfo: { name: "claude-code", version: "1" } });
    const t = texts(await c.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(t.length, 1);
    assert.match(t[0], /already in your context/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("alreadyLoaded 0.4.3.1: MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT overrides the default exempt list (custom substring, case-insensitive; empty string disables it)", async () => {
  const fx = makeNotes();
  growIndex(fx);
  // A custom exempt list: "my-injector" only — the DEFAULT name "hook" no longer exempts anyone.
  const c1 = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT: "My-Injector" });
  try {
    await c1.rpc("initialize", { clientInfo: { name: "session-start-hook", version: "1" } });
    const t1 = texts(await c1.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(t1.length, 1, "rule 2 still blocks it (first call, no activity) even though rule 1 no longer names it");
    assert.ok(!t1.some((x) => x.includes("already in your context")));
  } finally { await c1.close(); }

  const c2 = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT: "My-Injector" });
  try {
    await c2.rpc("initialize", { clientInfo: { name: "my-injector-bot", version: "1" } }); // matches, case-insensitively
    const t2 = texts(await c2.call("read_note", { identifier: "MEMORY" }));
    assert.ok(t2.some((x) => x.includes("Paragraph about")), "custom exempt name matches: full text on the very first call");
  } finally { await c2.close(); }

  // Empty string: a deliberate empty exempt list — "hook" is no longer exempt from anything.
  const c3 = start(fx, { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT: "" });
  try {
    await c3.rpc("initialize", { clientInfo: { name: "session-start-hook", version: "1" } });
    await c3.rpc("tools/list", {}); // give it rule-2 activity so only rule 1 is under test here
    const t3 = texts(await c3.call("read_note", { identifier: "MEMORY" }));
    assert.strictEqual(t3.length, 1);
    assert.match(t3[0], /already in your context/, "empty exempt list: even a hook-named client is no longer exempt");
  } finally { await c3.close(); }
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test("alreadyLoaded 0.4.3.1 config parsing: alreadyLoadedExemptClients (array, substring match) and alreadyLoadedRequireActivity round-trip through proxyConfig()", () => {
  const def = L.proxyConfig({ MEMGLOW_HOME: os.tmpdir(), MEMGLOW_CONFIG: path.join(os.tmpdir(), "none.json") });
  assert.deepStrictEqual(def.alreadyLoadedExemptClients, ["hook", "inject", "session-start", "sessionstart", "memglow-init"]);
  assert.strictEqual(def.alreadyLoadedRequireActivity, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-cfg-"));
  const file = path.join(dir, "memglow.config.json");
  fs.writeFileSync(file, JSON.stringify({ proxy: { alreadyLoadedExemptClients: ["acme-bot"], alreadyLoadedRequireActivity: false } }));
  const c = L.proxyConfig({ MEMGLOW_HOME: dir, MEMGLOW_CONFIG: file });
  assert.deepStrictEqual(c.alreadyLoadedExemptClients, ["acme-bot"]);
  assert.strictEqual(c.alreadyLoadedRequireActivity, false);

  // Env overrides the file, and an explicit empty env string is a deliberate empty list (not "use the file's").
  const e = L.proxyConfig({ MEMGLOW_HOME: dir, MEMGLOW_CONFIG: file, MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT: "a, B ,c", MEMGLOW_PROXY_ALREADY_LOADED_REQUIRE_ACTIVITY: "1" });
  assert.deepStrictEqual(e.alreadyLoadedExemptClients, ["a", "B", "c"]);
  assert.strictEqual(e.alreadyLoadedRequireActivity, true);
  const e2 = L.proxyConfig({ MEMGLOW_HOME: dir, MEMGLOW_CONFIG: file, MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT: "" });
  assert.deepStrictEqual(e2.alreadyLoadedExemptClients, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clientInfoExempt: pure helper — substring match on name or title, case-insensitive, no false match on empty/missing clientInfo or empty list", () => {
  assert.strictEqual(L.clientInfoExempt({ name: "session-start-hook" }, ["hook"]), true);
  assert.strictEqual(L.clientInfoExempt({ title: "My Inject Tool" }, ["inject"]), true);
  assert.strictEqual(L.clientInfoExempt({ name: "CLAUDE-CODE" }, ["hook", "inject"]), false);
  assert.strictEqual(L.clientInfoExempt(null, ["hook"]), false);
  assert.strictEqual(L.clientInfoExempt({ name: "hook-ish" }, []), false);
  assert.strictEqual(L.clientInfoExempt({}, ["hook"]), false);
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
  const c = start(fx, { FAKE_WRAP: "1", MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_TOC: "1", MEMGLOW_PROXY_SUGGESTIONS: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1" });
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
    assert.deepStrictEqual([c.sizeWarning, c.searchDetails, c.suggestions, c.dedupe, c.toc], [true, false, false, true, false]);
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
    assert.strictEqual(L.anyLever({ ...e, sizeWarning: false, searchDetails: false, suggestions: false, dedupe: false, toc: false, multiQuery: false, aliases: false, learnAliases: false }), false);
    const def = L.proxyConfig({ MEMGLOW_HOME: path.join(fx.root, "nowhere") });
    assert.deepStrictEqual([def.sizeWarning, def.searchDetails, def.suggestions, def.dedupe, def.toc, def.alreadyLoaded], [true, false, false, false, false, false]);
    assert.strictEqual(def.duplicateHint, false, "duplicateHint off by default (0.4.4.1: a pure advisory add, same bucket as indexHint/searchDetails)");
    const dh = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
    assert.strictEqual(dh.duplicateHint, true);
    assert.strictEqual(L.anyLever({ duplicateHint: true }), true, "duplicateHint alone is enough to turn levers on");
    assert.strictEqual(def.multiQuery, true, "multiQuery on by default since 0.4.2.2b");
    assert.deepStrictEqual([def.aliases, def.learnAliases], [true, true], "aliases/learnAliases on by default since 0.4.2.5 (effective-tokens rule: fewer calls on the replay fixture)");
    assert.strictEqual(def.aliasesMax, 2000);
    assert.deepStrictEqual(def.alwaysLoaded, [], "no config file: nothing always-loaded beyond the index");
    assert.strictEqual(def.memoryDir, null);
    assert.strictEqual(L.anyLever({ alreadyLoaded: true }), true, "alreadyLoaded alone is enough to turn levers on");
    const al = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
    assert.deepStrictEqual([al.aliases, al.learnAliases], [true, true]);
    assert.strictEqual(L.anyLever({ aliases: true }), true, "aliases alone is enough to turn levers on");
    assert.strictEqual(L.anyLever({ learnAliases: true }), true, "learnAliases alone is enough to turn levers on");
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

// ---------------------------------------------------------------------------------------------
// Lever 9 (multiQuery, 0.4.2.2b) — pure pieces: planMultiQuery, mergeRankedIds, mergeSearchResults,
// runSearchCall. A minimal fake `index` (resolve/note only — everything these functions touch).

function fakeIndex(notes) {
  const byId = new Map(Object.entries(notes || {}));
  return {
    resolve(ref) {
      const s = String(ref || "");
      if (byId.has(s)) return s;
      const base = s.split("/").pop();
      return byId.has(base) ? base : null;
    },
    note(id) { return byId.get(id) || null; },
  };
}

test("planMultiQuery: caps at MULTI_QUERY_MAX total, drops blanks/too-long/duplicates, null when nothing to multiply", () => {
  assert.strictEqual(L.planMultiQuery({ query: "a" }), null, "no memglow_queries: nothing to multiply");
  assert.strictEqual(L.planMultiQuery({ query: "a", [L.ARG_QUERIES]: [] }), null, "empty array: nothing to multiply");
  assert.strictEqual(L.planMultiQuery({ [L.ARG_QUERIES]: ["b"] }), null, "no recognisable query argument at all");
  assert.strictEqual(L.planMultiQuery({ query: "a", [L.ARG_QUERIES]: ["a", "  ", 42, "a"] }), null, "every entry blank, wrong type, or a duplicate of the main query");

  const plan = L.planMultiQuery({ query: "a", [L.ARG_QUERIES]: ["b", "c", "d", "e", "f"] });
  assert.strictEqual(plan.queryKey, "query");
  assert.deepStrictEqual(plan.phrasings, ["a", "b", "c", "d"], `capped at MULTI_QUERY_MAX (${L.MULTI_QUERY_MAX}), extras dropped`);

  const tooLong = "x".repeat(L.MULTI_QUERY_LEN_MAX + 1);
  const p2 = L.planMultiQuery({ q: "a", [L.ARG_QUERIES]: [tooLong, "b"] });
  assert.deepStrictEqual(p2.phrasings, ["a", "b"], "over MULTI_QUERY_LEN_MAX: dropped, the valid one kept");
});

test("mergeRankedIds: dedup by key, a key found by MORE phrasings ranks first, tie-broken by best original rank then first phrasing, capped", () => {
  // "a": found by phrasing 0 (rank 1) and 1 (rank 0) -> count 2. "b": phrasing 0 only (rank 0) -> count 1.
  const order = L.mergeRankedIds([["b", "a"], ["a"]], 0);
  assert.deepStrictEqual(order, ["a", "b"], "a found by both phrasings ranks before b, found by only one");
  assert.deepStrictEqual(L.mergeRankedIds([["x", "y", "z"]], 2), ["x", "y"], "capped to 2");
  assert.deepStrictEqual(L.mergeRankedIds([[], []], 5), [], "nothing anywhere: empty, not an error");
  assert.deepStrictEqual(L.mergeRankedIds([["a", null, "a", "b"]], 0), ["a", "b"], "falsy/duplicate entries within one phrasing ignored");
});

test("mergeSearchResults: tier A — plain-text hits reassembled from the SERVER'S OWN blocks, deduped by note id, capped to the largest phrasing's own hit count", () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" }, bob: { id: "bob", label: "Bob" }, carol: { id: "carol", label: "Carol" } });
  const r0 = { content: [{ type: "text", text: "### alice\npermalink: alice\nsnippet: s1\n\n### bob\npermalink: bob\nsnippet: s2" }] }; // 2 hits
  const r1 = { content: [{ type: "text", text: "### bob\npermalink: bob\nsnippet: s2\n\n### carol\npermalink: carol\nsnippet: s3" }] }; // 2 hits, bob again
  const merged = L.mergeSearchResults(idx, [r0, r1]);
  assert.strictEqual(merged.content.length, 1);
  const text = merged.content[0].text;
  assert.match(text, /### bob[\s\S]*permalink: bob/, "bob (found by both phrasings) kept, verbatim server text");
  assert.match(text, /### alice/, "alice: found in phrasing 0 at rank 0 — the better tie-break");
  // bob was found by BOTH phrasings: ranks before alice (found by only one, rank 0 there).
  assert.ok(text.indexOf("### bob") < text.indexOf("### alice"));
  // cap = max(2, 2) = 2: alice (rank 0 in its phrasing) edges out carol (rank 1 in its phrasing).
  assert.strictEqual((text.match(/^### /gm) || []).length, 2);
  assert.ok(!text.includes("### carol"));
});

test("mergeSearchResults: tier A keeps the FastMCP text wrap in step with the merged text", () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" } });
  const text = "### alice\npermalink: alice\nsnippet: s1";
  const r0 = { content: [{ type: "text", text }], structuredContent: { result: text } };
  const merged = L.mergeSearchResults(idx, [r0, r0]);
  assert.strictEqual(merged.structuredContent.result, merged.content[0].text);
});

test("mergeSearchResults: tier B — a compact listing when the format cannot be merged safely (non-text content, or real structuredContent)", () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice", theme: "people" } });
  const safe = { content: [{ type: "text", text: "permalink: alice" }] };
  const unsafe = { content: [{ type: "text", text: "permalink: alice" }], structuredContent: { results: [{ id: "alice" }] } }; // real structured data, not the text wrap
  const merged = L.mergeSearchResults(idx, [safe, unsafe]);
  assert.strictEqual(merged.content.length, 1);
  assert.match(merged.content[0].text, /^memglow: merged results across 2 phrasings:\n- Alice `alice`$/);
  assert.ok(!("structuredContent" in merged), "tier B never invents a structuredContent");
});

test("mergeSearchResults: fail open (null) — every phrasing found nothing, or (tier B) no id resolves in unsafe content", () => {
  const idx = fakeIndex({});
  assert.strictEqual(L.mergeSearchResults(idx, [{ content: [{ type: "text", text: "No results" }] }, { content: [{ type: "text", text: "No results" }] }]), null, "every phrasing empty");
  // Plain, all-text, identical blocks still merge (tier A dedups by the block's own text even
  // with no id) — fail open is for when tier A is skipped (non-text / real structuredContent)
  // AND tier B's id-sniffing comes up empty too.
  const unsafe = { content: [{ type: "text", text: "some text with no id or permalink in it" }], structuredContent: { results: [] } };
  assert.strictEqual(L.mergeSearchResults(idx, [unsafe, unsafe]), null, "unsafe format AND nothing resolves to a note id: fail open");
});

test("mergeSearchResults 0.4.5.1: a page's frame (\"# Search Results\" header, \"---\" footer) is not a hit — the first phrasing's frame wraps the merged hits", () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" }, bob: { id: "bob", label: "Bob" } });
  const page = (q, id) => ({ content: [{ type: "text", text: `# Search Results: ${q}\n*project: main*\n\n### ${id}\n- permalink: main/memory/${id}\n- score: 1.0000\n\n---\n*1 result | page 1, page_size 1*` }] });
  // Before 0.4.5.1 the identical footers (found by both phrasings) ranked first and, with one hit
  // per page, the cap (3 blocks) kept footer + two headers and no hit at all.
  const merged = L.mergeSearchResults(idx, [page("a", "alice"), page("b", "bob")]).content[0].text;
  assert.strictEqual(merged, "# Search Results: a\n*project: main*\n\n### alice\n- permalink: main/memory/alice\n- score: 1.0000\n\n---\n*1 result | page 1, page_size 1*");
  const two = (q, ids) => ({ content: [{ type: "text", text: `# Search Results: ${q}\n\n` + ids.map((i) => `### ${i}\n- permalink: ${i}`).join("\n\n") + "\n\n---\n*2 results*" }] });
  const m2 = L.mergeSearchResults(idx, [two("a", ["alice", "x1"]), two("b", ["bob", "alice"])]).content[0].text;
  assert.ok(m2.startsWith("# Search Results: a\n\n### alice"), "alice (both phrasings) first, after the header");
  assert.ok(m2.endsWith("\n\n---\n*2 results*"));
  assert.strictEqual((m2.match(/^### /gm) || []).length, 2, "capped to the hit count, frames not counted");
});

test("mergeSearchResults 0.4.5.1b: a basic-memory hit whose `- match:` spans blank lines stays ONE hit (heading to next heading)", () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" }, bob: { id: "bob", label: "Bob" }, carol: { id: "carol", label: "Carol" } });
  // Synthetic text shaped like basic-memory 4.x output: the match excerpt carries blank lines,
  // a bare permalink line and a "---" rule of its own.
  const aliceHit = "### alice\n- permalink: main/memory/alice\n- score: 0.9\n- match: alice\n\nmain/memory/alice\n\nUp: [[hub]]\n---\n- **Point**: alice continues here";
  const r0 = { content: [{ type: "text", text: `# Search Results: q1\n*project: main*\n\n${aliceHit}\n\n### bob\n- permalink: main/memory/bob\n- score: 0.8\n- match: bob line\n\n---\n*2 results | page 1, page_size 2*` }] };
  const r1 = { content: [{ type: "text", text: "# Search Results: q2\n*project: main*\n\n### carol\n- permalink: main/memory/carol\n- score: 0.7\n- match: carol\n\nmain/memory/carol\n\n### alice\n- permalink: main/memory/alice\n- score: 0.6\n- match: other\n\n---\n*2 results | page 1, page_size 2*" }] };
  assert.deepStrictEqual(L.hitChunksOf(r0.content[0].text), ["# Search Results: q1\n*project: main*", aliceHit, "### bob\n- permalink: main/memory/bob\n- score: 0.8\n- match: bob line", "---\n*2 results | page 1, page_size 2*"]);
  const merged = L.mergeSearchResults(idx, [r0, r1]).content[0].text;
  assert.ok(merged.includes(aliceHit), "alice's hit kept whole, continuation included");
  assert.strictEqual(merged.split("main/memory/alice\n\nUp: [[hub]]").length, 2, "its continuation appears once, attached to its own heading");
  assert.ok(merged.startsWith("# Search Results: q1\n*project: main*\n\n### alice"), "alice (both phrasings) first");
  assert.ok(merged.endsWith("\n\n---\n*2 results | page 1, page_size 2*"));
  assert.strictEqual((merged.match(/^### /gm) || []).length, 2, "cap = 2 hits");
  // Text without "### " blocks is split exactly as before.
  assert.deepStrictEqual(L.hitChunksOf("a\n\nb"), ["a", "b"]);
});

test("sizeWarning 0.4.5.1b: computed from the file as it is after the write — never a stale size", () => {
  const fx = makeNotes();
  try {
    const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_CONFIG: path.join(fx.home, "none.json"), MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "1000", MEMGLOW_POLL_MS: "60000", MEMGLOW_PROXY_MULTI_QUERY: "0" });
    const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: { add() {}, addClient() {} } });
    const file = path.join(fx.notes, "projects/big.md");
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(file, old, old); // the index knows big.md as large, from before this session
    const write = (id, sid, before) => {
      engine.clientMessage({ id, method: "tools/call", params: { name: "write_note", arguments: { title: "Big plan", directory: "projects", content: "x" } } }, sid);
      if (before) before();
      const r = engine.serverMessage({ id, result: { content: [{ type: "text", text: "# Updated note\npermalink: projects/big" }] } }, sid);
      return r.changed ? r.msg.result.content.map((c) => c.text) : ["# Updated note\npermalink: projects/big"];
    };
    // 1. The upstream has not rewritten the file yet (mtime from an hour ago): no stale warning.
    assert.deepStrictEqual(write(1, "s1"), ["# Updated note\npermalink: projects/big"]);
    // 2. Rewritten SMALL (a hub split down): no warning, although the index had it large.
    assert.deepStrictEqual(write(2, "s2", () => fs.writeFileSync(file, "---\ntitle: Big plan\n---\nnow tiny\n")), ["# Updated note\npermalink: projects/big"]);
    // 3. Rewritten large: the warning gives the NEW size, read off the file.
    const body = "y".repeat(20000);
    const w = write(3, "s3", () => fs.writeFileSync(file, "---\ntitle: Big plan\n---\n" + body));
    const tokens = Math.ceil(fs.statSync(file).size / 4);
    assert.match(w[0], new RegExp(`^⚠ memglow: this note is now ≈${tokens} tokens \\(threshold 1000\\)`));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("mergeSearchResults: tier A dedups identical un-identifiable text too (no note id needed to collapse a repeat)", () => {
  const idx = fakeIndex({});
  const r = { content: [{ type: "text", text: "some text with no id or permalink in it" }] };
  const merged = L.mergeSearchResults(idx, [r, r]);
  assert.strictEqual(merged.content[0].text, "some text with no id or permalink in it");
});

test("runSearchCall: sequential, one call per phrasing, the original query first; multiQuery off or no plan -> exactly one call", async () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" } });
  const sent = [];
  const sendUpstream = async (args) => { sent.push(args); return { result: { content: [{ type: "text", text: "permalink: alice" }] } }; };

  const off = await L.runSearchCall({ multiQuery: false }, idx, { query: "a", [L.ARG_QUERIES]: ["b"] }, sendUpstream);
  assert.strictEqual(off.calls, 1);
  assert.ok(!(L.ARG_QUERIES in sent[0]), "memglow_queries stripped even when multiQuery is off");
  assert.strictEqual(sent[0].query, "a");

  sent.length = 0;
  const r = await L.runSearchCall({ multiQuery: true }, idx, { query: "a", [L.ARG_QUERIES]: ["b", "c"] }, sendUpstream);
  assert.strictEqual(r.calls, 3);
  assert.deepStrictEqual(sent.map((a) => a.query), ["a", "b", "c"], "sequential, original query first");
  for (const a of sent) assert.ok(!(L.ARG_QUERIES in a));
});

test("runSearchCall: fail open — a LATER phrasing's error relays the FIRST phrasing's own result unchanged, never a partial merge", async () => {
  const idx = fakeIndex({ alice: { id: "alice", label: "Alice" } });
  const firstResult = { content: [{ type: "text", text: "permalink: alice" }] };
  let n = 0;
  const sendUpstream = async () => { n++; return n === 1 ? { result: firstResult } : { error: { code: -32000, message: "boom" } }; };
  const r = await L.runSearchCall({ multiQuery: true }, idx, { query: "a", [L.ARG_QUERIES]: ["b", "c"] }, sendUpstream);
  assert.strictEqual(r.calls, 2, "stopped at the failing phrasing, never tried the third");
  assert.deepStrictEqual(r.message, { result: firstResult });
});

test("runSearchCall: the FIRST phrasing's own error relays as is — exactly what a plain single search would have returned", async () => {
  const idx = fakeIndex({});
  const sendUpstream = async () => ({ error: { code: -32001, message: "upstream exploded" } });
  const r = await L.runSearchCall({ multiQuery: true }, idx, { query: "a", [L.ARG_QUERIES]: ["b"] }, sendUpstream);
  assert.strictEqual(r.calls, 1);
  assert.deepStrictEqual(r.message, { error: { code: -32001, message: "upstream exploded" } });
});

test("runSearchCall: a rejected sendUpstream (thrown/rejected promise) never throws — relayed as an upstream error", async () => {
  const idx = fakeIndex({});
  const r = await L.runSearchCall({ multiQuery: false }, idx, { query: "a" }, async () => { throw new Error("network down"); });
  assert.strictEqual(r.calls, 1);
  assert.match(r.message.error.message, /network down/);
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
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "1000", MEMGLOW_PROXY_SUGGESTIONS: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1" });
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
  const call = (id, name, args, session = "s9") => fetch(base, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  try {
    const r1 = await call(1, "read_note", { identifier: "alice" });
    const body = await r1.text();
    assert.strictEqual(Number(r1.headers.get("content-length")), Buffer.byteLength(body));
    const j = JSON.parse(body);
    assert.strictEqual(j.result.content[0].text, "permalink: people/alice\nhello");
    assert.match(j.result.content[1].text, /^memglow: related notes: Bob `bob`/);
    // A fresh session ("s10"): searchDetails still reports "alice" in full — it was only skipped
    // for a session that had already read it in full (see the "already read: no teaser row" test).
    const r2 = await call("sse", "search_notes", { query: "x" }, "s10");
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

// ---------------------------------------------------------------------------------------------
// Lever 9 (multiQuery, 0.4.2.2b) — end to end, stdio and HTTP.

test("multiQuery over stdio: tools/list advertises memglow_queries on search tools only; one upstream call per phrasing, merged into one reply; stripped and inert when off", async () => {
  const fx = makeNotes();
  const on = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "1" });
  try {
    await on.rpc("initialize", {});
    const list = await on.rpc("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of names) {
      const hasArg = "memglow_queries" in (list.result.tools.find((t) => t.name === n).inputSchema.properties || {});
      assert.strictEqual(hasArg, ["search_notes", "search"].includes(n), `${n}: memglow_queries only on search tools`);
    }
    // "secretbody" alone already matches alice/bob/carol/big (cap = 4, the biggest single
    // phrasing's own hit count); the other two phrasings narrow to alice/bob specifically, so
    // those two are found by MORE phrasings and rank first — merge, dedup AND rank, visibly.
    const r = await on.call("search_notes", { query: "secretbody", memglow_queries: ["alice", "bob"] });
    assert.strictEqual(r.result.content.length, 1, "ONE merged result for the client's ONE call");
    const text = r.result.content[0].text;
    assert.match(text, /alice/); assert.match(text, /bob/); assert.match(text, /carol/); assert.match(text, /\bbig\b/);
    assert.ok(text.indexOf("alice") < text.indexOf("carol"), "alice (found by 2 phrasings) ranks before carol (found by 1)");
    const log = fs.readFileSync(fx.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepStrictEqual(log.map((l) => l.args.query), ["secretbody", "alice", "bob"], "one upstream call per phrasing, sequential, original first");
    for (const l of log) assert.ok(!("memglow_queries" in l.args), "memglow_queries never reaches the upstream server");
  } finally { await on.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }

  const fx2 = makeNotes();
  const off = start(fx2, { MEMGLOW_PROXY_MULTI_QUERY: "0" });
  try {
    await off.rpc("initialize", {});
    const list = await off.rpc("tools/list", {});
    assert.ok(!JSON.stringify(list).includes("memglow_queries"), "off: never advertised");
    const r = await off.call("search_notes", { query: "SECRETBODY-alice", memglow_queries: ["SECRETBODY-bob"] });
    assert.strictEqual(texts(r).length, 1);
    const log = fs.readFileSync(fx2.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.strictEqual(log.length, 1, "off: exactly one upstream call, memglow_queries ignored");
    assert.ok(!("memglow_queries" in log[0].args), "off: still stripped before reaching the server");
  } finally { await off.close(); fs.rmSync(fx2.root, { recursive: true, force: true }); }
});

test("multiQuery over stdio: a plain search (no memglow_queries) is unaffected by the lever being on — still exactly one call", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "1" });
  try {
    const plain = await c.call("search_notes", { query: "SECRETBODY-alice" });
    assert.strictEqual(texts(plain).length, 1);
    const log = fs.readFileSync(fx.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.strictEqual(log.length, 1, "a plain search (no memglow_queries) is still exactly one call");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("multiQuery over HTTP: one merged response, upstream received one POST per phrasing, Content-Length correct", async () => {
  const fx = makeNotes();
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "1000", MEMGLOW_PROXY_MULTI_QUERY: "1" });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }) });
  const received = [];
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      received.push(m.params.arguments.query);
      const q = String(m.params.arguments.query || "").toLowerCase();
      const hits = q.includes("alice") ? "### alice\npermalink: people/alice\nsnippet: s" : q.includes("bob") ? "### bob\npermalink: people/bob\nsnippet: s" : "No results";
      const body = JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: hits }] } });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "notes", onReport: () => {}, levers: engine });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}/mcp`;
  try {
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "alice", memglow_queries: ["bob"] } } }) });
    const bodyText = await res.text();
    assert.strictEqual(Number(res.headers.get("content-length")), Buffer.byteLength(bodyText));
    const j = JSON.parse(bodyText);
    assert.strictEqual(j.id, 1);
    // Each phrasing's own fake upstream call returns exactly ONE hit here, so cap = 1: only the
    // best-ranked entry (alice, the original/first phrasing) survives — the merge/dedup/rank/cap
    // logic itself is unit-tested on its own above; this test is about the HTTP wiring.
    assert.match(j.result.content[0].text, /alice/);
    assert.deepStrictEqual(received, ["alice", "bob"], "one upstream POST per phrasing, sequential");
  } finally {
    upstream.closeAllConnections(); upstream.close();
    proxy.closeAllConnections(); proxy.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// Regression (2026-10-08): against a MCP 2026-07-28 server (basic-memory on MCP SDK 2.0), every
// multiQuery sub-call failed with "params._meta must be an object carrying the required ..." —
// the sub-calls were rebuilt as `{ name, arguments }` and lost the client's per-request envelope.
// The fake upstream below applies the same rules as the real server's modern path: `_meta`
// envelope required, MCP-Protocol-Version / Mcp-Method / Mcp-Name headers must match the body,
// answers as an SSE stream with keep-alive pings.
test("multiQuery over HTTP, MCP 2026-07-28 server: each sub-call carries the client's _meta envelope and headers; SSE answers merged; memglow_queries never sent upstream", async () => {
  const fx = makeNotes();
  const cfg = L.proxyConfig({ MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "1000", MEMGLOW_PROXY_MULTI_QUERY: "1" });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }) });
  const PV = "io.modelcontextprotocol/protocolVersion", CC = "io.modelcontextprotocol/clientCapabilities";
  const received = [];
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      received.push(m);
      const meta = m.params && m.params._meta;
      const reject = (message) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message } });
        res.writeHead(400, { "content-type": "application/json" }); res.end(body);
      };
      if (!meta || typeof meta !== "object" || !(PV in meta) || !(CC in meta)) return reject(`params._meta must be an object carrying the required '${PV}' and '${CC}' envelope keys`);
      if (req.headers["mcp-protocol-version"] !== meta[PV] || req.headers["mcp-method"] !== m.method || req.headers["mcp-name"] !== m.params.name) return reject("header mismatch");
      // Two hits per phrasing (merge cap = 2): alice is found by both, bob ONLY by the second
      // phrasing and outranks carol (rank 1 vs 2) — bob in the reply proves the sub-call worked.
      const row = (n) => `### ${n}\npermalink: people/${n}\nsnippet: s`;
      const q = String(m.params.arguments.query || "").toLowerCase();
      const hits = q.includes("alice") ? [row("alice"), row("carol")].join("\n\n") : q.includes("bob") ? [row("bob"), row("alice")].join("\n\n") : "No results";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ping\n\n");
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: hits }] } })}\n\n`);
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "basic-memory", onReport: () => {}, levers: engine });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}/mcp`;
  const meta = { [PV]: "2026-07-28", [CC]: { sampling: {} }, "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "1" }, progressToken: 7 };
  try {
    const res = await fetch(base, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "search_notes" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "memglow alice", memglow_queries: ["bob"], page_size: 5 }, _meta: meta } }) });
    const j = JSON.parse(await res.text());
    assert.strictEqual(j.id, 1);
    assert.ok(!j.error, "no error: " + JSON.stringify(j.error));
    assert.match(j.result.content[0].text, /alice/);
    assert.match(j.result.content[0].text, /bob/, "the second phrasing's hit is merged in");
    assert.deepStrictEqual(received.map((m) => m.params.arguments.query), ["memglow alice", "bob"], "one upstream call per phrasing");
    for (const m of received) {
      assert.ok(!("memglow_queries" in m.params.arguments), "memglow_queries never reaches the upstream server");
      assert.strictEqual(m.params.arguments.page_size, 5, "the other arguments are kept");
      assert.deepStrictEqual(m.params._meta, { [PV]: "2026-07-28", [CC]: { sampling: {} }, "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "1" } }, "envelope copied, the client's progressToken dropped");
    }
  } finally {
    upstream.closeAllConnections(); upstream.close();
    proxy.closeAllConnections(); proxy.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("multiQuery over stdio: each sub-call written upstream carries the client's _meta envelope", async () => {
  const { createSubCallSender, subCallParams } = require("../mcp-proxy/memglow-mcp-proxy");
  const written = [];
  const sub = createSubCallSender((b) => written.push(JSON.parse(b.toString("utf8"))));
  const reqParams = { name: "search_notes", arguments: { query: "a", memglow_queries: ["b"] }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
  const p = sub.send(subCallParams(reqParams, { query: "b" }));
  assert.strictEqual(written.length, 1);
  assert.deepStrictEqual(written[0].params, { name: "search_notes", arguments: { query: "b" }, _meta: reqParams._meta });
  assert.ok(sub.intercept({ jsonrpc: "2.0", id: written[0].id, result: { content: [] } }));
  assert.deepStrictEqual(await p, { result: { content: [] } });
  assert.deepStrictEqual(subCallParams({ name: "x", arguments: {} }, { q: 1 }), { name: "x", arguments: { q: 1 } }, "no _meta in, none invented");
});

// ---------------------------------------------------------------------------------------------
// Lever 10 (aliases, 0.4.2.3 + 0.4.2.4) — end to end. Pure pieces (significantWords, learnEntries,
// matchAlias, forgetMissing, createAliasStore) are unit-tested on their own in
// test/learned-aliases.test.js; this section is about the WIRING into createLevers/the real proxy.

test("aliases: on by default since 0.4.2.5 — the same miss -> read -> similar-search scenario now learns and injects with NO env override", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0" });
  try {
    assert.strictEqual(texts(await c.call("search_notes", { query: "roster assignment sheet" }))[0], "No results");
    await c.call("read_note", { identifier: "carol" });
    const r = texts(await c.call("search_notes", { query: "roster assignment update" }));
    assert.strictEqual(r.length, 2, "aliases AND learnAliases on by default (0.4.2.5): carol is injected, no env override needed");
    assert.match(r[0], /^- Carol `carol`$/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases: explicitly off (MEMGLOW_PROXY_ALIASES=0, MEMGLOW_PROXY_LEARN_ALIASES=0) — a search that misses, then a read of that note, then a similar later search: nothing is ever learned or injected", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0" });
  try {
    assert.strictEqual(texts(await c.call("search_notes", { query: "roster assignment sheet" }))[0], "No results");
    await c.call("read_note", { identifier: "carol" });
    const r = texts(await c.call("search_notes", { query: "roster assignment update" }));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0], "No results", "both switches explicitly off: nothing changes");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases (opt-in): a search that misses a note, then a single-note read of it, teaches the search's significant words; a later search sharing >= 2 of them gets that note injected at the TOP, in the upstream's own per-hit row format", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
  try {
    // 1 — a search for carol that finds nothing upstream (none of these words are in carol.md).
    assert.strictEqual(texts(await c.call("search_notes", { query: "roster assignment sheet" }))[0], "No results");
    // 2 — reading carol right after: carol was NOT among that search's own results, so its words
    // ("roster", "assignment", "sheet") are learned as aliases of carol.
    await c.call("read_note", { identifier: "carol" });
    // 3 — a later, similarly-worded search (2 of the 3 words overlap: "roster", "assignment")
    // still finds nothing upstream, but now gets carol injected FIRST — a plain-text "No results"
    // answer is safe to add a hit row to, so the upstream's own row shape is reused (hitRow),
    // never the compact fallback sentence.
    const r = texts(await c.call("search_notes", { query: "roster assignment update" }));
    assert.strictEqual(r.length, 2);
    assert.match(r[0], /^- Carol `carol`$/);
    assert.strictEqual(r[1], "No results", "the upstream's own answer is still relayed, unchanged, right after");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases (opt-in): only 1 shared word, learned once — below the threshold, nothing is injected", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
  try {
    assert.strictEqual(texts(await c.call("search_notes", { query: "roster assignment sheet" }))[0], "No results");
    await c.call("read_note", { identifier: "carol" });
    // Only "roster" overlaps (seen once so far) — 1 alias seen once is not enough.
    const r = texts(await c.call("search_notes", { query: "roster timetable update" }));
    assert.deepStrictEqual(r, ["No results"]);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases (opt-in): a note already among this search's own results is never duplicated", () => {
  // Driven directly through createLevers (not the spawned fixture): the toy upstream fixture
  // matches a search query as ONE literal substring, so there is no way to phrase a query that
  // is BOTH built from the learned alias words (which, by construction, never appeared in the
  // note — that is why the original search missed) AND a real upstream hit for the same note.
  // Crafting the upstream's own answer by hand here (step 3) sidesteps that fixture limitation
  // while still exercising the real engine end to end.
  const fx = makeNotes();
  try {
    const cfg = L.proxyConfig({
      MEMGLOW_HOME: fx.home, MEMGLOW_MEMORY_DIR: fx.notes, MEMGLOW_DATA_DIR: fx.data, MEMGLOW_LARGE_NOTE_TOKENS: "100000",
      MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1", MEMGLOW_PROXY_MULTI_QUERY: "0",
    });
    const index = L.createNoteIndex(cfg);
    const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
    const aliasStore = LA.createAliasStore(cfg);
    const engine = L.createLevers({ config: cfg, index, savings, aliasStore, serverName: "basic-memory" });
    const sid = "s1";
    // 1 — a search for carol that misses.
    engine.clientMessage({ id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "roster assignment sheet" } } }, sid);
    engine.serverMessage({ id: 1, result: { content: [{ type: "text", text: "No results" }] } }, sid);
    // 2 — reading carol right after teaches "roster"/"assignment"/"sheet" as its aliases.
    engine.clientMessage({ id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "carol" } } }, sid);
    engine.serverMessage({ id: 2, result: { content: [{ type: "text", text: rawNote(fx, "people/carol") }] } }, sid);
    // 3 — a later search that BOTH matches those aliases AND already found carol upstream for
    // real: carol must not be duplicated.
    engine.clientMessage({ id: 3, method: "tools/call", params: { name: "search_notes", arguments: { query: "roster assignment update" } } }, sid);
    const upstreamText = "### carol\npermalink: people/carol\nsnippet: s";
    const r3 = engine.serverMessage({ id: 3, result: { content: [{ type: "text", text: upstreamText }] } }, sid);
    assert.strictEqual(r3.changed, false, "nothing added: carol was already in the upstream's own answer");
    assert.strictEqual(r3.msg.result.content.length, 1, "still exactly the upstream's one content block");
    assert.strictEqual(r3.msg.result.content[0].text, upstreamText);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases (opt-in): `learnAliases` and `aliases` are independent — learning alone injects nothing, injection alone has nothing to learn from", async () => {
  const fx = makeNotes();
  // learnAliases only: records aliases, never surfaces them. Both default to true since
  // 0.4.2.5, so `aliases` must be explicitly forced off here to isolate "learning only".
  const c1 = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_LEARN_ALIASES: "1", MEMGLOW_PROXY_ALIASES: "0" });
  try {
    await c1.call("search_notes", { query: "roster assignment sheet" });
    await c1.call("read_note", { identifier: "carol" });
    const r1 = texts(await c1.call("search_notes", { query: "roster assignment update" }));
    assert.deepStrictEqual(r1, ["No results"], "aliases off: nothing injected even though it was learned");
  } finally { await c1.close(); }
  // aliases only, same data folder: whatever was just learned above is now USED. `learnAliases`
  // forced off here, same reason as above, to isolate "injection only" from the default.
  const c2 = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "0" });
  try {
    const r2 = texts(await c2.call("search_notes", { query: "roster assignment update" }));
    assert.strictEqual(r2.length, 2, "learnAliases off here, but aliases on surfaces what c1 already learned");
    assert.match(r2[0], /`carol`/);
  } finally { await c2.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases: a lever failure (a broken index/store) never breaks the relay", () => {
  const cfg = L.proxyConfig({ MEMGLOW_HOME: path.join(os.tmpdir(), "memglow-alias-broken-" + process.pid), MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
  const broken = L.createLevers({
    config: cfg, index: { resolve() { throw new Error("x"); }, note() { throw new Error("x"); } }, savings: { add() {}, addClient() {} },
    aliasStore: { available: () => true, learn() { throw new Error("x"); }, match() { throw new Error("x"); }, forgetMissing() { throw new Error("x"); } },
  });
  broken.clientMessage({ id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "x" } } });
  const m = { id: 1, result: { content: [{ type: "text", text: "No results" }] } };
  assert.deepStrictEqual(broken.serverMessage(m), { msg: m, changed: false });
});

// ---------------------------------------------------------------------------------------------
// 0.4.2.5 — aliases must learn from, and inject into, a multiQuery (lever 9, `memglow_queries`)
// search too: before this stage, that path bypassed handleSearch (and so lever 10) entirely.

test("aliases + multiQuery: a missed multi-phrasing search teaches EVERY phrasing's words, not just the main query", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "1", MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
  try {
    // 1 — a multi-phrasing search (3 phrasings total — "roster", "assignment", "sheet") misses
    // carol entirely upstream: each phrasing's own call returns "No results", so the merge tier
    // fails open to responses[0].
    const miss = texts(await c.call("search_notes", { query: "roster", memglow_queries: ["assignment", "sheet"] }));
    assert.deepStrictEqual(miss, ["No results"]);
    // 2 — reading carol right after: without this stage's fix, s.lastSearch would still be null
    // (handleSearch never ran for a multiQuery call), so nothing would be learned at all.
    await c.call("read_note", { identifier: "carol" });
    // 3 — a later, single-phrasing search sharing "roster" + "assignment" (2 of the learned
    // words) gets carol injected first — proving the UNION of all 3 phrasings' words was learned,
    // not only "roster" (the main query), which alone would be just 1 shared word.
    const r = texts(await c.call("search_notes", { query: "roster assignment update" }));
    assert.strictEqual(r.length, 2);
    assert.match(r[0], /^- Carol `carol`$/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("aliases + multiQuery: a learned candidate is injected into the multiQuery search's own MERGED result", async () => {
  const fx = makeNotes();
  const c = start(fx, { MEMGLOW_PROXY_MULTI_QUERY: "1", MEMGLOW_PROXY_ALIASES: "1", MEMGLOW_PROXY_LEARN_ALIASES: "1" });
  try {
    // Teach carol's aliases via a plain, single-phrasing search + read (same recipe as the
    // non-multiQuery alias test above) — multiQuery is on throughout but has nothing to multiply
    // here (no memglow_queries), so this step is unaffected by it.
    await c.call("search_notes", { query: "roster assignment sheet" });
    await c.call("read_note", { identifier: "carol" });
    // A LATER search that itself carries memglow_queries: without this stage's fix, the merged
    // result would never pass through handleSearch, so carol would never be injected.
    const r = texts(await c.call("search_notes", { query: "roster assignment update", memglow_queries: ["timetable change"] }));
    assert.strictEqual(r.length, 2, "candidate injected into the MERGED multiQuery result, not just a plain search");
    assert.match(r[0], /^- Carol `carol`$/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("applyAliasesToSearch: pure helper — learns from all phrasings, injects once, never duplicates an already-present note, no-op when both switches are off", () => {
  const cfg = { aliases: true, learnAliases: true, searchDetailsMax: 20 };
  const index = {
    resolve(r) { return r === "carol" ? "carol" : null; },
    note(id) { return id === "carol" ? { id: "carol", label: "Carol" } : null; },
  };
  let learned = null;
  const aliases = {
    available: () => true,
    learn(note, words) { learned = { note, words }; },
    match(words, exclude) { return !exclude.has("carol") && words.includes("roster") && words.includes("assignment") ? "carol" : null; },
    forgetMissing() {},
  };
  const s = { lastSearch: null };
  const result = { content: [{ type: "text", text: "No results" }] };

  const out = L.applyAliasesToSearch(cfg, index, aliases, s, ["roster", "assignment update"], result);
  assert.deepStrictEqual(s.lastSearch.words, ["roster", "assignment", "update"], "union of significant words from BOTH phrasings, order preserved");
  assert.strictEqual(out.content.length, 2);
  assert.match(out.content[0].text, /^- Carol `carol`$/);
  assert.strictEqual(out.content[1], result.content[0]);

  // Already present (resolved from the result's own text) — never duplicated.
  const already = { content: [{ type: "text", text: "permalink: carol\nsome hit" }] };
  const out2 = L.applyAliasesToSearch(cfg, index, aliases, { lastSearch: null }, ["roster", "assignment"], already);
  assert.strictEqual(out2, already, "candidate already in the merged result: untouched (same reference)");

  // Both switches off: untouched, nothing learned.
  const s3 = { lastSearch: null };
  const out3 = L.applyAliasesToSearch({ aliases: false, learnAliases: false, searchDetailsMax: 20 }, index, aliases, s3, ["roster"], result);
  assert.strictEqual(out3, result);
  assert.strictEqual(s3.lastSearch, null);
});

// ---------------------------------------------------------------------------------------------
// Lever 14 (duplicateHint, 0.4.4.1) — pure pieces first (duplicateHintCandidates,
// duplicateHintBlock, duplicateHintFor), then end to end through the stdio proxy.

test("duplicateHintCandidates: pure matcher — shares >= 2 significant words AND >= 60% coverage; EN and FR; a generic/unrelated title never matches; ranked by shared count then size; capped at 2", () => {
  const notes = [
    { id: "project-ha-climate", label: "Heating and climate", description: "Thermostat schedules, zones and heating preferences for the house", tokens: 50 },
    { id: "project-chauffage", label: "Chauffage et climatisation", description: "Réglages du chauffage et de la climatisation pour la maison", tokens: 40 },
    { id: "grocery", label: "Grocery list", description: "Weekly shopping", tokens: 10 },
  ];
  const sw = LA.significantWords;
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Heating and climate settings"), notes), ["project-ha-climate"], "EN near-duplicate: 2 of 3 words shared (66%)");
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Réglages chauffage climatisation"), notes), ["project-chauffage"], "FR near-duplicate: all 3 words shared");
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Trip itinerary draft"), notes), [], "no overlap with any note at all");
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Notes"), notes), [], "a single significant word can never reach the >= 2 threshold");
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Meeting notes 2026"), notes), [], "generic title, no real overlap with any note");
  assert.deepStrictEqual(L.duplicateHintCandidates([], notes), [], "no significant words at all: never matches");

  // Cap + ranking: three notes all share the same 2 words — ranked by note size (desc, tie-break
  // only), capped to 2.
  const three = [
    { id: "a", label: "Heating climate zones", description: "", tokens: 10 },
    { id: "b", label: "Heating climate setup", description: "", tokens: 999 },
    { id: "c", label: "Heating climate notes", description: "", tokens: 50 },
  ];
  assert.deepStrictEqual(L.duplicateHintCandidates(sw("Heating climate project"), three), ["b", "c"], "same shared count (2): ranked by note size, capped to 2");
});

test("duplicateHintBlock: exact gets its own short sentence; similar names 1-2 candidates with their label; empty/null input is never a block", () => {
  const index = { note(id) { return id === "project-ha-climate" ? { id, label: "Heating and climate" } : null; } };
  const exact = L.duplicateHintBlock(index, "project-ha-climate", null);
  assert.strictEqual(exact.type, "text");
  assert.strictEqual(exact.text, "memglow: a note with this title already exists: [[project-ha-climate]] — this write_note may replace or duplicate it; prefer edit_note.");
  const similar = L.duplicateHintBlock(index, null, ["project-ha-climate"]);
  assert.strictEqual(similar.text, "memglow: a note on this subject already exists — [[project-ha-climate]] (Heating and climate). Prefer edit_note on it (append / replace_section) over a new note.");
  // A candidate the index cannot describe (no note(), or it returns null) still gets an id — never crashes.
  const unknown = L.duplicateHintBlock(index, null, ["ghost"]);
  assert.strictEqual(unknown.text, "memglow: a note on this subject already exists — [[ghost]]. Prefer edit_note on it (append / replace_section) over a new note.");
  assert.strictEqual(L.duplicateHintBlock(index, null, []), null);
  assert.strictEqual(L.duplicateHintBlock(index, null, null), null);
});

test("duplicateHintFor: pure glue — exact wins over similar, a title-less call is null, index and archive notes are excluded from the similar rule even when they would otherwise qualify", () => {
  const notes = [
    { id: "project-ha-climate", label: "Heating and climate", description: "Thermostat schedules, zones and heating preferences for the house", theme: "projects", tokens: 50 },
    { id: "old-heating", label: "Old heating notes", description: "Archived heating climate notes from last winter", theme: "projects", tokens: 30 },
    { id: "MEMORY", label: "Index", description: "Heating and climate quick links, grocery shopping", theme: "index", tokens: 5 },
  ];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const index = {
    resolve(raw) { return byId.has(raw) ? raw : null; },
    allNotes() { return notes; },
    isArchive(id) { return id === "old-heating"; },
    note(id) { return byId.get(id) || null; },
  };
  assert.deepStrictEqual(L.duplicateHintFor(index, { title: "project-ha-climate" }), { exact: "project-ha-climate" });
  assert.strictEqual(L.duplicateHintFor(index, {}), null, "no title at all: nothing to check");
  assert.strictEqual(L.duplicateHintFor(index, { title: "   " }), null, "blank title: nothing to check");
  assert.strictEqual(L.duplicateHintFor(index, { title: "Archived heating climate notes" }), null, "its only real match is the archive note itself — excluded, so nothing at all");
  assert.deepStrictEqual(L.duplicateHintFor(index, { title: "Heating and climate overview" }), { similar: ["project-ha-climate"] }, "the index note would also qualify by words alone, but theme === index excludes it");
  assert.strictEqual(L.duplicateHintFor(null, { title: "anything" }), null, "no index at all: never throws");
});

test("duplicateHint (opt-in, over stdio): exact title match (via the note's own label) gets the short line; upstream content untouched otherwise", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("write_note", { title: "Heating and climate", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 2);
    assert.match(r[0], /^# Created note/, "upstream's own confirmation, untouched");
    assert.strictEqual(r[1], "memglow: a note with this title already exists: [[project-ha-climate]] — this write_note may replace or duplicate it; prefer edit_note.");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): a kebab slug matching the note's own id (not its label) is still an exact match", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("write_note", { title: "Project Ha Climate", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 2);
    assert.match(r[1], /^memglow: a note with this title already exists: \[\[project-ha-climate\]\]/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): an EN near-duplicate title gets the 'subject already exists' line with the note's label", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("write_note", { title: "Heating and climate settings", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[1], "memglow: a note on this subject already exists — [[project-ha-climate]] (Heating and climate). Prefer edit_note on it (append / replace_section) over a new note.");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): a FR near-duplicate title matches the FR note (significantWords is EN+FR)", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("write_note", { title: "Réglages chauffage climatisation", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 2);
    assert.match(r[1], /\[\[project-chauffage\]\] \(Chauffage et climatisation\)/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): an unrelated title gets no hint at all", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("write_note", { title: "Trip itinerary draft", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 1, "nothing added");
    assert.match(r[0], /^# Created note/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): index and archive notes are excluded from the similar rule end to end too, not only in the pure matcher", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    // Shares >= 2 words with BOTH the archive note and the index note's own description, but
    // neither counts — and its overlap with the live project note alone (heating/climate, 2 of
    // 4 words = 50%) falls short of the 60% coverage bar, so nothing is added at all.
    const r = texts(await c.call("write_note", { title: "Archived heating climate notes", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 1, "nothing added");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): edit_note is never checked, even when its content looks like a duplicate title", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c.call("edit_note", { identifier: "project-ha-climate", operation: "append", content: "\nHeating and climate settings\n" }));
    assert.strictEqual(r.length, 1, "edit_note is a write, but never write_note: duplicateHint never looks at it");
    assert.match(r[0], /^# Edited note/);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint: off by default — an exact duplicate title gets no hint at all", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx);
  try {
    const r = texts(await c.call("write_note", { title: "Heating and climate", content: "x", directory: "projects" }));
    assert.strictEqual(r.length, 1);
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test("duplicateHint (opt-in): the same note is never hinted twice in one session; a fresh session hints it again; arguments reach the server unchanged", async () => {
  const fx = makeDuplicateNotes();
  const c = start(fx, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const first = texts(await c.call("write_note", { title: "Heating and climate", content: "x", directory: "projects" }));
    assert.strictEqual(first.length, 2, "first time: hinted");
    const second = texts(await c.call("write_note", { title: "Heating and climate", content: "y", directory: "projects" }));
    assert.strictEqual(second.length, 1, "same note, same session: not hinted again");

    const logged = fs.readFileSync(fx.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const writes = logged.filter((e) => e.name === "write_note");
    assert.deepStrictEqual(writes.map((e) => e.args), [
      { title: "Heating and climate", content: "x", directory: "projects" },
      { title: "Heating and climate", content: "y", directory: "projects" },
    ], "duplicateHint never changes the arguments sent upstream");
  } finally { await c.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  // A FRESH session (new client, same notes) starts with an empty `duplicateHinted` set.
  const fx2 = makeDuplicateNotes();
  const c2 = start(fx2, { MEMGLOW_PROXY_DUPLICATE_HINT: "1" });
  try {
    const r = texts(await c2.call("write_note", { title: "Heating and climate", content: "z", directory: "projects" }));
    assert.strictEqual(r.length, 2, "a new session hints it again");
  } finally { await c2.close(); fs.rmSync(fx2.root, { recursive: true, force: true }); }
});
