"use strict";
// HTTP providers of the optional assistant (anthropic, openai-compatible). The "API" is ALWAYS a
// fake HTTP server on 127.0.0.1 started by this file: no real API is ever called, no real key used.
// Checked: request format (no tools), streaming and plain answers, HTTP errors, huge answers, tool
// calls, invalid JSON, redirects, the key never in a memglow response / log / error, key sources
// (env, mode-600 file; refused in the config file or in a readable file), https required off this
// machine, loopback without a key, and that only the requested note (secrets hidden) is sent.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const H = require("../lib/assistant/providers/http");
const anthropic = require("../lib/assistant/providers/anthropic");
const openai = require("../lib/assistant/providers/openai-compatible");
const providers = require("../lib/assistant/providers");

// A fake key, never a real one. Long and distinctive so any leak is found by a plain search.
const KEY = "sk-test-memglow-FAKE-0123456789abcdefFAKEKEY";

const FILLER = Array.from({ length: 12 }, (_, i) => `Line ${i} of filler text that makes this note larger than the threshold.`).join("\n");
const BIG = `---\ntitle: Big note\ntheme: projects\nsubtheme: alpha\n---\nIntro line about the big note.\n\n## Section A\nKeep this line please.\n${FILLER}\napi_password: hunter2hunter2hunter2\n\n## Section B\nMore about B.\n${FILLER.replace(/Line/g, "Row")}\nSee [[linker]].\n`;
const LINKER = "---\ntheme: knowledge\n---\nDetails are in [[big]].\n";
const OTHER = "---\ntheme: knowledge\n---\nUnrelated private text from another note.\n";

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** The proposal a cooperative model would answer, built from the <note> of the prompt. */
function proposalFor(prompt) {
  const m = /<note>\n([\s\S]*?)\n<\/note>/.exec(prompt);
  const id = /Note id: (\S+)/.exec(prompt)[1];
  const lines = (m ? m[1] : "").split("\n");
  const cut = lines.findIndex((l, i) => i > 0 && /^## /.test(l) && lines.slice(0, i).some((x) => /^## /.test(x)));
  return JSON.stringify({
    summary: `Short summary of ${id}.\n\n- [[${id}-part-1]]\n- [[${id}-part-2]]`,
    parts: [
      { title: "Part 1", file: `${id}-part-1.md`, content: lines.slice(0, cut).join("\n") },
      { title: "Part 2", file: `${id}-part-2.md`, content: lines.slice(cut).join("\n") },
    ],
    linkUpdates: [],
    notes: "Split in two.",
  });
}

// ------------------------------------------------------------------ fake API server

function fakeApi() {
  const calls = [];
  let mode = "ok";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as is */ }
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
      const anth = req.url.endsWith("/v1/messages");
      const prompt = body ? (anth ? body.messages[0].content : body.messages[1].content) : "";
      const sse = (events) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const e of events) res.write((e.event ? `event: ${e.event}\n` : "") + `data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
        res.end();
      };
      const errJson = (status, message, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(anth ? { type: "error", error: { type: "some_error", message } } : { error: { message, type: "some_error" } }));
      };
      const chunks = (t) => { const out = []; for (let i = 0; i < t.length; i += 40) out.push(t.slice(i, i + 40)); return out; };
      const answer = mode === "badjson" ? "Sure! I would split it in two parts. (no JSON)" : body ? proposalFor(prompt) : "";
      switch (mode) {
        case "401": return errJson(401, "Incorrect API key provided: " + KEY.slice(0, 12) + "***");
        case "429": return errJson(429, "rate limited", { "Retry-After": "7" });
        case "500": return errJson(500, "boom");
        case "echo": return errJson(400, "bad request for key " + KEY);
        case "redirect": res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" }); return res.end();
        case "hang": res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": hi\n\n"); return; // never ends
        case "huge": {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const line = "data: " + JSON.stringify(anth ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(60000) } } : { choices: [{ index: 0, delta: { content: "x".repeat(60000) } }] }) + "\n\n";
          let n = 0;
          const pump = () => { while (n < 120) { n++; if (!res.write(line)) return res.once("drain", pump); } res.end(); };
          res.on("error", () => {});
          return pump();
        }
        default: break;
      }
      if (anth) {
        if (mode === "json") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: answer }], stop_reason: "end_turn" }));
        }
        const ev = [
          { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } } },
          { event: "ping", data: { type: "ping" } },
        ];
        if (mode === "tool") {
          ev.push({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "write_file", input: {} } } });
          ev.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" } } });
        } else if (mode === "midstream-error") {
          ev.push({ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
        } else {
          ev.push({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
          for (const c of chunks(answer)) ev.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } } });
          ev.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
          ev.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: mode === "cut" ? "max_tokens" : "end_turn" } } });
        }
        ev.push({ event: "message_stop", data: { type: "message_stop" } });
        return sse(ev);
      }
      // OpenAI-compatible
      if (mode === "json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] }));
      }
      const ev = [];
      if (mode === "tool") {
        ev.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "write_file", arguments: "{}" } }] } }] } });
        ev.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } });
      } else {
        ev.push({ data: { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] } });
        for (const c of chunks(answer)) ev.push({ data: { choices: [{ index: 0, delta: { content: c } }] } });
        ev.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: mode === "cut" ? "length" : "stop" }] } });
      }
      ev.push({ data: "[DONE]" });
      return sse(ev);
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({
    srv, calls, url: `http://127.0.0.1:${srv.address().port}`,
    setMode(m) { mode = m; },
    close() { srv.closeAllConnections && srv.closeAllConnections(); srv.close(); },
  })));
}

