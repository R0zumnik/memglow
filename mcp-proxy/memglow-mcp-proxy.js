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
 * (detached, 3 s timeout, silent), with the memory server's response time (`durationMs`, shown as
 * "Memory engine speed" in memglow's Memory cost panel).
 *
 * v0.4 levers (lib/proxy-levers.js; switches in memglow.config.json → "proxy", or MEMGLOW_PROXY_*):
 * size warning (ON) only ADDS a text block before/after the server's own content; richer search
 * results and related-note suggestions (OFF since stage 0.4.2.2) do the same; session read
 * de-duplication and table-of-contents first (OFF) may replace a read answer; hideUnsupportedTools
 * (OFF) removes, from `tools/list` and per client session, the tools a config table marks
 * unsupported for that client (e.g. basic-memory's ChatGPT-only `search`/`fetch`); multiQuery (ON
 * since stage 0.4.2.2b) turns a search call's `memglow_queries` into one upstream call PER
 * PHRASING, sequentially, merged into one reply (bypasses the normal 1-line-in/1-line-out relay
 * below for that one call — see runStdio's `sub`/`createSubCallSender` and createHttpProxy's
 * multiQuery branch). With every lever off, bytes are relayed unchanged, as before; with levers
 * on, only whole JSON-RPC lines a lever rewrites (or, for multiQuery, a request/reply pair it
 * replaces outright) differ. Nothing is ever written in the notes folder.
 *
 * memglow's built-in memory rules (lib/memory-rules.js) are NOT a lever: ON by default (off with
 * MEMGLOW_RULES=0, or rules.enabled=false in Settings), they add memglow's calibrated
 * memory-hygiene rules to the upstream server's `initialize` response `instructions` field — kept
 * if already present, separated by a header — once per session, independently of every lever
 * above. Nothing else in that response changes.
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
const learnedAliases = require("../lib/learned-aliases");
const memoryRules = require("../lib/memory-rules");
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

/** Monotonic milliseconds (a wall-clock change never makes a duration negative). */
function monoMs() { return Number(process.hrtime.bigint() / 1000n) / 1000; }

/**
 * Watches JSON-RPC messages: remembers tools/call requests, reports when the matching response
 * arrives, with the time the server took (`durationMs`). Messages it cannot parse are ignored
 * (they are relayed anyway).
 */
