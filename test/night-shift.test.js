"use strict";
// The control panel ("Night Shift", GET /panel) and the small additions behind it: per-day
// maintenance counts (lib/weekly-report.js), per-day savings (lib/levers/accounting.js), the
// memory server's GET /api/maintenance/events, the viewer's relay of it, and the page itself.
// The pure renderers of public/control.js are tested in test/i18n.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const weekly = require("../lib/weekly-report");
const levers = require("../lib/proxy-levers");
const setup = require("../lib/setup");
const { dayOf } = require("../lib/cost");
const { createHttpServer } = require("../memory-server/http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); let v; while (!(v = await fn()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 40)); return v; };

test("weekly-report: buildDailyReport — the weekly counts, one entry per local day, oldest first, the window respected", () => {
  const now = new Date(2026, 10, 4, 9, 0).getTime();
  const at = (daysAgo, h) => new Date(2026, 10, 4 - daysAgo, h, 0).getTime();
  const days = weekly.buildDailyReport({
    autoSplitEvents: [{ t: at(0, 1), kind: "split" }, { t: at(2, 1), kind: "split-failed" }, { t: at(9, 1), kind: "split" }],
    structureEvents: [{ t: at(0, 2), kind: "fix", detail: "R2 — Up line" }, { t: at(0, 3), kind: "fix", detail: "R3 — x" }, { t: at(1, 2), kind: "cache-reused", detail: "4 cached verdicts" }],
    archiveEvents: [{ t: at(6, 2), kind: "archived", detail: "3 section(s) → a" }, { t: "bad", kind: "archived" }, null],
  }, now, 7);
  assert.strictEqual(days.length, 7);
  assert.deepStrictEqual(days.map((d) => d.day), [6, 5, 4, 3, 2, 1, 0].map((n) => weekly.localDay(at(n, 12))));
  assert.deepStrictEqual(days[6], { day: weekly.localDay(now), notesSplit: 1, structureFixes: 2, sectionsArchived: 0, aiCalls: 1, cachedVerdicts: 0, errors: 0 });
  assert.strictEqual(days[5].cachedVerdicts, 4);
  assert.deepStrictEqual([days[4].errors, days[4].aiCalls, days[4].notesSplit], [1, 1, 0]);
  assert.strictEqual(days[0].sectionsArchived, 3);
  assert.strictEqual(days.reduce((a, d) => a + d.notesSplit, 0), 1, "an event older than the window is ignored");
  assert.strictEqual(weekly.buildDailyReport({}, now, 7).every((d) => d.notesSplit === 0 && d.errors === 0), true);
  assert.strictEqual(weekly.buildDailyReport(undefined, now, 3).length, 3);
});

test("accounting: readDailySavings — saved and relayed tokens per day, every day present, readClientSavings unchanged", () => {
  const dir = tmp("memglow-ns-sav-");
  const now = Date.UTC(2026, 10, 4, 12);
  assert.strictEqual(levers.readDailySavings("", { now }), null);
  const empty = levers.readDailySavings(dir, { now, windowDays: 3 });
  assert.deepStrictEqual(empty, [2, 1, 0].map((i) => ({ day: dayOf(now - i * 86400000), saved: 0, relayed: 0, calls: 0 })));
  fs.writeFileSync(path.join(dir, "proxy-savings.json"), JSON.stringify({ version: 1, days: {
    [dayOf(now)]: { dedupe: 100, toc: 40, stateView: 10, dedupeCalls: 3, clients: { "claude-code": { tokens: 900, calls: 5 }, cursor: { tokens: 100, calls: 1 }, bad: null } },
    [dayOf(now - 86400000)]: { dedupe: "x", toc: -5, clients: "nope" },
    [dayOf(now - 40 * 86400000)]: { dedupe: 999 },
  } }));
  const r = levers.readDailySavings(dir, { now });
  assert.strictEqual(r.length, 30);
  assert.deepStrictEqual(r[29], { day: dayOf(now), saved: 150, relayed: 1000, calls: 6 });
  assert.deepStrictEqual(r[28], { day: dayOf(now - 86400000), saved: 0, relayed: 0, calls: 0 }, "garbage in a day never throws, never goes negative");
  assert.strictEqual(r.reduce((a, d) => a + d.saved, 0), 150, "a day older than the window is left out");
  assert.deepStrictEqual(Object.keys(levers.readClientSavings(dir, { now })).sort(), ["byClient", "byLever", "days", "sessionStart"], "the existing answer keeps its exact shape");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("memory server: GET /api/maintenance/events — 7 days of worker events, per-day counts, schedule; token-gated; /api/maintenance untouched", async () => {
  const now = Date.now();
  const worker = (events, status) => ({ recentEvents: (since = -Infinity) => events.filter((e) => e.t >= since), status: () => status });
  const autoSplit = worker([{ t: now - 3600000, kind: "split", note: "trip", detail: "3 parts" }, { t: now - 9 * 86400000, kind: "split", note: "old", detail: "" }],
    { enabled: true, provider: "anthropic", model: "claude-haiku-4-5", keySet: true, thresholdTokens: 5000, pendingCount: 0, lastScanAt: now - 7200000, nextScanAt: now + 7200000, lastError: null });
  const structure = worker([{ t: now - 1800000, kind: "fix", note: "bike", detail: "R2 — Up line added" + "x".repeat(600) }],
    { enabled: true, ai: { enabled: true, provider: "anthropic", model: "claude-haiku-4-5", apiKeyEnv: "SECRET_NAME" }, issues: { total: 3, fixable: 1, needsReview: 2, byRule: {} }, issueList: [], duplicates: [], lastScanAt: now - 7200000, nextScanAt: null, lastError: null });
  const server = createHttpServer({ rpc: { handleAny: () => null }, store: { notes: () => [] }, token: "s3cret", readOnly: false, autoSplit, structure });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(base + "/api/maintenance/events")).status, 401);
    const r = await fetch(base + "/api/maintenance/events", { headers: { authorization: "Bearer s3cret" } });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.deepStrictEqual(Object.keys(j).sort(), ["archive", "autoSplit", "days", "now", "schedule", "since", "structure"]);
    assert.strictEqual(j.autoSplit.length, 1, "older than 7 days: left out");
    assert.deepStrictEqual(Object.keys(j.autoSplit[0]).sort(), ["detail", "kind", "note", "t"]);
    assert.match(j.autoSplit[0].t, /^\d{4}-\d{2}-\d{2}T/, "ISO time, never raw epoch ms");
    assert.strictEqual(j.structure[0].detail.length, 300, "a detail is bounded");
    assert.deepStrictEqual(j.archive, []);
    assert.strictEqual(j.days.length, 7);
    assert.strictEqual(j.days.reduce((a, d) => a + d.notesSplit, 0), 1);
    assert.strictEqual(j.days.reduce((a, d) => a + d.structureFixes, 0), 1);
    assert.deepStrictEqual(j.schedule.structure.ai, { enabled: true, provider: "anthropic", model: "claude-haiku-4-5" }, "never more of the AI config than this");
    assert.deepStrictEqual([j.schedule.structure.fixable, j.schedule.structure.needsReview], [1, 2]);
    assert.match(j.schedule.autoSplit.nextScanAt, /^\d{4}-/);
    assert.deepStrictEqual(j.schedule.archive, { lastScanAt: null, nextScanAt: null });
    assert.ok(!JSON.stringify(j).includes("SECRET_NAME"));
    const m = await (await fetch(base + "/api/maintenance", { headers: { authorization: "Bearer s3cret" } })).json();
    assert.deepStrictEqual(Object.keys(m).sort(), ["archive", "autoSplit", "duplicates", "structure", "weekly"]);

    // The viewer's own reader of it (lib/setup.js): same URL rule, re-validated, bounded.
    assert.deepStrictEqual(await setup.memoryMaintenanceEvents({ url: "" }), { configured: false });
    assert.deepStrictEqual(await setup.memoryMaintenanceEvents({ url: "not a url" }), { configured: true, ok: false, error: "bad-url" });
    assert.deepStrictEqual(await setup.memoryMaintenanceEvents({ url: base + "/healthz" }), { configured: true, ok: false, error: "http-401" });
    for (const url of [base, base + "/healthz", base + "/api/maintenance"]) {
      const ev = await setup.memoryMaintenanceEvents({ url, token: "s3cret" });
      assert.strictEqual(ev.ok, true, url);
      assert.strictEqual(ev.autoSplit[0].note, "trip");
      assert.strictEqual(ev.days.length, 7);
      assert.strictEqual(ev.schedule.structure.needsReview, 2);
    }
  } finally { server.close(); }
});