// ------------------------------------------------------------------ memglow under test

/** Everything memglow prints while a test runs (to check the key never appears). */
function captureLogs() {
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { out.push(a.map(String).join(" ")); };
  return { out, restore() { Object.assign(console, orig); } };
}

async function start({ assistant, env = {}, keyFile } = {}) {
  const dir = tmp("memglow-http-mem-");
  fs.writeFileSync(path.join(dir, "big.md"), BIG);
  fs.writeFileSync(path.join(dir, "linker.md"), LINKER);
  fs.writeFileSync(path.join(dir, "other.md"), OTHER);
  const dataDir = tmp("memglow-http-data-");
  if (keyFile) fs.writeFileSync(path.join(dataDir, "assistant-api-key"), keyFile.content, { mode: keyFile.mode });
  if (keyFile) fs.chmodSync(path.join(dataDir, "assistant-api-key"), keyFile.mode);
  const cfgFile = path.join(tmp("memglow-http-cfg-"), "memglow.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ assistant: { enabled: true, ...assistant } }));
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_CONFIG: cfgFile, MEMGLOW_LARGE_NOTE_TOKENS: "200" }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: tmp("memglow-nopath-"), HOME: os.tmpdir(), ...env } });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const responses = [];
  return { server, dir, dataDir, config, port: server.address().port, responses, close() { server.closeAllConnections && server.closeAllConnections(); server.close(); } };
}

function req(s, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const r = http.request({ host: "127.0.0.1", port: s.port, path: pathname, method, headers: { Host: `127.0.0.1:${s.port}`, ...headers }, setHost: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        s.responses.push(JSON.stringify(res.headers) + "\n" + b);
        let j = null; try { j = JSON.parse(b); } catch { /* text */ }
        ok({ status: res.statusCode, body: b, json: j });
      });
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const write = (s) => ({ "Content-Type": "application/json", "X-Memglow": "1", Origin: `http://127.0.0.1:${s.port}` });
const post = (s, action, body) => req(s, "/api/assistant/" + action, { method: "POST", headers: write(s), body: body || {} });
async function settle(s, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const st = (await req(s, "/api/assistant")).json;
    if (st.job && st.job.state !== "running" && st.job.state !== "applying") return st;
    if (Date.now() - t0 > ms) throw new Error("job still running");
    await new Promise((r) => setTimeout(r, 40));
  }
}
const noKey = (where, text) => assert.ok(!String(text).includes(KEY) && !String(text).includes(KEY.slice(8)), "the key leaked in " + where);