function createWatcher({ server, source = "mcp", onReport = (evt) => core.report(evt, source, { channel: "mcp-proxy" }), clock = monoMs }) {
  const pending = new Map();
  const map = userMap();
  function each(msg, fn) { if (Array.isArray(msg)) msg.forEach(fn); else if (msg && typeof msg === "object") fn(msg); }
  return {
    fromClient(msg) {
      each(msg, (m) => {
        if (m.method === "tools/call" && m.id != null && m.params && typeof m.params.name === "string") {
          // Engine speed: the clock starts when the request leaves the client side of the proxy and
          // stops when the matching response comes back from the server (durationMs, reported with
          // the activity; validated and bounded again by memglow — lib/engine-speed.js).
          pending.set(String(m.id), { tool: m.params.name, args: m.params.arguments || {}, t0: clock() });
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
        const durationMs = Math.max(0, Math.round(clock() - call.t0));
        onReport({ kind: "mcp", trusted: true, server, tool, args: call.args, result: m.result, durationMs });
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

// A transform may return this to mean "write nothing for this line at all" — distinct from
// `null` ("keep the original line unchanged"). Used by the multiQuery lever: the client's one
// request becomes several upstream calls (sent directly, bypassing this relay) and ONE merged
// reply (written directly too, once all of them answer) — so neither the original request line
// nor any of the synthetic sub-calls' response lines are relayed as is.
const SUPPRESS = Symbol("memglow-mcp-proxy: suppress this line");

/**
 * Newline-delimited relay that can rewrite whole JSON-RPC lines (stdio transport, levers on).
 * Works on Buffers: a line nobody rewrites is written back byte for byte. `transform(msg)` returns
 * a replacement string (without the newline) to rewrite the line, `SUPPRESS` to write nothing for
 * it, or null to keep it as is. A line longer than `max` is relayed raw, unparsed.
 */
function lineRelay(write, transform, max = 20 * 1024 * 1024) {
  let parts = [], size = 0, raw = false;
  function emit(line) {
    let out = null;
    const txt = line.toString("utf8").trim();
    if (txt) { try { out = transform(JSON.parse(txt)); } catch { out = null; } }
    if (out === SUPPRESS) return;
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
      if (out === SUPPRESS) { /* write nothing for this event */ }
      else if (out == null) write(blockText + sep);
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
 * before). Never throws: a broken config means "no levers". `serverName` (the proxy's `--name`,
 * or its guessed label) is only used by lever 7 (hideUnsupportedTools) to pick the right
 * `unsupportedTools` table entry for the server actually being wrapped.
 */
function setupLevers(env = process.env, serverName = "") {
  try {
    const config = levers.proxyConfig(env);
    if (!levers.anyLever(config)) return null;
    const index = levers.createNoteIndex(config);
    const savings = levers.createSavings(config);
    const aliasStore = learnedAliases.createAliasStore(config);
    const engine = levers.createLevers({ config, index, savings, serverName, aliasStore });
    return { ...engine, savings, aliasStore, config };
  } catch (e) {
    process.stderr.write(`memglow-mcp-proxy: levers disabled (${e.message})\n`);
    return null;
  }
}

/** memglow's built-in memory rules (not a lever): null when disabled (env, or the saved setting). */
function setupRules(env = process.env, rules = undefined) {
  if (rules !== undefined) return rules; // tests pass their own (or null)
  try { return memoryRules.createRulesRelay({ text: memoryRules.computeRulesText(env) }); } catch { return null; }
}

// Lever 9 (multiQuery): how long to wait for ONE upstream sub-call before failing that phrasing
// open (see runSearchCall in lib/proxy-levers.js) rather than hanging the client's call forever.
const MULTI_QUERY_TIMEOUT_MS = 20000;

/**
 * Sends the EXTRA upstream calls a multiQuery search makes on its own, outside the normal
 * request/response relay: `send(tool, args)` writes a `tools/call` with a synthetic id (never
 * colliding with a client id, which is always a number or a plain client-chosen string) and
 * resolves with `{result}|{error}` when the matching line arrives; `intercept(m)` is how the
 * caller recognises that line (so it can suppress it instead of relaying it to the client) —
 * false for every other message, which the caller keeps handling as usual.
 */
function createSubCallSender(write) {
  const pending = new Map();
  let n = 0;
  return {
    intercept(m) {
      if (!m || typeof m !== "object" || m.id == null || "method" in m) return false;
      const resolve = pending.get(String(m.id));
      if (!resolve) return false;
      pending.delete(String(m.id));
      resolve(m.error ? { error: m.error } : { result: m.result });
      return true;
    },
    send(tool, args) {
      return new Promise((resolve) => {
        const id = "memglow-mq:" + process.pid + ":" + (++n);
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { pending.delete(id); finish({ error: { code: -32000, message: "memglow-mcp-proxy: multiQuery upstream timeout" } }); }, MULTI_QUERY_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        pending.set(id, finish);
        try { write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }) + "\n", "utf8")); }
        catch (e) { pending.delete(id); finish({ error: { code: -32000, message: "memglow-mcp-proxy: " + e.message } }); }
      });
    },
  };
}

function runStdio(o) {
  if (!o.cmd.length) { process.stderr.write("memglow-mcp-proxy: nothing to run (usage: memglow-mcp-proxy -- <server command>)\n"); process.exit(2); }
  const server = o.name || o.cmd.join(" ").match(/[A-Za-z0-9_-]*(memory|obsidian|notes|filesystem)[A-Za-z0-9_-]*/i)?.[0] || "memory";
  const w = createWatcher({ server, source: o.source });
  const lv = setupLevers(process.env, server);
  const rules = setupRules(process.env, o.rules);
  const child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  if (lv || rules) {
    // Levers on, or the memory rules active: whole lines are relayed (rewritten only when one of
    // the two layers changes them — rules only ever touches an `initialize` response).
    // multiQuery (lever 9) is handled OUTSIDE this per-line rewrite: it turns the client's one
    // request into several upstream calls and ONE merged reply, so it needs its own sender
    // (`sub`, below) rather than the 1 line in → 1 line out shape `transform` has everywhere else.
    const sub = lv ? createSubCallSender((b) => child.stdin.write(b)) : null;
    const up = lineRelay((b) => child.stdin.write(b), (m) => {
      try { w.fromClient(m); } catch { /* keep relaying */ }
      if (lv && lv.multiQuery.applies(m)) {
        lv.multiQuery.run(m, (args) => sub.send(m.params.name, args)).then((r) => {
          try { w.fromServer(r.message); } catch { /* ignore: the call is still answered below */ }
          process.stdout.write(JSON.stringify(r.message) + "\n");
        }).catch(() => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "memglow-mcp-proxy: multiQuery failed" } }) + "\n");
        });
        return SUPPRESS; // the original line is answered, out of band, once run() resolves
      }
      let msg = m, changed = false;
      if (rules) { const r = rules.clientMessage(msg); if (r.changed) { msg = r.msg; changed = true; } }
      if (lv) { const r = lv.clientMessage(msg); if (r.changed) { msg = r.msg; changed = true; } }
      return changed ? JSON.stringify(msg) : null;
    });
    const down = lineRelay((b) => process.stdout.write(b), (m) => {
      if (sub && sub.intercept(m)) return SUPPRESS; // a multiQuery sub-call's answer: never relayed as is
      try { w.fromServer(m); } catch { /* keep relaying */ }
      let msg = m, changed = false;
      if (rules) { const r = rules.serverMessage(msg); if (r.changed) { msg = r.msg; changed = true; } }
      if (lv) { const r = lv.serverMessage(msg); if (r.changed) { msg = r.msg; changed = true; } }
      return changed ? JSON.stringify(msg) : null;
    });
    process.stdin.on("data", (c) => up.push(c));
    process.stdin.on("end", () => { up.end(); child.stdin.end(); });
    child.stdout.on("data", (c) => down.push(c));
    child.stdout.on("end", () => down.end());
    if (lv) process.on("exit", () => { lv.savings.flush(); lv.aliasStore.flush(); });
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

