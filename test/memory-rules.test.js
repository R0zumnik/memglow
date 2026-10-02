"use strict";
// memglow's built-in memory-hygiene rules (lib/memory-rules.js), ON by default — see that file's
// header for the three delivery paths. This file covers: the template and hostile-input
// validation (pure), the transport-agnostic relay, delivery through the real MCP proxy (stdio and
// HTTP) and memglow's own MCP server (initialize instructions + the `memory-hygiene` prompt).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const R = require("../lib/memory-rules");

const PROXY = path.join(__dirname, "..", "mcp-proxy", "memglow-mcp-proxy.js");
const SERVER = path.join(__dirname, "..", "mcp-server", "memglow-mcp.js");
const FAKE_MEMORY = path.join(__dirname, "fixtures", "fake-memory-mcp.js");

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ---------------------------------------------------------------------------------------------
// Template + hostile-input validation (pure)

test("defaultTemplate: real configuration values, no placeholder left unfilled", () => {
  const text = R.defaultTemplate({ largeNoteTokens: 4000, splitChunkTokens: 1500, protectedLabel: "People, Family" });
  assert.match(text, /under 4000 tokens/);
  assert.match(text, /≈ 16 KB/); // 4000 tokens * 4 bytes / 1024
  assert.match(text, /parts of about 1500 tokens/);
  assert.match(text, /People, Family/);
  assert.ok(!/\{.*\}/.test(text), "no unfilled {placeholder} left");
  assert.ok(text.length > 400 && text.length < 1600, "short and impersonal, not a essay: " + text.length);
});

test("defaultTemplate (0.4.2.2b): the first rule tells the assistant to use memglow_queries in ONE call when the tool offers it", () => {
  const text = R.defaultTemplate({ largeNoteTokens: 4000, splitChunkTokens: 1500, protectedLabel: "People, Family" });
  const firstRule = text.split("\n")[1];
  assert.match(firstRule, /^- Search before reading or writing/);
  assert.match(firstRule, /memglow_queries/);
  assert.match(firstRule, /ONE call/);
  assert.match(firstRule, /2–3 different phrasings/, "the rule still names the 2-3 phrasings habit");
});

test("protectedLabelFor: config.protectedThemes with labels, saved zones.json wins, empty -> 'none configured'", () => {
  const themes = [{ id: "people", label: "People" }, { id: "work", label: "Work" }];
  assert.strictEqual(R.protectedLabelFor({ themes, protectedThemes: [], dataDir: null }), "none configured");
  assert.strictEqual(R.protectedLabelFor({ themes, protectedThemes: ["people"], dataDir: null }), "People");
  const dataDir = tmpDir("memglow-rules-zones-");
  fs.writeFileSync(path.join(dataDir, "zones.json"), JSON.stringify({ v: 1, protected: ["work"], labels: { work: "Team" } }));
  // The saved zones.json wins over config.protectedThemes, with its own label.
  assert.strictEqual(R.protectedLabelFor({ themes, protectedThemes: ["people"], dataDir }), "Team");
});

test("validateRulesInput: hostile bodies refused (length, control characters, types), valid ones pass", () => {
  assert.strictEqual(R.validateRulesInput("nope"), null, "not an object");
  assert.strictEqual(R.validateRulesInput({ nope: 1 }), null, "unknown field");
  assert.strictEqual(R.validateRulesInput({ enabled: "yes" }), null, "enabled must be boolean");
  assert.deepStrictEqual(R.validateRulesInput({ enabled: false }), { enabled: false });
  // extra: array, bounded count and length, control characters stripped-then-rejected if emptied
  assert.strictEqual(R.validateRulesInput({ extra: "nope" }), null, "extra must be an array");
  assert.strictEqual(R.validateRulesInput({ extra: Array(11).fill("x") }), null, "too many items");
  assert.strictEqual(R.validateRulesInput({ extra: ["x".repeat(301)] }), null, "item too long");
  assert.strictEqual(R.validateRulesInput({ extra: ["\u0000\u0001"] }), null, "control-only item becomes empty: refused");
  assert.strictEqual(R.validateRulesInput({ extra: [1] }), null, "non-string item");
  assert.deepStrictEqual(R.validateRulesInput({ extra: [" one line ", "two"] }), { extra: ["one line", "two"] }, "trimmed");
  assert.deepStrictEqual(R.validateRulesInput({ extra: ["clean​another"] }).extra[0], "cleananother", "invisible format char (Cf) removed");
  // override: string, bounded length, no control characters except newline/tab
  assert.strictEqual(R.validateRulesInput({ override: 5 }), null, "override must be a string");
  assert.strictEqual(R.validateRulesInput({ override: "x".repeat(4001) }), null, "too long");
  assert.strictEqual(R.validateRulesInput({ override: "line1\u0007line2" }), null, "bell control character refused");
  assert.deepStrictEqual(R.validateRulesInput({ override: " multi\nline\ttext " }), { override: "multi\nline\ttext" }, "newline/tab allowed, trimmed");
  assert.deepStrictEqual(R.validateRulesInput({ override: "" }), { override: "" }, "empty override is valid: falls back to the template");
  // a full, valid body
  assert.deepStrictEqual(R.validateRulesInput({ enabled: true, extra: ["a"], override: "" }), { enabled: true, extra: ["a"], override: "" });
});

