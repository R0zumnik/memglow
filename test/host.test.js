"use strict";
// DNS-rebinding guard: without a password, only localhost-style host names (or listed ones) are served.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { createCounters } = require("../lib/counters");
const { loadConfig } = require("../lib/config");

const TOKEN = "t".repeat(40);

function start(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-host-"));
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntheme: people\n---\nSecret body of A");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hdata-"));
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_TOKEN: TOKEN, ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const counters = createCounters({ dir: dataDir });
  const server = createServer(config, memory, { counters });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port })));
}

// http.request so that the Host header can be set freely, as a rebinding page would.
function get(port, pathname, host, extra = {}) {
  return new Promise((ok, ko) => {
    const hdrs = host === null ? { ...(extra.headers || {}) } : { Host: host, ...(extra.headers || {}) };
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: extra.method || "GET", headers: hdrs, setHost: host !== null }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode, body }));
    });
    req.on("error", ko);
    req.end(extra.body || undefined);
  });
}

test("no password: localhost names are served, a foreign host name is refused everywhere", async () => {
  const s = await start();
  try {
    for (const h of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `LOCALHOST:${s.port}`, `[::1]:${s.port}`, "localhost"]) {
      assert.strictEqual((await get(s.port, "/", h)).status, 200, h);
    }
    for (const p of ["/", "/api/graph", "/api/cost", "/api/view", "/events"]) {
      const r = await get(s.port, p, `attacker.example:${s.port}`);
      assert.strictEqual(r.status, 403, p);
      assert.ok(!r.body.includes("Secret body"), "no note content leaks on " + p);
    }
    assert.strictEqual((await get(s.port, "/", "127.0.0.1.attacker.example")).status, 403, "look-alike name");
    assert.ok([400, 403].includes((await get(s.port, "/", null)).status), "no Host header is refused (Node answers 400 itself)");
  } finally { s.server.close(); }
});

test("MEMGLOW_ALLOWED_HOSTS lists extra names (case-insensitive, port ignored)", async () => {
  const s = await start({ MEMGLOW_ALLOWED_HOSTS: "Nas.Local, 192.0.2.10" });
  try {
    assert.strictEqual((await get(s.port, "/", "nas.local:4747")).status, 200);
    assert.strictEqual((await get(s.port, "/", "192.0.2.10")).status, 200);
    assert.strictEqual((await get(s.port, "/", "other.local")).status, 403);
  } finally { s.server.close(); }
});

test("with a password the host name is not restricted (credentials protect it)", async () => {
  const s = await start({ MEMGLOW_PASSWORD: "a-long-password-123" });
  try {
    assert.strictEqual((await get(s.port, "/", "my-server.example")).status, 401);
    const auth = "Basic " + Buffer.from("memglow:a-long-password-123").toString("base64");
    assert.strictEqual((await get(s.port, "/", "my-server.example", { headers: { Authorization: auth } })).status, 200);
  } finally { s.server.close(); }
});

test("hooks keep working whatever the host name: POST /api/activity is checked by its token", async () => {
  const s = await start();
  try {
    const r = await get(s.port, "/api/activity", "memglow:4747", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "read", ids: ["a"], source: "test" }),
    });
    assert.ok([204, 202].includes(r.status), "activity accepted: " + r.status);
  } finally { s.server.close(); }
});
