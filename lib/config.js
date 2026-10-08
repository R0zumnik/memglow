"use strict";
/**
 * Configuration: environment variables, then an optional JSON file (MEMGLOW_CONFIG or
 * ./memglow.config.json). Themes are the big groups of the graph; notes pick one with a
 * `theme:` frontmatter key, or inherit it from their folder (`themeByFolder`).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { settings: archiveSettings } = require("./archive");
const { cleanClients } = require("./clients");

const DEFAULT_THEMES = [
  { id: "people", label: "People", color: "#2EE89B" },
  { id: "projects", label: "Projects", color: "#8FA8FF" },
  { id: "knowledge", label: "Knowledge", color: "#4FD1E0" },
  { id: "habits", label: "Habits & rules", color: "#FFB86B" },
  { id: "archive", label: "Archive", color: "#7E948D" },
];

/** Per-provider assistant settings (top level of `assistant`, or a section named after a provider). */
function providerFields(a, env, str, int) {
  const preset = str(env.MEMGLOW_ASSISTANT_PRESET || a.preset, 20).toLowerCase();
  return {
    command: str(env.MEMGLOW_ASSISTANT_COMMAND || a.command, 500),
    model: str(env.MEMGLOW_ASSISTANT_MODEL || a.model, 100),
    maxBudgetUsd: Number(a.maxBudgetUsd) > 0 ? Math.min(100, Number(a.maxBudgetUsd)) : 0,
    baseUrl: str(env.MEMGLOW_ASSISTANT_BASE_URL || a.baseUrl, 500),
    preset: /^[a-z]{1,20}$/.test(preset) ? preset : "",
    apiKeyEnv: str(a.apiKeyEnv, 64),
    apiKeyFile: str(a.apiKeyFile, 64),
    maxTokens: int(a.maxTokens, 0, 1, 1000000),
    // AI settings (lib/setup.js, Settings → AI settings): optional; absent = today's behaviour.
    temperature: typeof a.temperature === "number" && a.temperature >= 0 && a.temperature <= 2 ? a.temperature : null,
    timeoutMinutes: int(a.timeoutMinutes, 0, 1, 60),
    confirmRemote: typeof a.confirmRemote === "boolean" ? a.confirmRemote : null,
    priceIn: typeof a.priceIn === "number" && a.priceIn >= 0 && a.priceIn <= 1000 ? a.priceIn : null,
    priceOut: typeof a.priceOut === "number" && a.priceOut >= 0 && a.priceOut <= 1000 ? a.priceOut : null,
  };
}

/**
 * Names of fields that look like an API key written in the config file (refused: the key belongs
 * in an environment variable or a mode-600 file). Only the names are kept, never the values.
 */
