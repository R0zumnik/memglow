"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

const TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery";

function start(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-srv-"));
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntheme: projects\ndescription: \"</script><b>x\"\n---\n[[b]]");
  fs.writeFileSync(path.join(dir, "b.md"), "---\ntheme: knowledge\n---\npassword: hunter2hunter2");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-data-"));
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, base: `http://127.0.0.1:${server.address().port}` })));
}
const basic = (p) => "Basic " + Buffer.from("memglow:" + p).toString("base64");

test("viewer: page, config JSON, graph, note, static files", async () => {
  const { server, base } = await start({});
  try {
    const page = await (await fetch(base + "/")).text();
    const cfg = JSON.parse(page.match(/<script type="application\/json" id="memglow-config">([^<]*)<\/script>/)[1]);
    assert.ok(Array.isArray(cfg.themes));
    const g = await (await fetch(base + "/api/graph")).json();
    assert.strictEqual(g.nodes.length, 2);
    const b = await (await fetch(base + "/api/note/b")).json();
    assert.ok(!b.body.includes("hunter2"), "secret masked");
    assert.strictEqual((await fetch(base + "/api/note/zzz")).status, 404);
    for (const f of ["/app.js", "/app.css", "/cost.js", "/vendor/memglow-graph.js"]) assert.strictEqual((await fetch(base + f)).status, 200, f);
    assert.strictEqual((await fetch(base + "/nope")).status, 404);
    const r = await fetch(base + "/");
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  } finally { server.close(); }
});

test("activity route: 404 without a configured token, identical to an unknown route", async () => {
  const { server, base } = await start({});
  try {
    const a = await fetch(base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: "{}" });
    const unknown = await fetch(base + "/api/nothing", { method: "POST", body: "{}" });
    assert.strictEqual(a.status, 404);
    assert.strictEqual(await a.text(), await unknown.text());
  } finally { server.close(); }
});

test("activity route: token, validation, size limit", async () => {
  const { server, base } = await start({ MEMGLOW_TOKEN: TOKEN });
  const post = (auth, body) => fetch(base + "/api/activity", { method: "POST", headers: auth ? { Authorization: auth } : {}, body });
  try {
    assert.strictEqual((await post(null, '{"type":"read","ids":["a"]}')).status, 404);
    assert.strictEqual((await post("Bearer " + "x".repeat(40), '{"type":"read","ids":["a"]}')).status, 404);
    assert.strictEqual((await post("Bearer " + TOKEN, '{"type":"read","ids":["a"]}')).status, 204);
    assert.strictEqual((await post("Bearer " + TOKEN, '{"type":"read","ids":["zzz"]}')).status, 202);
    assert.strictEqual((await post("Bearer " + TOKEN, "not json")).status, 400);
    const big = await post("Bearer " + TOKEN, JSON.stringify({ type: "read", ids: ["a"], pad: "x".repeat(5000) })).catch(() => ({ status: 413 }));
    assert.strictEqual(big.status, 413);
  } finally { server.close(); }
});

test("live stream delivers activity events", async () => {
  const { server, base } = await start({ MEMGLOW_TOKEN: TOKEN });
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.get(base + "/api/stream", (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.includes("event: activity")) { req.destroy(); resolve(buf); }
        });
      });
      req.on("error", () => {});
      setTimeout(() => fetch(base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: '{"type":"write","ids":["a"]}' }), 300);
      setTimeout(() => reject(new Error("no event")), 4000);
    });
    assert.match(got, /"type":"write"/);
    assert.ok(!/hunter2/.test(got), "never content in the stream");
  } finally { server.close(); }
});

// A note of ≈ 6,500 tokens in 4 sections, one heading of which looks like a secret.
function bigNote() {
  const para = (w) => (w + " lorem ipsum dolor sit amet. ").repeat(60) + "\n";
  return "---\ntheme: knowledge\nsubtheme: ops\n---\nIntro line.\n" +
    "## First part\n" + para("a").repeat(3) +
    "## api_key: sk-abcdefghijklmnopqrstuvwxyz\n" + para("b").repeat(3) +
    "## Third <b>part</b>\n" + para("c").repeat(3) +
    "## Fourth part\n" + para("d").repeat(3) + "[[a]]\n";
}

