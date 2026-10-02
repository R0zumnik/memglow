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
const { which, runCli, childEnv } = require("./cli");
const { readSecretFile, redact } = require("./http");

// The subscription token (`claude setup-token`) typed in the page, in memglow's data folder, mode
// 600 (lib/setup.js). It is given ONLY to the `claude` process memglow starts, as
// CLAUDE_CODE_OAUTH_TOKEN in that process's environment (never on its command line).
const OAUTH_FILE = "claude-code-oauth-token";
const OAUTH_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// Model aliases `claude --model` accepts (checked against `claude --help` 2.1.x and
// https://code.claude.com/docs/en/model-config); a full model id (claude-…) is accepted too.
const MODEL_ALIASES = ["default", "best", "fable", "opus", "sonnet", "haiku", "sonnet[1m]", "opus[1m]"];
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{1,60}(\[1m\])?$/;
function validModel(m) { return typeof m === "string" && (MODEL_ALIASES.includes(m) || MODEL_RE.test(m)); }

/**
 * How `claude` will sign in. → { auth: "env" | "page" | "cli", token, error? }:
 * CLAUDE_CODE_OAUTH_TOKEN already in memglow's environment (env), else the page's token file
 * (page), else the CLI's own login on this machine (cli: `claude` then /login, once).
 */
function oauth({ env = process.env, dataDir } = {}) {
  if (typeof env[OAUTH_ENV] === "string" && env[OAUTH_ENV].trim()) return { auth: "env", token: "" };
  const r = readSecretFile(dataDir, OAUTH_FILE);
  if (r.error) return { auth: "cli", token: "", error: r.error };
  return r.value ? { auth: "page", token: r.value } : { auth: "cli", token: "" };
}

/** Environment of the `claude` child: the user's (minus memglow's secrets), plus the page's token. */
function claudeEnv(env, dataDir) {
  const out = childEnv(env || process.env);
  const o = oauth({ env: out, dataDir });
  if (o.auth === "page") {
    out[OAUTH_ENV] = o.token;
    // The user chose the subscription: an API key in the environment would win over it in Claude
    // Code's own order (https://code.claude.com/docs/en/authentication), so it is not passed.
    delete out.ANTHROPIC_API_KEY;
    delete out.ANTHROPIC_AUTH_TOKEN;
  }
  return out;
}

const NEEDED = ["--restricted", "--tools", "stream-json", "--include-partial-messages", "dontAsk", "--no-session-persistence", "--system-prompt", "--strict-mcp-config", "--disallowedTools"];
const NO_TOOLS = ["Bash", "PowerShell", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "Skill"];

const helpCache = new Map();
function detect({ config = {}, env = process.env } = {}) {
  const bin = which(config.command || "claude", env);
  if (!bin) {
    return { available: false, detected: false, reason: env.MEMGLOW_DOCKER === "1"
      ? "Claude Code not available in this container: the image does not include the `claude` command. Use the image variant with Claude Code (README → Docker → Claude Code subscription), or choose another provider."
      : "Claude Code (the `claude` command) was not found. Install it and sign in once in a terminal, then restart memglow — or choose another provider." };
  }
  if (config.model && !validModel(config.model)) return { available: false, detected: true, reason: "The Claude Code model must be an alias (" + MODEL_ALIASES.join(", ") + ") or a full model id (claude-…)." };
  let help = helpCache.get(bin);
  if (help == null) {
    const r = spawnSync(bin, ["--help"], { env: childEnv(env), encoding: "utf8", timeout: 15000, windowsHide: true, shell: false });
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

async function run({ config = {}, env = process.env, workDir, dataDir }, { system, prompt, onText, signal, timeoutMs }) {
  const d = detect({ config, env });
  if (!d.available) return { ok: false, error: d.reason };
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const childEnvironment = claudeEnv(env, dataDir);
  const r = await runCli({ bin: d.path, args: buildArgs({ model: config.model, maxBudgetUsd: config.maxBudgetUsd, system }), cwd: workDir, env: childEnvironment, stdin: prompt, parser: createParser(), onText, timeoutMs, signal });
  // Whatever the CLI printed, the token never comes back in a message.
  const tok = childEnvironment[OAUTH_ENV] || "";
  if (r.error) r.error = redact(r.error, tok);
  if (r.stderrTail) r.stderrTail = redact(r.stderrTail, tok);
  return r;
}

/** What the panel may know (never the token): who answers, how `claude` signs in, the model. */
function info(ctx = {}) {
  const o = oauth(ctx);
  return {
    destination: "Anthropic (Claude subscription)", local: false,
    key: o.auth === "cli" ? "not needed" : "set", keySource: o.auth === "cli" ? "" : o.auth, keyName: o.auth === "env" ? OAUTH_ENV : o.auth === "page" ? OAUTH_FILE : "",
    model: (ctx.config && ctx.config.model) || "",
  };
}

module.exports = {
  id: "claude-code",
  label: "Claude Code subscription (no API key)",
  kind: "cli",
  implemented: true,
  local: false,
  detect, run, info,
  MODEL_ALIASES, OAUTH_FILE, OAUTH_ENV, validModel, oauth, claudeEnv,
  _buildArgs: buildArgs, _createParser: createParser,
};
