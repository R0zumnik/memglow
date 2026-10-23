"use strict";
// headersHelper (hooks/memglow-headers.js, 0.5.3): Claude Code's per-conversation
// CLAUDE_CODE_SESSION_ID → the `x-memglow-session` header, plus a bearer token when one is
// configured. FAILS OPEN, ALWAYS: never throws, always prints valid JSON, always exits 0.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { sessionId, token, headers } = require("../hooks/memglow-headers");

const HOOK = path.join(__dirname, "..", "hooks", "memglow-headers.js");

// `env` is the WHOLE environment the child gets (never merged with this process's own) — this
// test file runs inside a real Claude Code session, which sets CLAUDE_CODE_SESSION_ID on THIS
// process too; merging would leak it straight back in regardless of what the caller deleted.
function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end();
  });
}

// Spawned with a clean-ish env: never let a real ~/.config/memglow/token or MEMGLOW_MEMORY_TOKEN
// from the host leak into these assertions.
function cleanEnv(extra) {
  const base = { ...process.env };
  delete base.MEMGLOW_MEMORY_TOKEN;
  delete base.CLAUDE_CODE_SESSION_ID;
  base.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hdr-home-")); // no real token file here
  return { ...base, ...extra };
}

test("sessionId: a valid CLAUDE_CODE_SESSION_ID (UUID shape) is returned trimmed; missing/invalid is null", () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = "  a1b2c3d4-e5f6-47a8-9abc-1234567890ab  ";
    assert.strictEqual(sessionId(), "a1b2c3d4-e5f6-47a8-9abc-1234567890ab");
    process.env.CLAUDE_CODE_SESSION_ID = "short";
    assert.strictEqual(sessionId(), null, "under 8 characters");
    process.env.CLAUDE_CODE_SESSION_ID = "has a space!!";
    assert.strictEqual(sessionId(), null, "characters outside [A-Za-z0-9._:-]");
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.strictEqual(sessionId(), null, "not set at all");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
  }
});

test("token: MEMGLOW_MEMORY_TOKEN, trimmed, wins outright (never even looks at the token file)", () => {
  // TOKEN_FILE is resolved once, from the REAL os.homedir() of whatever process requires this
  // module — this process's own home may or may not have a real ~/.config/memglow/token (this
  // very repo's own doc says it typically does, on the NAS). So this unit test only checks the
  // one path that is independent of that: an env token always wins. The no-env / file-only /
  // neither cases are checked below, as subprocesses with HOME pointed at a throwaway folder.
  const savedEnv = process.env.MEMGLOW_MEMORY_TOKEN;
  try {
    process.env.MEMGLOW_MEMORY_TOKEN = "  env-token-xyz  ";
    assert.strictEqual(token(), "env-token-xyz", "trimmed");
  } finally {
    if (savedEnv === undefined) delete process.env.MEMGLOW_MEMORY_TOKEN; else process.env.MEMGLOW_MEMORY_TOKEN = savedEnv;
  }
});

test("headers: x-memglow-session alone; Authorization alone; both together (MEMGLOW_MEMORY_TOKEN always set explicitly here, so the real token file, if any, is never consulted)", () => {
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID, savedTok = process.env.MEMGLOW_MEMORY_TOKEN;
  try {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.MEMGLOW_MEMORY_TOKEN = "tok-123";
    assert.deepStrictEqual(headers(), { Authorization: "Bearer tok-123" }, "Authorization alone");
    process.env.CLAUDE_CODE_SESSION_ID = "a1b2c3d4-e5f6-47a8-9abc-1234567890ab";
    assert.deepStrictEqual(headers(), { "x-memglow-session": "a1b2c3d4-e5f6-47a8-9abc-1234567890ab", Authorization: "Bearer tok-123" }, "both together");
    // "x-memglow-session alone" (no Authorization at all) is checked below, as a subprocess with
    // HOME pointed at a throwaway folder — this process's own ~/.config/memglow/token, if any,
    // must never leak into this unit test's expectations.
  } finally {
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    if (savedTok === undefined) delete process.env.MEMGLOW_MEMORY_TOKEN; else process.env.MEMGLOW_MEMORY_TOKEN = savedTok;
  }
});

test("as a subprocess (what Claude Code's headersHelper actually spawns): prints JSON on stdout, exits 0", async () => {
  const r = await run(cleanEnv({ CLAUDE_CODE_SESSION_ID: "a1b2c3d4-e5f6-47a8-9abc-1234567890ab" }));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out), { "x-memglow-session": "a1b2c3d4-e5f6-47a8-9abc-1234567890ab" });
});

test("as a subprocess: with MEMGLOW_MEMORY_TOKEN set, both headers are printed", async () => {
  const r = await run(cleanEnv({ CLAUDE_CODE_SESSION_ID: "a1b2c3d4-e5f6-47a8-9abc-1234567890ab", MEMGLOW_MEMORY_TOKEN: "s3cr3t" }));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out), { "x-memglow-session": "a1b2c3d4-e5f6-47a8-9abc-1234567890ab", Authorization: "Bearer s3cr3t" });
});

test("as a subprocess: a token file at ~/.config/memglow/token is read and trimmed when there is no env token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hdr-home-"));
  try {
    fs.mkdirSync(path.join(home, ".config", "memglow"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "memglow", "token"), "  file-token-abc\n");
    const r = await run(cleanEnv({ HOME: home }));
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(JSON.parse(r.out), { Authorization: "Bearer file-token-abc" });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("as a subprocess: nothing configured at all prints {} and still exits 0 (fails open)", async () => {
  const r = await run(cleanEnv({}));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out), {});
});