/** One full run: memglow + fake API in `mode`; returns the settled status, the calls, logs. */
async function runOnce({ provider, mode = "ok", assistant = {}, env = { MEMGLOW_ASSISTANT_API_KEY: KEY }, keyFile, pick } = {}) {
  const api = await fakeApi();
  api.setMode(mode);
  const base = provider === "anthropic" ? { baseUrl: api.url } : { baseUrl: api.url + "/v1", model: "test-model" };
  const logs = captureLogs();
  const s = await start({ assistant: { provider, ...base, ...assistant }, env, keyFile });
  try {
    const st0 = (await req(s, "/api/assistant")).json;
    const r = await post(s, "propose", { note: "big", ...(pick ? { provider: pick } : {}) });
    const st = r.status === 200 ? await settle(s) : null;
    // The page, the static script and the stream must not carry the key either.
    await req(s, "/");
    return { s, api, st0, r, st, logs: logs.out };
  } finally {
    logs.restore();
    s.close();
    api.close();
  }
}
function noLeak({ s, logs, st }) {
  for (const b of s.responses) noKey("an HTTP response of memglow", b);
  noKey("memglow's logs", logs.join("\n"));
  if (st && st.job) noKey("the job error", JSON.stringify(st.job));
}

// ------------------------------------------------------------------ unit

test("http: endpoint — https required off this machine, loopback http allowed, no credentials", () => {
  assert.strictEqual(H.endpoint("https://api.example.com/v1/").url, "https://api.example.com/v1");
  assert.strictEqual(H.endpoint("https://api.example.com/v1").local, false);
  for (const u of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:8080", "http://127.5.6.7/x"]) {
    const e = H.endpoint(u);
    assert.ok(e.ok && e.local, u);
  }
  for (const u of ["http://api.example.com/v1", "http://192.168.0.10:11434/v1", "http://10.0.0.2/v1", "http://host.docker.internal:11434/v1", "http://127.0.0.1.example.com/v1"]) {
    const e = H.endpoint(u);
    assert.ok(!e.ok && /requires https/.test(e.reason), u);
  }
  assert.ok(!H.endpoint("https://user:pw@api.example.com").ok);
  assert.ok(!H.endpoint("ftp://api.example.com").ok);
  assert.ok(!H.endpoint("file:///etc/passwd").ok);
  assert.ok(!H.endpoint("not a url").ok);
  assert.ok(!H.endpoint("https://api.example.com/v1?key=x").ok);
});

test("http: key sources — env (default or named), mode-600 file; readable file refused", () => {
  const d = tmp("memglow-key-");
  assert.deepStrictEqual(H.apiKey({ env: {}, dataDir: d }), { key: "", source: "" });
  assert.strictEqual(H.apiKey({ env: { MEMGLOW_ASSISTANT_API_KEY: " " + KEY + "\n" }, dataDir: d }).key, KEY);
  assert.strictEqual(H.apiKey({ config: { apiKeyEnv: "MY_KEY" }, env: { MY_KEY: KEY, MEMGLOW_ASSISTANT_API_KEY: "other" }, dataDir: d }).key, KEY);
  const bad = H.apiKey({ config: { apiKeyEnv: KEY }, env: {}, dataDir: d });
  assert.ok(bad.error && !bad.error.includes(KEY), "a key put in apiKeyEnv is refused without echoing it");
  const f = path.join(d, "assistant-api-key");
  fs.writeFileSync(f, KEY + "\n", { mode: 0o600 }); fs.chmodSync(f, 0o600);
  assert.deepStrictEqual(H.apiKey({ env: {}, dataDir: d }), { key: KEY, source: "file" });
  if (process.platform !== "win32") {
    for (const mode of [0o644, 0o640, 0o604]) {
      fs.chmodSync(f, mode);
      const r = H.apiKey({ env: {}, dataDir: d });
      assert.strictEqual(r.key, "", mode.toString(8));
      assert.match(r.error, /chmod 600/);
      noKey("the file-mode error", r.error);
    }
    fs.chmodSync(f, 0o600);
    fs.symlinkSync(f, path.join(d, "link-key"));
    assert.ok(H.apiKey({ config: { apiKeyFile: "link-key" }, env: {}, dataDir: d }).error, "a link is refused");
  }
  assert.ok(H.apiKey({ config: { apiKeyFile: "../etc/passwd" }, env: {}, dataDir: d }).error, "only a plain name in the data folder");
});

