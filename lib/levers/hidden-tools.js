"use strict";
/**
 * MCP proxy levers — lever 7, hideUnsupportedTools (0.4.12.4 split of lib/proxy-levers.js, see
 * that file's own top comment for the full picture). Per-client, per-session `tools/list`
 * filtering. Pure: no `cfg`/session state closed over, only passed in.
 */

// ---------------------------------------------------------------------------------------------
// Lever 7 — hideUnsupportedTools: per-client, per-session `tools/list` filtering.

/** A client is "known" once it has said a non-empty name or title in `initialize` — else caution: hide nothing. */
function clientInfoKnown(ci) {
  return !!(ci && ((typeof ci.name === "string" && ci.name.trim()) || (typeof ci.title === "string" && ci.title.trim())));
}

/**
 * Same rule as basic-memory's `client_info_is_openai_mcp()`: the client's reported name OR
 * title, trimmed and lower-cased, equals one of `allow` or starts with it followed by "/"
 * (so "openai-mcp" matches a future "openai-mcp/1.2" the same way it does upstream).
 */
function clientInfoAllowed(ci, allow) {
  for (const key of ["name", "title"]) {
    const raw = ci && ci[key];
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    for (const a of allow) {
      const al = String(a).trim().toLowerCase();
      if (al && (v === al || v.startsWith(al + "/"))) return true;
    }
  }
  return false;
}

/**
 * tools.profile "minimal" (0.6.0): the compat / rarely used tools that leave `tools/list` by
 * default (they cost tool-schema tokens at every session start) but stay CALLABLE by name — this
 * only edits the listing. `search` and `fetch` (ChatGPT-style) stay listed for OpenAI's MCP client.
 */
const MINIMAL_HIDDEN_TOOLS = [
  "schema_infer", "schema_validate", "schema_diff", "create_memory_project", "delete_project",
  "list_memory_projects", "list_workspaces", "view_note", "read_content", "basic_memory_diagnostics",
  "search", "fetch",
];
const OPENAI_CLIENT = "openai-mcp";
function profileHiddenTools(clientInfo) {
  const hidden = new Set(MINIMAL_HIDDEN_TOOLS);
  if (clientInfoKnown(clientInfo) && clientInfoAllowed(clientInfo, [OPENAI_CLIENT])) { hidden.delete("search"); hidden.delete("fetch"); }
  return hidden;
}

function unsupportedTableFor(cfg, serverName) {
  const s = String(serverName || "").trim().toLowerCase();
  if (!s || !cfg.unsupportedTools) return null;
  if (cfg.unsupportedTools[s]) return cfg.unsupportedTools[s];
  for (const [k, v] of Object.entries(cfg.unsupportedTools)) if (k && (s.includes(k) || k.includes(s))) return v;
  return null;
}

/**
 * Tool names to drop from `tools/list` for this client (lever 7), or null to drop none — no table for this
 * server, or the client never announced a name/title (unknown: never filtered, by design).
 */
function hiddenToolsFor(cfg, serverName, clientInfo) {
  const table = unsupportedTableFor(cfg, serverName);
  if (!table || !clientInfoKnown(clientInfo)) return null;
  const hidden = new Set();
  for (const [tool, allow] of Object.entries(table)) if (!clientInfoAllowed(clientInfo, allow)) hidden.add(tool);
  return hidden;
}



module.exports = { clientInfoKnown, clientInfoAllowed, unsupportedTableFor, hiddenToolsFor, profileHiddenTools, MINIMAL_HIDDEN_TOOLS };
