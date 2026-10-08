"use strict";
/**
 * memglow memory server — JSON-RPC 2.0 dispatcher, transport-agnostic: `handle(msg, ctx)` returns
 * the response object, or null for a notification / a message that needs no answer. Used by the
 * HTTP transport (memory-server/http.js) and the stdio one (memory-server/memglow-memory-server.js).
 *
 * Protocol versions: a legacy client sends `initialize` (2024-11-05 … 2025-11-25) and gets the
 * version it asked for when known. An MCP 2026-07-28 client sends no `initialize`: each request
 * names its version (header MCP-Protocol-Version, or params._meta
 * "io.modelcontextprotocol/protocolVersion"); such answers carry `resultType: "complete"`. Missing
 * `_meta` is never an error.
 */
const { SERVER_VERSION } = require("./tools");

const LEGACY_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const MODERN_VERSIONS = ["2026-07-28"];
const SUPPORTED_VERSIONS = LEGACY_VERSIONS.concat(MODERN_VERSIONS);
const LATEST_LEGACY = "2025-11-25";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const INSTRUCTIONS_BASE = "memglow memory server: the user's long-term Markdown memory (one project, \"main\"). "
  + "Find notes with search_notes (words, \"phrases\", AND/OR/NOT, tag:x; search_type title or permalink for exact lookups), "
  + "read one with read_note (permalink, title or memory:// URL), follow links with build_context, see what changed with recent_activity, browse with list_directory. ";
const INSTRUCTIONS = INSTRUCTIONS_BASE + "This preview is read-only: write_note, edit_note, move_note and delete_note answer an error.";
const INSTRUCTIONS_RW = INSTRUCTIONS_BASE + "Write with write_note (new note; overwrite=true to replace one), change a note with edit_note (append, prepend, find_replace, replace_section, insert_before_section, insert_after_section; metadata merges frontmatter keys), "
  + "move_note to move or rename, delete_note to delete (deleted notes go to a trash folder).";

/** The protocol version a request runs under: header, then params._meta, then the session's. */
function versionOf(msg, ctx = {}) {
  const meta = msg && msg.params && msg.params._meta;
  const fromMeta = meta && typeof meta === "object" ? meta[META_VERSION] : null;
  return (typeof ctx.headerVersion === "string" && ctx.headerVersion) || (typeof fromMeta === "string" && fromMeta) || ctx.sessionVersion || null;
}
const isModern = (v) => typeof v === "string" && v >= "2026-";

function createRpc({ tools, name = "memglow-memory", version = SERVER_VERSION, instructions = INSTRUCTIONS }) {
  const serverInfo = { name, title: "memglow memory server", version };
  const capabilities = { tools: { listChanged: false }, resources: {}, prompts: {} };

  function ok(id, result, modern) {
    return { jsonrpc: "2.0", id, result: modern ? { ...result, resultType: "complete" } : result };
  }
  function err(id, code, message, data) {
    const e = { code, message };
    if (data !== undefined) e.data = data;
    return { jsonrpc: "2.0", id: id === undefined ? null : id, error: e };
  }

  /** handle(msg, ctx) → response | null. ctx: { headerVersion, sessionVersion, onInitialize(version) }. */
  function handle(msg, ctx = {}) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return err(null, -32600, "Invalid Request");
    const { id, method, params } = msg;
    if (typeof method !== "string") return null; // a response from the client, or junk: nothing to answer
    const isNotification = id === undefined;
    if (isNotification) return null; // notifications/initialized, notifications/cancelled…
    const v = versionOf(msg, ctx);
    const modern = isModern(v);
    // A request that names a protocol version this server does not speak gets a clear error
    // (initialize negotiates through its own params instead). No version at all is fine.
    if (method !== "initialize" && typeof v === "string" && v && !SUPPORTED_VERSIONS.includes(v)) {
      return err(id, -32602, `Unsupported protocol version: ${v}`, { supported: SUPPORTED_VERSIONS, requested: v });
    }
    try {
      switch (method) {
        case "initialize": {
          const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
          const protocolVersion = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_LEGACY;
          if (typeof ctx.onInitialize === "function") ctx.onInitialize(protocolVersion);
          return ok(id, { protocolVersion, capabilities, serverInfo, instructions }, isModern(protocolVersion));
        }
        case "server/discover":
          return ok(id, { supportedVersions: SUPPORTED_VERSIONS, protocolVersion: modern ? v : MODERN_VERSIONS[0], capabilities, serverInfo, instructions }, true);
        case "ping":
          return ok(id, {}, modern);
        case "tools/list": {
          const r = { tools: tools.tools };
          if (modern) { r.cacheScope = "private"; r.ttlMs = 0; }
          return ok(id, r, modern);
        }
        case "tools/call": {
          if (!params || typeof params !== "object" || typeof params.name !== "string") return err(id, -32602, "Invalid params: \"name\" is required");
          const result = tools.call(params.name, params.arguments);
          if (!result) return err(id, -32602, `Unknown tool: ${params.name}`);
          if (typeof result.then === "function") {
            // A write: answered once it is done (the HTTP and stdio transports await it).
            return result.then((r) => ok(id, r, modern), (e) => err(id, -32603, `Internal error: ${e && e.message}`));
          }
          return ok(id, result, modern);
        }
        case "resources/list": return ok(id, { resources: [] }, modern);
        case "resources/templates/list": return ok(id, { resourceTemplates: [] }, modern);
        case "prompts/list": return ok(id, { prompts: [] }, modern);
        case "logging/setLevel": return ok(id, {}, modern);
        case "completion/complete": return ok(id, { completion: { values: [], total: 0, hasMore: false } }, modern);
        default: return err(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return err(id, -32603, `Internal error: ${e && e.message}`);
    }
  }

  /**
   * A batch (array) → array of responses (possibly empty); a single message → response | null.
   * When a write tool is involved the answer is a Promise of the same (reads stay synchronous).
   */
  function handleAny(payload, ctx = {}) {
    if (Array.isArray(payload)) {
      if (!payload.length) return err(null, -32600, "Invalid Request: empty batch");
      const outs = payload.map((m) => handle(m, ctx));
      if (outs.some((o) => o && typeof o.then === "function")) return Promise.all(outs).then((a) => a.filter(Boolean));
      return outs.filter(Boolean);
    }
    return handle(payload, ctx);
  }

  return { handle, handleAny, serverInfo };
}

module.exports = { createRpc, versionOf, SUPPORTED_VERSIONS, LEGACY_VERSIONS, MODERN_VERSIONS, INSTRUCTIONS, INSTRUCTIONS_RW };
