"use strict";
// 0.4.10.4 — freshness under a second at ~0 % CPU: non-recursive watches on the note folders only,
// events applied asynchronously (a stat of the named file), never a synchronous scan on reads.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createMemoryServer, parseArgs, HELP } = require("../memory-server/memglow-memory-server");
const { makeKb: makeSynthetic } = require("../bench/responsiveness");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return null; await sleep(10); } return Date.now() - t0; }

function kb(n = 40) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-watch-"));
  makeSynthetic(root, n); // memory/<theme>/… plus a .git folder
  fs.mkdirSync(path.join(root, ".trash", "x"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "y"), { recursive: true });
  return root;
}

test("watching: one watcher per note folder, never .git / .trash / node_modules", () => {
  const root = kb();
  const store = createStore({ root, pollMs: 0 }).start();
  try {
    const st = store.stats();
    // root + memory + 5 theme folders
    assert.strictEqual(st.watchedFolders, 7, JSON.stringify(st));
    assert.strictEqual(st.watching, true);
  } finally { store.stop(); }
  const off = createStore({ root, pollMs: 0, watch: false }).start();
  assert.strictEqual(off.stats().watchedFolders, 0, "--no-watch: no watcher");
  off.stop();
});

test("200 file writes inside .git cause 0 rescans and 0 event applies", async () => {
  const root = kb();
  const store = createStore({ root, pollMs: 0 }).start();
  try {
    await sleep(100);
    const before = store.stats();
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, ".git", "objects", (i % 16).toString(16).padStart(2, "0"), "obj-storm-" + i), "z".repeat(50));
    fs.writeFileSync(path.join(root, ".git", "index"), "idx");
    fs.writeFileSync(path.join(root, ".trash", "x", "gone.md"), "# trashed\n");
    await sleep(400);
    const after = store.stats();
    assert.strictEqual(after.fullScans, before.fullScans, "no rescan");
    assert.strictEqual(after.eventApplies, before.eventApplies, "no event applied");
    assert.strictEqual(after.version, before.version);
  } finally { store.stop(); }
});

test("a change to a note is visible in under 1 s, applied asynchronously (no synchronous scan on reads)", async () => {
  const root = kb();
  const srv = createMemoryServer({ root, watch: true, pollMs: 0 });
  try {
    const dir = path.join(root, "memory", "family");
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const find = (w) => srv.tools.call("search_notes", { query: w }).content[0].text.includes("### ");
    const scans0 = srv.store.stats().fullScans;
    fs.appendFileSync(file, "\nzorglubfresh\n");
    // A read right now does not scan synchronously.
    find("zorglubfresh");
    assert.strictEqual(srv.store.stats().fullScans, scans0, "no synchronous scan on the request path");
    const ms = await until(() => find("zorglubfresh"), 1000);
    assert.ok(ms != null, "visible within 1 s");
    process.stdout.write(`# edited note visible after ${ms} ms\n`);
    assert.strictEqual(srv.store.stats().fullScans, scans0, "found through the event (a stat of that file), no rescan");
    // touch (mtime only) → re-read, still fine; a new note in an existing folder; a delete.
    const now = new Date(); fs.utimesSync(file, now, now);
    fs.writeFileSync(path.join(dir, "brand-new-note.md"), "# Brand new\n\nquuxnewword\n");
    assert.ok(await until(() => find("quuxnewword"), 1000) != null, "new note visible within 1 s");
    fs.unlinkSync(path.join(dir, "brand-new-note.md"));
    assert.ok(await until(() => !find("quuxnewword"), 1000) != null, "deleted note gone within 1 s");
    // A new folder: found by a rescan, then watched itself.
    fs.mkdirSync(path.join(root, "memory", "newfolder"));
    fs.writeFileSync(path.join(root, "memory", "newfolder", "a.md"), "# A\n\nfrobnewfolder\n");
    assert.ok(await until(() => find("frobnewfolder"), 1500) != null, "note in a new folder visible");
    assert.ok(await until(() => srv.store.stats().watchedFolders === 8, 1500) != null, "the new folder is watched");
    const applies = srv.store.stats().eventApplies;
    fs.writeFileSync(path.join(root, "memory", "newfolder", "b.md"), "# B\n\nblargsecond\n");
    assert.ok(await until(() => find("blargsecond"), 1000) != null);
    assert.ok(srv.store.stats().eventApplies > applies, "seen through the new folder's own watcher");
  } finally { srv.close(); }
});

test("the writer's own writes (temp dot-files, rename) are not re-read", async () => {
  const root = kb(10);
  const srv = createMemoryServer({ root, readOnly: false, watch: true, pollMs: 0, fsync: false });
  try {
    const v0 = srv.store.stats().version;
    const r = await srv.rawRpc.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_note", arguments: { title: "w", directory: "memory/family", content: "hello" } } }, {});
    assert.strictEqual(r.result.isError, false);
    const v1 = srv.store.stats().version;
    assert.strictEqual(v1, v0 + 1, "the write itself updated the store");
    await sleep(300);
    assert.strictEqual(srv.store.stats().version, v1, "the watcher event found the same file: no new version");
  } finally { srv.close(); }
});

test("CLI: watching is the default, --no-watch opts out, the poll interval stays configurable", () => {
  assert.strictEqual(parseArgs([]).watch, true);
  assert.strictEqual(parseArgs(["--no-watch"]).watch, false);
  assert.strictEqual(parseArgs(["--poll-ms", "15000"]).pollMs, 15000);
  assert.match(HELP, /--no-watch/);
});
