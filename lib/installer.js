"use strict";
/**
 * `memglow init` / `memglow uninstall` — pure functions over a home directory, so the tests can
 * run on a fake home. Rules:
 *  - never overwrite a config file we cannot parse (skip that agent, say why);
 *  - back up every file before its first modification (<file>.memglow-backup);
 *  - our entries are recognisable (their command contains "/.memglow/app/"), so uninstall removes
 *    exactly them and nothing else; --restore-backups puts the original files back instead;
 *  - every change is recorded in ~/.memglow/install-manifest.json.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
// The MCP proxy levers (lib/proxy-levers.js) read the notes through lib/memory.js, lib/cost.js,
// lib/counters.js and lib/related.js: they ship with the runtime too.
// lib/clients.js: the AI tools chosen at set-up, readable by the proxy (per-client levers).
const RUNTIME = ["lib/agent-core.js", "lib/send-activity.js", "lib/proxy-levers.js", "lib/memory.js", "lib/cost.js",
  "lib/counters.js", "lib/related.js", "lib/clients.js", "adapters", "mcp-proxy", "hooks"];
const MARK = "/.memglow/app/";
const MEMORY_SERVER_RE = /(basic[-_]?memory|memory|obsidian|notes)/i;

const q = (p) => JSON.stringify(p); // quote a path for a shell command
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function readJson(file) {
  if (!exists(file)) return { data: {}, created: true };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { data: {}, created: false };
  try { return { data: JSON.parse(raw), created: false }; } catch (e) { return { error: `${file} is not valid JSON (${e.message}) — left untouched` }; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".memglow-tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function backup(file, manifest) {
  if (!exists(file)) return null;
  const b = file + ".memglow-backup";
  if (!exists(b)) fs.copyFileSync(file, b);
  return b;
}
function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dst, e));
  } else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode); }
}
const ours = (entry) => JSON.stringify(entry || "").includes(MARK);

// ----------------------------------------------------------------------------------------------
// Notes folder detection
function detectNotes(home) {
  const found = [];
  const bm = readJson(path.join(home, ".basic-memory", "config.json")).data || {};
  if (bm.projects && typeof bm.projects === "object") {
    const order = [bm.default_project, ...Object.keys(bm.projects)].filter(Boolean);
    for (const name of order) {
      const p = bm.projects[name];
      const dir = typeof p === "string" ? p : p && p.path;
      if (dir && exists(dir)) found.push({ dir, from: `basic-memory project "${name}"` });
    }
  }
  if (exists(path.join(home, "basic-memory"))) found.push({ dir: path.join(home, "basic-memory"), from: "basic-memory default folder" });
  for (const f of [path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"), path.join(home, ".config", "obsidian", "obsidian.json")]) {
    const o = readJson(f).data || {};
    const vaults = Object.values(o.vaults || {}).filter((v) => v && v.path && exists(v.path)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const v of vaults) found.push({ dir: v.path, from: "Obsidian vault" });
  }
  const seen = new Set();
  return found.filter((f) => (seen.has(f.dir) ? false : seen.add(f.dir)));
}

// ----------------------------------------------------------------------------------------------
// Agents: where their config lives, how our hook is added and removed.
function hookCmd(app, agent, arg = "") { return `node ${q(path.join(app, "adapters", agent, "hook.js"))}${arg ? " " + arg : ""}`; }

function claudeLike(file, event, matcher, extra = {}) {
  return {
    file,
    add(data, cmd) {
      data.hooks = data.hooks || {};
      const list = (data.hooks[event] = Array.isArray(data.hooks[event]) ? data.hooks[event] : []);
      if (!list.some(ours)) list.push({ matcher, hooks: [{ type: "command", command: cmd, ...extra }] });
      return data;
    },
    remove(data) {
      if (data.hooks && Array.isArray(data.hooks[event])) {
        data.hooks[event] = data.hooks[event].filter((e) => !ours(e));
        if (!data.hooks[event].length) delete data.hooks[event];
        if (!Object.keys(data.hooks).length) delete data.hooks;
      }
      return data;
    },
  };
}

function eventsFile(file, events, makeEntry, top = {}) {
  return {
    file,
    add(data, cmdFor) {
      Object.assign(data, { ...top, ...data });
      data.hooks = data.hooks || {};
      for (const ev of events) {
        const list = (data.hooks[ev] = Array.isArray(data.hooks[ev]) ? data.hooks[ev] : []);
        if (!list.some(ours)) list.push(makeEntry(cmdFor(ev)));
      }
      return data;
    },
    remove(data) {
      for (const ev of events) {
        if (data.hooks && Array.isArray(data.hooks[ev])) {
          data.hooks[ev] = data.hooks[ev].filter((e) => !ours(e));
          if (!data.hooks[ev].length) delete data.hooks[ev];
        }
      }
      if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
      return data;
    },
  };
}

function agents(home) {
  return [
    { id: "claude-code", label: "Claude Code", detect: path.join(home, ".claude"),
      json: claudeLike(path.join(home, ".claude", "settings.json"), "PostToolUse", "mcp__.*|Read|Write|Edit|MultiEdit", { timeout: 5 }) },
    { id: "codex", label: "OpenAI Codex CLI", detect: path.join(home, ".codex"),
      json: claudeLike(path.join(home, ".codex", "hooks.json"), "PostToolUse", "mcp__.*|apply_patch|Edit|Write", { timeout: 5 }) },
    { id: "gemini", label: "Gemini CLI", detect: path.join(home, ".gemini"),
      json: claudeLike(path.join(home, ".gemini", "settings.json"), "AfterTool", ".*", { name: "memglow", timeout: 5000 }) },
    { id: "cursor", label: "Cursor", detect: path.join(home, ".cursor"), perEvent: true,
      json: eventsFile(path.join(home, ".cursor", "hooks.json"), ["beforeReadFile", "afterFileEdit", "afterMCPExecution"],
        (cmd) => ({ command: cmd, timeout: 5 }), { version: 1 }) },
    { id: "windsurf", label: "Windsurf / Devin Desktop", detect: path.join(home, ".codeium", "windsurf"),
      json: eventsFile(path.join(home, ".codeium", "windsurf", "hooks.json"), ["post_read_code", "post_write_code", "post_mcp_tool_use"],
        (cmd) => ({ command: cmd, show_output: false })) },
    { id: "copilot", label: "GitHub Copilot CLI", detect: path.join(home, ".copilot"),
      json: eventsFile(path.join(home, ".copilot", "hooks", "memglow.json"), ["postToolUse"],
        (cmd) => ({ type: "command", bash: cmd, timeoutSec: 5 }), { version: 1 }) },
    { id: "cline", label: "Cline", detect: path.join(home, "Documents", "Cline"), script: path.join(home, "Documents", "Cline", "Rules", "Hooks", "PostToolUse") },
  ];
}

function detectAgents(home) { return agents(home).filter((a) => exists(a.detect)); }

// ----------------------------------------------------------------------------------------------
function loadManifest(mhome) {
  const r = readJson(path.join(mhome, "install-manifest.json"));
  return r.data && !r.error ? { files: [], mcp: [], ...r.data } : { files: [], mcp: [] };
}
function saveManifest(mhome, m) { writeJson(path.join(mhome, "install-manifest.json"), m); }

function installAgent(a, app, manifest) {
  if (a.script) {
    if (exists(a.script) && !fs.readFileSync(a.script, "utf8").includes("memglow")) {
      return { id: a.id, ok: false, why: `${a.script} already exists (Cline allows one PostToolUse script) — add this line to it: ${hookCmd(app, a.id)}` };
    }
    fs.mkdirSync(path.dirname(a.script), { recursive: true });
    fs.writeFileSync(a.script, `#!/bin/sh\n# memglow — Cline PostToolUse hook (remove with: memglow uninstall)\nexec ${hookCmd(app, a.id)}\n`);
    fs.chmodSync(a.script, 0o755);
    manifest.files.push({ agent: a.id, file: a.script, script: true });
    return { id: a.id, ok: true, file: a.script };
  }
  const r = readJson(a.json.file);
  if (r.error) return { id: a.id, ok: false, why: r.error };
  const b = backup(a.json.file);
  const data = a.perEvent || a.id === "windsurf" || a.id === "copilot"
    ? a.json.add(r.data, (ev) => hookCmd(app, a.id, a.id === "cursor" ? ev : ""))
    : a.json.add(r.data, hookCmd(app, a.id));
  writeJson(a.json.file, data);
  if (!manifest.files.some((f) => f.file === a.json.file)) manifest.files.push({ agent: a.id, file: a.json.file, backup: b, created: r.created });
  return { id: a.id, ok: true, file: a.json.file };
}

// Claude Desktop has no hooks: its memory MCP servers can be wrapped by the proxy instead.
function desktopConfigs(home) {
  return [path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "Claude", "claude_desktop_config.json")].filter(exists);
}
function wrapMcp(home, app, manifest) {
  const done = [];
  for (const file of desktopConfigs(home)) {
    const r = readJson(file);
    if (r.error || !r.data.mcpServers) continue;
    let changed = false;
    for (const [name, s] of Object.entries(r.data.mcpServers)) {
      if (!s || !s.command || ours(s) || !MEMORY_SERVER_RE.test(name + " " + (s.args || []).join(" "))) continue;
      if (!changed) backup(file);
      manifest.mcp.push({ file, name, original: { command: s.command, args: s.args || [] } });
      s.args = [path.join(app, "mcp-proxy", "memglow-mcp-proxy.js"), "--name", name, "--source", "claude-desktop", "--", s.command, ...(s.args || [])];
      s.command = "node";
      changed = true;
      done.push(`${name} (${file})`);
    }
    if (changed) writeJson(file, r.data);
  }
  return done;
}

/**
 * The variables of the first-run choices for Docker (the page shows them as "set by …" and they win
 * over it). NEVER a key: the key lines are written commented out, with what to put there.
 */
