"use strict";
/**
 * memglow memory server — "all-in-one" mode (stage 0.4.8.1, `--levers` / MEMGLOW_MEMORY_LEVERS=1).
 *
 * The MCP proxy's levers (lib/proxy-levers.js), memglow's memory rules (lib/memory-rules.js) and
 * the proxy's activity reporting, applied IN PROCESS around the memory server's own JSON-RPC
 * dispatch (memory-server/rpc.js), so that one process / one container / one port replaces the
 * pair "memglow-mcp-proxy → memglow memory server". Mirrors createHttpProxy() / runStdio() of
 * mcp-proxy/memglow-mcp-proxy.js step for step:
 *
 *   client message ──► watcher.fromClient ──► [multiQuery?] ──► rules.clientMessage ──► levers.clientMessage
 *                 ──► rpc.handleAny (the real server) ──► (index.afterWrite after a write)
 *                 ──► watcher.fromServer ──► rules.serverMessage ──► levers.serverMessage ──► client
 *
 * - The lever engine is built from the SAME settings the proxy reads (MEMGLOW_PROXY_* variables,
 *   memglow.config.json "proxy" section, MEMGLOW_DATA_DIR for savings / learned aliases /
 *   negative cache / delta read), through the levers' public API only. The one difference: the
 *   note index points at this server's own notes — `<root>/memory` when that folder exists, else
 *   the root — unless MEMGLOW_MEMORY_DIR is set.
 * - multiQuery (lever 9): one call to this server's own dispatcher per phrasing (the RAW one:
 *   sub-calls never go through the levers again), merged by the levers' own merge code.
 * - After every successful write tool call the levers' note index is rescanned at once
 *   (index.afterWrite), before the levers look at the answer, so sizeWarning / duplicateHint /
 *   alreadyLoaded / the negative-cache fingerprint never work from a stale view of our own write.
 * - Activity is reported like the proxy does (lib/agent-core.js reportInProcess: after the answer,
 *   in process, no child process), channel "memory-server".
 * - Session key (`ctx.sessionKey`, set by memory-server/http.js): the Mcp-Session-Id; for an
 *   `initialize` that opens a session, the id this server is about to hand out (so the client's
 *   clientInfo and the "once per session" rules land in ITS session, not a shared one); for a
 *   stateless (2026-07-28) request, a per-connection key. stdio: one session per process.
 * - Never throws: any failure in the lever layer falls back to the server's own answer.
 */
const fs = require("fs");
const path = require("path");
const core = require("../lib/agent-core");
const levers = require("../lib/proxy-levers");
const learnedAliases = require("../lib/learned-aliases");
const negativeCacheLib = require("../lib/negative-cache");
const deltaReadLib = require("../lib/delta-read");
const { setupRules, createWatcher, subCallParams } = require("../mcp-proxy/memglow-mcp-proxy");
const { createStoreMemory } = require("./store-memory");

// The memory server's own write tools (memory-server/write-tools.js): after any of them succeeds,
// the levers' note index is refreshed right away. Plus whatever the lever config calls a write.
const SERVER_WRITE_TOOLS = ["write_note", "edit_note", "move_note", "delete_note"];

/** The notes folder the levers' note index should watch for a server rooted at `root`. */
function leverMemoryDir(root, env = process.env) {
  if (env.MEMGLOW_MEMORY_DIR) return env.MEMGLOW_MEMORY_DIR;
  const sub = path.join(root, "memory");
  try { if (fs.statSync(sub).isDirectory()) return sub; } catch { /* no memory/ subfolder */ }
  return root;
}

/**
 * Same as setupLevers() in mcp-proxy/memglow-mcp-proxy.js (public API only), plus: the note index
 * defaults to this server's notes, and it is returned (afterWrite). null when every lever is off.
 */
