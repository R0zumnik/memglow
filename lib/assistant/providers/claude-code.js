"use strict";
/**
 * Provider: Claude Code (the user's own `claude` CLI, their subscription or key), run
 * non-interactively with NO TOOL AT ALL. It only reads the prompt (the note and its context) and
 * answers with a JSON proposal; memglow validates it, shows the diff and writes after approval.
 *
 * Options used (all checked against `claude --help`, Claude Code 2.1.x, and
 * https://code.claude.com/docs/en/permissions):
 *   -p                              print mode; the prompt is read from STDIN (never an argument)
 *   --output-format stream-json     one JSON event per line; with -p it REQUIRES --verbose
 *   --include-partial-messages      text deltas as they arrive (live progress in the panel)
 *   --tools ""                      no built-in tool exists (no file access, no shell, no web)
 *   --strict-mcp-config             no MCP server (none is given with --mcp-config)
 *   --restricted                    ignores the user/project settings files, so none of their
 *                                   allow rules or hooks apply; refuses bypassPermissions
 *   --permission-mode dontAsk       anything not pre-approved is denied, never prompted
 *   --settings {"permissions":{"deny":["*"]}}  a bare-name glob deny: every tool is removed
 *   --disallowedTools <names…>      the same, by name, for the built-ins (belt and braces)
 *   --disable-slash-commands        no skill
 *   --no-session-persistence        nothing added to the user's resumable sessions
 *   --system-prompt <text>          memglow's fixed rules replace the coding-agent prompt
 *   --model, --max-budget-usd       optional (assistant.model, assistant.maxBudgetUsd)
 * Run in an empty folder of memglow's data dir (no project CLAUDE.md, no .mcp.json).
 * Never used: --dangerously-skip-permissions, bypassPermissions, a shell.
 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const { which, runCli } = require("./cli");

const NEEDED = ["--restricted", "--tools", "stream-json", "--include-partial-messages", "dontAsk", "--no-session-persistence", "--system-prompt", "--strict-mcp-config", "--disallowedTools"];
const NO_TOOLS = ["Bash", "PowerShell", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "Skill"];

const helpCache = new Map();
function detect({ config = {}, env = process.env } = {}) {
  const bin = which(config.command || "claude", env);
  if (!bin) return { available: false, detected: false, reason: "Claude Code (the `claude` command) was not found. Install it and sign in once in a terminal, then restart memglow — or choose another provider." };
  let help = helpCache.get(bin);
  if (help == null) {
    const r = spawnSync(bin, ["--help"], { env, encoding: "utf8", timeout: 15000, windowsHide: true, shell: false });
    help = String(r.stdout || "") + String(r.stderr || "");
    if (help) helpCache.set(bin, help);
  }
  const missing = NEEDED.filter((o) => !help.includes(o));
  if (missing.length) return { available: false, detected: true, reason: "This Claude Code is too old for memglow's assistant (missing " + missing.join(", ") + "). Update it with `claude update`." };
  return { available: true, detected: true, path: bin };
}

function buildArgs({ model, maxBudgetUsd, system }) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "", "--strict-mcp-config", "--restricted", "--permission-mode", "dontAsk",
    "--settings", JSON.stringify({ permissions: { defaultMode: "dontAsk", deny: ["*"] } }),
    "--disallowedTools", ...NO_TOOLS,
    "--disable-slash-commands", "--no-session-persistence",
  ];
  if (model) args.push("--model", String(model));
  if (Number(maxBudgetUsd) > 0) args.push("--max-budget-usd", String(Number(maxBudgetUsd)));
  args.push("--system-prompt", system);
  return args;
}

function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.type === "text" ? x.text : "")).join("\n");
  return "";
}

/** Parser of `--output-format stream-json`. */
function createParser() {
  let rest = "";
  function line(l) {
    let o;
    try { o = JSON.parse(l); } catch { return []; }
    if (!o || typeof o !== "object") return [];
    if (o.type === "stream_event" && o.event) {
      const e = o.event;
      if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && typeof e.delta.text === "string") return [{ type: "text", text: e.delta.text }];
      return [];
    }
    if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      return o.message.content.filter((b) => b && b.type === "tool_use").map((b) => ({ type: "tool", name: String(b.name || "tool").slice(0, 100) }));
    }
    if (o.type === "result") {
      const ok = !o.is_error && (o.subtype === "success" || o.subtype == null);
      return [{ type: "result", ok, text: resultText(o.result), error: ok ? "" : String(o.subtype || "error").slice(0, 100) }];
    }
    return [];
  }
  return {
    push(chunk) {
      rest += chunk;
      const out = [];
      let i;
      while ((i = rest.indexOf("\n")) >= 0) {
        const l = rest.slice(0, i); rest = rest.slice(i + 1);
        if (l.trim()) out.push(...line(l));
      }
      return out;
    },
    end() { const l = rest; rest = ""; return l.trim() ? line(l) : []; },
  };
}

async function run({ config = {}, env = process.env, workDir }, { system, prompt, onText, signal, timeoutMs }) {
  const d = detect({ config, env });
  if (!d.available) return { ok: false, error: d.reason };
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  return runCli({ bin: d.path, args: buildArgs({ model: config.model, maxBudgetUsd: config.maxBudgetUsd, system }), cwd: workDir, env, stdin: prompt, parser: createParser(), onText, timeoutMs, signal });
}

module.exports = {
  id: "claude-code",
  label: "Claude Code (your CLI)",
  kind: "cli",
  implemented: true,
  local: false,
  detect, run,
  _buildArgs: buildArgs, _createParser: createParser,
};
