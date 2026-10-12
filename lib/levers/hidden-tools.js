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
 * Lever 8 rule 1 (alreadyLoadedExemptClients) — true when this session's clientInfo `name` OR
 * `title` CONTAINS any of `substrings`, case-insensitively. Deliberately a substring match, unlike
 * clientInfoAllowed's exact-id-or-prefix match above: an injection hook's clientInfo is whatever
 * the host happens to send (e.g. "session-start-hook", "my-app/inject-memory"), never one of
 * memglow's own known client ids, so "hook"/"inject" alone has to catch it. No clientInfo at all
 * never matches (nothing to search) — rule 2 is what still protects an unnamed injector.
 */
function clientInfoExempt(ci, substrings) {
  if (!ci || !Array.isArray(substrings) || !substrings.length) return false;
  const hay = `${typeof ci.name === "string" ? ci.name : ""} ${typeof ci.title === "string" ? ci.title : ""}`.trim().toLowerCase();
  if (!hay) return false;
  for (const raw of substrings) {
    const needle = String(raw || "").trim().toLowerCase();
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}

/** The unsupported-tools table entry for this upstream server name, or null (nothing configured for it). */
function unsupportedTableFor(cfg, serverName) {
  const s = String(serverName || "").trim().toLowerCase();
  if (!s || !cfg.unsupportedTools) return null;
  if (cfg.unsupportedTools[s]) return cfg.unsupportedTools[s];
  for (const [k, v] of Object.entries(cfg.unsupportedTools)) if (k && (s.includes(k) || k.includes(s))) return v;
  return null;
}

/**
 * Tool names to drop from `tools/list` for this client, or null to drop none — no table for this
 * server, or the client never announced a name/title (unknown: never filtered, by design).
 */
function hiddenToolsFor(cfg, serverName, clientInfo) {
  const table = unsupportedTableFor(cfg, serverName);
  if (!table || !clientInfoKnown(clientInfo)) return null;
  const hidden = new Set();
  for (const [tool, allow] of Object.entries(table)) if (!clientInfoAllowed(clientInfo, allow)) hidden.add(tool);
  return hidden;
}



module.exports = { clientInfoKnown, clientInfoAllowed, clientInfoExempt, unsupportedTableFor, hiddenToolsFor };