/**
 * One upstream `tools/call`, over HTTP, outside the normal request/response relay: used for the
 * EXTRA calls a multiQuery search makes on its own. JSON answers only (a sub-call that gets an
 * SSE answer back fails — the caller fails that phrasing open, same as a network error); the
 * one call the CLIENT actually asked for still goes through the normal streaming path below,
 * SSE included.
 */
function postJsonRpc(lib, target, baseHeaders, id, tool, args) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }), "utf8");
    const headers = { ...baseHeaders, "content-type": "application/json", "content-length": String(body.length) };
    delete headers["content-encoding"];
    const pr = lib.request(target, { method: "POST", headers }, (ur) => {
      const parts = [];
      ur.on("data", (c) => parts.push(c));
      ur.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(parts).toString("utf8"));
          resolve(j && j.error ? { error: j.error } : { result: j && j.result });
        } catch { resolve({ error: { code: -32000, message: "memglow-mcp-proxy: multiQuery: unreadable upstream response" } }); }
      });
    });
    pr.on("error", (e) => resolve({ error: { code: -32000, message: "memglow-mcp-proxy: multiQuery: " + e.message } }));
    pr.end(body);
  });
}

function createHttpProxy(o) {
  const up = new URL(o.upstream);
  const lib = up.protocol === "https:" ? https : http;
  const server = o.name || up.hostname;
  const lv = o.levers === undefined ? setupLevers(process.env, server) : o.levers; // tests pass their own (or null)
  const rules = setupRules(process.env, o.rules);
  let mqN = 0;
  return http.createServer((req, res) => {
    const w = createWatcher({ server, source: o.source, onReport: o.onReport });
    const sk = String(req.headers["mcp-session-id"] || "default");
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let parsed;
      if (body.length) { try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = undefined; /* not JSON */ } }
      const target = new URL(up.href);
      const incoming = new URL(req.url, "http://x");
      incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      const baseHeaders = hopless(req.headers);
      delete baseHeaders.host; delete baseHeaders["content-length"];

      // Lever 9 (multiQuery): this ONE client request becomes several upstream calls (sent
      // directly, below — never through the normal streaming path) and ONE merged reply. Never
      // for a JSON-RPC batch (an array): each element would need its own independent answer.
      if (parsed !== undefined && !Array.isArray(parsed) && lv && lv.multiQuery.applies(parsed)) {
        try { w.fromClient(parsed); } catch { /* keep relaying */ }
        const sendUpstream = (args) => postJsonRpc(lib, target, baseHeaders, "memglow-mq:" + process.pid + ":" + (++mqN), parsed.params.name, args);
        lv.multiQuery.run(parsed, sendUpstream).then((r) => {
          try { w.fromServer(r.message); } catch { /* ignore: the call is still answered below */ }
          const out = Buffer.from(JSON.stringify(r.message), "utf8");
          res.writeHead(200, { "content-type": "application/json", "content-length": String(out.length) });
          res.end(out);
        }).catch(() => {
          const out = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: "memglow-mcp-proxy: multiQuery failed" } }), "utf8");
          res.writeHead(200, { "content-type": "application/json", "content-length": String(out.length) });
          res.end(out);
        });
        return;
      }

      let wanted = false;
      if (parsed !== undefined) {
        try { w.fromClient(parsed); } catch { /* keep relaying */ }
        let msg = parsed, changed = false;
        if (rules) { const r = rules.clientMessage(msg, sk); if (r.changed) { msg = r.msg; changed = true; } }
        if (lv) { const r = lv.clientMessage(msg, sk); if (r.changed) { msg = r.msg; changed = true; } }
        if (changed) body = Buffer.from(JSON.stringify(msg), "utf8");
        const ids = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => m && m.id);
        wanted = (!!lv && lv.wants(ids, sk)) || (!!rules && rules.wants(ids, sk));
      }
      const transform = (m) => {
        try { w.fromServer(m); } catch { /* ignore */ }
        let msg = m, changed = false;
        if (rules) { const r = rules.serverMessage(msg, sk); if (r.changed) { msg = r.msg; changed = true; } }
        if (lv) { const r = lv.serverMessage(msg, sk); if (r.changed) { msg = r.msg; changed = true; } }
        return changed ? JSON.stringify(msg) : null;
      };
      const headers = { ...baseHeaders };
      if (body.length) headers["content-length"] = String(body.length);
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
    process.stdout.write("usage:\n  memglow-mcp-proxy [--name NAME] -- <memory MCP server command>\n  memglow-mcp-proxy --upstream URL --listen HOST:PORT [--name NAME]\nlevers (v0.4): MEMGLOW_PROXY_SIZE_WARNING, _MULTI_QUERY (default on), _SEARCH_DETAILS, _SUGGESTIONS, MEMGLOW_PROXY_DEDUPE, _TOC, _ARCHIVE_HINT, _HIDE_UNSUPPORTED, _ALREADY_LOADED (default off)\n  or memglow.config.json → \"proxy\": { ... } — see mcp-proxy/README.md\nmemory rules (default on): MEMGLOW_RULES=0 to turn off, or Settings → Memory rules — see README.md\n");
    process.exit(0);
  }
  if (o.upstream) {
    const [host, port] = (o.listen || "127.0.0.1:8765").split(":");
    createHttpProxy(o).listen(Number(port), host || "127.0.0.1", () =>
      process.stderr.write(`memglow-mcp-proxy: http://${host || "127.0.0.1"}:${port} -> ${o.upstream}\n`));
  } else runStdio(o);
}

module.exports = { createWatcher, createHttpProxy, lineTap, sseTap, lineRelay, sseRelay, setupLevers, setupRules, parseArgs, SUPPRESS, createSubCallSender };
