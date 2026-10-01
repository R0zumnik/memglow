"use strict";
/**
 * Shared core of every memglow agent adapter (Claude Code, Cursor, Codex, Gemini CLI, Windsurf,
 * GitHub Copilot, Cline) and of the MCP proxy.
 *
 * An adapter only translates its agent's hook payload into one of two neutral shapes:
 *   { kind: "file", op: "read"|"write", path }                 a file tool touched a note
 *   { kind: "mcp", server, tool, args, result }                an MCP tool was called
 * and hands it to `report()`, which classifies it, keeps note ids only (never content) and sends
 * the event to the viewer in a detached process that gives up after 3 s. Nothing is printed and
 * nothing ever throws: a lost event must never disturb the agent.
 *
 * Settings (environment of the agent, else ~/.memglow/memglow.config.json written by `memglow init`):
 *   MEMGLOW_URL          viewer URL                                (default http://127.0.0.1:4747)
 *   MEMGLOW_TOKEN        activity token, or
 *   MEMGLOW_TOKEN_FILE   file holding it                           (default ~/.memglow/token)
 *   MEMGLOW_MEMORY_DIR   notes folder: file tools count only inside it, .md only
 *   MEMGLOW_MCP_SERVERS  comma-separated MCP server names that are "memory" servers
 *                        (default basic-memory,memory,obsidian,notes,filesystem — substring match)
 *   MEMGLOW_MACHINE      short label for this machine in the journal (default: short hostname)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOME = () => process.env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");

function installedConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME(), "memglow.config.json"), "utf8")); } catch { return {}; }
}

// A short, per-machine label shown in the journal (e.g. "laptop · hook · Claude Code"). Closed
// charset, 32 characters at most — same rule the server validates again (lib/memory.js); never a
// path, never the raw hostname if it contains anything else. Falls back to "host" when even the
// short hostname cannot be made to fit.
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
function sanitizeMachine(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (MACHINE_RE.test(s)) return s;
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  return MACHINE_RE.test(cleaned) ? cleaned : "host";
}
function defaultMachine() {
  try { return sanitizeMachine(os.hostname().split(".")[0]); } catch { return "host"; }
}

function settings() {
  const cfg = installedConfig();
  const dir = process.env.MEMGLOW_MEMORY_DIR || cfg.memoryDir || "";
  const servers = (process.env.MEMGLOW_MCP_SERVERS || (Array.isArray(cfg.mcpServers) ? cfg.mcpServers.join(",") : "")
    || "basic-memory,memory,obsidian,notes,filesystem").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    url: (process.env.MEMGLOW_URL || cfg.url || "http://127.0.0.1:4747").replace(/\/+$/, ""),
    tokenFile: process.env.MEMGLOW_TOKEN_FILE || path.join(HOME(), "token"),
    memoryDir: dir ? path.resolve(dir) + path.sep : null,
    servers,
    machine: sanitizeMachine(process.env.MEMGLOW_MACHINE || cfg.machine || defaultMachine()),
  };
}

function token(s = settings()) {
  if (process.env.MEMGLOW_TOKEN) return process.env.MEMGLOW_TOKEN.trim();
  try { return fs.readFileSync(s.tokenFile, "utf8").trim(); } catch { return ""; }
}

// Tool name → activity type. Order matters: "search" before "read" ("search_file_content").
// Directory listings are deliberately ignored: they would light up the whole brain for nothing.
const SEARCH_RE = /(search|find|query|grep|glob|recent)/i;
const WRITE_RE = /(write|edit|create|update|move|rename|delete|remove|append|prepend|replace|patch|insert|save)/i;
const READ_RE = /(read|view|fetch|^get_|open|show|context|load)/i;

function mcpType(tool) {
  const t = String(tool || "");
  if (WRITE_RE.test(t)) return "write";
  if (SEARCH_RE.test(t)) return "search";
  if (READ_RE.test(t)) return "read";
  return null;
}

/** Note ids quoted in a text (search results, context…): permalinks, memory:// URLs, *.md paths. */
function idsInText(text) {
  const out = [];
  const re = /(?:memory:\/\/|permalink["']?\s*[:=]\s*["']?|\b)([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.md)\b/g;
  for (const m of String(text).matchAll(re)) out.push(m[1]);
  return out;
}

function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return ""; }
}

