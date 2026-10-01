"use strict";
// v0.4: "Time to find a note" (lib/find-time.js) and "Memory engine speed" (lib/engine-speed.js):
// pure computations, persistence, the MCP proxy's durationMs, the /api/activity → /api/cost path,
// and the panel renderers (public/cost.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const ft = require("../lib/find-time");
const es = require("../lib/engine-speed");
const core = require("../lib/agent-core");
const { createWatcher, createHttpProxy } = require("../mcp-proxy/memglow-mcp-proxy");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const costPage = require("../public/cost.js");

const TOKEN = "t".repeat(40);
const A = "claude-code|laptop|hook", B = "mcp|desk|mcp-proxy";

test("find time: one episode per search, same actor only, 2-minute window", () => {
  const ev = [
    { type: "search", ids: ["x"], a: A, t: 0 },
    { type: "search", ids: [], a: B, t: 1000 },       // another actor: ignored by A's episode
    { type: "read", ids: ["z"], a: B, t: 2000 },      // ends B's episode (1 s, 1 step)
    { type: "search", ids: ["y"], a: A, t: 5000 },    // A's second search: one more step
    { type: "read", ids: ["note1"], a: A, t: 9000 },  // ends both A episodes
    { type: "search", ids: ["q"], a: A, t: 200000 },  // no read within 2 min: missed
    { type: "read", ids: ["late"], a: A, t: 200000 + ft.WINDOW_MS + 1 },
  ];
  const eps = ft.episodes(ev);
  assert.strictEqual(eps.length, 4);
  assert.deepStrictEqual(eps.map((e) => [e.t, e.found, e.delayMs, e.steps, e.id]), [
    [0, true, 9000, 2, "note1"], [1000, true, 1000, 1, "z"], [5000, true, 4000, 1, "note1"], [200000, false, null, null, null],
  ]);
  const now = 200000 + ft.WINDOW_MS + 5;
  const s = ft.summarize(ev, now, (id) => ({ note1: "Note one", q: "Query hit", z: "Zed" })[id] || null);
  assert.strictEqual(s.searches, 4);
  assert.strictEqual(s.found, 3);
  assert.strictEqual(s.medianDelayMs, 4000);
  assert.strictEqual(s.medianSteps, 1);
  assert.strictEqual(s.missedShare, 0.25);
  assert.deepStrictEqual(s.top.map((x) => [x.found, x.label]), [[false, null], [true, "Note one"], [true, "Note one"], [true, "Zed"]]);
  assert.deepStrictEqual(s.top[0].context, ["Query hit"], "a missed search shows the titles it found");
  // A search whose window is still open is not counted as missed yet.
  const open = ft.summarize([{ type: "search", ids: [], a: A, t: 1000 }], 2000);
  assert.strictEqual(open.searches, 0);
  assert.strictEqual(ft.median([3, 1, 2, 10]), 2.5);
  assert.strictEqual(ft.median([]), null);
});

