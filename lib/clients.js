"use strict";
/**
 * The AI tools a user works with ("clients"): chosen at first run (page) or by `memglow init`, and
 * readable by every part of memglow that adapts to them (the page's set-up instructions, the MCP
 * proxy's per-client levers). Zero dependencies, no HTTP: the MCP proxy copies this file.
 *
 * Where the choice lives, highest priority first:
 *   1. MEMGLOW_CLIENTS (comma-separated ids; written by `memglow init --docker` in .env)
 *   2. <dataDir>/setup.json → clients (saved from the page, lib/setup.js)
 *   3. memglow.config.json → clients
 * When none is set, the page pre-ticks what `memglow init` detected
 * (~/.memglow/install-manifest.json → detected).
 */
const fs = require("fs");
const path = require("path");

/**
 * kind: "hook" = memglow init installs a hook next to the tool (adapters/<id>);
 *       "mcp"  = no hook: the MCP proxy in front of its memory server reports the activity.
 */
const CLIENTS = [
  { id: "claude-code", label: "Claude Code", kind: "hook" },
  { id: "codex", label: "Codex", kind: "hook" },
  { id: "gemini", label: "Gemini CLI", kind: "hook" },
  { id: "cursor", label: "Cursor", kind: "hook" },
  { id: "windsurf", label: "Windsurf", kind: "hook" },
  { id: "copilot", label: "GitHub Copilot", kind: "hook" },
  { id: "cline", label: "Cline", kind: "hook" },
  { id: "chatgpt", label: "ChatGPT", kind: "mcp" },
  { id: "other-mcp", label: "Other MCP client", kind: "mcp" },
];
const IDS = CLIENTS.map((c) => c.id);

/** A list of client ids: known ids only, de-duplicated, in the reference order. null = not set. */
function cleanClients(v) {
  if (typeof v === "string") {
    if (!v.trim()) return null; // an empty variable (e.g. `MEMGLOW_CLIENTS=` in a compose file) = not set
    v = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(v)) return null;
  return IDS.filter((id) => v.includes(id));
}

/** What `memglow init` recorded (detected tools, hooks installed), or empty lists. */
function installed(memglowHome) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(memglowHome, "install-manifest.json"), "utf8"));
    return {
      detected: cleanClients(m.detected) || [],
      hooks: cleanClients((Array.isArray(m.files) ? m.files : []).map((f) => f && f.agent)) || [],
      chosen: cleanClients(m.clients),
    };
  } catch { return { detected: [], hooks: [], chosen: null }; }
}

/**
 * The clients in effect. → { clients: [ids] | null, source: "env" | "page" | "config" | "none" }.
 * `fileClients` = config.clients from memglow.config.json (already cleaned).
 */
function readClients(dataDir, fileClients, env = process.env) {
  const e = cleanClients(env.MEMGLOW_CLIENTS);
  if (e) return { clients: e, source: "env" };
  if (dataDir) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dataDir, "setup.json"), "utf8"));
      const c = s && cleanClients(s.clients);
      if (c) return { clients: c, source: "page" };
    } catch { /* absent or unreadable */ }
  }
  if (Array.isArray(fileClients)) return { clients: cleanClients(fileClients), source: "config" };
  return { clients: null, source: "none" };
}

module.exports = { CLIENTS, IDS, cleanClients, installed, readClients };