function dockerEnvLines(clients, assistant) {
  const out = [];
  if (Array.isArray(clients)) out.push("# AI tools you use (first-run screen; remove this line to choose in the page)", `MEMGLOW_CLIENTS=${clients.join(",") || "none"}`);
  if (assistant && assistant.enabled) {
    out.push("# Optional assistant (remove these lines to choose in the page → Settings → AI settings)", "MEMGLOW_ASSISTANT=1");
    if (assistant.provider) out.push(`MEMGLOW_ASSISTANT_PROVIDER=${assistant.provider}`);
    const own = (assistant.providers || {})[assistant.provider] || {};
    if (own.model) out.push(`MEMGLOW_ASSISTANT_MODEL=${own.model}`);
    if (own.preset) out.push(`MEMGLOW_ASSISTANT_PRESET=${own.preset}`);
    if (own.baseUrl) out.push(`MEMGLOW_ASSISTANT_BASE_URL=${own.baseUrl}`);
    const ids = Object.keys(assistant.providers || {});
    if (ids.some((id) => id === "anthropic" || id === "openai-compatible")) {
      out.push("# API key: never written by memglow init. Put it here yourself (this file is mode 600), or type it",
        "# in the page from http://127.0.0.1 (Settings → AI settings). One per provider is safer:");
      for (const id of ids.filter((x) => x === "anthropic" || x === "openai-compatible")) out.push(`# MEMGLOW_ASSISTANT_API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}=`);
      out.push("# MEMGLOW_ASSISTANT_API_KEY=");
    }
    if (ids.includes("claude-code")) {
      out.push("# Claude Code subscription: the image variant with Claude Code (README → Docker), and the token",
        "# printed by `claude setup-token` on a computer where you are signed in:", "# CLAUDE_CODE_OAUTH_TOKEN=");
    }
  }
  return out;
}

