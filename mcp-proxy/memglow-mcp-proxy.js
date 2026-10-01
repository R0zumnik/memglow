#!/usr/bin/env node
"use strict";
/**
 * memglow MCP proxy — put it in front of ANY memory MCP server (basic-memory, the filesystem
 * server, an Obsidian server…) and every MCP client that talks to it (Claude Desktop, Claude Code,
 * Cursor, Codex, Gemini CLI, Cline, Continue, Roo, Windsurf, Copilot…) lights memglow up, with no
 * hook needed on the client side.
 *
 * It watches the traffic: for each `tools/call` it matches the request with its response and
 * reports read / search / write + note ids (never content) to memglow, through lib/agent-core.js
 * (detached, 3 s timeout, silent).
 *
 * v0.4 levers (lib/proxy-levers.js; switches in memglow.config.json → "proxy", or MEMGLOW_PROXY_*):
 * size warning, richer search results and related-note suggestions (ON by default) only ADD a text
 * block before/after the server's own content; session read de-duplication and table-of-contents
 * first (OFF by default) may replace a read answer. With every lever off, bytes are relayed
 * unchanged, as before; with levers on, only whole JSON-RPC lines a lever rewrites differ. Nothing
 * is ever written in the notes folder.
 *
 *   stdio:  memglow-mcp-proxy [--name basic-memory] -- uvx basic-memory mcp
 *   HTTP:   memglow-mcp-proxy --upstream http://127.0.0.1:8000/mcp --listen 127.0.0.1:8765 [--name x]
 *           (then point the client at http://127.0.0.1:8765/mcp)
 *
 * Tool → activity mapping is generic (read/view/fetch → read, search/find/query → search,
 * write/edit/create/move/delete → write); override with MEMGLOW_PROXY_MAP, a JSON object
 * { "<tool name>": "read"|"search"|"write"|"ignore" }.
 */
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const core = require("../lib/agent-core");
const levers = require("../lib/proxy-levers");
const { StringDecoder } = require("string_decoder");

function parseArgs(argv) {
  const o = { name: "", upstream: "", listen: "", source: "mcp", cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o.cmd = argv.slice(i + 1); break; }
    if (a === "--name") o.name = argv[++i] || "";
    else if (a === "--upstream") o.upstream = argv[++i] || "";
    else if (a === "--listen") o.listen = argv[++i] || "";
    else if (a === "--source") o.source = argv[++i] || "mcp";
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}

function userMap() {
  try { const m = JSON.parse(process.env.MEMGLOW_PROXY_MAP || "{}"); return m && typeof m === "object" ? m : {}; } catch { return {}; }
}

/**
 * Watches JSON-RPC messages: remembers tools/call requests, reports when the matching response
 * arrives. Messages it cannot parse are ignored (they are relayed anyway).
 */
function createWatcher({ server, source = "mcp", onReport = (evt) => core.report(evt, source, { channel: "mcp-proxy" }) }) {
  const pending = new Map();
  const map = userMap();
  function each(msg, fn) { if (Array.isArray(msg)) msg.forEach(fn); else if (msg && typeof msg === "object") fn(msg); }
  return {
    fromClient(msg) {
      each(msg, (m) => {
        if (m.method === "tools/call" && m.id != null && m.params && typeof m.params.name === "string") {
          pending.set(String(m.id), { tool: m.params.name, args: m.params.arguments || {} });
          if (pending.size > 1000) pending.delete(pending.keys().next().value);
        }
      });
    },
    fromServer(msg) {
      each(msg, (m) => {
        if (m.id == null || !pending.has(String(m.id))) return;
        const call = pending.get(String(m.id));
        pending.delete(String(m.id));
        if (m.error || (m.result && m.result.isError)) return; // failed calls change nothing
        const forced = map[call.tool];
        if (forced === "ignore") return;
        const tool = ["read", "search", "write"].includes(forced) ? forced : call.tool;
        onReport({ kind: "mcp", trusted: true, server, tool, args: call.args, result: m.result });
      });
    },
  };
}

/** Newline-delimited JSON tap (stdio transport). */
function lineTap(fn) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { fn(JSON.parse(line)); } catch { /* not JSON: ignore */ } }
    }
    if (buf.length > 20 * 1024 * 1024) buf = ""; // pathological line: stop watching it
  };
}

/**
 * Newline-delimited relay that can rewrite whole JSON-RPC lines (stdio transport, levers on).
 * Works on Buffers: a line nobody rewrites is written back byte for byte. `transform(msg)` returns
 * a replacement string (without the newline) or null to keep the line. A line longer than `max`
 * is relayed raw, unparsed.
 */
