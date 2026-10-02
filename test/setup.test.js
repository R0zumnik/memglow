"use strict";
// First-run set-up and Settings → AI settings (lib/setup.js, server.js /api/setup*, public/setup.js,
// lib/clients.js, bin/memglow.js init questions, lib/installer.js --docker). Every "API" here is a
// fake server on 127.0.0.1 and every key is fake; no real provider is ever called.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const setup = require("../lib/setup");
const clients = require("../lib/clients");
const claudeCode = require("../lib/assistant/providers/claude-code");
const page = require("../public/setup.js");

const KEY = "sk-test-memglow-SETUP-FAKE-0123456789abcdef";
const TOKEN = "sk-ant-oat01-FAKE-SUBSCRIPTION-TOKEN-0123456789";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A server on a temp notes folder and data folder; every console line is captured. */
async function start(env = {}, opts = {}) {
  const root = tmp("memglow-setup-");
  const notes = path.join(root, "notes"); fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "a.md"), "---\ntheme: knowledge\n---\n# A\nsecret project text\n");
  const data = path.join(root, "data");
  const fullEnv = { PATH: process.env.PATH, MEMORY_DIR: notes, MEMGLOW_DATA_DIR: data, MEMGLOW_HOME: path.join(root, "home"), ...env };
  const config = loadConfig(fullEnv, root);
  const memory = createMemory({ dir: config.memoryDir, config });
  const logs = [];
  const orig = {};
  for (const k of ["log", "warn", "error"]) { orig[k] = console[k]; console[k] = (...a) => logs.push(a.join(" ")); }
  const server = createServer(config, memory, { assistantEnv: fullEnv, setupStore: setup.createSetupStore({ dir: data, burst: 1000 }), ...opts });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const bodies = [];
  async function call(p, { method = "GET", body, headers = {} } = {}) {
    const h = method === "GET" ? { ...headers } : { "content-type": "application/json", "x-memglow": "1", origin: base, ...headers };
    const r = await fetch(base + p, { method, headers: h, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    bodies.push(text);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, text, json };
  }
  return {
    root, data, config, base, port, call, logs, bodies,
    async stop() { server.close(); for (const k of Object.keys(orig)) console[k] = orig[k]; },
  };
}