test("buildRulesText: off -> '', override wins outright, else template + extra lines", () => {
  const cfg = { largeNoteTokens: 5000, splitChunkTokens: 2000, themes: [], protectedThemes: [], dataDir: null };
  assert.strictEqual(R.buildRulesText(cfg, { enabled: false }), "");
  assert.strictEqual(R.buildRulesText(cfg, { enabled: false, override: "ignored anyway" }), "");
  assert.strictEqual(R.buildRulesText(cfg, { override: "Just this." }), "Just this.");
  const withExtra = R.buildRulesText(cfg, { extra: ["Always say hi.", "Never say bye."] });
  assert.match(withExtra, /^These are memglow's built-in memory-hygiene rules\./);
  assert.match(withExtra, /\n- Always say hi\.\n- Never say bye\.$/);
  // no settings at all (the untouched default): enabled by default, the template alone
  assert.strictEqual(R.buildRulesText(cfg, {}), R.defaultTemplate({ largeNoteTokens: 5000, splitChunkTokens: 2000, protectedLabel: "none configured" }));
});

test("readSavedRules: absent/malformed setup.json -> {}; a real 'rules' section round-trips", () => {
  assert.deepStrictEqual(R.readSavedRules(null), {});
  const dataDir = tmpDir("memglow-rules-setup-");
  assert.deepStrictEqual(R.readSavedRules(dataDir), {}, "no setup.json yet");
  fs.writeFileSync(path.join(dataDir, "setup.json"), "{not json");
  assert.deepStrictEqual(R.readSavedRules(dataDir), {}, "malformed file");
  fs.writeFileSync(path.join(dataDir, "setup.json"), JSON.stringify({ v: 1, rules: { enabled: false, extra: ["x"] } }));
  assert.deepStrictEqual(R.readSavedRules(dataDir), { enabled: false, extra: ["x"] });
  fs.writeFileSync(path.join(dataDir, "setup.json"), JSON.stringify({ v: 1, rules: { enabled: "nope" } }));
  assert.deepStrictEqual(R.readSavedRules(dataDir), {}, "hostile 'rules' section: refused as a whole, defaults apply");
});

test("envDisabled / rulesTextFor: MEMGLOW_RULES=0 (or false/off/no) disables, case-insensitively", () => {
  assert.strictEqual(R.envDisabled({ MEMGLOW_RULES: "0" }), true);
  assert.strictEqual(R.envDisabled({ MEMGLOW_RULES: "FALSE" }), true);
  assert.strictEqual(R.envDisabled({ MEMGLOW_RULES: "Off" }), true);
  assert.strictEqual(R.envDisabled({ MEMGLOW_RULES: "no" }), true);
  assert.strictEqual(R.envDisabled({}), false);
  assert.strictEqual(R.envDisabled({ MEMGLOW_RULES: "1" }), false);
  const cfg = { largeNoteTokens: 5000, splitChunkTokens: 2000, themes: [], protectedThemes: [], dataDir: null };
  assert.strictEqual(R.rulesTextFor(cfg, { MEMGLOW_RULES: "0" }), "");
  assert.match(R.rulesTextFor(cfg, {}), /memory-hygiene rules/);
});

// ---------------------------------------------------------------------------------------------
// Delivery: injectInstructions + the transport-agnostic relay

test("injectInstructions: creates the field, or appends to an existing one behind the header", () => {
  assert.deepStrictEqual(R.injectInstructions({ ok: true }, ""), { ok: true }, "no text: untouched");
  const created = R.injectInstructions({ ok: true }, "Rule 1.");
  assert.strictEqual(created.instructions, `--- ${R.HEADER} ---\nRule 1.`);
  assert.strictEqual(created.ok, true, "nothing else in the result changes");
  const appended = R.injectInstructions({ instructions: "Upstream's own text." }, "Rule 1.");
  assert.strictEqual(appended.instructions, `Upstream's own text.\n\n--- ${R.HEADER} ---\nRule 1.`);
});

test("createRulesRelay: null when off; injects once per session, server errors and non-initialize untouched", () => {
  assert.strictEqual(R.createRulesRelay({ text: "" }), null);
  const relay = R.createRulesRelay({ text: "Rule 1." });
  assert.ok(relay);

  // client -> server: never rewrites, only remembers the pending `initialize` id
  const c = relay.clientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "s1");
  assert.strictEqual(c.changed, false);
  assert.deepStrictEqual(c.msg, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.strictEqual(relay.wants([1], "s1"), true);
  assert.strictEqual(relay.wants([1], "s2"), false, "pending state is per session");

  // server -> client: the matching response gets the rules once
  const r1 = relay.serverMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x" } }, "s1");
  assert.strictEqual(r1.changed, true);
  assert.match(r1.msg.result.instructions, /Rule 1\./);
  assert.strictEqual(relay.wants([1], "s1"), false, "consumed");

  // a second initialize in the SAME session: tracked again, but never injected twice
  relay.clientMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, "s1");
  const r2 = relay.serverMessage({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "x" } }, "s1");
  assert.strictEqual(r2.changed, false, "once per session, even across a re-initialize");
  assert.strictEqual(r2.msg.result.instructions, undefined);

  // a DIFFERENT session gets its own, independent, first injection
  relay.clientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "s2");
  const r3 = relay.serverMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x" } }, "s2");
  assert.strictEqual(r3.changed, true);

  // an error response, or a response to an id never seen as `initialize`, is left alone
  relay.clientMessage({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }, "s3");
  const errored = relay.serverMessage({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "nope" } }, "s3");
  assert.strictEqual(errored.changed, false);
  const unrelated = relay.serverMessage({ jsonrpc: "2.0", id: 999, result: { content: [] } }, "s1");
  assert.strictEqual(unrelated.changed, false);
  // a server-to-client REQUEST (has "method") reusing one of our ids must never be touched
  const request = relay.serverMessage({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} }, "s1");
  assert.strictEqual(request.changed, false);
});

