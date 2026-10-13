"use strict";
// 0.4.10.7 — fix round before the production deploy (one regression test per item).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { createMemoryServer, parseArgs } = require("../memory-server/memglow-memory-server");
const { createStore } = require("../lib/store/store");
const { makeKb: makeSynthetic } = require("../bench/responsiveness");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10); } return true; }
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const call = (srv, name, args, id = 1) => srv.rawRpc.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, {});
const has = (store, rel) => store.notes().some((n) => n.rel === rel);

test("1: an outside save right after the server's rename is not hidden by a stale stat", async () => {
  for (const watch of [false, true]) {
    const root = tmp("memglow-7-1-");
    fs.mkdirSync(path.join(root, "memory"));
    fs.writeFileSync(path.join(root, "memory", "n.md"), "# n\n\noriginal\n");
    let inject = false;
    const srv = createMemoryServer({ root, readOnly: false, watch, pollMs: 0, fsync: false,
      writerHooks: { afterRename: async (abs) => { if (inject) { inject = false; fs.writeFileSync(abs + ".ed", "# n\n\neditor version\n"); fs.renameSync(abs + ".ed", abs); } } } });
    try {
      inject = true;
      const r = await call(srv, "edit_note", { identifier: "n", operation: "append", content: "\nserver line" });
      assert.strictEqual(r.result.isError, false, JSON.stringify(r));
      const read = () => srv.tools.call("read_note", { identifier: "n" }).content[0].text;
      assert.ok(await until(() => /editor version/.test(read()), 2000), `watch=${watch}: the editor's version is served, not the server's forever: ${read()}`);
      assert.ok(!/server line/.test(read()));
    } finally { srv.close(); }
  }
});

test("2: deferred fsyncs are coalesced (one per folder per batch) and run in parallel; --shutdown-timeout (default 25 s)", async () => {
  const root = tmp("memglow-7-2-");
  const synced = [];
  let inFlight = 0, maxInFlight = 0;
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsyncMode: "deferred",
    writerHooks: { beforeDeferredSync: async (p) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(20); inFlight--; synced.push(p); } } });
  try {
    const writes = [];
    for (let i = 0; i < 60; i++) writes.push(call(srv, "write_note", { title: "w" + (i % 20), directory: "memory/d", content: "v" + i, overwrite: true }, i));
    await Promise.all(writes);
    await srv.writer.idle();
    const dirSyncs = synced.filter((p) => p === path.join(root, "memory", "d")).length;
    const fileSyncs = synced.filter((p) => p.endsWith(".md") && !p.includes(".trash")).length;
    assert.ok(fileSyncs <= 60 && fileSyncs >= 20, `${fileSyncs} file fsyncs`);
    // Coalescing, not an exact count: how writes and syncs interleave depends on the machine (a fast CI
    // disk gave 12, the NAS far fewer); 60 writes must still need at most a third as many folder syncs.
    assert.ok(dirSyncs <= 20, `${dirSyncs} fsyncs of the same folder for 60 writes`);
    assert.ok(maxInFlight > 1, "fsyncs run in parallel");
  } finally { srv.close(); }
  assert.strictEqual(parseArgs([]).shutdownTimeoutMs, 25000);
  assert.strictEqual(parseArgs(["--shutdown-timeout", "40"]).shutdownTimeoutMs, 40000);
  assert.strictEqual(parseArgs([], { MEMGLOW_MEMORY_SHUTDOWN_TIMEOUT: "5" }).shutdownTimeoutMs, 5000);
});

test("2b: 60 deferred writes then SIGTERM — the process exits once its fsyncs are done, well within the grace period", { timeout: 90000 }, async () => {
  const root = tmp("memglow-7-2b-");
  const p = spawn(process.execPath, [path.join(__dirname, "..", "memory-server", "memglow-memory-server.js"), "--root", root, "--listen", "127.0.0.1:0", "--read-write", "--fsync-mode", "deferred", "--no-watch", "--poll-ms", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  const port = await new Promise((ok, ko) => { p.stderr.on("data", (c) => { err += c; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(err); if (m) ok(Number(m[1])); }); p.on("exit", () => ko(new Error(err))); });
  const post = (body) => new Promise((ok, ko) => { const d = JSON.stringify(body); const r = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(d) } }, (res) => { res.resume(); res.on("end", ok); }); r.on("error", ko); r.end(d); });
  for (let i = 0; i < 60; i++) await post({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "write_note", arguments: { title: "s" + i, directory: "memory/x", content: "x" + i } } });
  const t0 = Date.now();
  p.kill("SIGTERM");
  const code = await new Promise((ok) => p.on("exit", (c) => ok(c)));
  const ms = Date.now() - t0;
  process.stdout.write(`# exit ${ms} ms after SIGTERM with 60 deferred writes pending\n`);
  assert.strictEqual(code, 0);
  assert.ok(ms < 25000, `${ms} ms`);
  assert.strictEqual(fs.readdirSync(path.join(root, "memory", "x")).filter((f) => f.endsWith(".md")).length, 60);
});