test("find time: store keeps ids/actors/times only, rejects junk, persists atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-ft-"));
  try {
    const now = Date.now();
    const s = ft.createFindTime({ dir });
    assert.ok(s.add({ type: "search", ids: ["a", "../etc/passwd", "b"], source: "mcp", machine: "m1", channel: "mcp-proxy", t: now - 5000 }));
    assert.strictEqual(s.add({ type: "read", ids: [], source: "mcp", t: now }), null, "a read with no note says nothing");
    assert.strictEqual(s.add({ type: "write", ids: ["a"], source: "mcp", t: now }), null, "writes are not part of it");
    assert.ok(s.add({ type: "read", ids: ["a"], source: "mcp", machine: "m1", channel: "mcp-proxy", t: now - 3000 }));
    assert.deepStrictEqual(s._events()[0], { type: "search", ids: ["a", "b"], a: "mcp|m1|mcp-proxy", t: now - 5000 });
    s.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ft.FILE), "utf8"));
    assert.strictEqual(raw.events.length, 2);
    // A tampered file is sanitised on load.
    raw.events.push({ type: "search", ids: ["<script>"], a: "x y", t: now }, { type: "read", ids: ["ok"], a: A, t: "soon" });
    fs.writeFileSync(path.join(dir, ft.FILE), JSON.stringify(raw));
    const s2 = ft.createFindTime({ dir });
    assert.strictEqual(s2._events().length, 2);
    const sum = s2.summary(now, () => "A");
    assert.deepStrictEqual([sum.searches, sum.found, sum.medianDelayMs], [1, 1, 2000]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("engine speed: durations validated and bounded, p50/p95 per type, slow-search alert", () => {
  assert.strictEqual(es.cleanDuration(12.6), 13);
  for (const bad of [-1, es.MAX_MS + 1, NaN, Infinity, "120", null, undefined, {}]) assert.strictEqual(es.cleanDuration(bad), null, String(bad));
  assert.strictEqual(es.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.strictEqual(es.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.strictEqual(es.percentile([], 50), null);

  const now = 10 * 86400000;
  const day = 86400000;
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ type: "search", ms: 100 + i, t: now - 3 * day - i * 1000 });
  for (let i = 0; i < 5; i++) samples.push({ type: "read", ms: 40, t: now - day / 2 });
  samples.push({ type: "write", ms: 999, t: now - 9 * day }); // outside the 7 days
  let s = es.summarize(samples, now);
  assert.deepStrictEqual(s.types.read, { calls: 5, p50: 40, p95: 40 });
  assert.strictEqual(s.types.write.calls, 0);
  assert.strictEqual(s.types.search.calls, 20);
  assert.strictEqual(s.alert, null, "no recent searches: no alert");

  // Recent searches 2× slower AND ≥ 250 ms slower, with ≥ 10 samples each: alert.
  const slow = samples.concat(Array.from({ length: 10 }, (_, i) => ({ type: "search", ms: 400 + i, t: now - 3600000 - i })));
  s = es.summarize(slow, now);
  assert.ok(s.alert, "alert expected");
  assert.strictEqual(s.alert.baselineMs, 109);
  assert.ok(s.alert.recentMs >= 400);
  // 2× but only +100 ms (fast local server noise): no alert.
  const fast = Array.from({ length: 10 }, (_, i) => ({ type: "search", ms: 50, t: now - 2 * day - i }))
    .concat(Array.from({ length: 10 }, (_, i) => ({ type: "search", ms: 150, t: now - 1000 - i })));
  assert.strictEqual(es.summarize(fast, now).alert, null);
  // Too few recent samples: no alert.
  assert.strictEqual(es.summarize(samples.concat([{ type: "search", ms: 5000, t: now - 10 }]), now).alert, null);
});

test("proxy watcher: durationMs measured between request and response", () => {
  const seen = [];
  let clock = 1000;
  const w = createWatcher({ server: "x", onReport: (e) => seen.push(e), clock: () => clock });
  w.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "q" } } });
  clock = 1234.4;
  w.fromServer({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } });
  assert.strictEqual(seen[0].durationMs, 234);
});

test("agent core: durationMs passed on, empty proxy searches reported, hooks unchanged", () => {
  const S = { servers: ["basic-memory"], memoryDir: null };
  assert.deepStrictEqual(core.classify({ kind: "mcp", trusted: true, server: "x", tool: "search_notes", args: { query: "nothing" }, result: { content: [] } }, S), { type: "search", ids: [] });
  assert.strictEqual(core.classify({ kind: "mcp", server: "basic-memory", tool: "search_notes", args: {}, result: {} }, S), null, "untrusted (hook) empty search: unchanged");
  assert.strictEqual(core.classify({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: {}, result: {} }, S), null, "an empty read is still dropped");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-core-"));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { MEMGLOW_HOME: home, MEMGLOW_TOKEN: "x".repeat(40) });
    const body = core.report({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: { identifier: "alice" }, result: {}, durationMs: 41.7 }, "mcp", { channel: "mcp-proxy", dryRun: true });
    assert.strictEqual(body.durationMs, 42);
    const noDur = core.report({ kind: "mcp", trusted: true, server: "x", tool: "read_note", args: { identifier: "alice" }, result: {}, durationMs: -5 }, "mcp", { dryRun: true });
    assert.ok(!("durationMs" in noDur));
  } finally { process.env = saved; fs.rmSync(home, { recursive: true, force: true }); }
});

test("HTTP proxy: the upstream's response time reaches the report", async () => {
  const upstream = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => setTimeout(() => {
      const m = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "memory://notes/carol" }] } }));
    }, 120));
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const reports = [];
  const proxy = createHttpProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/mcp`, name: "n", onReport: (e) => reports.push(e), levers: null });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.address().port}/mcp`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_note", arguments: { identifier: "carol" } } }) });
    await r.json();
    const t0 = Date.now(); while (!reports.length && Date.now() - t0 < 2000) await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(reports[0].durationMs >= 100 && reports[0].durationMs < 2000, `durationMs ${reports[0].durationMs}`);
  } finally { proxy.close(); upstream.close(); }
});

