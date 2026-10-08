"use strict";
// memglow memory server, phase B (stage 0.4.5.2): write safety — one write queue (no lost
// update), reads never blocked, atomic replace (a failure mid-write leaves the old file), files
// changed on disk under a write, root confinement through symlinks, file mode/owner, size limit,
// the on-write hook, and the HTTP / stdio transports answering writes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const { createMemoryServer, parseArgs, runStdio } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { makeKb, NOTES } = require("./fixtures/memory-kb");

function setup(opts = {}) {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false, ...opts });
  const file = (rel) => fs.readFileSync(path.join(kb.root, rel), "utf8");
  return { kb, srv, call: (n, a) => srv.tools.call(n, a), file, done: () => { srv.close(); kb.cleanup(); } };
}
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes(".memglow-tmp-"));

test("50 parallel appends to one note: all applied, in order, none lost", async () => {
  const s = setup();
  try {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => s.call("edit_note", { identifier: "alice", operation: "append", content: `- [log] entry ${i}\n` })));
    assert.ok(results.every((r) => r.isError === false && /^# Edited note \(append\)/.test(r.content[0].text)));
    const t = s.file("memory/people/alice.md");
    for (let i = 0; i < 50; i++) assert.strictEqual(t.split(`- [log] entry ${i}\n`).length - 1, 1, `entry ${i} exactly once`);
    const order = [...t.matchAll(/entry (\d+)/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(order, Array.from({ length: 50 }, (_, i) => i), "queue order = call order");
    assert.ok(t.startsWith(NOTES["memory/people/alice.md"]), "the original text is intact before the appends");
    // The store saw the last write (no rescan).
    assert.strictEqual((await s.call("read_note", { identifier: "alice" })).content[0].text, t);
    // Parallel metadata merges on one note + writes to other notes, interleaved.
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      jobs.push(s.call("edit_note", { identifier: "Garden Project", operation: "append", content: "", metadata: { [`k${i}`]: i } }));
      jobs.push(s.call("write_note", { title: `parallel ${i}`, directory: "memory/par", content: `n${i}` }));
    }
    await Promise.all(jobs);
    const g = s.file("memory/projects/garden-project.md");
    for (let i = 0; i < 20; i++) assert.match(g, new RegExp(`\\nk${i}: ${i}\\n`));
    assert.strictEqual(fs.readdirSync(path.join(s.kb.root, "memory/par")).length, 20);
    assert.deepStrictEqual(tmpLeftovers(path.join(s.kb.root, "memory/people")), []);
  } finally { s.done(); }
});

test("reads are never blocked by a write in progress; they see the old version until the rename", async () => {
  let release;
  const gate = new Promise((ok) => { release = ok; });
  let reached;
  const atRename = new Promise((ok) => { reached = ok; });
  const s = setup({ writerHooks: { beforeRename: async () => { reached(); await gate; } } });
  try {
    const before = s.file("memory/people/bob.md");
    const pending = s.call("edit_note", { identifier: "bob", operation: "append", content: "LATER" });
    await atRename;
    const t0 = Date.now();
    assert.strictEqual(s.call("read_note", { identifier: "bob" }).content[0].text, before, "old text while the write waits");
    assert.match(s.call("search_notes", { query: "rugby" }).content[0].text, /Search Results/);
    assert.ok(Date.now() - t0 < 1000, "answered at once");
    // A second write queues behind the first.
    const second = s.call("edit_note", { identifier: "bob", operation: "append", content: "EVEN LATER" });
    release();
    await pending; await second;
    assert.match(s.file("memory/people/bob.md"), /LATER\nEVEN LATER$/);
  } finally { s.done(); }
});

test("a failure mid-write (after the temp file, before the rename) leaves the old file intact and no temp file", async () => {
  for (const hook of ["afterTmpWrite", "beforeRename"]) {
    const s = setup({ writerHooks: { [hook]: async () => { throw new Error("simulated crash"); } } });
    try {
      const before = s.file("memory/people/alice.md");
      const r = await s.call("edit_note", { identifier: "alice", operation: "append", content: "never" });
      assert.strictEqual(r.isError, true, hook);
      assert.match(r.content[0].text, /^Error calling tool 'edit_note': internal error \(simulated crash\)/);
      assert.strictEqual(s.file("memory/people/alice.md"), before, hook + ": old version intact");
      assert.deepStrictEqual(tmpLeftovers(path.join(s.kb.root, "memory/people")), []);
      assert.strictEqual(s.call("read_note", { identifier: "alice" }).content[0].text, before, "the store still serves the old version");
      const w = await s.call("write_note", { title: "new one", directory: "memory/people", content: "x" });
      assert.strictEqual(w.isError, true);
      assert.ok(!fs.existsSync(path.join(s.kb.root, "memory/people/new one.md")), "a failed create leaves nothing");
    } finally { s.done(); }
  }
  // A process killed between the temp write and the rename leaves a dot-file: never indexed, the
  // note keeps its old content, and the next write works.
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.kb.root, "memory/people/.alice.md.memglow-tmp-999-deadbeef"), "---\ntitle: half\n---\nhalf-written");
    s.srv.store.scan();
    assert.ok(!s.srv.store.notes().some((n) => /memglow-tmp/.test(n.rel)));
    assert.strictEqual(s.call("read_note", { identifier: "alice" }).content[0].text, NOTES["memory/people/alice.md"]);
    assert.strictEqual((await s.call("edit_note", { identifier: "alice", operation: "append", content: "ok" })).isError, false);
  } finally { s.done(); }
});