test("http: redact never lets the key (or key-shaped text) through", () => {
  const m = H.redact("Incorrect API key provided: " + KEY + " / Bearer abcdefghij / sk-proj-ABCDEF123456", KEY);
  noKey("redact", m);
  assert.ok(!/sk-proj-ABCDEF/.test(m) && !/abcdefghij/.test(m));
});

test("http: SSE parser handles split chunks, CRLF, comments, multi-line data", () => {
  const p = H.createSse();
  assert.deepStrictEqual(p.push(": ping\n\nevent: a\nda"), []);
  assert.deepStrictEqual(p.push("ta: 1\r\ndata: 2\r\n\r\n"), [{ event: "a", data: "1\n2" }]);
  assert.deepStrictEqual(p.push("data: [DONE]"), []);
  assert.deepStrictEqual(p.end(), [{ event: "message", data: "[DONE]" }]);
});

test("providers: settings per provider, presets, panel info never holds the key", () => {
  const ac = { provider: "anthropic", model: "claude-x", sections: { "openai-compatible": { preset: "ollama", model: "llama3.1" } } };
  assert.strictEqual(providers.configFor(ac, "anthropic").model, "claude-x");
  assert.strictEqual(providers.configFor(ac, "openai-compatible").model, "llama3.1");
  assert.strictEqual(providers.configFor(ac, "claude-code").model, undefined, "top-level model only for the default provider");
  const ctx = (id) => ({ config: providers.configFor(ac, id), env: { MEMGLOW_ASSISTANT_API_KEY: KEY }, dataDir: tmp("memglow-p-") });
  const rows = providers.list(ctx);
  noKey("the provider list", JSON.stringify(rows));
  const a = rows.find((r) => r.id === "anthropic");
  assert.deepStrictEqual([a.destination, a.local, a.key, a.available], ["api.anthropic.com", false, "set", true]);
  const o = rows.find((r) => r.id === "openai-compatible");
  assert.deepStrictEqual([o.destination, o.local, o.available], ["127.0.0.1:11434", true, true]);
  assert.deepStrictEqual(Object.keys(openai.PRESETS).sort(), ["lmstudio", "mistral", "ollama", "openai", "openrouter"]);
  assert.strictEqual(openai.PRESETS.ollama, "http://127.0.0.1:11434/v1");
  assert.strictEqual(openai.PRESETS.lmstudio, "http://127.0.0.1:1234/v1");
  // Remote without a key: not ready, says what to do.
  const r = anthropic.detect({ config: {}, env: {}, dataDir: tmp("memglow-p-") });
  assert.ok(!r.available && /MEMGLOW_ASSISTANT_API_KEY/.test(r.reason));
  const m = openai.detect({ config: { baseUrl: "https://api.mistral.ai/v1" }, env: { MEMGLOW_ASSISTANT_API_KEY: KEY } });
  assert.ok(!m.available && /assistant\.model/.test(m.reason));
});