function setupServerLevers({ root, env = process.env, serverName = "", log = () => {}, store = null }) {
  try {
    const config = levers.proxyConfig({ ...env, MEMGLOW_MEMORY_DIR: leverMemoryDir(root, env) });
    if (!levers.anyLever(config)) return null;
    // 0.4.10.3: one index — the levers' note index reads this server's own store (already parsed
    // notes, in-memory text) instead of scanning the same folder a second time (lib/memory.js).
    // Only when the index folder is inside the store's root; else lib/memory.js as before.
    let memory = null;
    try { memory = store && config.memoryDir ? createStoreMemory({ store, memoryDir: config.memoryDir, config: config.memory }) : null; } catch { memory = null; }
    const index = levers.createNoteIndex(config, memory ? { memory } : {});
    const savings = levers.createSavings(config);
    const aliasStore = learnedAliases.createAliasStore(config);
    const negativeCacheStore = negativeCacheLib.createNegativeCacheStore(config);
    const deltaReadStore = deltaReadLib.createDeltaReadStore(config);
    const engine = levers.createLevers({ config, index, savings, serverName, aliasStore, negativeCacheStore, deltaReadStore });
    return { ...engine, index, savings, aliasStore, negativeCacheStore, deltaReadStore, config };
  } catch (e) {
    log(`memglow memory server: levers disabled (${e.message})`);
    return null;
  }
}

function each(msg, fn) { if (Array.isArray(msg)) msg.forEach(fn); else if (msg && typeof msg === "object") fn(msg); }
const isThenable = (x) => !!x && typeof x.then === "function";

/**
 * createAllInOne({ rpc, root, env, name, source, onReport, levers, rules, log }) →
 * { rpc: { handle, handleAny, serverInfo }, lv, rules, close() }
 * `levers` / `rules` (tests): pass an engine (or null) to bypass the env-based set-up; a test
 * engine passed here should carry `index` for afterWrite (optional).
 */
