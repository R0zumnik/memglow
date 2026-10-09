"use strict";
// 0.4.10.1 — fsync mode: sync (default) | deferred | none.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createMemoryServer, parseArgs, resolveFsyncMode } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { createStore } = require("../lib/store/store");
const { createWriter } = require("../memory-server/writer");
const controlPage = require("../public/control.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const call = (srv, name, args, id = 1) => srv.rawRpc.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, {});

test("fsync mode: the public default is sync; --fsync-mode, --no-fsync, MEMGLOW_MEMORY_FSYNC, memoryServer.fsyncMode (never from the current folder)", () => {
  const home = tmp("memglow-fsync-home-");
  const env = { MEMGLOW_HOME: home };
  assert.deepStrictEqual(resolveFsyncMode(parseArgs([], env), env), { mode: "sync", source: "default" });
  assert.strictEqual(resolveFsyncMode(parseArgs(["--fsync-mode", "deferred"], env), env).mode, "deferred");
  assert.strictEqual(resolveFsyncMode(parseArgs(["--fsync-mode=none"], env), env).mode, "none");
  assert.strictEqual(resolveFsyncMode(parseArgs(["--no-fsync"], env), env).mode, "none");
  assert.strictEqual(parseArgs(["--fsync-mode", "bogus"], env).badFsyncMode, "bogus");
  assert.strictEqual(resolveFsyncMode(parseArgs([], { ...env, MEMGLOW_MEMORY_FSYNC: "deferred" }), { ...env, MEMGLOW_MEMORY_FSYNC: "deferred" }).mode, "deferred");
  // ~/.memglow/memglow.config.json
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ memoryServer: { fsyncMode: "deferred" } }));
  assert.deepStrictEqual(resolveFsyncMode(parseArgs([], env), env), { mode: "deferred", source: "memglow.config.json" });
  // flag > env > file
  assert.strictEqual(resolveFsyncMode(parseArgs(["--fsync-mode", "sync"], env), env).mode, "sync");
  // MEMGLOW_CONFIG
  const other = path.join(home, "other.json");
  fs.writeFileSync(other, JSON.stringify({ memoryServer: { fsyncMode: "none" } }));
  assert.strictEqual(resolveFsyncMode(parseArgs([], { ...env, MEMGLOW_CONFIG: other }), { ...env, MEMGLOW_CONFIG: other }).mode, "none");
  // A ./memglow.config.json in the current folder is never read.
  const cwd = tmp("memglow-fsync-cwd-");
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), JSON.stringify({ memoryServer: { fsyncMode: "none" } }));
  const home2 = tmp("memglow-fsync-home2-");
  const prev = process.cwd();
  process.chdir(cwd);
  try { assert.strictEqual(resolveFsyncMode(parseArgs([], { MEMGLOW_HOME: home2 }), { MEMGLOW_HOME: home2 }).mode, "sync"); }
  finally { process.chdir(prev); }
});

test("deferred: the write answers after the rename; idle() waits for every pending fsync", async () => {
  const root = tmp("memglow-fsync-idle-");
  fs.mkdirSync(path.join(root, "memory"));
  let release, synced = [];
  const gate = new Promise((ok) => { release = ok; });
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsyncMode: "deferred",
    writerHooks: { beforeDeferredSync: async (p) => { await gate; synced.push(p); } } });
  try {
    const r = await call(srv, "write_note", { title: "deferred one", directory: "memory", content: "hello" });
    assert.strictEqual(r.result.isError, false, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(root, "memory", "deferred one.md")), "renamed into place before the answer");
    assert.strictEqual(synced.length, 0, "fsyncs not done yet");
    assert.ok(srv.writer.stats().pendingSyncs > 0, "fsyncs pending");
    let idleDone = false;
    const idle = srv.writer.idle().then(() => { idleDone = true; });
    await new Promise((ok) => setTimeout(ok, 100));
    assert.strictEqual(idleDone, false, "idle() waits for the pending fsyncs");
    release();
    await idle;
    assert.ok(synced.some((p) => p.endsWith("deferred one.md")), "the file was fsync'd");
    assert.ok(synced.some((p) => p === path.join(root, "memory")), "and its folder");
    assert.strictEqual(srv.writer.stats().pendingSyncs, 0);
    assert.ok(srv.writer.stats().deferredSyncs >= 2);
  } finally { srv.close(); }
});