test("config: an API key in memglow.config.json is refused (field named, value never shown)", async () => {
  for (const assistant of [{ provider: "anthropic", apiKey: KEY }, { provider: "openai-compatible", "openai-compatible": { api_key: KEY } }]) {
    const logs = captureLogs();
    const s = await start({ assistant, env: { MEMGLOW_ASSISTANT_API_KEY: KEY } });
    try {
      const st = (await req(s, "/api/assistant")).json;
      assert.strictEqual(st.available, false);
      assert.match(st.reason, /Refused: memglow\.config\.json contains assistant\.(openai-compatible\.)?api_?[kK]ey/);
      const r = await post(s, "propose", { note: "big" });
      assert.strictEqual(r.status, 503);
      assert.match(r.json.error, /Refused/);
      noKey("the config refusal", r.body + JSON.stringify(st) + JSON.stringify(s.config.assistant.keyInConfig));
    } finally { logs.restore(); s.close(); }
    noKey("logs", logs.out.join("\n"));
  }
});

// ------------------------------------------------------------------ anthropic, end to end

test("anthropic: streamed proposal — request format, no tools, key only in x-api-key, only the note sent", async () => {
  const run = await runOnce({ provider: "anthropic" });
  const { st, api, st0 } = run;
  assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job));
  assert.strictEqual(st.job.provider, "anthropic");
  assert.ok(st.job.chars > 100, "streamed progress counted");
  const [c] = api.calls;
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(c.method, "POST");
  assert.strictEqual(c.url, "/v1/messages");
  assert.strictEqual(c.headers["x-api-key"], KEY);
  assert.strictEqual(c.headers["anthropic-version"], "2023-06-01");
  assert.strictEqual(c.headers.authorization, undefined);
  assert.deepStrictEqual(Object.keys(c.body).sort(), ["max_tokens", "messages", "model", "stream", "system"]);
  assert.ok(!("tools" in c.body) && !("tool_choice" in c.body), "no tool declared");
  assert.strictEqual(c.body.model, anthropic.DEFAULT_MODEL);
  assert.strictEqual(c.body.stream, true);
  assert.strictEqual(c.body.messages.length, 1);
  assert.match(c.body.system, /You have NO tools/);
  noKey("the request body", c.raw);
  // Only the requested note: its lines yes, its secret no, other notes' bodies no.
  const prompt = c.body.messages[0].content;
  assert.ok(prompt.includes("Intro line about the big note") && prompt.includes("Keep this line please."));
  assert.ok(!c.raw.includes("hunter2"), "secret-looking line never sent");
  assert.ok(prompt.includes("⟦memglow-secret-1⟧"));
  assert.ok(!c.raw.includes("Unrelated private text"), "another note's body is never sent");
  assert.ok(st0.providers.find((p) => p.id === "anthropic").key === "set");
  noLeak(run);
});

test("anthropic: a non-streamed JSON answer works too; a cut-off answer fails", async () => {
  const a = await runOnce({ provider: "anthropic", mode: "json" });
  assert.strictEqual(a.st.job.state, "proposed", JSON.stringify(a.st.job));
  const b = await runOnce({ provider: "anthropic", mode: "cut" });
  assert.strictEqual(b.st.job.state, "failed");
  assert.match(b.st.job.error, /max_tokens/);
});

test("anthropic: 401, 429, 500, mid-stream error, redirect — clean messages, never the key", async () => {
  const want = { 401: /key was refused.*HTTP 401/, 429: /HTTP 429.*retry in 7 s/, 500: /server error \(HTTP 500\)/, "midstream-error": /overloaded_error/, redirect: /redirect.*does not follow/, echo: /HTTP 400/ };
  for (const [mode, re] of Object.entries(want)) {
    const run = await runOnce({ provider: "anthropic", mode });
    assert.strictEqual(run.st.job.state, "failed", mode);
    assert.match(run.st.job.error, re, mode);
    noLeak(run);
    assert.ok(!fs.existsSync(path.join(run.s.dir, "big-part-1.md")), "nothing written");
  }
});