test("lightConfig / computeRulesText: memglow.config.json + env, MEMGLOW_RULES=0 disables, never throws", () => {
  const home = tmpDir("memglow-rules-light-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({
    largeNoteTokens: 3000, splitChunkTokens: 1000, protectedThemes: ["people"],
    themes: [{ id: "people", label: "People" }, { id: "work", label: "Work" }],
  }));
  const env = { MEMGLOW_HOME: home };
  const text = R.computeRulesText(env);
  assert.match(text, /under 3000 tokens/);
  assert.match(text, /People\./);
  assert.strictEqual(R.computeRulesText({ ...env, MEMGLOW_RULES: "0" }), "");
  // a config file that cannot even parse must never throw: fall back to defaults, rules still on
  fs.writeFileSync(path.join(home, "memglow.config.json"), "{not json");
  assert.match(R.computeRulesText(env), /memory-hygiene rules/);
});

// ---------------------------------------------------------------------------------------------
// End to end: the real MCP proxy (stdio), memglow's rules alongside and independent of the levers

const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

function startProxy(env) {
  const root = tmpDir("memglow-rules-proxy-");
  const notes = path.join(root, "notes");
  fs.mkdirSync(notes);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) if (k.startsWith("MEMGLOW_") || k === "MEMORY_DIR") delete baseEnv[k];
  const p = spawn(process.execPath, [PROXY, "--name", "basic-memory", "--", process.execPath, FAKE_MEMORY],
    { env: { ...baseEnv, MEMGLOW_HOME: home, MEMGLOW_MEMORY_DIR: notes, MEMGLOW_DATA_DIR: data, MEMGLOW_FAKE_MCP: "1", FAKE_NOTES_DIR: notes, ...env } });
  let out = "";
  const lines = [];
  p.stdout.on("data", (d) => { out += d; let i; while ((i = out.indexOf("\n")) >= 0) { lines.push(out.slice(0, i)); out = out.slice(i + 1); } });
  return { p, lines, root, home };
}