const COMPOSE_PASS = ["MEMGLOW_CLIENTS", "MEMGLOW_ASSISTANT", "MEMGLOW_ASSISTANT_PROVIDER", "MEMGLOW_ASSISTANT_MODEL", "MEMGLOW_ASSISTANT_PRESET",
  "MEMGLOW_ASSISTANT_BASE_URL", "MEMGLOW_ASSISTANT_API_KEY", "MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC", "MEMGLOW_ASSISTANT_API_KEY_OPENAI_COMPATIBLE", "CLAUDE_CODE_OAUTH_TOKEN"];

function dockerFiles(mhome, notes, port, tok, { clients = null, assistant = null } = {}) {
  const extra = dockerEnvLines(clients, assistant);
  fs.writeFileSync(path.join(mhome, ".env"), `MEMGLOW_TOKEN=${tok}\nNOTES=${notes}\nPORT=${port}\n` + (extra.length ? extra.join("\n") + "\n" : ""), { mode: 0o600 });
  fs.chmodSync(path.join(mhome, ".env"), 0o600);
  fs.writeFileSync(path.join(mhome, "docker-compose.yml"), [
    "# memglow — generated by `memglow init --docker`. Start: docker compose -f ~/.memglow/docker-compose.yml up -d",
    "services:",
    "  memglow:",
    "    image: ghcr.io/r0zumnik/memglow:latest   # or build locally: docker build -t memglow . (then image: memglow)",
    "    container_name: memglow",
    "    restart: unless-stopped",
    "    ports:",
    "      - \"127.0.0.1:${PORT}:4747\"",
    "    environment:",
    "      - MEMGLOW_TOKEN=${MEMGLOW_TOKEN}",
    // Empty when not set in .env: memglow treats an empty variable as not set (the page decides).
    ...(extra.length ? COMPOSE_PASS.map((k) => `      - ${k}=\${${k}:-}`) : []),
    "    volumes:",
    "      - \"${NOTES}:/memory:ro\"",
    "      - memglow-data:/data   # memglow's own data (Memory cost counters), never the notes",
    "volumes:",
    "  memglow-data:",
    "",
  ].join("\n"));
}