test("memory cost: counts real activity, ignores demo activity, persists ids and numbers only", async () => {
  const { server, base, dir, dataDir } = await start({ MEMGLOW_TOKEN: TOKEN });
  const post = (body) => fetch(base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(body) });
  try {
    fs.writeFileSync(path.join(dir, "big.md"), bigNote());
    const before = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(before.read.today, 0);
    assert.strictEqual(before.tooLarge.length, 1);
    const big = before.tooLarge[0];
    assert.strictEqual(big.id, "big");
    assert.ok(big.tokens > 5000, "above the default threshold");
    assert.ok(big.sections.length === 5, "intro + 4 sections");
    assert.ok(!JSON.stringify(big.sections).includes("sk-abcdef"), "secret-looking heading masked");
    assert.ok(big.split && big.split.length >= 2, "a split is suggested");
    assert.ok(big.split.every((p) => p.tokens <= 2000 || p.titles.length === 1), "parts of ≤ 2,000 tokens unless a single section");

    assert.strictEqual((await post({ type: "read", ids: ["big"], demo: true })).status, 204);
    const demo = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(demo.read.today, 0, "demo activity is not counted");

    assert.strictEqual((await post({ type: "read", ids: ["big"] })).status, 204);
    assert.strictEqual((await post({ type: "write", ids: ["a"] })).status, 204);
    const after = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(after.read.today, big.tokens);
    assert.strictEqual(after.top[0].id, "big");
    assert.strictEqual(after.top[0].reads7, 1);
    assert.deepStrictEqual(after.share && [after.share.notes, after.share.percent], [1, 100]);
    assert.ok(after.written.days7 > 0);
    assert.strictEqual(after.neverRead.available, false, "less than 30 days of data");
    assert.match(after.neverRead.since, /^\d{4}-\d{2}-\d{2}$/);

    await new Promise((ok) => setTimeout(ok, 2300)); // grouped write, 2 s after the burst
    const saved = fs.readFileSync(path.join(dataDir, "activity-counts.json"), "utf8");
    const parsed = JSON.parse(saved);
    const today = Object.keys(parsed.days)[0];
    assert.deepStrictEqual(parsed.days[today].notes.big, { read: 1, search: 0, write: 0 });
    assert.ok(!/lorem|ipsum|hunter2/.test(saved), "counters hold no note content");
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["a.md", "b.md", "big.md"], "nothing written in the notes folder");
  } finally { server.close(); }
});

test("memory cost: no section titles when note bodies are hidden; same password as the rest", async () => {
  const { server, base, dir } = await start({ MEMGLOW_SHOW_BODIES: "false", MEMGLOW_PASSWORD: PASSWORD });
  try {
    fs.writeFileSync(path.join(dir, "big.md"), bigNote());
    assert.strictEqual((await fetch(base + "/api/cost")).status, 401);
    const c = await (await fetch(base + "/api/cost", { headers: { Authorization: basic(PASSWORD) } })).json();
    assert.strictEqual(c.tooLarge[0].id, "big");
    assert.strictEqual(c.tooLarge[0].sections, undefined);
    assert.strictEqual(c.sectionsIncluded, false);
    assert.ok(!JSON.stringify(c).includes("First part"));
  } finally { server.close(); }
});

test("memory cost: threshold from the config file", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-cfg-"));
  const cfgFile = path.join(cfgDir, "memglow.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ largeNoteTokens: 400, splitChunkTokens: 300 }));
  const { server, base } = await start({ MEMGLOW_CONFIG: cfgFile });
  try {
    const c = await (await fetch(base + "/api/cost")).json();
    assert.strictEqual(c.largeNoteTokens, 400);
    assert.strictEqual(c.chunkTokens, 300);
  } finally { server.close(); }
});

test("optional password: Basic auth on the viewer, not on the activity route", async () => {
  const { server, base } = await start({ MEMGLOW_PASSWORD: PASSWORD, MEMGLOW_TOKEN: TOKEN });
  try {
    assert.strictEqual((await fetch(base + "/")).status, 401);
    assert.strictEqual((await fetch(base + "/api/graph", { headers: { Authorization: basic("wrong password!") } })).status, 401);
    assert.strictEqual((await fetch(base + "/api/graph", { headers: { Authorization: basic(PASSWORD) } })).status, 200);
    const a = await fetch(base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: '{"type":"read","ids":["a"]}' });
    assert.strictEqual(a.status, 204);
  } finally { server.close(); }
});
