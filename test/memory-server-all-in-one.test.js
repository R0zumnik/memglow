"use strict";
// memglow memory server, all-in-one mode (stage 0.4.8.1, --levers): the MCP proxy's levers, memory
// rules and activity reporting applied in process. The main test runs the SAME scripted session
// against "memglow-mcp-proxy → memglow memory server (no levers)" and against "memory server
// --levers", side by side on two copies of the same fixture with the same lever settings, and
// compares every response body byte for byte (and the activity reports).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createHttpProxy, setupLevers, setupRules } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer, parseArgs } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { leverMemoryDir } = require("../memory-server/all-in-one");
const { HEADER: RULES_HEADER } = require("../lib/memory-rules");
const { makeKb } = require("./fixtures/memory-kb");

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const NAME = "memglow-memory";

function baseKb() {
  const kb = makeKb();
  // An index note long enough for lever 8's stub, a large note for sizeWarning on read.
  kb.write("memory/MEMORY.md", "---\ntitle: MEMORY\ntype: note\npermalink: main/memory/memory\n---\n\n# Memory index\n\n- [[alice]] — Alice, a friend\n- [[Garden Project]] — the garden\n\n" + "Context paragraph about the household and its projects. ".repeat(30));
  kb.write("memory/notes/long-read.md", "---\ntitle: Long read\ntype: note\n---\n\n## Part one\n" + Array.from({ length: 60 }, (_, i) => `garden tomato soil water, line ${i}.`).join("\n") + "\n## Part two\n" + Array.from({ length: 40 }, (_, i) => `rugby stade training, line ${i}.`).join("\n") + "\n");
  return kb;
}

function copyKb(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-kb-"));
  fs.cpSync(src, root, { recursive: true, preserveTimestamps: true });
  return root;
}

function leverEnv(home, extra = {}) {
  return {
    MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"),
    MEMGLOW_POLL_MS: "60000", MEMGLOW_LARGE_NOTE_TOKENS: "300",
    MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_DELTA_READ: "1", MEMGLOW_PROXY_DUPLICATE_HINT: "1", MEMGLOW_PROXY_ALREADY_LOADED: "1",
    MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_PROXY_INDEX_HINT: "1", MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1",
    ...extra,
  };
}

