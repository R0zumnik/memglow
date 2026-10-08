"use strict";
/**
 * memglow memory server — Streamable HTTP transport on `/mcp` (POST only).
 *
 *  - Legacy sessions: `initialize` answers with an `Mcp-Session-Id` header; later requests may
 *    send it back. An unknown or missing session id is accepted (no 404): reads need no session
 *    state, and a client whose session was lost to a server restart keeps working.
 *  - MCP 2026-07-28 per-request mode: no session, version in the `MCP-Protocol-Version` header
 *    and/or `params._meta`.
 *  - Answers `application/json`; a client whose Accept lists only `text/event-stream` gets one SSE
 *    `event: message`. Notifications (and client responses) → 202. Batches are answered as arrays.
 *  - GET /mcp → 405 (no server-initiated stream), DELETE /mcp → ends a session, GET /healthz → a
 *    small JSON status.
 *  - Every request is handled on its own: the tools are synchronous and fast, nothing queues
 *    behind a slow operation. A request that cannot be parsed (bad request-target, bad JSON, too
 *    large, unsupported MCP-Protocol-Version) gets a 4xx; nothing a client sends can throw out of
 *    the handler.
 *  - Security (MCP spec, DNS rebinding): a request carrying an `Origin` header is refused (403)
 *    unless that origin is in `allowOrigins` (default: none). Requests without Origin — what CLI
 *    and MCP clients send — are allowed. With `token` set, every request except GET /healthz needs
 *    `Authorization: Bearer <token>` (401 otherwise).
 */
const http = require("http");
const crypto = require("crypto");
const { SUPPORTED_VERSIONS } = require("./rpc");

const MAX_BODY = 10 * 1024 * 1024;
const MAX_SESSIONS = 5000;

function wantsSseOnly(accept) {
  const a = String(accept || "").toLowerCase();
  if (!a) return false;
  return a.includes("text/event-stream") && !a.includes("application/json") && !a.includes("*/*") && !a.includes("application/*");
}

/**
 * Stop a request whose body is refused: it is no longer read (paused), the 413 is sent with
 * "Connection: close", and the socket is destroyed shortly after — not at once, so the client can
 * still read the 413 before the connection goes (an immediate destroy with unread data pending
 * makes the kernel reset the connection, and the answer can be lost).
 */
function dropSoon(req) {
  try { req.socket.end(); } catch { /* ignore */ }
  const t = setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } }, 1000);
  if (t.unref) t.unref();
}

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createHttpServer({ rpc, store, path: mcpPath = "/mcp", log = () => {}, allowOrigins = [], token = "" }) {
  const origins = new Set((allowOrigins || []).map((o) => String(o).trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean));
  const sessions = new Map(); // id → { version, lastSeen }

  function send(res, status, body, headers = {}, sse = false) {
    if (body === undefined || body === null) {
      res.writeHead(status, { "content-length": "0", ...headers });
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    if (sse) {
      const out = "event: message\ndata: " + json + "\n\n";
      res.writeHead(status, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "content-length": String(Buffer.byteLength(out)), ...headers });
      res.end(out);
      return;
    }
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), ...headers });
    res.end(json);
  }

  function rememberSession(id, version) {
    if (sessions.size >= MAX_SESSIONS) {
      // Drop the least recently seen tenth.
      const old = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, Math.ceil(MAX_SESSIONS / 10));
      for (const [k] of old) sessions.delete(k);
    }
    sessions.set(id, { version, lastSeen: Date.now() });
  }

  const server = http.createServer((req, res) => {
    try { handle(req, res); }
    catch (e) {
      log("memglow memory server: request failed: " + (e && e.message));
      try { if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }); else res.destroy(); } catch { /* socket gone */ }
    }
  });

  function handle(req, res) {
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad request-target" } }); }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(String(origin).trim().replace(/\/+$/, "").toLowerCase())) {
      return send(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Forbidden: Origin ${String(origin).slice(0, 200)} is not allowed` } });
    }
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === "/healthz" && req.method === "GET") {
      const s = store ? store.stats() : {};
      return send(res, 200, { ok: true, name: rpc.serverInfo.name, version: rpc.serverInfo.version, notes: s.notes, indexVersion: s.version, lastScanAt: s.lastScanAt ? new Date(s.lastScanAt).toISOString() : null });
    }
    if (token) {
      const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
      if (!m || !sameToken(m[1].trim(), token)) {
        return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized: a valid Authorization: Bearer token is required" } }, { "www-authenticate": "Bearer" });
      }
    }
    if (p !== mcpPath && !(p === "/" && mcpPath === "/")) {
      return send(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Not found: ${url.pathname} (the MCP endpoint is ${mcpPath})` } });
    }
    if (req.method === "GET") return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed: this server does not open server-to-client streams" } }, { allow: "POST, DELETE" });
    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (sid) sessions.delete(String(sid));
      return send(res, 200, null);
    }
    if (req.method === "OPTIONS") return send(res, 204, null, { allow: "POST, DELETE, GET" });
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Method not allowed: ${req.method}` } }, { allow: "POST, DELETE" });

    const chunks = [];
    let size = 0, tooBig = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.pause();
      res.on("finish", () => dropSoon(req));
      send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } }, { connection: "close" });
      return;
    }
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Stop reading at once: answer 413 and drop the connection.
        tooBig = true;
        chunks.length = 0;
        req.pause();
        res.on("finish", () => dropSoon(req));
        try { send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } }, { connection: "close" }); } catch { req.destroy(); }
      } else chunks.push(c);
    });
    req.on("error", () => { /* client went away */ });
    req.on("end", () => { try { onBody(); } catch (e) { log("memglow memory server: request failed: " + (e && e.message)); if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }); } });
    function onBody() {
      if (tooBig) return;
      const sse = wantsSseOnly(req.headers.accept);
      const hv = req.headers["mcp-protocol-version"] ? String(req.headers["mcp-protocol-version"]) : null;
      if (hv && !SUPPORTED_VERSIONS.includes(hv)) {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32602, message: `Unsupported protocol version: ${hv.slice(0, 50)}`, data: { supported: SUPPORTED_VERSIONS, requested: hv.slice(0, 50) } } }, {}, sse);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not valid JSON" } }, {}, sse); }

      const sid = req.headers["mcp-session-id"] ? String(req.headers["mcp-session-id"]) : null;
      const sess = sid ? sessions.get(sid) : null;
      if (sess) sess.lastSeen = Date.now();
      let newSession = null;
      const ctx = {
        headerVersion: req.headers["mcp-protocol-version"] ? String(req.headers["mcp-protocol-version"]) : null,
        sessionVersion: sess ? sess.version : null,
        onInitialize: (version) => {
          if (version >= "2026-") return; // per-request mode: no session
          newSession = sid && !sess ? sid : crypto.randomBytes(16).toString("hex");
          rememberSession(newSession, version);
        },
      };
      let out;
      try { out = rpc.handleAny(payload, ctx); }
      catch (e) { out = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error: " + (e && e.message) } }; }
      const headers = newSession ? { "mcp-session-id": newSession } : {};
      if (out == null || (Array.isArray(out) && !out.length)) return send(res, 202, null, headers);
      return send(res, 200, out, headers, sse);
    }
  }
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.sessions = sessions;
  return server;
}

module.exports = { createHttpServer, wantsSseOnly };