test("server: /api/activity feeds time to find and engine speed; /api/cost shows titles and numbers only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-sp-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-spd-"));
  fs.writeFileSync(path.join(dir, "alpha.md"), "---\ntitle: Alpha plan\n---\nsecret body words");
  fs.writeFileSync(path.join(dir, "beta.md"), "beta");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_TOKEN: TOKEN }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(body) });
  try {
    const empty = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(empty.findTime.searches, 0);
    assert.strictEqual(empty.engineSpeed.total, 0);
    const who = { source: "mcp", machine: "desk", channel: "mcp-proxy" };
    assert.strictEqual((await post({ type: "search", ids: [], ...who, durationMs: 80 })).status, 202, "a search with no known note: not shown, still measured");
    assert.strictEqual((await post({ type: "search", ids: ["alpha"], ...who, durationMs: 120 })).status, 204);
    assert.strictEqual((await post({ type: "read", ids: ["alpha"], ...who, durationMs: 30 })).status, 204);
    await post({ type: "read", ids: ["beta"], ...who, durationMs: 1e9 });          // out of bounds: dropped
    await post({ type: "read", ids: ["beta"], ...who, durationMs: "fast" });       // not a number: dropped
    await post({ type: "search", ids: ["beta"], ...who, durationMs: 50, demo: true }); // demo: never counted
    const c = await (await fetch(base + "/api/cost")).json();
    assert.deepStrictEqual(c.engineSpeed.types.search, { calls: 2, p50: 80, p95: 120 });
    assert.deepStrictEqual(c.engineSpeed.types.read, { calls: 1, p50: 30, p95: 30 });
    // Both searches end on the read of alpha (2 episodes: 2 steps, then 1 step).
    assert.strictEqual(c.findTime.searches, 2);
    assert.strictEqual(c.findTime.found, 2);
    assert.strictEqual(c.findTime.top[0].label, "Alpha plan");
    assert.ok(!JSON.stringify(c.findTime).includes("secret body"));
    // Persisted in the data folder, never in the notes folder.
    await new Promise((ok) => setTimeout(ok, 2300));
    assert.ok(fs.existsSync(path.join(dataDir, ft.FILE)) && fs.existsSync(path.join(dataDir, es.FILE)));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["alpha.md", "beta.md"]);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("panel: find time and engine speed blocks render, escape titles, show the alert", () => {
  const T = costPage.defaultCostT;
  assert.match(costPage.costFindTime(null, T), /No search counted/);
  assert.match(costPage.costEngineSpeed({ total: 0 }, T), /No timed call yet/);
  const html = costPage.costFindTime({ searches: 4, found: 3, medianDelayMs: 4000, medianSteps: 1.5, missedShare: 0.25,
    top: [{ found: false, context: ["<b>x</b>"] }, { found: true, id: "n1", label: "<img src=x>", delayMs: 9000, steps: 2 }] }, T);
  assert.ok(!html.includes("<img") && !html.includes("<b>x"), "titles escaped");
  assert.match(html, /data-note="n1"/);
  assert.match(html, /4 searches counted/);
  assert.match(html, /25%/);
  const sp = costPage.costEngineSpeed({ total: 3, types: { search: { calls: 2, p50: 80, p95: 1500 }, read: { calls: 1, p50: 30, p95: 30 }, write: { calls: 0 } },
    alert: { recentMs: 900, baselineMs: 200 } }, T);
  assert.match(sp, /Search is getting slower/);
  assert.match(sp, /1\.5\s?s/);
  assert.ok(!/>Write</.test(sp), "a type with no call is not listed");
  assert.strictEqual(costPage.costDuration(null), "—");
  assert.match(costPage.costDuration(80000, "en"), /1\s?min 20\s?s/);
  assert.match(costPage.costRender({ read: { today: 0, days7: 0 }, written: { days7: 0 }, totals: { tokens: 0, notes: 0 }, top: [], tooLarge: [], neverRead: { available: false }, organisation: [], findTime: null, engineSpeed: null }, {}, T), /Time to find a note/);
});
