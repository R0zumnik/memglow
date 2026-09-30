#!/usr/bin/env node
"use strict";
/**
 * memglow MCP proxy — put it in front of ANY memory MCP server (basic-memory, the filesystem
 * server, an Obsidian server…) and every MCP client that talks to it (Claude Desktop, Claude Code,
 * Cursor, Codex, Gemini CLI, Cline, Continue, Roo, Windsurf, Copilot…) lights memglow up, with no
 * hook needed on the client side.
 *
 * It relays bytes unchanged in both directions and only *watches* them: for each `tools/call`
 * it matches the request with its response and reports read / search / write + note ids (never
 * content) to memglow, through lib/agent-core.js (detached, 3 s timeout, silent).
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
function createWatcher({ server, source = "mcp", onReport = (evt) => core.report(evt, source) }) {
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

function runStdio(o) {
  if (!o.cmd.length) { process.stderr.write("memglow-mcp-proxy: nothing to run (usage: memglow-mcp-proxy -- <server command>)\n"); process.exit(2); }
  const server = o.name || o.cmd.join(" ").match(/[A-Za-z0-9_-]*(memory|obsidian|notes|filesystem)[A-Za-z0-9_-]*/i)?.[0] || "memory";
  const w = createWatcher({ server, source: o.source });
  const child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  const fromClient = lineTap((m) => w.fromClient(m));
  const fromServer = lineTap((m) => w.fromServer(m));
  process.stdin.on("data", (c) => { child.stdin.write(c); try { fromClient(c); } catch { /* keep relaying */ } });
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.on("data", (c) => { process.stdout.write(c); try { fromServer(c); } catch { /* keep relaying */ } });
  child.on("error", (e) => { process.stderr.write(`memglow-mcp-proxy: cannot start ${o.cmd[0]}: ${e.message}\n`); process.exit(127); });
  child.on("exit", (code, sig) => process.exit(code == null ? (sig ? 1 : 0) : code));
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
  return http.createServer((req, res) => {
    const w = createWatcher({ server, source: o.source, onReport: o.onReport });
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length) { try { w.fromClient(JSON.parse(body.toString("utf8"))); } catch { /* not JSON */ } }
      const headers = hopless(req.headers);
      delete headers.host; delete headers["content-length"];
      if (body.length) headers["content-length"] = String(body.length);
      const target = new URL(up.href);
      const incoming = new URL(req.url, "http://x");
      incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      const pr = lib.request(target, { method: req.method, headers }, (ur) => {
        res.writeHead(ur.statusCode || 502, hopless(ur.headers));
        const type = String(ur.headers["content-type"] || "");
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
    process.stdout.write("usage:\n  memglow-mcp-proxy [--name NAME] -- <memory MCP server command>\n  memglow-mcp-proxy --upstream URL --listen HOST:PORT [--name NAME]\n");
    process.exit(0);
  }
  if (o.upstream) {
    const [host, port] = (o.listen || "127.0.0.1:8765").split(":");
    createHttpProxy(o).listen(Number(port), host || "127.0.0.1", () =>
      process.stderr.write(`memglow-mcp-proxy: http://${host || "127.0.0.1"}:${port} -> ${o.upstream}\n`));
  } else runStdio(o);
}

module.exports = { createWatcher, createHttpProxy, lineTap, sseTap, parseArgs };
