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
const { createTools, SERVER_VERSION, sameFileTwins } = require("./tools");
const { createRpc, INSTRUCTIONS, INSTRUCTIONS_RW } = require("./rpc");
const { createWriter, ownershipWarning, FSYNC_MODES } = require("./writer");
const defaultsLib = require("../lib/defaults");
const { createHttpServer } = require("./http");
const { createAllInOne } = require("./all-in-one");

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
                  keeps its mode, a new one gets 0660 — group kept from the folder as before)
  --on-write CMD  shell command run after writes (debounced, never blocking a write), in the
                  notes folder, with MEMGLOW_CHANGED_FILES (one path per line) — e.g. a git
                  snapshot script
  --on-write-delay-ms N  quiet time before the on-write command runs (default and minimum 10000)
  --overwrite-default  write_note replaces an existing note when \`overwrite\` is omitted
                  (default: it refuses, like basic-memory)
  --serve-files text|any  read_content serves only text and image files (.md .txt .json .csv
                  .yaml .yml .png .jpg .jpeg .gif .webp .svg .pdf) by default; "any" serves any
                  regular file under the root, as before 0.4.9.1. Env MEMGLOW_MEMORY_SERVE_FILES
  --no-structured-read  read_note's text answer carries the note once (in content), without the
                  FastMCP structuredContent copy of the same text (fewer tokens with clients that
                  pass both on). Env MEMGLOW_MEMORY_STRUCTURED_READ=0
  --kebab-filenames  file names of new notes in kebab-case (default: the title as is)
  --update-permalinks-on-move  a moved note's permalink follows its new path (default: kept)
  --fsync-mode sync|deferred|none  durability of writes (default: sync). sync: fsync the file
                  and its folder before answering. deferred: answer right after the atomic rename,
                  fsync just after in the background (a power cut within ~1-3 s of a write can lose
                  that write; on btrfs / ext4 defaults the previous version survives, on XFS or
                  ext4 noauto_da_alloc the note can come back empty; safe with a UPS). none: no fsync. Env
                  MEMGLOW_MEMORY_FSYNC, or "memoryServer": { "fsyncMode": … } in memglow.config.json
                  (MEMGLOW_CONFIG or ~/.memglow only, never the current folder)
  --no-fsync      same as --fsync-mode none
  --poll-ms N     fallback periodic rescan, in ms (default 3000; 0 = file watching only)
  --no-watch      do not watch the note folders (periodic rescan only). Not needed any more for a
                  .git snapshot folder: since 0.4.10.4 only the note folders themselves are
                  watched, non-recursively (never .git, .trash, @eaDir, node_modules, dot-folders)
  --allow-origin O  accept browser requests from this Origin (repeatable or comma-separated;
                  default: none — any request carrying an Origin header is refused, requests
                  without one, as MCP clients send them, are accepted). Env MEMGLOW_MEMORY_ALLOW_ORIGIN
  --token T       require "Authorization: Bearer T" on every HTTP request (GET /healthz excepted).
                  Env MEMGLOW_MEMORY_TOKEN (preferred: keeps it out of the process list)
  --levers        all-in-one mode: apply the memglow MCP proxy's levers, memory rules and
                  activity reporting in this process (no separate memglow-mcp-proxy needed).
                  Env MEMGLOW_MEMORY_LEVERS=1. Lever switches: MEMGLOW_PROXY_* / memglow.config.json
                  "proxy", as for the proxy; data in MEMGLOW_DATA_DIR
  --name NAME     with --levers: the server name the levers and activity reports use
                  (default: memglow-memory)
  --source S      with --levers: the activity source label (default: mcp)
  --quiet         no log on stderr
`;