function lineRelay(write, transform, max = 20 * 1024 * 1024) {
  let parts = [], size = 0, raw = false;
  function emit(line) {
    let out = null;
    const txt = line.toString("utf8").trim();
    if (txt) { try { out = transform(JSON.parse(txt)); } catch { out = null; } }
    write(out != null ? Buffer.from(out + "\n", "utf8") : line);
  }
  return {
    push(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      let start = 0, i;
      while ((i = b.indexOf(10, start)) >= 0) {
        const piece = b.subarray(start, i + 1);
        if (raw) { write(piece); raw = false; }
        else { parts.push(piece); const line = Buffer.concat(parts); parts = []; size = 0; emit(line); }
        start = i + 1;
      }
      const rest = b.subarray(start);
      if (!rest.length) return;
      if (raw) { write(rest); return; }
      parts.push(rest); size += rest.length;
      if (size > max) { write(Buffer.concat(parts)); parts = []; size = 0; raw = true; }
    },
    end() { if (parts.length) { write(Buffer.concat(parts)); parts = []; size = 0; } },
  };
}

/**
 * Server-sent events relay that can rewrite the JSON `data:` of an event (HTTP transport, levers
 * on). Events nobody rewrites are written back unchanged, with their original separator.
 */
function sseRelay(write, transform) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  function flushBlocks() {
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const blockText = buf.slice(0, m.index), sep = m[0];
      buf = buf.slice(m.index + sep.length);
      const lines = blockText.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      let out = null;
      if (data) { try { out = transform(JSON.parse(data)); } catch { out = null; } }
      if (out == null) write(blockText + sep);
      else write(lines.filter((l) => !l.startsWith("data:")).concat("data: " + out).join("\n") + "\n\n");
    }
  }
  return {
    push(chunk) { buf += dec.write(chunk); flushBlocks(); },
    end() { buf += dec.end(); if (buf) { write(buf); buf = ""; } },
  };
}

/**
 * The v0.4 levers (lib/proxy-levers.js), or null when every lever is off (pure byte relay, as
 * before). Never throws: a broken config means "no levers".
 */
function setupLevers(env = process.env) {
  try {
    const config = levers.proxyConfig(env);
    if (!levers.anyLever(config)) return null;
    const index = levers.createNoteIndex(config);
    const savings = levers.createSavings(config);
    const engine = levers.createLevers({ config, index, savings });
    return { ...engine, savings, config };
  } catch (e) {
    process.stderr.write(`memglow-mcp-proxy: levers disabled (${e.message})\n`);
    return null;
  }
}

function runStdio(o) {
  if (!o.cmd.length) { process.stderr.write("memglow-mcp-proxy: nothing to run (usage: memglow-mcp-proxy -- <server command>)\n"); process.exit(2); }
  const server = o.name || o.cmd.join(" ").match(/[A-Za-z0-9_-]*(memory|obsidian|notes|filesystem)[A-Za-z0-9_-]*/i)?.[0] || "memory";
  const w = createWatcher({ server, source: o.source });
  const lv = setupLevers();
  const child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  if (lv) {
    // Levers on: whole lines are relayed (rewritten only when a lever changes them).
    const up = lineRelay((b) => child.stdin.write(b), (m) => {
      try { w.fromClient(m); } catch { /* keep relaying */ }
      const r = lv.clientMessage(m);
      return r.changed ? JSON.stringify(r.msg) : null;
    });
    const down = lineRelay((b) => process.stdout.write(b), (m) => {
      try { w.fromServer(m); } catch { /* keep relaying */ }
      const r = lv.serverMessage(m);
      return r.changed ? JSON.stringify(r.msg) : null;
    });
    process.stdin.on("data", (c) => up.push(c));
    process.stdin.on("end", () => { up.end(); child.stdin.end(); });
    child.stdout.on("data", (c) => down.push(c));
    child.stdout.on("end", () => down.end());
    process.on("exit", () => lv.savings.flush());
  } else {
    const fromClient = lineTap((m) => w.fromClient(m));
    const fromServer = lineTap((m) => w.fromServer(m));
    process.stdin.on("data", (c) => { child.stdin.write(c); try { fromClient(c); } catch { /* keep relaying */ } });
    process.stdin.on("end", () => child.stdin.end());
    child.stdout.on("data", (c) => { process.stdout.write(c); try { fromServer(c); } catch { /* keep relaying */ } });
  }
  child.on("error", (e) => { process.stderr.write(`memglow-mcp-proxy: cannot start ${o.cmd[0]}: ${e.message}\n`); process.exit(127); });
  // "close" (not "exit"): all of the server's output has been relayed by then.
  child.on("close", (code, sig) => process.exit(code == null ? (sig ? 1 : 0) : code));
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
}

/** Server-sent events tap: feeds each `data:` payload to fn. */
function sseTap(fn) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) { try { fn(JSON.parse(data)); } catch { /* ignore */ } }
    }
    if (buf.length > 20 * 1024 * 1024) buf = "";
  };
}

