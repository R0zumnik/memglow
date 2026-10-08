#!/usr/bin/env node
"use strict";
/**
 * memglow memory server (preview, stage 0.4.5.1 — phase A: engine + read tools, read-only).
 *
 * An MCP memory server over a folder of Markdown notes, tool-compatible with basic-memory
 * (same tool names and arguments, compatible text output), so the clients, hooks and the memglow
 * MCP proxy in front of it keep working unchanged. In-memory index, refreshed on file change;
 * lexical search (no embeddings). Zero dependencies.
 *
 *   memglow-memory-server --root ~/knowledge --listen 127.0.0.1:8000     Streamable HTTP on /mcp
 *   memglow-memory-server --root ~/knowledge --stdio                      newline-delimited stdio
 *   memglow memory-server …                                                same, via the memglow CLI
 *
 * Options: --root DIR (default $MEMGLOW_MEMORY_ROOT or the current folder), --project NAME (default
 * "main"), --listen HOST:PORT, --stdio (the default when --listen is absent), --read-only (phase A
 * is always read-only: write tools answer an error), --poll-ms N (rescan period, default 3000),
 * --no-watch, --quiet.
 */
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createTools, SERVER_VERSION } = require("./tools");
const { createRpc } = require("./rpc");
const { createHttpServer } = require("./http");

const HELP = `memglow memory server ${SERVER_VERSION} (preview, read-only)

usage:
  memglow-memory-server [--root DIR] [--project main] --listen HOST:PORT    HTTP, endpoint /mcp
  memglow-memory-server [--root DIR] [--project main] --stdio               stdio (default)

options:
  --root DIR      notes folder (default: $MEMGLOW_MEMORY_ROOT, else the current folder)
  --project NAME  project name used in permalinks and outputs (default: main)
  --read-only     write tools answer an error (always the case in this preview)
  --poll-ms N     periodic rescan, in ms (default 3000; 0 = file watching only)
  --no-watch      do not use fs.watch (periodic rescan only)
  --quiet         no log on stderr
`;

function parseArgs(argv, env = process.env) {
  const o = { root: env.MEMGLOW_MEMORY_ROOT || "", project: env.MEMGLOW_MEMORY_PROJECT || "main", listen: "", stdio: false, readOnly: true, pollMs: 3000, watch: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = argv[++i] || "";
    else if (a.startsWith("--root=")) o.root = a.slice(7);
    else if (a === "--project") o.project = argv[++i] || "main";
    else if (a.startsWith("--project=")) o.project = a.slice(10);
    else if (a === "--listen") o.listen = argv[++i] || "";
    else if (a.startsWith("--listen=")) o.listen = a.slice(9);
    else if (a === "--stdio") o.stdio = true;
    else if (a === "--read-only") o.readOnly = true;
    else if (a === "--poll-ms") o.pollMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--no-watch") o.watch = false;
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o.unknown = (o.unknown || []).concat(a);
  }
  if (!o.root) o.root = process.cwd();
  return o;
}

/** Builds store + tools + rpc for a root (used by the CLI and by tests). */
function createMemoryServer({ root, project = "main", readOnly = true, pollMs = 3000, watch = true, maxFileBytes, log = () => {} }) {
  let tools = null;
  const store = createStore({ root, project, pollMs, watch, log, ...(maxFileBytes ? { maxFileBytes } : {}), onChange: () => { if (tools) { try { tools.warm(); } catch { /* next search rebuilds */ } } } });
  store.start();
  tools = createTools({ store, project, readOnly });
  tools.warm();
  const rpc = createRpc({ tools });
  return { store, tools, rpc, close: () => store.stop() };
}

function runStdio(rpc, input = process.stdin, output = process.stdout) {
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
      let out;
      try { out = rpc.handleAny(msg, {}); } catch (e) { out = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error: " + e.message } }; }
      if (out == null || (Array.isArray(out) && !out.length)) continue;
      output.write(JSON.stringify(out) + "\n");
    }
    if (buf.length > 20 * 1024 * 1024) buf = "";
  });
  input.on("end", () => process.exit(0));
  input.resume();
}

function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv, env);
  if (o.help) { process.stdout.write(HELP); return 0; }
  const log = o.quiet ? () => {} : (s) => process.stderr.write(s + "\n");
  if (o.unknown) { process.stderr.write(`memglow-memory-server: unknown option(s): ${o.unknown.join(" ")}\n\n${HELP}`); return 2; }
  const root = path.resolve(o.root);
  const t0 = Date.now();
  const srv = createMemoryServer({ root, project: o.project, readOnly: o.readOnly, pollMs: o.pollMs, watch: o.watch, log });
  const st = srv.store.stats();
  log(`memglow memory server ${SERVER_VERSION}: ${st.notes} notes indexed from ${root} in ${Date.now() - t0} ms (project "${o.project}", read-only${st.watching ? ", watching" : ""})`);
  if (o.listen) {
    const m = /^(?:\[?([^\]]*)\]?:)?(\d+)$/.exec(o.listen.trim());
    if (!m) { process.stderr.write(`memglow-memory-server: bad --listen "${o.listen}" (expected HOST:PORT)\n`); return 2; }
    const host = m[1] || "127.0.0.1", port = Number(m[2]);
    const server = createHttpServer({ rpc: srv.rpc, store: srv.store, log });
    server.on("error", (e) => { process.stderr.write(`memglow-memory-server: cannot listen on ${host}:${port}: ${e.message}\n`); srv.close(); process.exit(1); });
    server.listen(port, host, () => log(`memglow memory server: listening on http://${host}:${server.address().port}/mcp`));
    const stop = () => { srv.close(); server.close(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return null;
  }
  runStdio(srv.rpc);
  return null;
}

if (require.main === module) { const code = main(); if (code != null) process.exitCode = code; }

module.exports = { main, parseArgs, createMemoryServer, runStdio, HELP };
