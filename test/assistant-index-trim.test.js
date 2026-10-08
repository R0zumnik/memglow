"use strict";
// "Trim the index" (lib/index-trim.js plan, lib/assistant/index.js's proposeIndexTrim), end to end
// through the same job machinery as split/regroup/archive/tidy: propose -> diff -> confirm -> apply
// -> Undo. Fully deterministic, no AI, no provider needed at all.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// index.md: one line whose dropped text is already in its note's description (kept as is), one
// line whose note has no description at all (also gets one, moved in the same proposal).
function indexTrimMemory() {
  const dir = tmp("memglow-idxtrim-mem-");
  const write = (name, body) => fs.writeFileSync(path.join(dir, name + ".md"), body);
  write("index", [
    "# Memory index",
    "- [[note-desc]] — This note already has a long description that matches its hook exactly here",
    "- [[note-nodesc]] — This other note has no description yet so it should get one added for it",
  ].join("\n") + "\n");
  write("note-desc", [
    "---",
    "title: note-desc",
    "description: \"This note already has a long description that matches its hook exactly here\"",
    "---",
    "Body of note-desc.",
  ].join("\n") + "\n");
  write("note-nodesc", [
    "---",
    "title: note-nodesc",
    "---",
    "Body of note-nodesc, totally unrelated words only.",
  ].join("\n") + "\n");
  return dir;
}

function start({ env = {} } = {}) {
  const dir = indexTrimMemory();
  const dataDir = tmp("memglow-idxtrim-data-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1", ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: tmp("memglow-idxtrim-nofake-"), HOME: os.tmpdir() } });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, port: server.address().port })));
}

function req(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: h, setHost: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* text */ } ok({ status: res.statusCode, body: b, json: j }); });
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
const write = (port, extra = {}) => ({ "Content-Type": "application/json", "X-Memglow": "1", Origin: `http://127.0.0.1:${port}`, ...extra });
const post = (s, action, body) => req(s.port, "/api/assistant/" + action, { method: "POST", headers: write(s.port), body: body || {} });
const read = (dir, name) => fs.readFileSync(path.join(dir, name + ".md"), "utf8");

test("indexTrim: propose -> diff -> confirm -> apply -> index and the note shortened, backup made; Undo restores bytes exactly", async () => {
  const s = await start();
  try {
    const before = { index: read(s.dir, "index"), desc: read(s.dir, "note-desc"), nodesc: read(s.dir, "note-nodesc") };

    const p = await post(s, "propose", { kind: "indexTrim", maxChars: 40 });
    assert.strictEqual(p.status, 200, p.body);
    assert.strictEqual(p.json.job.kind, "indexTrim");
    assert.strictEqual(p.json.job.state, "proposed", JSON.stringify(p.json.job.errors));
    const rels = p.json.job.files.map((f) => f.rel).sort();
    assert.deepStrictEqual(rels, ["index.md", "note-nodesc.md"], "note-desc.md is untouched: its description already covers the dropped text");
    assert.match(p.json.job.notes, /2 index line\(s\) shortened/);
    assert.match(p.json.job.notes, /1 note\(s\) get the full original hook/);
    assert.ok(p.json.job.gain.saved > 0);
    // A proposal writes nothing.
    assert.strictEqual(read(s.dir, "index"), before.index);
    assert.strictEqual(read(s.dir, "note-nodesc"), before.nodesc);

    const c = await post(s, "confirm", { job: p.json.job.id });
    assert.strictEqual(c.status, 200, c.body);
    const a = await post(s, "apply", { job: p.json.job.id, token: c.json.token });
    assert.strictEqual(a.status, 200, a.body);
    assert.strictEqual(a.json.job.state, "applied");
    assert.ok(a.json.job.backup);

    const index = read(s.dir, "index");
    assert.ok(!index.includes("that matches its hook exactly here"), "dropped text gone from the index");
    assert.ok(index.includes("[[note-desc]] — This note already has a long description"));
    assert.ok(index.includes("[[note-nodesc]] — This other note has no description yet"));

    const nodesc = read(s.dir, "note-nodesc");
    assert.match(nodesc, /description: "This other note has no description yet so it should get one added for it"/);
    assert.ok(nodesc.includes("Body of note-nodesc, totally unrelated words only."), "body byte-identical");

    // note-desc.md was never part of the proposal, so it is untouched on disk.
    assert.strictEqual(read(s.dir, "note-desc"), before.desc);

    const u = await post(s, "undo", { job: p.json.job.id });
    assert.strictEqual(u.status, 200, u.body);
    assert.strictEqual(read(s.dir, "index"), before.index, "index restored byte for byte");
    assert.strictEqual(read(s.dir, "note-nodesc"), before.nodesc, "note-nodesc restored byte for byte");
  } finally { s.server.close(); }
});

test("indexTrim: a note changed on disk between propose and apply is refused, nothing written", async () => {
  const s = await start();
  try {
    const before = { index: read(s.dir, "index"), nodesc: read(s.dir, "note-nodesc") };
    const p = await post(s, "propose", { kind: "indexTrim", maxChars: 40 });
    assert.strictEqual(p.json.job.state, "proposed", JSON.stringify(p.json.job.errors));
    // The index note is edited by someone/something else right after the proposal.
    fs.writeFileSync(path.join(s.dir, "index.md"), before.index + "\n- [[note-desc]] — one more line added after the proposal was made\n");

    const c = await post(s, "confirm", { job: p.json.job.id });
    const a = await post(s, "apply", { job: p.json.job.id, token: c.json.token });
    assert.strictEqual(a.status, 409, a.body);
    assert.match(a.json.error, /changed since the proposal/);
    assert.strictEqual(read(s.dir, "note-nodesc"), before.nodesc, "nothing else was written either");
  } finally { s.server.close(); }
});

test("indexTrim: nothing to trim (hooks already short) -> an honest 'invalid' state, not an error", async () => {
  const s = await start();
  try {
    const p = await post(s, "propose", { kind: "indexTrim", maxChars: 1000 });
    assert.strictEqual(p.status, 200, p.body);
    assert.strictEqual(p.json.job.state, "invalid");
    assert.ok(p.json.job.errors.some((e) => /nothing to trim/i.test(e)));
  } finally { s.server.close(); }
});

test("indexTrim: GET /api/cost reports a plan summary next to the always-loaded figures", async () => {
  const s = await start({ env: { MEMGLOW_INDEX_TRIM_MAX_CHARS: "40" } });
  try {
    const c = (await req(s.port, "/api/cost")).json;
    assert.ok(c.alwaysLoaded, JSON.stringify(c));
    assert.ok(c.alwaysLoaded.indexTrim, JSON.stringify(c.alwaysLoaded));
    assert.strictEqual(c.alwaysLoaded.indexTrim.lines, 2);
    assert.ok(c.alwaysLoaded.indexTrim.tokensSaved > 0);
  } finally { s.server.close(); }
});