// Hop-by-hop headers belong to one connection and must not be forwarded (RFC 9110 §7.6.1).
const HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"];
function hopless(h) {
  const out = { ...h };
  for (const k of HOP) delete out[k];
  return out;
}

function createHttpProxy(o) {
  const up = new URL(o.upstream);
  const lib = up.protocol === "https:" ? https : http;
  const server = o.name || up.hostname;
  const lv = o.levers === undefined ? setupLevers() : o.levers; // tests pass their own (or null)
  return http.createServer((req, res) => {
    const w = createWatcher({ server, source: o.source, onReport: o.onReport });
    const sk = String(req.headers["mcp-session-id"] || "default");
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let wanted = false;
      if (body.length) {
        let parsed;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = undefined; /* not JSON */ }
        if (parsed !== undefined) {
          try { w.fromClient(parsed); } catch { /* keep relaying */ }
          if (lv) {
            const r = lv.clientMessage(parsed, sk);
            if (r.changed) body = Buffer.from(JSON.stringify(r.msg), "utf8");
            const ids = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => m && m.id);
            wanted = lv.wants(ids, sk);
          }
        }
      }
      const transform = (m) => {
        try { w.fromServer(m); } catch { /* ignore */ }
        const r = lv.serverMessage(m, sk);
        return r.changed ? JSON.stringify(r.msg) : null;
      };
      const headers = hopless(req.headers);
      delete headers.host; delete headers["content-length"];
      if (body.length) headers["content-length"] = String(body.length);
      const target = new URL(up.href);
      const incoming = new URL(req.url, "http://x");
      incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      const pr = lib.request(target, { method: req.method, headers }, (ur) => {
        const type = String(ur.headers["content-type"] || "");
        const encoded = !!ur.headers["content-encoding"] && ur.headers["content-encoding"] !== "identity";
        if (wanted && !encoded && (type.includes("json") || type.includes("text/event-stream"))) {
          // A lever awaits this answer: JSON is buffered then (maybe) rewritten; SSE event by event.
          const h = hopless(ur.headers);
          delete h["content-length"];
          if (type.includes("text/event-stream")) {
            res.writeHead(ur.statusCode || 502, h);
            const relay = sseRelay((s) => res.write(s), transform);
            ur.on("data", (c) => relay.push(c));
            ur.on("end", () => { relay.end(); res.end(); });
          } else {
            const parts = [];
            ur.on("data", (c) => parts.push(c));
            ur.on("end", () => {
              let out = Buffer.concat(parts);
              try { const t = transform(JSON.parse(out.toString("utf8"))); if (t != null) out = Buffer.from(t, "utf8"); } catch { /* relay as is */ }
              h["content-length"] = String(out.length);
              res.writeHead(ur.statusCode || 502, h);
              res.end(out);
            });
          }
          return;
        }
        res.writeHead(ur.statusCode || 502, hopless(ur.headers));
        const tap = type.includes("text/event-stream") ? sseTap((m) => w.fromServer(m)) : null;
        const jsonChunks = [];
        ur.on("data", (c) => {
          res.write(c);
          try { if (tap) tap(c); else if (type.includes("json")) jsonChunks.push(c); } catch { /* keep relaying */ }
        });
        ur.on("end", () => {
          res.end();
          if (jsonChunks.length) { try { w.fromServer(JSON.parse(Buffer.concat(jsonChunks).toString("utf8"))); } catch { /* ignore */ } }
        });
      });
      pr.on("error", (e) => {
        if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "memglow-mcp-proxy: upstream unreachable: " + e.message } }));
      });
      // client went away (e.g. closed an SSE stream): stop the upstream request too
      res.on("close", () => { if (!res.writableFinished) pr.destroy(); });
      pr.end(body);
    });
  });
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write("usage:\n  memglow-mcp-proxy [--name NAME] -- <memory MCP server command>\n  memglow-mcp-proxy --upstream URL --listen HOST:PORT [--name NAME]\nlevers (v0.4): MEMGLOW_PROXY_SIZE_WARNING, _SEARCH_DETAILS, _SUGGESTIONS (default on), MEMGLOW_PROXY_DEDUPE, _TOC, _ARCHIVE_HINT (default off)\n  or memglow.config.json → \"proxy\": { ... } — see mcp-proxy/README.md\n");
    process.exit(0);
  }
  if (o.upstream) {
    const [host, port] = (o.listen || "127.0.0.1:8765").split(":");
    createHttpProxy(o).listen(Number(port), host || "127.0.0.1", () =>
      process.stderr.write(`memglow-mcp-proxy: http://${host || "127.0.0.1"}:${port} -> ${o.upstream}\n`));
  } else runStdio(o);
}

module.exports = { createWatcher, createHttpProxy, lineTap, sseTap, lineRelay, sseRelay, setupLevers, parseArgs };
