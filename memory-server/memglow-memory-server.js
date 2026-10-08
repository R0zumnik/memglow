#!/usr/bin/env node
"use strict";
/**
 * memglow memory server (preview, stage 0.4.5.2 — phase A: engine + read tools; phase B: write
 * tools, enabled with --read-write).
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
 * Options: see HELP below. Read-only unless --read-write (or MEMGLOW_MEMORY_READ_WRITE=1) is given;
 * --read-only always wins.
 */
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createTools, SERVER_VERSION } = require("./tools");
const { createRpc, INSTRUCTIONS, INSTRUCTIONS_RW } = require("./rpc");
const { createWriter } = require("./writer");
const { createHttpServer } = require("./http");

const HELP = `memglow memory server ${SERVER_VERSION} (preview)

usage:
  memglow-memory-server [--root DIR] [--project main] --listen HOST:PORT    HTTP, endpoint /mcp
  memglow-memory-server [--root DIR] [--project main] --stdio               stdio (default)

options:
  --root DIR      notes folder (default: $MEMGLOW_MEMORY_ROOT, else the current folder)
  --project NAME  project name used in permalinks and outputs (default: main)
  --read-write    enable the write tools (write_note, edit_note, move_note, delete_note).
                  Env MEMGLOW_MEMORY_READ_WRITE=1. Without it the server is read-only.
  --read-only     write tools answer an error (the default; wins over --read-write)
  --file-mode MODE  octal mode for every file written (e.g. 0664; default: an existing file
                  keeps its mode, a new one gets 0666 minus the umask)
  --on-write CMD  shell command run after writes (debounced, never blocking a write), in the
                  notes folder, with MEMGLOW_CHANGED_FILES (one path per line) — e.g. a git
                  snapshot script
  --on-write-delay-ms N  quiet time before the on-write command runs (default and minimum 10000)
  --overwrite-default  write_note replaces an existing note when \`overwrite\` is omitted
                  (default: it refuses, like basic-memory)
  --kebab-filenames  file names of new notes in kebab-case (default: the title as is)
  --update-permalinks-on-move  a moved note's permalink follows its new path (default: kept)
  --no-fsync      do not fsync written files (still atomic; faster on slow disks, but a power
                  cut may lose the last writes)
  --poll-ms N     periodic rescan, in ms (default 3000; 0 = file watching only)
  --no-watch      do not use fs.watch (periodic rescan only)
  --allow-origin O  accept browser requests from this Origin (repeatable or comma-separated;
                  default: none — any request carrying an Origin header is refused, requests
                  without one, as MCP clients send them, are accepted). Env MEMGLOW_MEMORY_ALLOW_ORIGIN
  --token T       require "Authorization: Bearer T" on every HTTP request (GET /healthz excepted).
                  Env MEMGLOW_MEMORY_TOKEN (preferred: keeps it out of the process list)
  --quiet         no log on stderr
`;