function createAllInOne({ rpc, root, env = process.env, name = "memglow-memory", source = "mcp", onReport, levers: lvIn, rules: rulesIn, log = () => {}, store = null }) {
  const lv = lvIn === undefined ? setupServerLevers({ root, env, serverName: name, log, store }) : lvIn;
  const rules = setupRules(env, rulesIn);
  // 0.4.10.0: in-process and after the answer (core.reportInProcess: setImmediate + fetch, cached
  // settings) — it used to read the config and the token and spawn a node process per call,
  // before the answer was even sent.
  const report = onReport || ((evt) => core.reportInProcess(evt, source, { channel: "memory-server" }));
  const cfg = lv && lv.config ? lv.config : null;
  const leverWriteTools = new Set(cfg && Array.isArray(cfg.writeTools) ? cfg.writeTools : []);
  // A write the levers' own handleWrite already follows with index.afterWrite() (sizeWarning,
  // negativeCache, duplicateHint or orphanHint on, tool in proxy.writeTools) needs no second
  // rescan here.
  const leverRefreshes = !!(cfg && (cfg.negativeCache || cfg.sizeWarning || cfg.duplicateHint || cfg.orphanHint));
  const writeTools = new Set(SERVER_WRITE_TOOLS.concat([...leverWriteTools]));
  const needsOwnRefresh = (tool) => writeTools.has(tool) && !(leverRefreshes && leverWriteTools.has(tool));
  let mqN = 0;

  /** The raw server's answer for one sub-call, as `{result}|{error}` (multiQuery's sendUpstream). */
  function subCall(params, ctx) {
    const subCtx = { headerVersion: ctx.headerVersion || null, sessionVersion: ctx.sessionVersion || null };
    const req = { jsonrpc: "2.0", id: "memglow-mq:" + process.pid + ":" + (++mqN), method: "tools/call", params };
    const unwrap = (r) => (r && r.error ? { error: r.error } : r && "result" in r ? { result: r.result } : { error: { code: -32000, message: "memglow memory server: multiQuery: no response" } });
    let out;
    try { out = rpc.handle(req, subCtx); } catch (e) { return { error: { code: -32603, message: "Internal error: " + (e && e.message) } }; }
    return isThenable(out) ? out.then(unwrap, (e) => ({ error: { code: -32603, message: "Internal error: " + (e && e.message) } })) : unwrap(out);
  }

  /** Did a write tool whose rescan is ours to do succeed in this exchange? (ids matched with answers) */
  function wroteSomething(reqMsg, out) {
    const ids = new Map();
    each(reqMsg, (m) => { if (m && m.method === "tools/call" && m.id != null && m.params && needsOwnRefresh(m.params.name)) ids.set(String(m.id), true); });
    if (!ids.size) return false;
    let wrote = false;
    each(out, (m) => { if (m && m.id != null && ids.has(String(m.id)) && !m.error && m.result && !m.result.isError) wrote = true; });
    return wrote;
  }

  function handleAny(payload, ctx = {}) {
    const sk = ctx.sessionKey; // undefined → "default" in both layers (stdio: one session per process)
    // 0.4.10.9: the HTTP User-Agent (memory-server/http.js), the last-resort client identity for
    // the per-client accounting when neither the session nor the request names its client.
    const hints = { userAgent: typeof ctx.userAgent === "string" ? ctx.userAgent : null };
    const w = createWatcher({ server: name, source, onReport: report });

    // Lever 9 (multiQuery) — never for a batch, exactly as the HTTP proxy.
    if (lv && payload && !Array.isArray(payload)) {
      let applies = false;
      try { applies = lv.multiQuery.applies(payload); } catch { applies = false; }
      if (applies) {
        try { w.fromClient(payload); } catch { /* keep going */ }
        let run;
        try { run = Promise.resolve(lv.multiQuery.run(payload, (args) => subCall(subCallParams(payload.params, args), ctx), sk, hints)); }
        catch (e) { run = Promise.reject(e); }
        return run.then((r) => {
          try { w.fromServer(r.message); } catch { /* ignore */ }
          return r.message;
        }).catch(() => ({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "memglow memory server: multiQuery failed" } }));
      }
    }

    let msg = payload;
    try {
      w.fromClient(payload);
    } catch { /* keep going */ }
    try {
      if (rules) { const r = rules.clientMessage(msg, sk); if (r.changed) msg = r.msg; }
      if (lv) { const r = lv.clientMessage(msg, sk, hints); if (r.changed) msg = r.msg; }
    } catch { msg = payload; }

    const after = (out) => {
      if (out == null) return out;
      try { if (lv && lv.index && wroteSomething(msg, out)) lv.index.afterWrite(); } catch { /* keep the old view */ }
      try { w.fromServer(out); } catch { /* ignore */ }
      let o = out;
      try {
        if (rules) { const r = rules.serverMessage(o, sk); if (r.changed) o = r.msg; }
        if (lv) { const r = lv.serverMessage(o, sk); if (r.changed) o = r.msg; }
      } catch { o = out; }
      return o;
    };
    const out = rpc.handleAny(msg, ctx);
    return isThenable(out) ? out.then(after) : after(out);
  }

  /** Writes the savings counters now (SIGTERM: before waiting for pending writes). */
  function flush() {
    if (!lv) return;
    try { lv.savings.flush(); } catch { /* best effort */ }
  }

  let closed = false;
  function close() {
    if (closed || !lv) return;
    closed = true;
    for (const f of [() => lv.savings.flush(), () => lv.aliasStore.flush(), () => lv.negativeCache.flushPending(), () => lv.negativeCacheStore.flush(), () => lv.deltaReadStore.flush()]) {
      try { f(); } catch { /* best effort */ }
    }
  }

  return {
    rpc: { handle: (m, ctx) => handleAny(m, ctx), handleAny, serverInfo: rpc.serverInfo },
    lv, rules, close, flush,
  };
}

module.exports = { createAllInOne, setupServerLevers, leverMemoryDir, SERVER_WRITE_TOOLS };