test("3: a change made while the startup load runs is seen through the watcher, not the poll", async () => {
  const root = tmp("memglow-7-3-");
  makeSynthetic(root, 1200);
  const store = createStore({ root, pollMs: 0 });
  const p = store.startAsync({ chunk: 4 });
  await sleep(5);
  fs.writeFileSync(path.join(root, "memory", "family", "early.md"), "# early\n");
  fs.writeFileSync(path.join(root, "memory", "tech", "early2.md"), "# early2\n");
  await p;
  assert.ok(await until(() => has(store, "memory/family/early.md") && has(store, "memory/tech/early2.md"), 1500));
  store.stop();
});

test("4: a long write burst does not postpone a new folder's notes (rescan merged, not dropped)", async () => {
  const root = tmp("memglow-7-4-");
  makeSynthetic(root, 150);
  const srv = createMemoryServer({ root, readOnly: false, pollMs: 0, fsync: false });
  try {
    let stop = false, i = 0;
    const burst = (async () => { while (!stop) await call(srv, "write_note", { title: "b" + i, directory: "memory/home", content: "x" + i }, i++); })();
    await sleep(50);
    fs.mkdirSync(path.join(root, "memory", "newdir"));
    fs.writeFileSync(path.join(root, "memory", "newdir", "n.md"), "# n\n");
    const seen = await until(() => has(srv.store, "memory/newdir/n.md"), 2000);
    stop = true; await burst;
    assert.ok(seen, "indexed DURING the burst");
    assert.ok(has(srv.store, "memory/home/b0.md") && has(srv.store, `memory/home/b${i - 1}.md`), "the burst's own notes kept");
  } finally { srv.close(); }
});

test("5: the .trash backup is fsync'd; a moved file's pending fsync follows it", async () => {
  const root = tmp("memglow-7-5-");
  const synced = [];
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsyncMode: "deferred", writerHooks: { beforeDeferredSync: async (p) => { await sleep(30); synced.push(p); } } });
  try {
    await call(srv, "write_note", { title: "a", directory: "memory", content: "one" });
    await call(srv, "write_note", { title: "a", directory: "memory", content: "two", overwrite: true });
    await srv.writer.idle();
    assert.ok(synced.some((p) => p.includes(path.sep + ".trash" + path.sep) && p.endsWith("a.md")), "the backup copy fsync'd");
    synced.length = 0;
    const base = srv.writer.stats().deferredSyncs;
    await call(srv, "write_note", { title: "m", directory: "memory", content: "move me" });
    await call(srv, "move_note", { identifier: "m", destination_path: "memory/moved/m.md" });
    await srv.writer.idle();
    assert.strictEqual(srv.writer.stats().deferredSyncs - base, synced.length, "none lost to ENOENT: " + synced.join(", "));
    assert.ok(!srv.writer.stats().deferredSyncErrors);
  } finally { srv.close(); }
});

test("6: read_note, edit_note and lever 8's check apply a pending outside save first", async () => {
  const root = tmp("memglow-7-6-");
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "memory", "MEMORY.md"), "# MEMORY\n\nv1 " + "x ".repeat(400) + "\n");
  fs.writeFileSync(path.join(root, "memory", "n.md"), "# n\n\nold text\n");
  const home = tmp("memglow-7-6h-");
  const env = { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_DATA_DIR: path.join(home, "d"), MEMGLOW_PROXY_ALREADY_LOADED: "1" };
  const srv = createMemoryServer({ root, readOnly: false, watch: true, pollMs: 0, fsync: false, allInOne: { env, name: "memglow-memory", onReport: () => {} } });
  try {
    fs.writeFileSync(path.join(root, "memory", "n.md"), "# n\n\nnew text\n");
    assert.match(srv.tools.call("read_note", { identifier: "n" }).content[0].text, /new text/, "read right after the save");
    fs.writeFileSync(path.join(root, "memory", "fresh-one.md"), "# fresh\n\nbody\n");
    const e = await call(srv, "edit_note", { identifier: "fresh-one", operation: "append", content: "\nmore" });
    assert.strictEqual(e.result.isError, false, "edit_note finds a note saved a moment ago: " + JSON.stringify(e));
    const idx = srv.aio.lv.index;
    const h1 = idx.fileHash("MEMORY");
    fs.writeFileSync(path.join(root, "memory", "MEMORY.md"), "# MEMORY\n\nv2 changed\n");
    assert.notStrictEqual(idx.fileHash("MEMORY"), h1, "lever 8 sees the change at once");
  } finally { srv.close(); }
});