test("sync (default) and none: no deferred fsync ever pending; healthz and the control panel show the mode read-only", async () => {
  for (const mode of ["sync", "none"]) {
    const root = tmp("memglow-fsync-" + mode + "-");
    const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, ...(mode === "sync" ? {} : { fsyncMode: mode }) });
    try {
      assert.strictEqual(srv.writer.fsyncMode, mode);
      const r = await call(srv, "write_note", { title: "x", directory: "d", content: "y" });
      assert.strictEqual(r.result.isError, false);
      assert.strictEqual(srv.writer.stats().pendingSyncs, 0);
      assert.strictEqual(srv.writer.stats().deferredSyncs, 0);
    } finally { srv.close(); }
  }
  const root = tmp("memglow-fsync-hz-");
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsyncMode: "deferred" });
  const get = (port, headers = {}) => new Promise((ok, ko) => http.get({ port, host: "127.0.0.1", path: "/healthz", headers }, (res) => { const p = []; res.on("data", (c) => p.push(c)); res.on("end", () => ok(JSON.parse(Buffer.concat(p)))); }).on("error", ko));
  for (const token of ["", "s3cret-token"]) {
    const server = createHttpServer({ rpc: srv.rpc, store: srv.store, readOnly: false, token, fsyncMode: srv.writer.fsyncMode });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const anon = await get(server.address().port);
      if (token) {
        assert.ok(!("fsyncMode" in anon), "an unauthenticated caller never sees it when a token is set");
        assert.strictEqual((await get(server.address().port, { authorization: "Bearer " + token })).fsyncMode, "deferred");
      } else assert.strictEqual(anon.fsyncMode, "deferred");
    } finally { server.close(); }
  }
  srv.close();
  const html = controlPage.controlRenderMemoryServer({ configured: true, ok: true, readOnly: false, tokenRequired: false, version: "1", notes: 3, fsyncMode: "deferred" });
  assert.match(html, /data-fsync-mode="deferred"/);
  assert.match(html, /fsync deferred/);
  assert.ok(!/<input|<select|<button/.test(html), "a badge, never a control");
  assert.ok(!/fsync/.test(controlPage.controlRenderMemoryServer({ configured: true, ok: true, readOnly: true, version: "1", notes: 3 })), "no badge without the information");
});

test("deferred: kill -9 in the middle of a stream of writes leaves every file intact, old or new version", { timeout: 60000 }, async () => {
  const root = tmp("memglow-fsync-kill-");
  const child = path.join(root, "..", path.basename(root) + "-child.js");
  const N = 6;
  fs.writeFileSync(child, `
    const fsp = require("fs").promises, path = require("path");
    const { createStore } = require(${JSON.stringify(path.join(__dirname, "..", "lib", "store", "store.js"))});
    const { createWriter } = require(${JSON.stringify(path.join(__dirname, "..", "memory-server", "writer.js"))});
    const root = ${JSON.stringify(root)};
    const text = (f, v) => "# note " + f + " v" + v + "\\n" + ("line of version " + v + " of note " + f + "\\n").repeat(3000) + "END v" + v + "\\n";
    (async () => {
      const store = createStore({ root, watch: false, pollMs: 0 }); store.start();
      const w = createWriter({ store, fsyncMode: "deferred", chownToParent: false });
      for (let f = 0; f < ${N}; f++) await w.run(async () => { const abs = path.join(root, "n" + f + ".md"); await w.writeAtomic(abs, text(f, 0), null); });
      process.stdout.write("ready\\n");
      for (let v = 1; ; v++) for (let f = 0; f < ${N}; f++) w.run(async () => { const abs = path.join(root, "n" + f + ".md"); const prev = await fsp.stat(abs); await w.writeAtomic(abs, text(f, v), prev); });
    })();
    setInterval(() => {}, 1000);
  `);
  const p = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => p.stdout.on("data", (c) => { if (String(c).includes("ready")) ok(); }));
  await new Promise((ok) => setTimeout(ok, 400));
  p.kill("SIGKILL");
  await new Promise((ok) => p.on("exit", ok));
  for (let f = 0; f < N; f++) {
    const t = fs.readFileSync(path.join(root, "n" + f + ".md"), "utf8");
    const m = /^# note (\d+) v(\d+)\n/.exec(t);
    assert.ok(m && Number(m[1]) === f, "header intact");
    const v = m[2];
    const want = "# note " + f + " v" + v + "\n" + ("line of version " + v + " of note " + f + "\n").repeat(3000) + "END v" + v + "\n";
    assert.strictEqual(t, want, `n${f}.md is exactly one whole version (v${v})`);
  }
});

test("bench: deferred write p50 under 50 ms on a temp folder (sync for comparison)", { timeout: 120000 }, async () => {
  const out = {};
  for (const mode of ["deferred", "sync"]) {
    const root = tmp("memglow-fsync-bench-" + mode + "-");
    const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsyncMode: mode });
    const ms = [];
    const n = mode === "sync" ? 8 : 30;
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      const r = await call(srv, "write_note", { title: "b" + i, directory: "memory", content: "bench " + i }, i);
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.strictEqual(r.result.isError, false);
    }
    await srv.writer.idle();
    srv.close();
    ms.sort((a, b) => a - b);
    out[mode] = Math.round(ms[Math.floor(ms.length / 2)] * 100) / 100;
  }
  process.stdout.write(`# write p50 ms: deferred ${out.deferred}, sync ${out.sync}\n`);
  assert.ok(out.deferred < 50, `deferred p50 ${out.deferred} ms`);
});
