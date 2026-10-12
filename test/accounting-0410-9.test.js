"use strict";
// 0.4.10.9 — per-client accounting in all-in-one mode (and the proxy), the SIGTERM flush of the
// savings file, `--kebab-filenames` / MEMGLOW_MEMORY_KEBAB_FILENAMES, and lever 15 (slugHint).
//
// The bug this reproduces (production, 2026-10-12): <dataDir>/proxy-savings.json had almost every
// call under "unknown" and only a handful of calls per day. Two causes: (1) only READ tools were
// ever counted (searches, writes, multiQuery searches and every other tool never were), and (2)
// the client was only ever known from a legacy `initialize` — an MCP 2026-07-28 client sends no
// `initialize`, only a per-request `_meta` envelope (clientInfo optional), so it was "unknown".
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { createHttpProxy, setupLevers, setupRules } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer, parseArgs } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const L = require("../lib/proxy-levers");
const { makeKb } = require("./fixtures/memory-kb");

const NAME = "memglow-memory";
const V26 = "2026-07-28";
const META = (clientInfo) => ({ "io.modelcontextprotocol/protocolVersion": V26, "io.modelcontextprotocol/clientCapabilities": {}, ...(clientInfo ? { "io.modelcontextprotocol/clientInfo": clientInfo } : {}) });
const call = (id, name, args, meta) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

function baseKb() {
  const kb = makeKb();
  kb.write("memory/notes/long-read.md", "---\ntitle: Long read\ntype: note\n---\n\n## Part one\n" + Array.from({ length: 60 }, (_, i) => `garden tomato soil water, line ${i}.`).join("\n") + "\n");
  return kb;
}
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-acct-")); }
function envFor(home, extra = {}) {
  return { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_POLL_MS: "60000", MEMGLOW_PROXY_LOG: "0", ...extra };
}
const savingsOf = (home) => JSON.parse(fs.readFileSync(path.join(home, "data", "proxy-savings.json"), "utf8"));
const today = (home) => { const d = savingsOf(home).days; return d[Object.keys(d).sort().pop()]; };