function parseArgs(argv, env = process.env) {
  const o = { root: env.MEMGLOW_MEMORY_ROOT || "", project: env.MEMGLOW_MEMORY_PROJECT || "main", listen: "", stdio: false, readOnly: true, pollMs: 3000, watch: true, quiet: false,
    readWrite: /^(1|true|yes|on)$/i.test(String(env.MEMGLOW_MEMORY_READ_WRITE || "")), forceReadOnly: false, fileMode: null, onWrite: env.MEMGLOW_MEMORY_ON_WRITE || "", onWriteDelayMs: 10000,
    overwriteDefault: false, kebabFilenames: false, updatePermalinksOnMove: false, fsync: true,
    allowOrigins: String(env.MEMGLOW_MEMORY_ALLOW_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean), token: env.MEMGLOW_MEMORY_TOKEN || "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = argv[++i] || "";
    else if (a.startsWith("--root=")) o.root = a.slice(7);
    else if (a === "--project") o.project = argv[++i] || "main";
    else if (a.startsWith("--project=")) o.project = a.slice(10);
    else if (a === "--listen") o.listen = argv[++i] || "";
    else if (a.startsWith("--listen=")) o.listen = a.slice(9);
    else if (a === "--stdio") o.stdio = true;
    else if (a === "--read-only") o.forceReadOnly = true;
    else if (a === "--read-write") o.readWrite = true;
    else if (a === "--file-mode") o.fileMode = argv[++i] || "";
    else if (a.startsWith("--file-mode=")) o.fileMode = a.slice(12);
    else if (a === "--on-write") o.onWrite = argv[++i] || "";
    else if (a.startsWith("--on-write=")) o.onWrite = a.slice(11);
    else if (a === "--on-write-delay-ms") o.onWriteDelayMs = Math.max(10000, Number(argv[++i]) || 0);
    else if (a === "--overwrite-default") o.overwriteDefault = true;
    else if (a === "--kebab-filenames") o.kebabFilenames = true;
    else if (a === "--no-fsync") o.fsync = false;
    else if (a === "--update-permalinks-on-move") o.updatePermalinksOnMove = true;
    else if (a === "--poll-ms") o.pollMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--no-watch") o.watch = false;
    else if (a === "--allow-origin") o.allowOrigins.push(...String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean));
    else if (a === "--token") o.token = argv[++i] || "";
    else if (a === "--quiet" || a === "-q") o.quiet = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o.unknown = (o.unknown || []).concat(a);
  }
  if (!o.root) o.root = process.cwd();
  o.readOnly = o.forceReadOnly || !o.readWrite;
  if (o.fileMode != null) {
    const m = /^0?o?([0-7]{3,4})$/.exec(String(o.fileMode).trim());
    if (m) o.fileMode = parseInt(m[1], 8);
    else o.badFileMode = String(o.fileMode);
  }
  return o;
}

/**
 * Builds store + (writer) + tools + rpc for a root (used by the CLI and by tests). Writes are
 * enabled only with readOnly: false. `writerHooks` (tests): fault injection in the writer.
 */
function createMemoryServer({ root, project = "main", readOnly = true, pollMs = 3000, watch = true, maxFileBytes, log = () => {},
  fsync = true, fileMode = null, onWrite = "", onWriteDelayMs = 10000, overwriteDefault = false, kebabFilenames = false, updatePermalinksOnMove = false, writerHooks = {}, chownToParent }) {
  let tools = null, warmTimer = null;
  // The search index is rebuilt lazily by the next search anyway; warming it after a change is
  // coalesced (a burst of writes costs one rebuild, not one per write).
  const onChange = () => {
    if (!tools || warmTimer) return;
    warmTimer = setImmediate(() => { warmTimer = null; try { tools.warm(); } catch { /* next search rebuilds */ } });
  };
  const store = createStore({ root, project, pollMs, watch, log, ...(maxFileBytes ? { maxFileBytes } : {}), onChange });
  store.start();
  const writer = readOnly ? null : createWriter({ store, fsync, fileMode, onWrite, onWriteDelayMs, log, hooks: writerHooks, ...(maxFileBytes ? { maxFileBytes } : {}), ...(chownToParent != null ? { chownToParent } : {}) });
  tools = createTools({ store, project, readOnly, writer, writeOptions: { overwriteDefault, kebabFilenames, updatePermalinksOnMove } });
  tools.warm();
  const rpc = createRpc({ tools, instructions: readOnly ? INSTRUCTIONS : INSTRUCTIONS_RW });
  return { store, tools, rpc, writer, close: () => { if (warmTimer) { clearImmediate(warmTimer); warmTimer = null; } store.stop(); if (writer) writer.flushHook(); } };
}