test("setup: shown at first run, then no more; can be run again from Settings", async () => {
  const s = await start();
  try {
    const first = await s.call("/");
    const cfg = JSON.parse(first.text.match(/id="memglow-config">([^<]*)</)[1]);
    assert.strictEqual(cfg.setupPending, true);
    assert.match(first.text, /id="mg-setup"/);
    assert.match(first.text, /<script src="\/setup\.js\?v=/);
    assert.strictEqual((await s.call("/setup.js")).status, 200);
    const g = await s.call("/api/setup");
    assert.strictEqual(g.json.wizard.done, false);
    // Step 1 saved, not finished: still pending.
    assert.strictEqual((await s.call("/api/setup", { method: "PUT", body: { clients: ["codex", "chatgpt", "claude-code"] } })).status, 200);
    assert.strictEqual(JSON.parse((await s.call("/")).text.match(/id="memglow-config">([^<]*)</)[1]).setupPending, true);
    assert.deepStrictEqual((await s.call("/api/setup")).json.clients.chosen, ["claude-code", "codex", "chatgpt"], "reference order");
    assert.strictEqual((await s.call("/api/setup", { method: "PUT", body: { wizardDone: true } })).status, 200);
    const after = await s.call("/");
    assert.strictEqual(JSON.parse(after.text.match(/id="memglow-config">([^<]*)</)[1]).setupPending, false);
    // Run again from Settings: the buttons are there whatever the state.
    assert.match(after.text, /id="mem-setup-again"/);
    assert.match(after.text, /id="mem-llmset"/);
    // Saved in the data folder, mode 600, readable by the proxy (lib/clients.js).
    assert.strictEqual(fs.statSync(path.join(s.data, "setup.json")).mode & 0o777, 0o600);
    assert.deepStrictEqual(clients.readClients(s.data, null, {}), { clients: ["claude-code", "codex", "chatgpt"], source: "page" });
  } finally { await s.stop(); }
});

test("setup: hostile bodies are refused, nothing written, nothing echoed", async () => {
  const s = await start();
  try {
    const bad = [
      [{ clients: ["claude-code", "evil"] }, "bad-clients"],
      [{ clients: "claude-code" }, "bad-clients"],
      [{ nope: 1 }, "unknown-field"],
      [JSON.parse('{"__proto__": {"x": 1}}'), "unknown-field"],
      [{ assistant: { enabled: "yes" } }, "bad-value"],
      [{ assistant: { providers: { codex: {} } } }, "unknown-provider"],
      [{ assistant: { providers: { anthropic: { model: "gpt-4o" } } } }, "bad-model"],
      [{ assistant: { providers: { "claude-code": { model: "opus; rm -rf /" } } } }, "bad-model"],
      [{ assistant: { providers: { "claude-code": { maxTokens: 10 } } } }, "unknown-field"],
      [{ assistant: { providers: { anthropic: { baseUrl: "http://example.com" } } } }, "bad-url"],
      [{ assistant: { providers: { anthropic: { baseUrl: "https://user:pw@example.com" } } } }, "bad-url"],
      [{ assistant: { providers: { ollama: { baseUrl: "https://example.com/v1" } } } }, "url-not-local"],
      [{ assistant: { providers: { anthropic: { model: "claude-opus-5", temperature: 0.5 } } } }, "temperature-unsupported"],
      [{ assistant: { providers: { "openai-compatible": { temperature: 3 } } } }, "out-of-range"],
      [{ assistant: { providers: { "openai-compatible": { maxTokens: 1.5 } } } }, "out-of-range"],
      [{ assistant: { providers: { anthropic: {} }, provider: "ollama" } }, "default-not-chosen"],
      [{ assistant: { providers: { anthropic: { apiKey: KEY } } } }, "secret-field"],
      [{ assistant: { providers: { "openai-compatible": { model: KEY } } } }, "secret-field"],
      [{ tuning: { allowMissingLines: 51 } }, "out-of-range"],
      [{ tuning: { backup: "rsync" } }, "bad-value"],
      [{ tuning: { largeNoteTokens: 300, splitChunkTokens: 400 } }, "parts-larger-than-limit"],
    ];
    for (const [body, error] of bad) {
      const r = await s.call("/api/setup", { method: "PUT", body });
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.strictEqual(r.json.error, error, JSON.stringify(body));
    }
    assert.ok(!fs.existsSync(path.join(s.data, "setup.json")), "nothing written");
    assert.strictEqual((await s.call("/api/setup", { method: "PUT", body: "{not json" })).status, 400);
    assert.strictEqual((await s.call("/api/setup", { method: "PUT", body: JSON.stringify({ clients: [] }), headers: { "content-type": "text/plain" } })).status, 415);
    assert.strictEqual((await s.call("/api/setup", { method: "PUT", body: JSON.stringify({ clients: ["x".repeat(20000)] }) })).status, 413);
    // CSRF: memglow's header and the page's origin are required, for every write route.
    for (const p of ["/api/setup", "/api/setup/secret", "/api/setup/test"]) {
      const method = p === "/api/setup" ? "PUT" : "POST";
      assert.strictEqual((await s.call(p, { method, body: { provider: "anthropic", secret: KEY }, headers: { "x-memglow": "" } })).status, 403, p + " without header");
      assert.strictEqual((await s.call(p, { method, body: { provider: "anthropic", secret: KEY }, headers: { origin: "http://evil.example" } })).status, 403, p + " cross-origin");
      assert.strictEqual((await s.call(p, { method, body: { provider: "anthropic", secret: KEY }, headers: { "sec-fetch-site": "cross-site" } })).status, 403, p + " cross-site");
    }
    assert.ok(!fs.existsSync(path.join(s.data, "assistant-api-key-anthropic")));
    for (const b of s.bodies) assert.ok(!b.includes(KEY), "the key is never echoed");
  } finally { await s.stop(); }
});

test("setup: providers saved (several), page > file, environment > page, assistant on without restart", async () => {
  const root = tmp("memglow-setup-cfg-");
  const cfgFile = path.join(root, "memglow.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ largeNoteTokens: 4000, assistant: { enabled: false, provider: "anthropic", anthropic: { model: "claude-haiku-4-5" } } }));
  const s = await start({ MEMGLOW_CONFIG: cfgFile, MEMGLOW_ASSISTANT_MODEL: "claude-opus-5" });
  try {
    let g = (await s.call("/api/setup")).json;
    assert.strictEqual(g.assistant.enabled, false);
    assert.strictEqual(g.tuning.largeNoteTokens, 4000);
    assert.strictEqual((await s.call("/api/assistant")).status, 404, "off: the route does not exist");
    const r = await s.call("/api/setup", { method: "PUT", body: {
      assistant: { enabled: true, provider: "anthropic", providers: {
        anthropic: { model: "claude-sonnet-4-6", maxTokens: 2000, temperature: 0.4, confirmRemote: false, priceIn: 3, priceOut: 15 },
        "claude-code": { model: "opus", maxBudgetUsd: 0.5, timeoutMinutes: 5 },
        ollama: { model: "llama3.1:8b" },
      } },
      tuning: { largeNoteTokens: 6000, splitChunkTokens: 1500, allowMissingLines: 2, backup: "copy" },
    } });
    assert.strictEqual(r.status, 200, r.text);
    g = r.json;
    const row = (id) => g.assistant.providers.find((p) => p.id === id);
    assert.strictEqual(g.assistant.enabled, true);
    // Environment > page: MEMGLOW_ASSISTANT_MODEL keeps the default provider's model, shown locked.
    assert.strictEqual(row("anthropic").settings.model, "claude-opus-5");
    assert.strictEqual(row("anthropic").locked.model, "MEMGLOW_ASSISTANT_MODEL");
    assert.strictEqual(row("anthropic").settings.maxTokens, 2000);
    assert.strictEqual(row("claude-code").settings.model, "opus");
    assert.strictEqual(row("claude-code").settings.maxBudgetUsd, 0.5);
    assert.strictEqual(row("ollama").local, true);
    assert.strictEqual(row("anthropic").source, "page");
    assert.strictEqual(g.tuning.largeNoteTokens, 6000, "page > file");
    assert.strictEqual(g.tuning.allowMissingLines, 2);
    assert.strictEqual(g.tuning.backup, "copy");
    // Live: the assistant exists now, with the settings in effect.
    const st = await s.call("/api/assistant");
    assert.strictEqual(st.status, 200);
    const ollama = st.json.providers.find((p) => p.id === "ollama");
    assert.strictEqual(ollama.destination, "127.0.0.1:11434");
    assert.strictEqual(st.json.providers.find((p) => p.id === "anthropic").confirmRemote, false);
    assert.strictEqual(st.json.providers.find((p) => p.id === "claude-code").confirmRemote, true, "remote: ask by default");
    assert.match((await s.call("/")).text, /mg-ai-title/, "the panel is on the page");
    // Environment > page for the on/off switch.
    const e = setup.effective({ assistant: { enabled: false, provider: "anthropic", sections: {} }, largeNoteTokens: 5000, clients: ["codex"] },
      { assistant: { enabled: true, provider: "ollama", providers: { ollama: {} } }, clients: ["cline"], tuning: { largeNoteTokens: 9000 } },
      { MEMGLOW_ASSISTANT: "0", MEMGLOW_CLIENTS: "gemini", MEMGLOW_LARGE_NOTE_TOKENS: "7000" });
    assert.strictEqual(e.assistant.enabled, false);
    assert.strictEqual(e.assistant.provider, "ollama");
    assert.deepStrictEqual(e.clients, ["gemini"]);
    assert.strictEqual(e.clientsSource, "env");
    assert.strictEqual(e.largeNoteTokens, 5000, "the file value (already env-resolved by loadConfig) is kept when the env sets it");
    assert.strictEqual(setup.effective({ assistant: {}, clients: null }, {}, { MEMGLOW_CLIENTS: "" }).clients, null, "an empty variable is not set");
  } finally { await s.stop(); }
});

test("setup: a key is typed only from this computer, or with a password over HTTPS", async () => {
  const s = await start();
  try {
    const ok = await s.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", secret: KEY } });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, { provider: "anthropic", key: "set", keySource: "page", keyName: "assistant-api-key-anthropic" });
    const file = path.join(s.data, "assistant-api-key-anthropic");
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(file, "utf8").trim(), KEY);
    // Through a proxy on this machine (forwarded headers), or from a non-loopback origin: refused.
    for (const headers of [{ "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-real-ip": "203.0.113.9" }]) {
      const r = await s.call("/api/setup/secret", { method: "POST", body: { provider: "openai-compatible", secret: KEY }, headers });
      assert.strictEqual(r.status, 403, JSON.stringify(headers));
      assert.strictEqual(r.json.error, "secret-entry-refused");
    }
    assert.ok(!fs.existsSync(path.join(s.data, "assistant-api-key-openai-compatible")));
    // A bad value is refused without echo; extra fields are refused; no secret for a local model.
    const badValue = "sk bad value with spaces " + KEY;
    assert.strictEqual((await s.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", secret: badValue } })).status, 400);
    assert.strictEqual((await s.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", secret: KEY, model: "x" } })).status, 400);
    assert.strictEqual((await s.call("/api/setup/secret", { method: "POST", body: { provider: "ollama", secret: KEY } })).json.error, "no-secret-for-provider");
    // Never in any answer, page or log.
    const everything = [(await s.call("/api/setup")).text, (await s.call("/")).text, ...s.bodies, ...s.logs].join("\n");
    assert.ok(!everything.includes(KEY), "never sent back, never logged");
    assert.strictEqual((await s.call("/api/setup")).json.assistant.providers.find((p) => p.id === "anthropic").key, "set");
    // Remove key.
    const rm = await s.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", remove: true } });
    assert.strictEqual(rm.json.key, "not set");
    assert.ok(!fs.existsSync(file));
  } finally { await s.stop(); }

  // Password set, but plain HTTP from another machine (as seen through a proxy): refused; with the
  // proxy trusted and X-Forwarded-Proto https: allowed.
  const pw = "a-long-password-for-tests";
  const auth = { authorization: "Basic " + Buffer.from("memglow:" + pw).toString("base64") };
  for (const [trust, proto, want] of [["", "http", 403], ["", "https", 403], ["1", "http", 403], ["1", "https", 200]]) {
    const t = await start({ MEMGLOW_PASSWORD: pw, MEMGLOW_TRUST_PROXY: trust });
    try {
      const r = await t.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", secret: KEY },
        headers: { ...auth, origin: proto + "://memglow.example", "x-forwarded-host": "memglow.example", "x-forwarded-proto": proto, "x-forwarded-for": "203.0.113.9" } });
      assert.strictEqual(r.status, want, `trust=${trust} proto=${proto}`);
      if (want === 403) assert.match(r.json.reason, /not-https/);
    } finally { await t.stop(); }
  }
  // The pure rule: loopback socket, no proxy header, loopback origin.
  const fake = (addr, headers) => ({ socket: { remoteAddress: addr }, headers });
  assert.strictEqual(setup.secretEntry(fake("127.0.0.1", { origin: "http://localhost:4747" }), {}).allowed, true);
  assert.strictEqual(setup.secretEntry(fake("::ffff:127.0.0.1", { origin: "http://127.0.0.1:4747" }), {}).allowed, true);
  assert.strictEqual(setup.secretEntry(fake("172.17.0.1", { origin: "http://127.0.0.1:4747" }), {}).allowed, false, "Docker bridge: not this machine");
  assert.strictEqual(setup.secretEntry(fake("127.0.0.1", { origin: "http://memglow.lan" }), {}).allowed, false);
});

test("setup: changing the address of a provider that holds a key needs the same conditions as typing one", async () => {
  const s = await start({ MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC: KEY });
  try {
    const put = (baseUrl, headers) => s.call("/api/setup", { method: "PUT", headers, body: { assistant: { enabled: true, provider: "anthropic", providers: { anthropic: { baseUrl } } } } });
    assert.strictEqual((await put("https://gateway.example/anthropic", { "x-forwarded-for": "203.0.113.9" })).json.error, "destination-change-needs-local");
    assert.strictEqual((await put("https://gateway.example/anthropic")).status, 200, "from this computer");
    const row = (await s.call("/api/setup")).json.assistant.providers.find((p) => p.id === "anthropic");
    assert.deepStrictEqual([row.key, row.keySource, row.keyName], ["set", "env", "MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC"]);
    for (const b of s.bodies) assert.ok(!b.includes(KEY));
  } finally { await s.stop(); }
});

test("setup: Test connection against a fake API — minimal request, OK or a key-free error", async () => {
  const calls = [];
  let status = 200;
  const api = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, body: raw });
      if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }, { id: "qwen2.5" }, { id: "bad id!" }] })); }
      if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: " + KEY } })); }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.endsWith("/v1/messages")) return res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }));
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((ok) => api.listen(0, "127.0.0.1", ok));
  const apiBase = `http://127.0.0.1:${api.address().port}`;
  const s = await start();
  try {
    await s.call("/api/setup/secret", { method: "POST", body: { provider: "anthropic", secret: KEY } });
    await s.call("/api/setup", { method: "PUT", body: { assistant: { enabled: true, provider: "anthropic", providers: {
      anthropic: { baseUrl: apiBase, model: "claude-haiku-4-5" }, ollama: { baseUrl: apiBase + "/v1", model: "llama3.1:8b" } } } } });
    let r = await s.call("/api/setup/test", { method: "POST", body: { provider: "anthropic" } });
    assert.strictEqual(r.json.ok, true, r.text);
    const c = calls.find((x) => x.url === "/v1/messages");
    assert.strictEqual(c.headers["x-api-key"], KEY, "the key goes to the provider only");
    assert.ok(!c.body.includes("secret project text"), "no note content in a test");
    assert.ok(!/"tools"/.test(c.body));
    r = await s.call("/api/setup/test", { method: "POST", body: { provider: "ollama" } });
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.models, ["llama3.1:8b", "qwen2.5"], "the local server's models, valid names only");
    assert.ok(!calls.find((x) => x.url === "/v1/chat/completions").headers.authorization, "no key to a local model");
    status = 401;
    r = await s.call("/api/setup/test", { method: "POST", body: { provider: "anthropic" } });
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.error, /401/);
    assert.strictEqual((await s.call("/api/setup/test", { method: "POST", body: { provider: "codex" } })).status, 400);
    for (const b of [...s.bodies, ...s.logs]) assert.ok(!b.includes(KEY), "the key never comes back");
  } finally { await s.stop(); api.close(); }
});

