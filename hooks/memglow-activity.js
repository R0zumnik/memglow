#!/usr/bin/env node
"use strict";
/**
 * Claude Code PostToolUse hook for memglow: tells the viewer that the assistant just READ,
 * SEARCHED or WROTE a memory note, so the matching neuron lights up live.
 *
 * - Never blocks the session: it detaches a sender process and returns at once; the sender
 *   gives up after 3 s; nothing is ever printed.
 * - Sends note ids only (the server re-checks them against existing notes), never content.
 *
 * Configuration (environment of the Claude Code session):
 *   MEMGLOW_URL          viewer base URL                   (default http://127.0.0.1:4747)
 *   MEMGLOW_TOKEN        same value as the server's MEMGLOW_TOKEN, or
 *   MEMGLOW_TOKEN_FILE   file holding it                   (default ~/.memglow/token, mode 600)
 *   MEMGLOW_MEMORY_DIR   folder whose .md files count for Read/Write/Edit (optional)
 *   MEMGLOW_MCP_PREFIX   MCP tool prefix of the memory server (default mcp__basic-memory__)
 *   MEMGLOW_SOURCE       label shown in the journal         (default "claude")
 *   MEMGLOW_MACHINE      short label for this machine in the journal (default: short hostname)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const BASE = (process.env.MEMGLOW_URL || "http://127.0.0.1:4747").replace(/\/+$/, "");
const TOKEN_FILE = process.env.MEMGLOW_TOKEN_FILE || path.join(os.homedir(), ".memglow", "token");
const MEMORY_DIR = process.env.MEMGLOW_MEMORY_DIR ? path.resolve(process.env.MEMGLOW_MEMORY_DIR) + path.sep : null;
const PREFIX = process.env.MEMGLOW_MCP_PREFIX || "mcp__basic-memory__";
const SOURCE = /^[a-z0-9-]{1,20}$/.test(process.env.MEMGLOW_SOURCE || "") ? process.env.MEMGLOW_SOURCE : "claude";

// Same rule the server validates again (lib/memory.js): closed charset, 32 characters at most,
// never a path. Falls back to "host" when even the short hostname cannot be made to fit.
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
function machineName() {
  const raw = process.env.MEMGLOW_MACHINE || (() => { try { return os.hostname().split(".")[0]; } catch { return ""; } })();
  if (MACHINE_RE.test(raw)) return raw;
  const cleaned = String(raw).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  return MACHINE_RE.test(cleaned) ? cleaned : "host";
}

const READ = new Set(["read_note", "view_note", "build_context", "fetch", "read_content"]);
const SEARCH = new Set(["search_notes", "search", "recent_activity"]);
const WRITE = new Set(["write_note", "edit_note", "move_note", "delete_note"]);

function token() {
  if (process.env.MEMGLOW_TOKEN) return process.env.MEMGLOW_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}

if (process.argv[2] === "--send") {
  (async () => {
    try {
      await fetch(BASE + "/api/activity", {
        method: "POST",
        headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
        body: Buffer.from(process.argv[3] || "", "base64").toString("utf8"),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* silent: a lost activity does not matter */ }
  })();
  return;
}

/** Note ids quoted in a text (search results, build_context…): permalinks, memory:// URLs, *.md */
function idsInText(text) {
  const out = [];
  const re = /(?:memory:\/\/|permalink["']?\s*[:=]\s*["']?|\b)([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_-]+\.md)\b/g;
  for (const m of String(text).matchAll(re)) out.push(m[1]);
  return out;
}

/** Hook input → { type, ids } or null. Exported for tests. */
function analyse(e) {
  const tool = String(e.tool_name || "");
  const input = e.tool_input || {};
  if (tool.startsWith(PREFIX)) {
    const name = tool.slice(PREFIX.length);
    const type = READ.has(name) ? "read" : SEARCH.has(name) ? "search" : WRITE.has(name) ? "write" : null;
    if (!type) return null;
    const quoted = [input.identifier, input.url, input.id, input.permalink, input.title, input.destination_path]
      .filter((v) => typeof v === "string" && v).map((v) => v.replace(/^memory:\/\//, ""));
    let reply = e.tool_response;
    if (reply && typeof reply !== "string") { try { reply = JSON.stringify(reply); } catch { reply = ""; } }
    const found = idsInText((reply || "").slice(0, 200000));
    return { type, ids: type === "search" ? found.concat(quoted) : quoted.concat(found) };
  }
  if (!MEMORY_DIR) return null;
  const file = String(input.file_path || "");
  if (!file.startsWith(MEMORY_DIR) || !file.endsWith(".md")) return null;
  const type = tool === "Read" ? "read" : tool === "Write" || tool === "Edit" ? "write" : null;
  return type ? { type, ids: [file] } : null;
}

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const a = analyse(JSON.parse(raw));
      if (!a) return;
      const ids = [...new Set(a.ids.map((s) => String(s).split("/").pop().replace(/\.md$/i, "")).filter(Boolean))].slice(0, 50);
      if (!ids.length || !token()) return;
      const payload = Buffer.from(JSON.stringify({ type: a.type, ids, source: SOURCE, channel: "hook", machine: machineName() })).toString("base64");
      spawn(process.execPath, [__filename, "--send", payload], { detached: true, stdio: "ignore" }).unref();
    } catch { /* never an error in the session */ }
  });
}

module.exports = { analyse, idsInText, machineName };