test("setup: memoryMaintenanceEvents — an older memory server (404), a wrong shape, hostile values", async () => {
  let answer = null;
  const fake = http.createServer((req, res) => {
    if (!answer) { res.writeHead(404); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer));
  });
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${fake.address().port}`;
  try {
    assert.deepStrictEqual(await setup.memoryMaintenanceEvents({ url }), { configured: true, ok: false, error: "http-404" });
    answer = { autoSplit: "no" };
    assert.deepStrictEqual(await setup.memoryMaintenanceEvents({ url }), { configured: true, ok: false, error: "bad-answer" });
    answer = {
      since: 12, now: "2026-11-04T08:00:00.000Z", days: [{ day: "2026-11-04", notesSplit: -3, structureFixes: 2.7, errors: "x" }, { day: "<script>" }, null],
      autoSplit: [{ t: "2026-11-04T01:00:00.000Z", kind: "split", note: "n".repeat(900), detail: 5, secret: "sk-ant-nope" }, { t: 5, kind: "x" }, "junk"],
      structure: [], archive: Array.from({ length: 400 }, (_, i) => ({ t: "2026-11-04T01:00:00.000Z", kind: "left", note: "n" + i })),
      schedule: { autoSplit: { lastScanAt: 3, nextScanAt: "2026-11-05T01:00:00.000Z", apiKey: "sk-ant-nope" }, structure: "junk" },
    };
    const ev = await setup.memoryMaintenanceEvents({ url });
    assert.strictEqual(ev.ok, true);
    assert.strictEqual(ev.since, null);
    assert.deepStrictEqual(ev.days, [{ day: "2026-11-04", notesSplit: 0, structureFixes: 2, sectionsArchived: 0, aiCalls: 0, cachedVerdicts: 0, errors: 0 }]);
    assert.strictEqual(ev.autoSplit.length, 1);
    assert.strictEqual(ev.autoSplit[0].note.length, 200);
    assert.strictEqual(ev.autoSplit[0].detail, "5");
    assert.strictEqual(ev.archive.length, 300, "at most 300 events per worker, the newest");
    assert.strictEqual(ev.archive[299].note, "n399");
    assert.deepStrictEqual(ev.schedule.autoSplit, { lastScanAt: null, nextScanAt: "2026-11-05T01:00:00.000Z" });
    assert.deepStrictEqual(ev.schedule.structure, { lastScanAt: null, nextScanAt: null, ai: { enabled: false, provider: "", model: "" }, fixable: 0, needsReview: 0 });
    assert.ok(!JSON.stringify(ev).includes("sk-ant"));
  } finally { fake.close(); }
});

test("viewer: GET /panel (own CSP, fingerprinted assets, self-hosted font), GET /api/maintenance/events relays the memory server, /api/cost carries savingsByDay", async () => {
  const dir = tmp("memglow-ns-kb-"), data = tmp("memglow-ns-data-");
  fs.writeFileSync(path.join(dir, "a.md"), "# A\n");
  const mem = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/maintenance/events") return res.end(JSON.stringify({ since: "2026-11-01T00:00:00.000Z", now: "2026-11-04T00:00:00.000Z", days: [], autoSplit: [{ t: "2026-11-03T01:00:00.000Z", kind: "split", note: "trip", detail: "3 parts" }], structure: [], archive: [], schedule: {} }));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((ok) => mem.listen(0, "127.0.0.1", ok));
  const env = { MEMORY_DIR: dir, MEMGLOW_DATA_DIR: data, MEMGLOW_HOME: tmp("memglow-ns-home-"), MEMGLOW_MEMORY_URL: `http://127.0.0.1:${mem.address().port}` };
  const config = loadConfig(env);
  config.title = "mem<glow>";
  const server = createServer(config, createMemory({ dir: config.memoryDir, config }), { assistantEnv: env });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(base + "/api/maintenance/events")).json();
    assert.ok(first.configured === false || first.ok === true, "answers at once with what it knows, never blocks on the memory server");
    const r = await fetch(base + "/panel");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(r.headers.get("content-security-policy"), /default-src 'self'.*script-src 'self'.*font-src 'self'/);
    assert.strictEqual(r.headers.get("x-frame-options"), "DENY");
    const html = await r.text();
    assert.ok(html.includes("mem&lt;glow&gt;") && !html.includes("mem<glow>"), "the title is escaped");
    assert.ok(!html.includes("{{"), "every placeholder is filled");
    const assets = [...html.matchAll(/(?:href|src)="(\/[^"]+\?v=[0-9a-f]{10})"/g)].map((m) => m[1]);
    assert.ok(assets.length >= 5, "stylesheet, boot script, font, i18n.js, control.js");
    for (const a of assets) {
      const f = await fetch(base + a);
      assert.strictEqual(f.status, 200, a);
      assert.match(f.headers.get("cache-control"), /immutable/, a);
      await f.arrayBuffer();
    }
    assert.strictEqual((await fetch(base + "/vendor/fonts/bricolage-grotesque-latin-ext.woff2")).headers.get("content-type"), "font/woff2");
    const ev = await waitFor(async () => { const j = await (await fetch(base + "/api/maintenance/events")).json(); return j.ok ? j : null; });
    assert.ok(ev, "the background refresh lands");
    assert.strictEqual(ev.autoSplit[0].note, "trip");
    const cost = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(cost.savingsByDay.length, 30);
    assert.deepStrictEqual(Object.keys(cost.savingsByDay[0]).sort(), ["calls", "day", "relayed", "saved"]);
    // The memory page's "Control" entry now leads here.
    assert.match(await (await fetch(base + "/")).text(), /<a class="bn-btn" id="mem-control" href="\/panel"/);
    assert.strictEqual((await fetch(base + "/panel", { method: "POST" })).status, 404);
  } finally {
    server.close(); mem.close();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
  }
});