test("anthropic: tool call, invalid JSON, huge answer are refused", async () => {
  const t = await runOnce({ provider: "anthropic", mode: "tool" });
  assert.strictEqual(t.st.job.state, "failed");
  assert.match(t.st.job.error, /tried to use a tool/);
  const j = await runOnce({ provider: "anthropic", mode: "badjson" });
  assert.strictEqual(j.st.job.state, "invalid");
  assert.match(j.st.job.errors[0], /not a JSON object/);
  const h = await runOnce({ provider: "anthropic", mode: "huge" });
  assert.strictEqual(h.st.job.state, "failed");
  assert.match(h.st.job.error, /too large/);
  for (const r of [t, j, h]) noLeak(r);
});

test("anthropic: key from a mode-600 file works; a readable file is refused before any request", async () => {
  if (process.platform === "win32") return;
  const ok = await runOnce({ provider: "anthropic", env: {}, keyFile: { content: KEY + "\n", mode: 0o600 } });
  assert.strictEqual(ok.st.job.state, "proposed");
  assert.strictEqual(ok.api.calls[0].headers["x-api-key"], KEY);
  noLeak(ok);
  const bad = await runOnce({ provider: "anthropic", env: {}, keyFile: { content: KEY + "\n", mode: 0o644 } });
  assert.strictEqual(bad.r.status, 503);
  assert.match(bad.r.json.error, /chmod 600/);
  assert.strictEqual(bad.api.calls.length, 0, "no request sent");
  noLeak(bad);
});

test("anthropic: cancel stops a hanging request", async () => {
  const api = await fakeApi();
  api.setMode("hang");
  const s = await start({ assistant: { provider: "anthropic", baseUrl: api.url }, env: { MEMGLOW_ASSISTANT_API_KEY: KEY } });
  try {
    const r = await post(s, "propose", { note: "big" });
    for (let i = 0; i < 100 && !api.calls.length; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.strictEqual((await post(s, "cancel", { job: r.json.job.id })).status, 200);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "cancelled");
  } finally { s.close(); api.close(); }
});

// ------------------------------------------------------------------ openai-compatible, end to end

test("openai-compatible: streamed proposal — Bearer key, no tools, system + user messages", async () => {
  const run = await runOnce({ provider: "openai-compatible", assistant: { maxTokens: 9000 } });
  const { st, api } = run;
  assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job));
  const [c] = api.calls;
  assert.strictEqual(c.url, "/v1/chat/completions");
  assert.strictEqual(c.headers.authorization, "Bearer " + KEY);
  assert.strictEqual(c.headers["x-api-key"], undefined);
  assert.deepStrictEqual(Object.keys(c.body).sort(), ["max_tokens", "messages", "model", "stream"]);
  assert.ok(!("tools" in c.body) && !("functions" in c.body) && !("tool_choice" in c.body));
  assert.strictEqual(c.body.model, "test-model");
  assert.strictEqual(c.body.max_tokens, 9000);
  assert.deepStrictEqual(c.body.messages.map((m) => m.role), ["system", "user"]);
  assert.ok(!c.raw.includes("hunter2") && !c.raw.includes("Unrelated private text"));
  noLeak(run);
});

test("openai-compatible: loopback (Ollama / LM Studio style) works with no key — no Authorization header", async () => {
  const run = await runOnce({ provider: "openai-compatible", env: {} });
  assert.strictEqual(run.st.job.state, "proposed", JSON.stringify(run.st.job));
  assert.strictEqual(run.api.calls[0].headers.authorization, undefined);
  const row = run.st0.providers.find((p) => p.id === "openai-compatible");
  assert.deepStrictEqual([row.local, row.key, row.available], [true, "not needed", true]);
  assert.ok(!("max_tokens" in run.api.calls[0].body), "no max_tokens unless configured");
});

