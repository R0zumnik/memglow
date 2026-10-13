#!/usr/bin/env node
"use strict";
/**
 * Claude Code SessionStart hook for memglow: instead of a whole-index injection, this calls the
 * memory server's `memory_core` tool (lib/memory-core.js) with the session's own working folder
 * (and, best effort, its git remote) and prints the hook JSON a SessionStart hook is expected to
 * print — `hookSpecificOutput.additionalContext` — so the assistant starts with the matching
 * project hub(s) plus a tiny global index, instead of the whole memory index note.
 *
 * FAILS OPEN, ALWAYS: any problem at all — memory-server not running, bad/missing token, a
 * timeout, a malformed answer, an unexpected tool result shape, even an uncaught exception —
 * ends with this hook printing NOTHING and exiting 0. A session must never fail, or even look
 * different, just because this optional optimisation could not run; nothing here ever throws out
 * to the caller, and nothing here is more than a few seconds slower than not having it at all.
 *
 * Configuration (environment of the Claude Code session):
 *   MEMGLOW_MEMORY_URL     the memory server's base URL          (default http://127.0.0.1:8000)
 *   MEMGLOW_MEMORY_PATH    its MCP endpoint path                  (default /mcp)
 *   MEMGLOW_MEMORY_TOKEN   bearer token, or
 *   MEMGLOW_MEMORY_TOKEN_FILE  file holding it            (default ~/.config/memglow/token)
 *   MEMGLOW_MEMORY_CORE_BUDGET  budget_tokens passed to memory_core (default 1500)
 *   MEMGLOW_MEMORY_CORE_TIMEOUT_MS  hard timeout for the whole hook (default 2500)
 *
 * Usage (Claude Code settings.json):
 *   { "hooks": { "SessionStart": [ { "hooks": [
 *       { "type": "command", "command": "node /path/to/hooks/memglow-session-core.js" }
 *   ] } ] } }
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE = (process.env.MEMGLOW_MEMORY_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const MCP_PATH = process.env.MEMGLOW_MEMORY_PATH || "/mcp";
const TOKEN_FILE = process.env.MEMGLOW_MEMORY_TOKEN_FILE || path.join(os.homedir(), ".config", "memglow", "token");
const BUDGET = Number(process.env.MEMGLOW_MEMORY_CORE_BUDGET) > 0 ? Number(process.env.MEMGLOW_MEMORY_CORE_BUDGET) : 1500;
const HARD_TIMEOUT_MS = Number(process.env.MEMGLOW_MEMORY_CORE_TIMEOUT_MS) > 0 ? Number(process.env.MEMGLOW_MEMORY_CORE_TIMEOUT_MS) : 2500;
const FETCH_TIMEOUT_MS = Math.max(500, HARD_TIMEOUT_MS - 300);

function token() {
  if (process.env.MEMGLOW_MEMORY_TOKEN) return process.env.MEMGLOW_MEMORY_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}

/** Best-effort git remote / repo name for `cwd` — "" on anything but a clean, fast success. */
function gitHint(cwd) {
  try {
    const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 800, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
    return url;
  } catch { return ""; }
}

/** Reads all of stdin, with a short deadline — a SessionStart payload is small and closes fast;
 * no payload (or a slow/absent one) still resolves, with "". */
function readStdin(maxMs) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const t = setTimeout(() => finish(out), maxMs);
    if (t.unref) t.unref();
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => { out += d; });
      process.stdin.on("end", () => { clearTimeout(t); finish(out); });
      process.stdin.on("error", () => { clearTimeout(t); finish(out); });
      process.stdin.resume();
    } catch { clearTimeout(t); finish(out); }
  });
}

/** The server's answer body, JSON or SSE ("event: message\ndata: {...}\n\n") → the parsed JSON, or null. */
function parseBody(text, contentType) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (/event-stream/i.test(String(contentType || "")) || s.startsWith("event:")) {
    const m = /^data:\s*(.+)$/m.exec(s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  try { return JSON.parse(s); } catch { return null; }
}

async function callMemoryCore({ cwd, project }) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "memglow-session-core", method: "tools/call",
    params: { name: "memory_core", arguments: { cwd, project, budget_tokens: BUDGET, output_format: "text" } },
  });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const t = token();
  if (t) headers.authorization = "Bearer " + t;
  const res = await fetch(BASE + MCP_PATH, { method: "POST", headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) return null;
  const msg = parseBody(text, res.headers.get("content-type"));
  if (!msg || msg.error || !msg.result) return null;
  const content = msg.result.content;
  const item = Array.isArray(content) ? content.find((c) => c && c.type === "text" && typeof c.text === "string") : null;
  const out = item ? item.text : (typeof msg.result.structuredContent === "object" && msg.result.structuredContent && typeof msg.result.structuredContent.result === "string" ? msg.result.structuredContent.result : null);
  return typeof out === "string" && out.trim() ? out : null;
}

async function run() {
  const stdinRaw = await readStdin(300);
  let cwd = process.cwd();
  try { const payload = JSON.parse(stdinRaw); if (payload && typeof payload.cwd === "string" && payload.cwd.trim()) cwd = payload.cwd.trim(); } catch { /* keep process.cwd() */ }
  const remote = gitHint(cwd);
  const project = [remote, path.basename(cwd)].filter(Boolean);
  const additionalContext = await callMemoryCore({ cwd, project });
  if (!additionalContext) return; // fail open: print nothing
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }));
}

if (require.main === module) {
  let finished = false;
  const safety = setTimeout(() => { if (!finished) process.exit(0); }, HARD_TIMEOUT_MS);
  if (safety.unref) safety.unref();
  run().catch(() => { /* fail open: nothing printed */ }).finally(() => { finished = true; clearTimeout(safety); process.exit(0); });
}

module.exports = { parseBody, gitHint, readStdin, callMemoryCore };