async function startAllInOne(root, env) {
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false, allInOne: { env, name: NAME, onReport: () => {} } });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, srv, lv: srv.aio.lv,
    close: () => { server.closeAllConnections(); server.close(); srv.close(); } };
}
async function startProxyPair(root, env) {
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false });
  const upstream = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const lv = setupLevers(env, NAME);
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: NAME, onReport: () => {}, levers: lv, rules: setupRules({ ...env, MEMGLOW_RULES: "0" }) });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${proxy.address().port}/mcp`, srv, lv,
    close: () => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); srv.close(); } };
}

/** POST; `agent: false` = a new TCP connection for this request. */
function post(url, body, headers = {}, agent = undefined) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(url, { method: "POST", agent, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(data.length), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
const H26 = { "mcp-protocol-version": V26 };

/**
 * The four real traffic shapes; returns the number of tools/call requests each one made, by the
 * bucket it must be counted under. Every shape mixes reads, searches, writes, a multiQuery search
 * and a tool no lever acts on.
 */
async function realTraffic(url) {
  const expect = {};
  const add = (bucket) => { expect[bucket] = (expect[bucket] || 0) + 1; };
  // (a) legacy 2025-06-18 session: `initialize` with clientInfo, then calls (keep-alive).
  const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const init = await post(url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-memoire", version: "1" } } }, {}, a);
  const HA = { "mcp-session-id": init.headers["mcp-session-id"] };
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, HA, a);
  await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, HA, a); // not a tools/call: never counted
  for (const [i, c] of [["read_note", { identifier: "alice" }], ["search_notes", { query: "garden" }], ["recent_activity", { timeframe: "7d" }],
    ["write_note", { title: "legacy-note", directory: "memory/notes", content: "From a legacy session." }]].entries()) {
    await post(url, call(10 + i, c[0], c[1]), HA, a); add("mcp-memoire");
  }
  // (b) 2026-07-28 stateless calls carrying `_meta` with clientInfo (a new connection each time).
  const ccMeta = META({ name: "claude-code", version: "2.5.1" });
  for (const [i, c] of [["read_note", { identifier: "bob" }], ["search_notes", { query: "rugby", memglow_queries: ["stade"] }],
    ["edit_note", { identifier: "legacy-note", operation: "append", content: "\nmore" }], ["list_directory", { dir_name: "/" }]].entries()) {
    await post(url, call(20 + i, c[0], c[1], ccMeta), H26, false); add("claude-code");
  }
  // (b') the SessionStart hook: `_meta` clientInfo session-start-hook.
  await post(url, call(30, "read_note", { identifier: "MEMORY" }, META({ name: "session-start-hook", version: "1" })), H26, false); add("session-start-hook");
  // (c) 2026-07-28 calls with NO clientInfo, on one stable keep-alive connection: User-Agent.
  const c = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const UA = { ...H26, "user-agent": "claude-code/2.5.1 (external, cli)" };
  for (const [i, x] of [["read_note", { identifier: "garden-project" }], ["search_notes", { query: "tea" }], ["build_context", { url: "memory://main/memory/people/alice" }]].entries()) {
    await post(url, call(40 + i, x[0], x[1], META()), UA, c); add("claude-code");
  }
  // (d) 2026-07-28 calls with no clientInfo and a new connection each time: User-Agent, else "unknown".
  for (const [i, x] of [["search_notes", { query: "alice" }], ["read_note", { identifier: "long-read" }]].entries()) {
    await post(url, call(50 + i, x[0], x[1], META()), { ...H26, "user-agent": "claude-code/2.5.1" }, false); add("claude-code");
  }
  for (const [i, x] of [["search_notes", { query: "nothing-here-zz" }], ["no_such_tool", {}]].entries()) {
    await post(url, call(60 + i, x[0], x[1], META()), H26, false); add("unknown");
  }
  a.destroy(); c.destroy();
  return expect;
}

function assertCounted(lv, home, expect) {
  lv.savings.flush();
  const day = today(home);
  const got = Object.fromEntries(Object.entries(day.clients || {}).map(([k, v]) => [k, v.calls]));
  assert.deepStrictEqual(got, expect, "every tools/call counted once, under the best identity");
  for (const [k, v] of Object.entries(day.clients)) assert.ok(v.tokens > 0, `${k}: tokens recorded`);
}

test("all-in-one: every tools/call of the four real traffic shapes is counted once, under the right client", async () => {
  const kb = baseKb(), home = tmpHome();
  const B = await startAllInOne(kb.root, envFor(home));
  try {
    const expect = await realTraffic(B.url);
    assertCounted(B.lv, home, expect);
    // readClientSavings (the cost panel) sees the same totals.
    const r = L.readClientSavings(path.join(home, "data"));
    assert.strictEqual(r.byClient["claude-code"].calls, expect["claude-code"]);
    assert.strictEqual(r.byClient["mcp-memoire"].calls, 4);
  } finally { B.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("proxy mode: the same traffic is counted the same way (same fallback)", async () => {
  const kb = baseKb(), home = tmpHome();
  const A = await startProxyPair(kb.root, envFor(home, { MEMGLOW_MEMORY_DIR: path.join(kb.root, "memory") }));
  try {
    const expect = await realTraffic(A.url);
    assertCounted(A.lv, home, expect);
  } finally { A.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("per-lever savings: all-in-one records exactly what the proxy records", async () => {
  const levers = { MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_TOC: "1", MEMGLOW_LARGE_NOTE_TOKENS: "300" };
  const runOne = async (start, root, home) => {
    const S = await start(root, home);
    try {
      const sid = (await post(S.url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } })).headers["mcp-session-id"];
      const H = { "mcp-session-id": sid };
      await post(S.url, call(1, "read_note", { identifier: "alice" }), H);
      await post(S.url, call(2, "read_note", { identifier: "alice" }), H); // dedupe
      await post(S.url, call(3, "read_note", { identifier: "long-read" }), H); // toc
      await post(S.url, call(4, "read_note", { identifier: "long-read", memglow_section: "Part one" }), H); // toc section
      S.lv.savings.flush();
      return today(home);
    } finally { S.close(); }
  };
  const kbA = baseKb(), kbB = baseKb(), homeA = tmpHome(), homeB = tmpHome();
  try {
    const a = await runOne((root, home) => startProxyPair(root, envFor(home, { ...levers, MEMGLOW_MEMORY_DIR: path.join(root, "memory") })), kbA.root, homeA);
    const b = await runOne((root, home) => startAllInOne(root, envFor(home, levers)), kbB.root, homeB);
    assert.ok(b.dedupe > 0 && b.dedupeCalls === 1, "dedupe recorded in all-in-one: " + JSON.stringify(b));
    assert.ok(b.toc > 0 && b.tocCalls >= 1, "toc recorded in all-in-one");
    assert.deepStrictEqual(b, a);
  } finally { kbA.cleanup(); kbB.cleanup(); for (const d of [homeA, homeB]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a churn of new-connection stateless calls never evicts a legacy session's clientInfo", async () => {
  const kb = baseKb(), home = tmpHome();
  const B = await startAllInOne(kb.root, envFor(home));
  try {
    const sid = (await post(B.url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "mcp-memoire" } } })).headers["mcp-session-id"];
    for (let i = 0; i < 230; i++) await post(B.url, call(100 + i, "list_memory_projects", {}, META()), H26, false);
    await post(B.url, call(1, "read_note", { identifier: "alice" }), { "mcp-session-id": sid });
    B.lv.savings.flush();
    const clients = today(home).clients;
    assert.strictEqual(clients["mcp-memoire"].calls, 1);
    assert.strictEqual(clients.unknown.calls, 230);
  } finally { B.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("identity helpers: _meta clientInfo, User-Agent mapping, empty answers still count", () => {
  assert.deepStrictEqual(L.metaClientInfo({ _meta: META({ name: "claude-code", version: "1" }) }), { name: "claude-code", title: null, version: "1" });
  assert.strictEqual(L.metaClientInfo({ _meta: META() }), null);
  assert.strictEqual(L.metaClientInfo({ _meta: { "io.modelcontextprotocol/clientInfo": { name: " " } } }), null);
  assert.strictEqual(L.clientBucket(L.userAgentClientInfo("claude-code/2.5.1 (external, cli)")), "claude-code");
  assert.strictEqual(L.clientBucket(L.userAgentClientInfo("Claude-Code/3")), "claude-code");
  assert.strictEqual(L.clientBucket(L.userAgentClientInfo("node")), "node");
  assert.strictEqual(L.clientBucket(L.userAgentClientInfo("")), "unknown");
  assert.strictEqual(L.clientBucket(L.userAgentClientInfo(undefined)), "unknown");
  const home = tmpHome();
  try {
    const s = L.createSavings({ savingsFile: true, dataDir: path.join(home, "data") }, () => {});
    s.addClient(null, 0);
    s.addClient({ name: "cursor" }, 12);
    s.flush();
    assert.deepStrictEqual(today(home).clients, { unknown: { tokens: 0, calls: 1 }, cursor: { tokens: 12, calls: 1 } });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("savings file: written within ~2 s by an unref'd timer, and backward compatible (old fields kept, merged)", async () => {
  const home = tmpHome();
  const dataDir = path.join(home, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "proxy-savings.json"), JSON.stringify({ version: 1, days: { "2026-01-01": { dedupe: 5, dedupeCalls: 1, clients: { unknown: { tokens: 3, calls: 1 } } } } }));
    const s = L.createSavings({ savingsFile: true, dataDir }, () => {});
    s.addClient({ name: "claude-code" }, 7);
    await new Promise((ok) => setTimeout(ok, 2400));
    const f = savingsOf(home);
    assert.strictEqual(f.version, 1);
    assert.deepStrictEqual(f.days["2026-01-01"], { dedupe: 5, dedupeCalls: 1, clients: { unknown: { tokens: 3, calls: 1 } } });
    const day = f.days[Object.keys(f.days).sort().pop()];
    assert.deepStrictEqual(day.clients, { "claude-code": { tokens: 7, calls: 1 } });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function freePort() {
  return new Promise((ok, ko) => { const s = net.createServer(); s.once("error", ko); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

test("SIGTERM: the real server writes the savings counted so far before exiting", async () => {
  const kb = baseKb(), home = tmpHome();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "memory-server", "memglow-memory-server.js"), "--root", kb.root, "--listen", "127.0.0.1:" + port, "--levers", "--read-write", "--fsync-mode", "deferred", "--quiet"],
    { env: { ...process.env, ...envFor(home) }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    for (let i = 0; i < 100; i++) {
      const r = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, H26, false).catch(() => null);
      if (r) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    await post(url, call(1, "search_notes", { query: "garden" }, META({ name: "claude-code" })), H26, false);
    await post(url, call(2, "read_note", { identifier: "alice" }, META()), { ...H26, "user-agent": "claude-code/2.5.1" }, false);
    const exited = new Promise((ok) => child.once("exit", ok));
    child.kill("SIGTERM"); // well before the 2 s timer
    await exited;
    assert.strictEqual(today(home).clients["claude-code"].calls, 2, err);
  } finally { try { child.kill("SIGKILL"); } catch { /* gone */ } kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- 2. Non-slug titles ----

test("--kebab-filenames / MEMGLOW_MEMORY_KEBAB_FILENAMES=1: a French title gives a transliterated slug file, the title is kept", async () => {
  assert.strictEqual(parseArgs([], {}).kebabFilenames, false);
  assert.strictEqual(parseArgs([], { MEMGLOW_MEMORY_KEBAB_FILENAMES: "1" }).kebabFilenames, true);
  assert.strictEqual(parseArgs(["--kebab-filenames"], {}).kebabFilenames, true);
  const kb = baseKb();
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false, kebabFilenames: true });
  try {
    await srv.ready;
    const title = "Chantier eau cave Choisy – état au 2026-10-11 soir";
    const r = await srv.tools.call("write_note", { title, directory: "memory", content: "Fuite sous l'évier." });
    assert.ok(!r.isError, JSON.stringify(r));
    const file = path.join(kb.root, "memory", "chantier-eau-cave-choisy-etat-au-2026-10-11-soir.md");
    assert.ok(fs.existsSync(file), fs.readdirSync(path.join(kb.root, "memory")).join(", "));
    assert.match(fs.readFileSync(file, "utf8"), /^title: Chantier eau cave Choisy – état au 2026-10-11 soir$/m);
  } finally { srv.close(); kb.cleanup(); }
});

test("slugHint (lever 15): off by default; on, one advisory line for a non-slug title or a note at the notes root", async () => {
  assert.strictEqual(L.DEFAULTS.slugHint, false);
  assert.ok(L.LEVER_META.some((m) => m.key === "slugHint" && m.env === "MEMGLOW_PROXY_SLUG_HINT"));
  assert.strictEqual(L.anyLever({ slugHint: true }), true);
  const kb = baseKb();
  const homeOff = tmpHome(), homeOn = tmpHome();
  const off = await startAllInOne(kb.root, envFor(homeOff));
  const textOf = (r) => JSON.parse(r.text).result.content.map((c) => c.text).join("\n");
  const title = "Chantier eau cave Choisy – état au 2026-10-11 soir";
  try {
    const r = await post(off.url, call(1, "write_note", { title, directory: "memory", content: "x" }, META({ name: "claude-code" })), H26);
    assert.ok(!/kebab slug/.test(textOf(r)), "off by default: no line");
  } finally { off.close(); }
  const on = await startAllInOne(kb.root, envFor(homeOn, { MEMGLOW_PROXY_SLUG_HINT: "1" }));
  try {
    assert.strictEqual(on.lv.config.slugHint, true);
    const w = (id, args) => post(on.url, call(id, "write_note", args, META({ name: "claude-code" })), H26).then(textOf);
    const t1 = await w(1, { title, directory: "memory", content: "y", overwrite: true });
    assert.ok(t1.includes(`memglow: title "${title}" is not a kebab slug — prefer "chantier-eau-cave-choisy-etat-au-2026-10-11-soir" in a memory/<folder>/ directory`), t1);
    assert.match(t1, /^# Created note|# Updated note/m, "the write itself still happened");
    const t2 = await w(2, { title: "Réunion Été", directory: "memory/house", content: "z" });
    assert.match(t2, /title "Réunion Été" is not a kebab slug — prefer "reunion-ete" \(/);
    assert.ok(!/memory\/<folder>/.test(t2), "already in a sub-folder: no folder advice");
    const t3 = await w(3, { title: "boiler-service", directory: "/", content: "z" });
    assert.match(t3, /memglow: note "boiler-service" was written directly in the notes root folder — prefer a memory\/<folder>\/ directory/);
    const t4 = await w(4, { title: "boiler-service-2", directory: "memory/house", content: "z" });
    assert.ok(!/memglow: (title|note) /.test(t4), "a slug in a sub-folder: nothing");
    const e = await post(on.url, call(5, "edit_note", { identifier: "Réunion Été", operation: "append", content: "\nmore" }, META({ name: "claude-code" })), H26).then(textOf);
    assert.ok(!/kebab slug/.test(e), "edit_note: never");
  } finally { on.close(); kb.cleanup(); for (const d of [homeOff, homeOn]) fs.rmSync(d, { recursive: true, force: true }); }
});