/** Candidate note references found in MCP tool arguments. */
function idsInArgs(args) {
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return idsInText(args); } }
  if (!args || typeof args !== "object") return [];
  const out = [];
  for (const k of ["identifier", "url", "uri", "id", "permalink", "title", "path", "file_path", "filePath",
    "note", "name", "destination_path", "source", "destination"]) {
    const v = args[k];
    if (typeof v === "string" && v) out.push(v.replace(/^memory:\/\//, ""));
  }
  for (const k of ["paths", "identifiers", "notes", "files"]) {
    if (Array.isArray(args[k])) for (const v of args[k]) if (typeof v === "string") out.push(v);
  }
  return out;
}

// Agents spell server names differently ("basic-memory", "basic_memory", "basicMemory"): compare
// without separators or case.
const flat = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function isMemoryServer(server, s) {
  const n = flat(server);
  return !!n && s.servers.some((x) => flat(x) && n.includes(flat(x)));
}

/**
 * Neutral event → { type, ids } or null. Exported for tests.
 * ids are reduced to note names (last path segment, no .md); the server re-checks them anyway.
 */
function classify(evt, s = settings()) {
  if (!evt || typeof evt !== "object") return null;
  let type = null, ids = [];
  if (evt.kind === "file") {
    if (!s.memoryDir) return null;
    const file = path.resolve(String(evt.path || ""));
    if (!(file + "").startsWith(s.memoryDir) || !/\.md$/i.test(file)) return null;
    type = evt.op === "write" ? "write" : evt.op === "read" ? "read" : null;
    ids = [file];
  } else if (evt.kind === "mcp") {
    // The MCP proxy only ever wraps memory servers: it marks its events trusted.
    if (!evt.trusted && !isMemoryServer(evt.server, s)) return null;
    type = mcpType(evt.tool);
    if (!type) return null;
    const quoted = idsInArgs(evt.args);
    const found = idsInText(asText(evt.result).slice(0, 200000));
    ids = type === "search" ? found.concat(quoted) : quoted.concat(found);
  }
  if (!type) return null;
  const clean = [...new Set(ids.map((x) => String(x).split(/[\\/]/).pop().replace(/\.md$/i, "")).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(x)))].slice(0, 50);
  // A search through the MCP proxy that found nothing is still reported (no id): memglow's "Time to
  // find a note" counts it as a missed search, and its response time still counts.
  if (!clean.length && evt.kind === "mcp" && evt.trusted && type === "search") return { type, ids: [] };
  return clean.length ? { type, ids: clean } : null;
}

const CHANNELS = new Set(["hook", "mcp-proxy", "file", "api", "demo"]);

/**
 * Fire and forget: detached sender, 3 s timeout, silent.
 * opts.channel: how this event reaches memglow — "hook" (an adapter's own hook, the default here)
 * or "mcp-proxy" (the MCP proxy passes its own). Always paired with this machine's short label
 * (settings().machine) so the journal can read e.g. "laptop · hook · Claude Code".
 */
function report(evt, source, opts = {}) {
  try {
    const s = settings();
    const a = classify(evt, s);
    if (!a) return null;
    const tok = token(s);
    if (!tok) return null;
    const channel = CHANNELS.has(opts.channel) ? opts.channel : "hook";
    const body = { type: a.type, ids: a.ids, source: /^[a-z0-9-]{1,20}$/.test(source) ? source : "agent", channel, machine: s.machine };
    // Response time of the memory server, measured by the MCP proxy (hooks have none).
    if (typeof evt.durationMs === "number" && Number.isFinite(evt.durationMs) && evt.durationMs >= 0) body.durationMs = Math.round(evt.durationMs);
    if (opts.dryRun) return body;
    const payload = Buffer.from(JSON.stringify(body)).toString("base64");
    spawn(process.execPath, [path.join(__dirname, "send-activity.js"), s.url, payload], {
      detached: true, stdio: "ignore", env: { ...process.env, MEMGLOW_TOKEN: tok },
    }).unref();
    return body;
  } catch { return null; }
}

/** Read all of stdin as JSON (hooks), then call fn(json). Errors are swallowed. */
function readStdinJson(fn) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let data = null;
    try { data = JSON.parse(raw); } catch { /* not JSON: nothing to report */ }
    try { fn(data); } catch { /* never disturb the agent */ }
  });
}

module.exports = { settings, token, classify, report, readStdinJson, mcpType, idsInText, idsInArgs, sanitizeMachine, MACHINE_RE };
