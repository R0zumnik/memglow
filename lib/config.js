"use strict";
/**
 * Configuration: environment variables, then an optional JSON file (MEMGLOW_CONFIG or
 * ./memglow.config.json). Themes are the big groups of the graph; notes pick one with a
 * `theme:` frontmatter key, or inherit it from their folder (`themeByFolder`).
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_THEMES = [
  { id: "people", label: "People", color: "#2EE89B" },
  { id: "projects", label: "Projects", color: "#8FA8FF" },
  { id: "knowledge", label: "Knowledge", color: "#4FD1E0" },
  { id: "habits", label: "Habits & rules", color: "#FFB86B" },
  { id: "archive", label: "Archive", color: "#7E948D" },
];

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

  return {
    memoryDir,
    port: Number(env.PORT || fromFile.port || 4747),
    host: env.HOST || fromFile.host || "127.0.0.1",
    token,          // protects POST /api/activity (assistant hooks)
    password,       // optional HTTP Basic auth for the viewer (user "memglow")
    showBodies: String(env.MEMGLOW_SHOW_BODIES ?? fromFile.showBodies ?? "true") !== "false",
    pollMs: Math.max(500, Number(env.MEMGLOW_POLL_MS || fromFile.pollMs || 2000)),
    title: String(fromFile.title || "memglow").slice(0, 60),
    indexNote: fromFile.indexNote || ["MEMORY", "index"],
    themes,
    themeByFolder: Array.isArray(fromFile.themeByFolder) ? fromFile.themeByFolder.filter((x) => Array.isArray(x) && x.length === 2) : [],
    defaultTheme: fromFile.defaultTheme || null,
    subthemeLabels: fromFile.subthemeLabels && typeof fromFile.subthemeLabels === "object" ? fromFile.subthemeLabels : {},
  };
}

module.exports = { loadConfig, DEFAULT_THEMES };