function runStdio(rpc, input = process.stdin, output = process.stdout, onEnd = () => process.exit(0)) {
  let buf = "";
  let pending = 0, ended = false;
  const finish = () => { if (ended && !pending) output.write("", () => onEnd()); };
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
      const emit = (o) => { if (o == null || (Array.isArray(o) && !o.length)) return; output.write(JSON.stringify(o) + "\n"); };
      if (out && typeof out.then === "function") {
        // A write: answered when done (JSON-RPC ids let the client match answers to requests).
        pending++;
        out.then(emit, (e) => emit({ jsonrpc: "2.0", id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: "Internal error: " + (e && e.message) } }))
          .finally(() => { pending--; finish(); });
        continue;
      }
      emit(out);
    }
    if (buf.length > 20 * 1024 * 1024) buf = "";
  });
  // Exit only once every answer (pending writes included) has been written and flushed: a write's
  // callback runs after the data is handed to the OS, in order, so the empty write's callback
  // comes after all of them.
  input.on("end", () => { ended = true; finish(); });
  input.resume();
}

function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv, env);
  if (o.help) { process.stdout.write(HELP); return 0; }
  const log = o.quiet ? () => {} : (s) => process.stderr.write(s + "\n");
  // Last line of defence: nothing a client sends may take the server down. Every request path
  // already catches its own errors; anything that still escapes is logged, not fatal.
  process.on("uncaughtException", (e) => { try { process.stderr.write("memglow memory server: unexpected error (kept running): " + (e && e.stack || e) + "\n"); } catch { /* ignore */ } });
  if (o.unknown) { process.stderr.write(`memglow-memory-server: unknown option(s): ${o.unknown.join(" ")}\n\n${HELP}`); return 2; }
  if (o.badFileMode != null) { process.stderr.write(`memglow-memory-server: bad --file-mode "${o.badFileMode}" (expected an octal mode such as 0664)\n`); return 2; }
  const root = path.resolve(o.root);
  const t0 = Date.now();
  const srv = createMemoryServer({ root, project: o.project, readOnly: o.readOnly, pollMs: o.pollMs, watch: o.watch, log,
    fsync: o.fsync, fileMode: o.fileMode, onWrite: o.onWrite, onWriteDelayMs: o.onWriteDelayMs, overwriteDefault: o.overwriteDefault, kebabFilenames: o.kebabFilenames, updatePermalinksOnMove: o.updatePermalinksOnMove });
  const st = srv.store.stats();
  log(`memglow memory server ${SERVER_VERSION}: ${st.notes} notes indexed from ${root} in ${Date.now() - t0} ms (project "${o.project}", ${o.readOnly ? "read-only" : "read-write"}${st.watching ? ", watching" : ""})`);
  if (o.listen) {
    const m = /^(?:\[?([^\]]*)\]?:)?(\d+)$/.exec(o.listen.trim());
    if (!m) { process.stderr.write(`memglow-memory-server: bad --listen "${o.listen}" (expected HOST:PORT)\n`); return 2; }
    const host = m[1] || "127.0.0.1", port = Number(m[2]);
    const server = createHttpServer({ rpc: srv.rpc, store: srv.store, log, allowOrigins: o.allowOrigins, token: o.token });
    server.once("error", (e) => { process.stderr.write(`memglow-memory-server: cannot listen on ${host}:${port}: ${e.message}\n`); srv.close(); process.exit(1); });
    server.listen(port, host, () => log(`memglow memory server: listening on http://${host}:${server.address().port}/mcp`));
    // Writes in progress finish first (at most 10 s), so a stop never leaves a half-done edit
    // (an interrupted one would leave the old file anyway: writes are atomic).
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      const idle = srv.writer ? srv.writer.idle() : Promise.resolve();
      const cap = new Promise((ok) => { const t = setTimeout(ok, 10000); if (t.unref) t.unref(); });
      Promise.race([idle, cap]).finally(() => { srv.close(); process.exit(0); });
    };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return null;
  }
  runStdio(srv.rpc, process.stdin, process.stdout, () => { srv.close(); process.exit(0); });
  return null;
}

if (require.main === module) { const code = main(); if (code != null) process.exitCode = code; }

module.exports = { main, parseArgs, createMemoryServer, runStdio, HELP };