test("openai-compatible: plain JSON answer, tool call, cut-off, errors, huge answer", async () => {
  assert.strictEqual((await runOnce({ provider: "openai-compatible", mode: "json" })).st.job.state, "proposed");
  const cases = { tool: /tried to use a tool/, cut: /cut off/, 401: /HTTP 401/, 429: /HTTP 429/, 500: /HTTP 500/, huge: /too large/, echo: /HTTP 400/ };
  for (const [mode, re] of Object.entries(cases)) {
    const run = await runOnce({ provider: "openai-compatible", mode });
    assert.strictEqual(run.st.job.state, "failed", mode);
    assert.match(run.st.job.error, re, mode);
    noLeak(run);
  }
  const bad = await runOnce({ provider: "openai-compatible", mode: "badjson" });
  assert.strictEqual(bad.st.job.state, "invalid");
});

test("openai-compatible: remote http:// is refused, nothing sent; remote https without a key is not ready", async () => {
  const s = await start({ assistant: { provider: "openai-compatible", baseUrl: "http://api.example.com/v1", model: "m" }, env: { MEMGLOW_ASSISTANT_API_KEY: KEY } });
  try {
    const st = (await req(s, "/api/assistant")).json;
    assert.strictEqual(st.available, false);
    assert.match(st.reason, /requires https/);
    assert.strictEqual((await post(s, "propose", { note: "big" })).status, 503);
  } finally { s.close(); }
  const s2 = await start({ assistant: { provider: "openai-compatible", preset: "mistral", model: "mistral-large-latest" } });
  try {
    const st = (await req(s2, "/api/assistant")).json;
    assert.strictEqual(st.available, false);
    const row = st.providers.find((p) => p.id === "openai-compatible");
    assert.deepStrictEqual([row.destination, row.local, row.key], ["api.mistral.ai", false, "not set"]);
  } finally { s2.close(); }
});

test("panel: provider picked per request; unknown or unsupported one refused", async () => {
  const api = await fakeApi();
  // Default claude-code (not installed here), but an Ollama-style provider configured in its section.
  const s = await start({ assistant: { provider: "claude-code", "openai-compatible": { baseUrl: api.url + "/v1", model: "llama3.1" } } });
  try {
    assert.strictEqual((await post(s, "propose", { note: "big", provider: "nope" })).status, 400);
    assert.strictEqual((await post(s, "propose", { note: "big", provider: "codex" })).status, 503);
    assert.strictEqual((await post(s, "propose", { note: "big" })).status, 503, "the default (claude-code) is not installed");
    const r = await post(s, "propose", { note: "big", provider: "openai-compatible" });
    assert.strictEqual(r.status, 200, r.body);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed");
    assert.strictEqual(st.job.provider, "openai-compatible");
    assert.strictEqual(api.calls[0].body.model, "llama3.1");
  } finally { s.close(); api.close(); }
});

test("panel: says where the note goes before Propose (local vs remote host), never a key", () => {
  const ui = require("../public/assistant.js");
  const list = [
    { id: "claude-code", label: "Claude Code (your CLI)", kind: "cli", implemented: true, available: true },
    { id: "anthropic", label: "Anthropic API (your key)", kind: "http", implemented: true, available: true, destination: "api.anthropic.com", local: false, key: "set", model: "claude-sonnet-5-5" },
    { id: "openai-compatible", label: "OpenAI-compatible", kind: "http", implemented: true, available: true, destination: "127.0.0.1:11434", local: true, key: "not needed", model: "llama3.1" },
  ];
  const remote = ui.aiAskForm("big", "Big", list, "anthropic");
  assert.match(remote, /Your note will be sent to <strong>api\.anthropic\.com<\/strong>/);
  assert.match(remote, /data-provider="anthropic"/);
  assert.match(remote, /<select id="mg-ai-provider">/);
  assert.match(ui.aiAskForm("big", "Big", list, "openai-compatible"), /Local model — nothing leaves your machine/);
  assert.match(ui.aiAskForm("big", "Big", [list[0]], "claude-code"), /through your Claude Code/);
  const evil = { ...list[1], destination: "<img src=x>", model: "<b>" };
  assert.ok(!ui.aiDestination(evil).includes("<img") && !ui.aiRenderProviders([evil], "anthropic").includes("<img"));
  assert.match(ui.aiRenderProviders(list, "anthropic"), /key: set/);
});