function parseArgs(argv, env = process.env) {
  const o = { root: env.MEMGLOW_MEMORY_ROOT || "", project: env.MEMGLOW_MEMORY_PROJECT || "main", listen: "", stdio: false, readOnly: true, pollMs: 3000, watch: true, quiet: false,
    readWrite: /^(1|true|yes|on)$/i.test(String(env.MEMGLOW_MEMORY_READ_WRITE || "")), forceReadOnly: false, fileMode: null, onWrite: env.MEMGLOW_MEMORY_ON_WRITE || "", onWriteDelayMs: 10000,
    overwriteDefault: false, kebabFilenames: false, updatePermalinksOnMove: false, fsync: true,
    allowOrigins: String(env.MEMGLOW_MEMORY_ALLOW_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean), token: env.MEMGLOW_MEMORY_TOKEN || "",
    levers: /^(1|true|yes|on)$/i.test(String(env.MEMGLOW_MEMORY_LEVERS || "")), name: "", source: "mcp",
    serveFiles: String(env.MEMGLOW_MEMORY_SERVE_FILES || "").toLowerCase() === "any" ? "any" : "text",
    structuredRead: !/^(0|false|no|off)$/i.test(String(env.MEMGLOW_MEMORY_STRUCTURED_READ || "")) };
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
    else if (a === "--no-fsync") { o.fsync = false; o.fsyncMode = "none"; }
    else if (a === "--fsync-mode" || a.startsWith("--fsync-mode=")) {
      const v = String(a === "--fsync-mode" ? argv[++i] || "" : a.slice(13)).toLowerCase();
      if (FSYNC_MODES.includes(v)) o.fsyncMode = v; else o.badFsyncMode = v;
    }
    else if (a === "--update-permalinks-on-move") o.updatePermalinksOnMove = true;
    else if (a === "--poll-ms") o.pollMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--no-watch") o.watch = false;
    else if (a === "--no-structured-read") o.structuredRead = false;
    else if (a === "--serve-files" || a.startsWith("--serve-files=")) {
      const v = String(a === "--serve-files" ? argv[++i] || "" : a.slice(14)).toLowerCase();
      if (v === "any" || v === "text") o.serveFiles = v; else o.badServeFiles = v;
    }
    else if (a === "--allow-origin") o.allowOrigins.push(...String(argv[++i] || "").split(",").map((x) => x.trim()).filter(Boolean));
    else if (a === "--token") o.token = argv[++i] || "";
    else if (a === "--levers") o.levers = true;
    else if (a === "--name") o.name = argv[++i] || "";
    else if (a.startsWith("--name=")) o.name = a.slice(7);
    else if (a === "--source") o.source = argv[++i] || "mcp";
    else if (a.startsWith("--source=")) o.source = a.slice(9);
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
 * `allInOne` (0.4.8.1, --levers): false/undefined = the plain server, exactly as before; true or
 * { env, name, source, onReport, levers, rules } = the proxy's levers, rules and activity
 * reporting applied in process (memory-server/all-in-one.js) — then `rpc` is that wrapped
 * dispatcher and `rawRpc` the server's own.
 * `deferStart` (0.4.10.2, the CLI): return at once and load the notes folder and build the
 * search index in setImmediate chunks (`ready` resolves when done); a request arriving before
 * that waits for it (never fails, never sees a half-loaded folder). Without it everything is
 * loaded before this returns, as before (`ready` is already resolved).
 */
/**
 * The fsync mode in effect and where it comes from: --fsync-mode / --no-fsync, else
 * MEMGLOW_MEMORY_FSYNC, else memglow.config.json "memoryServer.fsyncMode" (MEMGLOW_CONFIG or
 * ~/.memglow/memglow.config.json — never a ./memglow.config.json in the current folder, the
 * 0.4.7.6 trust boundary), else "sync". → { mode, source, warning? }
 */
function resolveFsyncMode(o, env = process.env) {
  if (o.fsyncMode) return { mode: o.fsyncMode, source: o.fsync === false && o.fsyncMode === "none" ? "--no-fsync" : "--fsync-mode" };
  const e = String(env.MEMGLOW_MEMORY_FSYNC || "").trim().toLowerCase();
  if (e) {
    if (FSYNC_MODES.includes(e)) return { mode: e, source: "MEMGLOW_MEMORY_FSYNC" };
    return { mode: "sync", source: "default", warning: `memglow memory server: ignoring MEMGLOW_MEMORY_FSYNC="${e.slice(0, 40)}" (expected sync, deferred or none)` };
  }
  let cfg = {};
  try { cfg = defaultsLib.resolveConfigFiles({ env, allowCwd: false }).config || {}; } catch { cfg = {}; }
  const ms = cfg && typeof cfg.memoryServer === "object" && cfg.memoryServer ? cfg.memoryServer : {};
  const c = typeof ms.fsyncMode === "string" ? ms.fsyncMode.trim().toLowerCase() : "";
  if (c && FSYNC_MODES.includes(c)) return { mode: c, source: "memglow.config.json" };
  return { mode: "sync", source: "default" };
}

function createMemoryServer({ root, project = "main", readOnly = true, pollMs = 3000, watch = true, maxFileBytes, log = () => {},
  fsync = true, fsyncMode = null, cleanupTempsMinAgeMs = 60000, fileMode = null, serveFiles = "text", structuredRead = true, onWrite = "", onWriteDelayMs = 10000, overwriteDefault = false, kebabFilenames = false, updatePermalinksOnMove = false, writerHooks = {}, chownToParent, allInOne, deferStart = false }) {
  let tools = null, warmTimer = null, isReady = !deferStart;
  // The search index is rebuilt lazily by the next search anyway; warming it after a change is
  // coalesced (a burst of writes costs one rebuild, not one per write).
  const onChange = () => {
    // Not during a deferred start: warmAsync builds the index in chunks (0.4.10.6b).
    if (!tools || warmTimer || (deferStart && !isReady)) return;
    warmTimer = setImmediate(() => { warmTimer = null; try { tools.warm(); } catch { /* next search rebuilds */ } });
  };
  const store = createStore({ root, project, pollMs, watch, log, ...(maxFileBytes ? { maxFileBytes } : {}), onChange });
  const writer = readOnly ? null : createWriter({ store, fsync, fsyncMode, fileMode, onWrite, onWriteDelayMs, log, hooks: writerHooks, ...(maxFileBytes ? { maxFileBytes } : {}), ...(chownToParent != null ? { chownToParent } : {}) });
  const startupChecks = () => {
    if (!writer) return;
    try { const w = ownershipWarning(require("fs").statSync(root)); if (w) log(w); } catch { /* no root: nothing to warn about */ }
    writer.cleanupTemps(cleanupTempsMinAgeMs);
    const twins = sameFileTwins(store.notes());
    const col = store.collisions();
    if (twins.length || col.length) log(`memglow memory server: ${twins.length + col.length} note(s) present under several paths or permalinks (an interrupted move?) — see basic_memory_diagnostics`);
  };
  tools = createTools({ store, project, readOnly, writer, serveFiles, structuredRead, writeOptions: { overwriteDefault, kebabFilenames, updatePermalinksOnMove } });
  let ready;
  if (!deferStart) {
    store.start();
    startupChecks();
    tools.warm();
    ready = Promise.resolve();
  } else {
    ready = store.startAsync()
      .then(() => { try { startupChecks(); } catch { /* best effort */ } })
      .then(() => tools.engine.warmAsync())
      // 0.4.10.3: the levers' note index (fed from the store) built now, not by the first request.
      .then(() => { try { if (aio && aio.lv && aio.lv.index) aio.lv.index.allNotes(); } catch { /* lazily then */ } })
      .catch(() => { /* a request still gets the plain scan / a lazy index */ })
      .then(() => { isReady = true; });
  }
  const rawRpc = createRpc({ tools, instructions: readOnly ? INSTRUCTIONS : INSTRUCTIONS_RW });
  const aio = allInOne ? createAllInOne({ rpc: rawRpc, root, log, store, ...(allInOne === true ? {} : allInOne) }) : null;
  const inner = aio ? aio.rpc : rawRpc;
  // Until the folder is loaded and indexed, a request waits for it (deferStart only).
  const rpc = deferStart ? {
    serverInfo: inner.serverInfo,
    handle: (m, ctx) => (isReady ? inner.handle(m, ctx) : ready.then(() => inner.handle(m, ctx))),
    handleAny: (m, ctx) => (isReady ? inner.handleAny(m, ctx) : ready.then(() => inner.handleAny(m, ctx))),
  } : inner;
  return { store, tools, rpc, rawRpc, aio, writer, ready, isReady: () => isReady, close: () => { if (warmTimer) { clearImmediate(warmTimer); warmTimer = null; } store.stop(); if (writer) writer.flushHook(); if (aio) aio.close(); } };
}

function runStdio(rpc, input = process.stdin, output = process.stdout, onEnd = () => process.exit(0), ready = null) {
  let buf = "";
  let pending = 0, ended = false;
  // 0.4.10.2: until the notes folder is loaded (`ready`), lines are only buffered — then handled
  // in arrival order, so the answers keep the order they always had.
  let isReady = !ready;
  const finish = () => { if (isReady && ended && !pending) output.write("", () => onEnd()); };
  input.setEncoding("utf8");
  if (ready) ready.then(() => { isReady = true; onData(""); finish(); }, () => { isReady = true; onData(""); finish(); });
  input.on("data", (chunk) => onData(chunk));
  function onData(chunk) {
    buf += chunk;
    if (!isReady) return;
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
  }
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
  process.on("unhandledRejection", (e) => { try { process.stderr.write("memglow memory server: unhandled rejection (kept running): " + (e && e.stack || e) + "\n"); } catch { /* ignore */ } });
  if (o.unknown) { process.stderr.write(`memglow-memory-server: unknown option(s): ${o.unknown.join(" ")}\n\n${HELP}`); return 2; }
  if (o.badFsyncMode != null) { process.stderr.write(`memglow-memory-server: bad --fsync-mode "${o.badFsyncMode}" (expected sync, deferred or none)\n`); return 2; }
  if (o.badServeFiles != null) { process.stderr.write(`memglow-memory-server: bad --serve-files "${o.badServeFiles}" (expected text or any)\n`); return 2; }
  if (o.badFileMode != null) { process.stderr.write(`memglow-memory-server: bad --file-mode "${o.badFileMode}" (expected an octal mode such as 0664)\n`); return 2; }
  const root = path.resolve(o.root);
  const t0 = Date.now();
  const fsyncInfo = resolveFsyncMode(o, env);
  // 0.4.10.2: the port opens at once; the notes folder is loaded and indexed in the background
  // (requests meanwhile wait for it, they never fail).
  const srv = createMemoryServer({ root, project: o.project, readOnly: o.readOnly, pollMs: o.pollMs, watch: o.watch, log,
    fsync: o.fsync, fsyncMode: fsyncInfo.mode, fileMode: o.fileMode, serveFiles: o.serveFiles, structuredRead: o.structuredRead, onWrite: o.onWrite, onWriteDelayMs: o.onWriteDelayMs, overwriteDefault: o.overwriteDefault, kebabFilenames: o.kebabFilenames, updatePermalinksOnMove: o.updatePermalinksOnMove,
    allInOne: o.levers ? { env, name: o.name || "memglow-memory", source: o.source } : false, deferStart: true });
  if (fsyncInfo.warning) log(fsyncInfo.warning);
  srv.ready.then(() => {
    const st = srv.store.stats();
    log(`memglow memory server ${SERVER_VERSION}: ${st.notes} notes indexed from ${root} in ${Date.now() - t0} ms (project "${o.project}", ${o.readOnly ? "read-only" : "read-write, fsync " + fsyncInfo.mode + (fsyncInfo.source !== "default" ? " (" + fsyncInfo.source + ")" : "")}${st.watching ? ", watching" : ""})`);
    if (srv.aio) {
      const c = srv.aio.lv && srv.aio.lv.config;
      log(`memglow memory server: all-in-one — levers ${c ? "on (notes index: " + (c.memoryDir || "none") + ", data: " + c.dataDir + ")" : "all off"}, memory rules ${srv.aio.rules ? "on" : "off"}, activity channel "memory-server"`);
    }
  });
  if (o.listen) {
    const m = /^(?:\[?([^\]]*)\]?:)?(\d+)$/.exec(o.listen.trim());
    if (!m) { process.stderr.write(`memglow-memory-server: bad --listen "${o.listen}" (expected HOST:PORT)\n`); return 2; }
    const host = m[1] || "127.0.0.1", port = Number(m[2]);
    const server = createHttpServer({ rpc: srv.rpc, store: srv.store, log, allowOrigins: o.allowOrigins, token: o.token, readOnly: o.readOnly, fsyncMode: srv.writer ? srv.writer.fsyncMode : null });
    server.once("error", (e) => { process.stderr.write(`memglow-memory-server: cannot listen on ${host}:${port}: ${e.message}\n`); srv.close(); process.exit(1); });
    server.listen(port, host, () => log(`memglow memory server: listening on http://${host}:${server.address().port}/mcp`));
    // Writes in progress — and, with --fsync-mode deferred, their pending fsyncs — finish first
    // (at most 10 s), so a stop never leaves a half-done edit (an interrupted one would leave the
    // old file anyway: writes are atomic).
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
  // SIGTERM / SIGINT in stdio mode too: pending writes and fsyncs first (0.4.10.6b).
  const stopStdio = () => {
    const idle = srv.writer ? srv.writer.idle() : Promise.resolve();
    const cap = new Promise((ok) => { const t = setTimeout(ok, 10000); if (t.unref) t.unref(); });
    Promise.race([idle, cap]).finally(() => { srv.close(); process.exit(0); });
  };
  process.on("SIGINT", stopStdio); process.on("SIGTERM", stopStdio);
  // stdin closed: pending writes AND their deferred fsyncs finish first (at most 10 s).
  runStdio(srv.rpc, process.stdin, process.stdout, () => {
    const idle = srv.writer ? srv.writer.idle() : Promise.resolve();
    const cap = new Promise((ok) => { const t = setTimeout(ok, 10000); if (t.unref) t.unref(); });
    Promise.race([idle, cap]).finally(() => { srv.close(); process.exit(0); });
  }, srv.ready);
  return null;
}

if (require.main === module) { const code = main(); if (code != null) process.exitCode = code; }

module.exports = { main, parseArgs, createMemoryServer, runStdio, resolveFsyncMode, HELP };
