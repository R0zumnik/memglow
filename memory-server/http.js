"use strict";
/**
 * memglow memory server — Streamable HTTP transport on `/mcp` (POST only).
 *
 *  - Legacy sessions: `initialize` answers with an `Mcp-Session-Id` header; later requests may
 *    send it back. An unknown or missing session id is accepted (no 404): reads need no session
 *    state, and a client whose session was lost to a server restart keeps working.
 *  - MCP 2026-07-28 per-request mode: no session, version in the `MCP-Protocol-Version` header
 *    and/or `params._meta`. 0.5.3: Claude Code opens a NEW TCP connection between calls even
 *    within the same conversation, so the per-connection fallback alone gave the all-in-one
 *    layer's per-session levers (lib/proxy-levers.js: alreadyLoaded, dedupe, deltaRead…) a fresh
 *    key on every call — never a repeat, 0 tokens saved. A request may now carry its own
 *    `x-memglow-session` header (validated: 8-128 characters of [A-Za-z0-9._:-], else ignored),
 *    sent by Claude Code's `headersHelper` mechanism (hooks/memglow-headers.js) from its own
 *    per-conversation `CLAUDE_CODE_SESSION_ID` — see sessionKeyFor() below and the README.
 *  - Answers `application/json`; a client whose Accept lists only `text/event-stream` gets one SSE
 *    `event: message`. Notifications (and client responses) → 202. Batches are answered as arrays.
 *  - GET /mcp → 405 (no server-initiated stream), DELETE /mcp → ends a session, GET /healthz → a
 *    small JSON status.
 *  - Every request is handled on its own: read tools are synchronous and fast; a write tool's
 *    answer is awaited (writes queue among themselves, never in front of reads). A request that cannot be parsed (bad request-target, bad JSON, too
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

// Per-connection keys for stateless (MCP 2026-07-28) requests: one TCP connection, one key.
const connKeys = new WeakMap();
let connN = 0;
function connKey(socket) {
  if (!socket) return "conn:none";
  let k = connKeys.get(socket);
  if (!k) { k = "conn:" + (++connN); connKeys.set(socket, k); }
  return k;
}

/** True for an `initialize` that opens a legacy session (rpc.js: an unknown version falls back to legacy). */
function opensSession(m) {
  if (!m || typeof m !== "object" || m.method !== "initialize" || m.id === undefined) return false;
  const v = m.params && typeof m.params.protocolVersion === "string" ? m.params.protocolVersion : null;
  return !(v && SUPPORTED_VERSIONS.includes(v) && v >= "2026-");
}

// 0.5.3: validates the `x-memglow-session` header (see sessionKeyFor below) — 8-128 characters
// of [A-Za-z0-9._:-] once trimmed (a UUID, e.g. CLAUDE_CODE_SESSION_ID, comfortably fits); any
// other shape (too short/long, stray characters, not a string at all) is simply ignored, never
// an error — this header is advisory, never required.
const HEADER_SID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
function validHeaderSid(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return HEADER_SID_RE.test(s) ? s : null;
}

/**
 * The session key the all-in-one layer (memory-server/all-in-one.js) uses for this request —
 * ignored by the plain server: for an `initialize` that opens a session, the id that session is
 * about to get (a re-initialize under a known id gets a NEW id: its key follows); else the
 * Mcp-Session-Id when one is sent; else (0.5.3) a validated `x-memglow-session` header
 * (validHeaderSid above), "hdr:" prefixed; else (a stateless request with neither) one key per
 * TCP connection — never a single key shared by every client. Distinct prefixes ("sid:"/"hdr:"/
 * "conn:") mean a client-chosen session id, a header value and a connection key can never
 * collide with one another. `hdrSid` is passed in already validated (the call site reads
 * `req.headers["x-memglow-session"]` through validHeaderSid) so this function stays pure/testable
 * without needing a real `req.headers`.
 */
function sessionKeyFor(req, sid, payload, propose, hdrSid) {
  if ((Array.isArray(payload) ? payload : [payload]).some(opensSession)) return "sid:" + propose();
  if (sid) return "sid:" + sid;
  if (hdrSid) return "hdr:" + hdrSid;
  return connKey(req.socket);
}

function createHttpServer({ rpc, store, path: mcpPath = "/mcp", log = () => {}, allowOrigins = [], token = "", readOnly = true, fsyncMode = null }) {
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
    // 0.4.7.6 (minor 7): whether THIS request is authenticated, computed once and reused below —
    // GET /healthz stays reachable without a token (so a load balancer / the control panel can
    // always tell "is it up"), but an UNAUTHENTICATED caller, when a token IS configured, only
    // ever sees `ok`/`version`/`notes`: `readOnly`/`tokenRequired` (booleans, never the token
    // itself) are informative enough about this server's OWN setup that they wait for the same
    // Bearer token every other request already needs. No token configured at all → nothing to
    // gate, the full answer is shown either way (matches lib/setup.js memoryServerStatus()'s own
    // shape, which reads exactly these fields).
    const authed = !token || (() => {
      const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
      return !!m && sameToken(m[1].trim(), token);
    })();
    if (p === "/healthz" && req.method === "GET") {
      const s = store ? store.stats() : {};
      const base = { ok: true, version: rpc.serverInfo.version, notes: s.notes };
      if (!authed) return send(res, 200, base);
      return send(res, 200, {
        ...base, name: rpc.serverInfo.name,
        indexVersion: s.version, lastScanAt: s.lastScanAt ? new Date(s.lastScanAt).toISOString() : null,
        readOnly: !!readOnly, tokenRequired: !!token,
        ...(fsyncMode ? { fsyncMode } : {}),
      });
    }
    if (!authed) {
      return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized: a valid Authorization: Bearer token is required" } }, { "www-authenticate": "Bearer" });
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
      // The id a legacy `initialize` will hand out, chosen up front so the all-in-one layer
      // (memory-server/all-in-one.js) can key that very request under the session it opens.
      let proposed = null;
      const propose = () => proposed || (proposed = sid && !sess ? sid : crypto.randomBytes(16).toString("hex"));
      const ctx = {
        headerVersion: req.headers["mcp-protocol-version"] ? String(req.headers["mcp-protocol-version"]) : null,
        sessionVersion: sess ? sess.version : null,
        sessionKey: sessionKeyFor(req, sid, payload, propose, validHeaderSid(req.headers["x-memglow-session"])),
        // 0.4.10.9: the all-in-one layer's last-resort client identity (accounting only).
        userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]).slice(0, 200) : null,
        onInitialize: (version) => {
          if (version >= "2026-") return; // per-request mode: no session
          newSession = propose();
          rememberSession(newSession, version);
        },
      };
      let out;
      try { out = rpc.handleAny(payload, ctx); }
      catch (e) { out = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error: " + (e && e.message) } }; }
      const finish = (o) => {
        const headers = newSession ? { "mcp-session-id": newSession } : {};
        if (res.writableEnded || res.destroyed) return;
        if (o == null || (Array.isArray(o) && !o.length)) return send(res, 202, null, headers);
        return send(res, 200, o, headers, sse);
      };
      if (out && typeof out.then === "function") {
        out.then(finish, (e) => finish({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error: " + (e && e.message) } }))
          .catch((e) => log("memglow memory server: request failed: " + (e && e.message)));
        return;
      }
      return finish(out);
    }
  }
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.sessions = sessions;
  return server;
}

module.exports = { createHttpServer, wantsSseOnly, sessionKeyFor, connKey, validHeaderSid, HEADER_SID_RE };