/** "proxy → memory server (no levers)": the two-container set-up of 0.4.6. */
async function startProxyPair(root, env, reports) {
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false });
  const upstream = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: NAME,
    onReport: (e) => reports.push(e), levers: setupLevers(env, NAME), rules: setupRules(env) });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${proxy.address().port}/mcp`, srv,
    close: () => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); srv.close(); } };
}

/** "memory server --levers": one process, one port. */
async function startAllInOne(root, env, reports, opts = {}) {
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false,
    allInOne: { env, name: NAME, onReport: (e) => reports.push(e), ...opts } });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, srv,
    close: () => { server.closeAllConnections(); server.close(); srv.close(); } };
}

/** POST with Node's http (agent chosen by the caller: one agent = one keep-alive connection). */
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

const call = (id, name, args, meta) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

/** The scripted session; returns [{ step, status, text }]. */
async function script(url) {
  const out = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let H = {};
  const step = async (label, body, headers = H) => { const r = await post(url, body, headers, agent); out.push({ step: label, status: r.status, text: r.text }); return r; };
  const init = await step("initialize", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } });
  H = { "mcp-session-id": init.headers["mcp-session-id"] };
  await step("notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" });
  await step("tools/list", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  await step("search (plain)", call(2, "search_notes", { query: "garden" }));
  await step("search + memglow_queries", call(3, "search_notes", { query: "tea", memglow_queries: ["rugby stade", "orleans"] }));
  await step("read_note #1 (sizeWarning)", call(4, "read_note", { identifier: "long-read" }));
  await step("read_note #2 (dedupe)", call(5, "read_note", { identifier: "long-read" }));
  await step("read index (alreadyLoaded)", call(6, "read_note", { identifier: "MEMORY" }));
  await step("read small", call(7, "read_note", { identifier: "main/memory/projects/garden-project" }));
  await step("read fresh", call(8, "read_note", { identifier: "long-read", memglow_fresh: true }));
  await step("write_note (duplicateHint + sizeWarning)", call(9, "write_note", { title: "garden-project-ideas", directory: "memory/ideas", content: "Ideas for the garden project. " + "compost seeds rows. ".repeat(120) }));
  await step("write_note (exact duplicate)", call(10, "write_note", { title: "Rugby Club", directory: "memory/other", content: "A second rugby note." }));
  await step("edit_note", call(11, "edit_note", { identifier: "long-read", operation: "append", content: "\n- [todo] water the tomatoes at dusk" }));
  await step("read after edit (delta)", call(12, "read_note", { identifier: "long-read" }));
  await step("read the new note", call(13, "read_note", { identifier: "garden-project-ideas" }));
  await step("search after write", call(14, "search_notes", { query: "compost seeds" }));
  await step("recent_activity", call(15, "recent_activity", { timeframe: "7d" }));
  await step("stateless 2026-07-28 search + memglow_queries", call(16, "search_notes", { query: "wifi", memglow_queries: ["box répéteur"] }, META), { "mcp-protocol-version": "2026-07-28" });
  await step("batch", [call(17, "read_note", { identifier: "bob" }), call(18, "search_notes", { query: "zebra" })]);
  await step("unknown tool", call(19, "no_such_tool", {}));
  agent.destroy();
  return out;
}

test("all-in-one ≡ proxy → memory server: the same scripted session gives byte-identical answers", async () => {
  const kb = baseKb();
  const rootA = copyKb(kb.root), rootB = copyKb(kb.root);
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-a-")), homeB = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-b-"));
  // The proxy is told where the notes are; all-in-one finds <root>/memory by itself.
  const envA = leverEnv(homeA, { MEMGLOW_MEMORY_DIR: path.join(rootA, "memory") });
  const envB = leverEnv(homeB);
  const repA = [], repB = [];
  const A = await startProxyPair(rootA, envA, repA);
  const B = await startAllInOne(rootB, envB, repB);
  try {
    assert.strictEqual(B.srv.aio.lv.config.memoryDir, path.join(rootB, "memory"), "all-in-one: lever index on <root>/memory");
    const a = await script(A.url);
    const b = await script(B.url);
    assert.strictEqual(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.strictEqual(b[i].status, a[i].status, `status of step "${a[i].step}"`);
      assert.strictEqual(b[i].text, a[i].text, `body of step "${a[i].step}"`);
    }
    // Not vacuous: the levers and the rules really did act in this session.
    const by = Object.fromEntries(b.map((r) => [r.step, r.text]));
    assert.ok(by["initialize"].includes(RULES_HEADER), "memory rules appended to instructions");
    assert.ok(/memglow_queries/.test(by["tools/list"]) && /memglow_fresh/.test(by["tools/list"]), "tools/list augmented");
    assert.match(by["read_note #2 (dedupe)"], /memglow:/, "dedupe stub");
    assert.match(by["read index (alreadyLoaded)"], /already in your context/);
    assert.match(by["read_note #1 (sizeWarning)"], /⚠ memglow: this note is ≈\d+ tokens/);
    assert.match(by["write_note (duplicateHint + sizeWarning)"], /⚠ memglow: this note is now ≈\d+ tokens/);
    assert.match(by["write_note (duplicateHint + sizeWarning)"], /memglow: a note on this subject already exists — \[\[garden-project\]\]/);
    assert.match(by["write_note (exact duplicate)"], /memglow: a note with this title already exists: \[\[rugby-club\]\]/);
    assert.match(by["read after edit (delta)"], /memglow: .*chang/i, "within-session delta");
    assert.ok(!/memglow_queries|memglow_fresh/.test(by["search + memglow_queries"]));
    // The activity reports match too (durationMs aside: timing).
    const strip = (r) => r.map(({ durationMs, ...e }) => e);
    assert.deepStrictEqual(strip(repB), strip(repA));
    assert.ok(repB.length >= 10 && repB.every((e) => e.server === NAME && typeof e.durationMs === "number"));
    // The written notes are the same files.
    for (const rel of ["memory/ideas/garden-project-ideas.md", "memory/notes/long-read.md", "memory/other/Rugby Club.md"]) {
      assert.strictEqual(fs.readFileSync(path.join(rootB, rel), "utf8"), fs.readFileSync(path.join(rootA, rel), "utf8"), rel);
    }
  } finally {
    A.close(); B.close(); kb.cleanup();
    for (const d of [rootA, rootB, homeA, homeB]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("all-in-one: memglow_* arguments never reach the store", async () => {
  const kb = baseKb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-"));
  const B = await startAllInOne(kb.root, leverEnv(home, { MEMGLOW_PROXY_TOC: "1" }), []);
  const seen = [];
  const orig = B.srv.tools.call;
  B.srv.tools.call = (name, args) => { seen.push({ name, args }); return orig(name, args); };
  try {
    const sid = (await post(B.url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "x" } } })).headers["mcp-session-id"];
    const H = { "mcp-session-id": sid };
    await post(B.url, call(1, "search_notes", { query: "garden", memglow_queries: ["tomato", "seeds"] }), H);
    await post(B.url, call(2, "read_note", { identifier: "long-read", memglow_fresh: true, memglow_section: "Part two" }), H);
    await post(B.url, call(3, "search_notes", { query: "garden", memglow_queries: [] }), H);
    await post(B.url, [call(4, "search_notes", { query: "rugby", memglow_queries: ["stade"] })], H); // batch: no multiQuery, still stripped
    await post(B.url, call(5, "search_notes", { query: "wifi", memglow_queries: ["box"] }, META), { "mcp-protocol-version": "2026-07-28" });
    assert.ok(seen.length >= 7, "every call reached the store");
    for (const c of seen) assert.ok(!Object.keys(c.args || {}).some((k) => k.startsWith("memglow_")), JSON.stringify(c));
  } finally { B.srv.tools.call = orig; B.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("all-in-one: the lever index is refreshed right after the server's own writes", async () => {
  const kb = baseKb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-"));
  // Only searchDetails on: no lever of its own calls afterWrite, and the index polls every 60 s.
  const env = { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_POLL_MS: "60000",
    MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_MULTI_QUERY: "0", MEMGLOW_PROXY_ALIASES: "0", MEMGLOW_PROXY_LEARN_ALIASES: "0", MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_RULES: "0" };
  const B = await startAllInOne(kb.root, env, []);
  try {
    const H = { "mcp-session-id": (await post(B.url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })).headers["mcp-session-id"] };
    await post(B.url, call(1, "search_notes", { query: "garden" }), H); // the index is built now
    await post(B.url, call(2, "write_note", { title: "zanzibar-trip", directory: "memory/projects", content: "Plan the zanzibar trip." }), H);
    const r = JSON.parse((await post(B.url, call(3, "search_notes", { query: "zanzibar" }), H)).text);
    const text = r.result.content.map((c) => c.text).join("\n");
    assert.match(text, /zanzibar-trip/);
    assert.ok(B.srv.aio.lv.index.note("zanzibar-trip"), "the new note is known to the levers at once");
  } finally { B.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("all-in-one: sessions never mix — two legacy sessions, two stateless connections; rules once per session", async () => {
  const kb = baseKb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-"));
  const B = await startAllInOne(kb.root, leverEnv(home), []);
  const ag1 = new http.Agent({ keepAlive: true, maxSockets: 1 }), ag2 = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const read = (id, H, ag, meta) => post(B.url, call(id, "read_note", { identifier: "long-read" }, meta), H, ag).then((r) => JSON.parse(r.text).result.content.map((c) => c.text).join("\n"));
    const sessions = [];
    for (const n of [1, 2]) {
      const r = await post(B.url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "client-" + n } } });
      assert.ok(JSON.parse(r.text).result.instructions.includes(RULES_HEADER), `session ${n} gets the memory rules`);
      sessions.push({ "mcp-session-id": r.headers["mcp-session-id"] });
    }
    const full = await read(1, sessions[0]);
    assert.match(await read(2, sessions[0]), /^memglow:/, "same session: dedupe stub");
    assert.strictEqual(await read(3, sessions[1]), full, "another session: the full note");
    // Stateless (2026-07-28): one key per connection.
    const SH = { "mcp-protocol-version": "2026-07-28" };
    assert.strictEqual(await read(4, SH, ag1, META), full);
    assert.match(await read(5, SH, ag1, META), /^memglow:/, "same connection: dedupe stub");
    assert.strictEqual(await read(6, SH, ag2, META), full, "another connection: the full note");
    // A client-chosen session id that looks like a connection key shares nothing with it.
    assert.strictEqual(await read(7, { "mcp-session-id": "conn:1" }), full);
    // Re-initialize under a known session id: a new id is handed out, and the levers follow it.
    const re = await post(B.url, { jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "client-1" } } }, sessions[0]);
    const newSid = re.headers["mcp-session-id"];
    assert.ok(newSid && newSid !== sessions[0]["mcp-session-id"]);
    assert.ok(JSON.parse(re.text).result.instructions.includes(RULES_HEADER), "the new session gets the rules");
    assert.strictEqual(await read(10, { "mcp-session-id": newSid }), full, "a fresh session: the full note");
    assert.match(await read(11, { "mcp-session-id": newSid }), /^memglow:/);
  } finally { ag1.destroy(); ag2.destroy(); B.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("all-in-one over stdio (runStdio): one session per process, multiQuery and writes answered", async () => {
  const { runStdio } = require("../memory-server/memglow-memory-server");
  const { PassThrough } = require("stream");
  const kb = baseKb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-"));
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false, allInOne: { env: leverEnv(home), name: NAME, onReport: () => {} } });
  const input = new PassThrough(), output = new PassThrough();
  let buf = "";
  output.on("data", (c) => { buf += c; });
  const ended = new Promise((ok) => runStdio(srv.rpc, input, output, ok));
  try {
    const lines = [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } },
      call(1, "search_notes", { query: "tea", memglow_queries: ["rugby stade"] }),
      call(2, "read_note", { identifier: "long-read" }),
      call(3, "read_note", { identifier: "long-read" }),
      call(4, "write_note", { title: "Alice Martin", directory: "memory/x", content: "dup" }),
    ];
    input.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await ended;
    const got = Object.fromEntries(buf.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    assert.ok(got[0].result.instructions.includes(RULES_HEADER));
    assert.ok(got[1].result.content.length >= 1);
    assert.match(got[3].result.content[0].text, /^memglow:/);
    assert.match(got[4].result.content.map((c) => c.text).join("\n"), /already exists: \[\[alice\]\]/);
  } finally { srv.close(); kb.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("without --levers the server is the plain 0.4.6 server; flags and the lever notes folder", () => {
  const kb = baseKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
    assert.strictEqual(srv.rpc, srv.rawRpc);
    assert.strictEqual(srv.aio, null);
    srv.close();
    assert.strictEqual(parseArgs([], {}).levers, false);
    assert.strictEqual(parseArgs(["--levers"], {}).levers, true);
    assert.strictEqual(parseArgs([], { MEMGLOW_MEMORY_LEVERS: "1" }).levers, true);
    assert.strictEqual(parseArgs(["--name", "kb", "--source=nas"], {}).name, "kb");
    assert.strictEqual(parseArgs(["--source=nas"], {}).source, "nas");
    assert.strictEqual(parseArgs(["--name", "kb"], {}).unknown, undefined);
    assert.strictEqual(leverMemoryDir(kb.root, {}), path.join(kb.root, "memory"));
    assert.strictEqual(leverMemoryDir(path.join(kb.root, "docs"), {}), path.join(kb.root, "docs"));
    assert.strictEqual(leverMemoryDir(kb.root, { MEMGLOW_MEMORY_DIR: "/elsewhere" }), "/elsewhere");
  } finally { kb.cleanup(); }
});

test("all-in-one: a lever layer failure never takes a call down", async () => {
  const kb = baseKb();
  const boom = () => { throw new Error("boom"); };
  const broken = { clientMessage: boom, serverMessage: boom, wants: boom, multiQuery: { applies: boom, run: boom }, index: { afterWrite: boom } };
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false, allInOne: { env: { MEMGLOW_RULES: "0" }, levers: broken, onReport: boom } });
  try {
    const r = srv.rpc.handleAny(call(1, "read_note", { identifier: "bob" }), {});
    assert.match(r.result.content[0].text, /rugby/);
    const w = await srv.rpc.handleAny(call(2, "write_note", { title: "t1", directory: "memory/x", content: "c" }), {});
    assert.match(w.result.content[0].text, /^# Created note/);
  } finally { srv.close(); }
  // multiQuery applies, then run() throws synchronously: an error answer, never a throw.
  const half = { clientMessage: (m) => ({ msg: m, changed: false }), serverMessage: (m) => ({ msg: m, changed: false }), multiQuery: { applies: () => true, run: boom } };
  const srv2 = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, allInOne: { env: { MEMGLOW_RULES: "0" }, levers: half, onReport: () => {} } });
  try {
    const r = await srv2.rpc.handleAny(call(3, "search_notes", { query: "x", memglow_queries: ["y"] }), {});
    assert.strictEqual(r.id, 3);
    assert.match(r.error.message, /multiQuery failed/);
  } finally { srv2.close(); kb.cleanup(); }
});

test("activity channel \"memory-server\": accepted by the viewer, sent by agent-core", () => {
  const { createMemory } = require("../lib/memory");
  const core = require("../lib/agent-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-ch-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    const m = createMemory({ dir, config: { indexNote: ["MEMORY"], themes: [{ id: "other", label: "Other" }] } });
    m.scan();
    assert.strictEqual(m.activity({ type: "read", ids: ["a"], channel: "memory-server" }).ok, true);
    assert.strictEqual(m.graph().activities.at(-1).channel, "memory-server");
    const saved = process.env.MEMGLOW_TOKEN;
    process.env.MEMGLOW_TOKEN = "t".repeat(40);
    try {
      const body = core.report({ kind: "mcp", trusted: true, server: NAME, tool: "read_note", args: { identifier: "alice" }, result: { content: [] }, durationMs: 3 }, "mcp", { channel: "memory-server", dryRun: true });
      assert.ok(body, "classified");
      assert.strictEqual(body.channel, "memory-server");
    } finally { if (saved === undefined) delete process.env.MEMGLOW_TOKEN; else process.env.MEMGLOW_TOKEN = saved; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