test("stdio proxy: memglow's rules land in `initialize`'s instructions, kept alongside the upstream's own", async () => {
  const s = startProxy({ FAKE_INSTRUCTIONS: "Upstream says hi." });
  try {
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await waitFor(() => s.lines.length >= 1);
    const res = JSON.parse(s.lines[0]);
    assert.match(res.result.instructions, /^Upstream says hi\./);
    assert.match(res.result.instructions, new RegExp(`--- ${R.HEADER} ---`));
    assert.match(res.result.instructions, /memory-hygiene rules/);
    // a second initialize in the same (single) stdio session: not injected again
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }) + "\n");
    await waitFor(() => s.lines.length >= 2);
    const res2 = JSON.parse(s.lines[1]);
    assert.strictEqual(res2.result.instructions, "Upstream says hi.");
  } finally { s.p.kill(); fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("stdio proxy: MEMGLOW_RULES=0 relays `initialize` byte for byte (independent of the levers)", async () => {
  const s = startProxy({ MEMGLOW_RULES: "0" });
  try {
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await waitFor(() => s.lines.length >= 1);
    assert.deepStrictEqual(JSON.parse(s.lines[0]), { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } finally { s.p.kill(); fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("stdio proxy: rules.enabled=false in setup.json (Settings) turns delivery off, same as the env", async () => {
  const s = startProxy({});
  fs.writeFileSync(path.join(s.root, "data", "setup.json"), JSON.stringify({ v: 1, rules: { enabled: false } }));
  try {
    s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await waitFor(() => s.lines.length >= 1);
    assert.strictEqual(JSON.parse(s.lines[0]).result.instructions, undefined);
  } finally { s.p.kill(); fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("HTTP proxy: rules injected into the initialize JSON response, via the o.rules override", async () => {
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
    });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const { createHttpProxy, setupRules } = require("../mcp-proxy/memglow-mcp-proxy");
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "notes", levers: null, rules: setupRules({}, R.createRulesRelay({ text: "A rule." })) });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    const j = await r.json();
    assert.match(j.result.instructions, /A rule\./);
  } finally {
    upstream.closeAllConnections(); await new Promise((ok) => upstream.close(ok));
    proxy.closeAllConnections(); proxy.close();
  }
});

// ---------------------------------------------------------------------------------------------
// memglow's own MCP server: initialize instructions + the `memory-hygiene` prompt

test("mcp-server: initialize instructions include the rules; the memory-hygiene prompt mirrors them; off when disabled", () => {
  const { createContext, createRpc, RULES_PROMPT_NAME } = require("../mcp-server/memglow-mcp");
  const notesDir = tmpDir("memglow-rules-mcp-notes-");
  const dataDir = tmpDir("memglow-rules-mcp-data-");
  const sent = [];
  const handle = createRpc((s) => sent.push(JSON.parse(s.trim())));
  const ctx = createContext({ MEMORY_DIR: notesDir, MEMGLOW_DATA_DIR: dataDir }, os.tmpdir());
  const last = () => sent[sent.length - 1];

  handle(ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.strictEqual(last().result.capabilities.prompts && typeof last().result.capabilities.prompts, "object");
  assert.match(last().result.instructions, new RegExp(`--- ${R.HEADER} ---`));
  assert.match(last().result.instructions, /memory-hygiene rules/);

  handle(ctx, { jsonrpc: "2.0", id: 2, method: "prompts/list" });
  assert.deepStrictEqual(last().result.prompts.map((p) => p.name), [RULES_PROMPT_NAME]);

  handle(ctx, { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: RULES_PROMPT_NAME } });
  const got = last().result;
  assert.strictEqual(got.messages[0].role, "user");
  assert.strictEqual(got.messages[0].content.type, "text");
  assert.match(got.messages[0].content.text, /memory-hygiene rules/);
  assert.ok(last().result.instructions === undefined, "a result, not wrapped again");

  handle(ctx, { jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "no-such-prompt" } });
  assert.strictEqual(last().error.code, -32602);

  // disabled (env): no prompt offered, initialize instructions unchanged, prompts/get refuses
  const sent2 = [];
  const handle2 = createRpc((s) => sent2.push(JSON.parse(s.trim())));
  const prevEnv = process.env.MEMGLOW_RULES;
  process.env.MEMGLOW_RULES = "0";
  try {
    handle2(ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.ok(!/memory-hygiene rules/.test(sent2[sent2.length - 1].result.instructions || ""));
    handle2(ctx, { jsonrpc: "2.0", id: 2, method: "prompts/list" });
    assert.deepStrictEqual(sent2[sent2.length - 1].result.prompts, []);
    handle2(ctx, { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: RULES_PROMPT_NAME } });
    assert.strictEqual(sent2[sent2.length - 1].error.code, -32602);
  } finally {
    if (prevEnv === undefined) delete process.env.MEMGLOW_RULES; else process.env.MEMGLOW_RULES = prevEnv;
  }
});

test("real process: memglow-mcp over actual stdio ships the memory-hygiene prompt", async () => {
  const notesDir = tmpDir("memglow-rules-real-notes-");
  const dataDir = tmpDir("memglow-rules-real-data-");
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MEMORY_DIR: notesDir, MEMGLOW_DATA_DIR: dataDir } });
  try {
    const wire = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "memory-hygiene" } },
    ].map((m) => JSON.stringify(m) + "\n").join("");
    child.stdin.write(wire);
    const lines = await new Promise((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error("timed out: " + out)), 5000);
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
        const got = out.split("\n").filter(Boolean);
        if (got.length >= 2) { clearTimeout(t); resolve(got.slice(0, 2).map((l) => JSON.parse(l))); }
      });
    });
    assert.match(lines[0].result.instructions, /memory-hygiene rules/);
    assert.match(lines[1].result.messages[0].content.text, /memory-hygiene rules/);
  } finally { child.kill(); }
});
