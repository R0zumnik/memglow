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
  const config = loadConfig({ MEMORY_DIR: dir, ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
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
    for (const f of ["/app.js", "/app.css", "/vendor/memglow-graph.js"]) assert.strictEqual((await fetch(base + f)).status, 200, f);
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