test("setup: Claude Code subscription — model checked, token only in the `claude` child's environment", async () => {
  for (const m of ["opus", "sonnet", "haiku", "fable", "default", "sonnet[1m]", "claude-opus-5-5"]) assert.ok(claudeCode.validModel(m), m);
  for (const m of ["gpt-4o", "opus --dangerously-skip-permissions", "-p", "claude-", "Opus"]) assert.ok(!claudeCode.validModel(m), m);
  assert.strictEqual(claudeCode.label, "Claude Code subscription (no API key)");

  const s = await start();
  const bin = path.join(s.root, "bin");
  fs.mkdirSync(bin);
  const seen = path.join(s.root, "seen.json");
  const fake = path.join(bin, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require("fs");
if (process.argv.includes("--help")) { process.stdout.write("--restricted --tools stream-json --include-partial-messages dontAsk --no-session-persistence --system-prompt --strict-mcp-config --disallowedTools"); process.exit(0); }
let input = ""; process.stdin.on("data", (d) => input += d); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN || "", apiKey: process.env.ANTHROPIC_API_KEY || "", memglowToken: process.env.MEMGLOW_TOKEN || "", argv: process.argv.slice(2) }));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "OK" }) + "\\n");
});
`, { mode: 0o755 });
  await s.stop();
  const t = await start({ PATH: bin + path.delimiter + process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-api-OTHER-KEY-0000000000", MEMGLOW_TOKEN: "x".repeat(40) });
  try {
    await t.call("/api/setup", { method: "PUT", body: { assistant: { enabled: true, provider: "claude-code", providers: { "claude-code": { model: "sonnet" } } } } });
    assert.strictEqual((await t.call("/api/setup/secret", { method: "POST", body: { provider: "claude-code", secret: TOKEN } })).json.keySource, "page");
    assert.strictEqual(fs.statSync(path.join(t.data, "claude-code-oauth-token")).mode & 0o777, 0o600);
    const r = await t.call("/api/setup/test", { method: "POST", body: { provider: "claude-code" } });
    assert.strictEqual(r.json.ok, true, r.text);
    const got = JSON.parse(fs.readFileSync(seen, "utf8"));
    assert.strictEqual(got.token, TOKEN, "given to the claude process");
    assert.strictEqual(got.apiKey, "", "an API key would win over the subscription: not passed");
    assert.strictEqual(got.memglowToken, "", "memglow's own secrets never reach a child");
    assert.ok(!got.argv.join(" ").includes(TOKEN), "never on the command line");
    assert.deepStrictEqual(got.argv.slice(got.argv.indexOf("--model"), got.argv.indexOf("--model") + 2), ["--model", "sonnet"]);
    assert.ok(!process.env.CLAUDE_CODE_OAUTH_TOKEN, "memglow's own environment is not changed");
    const env = claudeCode.claudeEnv({ PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "x" }, t.data);
    assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.ok(!("ANTHROPIC_AUTH_TOKEN" in env));
    assert.deepStrictEqual(claudeCode.oauth({ env: { CLAUDE_CODE_OAUTH_TOKEN: "from-env-123456" }, dataDir: t.data }), { auth: "env", token: "" }, "environment > page");
    for (const b of [...t.bodies, ...t.logs]) assert.ok(!b.includes(TOKEN), "the token is never sent back or logged");
    // Docker without the CLI: said plainly.
    const d = claudeCode.detect({ env: { PATH: "/nonexistent", MEMGLOW_DOCKER: "1" } });
    assert.match(d.reason, /not available in this container/);
  } finally { await t.stop(); }
});

test("setup: usage counts and estimate, numbers only", () => {
  const dir = tmp("memglow-usage-");
  const now = Date.UTC(2026, 9, 1, 12);
  const u = setup.createUsage({ dir, now: () => now });
  u.add({ provider: "anthropic", ok: true, inChars: 4000, outChars: 2000 });
  u.add({ provider: "anthropic", ok: false, inChars: 400, outChars: 0 }, now - 10 * 86400000);
  u.add({ provider: "claude-code", ok: true, inChars: 400, outChars: 40 });
  u.add({ provider: "evil", ok: true, inChars: 1, outChars: 1 });
  const sum = u.summary((id) => (id === "anthropic" ? [3, 15] : null));
  assert.deepStrictEqual(Object.keys(sum).sort(), ["anthropic", "claude-code"]);
  assert.strictEqual(sum.anthropic.d7.n, 1);
  assert.strictEqual(sum.anthropic.d30.n, 2);
  assert.strictEqual(sum.anthropic.d30.failed, 1);
  assert.strictEqual(sum.anthropic.d7.cost, Math.round(((1000 * 3 + 500 * 15) / 1e6) * 10000) / 10000);
  assert.strictEqual(sum["claude-code"].billing, "subscription");
  assert.strictEqual(fs.statSync(path.join(dir, setup.USAGE_FILE)).mode & 0o777, 0o600);
  assert.deepStrictEqual(setup.priceOf({ model: "claude-haiku-4-5" }, "anthropic"), [1, 5]);
});

test("setup page: renders every step and AI settings, escapes server text, collects strictly", () => {
  const T = (k, p) => "[" + k + "]" + (p ? JSON.stringify(p) : "");
  const s = {
    docker: true, activityToken: false,
    clients: { list: clients.CLIENTS.map((c) => ({ ...c, detected: c.id === "codex", hook: false })), chosen: null, locked: "" },
    assistant: { enabled: true, provider: "anthropic", blocked: "", locked: {}, providers: [
      { id: "anthropic", label: "<b>A</b>", local: false, detected: true, available: false, reason: "<img src=x>", destination: "api.anthropic.com", key: "not set", secret: "apikey", keyEnv: "MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC",
        fields: setup.FIELDS.anthropic, settings: { model: "claude-haiku-4-5" }, defaults: setup.DEFAULTS.anthropic, models: ["claude-opus-5"], presets: [], temperatureMax: 1, temperatureSupported: true, price: [1, 5], locked: {}, configured: true, source: "page" },
      { id: "ollama", label: "Ollama", local: true, detected: false, available: true, destination: "127.0.0.1:11434", key: "not needed", secret: "", fields: setup.FIELDS.ollama, settings: {}, defaults: setup.DEFAULTS.ollama, models: [], presets: [], temperatureMax: 2, temperatureSupported: true, price: null, locked: {}, configured: false },
    ] },
    tuning: { largeNoteTokens: 5000, splitChunkTokens: 2000, allowMissingLines: 3, backup: "auto", locked: {} },
    secretEntry: { allowed: false, reason: "no-password" },
    usage: { anthropic: { d7: { n: 2, inTokens: 10, outTokens: 5, cost: 0.01 }, d30: { n: 3, inTokens: 20, outTokens: 9, cost: 0.02 }, billing: "api" } },
  };
  const c = page.setupRenderClients(s, null, "http://127.0.0.1:4747", T);
  assert.match(c, /value="codex" checked/, "pre-ticked from what memglow init detected");
  assert.match(c, /\[setup.hookDocker\]/, "Docker: hooks run next to the tool");
  assert.match(c, /MEMGLOW_URL=http:\/\/127\.0\.0\.1:4747/);
  assert.match(c, /\[setup.noToken\]/);
  const state = page.setupStateFrom(s, true);
  assert.deepStrictEqual(Object.keys(state.chosen), ["anthropic"]);
  const full = page.setupRenderProviders(s, state, true, T);
  assert.ok(!full.includes("<b>A</b>") && !full.includes("<img src=x>"), "server text escaped");
  assert.match(full, /type="password" disabled/, "key field disabled when not allowed");
  assert.match(full, /\[setup.keyLocked\]/);
  assert.match(full, /data-f="temperature"/);
  assert.match(full, /\[setup.privacyRemote\]\{&quot;dest&quot;:&quot;api.anthropic.com&quot;\}/);
  assert.match(full, /\[aiset.capEstimate\]/);
  assert.match(full, /data-act="add"/, "the other providers can be added");
  const wiz = page.setupRenderProviders(s, { enabled: true, provider: "ollama", chosen: { ollama: {} } }, false, T);
  assert.match(wiz, /\[setup.privacyLocal\]/);
  assert.ok(!/data-f="maxTokens"/.test(wiz), "first run: the essentials only");
  const allowed = page.setupProviderFields(s.assistant.providers[0], {}, { allowed: true }, false, T);
  assert.match(allowed, /type="password" data-secret="anthropic" autocomplete="off"/);
  assert.ok(!/value="sk-/.test(allowed));
  assert.match(page.setupRenderTuning(s, null, T), /\[aiset.missingWarn\]/, "warning when lines may go missing");
  assert.match(page.setupRenderUsage(s, T), /\[aiset.usageRow\]/);
  // Collect: empty number = default (null), checkbox read as a boolean, unchosen providers ignored.
  const inp = (p, f, value, extra = {}) => ({ getAttribute: (k) => ({ "data-p": p, "data-f": f }[k] || null), value, ...extra });
  const body = page.setupCollectProviders({ enabled: true, provider: "anthropic", chosen: { anthropic: {} } }, [
    inp("anthropic", "model", " claude-opus-5 "), inp("anthropic", "maxTokens", ""), inp("anthropic", "temperature", "0.3"),
    inp("anthropic", "confirmRemote", "", { checked: false }), inp("ollama", "model", "x"),
  ]);
  assert.deepStrictEqual(body, { enabled: true, provider: "anthropic", providers: { anthropic: { model: "claude-opus-5", maxTokens: null, temperature: 0.3, confirmRemote: false } } });
  assert.strictEqual(setup.validate({ assistant: body }).ok, false, "temperature refused for that model — said by the server");
});

test("memglow init: questions simulated (tools, assistant, masked key) and --docker without any key", async () => {
  const { cmdInit } = require("../bin/memglow.js");
  const home = tmp("memglow-init-q-");
  const notes = path.join(home, "notes"); fs.mkdirSync(notes);
  fs.mkdirSync(path.join(home, ".codex"));
  const asked = [];
  const answers = { text: ["2,8", "2", "claude-opus-5"], hidden: [KEY] };
  const io = {
    text: async (q, def) => { asked.push(["text", q, def]); return answers.text.shift(); },
    hidden: async (q) => { asked.push(["hidden", q]); return answers.hidden.shift(); },
    yesNo: async (q) => { asked.push(["yesNo", q]); return true; },
    log: () => {},
  };
  const out = []; const log = console.log; console.log = (...a) => out.push(a.join(" "));
  let code;
  try { code = await cmdInit({ _: ["init"], dir: notes, home }, io); } finally { console.log = log; }
  assert.strictEqual(code, 0, out.join("\n"));
  assert.strictEqual(asked.find((a) => a[0] === "text")[2], "2", "detected tools proposed by default (Codex = 2)");
  assert.ok(asked.some((a) => a[0] === "hidden"), "the key is read without echo");
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".memglow", "memglow.config.json"), "utf8"));
  assert.deepStrictEqual(cfg.clients, ["codex", "chatgpt"]);
  assert.deepStrictEqual(cfg.assistant, { enabled: true, provider: "anthropic", anthropic: { model: "claude-opus-5" } });
  assert.ok(!JSON.stringify(cfg).includes(KEY), "no key in the config file");
  const keyFile = path.join(home, ".memglow", "assistant-api-key-anthropic");
  assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!out.join("\n").includes(KEY), "never printed");
  const manifest = JSON.parse(fs.readFileSync(path.join(home, ".memglow", "install-manifest.json"), "utf8"));
  assert.deepStrictEqual(manifest.detected, ["codex"]);

  // --docker: the choices become variables, the key lines stay commented, no key is asked.
  const home2 = tmp("memglow-init-d-");
  const notes2 = path.join(home2, "notes"); fs.mkdirSync(notes2);
  const asked2 = [];
  const answers2 = ["1,9", "1,2", "opus", "claude-opus-5"];
  const io2 = { text: async () => answers2.shift(), hidden: async () => { asked2.push("hidden"); return KEY; }, yesNo: async () => true, log: () => {} };
  console.log = () => {};
  try { code = await cmdInit({ _: ["init"], dir: notes2, home: home2, docker: true }, io2); } finally { console.log = log; }
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(asked2, [], "no key asked for Docker");
  const envText = fs.readFileSync(path.join(home2, ".memglow", ".env"), "utf8");
  assert.match(envText, /^MEMGLOW_CLIENTS=claude-code,other-mcp$/m);
  assert.match(envText, /^MEMGLOW_ASSISTANT=1$/m);
  assert.match(envText, /^MEMGLOW_ASSISTANT_PROVIDER=claude-code$/m);
  assert.match(envText, /^MEMGLOW_ASSISTANT_MODEL=opus$/m);
  assert.match(envText, /^# MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC=$/m);
  assert.match(envText, /^# CLAUDE_CODE_OAUTH_TOKEN=$/m);
  assert.ok(!envText.includes(KEY));
  assert.strictEqual(fs.statSync(path.join(home2, ".memglow", ".env")).mode & 0o777, 0o600);
  const compose = fs.readFileSync(path.join(home2, ".memglow", "docker-compose.yml"), "utf8");
  assert.match(compose, /- MEMGLOW_CLIENTS=\$\{MEMGLOW_CLIENTS:-\}/);
  assert.match(compose, /- CLAUDE_CODE_OAUTH_TOKEN=\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}/);

  // --yes: nothing asked, nothing new written (previous behaviour).
  const home3 = tmp("memglow-init-y-");
  const notes3 = path.join(home3, "notes"); fs.mkdirSync(notes3);
  console.log = () => {};
  try { code = await cmdInit({ _: ["init"], dir: notes3, home: home3, yes: true, docker: true }); } finally { console.log = log; }
  assert.strictEqual(code, 0);
  const cfg3 = JSON.parse(fs.readFileSync(path.join(home3, ".memglow", "memglow.config.json"), "utf8"));
  assert.ok(!("clients" in cfg3) && !("assistant" in cfg3));
  assert.ok(!/MEMGLOW_CLIENTS/.test(fs.readFileSync(path.join(home3, ".memglow", ".env"), "utf8")));
});

test("setup page script: runs in a simulated page — wizard opens, step 1 saved, step 2, finish opens step 3", async () => {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "setup.js"), "utf8");
  const s = await start();
  try {
    const els = {};
    const docListeners = {};
    const events = [];
    const mk = (id) => {
      const l = {};
      return (els[id] = els[id] || {
        id, hidden: id === "mg-setup" || id === "mg-llmset", textContent: "", innerHTML: "", className: "", value: "", open: false,
        addEventListener(t, f) { (l[t] = l[t] || []).push(f); },
        fire(t, e) { return Promise.all((l[t] || []).map((f) => f(Object.assign({ preventDefault() {}, target: this }, e || {})))); },
        querySelectorAll(sel) {
          if (sel === 'input[name="client"]') return [...this.innerHTML.matchAll(/value="([a-z-]+)"( checked)?/g)].filter((m) => /name="client"/.test(this.innerHTML)).map((m) => ({ value: m[1], checked: !!m[2] }));
          return [];
        },
        querySelector() { return null; }, scrollIntoView() {}, getAttribute: (k) => (k === "data-api" ? "/api/setup" : null),
      });
    };
    const cfgText = (await s.call("/")).text.match(/id="memglow-config">([^<]*)</)[1];
    mk("memglow-config").textContent = cfgText;
    const document = {
      getElementById: (id) => mk(id),
      addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
      dispatchEvent(e) { events.push(e.type); },
    };
    const sandbox = {
      document, console,
      window: { location: { origin: s.base, reload() { events.push("reload"); } } },
      CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
      fetch: (url, o) => fetch(s.base + url, { ...o, headers: { ...(o && o.headers), origin: s.base } }),
      setTimeout,
    };
    vm.runInNewContext(src, sandbox);
    const settle = () => new Promise((r) => setTimeout(r, 150));
    const waitFor = async (f) => { for (let i = 0; i < 60 && !f(); i++) await settle(); };
    await waitFor(() => els["mg-setup"].hidden === false && els["mg-setup-body"].innerHTML);
    assert.strictEqual(els["mg-setup"].hidden, false, "first run: the wizard opens by itself");
    assert.match(els["mg-setup-body"].innerHTML, /name="client" value="claude-code"/);
    assert.strictEqual(els["mg-setup-step"].textContent, "Step 1 of 3");
    els["mg-setup-body"].innerHTML = els["mg-setup-body"].innerHTML.replace('value="codex"', 'value="codex" checked');
    await els["mg-setup-next"].fire("click");
    await waitFor(() => els["mg-setup-step"].textContent === "Step 2 of 3");
    assert.deepStrictEqual((await s.call("/api/setup")).json.clients.chosen, ["codex"]);
    assert.strictEqual(els["mg-setup-step"].textContent, "Step 2 of 3");
    assert.match(els["mg-setup-body"].innerHTML, /name="mg-ai-on"/);
    await els["mg-setup-next"].fire("click");
    await waitFor(() => events.includes("memglow:zones-open"));
    assert.strictEqual(els["mg-setup"].hidden, true);
    assert.ok(events.includes("memglow:zones-open"), "step 3 = the Protected groups screen");
    assert.strictEqual((await s.call("/api/setup")).json.wizard.done, true);
    // AI settings opens from Settings.
    await els["mem-llmset"].fire("click");
    await waitFor(() => els["mg-llmset"].hidden === false && /tuning/.test(els["mg-llmset-body"].innerHTML));
    assert.strictEqual(els["mg-llmset"].hidden, false);
    assert.match(els["mg-llmset-body"].innerHTML, /mg-setup__tuning/);
  } finally { await s.stop(); }
});