const KEY_FIELD = /^(api[_-]?key|key|token|secret|password|authorization|bearer|access[_-]?token|auth[_-]?token)$/i;
function keyFields(a, prefix = "assistant") {
  const out = [];
  for (const [k, v] of Object.entries(a || {})) {
    if (KEY_FIELD.test(k)) out.push(prefix + "." + k);
    else if (v && typeof v === "object" && !Array.isArray(v) && prefix === "assistant") out.push(...keyFields(v, prefix + "." + k));
  }
  return out;
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function loadConfig(env = process.env, cwd = process.cwd()) {
  const file = env.MEMGLOW_CONFIG || path.join(cwd, "memglow.config.json");
  let fromFile = {};
  if (fs.existsSync(file)) {
    try { fromFile = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`memglow: cannot parse ${file}: ${e.message}`); }
  }
  const themes = (Array.isArray(fromFile.themes) && fromFile.themes.length ? fromFile.themes : DEFAULT_THEMES)
    .filter((t) => t && ID_RE.test(String(t.id)) && t.id !== "index" && t.id !== "other")
    .slice(0, 8)
    .map((t) => ({ id: t.id, label: String(t.label || t.id).slice(0, 40), color: COLOR_RE.test(t.color) ? t.color : "#A9C9BF" }));

  const memoryDir = path.resolve(cwd, env.MEMORY_DIR || fromFile.memoryDir || "./memory");
  const token = env.MEMGLOW_TOKEN || "";
  if (token && token.length < 32) throw new Error("memglow: MEMGLOW_TOKEN must be at least 32 characters");
  const password = env.MEMGLOW_PASSWORD || "";
  if (password && password.length < 12) throw new Error("memglow: MEMGLOW_PASSWORD must be at least 12 characters");

  // memglow's own data (Memory cost counters). Never MEMORY_DIR: the notes are only read.
  const dataDir = path.resolve(cwd, env.MEMGLOW_DATA_DIR || fromFile.dataDir || env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow"));
  const int = (v, def, min, max) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };

  // Optional assistant (lib/assistant): OFF unless assistant.enabled is true or MEMGLOW_ASSISTANT=1
  // (MEMGLOW_ASSISTANT=0 turns it off whatever the file says).
  const a = fromFile.assistant && typeof fromFile.assistant === "object" ? fromFile.assistant : {};
  const envOn = String(env.MEMGLOW_ASSISTANT || "").toLowerCase();
  const str = (v, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
  const assistant = {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    // HTTP providers (anthropic, openai-compatible). The API KEY is never read from this file: only
    // from an environment variable or a mode-600 file in the data folder (lib/assistant/providers/http.js).
    ...providerFields(a, env, str, int),
    provider: str(env.MEMGLOW_ASSISTANT_PROVIDER || a.provider, 40) || "claude-code",
    timeoutMinutes: int(a.timeoutMinutes, 10, 1, 60),
    backup: ["auto", "git", "copy"].includes(a.backup) ? a.backup : "auto",
    allowMissingLines: int(a.allowMissingLines, 0, 0, 50),
    sections: {},
    keyInConfig: keyFields(a),
  };
  for (const id of ["claude-code", "anthropic", "openai-compatible", "ollama", "lmstudio"]) {
    if (a[id] && typeof a[id] === "object" && !Array.isArray(a[id])) assistant.sections[id] = providerFields(a[id], {}, str, int);
  }

  return {
    cwd,
    assistant,
    // The AI tools the user works with (lib/clients.js): from this file; the first-run screen's
    // choice (<dataDir>/setup.json) and MEMGLOW_CLIENTS win (lib/setup.js applySetup).
    clients: cleanClients(fromFile.clients),
    // Behind a reverse proxy that terminates HTTPS: trust its X-Forwarded-Proto to know that the
    // browser's connection is encrypted. Only used to allow typing a secret in the page (lib/setup.js).
    trustProxy: /^(1|true)$/i.test(String(env.MEMGLOW_TRUST_PROXY ?? (fromFile.trustProxy === true ? "true" : ""))),
    // Set by the Docker image: the page then explains that hooks run next to the AI tools, on the host.
    docker: env.MEMGLOW_DOCKER === "1",
    // Archive tier (lib/archive.js): when a section counts as dormant, where archive notes go.
    archive: archiveSettings(fromFile.archive, env, fromFile.archiveAfterDays),
    memoryDir,
    dataDir,
    // Memory cost: a note above this many tokens (≈ bytes / 4) is "too large"; split suggestions
    // group its sections into parts of about `splitChunkTokens`.
    largeNoteTokens: int(env.MEMGLOW_LARGE_NOTE_TOKENS || fromFile.largeNoteTokens, 5000, 200, 1000000),
    splitChunkTokens: int(fromFile.splitChunkTokens, 2000, 100, 1000000),
    port: Number(env.PORT || fromFile.port || 4747),
    host: env.HOST || fromFile.host || "127.0.0.1",
    token,          // protects POST /api/activity (assistant hooks)
    password,       // optional HTTP Basic auth for the viewer (user "memglow")
    // Without a password, only requests addressed to these host names are served (DNS-rebinding
    // guard, see server.js). localhost, 127.0.0.1 and ::1 are always allowed.
    allowedHosts: String(env.MEMGLOW_ALLOWED_HOSTS || (Array.isArray(fromFile.allowedHosts) ? fromFile.allowedHosts.join(",") : ""))
      .split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.:[\]-]{1,253}$/.test(h)),
    showBodies: String(env.MEMGLOW_SHOW_BODIES ?? fromFile.showBodies ?? "true") !== "false",
    pollMs: Math.max(500, Number(env.MEMGLOW_POLL_MS || fromFile.pollMs || 2000)),
    title: String(fromFile.title || "memglow").slice(0, 60),
    indexNote: fromFile.indexNote || ["MEMORY", "index"],
    themes,
    themeByFolder: Array.isArray(fromFile.themeByFolder) ? fromFile.themeByFolder.filter((x) => Array.isArray(x) && x.length === 2) : [],
    defaultTheme: fromFile.defaultTheme || null,
    subthemeLabels: fromFile.subthemeLabels && typeof fromFile.subthemeLabels === "object" ? fromFile.subthemeLabels : {},
    // Protected zones (lib/zones.js): top-level theme ids the assistant never moves notes across.
    // null = not defined in the file (the page then asks at first run; a choice saved from the page
    // in the data folder wins over this value).
    protectedThemes: Array.isArray(fromFile.protectedThemes)
      ? [...new Set(fromFile.protectedThemes.filter((id) => themes.some((t) => t.id === id)))]
      : null,
    // Always-loaded cost (lib/always-loaded.js): instruction files loaded at every session. Only
    // their SIZE is read (never their content); paths as written by the user, "~" = home folder,
    // relative paths from the folder memglow starts in.
    alwaysLoaded: (Array.isArray(fromFile.alwaysLoaded) ? fromFile.alwaysLoaded : [])
      .filter((s) => typeof s === "string" && s.trim() && s.length <= 500 && !/[\u0000-\u001F]/.test(s))
      .map((s) => s.trim()).slice(0, 20),
    // Sessions per day when the activity counters cannot tell (no index read counted).
    sessionsPerDay: int(fromFile.sessionsPerDay, 5, 1, 1000),
    // An index note above this size gets a "trim the index" tip (and, with proxy.indexWarning, a
    // warning from the MCP proxy when it is read).
    indexWarningTokens: int(fromFile.indexWarningTokens, 2000, 100, 1000000),
    // "Trim the index" (lib/index-trim.js): an index line's hook longer than this many characters
    // is a candidate for deterministic shortening.
    indexTrimMaxChars: int(env.MEMGLOW_INDEX_TRIM_MAX_CHARS || fromFile.indexTrimMaxChars, 90, 30, 1000),
    // Scheduled maintenance proposals (lib/maintenance.js): the scan always runs once at start,
    // then again every this many hours. 0 = no repeat (the start-up scan still runs once).
    maintenanceEveryHours: int(env.MEMGLOW_MAINTENANCE_EVERY_HOURS || fromFile.maintenanceEveryHours, 24, 0, 24 * 366),
  };
}

module.exports = { loadConfig, DEFAULT_THEMES };
