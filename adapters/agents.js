"use strict";
/**
 * Per-agent translators: native hook payload → neutral events for lib/agent-core.js.
 * Payload shapes follow each vendor's documentation (see adapters/<agent>/README.md for links).
 * Each parser is tolerant: an unknown or partial payload simply yields no event.
 *
 * run(agent, argv) is what adapters/<agent>/hook.js calls: it reads stdin, reports, and prints
 * exactly what that agent expects on stdout (some require JSON, most want nothing).
 */
const path = require("path");
const core = require("../lib/agent-core");

function obj(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") { try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  return {};
}
const first = (...v) => v.find((x) => typeof x === "string" && x) || "";

/** "mcp__server__tool" (Claude Code, Codex) → { server, tool } */
function splitDoubleUnderscore(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ""));
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Paths touched by a Codex apply_patch body ("*** Update File: x", "*** Add File: x", …). */
function patchPaths(input) {
  const text = typeof input === "string" ? input : first(input && input.patch, input && input.input, input && input.command);
  const out = [];
  for (const m of String(text).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  for (const m of String(text).matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

const resolve = (p, cwd) => (p ? path.resolve(cwd || process.cwd(), String(p)) : "");

const PARSERS = {
  // Claude Code — PostToolUse {tool_name, tool_input, tool_response}
  "claude-code"(e) {
    const mcp = splitDoubleUnderscore(e.tool_name);
    if (mcp) return [{ kind: "mcp", ...mcp, args: e.tool_input, result: e.tool_response }];
    const i = obj(e.tool_input);
    const file = resolve(i.file_path, e.cwd);
    if (e.tool_name === "Read") return [{ kind: "file", op: "read", path: file }];
    if (["Write", "Edit", "MultiEdit"].includes(e.tool_name)) return [{ kind: "file", op: "write", path: file }];
    return [];
  },

  // OpenAI Codex CLI — PostToolUse {tool_name, tool_input, tool_response}; edits go through apply_patch
  codex(e) {
    const mcp = splitDoubleUnderscore(e.tool_name);
    if (mcp) return [{ kind: "mcp", ...mcp, args: e.tool_input, result: e.tool_response }];
    if (/^(apply_patch|Edit|Write)$/.test(String(e.tool_name))) {
      return patchPaths(e.tool_input).concat(first(obj(e.tool_input).file_path, obj(e.tool_input).path) || [])
        .map((p) => ({ kind: "file", op: "write", path: resolve(p, e.cwd) }));
    }
    return [];
  },

  // Gemini CLI — AfterTool {tool_name, tool_input, tool_response, mcp_context}; MCP tools "mcp_<server>_<tool>"
  gemini(e) {
    const name = String(e.tool_name || "");
    const i = obj(e.tool_input);
    const ctx = obj(e.mcp_context);
    if (name.startsWith("mcp_") || ctx.server_name || ctx.serverName) {
      const server = first(ctx.server_name, ctx.serverName, name.slice(4));
      const tool = first(ctx.tool_name, ctx.toolName, e.original_request_name, name.slice(4));
      return [{ kind: "mcp", server, tool, args: i, result: e.tool_response && (e.tool_response.llmContent ?? e.tool_response) }];
    }
    if (name === "read_file") return [{ kind: "file", op: "read", path: resolve(first(i.absolute_path, i.file_path, i.path), e.cwd) }];
    if (name === "read_many_files") return (i.paths || []).map((p) => ({ kind: "file", op: "read", path: resolve(p, e.cwd) }));
    if (name === "write_file" || name === "replace") return [{ kind: "file", op: "write", path: resolve(first(i.file_path, i.absolute_path, i.path), e.cwd) }];
    return [];
  },

  // Cursor — hooks.json events; the event name is passed as argv[2] by the installed config
  cursor(e, event) {
    const ev = event || e.hook_event_name || "";
    if (ev === "beforeReadFile") return [{ kind: "file", op: "read", path: resolve(e.file_path) }];
    if (ev === "afterFileEdit") return [{ kind: "file", op: "write", path: resolve(e.file_path) }];
    if (ev === "afterMCPExecution" || ev === "beforeMCPExecution") {
      return [{ kind: "mcp", server: e.mcp_server_name, tool: e.tool_name, args: obj(e.tool_input), result: e.result_json }];
    }
    return [];
  },

  // Windsurf / Devin Desktop (Cascade hooks) — {agent_action_name, tool_info}
  windsurf(e) {
    const t = obj(e.tool_info);
    switch (e.agent_action_name) {
      case "post_read_code": return [{ kind: "file", op: "read", path: resolve(t.file_path) }];
      case "post_write_code": return [{ kind: "file", op: "write", path: resolve(t.file_path) }];
      case "post_mcp_tool_use": return [{ kind: "mcp", server: t.mcp_server_name, tool: t.mcp_tool_name, args: t.mcp_tool_arguments, result: t.mcp_result }];
      default: return [];
    }
  },

  // GitHub Copilot (CLI and coding agent) — postToolUse {toolName, toolArgs, toolResult}
  copilot(e) {
    const name = String(e.toolName || "");
    const a = obj(e.toolArgs);
    const cwd = e.cwd || e.workingDirectory;
    const file = resolve(first(a.path, a.file_path, a.filePath), cwd);
    if (/^(view|read|read_file)$/i.test(name)) return file ? [{ kind: "file", op: "read", path: file }] : [];
    if (/^(edit|create|write|str_replace|write_file|str_replace_editor)$/i.test(name)) return file ? [{ kind: "file", op: "write", path: file }] : [];
    // MCP tools: "<server>-<tool>", "<server>/<tool>" or "mcp__<server>__<tool>"
    let m = splitDoubleUnderscore(name);
    if (!m) { const x = /^([^/]+)\/(.+)$/.exec(name) || /^(.+?)-([a-z_]+)$/i.exec(name); if (x) m = { server: x[1], tool: x[2] }; }
    return m ? [{ kind: "mcp", ...m, args: a, result: e.toolResult }] : [];
  },

  // Cline — PostToolUse script; payload {postToolUse: {tool|toolName, parameters|params, result}, workspaceRoots}
  cline(e) {
    const p = obj(e.postToolUse || e.PostToolUse || e);
    const name = first(p.tool, p.toolName, p.name);
    const a = obj(p.parameters || p.params || p.input);
    const cwd = (Array.isArray(e.workspaceRoots) && e.workspaceRoots[0]) || e.cwd;
    if (name === "use_mcp_tool") return [{ kind: "mcp", server: a.server_name, tool: a.tool_name, args: obj(a.arguments), result: p.result }];
    if (name === "access_mcp_resource") return [{ kind: "mcp", server: a.server_name, tool: "read_resource", args: { uri: a.uri }, result: p.result }];
    if (name === "read_file") return [{ kind: "file", op: "read", path: resolve(a.path, cwd) }];
    if (name === "write_to_file" || name === "replace_in_file") return [{ kind: "file", op: "write", path: resolve(a.path, cwd) }];
    return [];
  },
};

// What each agent expects on stdout for the events we use.
const OUTPUT = {
  gemini: () => "{}",                                      // stdout must be JSON
  cline: () => JSON.stringify({ cancel: false }),         // control JSON
  cursor: (event) => (/^before/.test(event || "") ? JSON.stringify({ permission: "allow" }) : ""),
};

/** payload → neutral events (exported for tests). */
function parse(agent, payload, event) {
  const fn = PARSERS[agent];
  if (!fn || !payload || typeof payload !== "object") return [];
  try { return (fn(payload, event) || []).filter((e) => (e.kind === "file" ? !!e.path : !!e.tool)); } catch { return []; }
}

function run(agent, argv = process.argv.slice(2)) {
  const event = argv[0];
  // Print the expected answer first and unconditionally: the agent must never be blocked.
  const out = OUTPUT[agent] ? OUTPUT[agent](event) : "";
  if (out) process.stdout.write(out);
  core.readStdinJson((payload) => {
    for (const evt of parse(agent, payload, event)) core.report(evt, agent);
  });
}

module.exports = { parse, run, AGENTS: Object.keys(PARSERS), patchPaths };