/**
 * opts: { home, dir, port, agents: "all"|"none"|[ids], wrapMcp, docker, confirm(question)→bool }
 * → report object (what was done, what was skipped and why).
 */
async function init(opts = {}) {
  const home = opts.home;
  const mhome = path.join(home, ".memglow");
  const app = path.join(mhome, "app");
  const confirm = opts.confirm || (async () => true);
  const out = { notes: null, agents: [], skipped: [], mcp: [], docker: false, detected: [], clients: null, assistant: null, secrets: [] };

  const notes = opts.dir ? path.resolve(opts.dir) : (detectNotes(home)[0] || {}).dir;
  if (!notes || !exists(notes)) throw new Error("no notes folder found — pass one with --dir <folder>");
  out.notes = notes;
  const port = Number(opts.port || 4747);

  fs.mkdirSync(mhome, { recursive: true, mode: 0o700 });
  const tokFile = path.join(mhome, "token");
  const tok = exists(tokFile) ? fs.readFileSync(tokFile, "utf8").trim() : crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(tokFile, tok + "\n", { mode: 0o600 });
  fs.chmodSync(tokFile, 0o600);
  const cfgFile = path.join(mhome, "memglow.config.json");
  const cfg = { ...(readJson(cfgFile).data || {}), memoryDir: notes, port, url: `http://127.0.0.1:${port}` };
  // First-run choices asked by `memglow init` (bin/memglow.js): the AI tools, the assistant and its
  // providers. In the config file — the page (setup.json) and the environment win over it.
  const clients = Array.isArray(opts.clients) ? require("./clients").cleanClients(opts.clients) : null;
  if (clients) { cfg.clients = clients; out.clients = clients; }
  if (opts.assistant && typeof opts.assistant === "object") {
    const v = require("./setup").validate({ assistant: opts.assistant });
    if (!v.ok) throw new Error(`assistant settings refused (${v.error}${v.field ? " " + v.field : ""})`);
    const a = v.value.assistant;
    const prev = cfg.assistant && typeof cfg.assistant === "object" ? cfg.assistant : {};
    cfg.assistant = { ...prev, enabled: a.enabled, ...(a.provider ? { provider: a.provider } : {}) };
    for (const [id, fields] of Object.entries(a.providers)) cfg.assistant[id] = { ...(prev[id] || {}), ...fields };
    out.assistant = a;
  }
  writeJson(cfgFile, cfg);
  // A key typed (masked) in the terminal: a mode-600 file of the data folder, like the page does.
  for (const [id, value] of Object.entries(opts.secrets || {})) {
    if (require("./setup").writeSecret(mhome, id, value)) out.secrets.push(id);
  }

  fs.rmSync(app, { recursive: true, force: true });
  for (const rel of RUNTIME) copyRecursive(path.join(ROOT, rel), path.join(app, rel));

  const manifest = loadManifest(mhome);
  const want = opts.agents || "all";
  // What was found on this computer: the page pre-ticks it (lib/clients.js installed()).
  out.detected = detectAgents(home).map((a) => a.id);
  manifest.detected = out.detected;
  if (clients) manifest.clients = clients;
  for (const a of detectAgents(home)) {
    if (want === "none" || (Array.isArray(want) && !want.includes(a.id))) continue;
    if (clients && !clients.includes(a.id)) { out.skipped.push({ id: a.id, why: "not one of the tools you chose" }); continue; }
    if (!(await confirm(`Install the memglow hook for ${a.label}?`))) { out.skipped.push({ id: a.id, why: "declined" }); continue; }
    const r = installAgent(a, app, manifest);
    if (r.ok) out.agents.push(r); else out.skipped.push(r);
  }
  if (opts.wrapMcp && desktopConfigs(home).length && (await confirm("Wrap the memory MCP servers of Claude Desktop with the memglow proxy?"))) {
    out.mcp = wrapMcp(home, app, manifest);
  }
  if (opts.docker) { dockerFiles(mhome, notes, port, tok, { clients, assistant: out.assistant }); out.docker = true; }
  manifest.version = require("../package.json").version;
  manifest.installedAt = new Date().toISOString();
  saveManifest(mhome, manifest);
  return out;
}

