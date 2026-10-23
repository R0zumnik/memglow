#!/usr/bin/env node
"use strict";
/**
 * Claude Code `headersHelper` for memglow (0.5.3) — prints the JSON object of HTTP headers
 * Claude Code then sends on EVERY MCP request to memglow's memory server for the rest of the
 * conversation, so a stateless MCP 2026-07-28 session (no `Mcp-Session-Id`: Claude Code opens a
 * new TCP connection between calls) is still recognised as the SAME session by
 * memory-server/http.js's sessionKeyFor() — without it, the per-session levers
 * (lib/proxy-levers.js: alreadyLoaded, dedupe, deltaRead…) never see a repeat and save 0 tokens.
 *
 * Claude Code runs a `headersHelper` command ONCE per conversation, reads its stdout as one JSON
 * object of headers, and sends those headers back on every request of that MCP server for the
 * rest of the session — setting, in THIS process's own environment: CLAUDE_CODE_SESSION_ID (a
 * UUID unique per conversation), plus CLAUDE_CODE_MCP_SERVER_NAME / CLAUDE_CODE_MCP_SERVER_URL
 * (not used here — the session id alone is enough to key a session). Claude Code sends no
 * session id of its own otherwise (only a `user-agent: claude-code/<ver>` and `_meta.clientInfo`).
 *
 * FAILS OPEN, ALWAYS (same rule as every other hook here): never throws, always prints valid
 * JSON on stdout (worst case `{}`), always exits 0 — a broken helper must never break the MCP
 * connection, and a session must never fail, or even look different, for want of this header.
 *
 * Configuration (environment of the Claude Code session):
 *   MEMGLOW_MEMORY_TOKEN   bearer token for the memory server, or
 *   ~/.config/memglow/token  file holding it (trimmed) — same file/variable every other memglow
 *                            hook here already reads (hooks/memglow-session-core.js)
 *
 * Usage (.claude.json / `claude mcp add`), on the memory server's MCP entry:
 *   { "mcpServers": { "memglow": { "type": "http", "url": "http://127.0.0.1:8000/mcp",
 *       "headersHelper": "node /path/to/hooks/memglow-headers.js" } } }
 * See README.md, "Session identity with Claude Code (headersHelper)".
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN_FILE = path.join(os.homedir(), ".config", "memglow", "token");
// Same validation as memory-server/http.js's validHeaderSid(): 8-128 characters of
// [A-Za-z0-9._:-] once trimmed — a UUID (CLAUDE_CODE_SESSION_ID's own shape) comfortably fits.
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** CLAUDE_CODE_SESSION_ID, validated — or null (missing, not a string, or the wrong shape). */
function sessionId() {
  const v = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return SESSION_ID_RE.test(s) ? s : null;
}

/** The bearer token (env first, else the token file, both trimmed) — or null. Never throws. */
function token() {
  try {
    const env = process.env.MEMGLOW_MEMORY_TOKEN;
    if (typeof env === "string" && env.trim()) return env.trim();
  } catch { /* fail open */ }
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return t || null;
  } catch { return null; }
}

/** The headers object this helper prints — {} when there is nothing to add. Never throws. */
function headers() {
  const out = {};
  try { const sid = sessionId(); if (sid) out["x-memglow-session"] = sid; } catch { /* fail open */ }
  try { const t = token(); if (t) out.Authorization = "Bearer " + t; } catch { /* fail open */ }
  return out;
}

if (require.main === module) {
  let out = "{}";
  try { out = JSON.stringify(headers()); } catch { out = "{}"; }
  try { process.stdout.write(out); } catch { /* nothing more we can do */ }
  process.exitCode = 0;
}

module.exports = { sessionId, token, headers, SESSION_ID_RE, TOKEN_FILE };
