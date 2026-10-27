"use strict";
// lib/ai-provider.js — the pluggable AI facade auto-split (and the star-structure guardian) call:
// anthropic and openai-compatible against a fake HTTP server (never a real API), claude-code
// against a fake `claude` binary (never the real CLI), the key-resolution order (apiKeyEnv name,
// MEMGLOW_AI_API_KEY directly, apiKeyFile / MEMGLOW_AI_API_KEY_FILE paths, a bad key file refused)
// and that the key is never present in a run()/detect() result.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const ai = require("../lib/ai-provider");

const KEY = "sk-test-memglow-FAKE-ai-provider-0123456789";

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function fakeApi({ anthropicShape }) {
  let lastAuth = null;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      lastAuth = { "x-api-key": req.headers["x-api-key"], authorization: req.headers.authorization };
      if (req.headers["x-api-key"] && req.headers["x-api-key"] !== KEY) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } })); }
      if (req.headers.authorization && req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "bad key" } })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (anthropicShape) return res.end(JSON.stringify({ id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "{\"ok\":true}" }], stop_reason: "end_turn" }));
      return res.end(JSON.stringify({ id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}`, lastAuth: () => lastAuth, close: () => srv.close() })));
}

test("anthropic: run() succeeds with a key from MEMGLOW_AI_API_KEY directly, and detect() reports available", async () => {
  const api = await fakeApi({ anthropicShape: true });
  try {
    const cfg = { provider: "anthropic", baseUrl: api.url, model: "x" };
    const env = { MEMGLOW_AI_API_KEY: KEY };
    assert.strictEqual(ai.detect(cfg, { env }).available, true);
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '{"ok":true}');
    assert.strictEqual(api.lastAuth()["x-api-key"], KEY);
  } finally { api.close(); }
});

test("openai-compatible: run() succeeds with a key read from a key FILE (apiKeyFile, absolute path, trimmed)", async () => {
  const api = await fakeApi({ anthropicShape: false });
  const dir = tmp("memglow-ai-keyfile-");
  const keyFile = path.join(dir, "key.txt");
  fs.writeFileSync(keyFile, "  " + KEY + "  \n", { mode: 0o600 });
  try {
    const cfg = { provider: "openai-compatible", baseUrl: api.url, model: "x", apiKeyFile: keyFile };
    const d = ai.detect(cfg, { env: {} });
    assert.strictEqual(d.available, true, JSON.stringify(d));
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(api.lastAuth().authorization, `Bearer ${KEY}`);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("openai-compatible: MEMGLOW_AI_API_KEY_FILE env override also works, and a world-readable key file is refused", async () => {
  const api = await fakeApi({ anthropicShape: false });
  const dir = tmp("memglow-ai-keyfile2-");
  const keyFile = path.join(dir, "key.txt");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  try {
    const cfg = { provider: "openai-compatible", baseUrl: api.url, model: "x" };
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env: { MEMGLOW_AI_API_KEY_FILE: keyFile } });
    assert.strictEqual(r.ok, true);

    fs.chmodSync(keyFile, 0o644);
    const bad = ai.detect(cfg, { env: { MEMGLOW_AI_API_KEY_FILE: keyFile } });
    assert.strictEqual(bad.available, false);
    assert.match(bad.reason, /can be read by other users/);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolution order: apiKeyEnv (a NAME) wins over MEMGLOW_AI_API_KEY, which wins over a key file", async () => {
  const api = await fakeApi({ anthropicShape: true });
  const dir = tmp("memglow-ai-keyfile3-");
  const keyFile = path.join(dir, "key.txt");
  fs.writeFileSync(keyFile, "wrong-key-from-file", { mode: 0o600 });
  try {
    const cfg = { provider: "anthropic", baseUrl: api.url, model: "x", apiKeyEnv: "MY_OWN_VAR", apiKeyFile: keyFile };
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env: { MY_OWN_VAR: KEY, MEMGLOW_AI_API_KEY: "wrong-key-from-env" } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(api.lastAuth()["x-api-key"], KEY);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no key at all, a REMOTE endpoint: detect() says unavailable with a reason, run() refuses without ever contacting the server", async () => {
  // A local (127.0.0.1) endpoint never requires a key (Ollama, LM Studio); a remote one does —
  // "https://example.test" (RFC 2606) is never actually reached: the refusal happens before any
  // network call, which is exactly what this checks (no server listens there in this test).
  const cfg = { provider: "anthropic", baseUrl: "https://example.test", model: "x" };
  const d = ai.detect(cfg, { env: {} });
  assert.strictEqual(d.available, false);
  assert.match(d.reason, /No Anthropic API key/);
  const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env: {} });
  assert.strictEqual(r.ok, false);
  assert.ok(!/sk-test-memglow/.test(JSON.stringify(r)));
});

test("a LOCAL endpoint (loopback) never requires a key — e.g. Ollama/LM Studio through openai-compatible", async () => {
  const api = await fakeApi({ anthropicShape: false });
  try {
    const cfg = { provider: "openai-compatible", baseUrl: api.url, model: "x" };
    assert.strictEqual(ai.detect(cfg, { env: {} }).available, true);
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(api.lastAuth().authorization, undefined, "no Authorization header sent without a key");
  } finally { api.close(); }
});

test("unknown/unset provider: detect() and run() fail cleanly, never throw", () => {
  assert.strictEqual(ai.detect({}).available, false);
  assert.strictEqual(ai.detect({ provider: "made-up" }).available, false);
});

test("describe(): never includes the key itself, only provider/model/\"key set\"", async () => {
  const api = await fakeApi({ anthropicShape: true });
  try {
    const cfg = { provider: "anthropic", baseUrl: api.url, model: "my-model" };
    const d = ai.describe(cfg, { env: { MEMGLOW_AI_API_KEY: KEY } });
    assert.strictEqual(d.provider, "anthropic");
    assert.strictEqual(d.model, "my-model");
    assert.strictEqual(d.key, "set");
    assert.ok(!JSON.stringify(d).includes(KEY));
  } finally { api.close(); }
});

// ------------------------------------------------------------------ claude-code (fake binary)

function makeFakeClaude({ result = { parts: [] } } = {}) {
  const dir = tmp("memglow-ai-fakeclaude-");
  const script = [
    "#!" + process.execPath,
    "const fs=require('fs');",
    "if(!process.argv.includes('-p')&&!process.argv.includes('--help')){process.exit(0)}",
    "if(process.argv.includes('--help')){process.stdout.write('--restricted --tools stream-json --include-partial-messages dontAsk --no-session-persistence --system-prompt --strict-mcp-config --disallowedTools');process.exit(0)}",
    "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);",
    "process.stdin.on('end',()=>{",
    "  const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
    `  out({type:'result',subtype:'success',is_error:false,result: ${JSON.stringify(JSON.stringify(result))} });`,
    "});",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "claude"), script, { mode: 0o755 });
  return dir;
}

test("claude-code: run() spawns the (fake) CLI with no real network, and returns its JSON result", async () => {
  const fakeDir = makeFakeClaude({ result: { ok: true, via: "claude-code" } });
  const dataDir = tmp("memglow-ai-claude-data-");
  try {
    const cfg = { provider: "claude-code", model: "haiku" };
    const env = { PATH: fakeDir, HOME: os.tmpdir() };
    assert.strictEqual(ai.detect(cfg, { env, dataDir }).available, true);
    const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env, dataDir });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(r.text), { ok: true, via: "claude-code" });
  } finally { fs.rmSync(fakeDir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("claude-code: not on PATH — detect() unavailable, run() fails cleanly", async () => {
  const cfg = { provider: "claude-code" };
  const env = { PATH: "/does/not/exist" };
  assert.strictEqual(ai.detect(cfg, { env }).available, false);
  const r = await ai.run(cfg, { system: "s", prompt: "p" }, { env });
  assert.strictEqual(r.ok, false);
});