/** opts: { home, restoreBackups, purge } */
function uninstall(opts = {}) {
  const home = opts.home;
  const mhome = path.join(home, ".memglow");
  const manifest = loadManifest(mhome);
  const out = { cleaned: [], restored: [], mcp: [] };
  const byId = Object.fromEntries(agents(home).map((a) => [a.id, a]));
  for (const f of manifest.files) {
    if (f.script) {
      if (exists(f.file) && fs.readFileSync(f.file, "utf8").includes("memglow")) { fs.rmSync(f.file); out.cleaned.push(f.file); }
      continue;
    }
    if (opts.restoreBackups && f.backup && exists(f.backup)) { fs.copyFileSync(f.backup, f.file); out.restored.push(f.file); continue; }
    const r = readJson(f.file);
    if (r.error || r.created && !exists(f.file)) continue;
    const a = byId[f.agent];
    const data = a ? a.json.remove(r.data) : r.data;
    const empty = !Object.keys(data).filter((k) => k !== "version").length;
    if (f.created && empty) fs.rmSync(f.file); else writeJson(f.file, data);
    out.cleaned.push(f.file);
  }
  for (const w of manifest.mcp) {
    const r = readJson(w.file);
    if (r.error || !r.data.mcpServers || !r.data.mcpServers[w.name]) continue;
    const s = r.data.mcpServers[w.name];
    if (!ours(s)) continue;
    s.command = w.original.command; s.args = w.original.args;
    writeJson(w.file, r.data);
    out.mcp.push(w.name);
  }
  fs.rmSync(path.join(mhome, "install-manifest.json"), { force: true });
  fs.rmSync(path.join(mhome, "app"), { recursive: true, force: true });
  if (opts.purge) fs.rmSync(mhome, { recursive: true, force: true });
  return out;
}

module.exports = { init, uninstall, detectNotes, detectAgents, agents, dockerEnvLines, MARK };