test("a note changed on disk while being edited: the edit is redone on the new text (nothing lost)", async () => {
  let n = 0;
  const kbHolder = {};
  const s = setup({ writerHooks: { beforeRename: async (tmp, abs) => { if (n++ === 0) { fs.appendFileSync(abs, "EXTERNAL EDIT\n"); fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000)); } } } });
  kbHolder.s = s;
  try {
    const r = await s.call("edit_note", { identifier: "bob", operation: "append", content: "OURS\n" });
    assert.strictEqual(r.isError, false, r.content[0].text);
    assert.strictEqual(s.file("memory/people/bob.md"), NOTES["memory/people/bob.md"] + "EXTERNAL EDIT\nOURS\n");
  } finally { s.done(); }
});

test("confinement: a symlinked folder leading outside the root is refused for writes and moves", async (t) => {
  const s = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-outside-"));
  try {
    try { fs.symlinkSync(outside, path.join(s.kb.root, "memory/out"), "dir"); } catch { t.skip("no symlinks here"); return; }
    const w = await s.call("write_note", { title: "escape", directory: "memory/out", content: "x" });
    assert.strictEqual(w.isError, true);
    assert.match(w.content[0].text, /resolves outside the project/);
    const m = await s.call("move_note", { identifier: "alice", destination_path: "memory/out/alice.md" });
    assert.strictEqual(m.isError, true);
    const e = await s.call("edit_note", { identifier: "memory/out/new", operation: "append", content: "x" });
    assert.strictEqual(e.isError, true);
    assert.deepStrictEqual(fs.readdirSync(outside), [], "nothing written outside");
    assert.ok(fs.existsSync(path.join(s.kb.root, "memory/people/alice.md")));
  } finally { s.done(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("file mode: --file-mode applies; otherwise an existing file keeps its mode; owner taken from the folder", async () => {
  const s = setup({ fileMode: 0o640, chownToParent: true });
  try {
    await s.call("write_note", { title: "moded", directory: "memory/m", content: "x" });
    const st = fs.statSync(path.join(s.kb.root, "memory/m/moded.md"));
    assert.strictEqual(st.mode & 0o777, 0o640);
    const dirSt = fs.statSync(path.join(s.kb.root, "memory/m"));
    assert.strictEqual(st.uid, dirSt.uid);
    assert.strictEqual(st.gid, dirSt.gid);
  } finally { s.done(); }
  const s2 = setup();
  try {
    const abs = path.join(s2.kb.root, "memory/people/alice.md");
    fs.chmodSync(abs, 0o600);
    await s2.call("edit_note", { identifier: "alice", operation: "append", content: "x" });
    assert.strictEqual(fs.statSync(abs).mode & 0o777, 0o600);
  } finally { s2.done(); }
});

test("the store is updated by the write itself: version bumped, a rescan finds nothing to re-read, sizes and dates fresh", async () => {
  const s = setup();
  try {
    const v0 = s.srv.store.version();
    const old = s.srv.store.resolve("bob");
    await s.call("edit_note", { identifier: "bob", operation: "append", content: "x".repeat(1000) });
    assert.ok(s.srv.store.version() > v0);
    const n = s.srv.store.resolve("bob");
    const st = fs.statSync(path.join(s.kb.root, "memory/people/bob.md"));
    assert.strictEqual(n.size, st.size);
    assert.strictEqual(n.mtimeMs, st.mtimeMs);
    assert.ok(n.mtimeMs > old.mtimeMs, "dated now, not a day ago");
    assert.strictEqual(s.srv.store.scan(), false, "the rescan sees the same stat: nothing re-read");
    const ra = s.call("recent_activity", { timeframe: "1h", output_format: "json" });
    assert.ok(ra.structuredContent.result.some((x) => x.title === "bob"));
  } finally { s.done(); }
});

test("size limit: a write that would exceed maxFileBytes is refused and nothing is written", async () => {
  const s = setup({ maxFileBytes: 2048 });
  try {
    const r = await s.call("write_note", { title: "big", directory: "memory", content: "y".repeat(5000) });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /too large/);
    assert.ok(!fs.existsSync(path.join(s.kb.root, "memory/big.md")));
  } finally { s.done(); }
});

test("fsync on (the default): writes still go through", async () => {
  const s = setup({ fsync: true });
  try {
    assert.strictEqual((await s.call("write_note", { title: "synced", directory: "memory", content: "durable" })).isError, false);
    assert.match(s.file("memory/synced.md"), /durable$/);
  } finally { s.done(); }
});

test("on-write hook: debounced, one run for a burst of writes, told which files changed; never blocks the writes", async () => {
  const out = path.join(os.tmpdir(), `memglow-hook-${process.pid}-${Date.now()}.txt`);
  const cmd = `"${process.execPath}" -e "require('fs').appendFileSync(${JSON.stringify(out).replace(/"/g, "'")}, process.env.MEMGLOW_CHANGED_FILES + '\\n--\\n')"`;
  const s = setup({ onWrite: cmd, onWriteDelayMs: 300 });
  try {
    const t0 = Date.now();
    await s.call("edit_note", { identifier: "alice", operation: "append", content: "a" });
    await s.call("write_note", { title: "hooked", directory: "memory", content: "b" });
    await s.call("delete_note", { identifier: "bob" });
    assert.ok(Date.now() - t0 < 5000, "writes did not wait for the hook");
    assert.ok(!fs.existsSync(out), "not run yet (debounced)");
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((ok) => setTimeout(ok, 100));
    await new Promise((ok) => setTimeout(ok, 500));
    const runs = fs.readFileSync(out, "utf8").split("\n--\n").filter(Boolean);
    assert.strictEqual(runs.length, 1, "one run for the burst");
    assert.deepStrictEqual(runs[0].split("\n").sort(), ["memory/hooked.md", "memory/people/alice.md", "memory/people/bob.md"]);
    assert.ok(s.srv.writer.stats().hookRuns >= 1);
  } finally { s.done(); fs.rmSync(out, { force: true }); }
});

test("CLI flags: read-only by default, --read-write / env enable writes, --read-only wins, --file-mode, delays", () => {
  assert.strictEqual(parseArgs([], {}).readOnly, true);
  assert.strictEqual(parseArgs(["--read-write"], {}).readOnly, false);
  assert.strictEqual(parseArgs([], { MEMGLOW_MEMORY_READ_WRITE: "1" }).readOnly, false);
  assert.strictEqual(parseArgs(["--read-write", "--read-only"], {}).readOnly, true);
  assert.strictEqual(parseArgs(["--file-mode", "0664"], {}).fileMode, 0o664);
  assert.strictEqual(parseArgs(["--file-mode=640"], {}).fileMode, 0o640);
  assert.strictEqual(parseArgs(["--file-mode", "rw-r"], {}).badFileMode, "rw-r");
  assert.strictEqual(parseArgs(["--on-write-delay-ms", "50"], {}).onWriteDelayMs, 10000, "never under 10 s from the CLI");
  assert.strictEqual(parseArgs(["--no-fsync"], {}).fsync, false);
  const o = parseArgs(["--on-write", "git commit -am x", "--overwrite-default", "--kebab-filenames", "--update-permalinks-on-move"], {});
  assert.deepStrictEqual([o.onWrite, o.overwriteDefault, o.kebabFilenames, o.updatePermalinksOnMove], ["git commit -am x", true, true, true]);
});

test("HTTP transport: a write is answered once done; a batch mixing a read and a write gets both answers", async () => {
  const s = setup();
  const server = createHttpServer({ rpc: s.srv.rpc, store: s.srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = async (body) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })).json();
  try {
    const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.match(init.result.instructions, /write_note/);
    assert.doesNotMatch(init.result.instructions, /read-only/);
    const w = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_note", arguments: { title: "via http", directory: "memory", content: "hello http" } } });
    assert.strictEqual(w.id, 1);
    assert.match(w.result.content[0].text, /^# Created note\n/);
    const batch = await post([
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_note", arguments: { identifier: "via http" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "edit_note", arguments: { identifier: "via http", operation: "append", content: "more" } } },
    ]);
    assert.deepStrictEqual(batch.map((x) => x.id), [2, 3]);
    assert.match(batch[0].result.content[0].text, /hello http$/);
    assert.match(batch[1].result.content[0].text, /^# Edited note \(append\)/);
    const diag = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "basic_memory_diagnostics", arguments: {} } });
    assert.match(diag.result.content[0].text, /- mode: read-write\n- writes: 2 since start/);
  } finally { server.closeAllConnections(); server.close(); s.done(); }
});

test("stdio transport: a write's answer is written before the process would exit", async () => {
  const s = setup();
  try {
    const input = new PassThrough(), output = new PassThrough();
    let outText = "";
    output.on("data", (c) => { outText += c; });
    const ended = new Promise((ok) => runStdio(s.srv.rpc, input, output, ok));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write_note", arguments: { title: "via stdio", directory: "memory", content: "x" } } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }) + "\n");
    input.end();
    await ended;
    const lines = outText.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => l.id).sort(), [7, 8]);
    assert.match(lines.find((l) => l.id === 7).result.content[0].text, /^# Created note/);
  } finally { s.done(); }
});
