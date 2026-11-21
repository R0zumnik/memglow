"use strict";
// core-perf — lean answers (--lean-answers / MEMGLOW_MEMORY_LEAN_ANSWERS / memoryServer.leanAnswers),
// OFF by default: with it every answer is sent once (no structuredContent copy, no outputSchema
// declared for those tools), search_notes drops its project and score lines, recent_activity and
// list_directory drop the internal ids, build_context answers Markdown unless JSON is asked.
// Without it nothing changes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer, parseArgs, resolveLeanAnswers, HELP } = require("../memory-server/memglow-memory-server");
const { leanToolList } = require("../memory-server/tools");
const { TOOLS } = require("../memory-server/schemas");
const searchMeta = require("../lib/search-meta");
const { estimateTokens } = require("../lib/cost");
const { makeKb } = require("./fixtures/memory-kb");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const text = (r) => r.content.map((c) => c.text).join("\n");
/** What Claude Code hands the model: structuredContent (JSON) when there is one, else the text. */
const modelSees = (r) => (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : text(r));

function pair(extra = {}) {
  const k = makeKb();
  const plain = createMemoryServer({ root: k.root, watch: false, pollMs: 0, ...extra });
  const lean = createMemoryServer({ root: k.root, watch: false, pollMs: 0, leanAnswers: true, ...extra });
  return { k, plain, lean, close: () => { plain.close(); lean.close(); k.cleanup(); } };
}

test("lean answers are off by default: flag, env and config file, in that order", () => {
  const home = tmp("memglow-lean-home-");
  const env = { MEMGLOW_HOME: home };
  assert.strictEqual(resolveLeanAnswers(parseArgs([], env), env), false);
  assert.strictEqual(resolveLeanAnswers(parseArgs(["--lean-answers"], env), env), true);
  assert.strictEqual(resolveLeanAnswers(parseArgs([], env), { ...env, MEMGLOW_MEMORY_LEAN_ANSWERS: "1" }), true);
  assert.strictEqual(resolveLeanAnswers(parseArgs(["--no-lean-answers"], env), { ...env, MEMGLOW_MEMORY_LEAN_ANSWERS: "1" }), false, "the flag wins over the env");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ memoryServer: { leanAnswers: true } }));
  assert.strictEqual(resolveLeanAnswers(parseArgs([], env), env), true, "config file");
  assert.strictEqual(resolveLeanAnswers(parseArgs([], env), { ...env, MEMGLOW_MEMORY_LEAN_ANSWERS: "0" }), false, "the env wins over the file");
  // A ./memglow.config.json in the current folder (the notes folder may be an untrusted clone) is never read.
  const cwd = tmp("memglow-lean-cwd-"), home2 = tmp("memglow-lean-home2-");
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), JSON.stringify({ memoryServer: { leanAnswers: true } }));
  const prev = process.cwd();
  process.chdir(cwd);
  try { assert.strictEqual(resolveLeanAnswers(parseArgs([], { MEMGLOW_HOME: home2 }), { MEMGLOW_HOME: home2 }), false); }
  finally { process.chdir(prev); }
  assert.match(HELP, /--lean-answers/);
  for (const d of [home, cwd, home2]) fs.rmSync(d, { recursive: true, force: true });
});

test("lean answers off: every answer keeps its shape (structuredContent copy, score line, ids, JSON context)", () => {
  const { plain, close } = pair();
  try {
    const s = plain.tools.call("search_notes", { query: "alice" });
    assert.deepStrictEqual(s.structuredContent, { result: text(s) });
    assert.match(text(s), /^\*project: main\*$/m);
    assert.match(text(s), /^- score: \d+\.\d{4}$/m);
    assert.match(text(plain.tools.call("recent_activity", { timeframe: "3650d" })), /\[id: [0-9a-f-]{36}\]/);
    assert.match(text(plain.tools.call("list_directory", { dir_name: "memory", depth: 3 })), /\| id: [0-9a-f-]{36}/);
    assert.doesNotThrow(() => JSON.parse(text(plain.tools.call("build_context", { url: "memory://main/memory/people/alice" }))));
    assert.strictEqual(plain.tools.tools, TOOLS, "tools/list untouched");
  } finally { close(); }
});

test("lean answers: each answer is sent once, and tools/list declares no outputSchema for those tools", () => {
  const { plain, lean, close } = pair();
  try {
    const calls = [
      ["read_note", { identifier: "alice" }], ["read_note", { identifier: "alice", output_format: "json" }], ["read_note", { identifier: "no such note at all" }],
      ["search_notes", { query: "alice" }], ["search_notes", { query: "alice", output_format: "json" }], ["search_notes", { query: "zzznothing" }], ["search_notes", {}],
      ["build_context", { url: "memory://main/memory/people/alice" }], ["recent_activity", { timeframe: "3650d" }], ["list_directory", { dir_name: "/", depth: 3 }],
      ["memory_core", {}], ["memory_index_level", { level: 0 }], ["list_memory_projects", {}], ["basic_memory_diagnostics", {}], ["view_note", { identifier: "alice" }],
    ];
    for (const [name, args] of calls) {
      const r = lean.tools.call(name, args);
      assert.ok(!("structuredContent" in r), `${name}: no structuredContent`);
      assert.ok(Array.isArray(r.content) && r.content.length && r.content.every((c) => c.type === "text" && typeof c.text === "string" && c.text), `${name}: text content`);
      assert.strictEqual(r.isError, false, name);
    }
    // The text itself is the plain server's, for the tools lean does not reword.
    for (const [name, args] of [["read_note", { identifier: "alice" }], ["memory_core", {}], ["memory_index_level", { level: 0 }], ["read_note", { identifier: "alice", output_format: "json" }]]) {
      assert.strictEqual(text(lean.tools.call(name, args)), text(plain.tools.call(name, args)), name);
    }
    // Tools that answer their own object keep it (and their schema).
    const rc = lean.tools.call("read_content", { path: "memory/people/alice.md" });
    assert.strictEqual(rc.structuredContent.type, "text");
    assert.ok(Array.isArray(lean.tools.call("search", { query: "alice" }).structuredContent.result));
    // A tool that declares an outputSchema must send structuredContent: none declared where none is sent.
    const listed = lean.tools.tools;
    assert.strictEqual(listed.length, TOOLS.length);
    for (const t of listed) {
      const full = TOOLS.find((x) => x.name === t.name);
      if (["read_content", "search", "fetch"].includes(t.name)) assert.deepStrictEqual(t, full);
      else {
        assert.ok(!("outputSchema" in t), `${t.name}: no outputSchema`);
        if (t.name !== "build_context") assert.deepStrictEqual(t, (({ outputSchema, ...rest }) => rest)(full), `${t.name}: nothing else changed`);
      }
    }
    const bc = listed.find((t) => t.name === "build_context");
    assert.strictEqual(bc.inputSchema.properties.output_format.default, "text");
    assert.deepStrictEqual([...bc.inputSchema.properties.output_format.enum].sort(), ["json", "text"]);
    assert.strictEqual(TOOLS.find((t) => t.name === "build_context").inputSchema.properties.output_format.default, "json", "the shared list is not modified");
    assert.deepStrictEqual(leanToolList(TOOLS).map((t) => t.name), TOOLS.map((t) => t.name));
  } finally { close(); }
});

test("lean answers: search_notes keeps every hit and permalink, without the project and score lines", () => {
  const { plain, lean, close } = pair();
  try {
    for (const q of [{ query: "alice" }, { query: "garden project", page_size: 3 }, { query: "rugby OR tea" }, { tags: "family" }]) {
      const a = text(plain.tools.call("search_notes", q)), r = lean.tools.call("search_notes", q), b = text(r);
      assert.strictEqual(b, a.split("\n").filter((l) => !/^- score: /.test(l) && !/^\*project: /.test(l)).join("\n"), JSON.stringify(q));
      assert.ok(!/score|\*project/.test(b));
      assert.deepStrictEqual(b.match(/^- permalink: .*$/gm), a.match(/^- permalink: .*$/gm));
      // The blocks handed to the levers out of band are exactly this text's blocks.
      const m = searchMeta.get(r);
      assert.ok(m && m.chunks.length >= 2, "search metadata still attached");
      assert.strictEqual(m.chunks.map((c) => c.text).join("\n\n"), b);
      assert.ok(estimateTokens(modelSees(r)) < estimateTokens(modelSees(plain.tools.call("search_notes", q))));
    }
  } finally { close(); }
});

test("lean answers: recent_activity and list_directory without internal ids, build_context in Markdown unless JSON is asked", () => {
  const { plain, lean, close } = pair();
  try {
    const strip = (s) => s.replace(/ \[id: [0-9a-f-]{36}\]/g, "").replace(/ \| id: [0-9a-f-]{36}/g, "");
    for (const [name, args] of [["recent_activity", { timeframe: "3650d" }], ["recent_activity", { timeframe: "3650d", type: "observation" }], ["list_directory", { dir_name: "memory", depth: 3 }], ["list_directory", { dir_name: "/", depth: 1 }]]) {
      const a = text(plain.tools.call(name, args)), b = text(lean.tools.call(name, args));
      assert.strictEqual(b, strip(a), name);
      assert.ok(!/id: [0-9a-f]{8}-/.test(b), name);
    }
    assert.notStrictEqual(text(lean.tools.call("recent_activity", { timeframe: "3650d" })), text(plain.tools.call("recent_activity", { timeframe: "3650d" })), "the fixture does show ids when not lean");
    // JSON answers of these tools keep their fields (external_id included): only the default text is leaner.
    assert.strictEqual(text(lean.tools.call("list_directory", { dir_name: "memory", depth: 3, output_format: "json" })), text(plain.tools.call("list_directory", { dir_name: "memory", depth: 3, output_format: "json" })));
    const url = { url: "memory://main/memory/people/alice" };
    const md = text(lean.tools.call("build_context", url));
    assert.match(md, /^# Context: Alice Martin/);
    assert.strictEqual(md, text(plain.tools.call("build_context", { ...url, output_format: "text" })), "the same Markdown the plain server gives on request");
    const strip2 = (j) => { const o = JSON.parse(j); o.metadata.generated_at = o.metadata.timeframe = null; return o; };
    assert.deepStrictEqual(strip2(text(lean.tools.call("build_context", { ...url, output_format: "json" }))), strip2(text(plain.tools.call("build_context", url))), "JSON on request: unchanged");
    assert.ok(estimateTokens(md) < estimateTokens(text(plain.tools.call("build_context", url))) * 0.7, "the default context costs clearly less");
  } finally { close(); }
});

test("lean answers: write tools answer once too, and what they write is identical", async () => {
  const { plain, lean, close } = pair({ readOnly: false, fsync: false });
  try {
    const w = await lean.tools.call("write_note", { title: "Lean One", directory: "memory/lean", content: "hello\n" });
    assert.ok(!("structuredContent" in w) && /^# Created note/.test(text(w)), text(w));
    const e = await lean.tools.call("edit_note", { identifier: "Lean One", operation: "append", content: "more\n" });
    assert.ok(!("structuredContent" in e) && /^# Edited note/.test(text(e)));
    const w2 = await plain.tools.call("write_note", { title: "Plain One", directory: "memory/lean", content: "hello\n" });
    assert.deepStrictEqual(w2.structuredContent, { result: text(w2) }, "not lean: as before");
    const a = fs.readFileSync(path.join(lean.store.root, "memory/lean/Lean One.md"), "utf8"), b = fs.readFileSync(path.join(plain.store.root, "memory/lean/Plain One.md"), "utf8");
    assert.strictEqual(a.replace(/Lean One|lean-one/g, "X").replace("\nmore\n", "\n"), b.replace(/Plain One|plain-one/g, "X"));
    const d = await lean.tools.call("delete_note", { identifier: "Lean One" });
    assert.ok(!("structuredContent" in d) && text(d) === "true");
    const err = await lean.tools.call("edit_note", { identifier: "Lean One", operation: "bogus", content: "x" });
    assert.strictEqual(err.isError, true);
  } finally { close(); }
});

test("lean answers through the levers and both protocol generations: still once, stateView and dedupe still apply", async () => {
  const k = makeKb();
  const home = tmp("memglow-lean-aio-");
  const journal = ["---", "title: journal-lean", "---", "", "# journal-lean", "", "## Rules", "", "- keep it short", ""];
  for (let d = 1; d <= 12; d++) journal.push(`## Update 2026-10-${String(d).padStart(2, "0")}`, "", ...Array.from({ length: 14 }, (_, i) => `- entry ${d}.${i}: the backup of the server went through and the router was restarted before noon`), "");
  k.write("memory/journal-lean.md", journal.join("\n"));
  k.write("memory/medium-lean.md", "---\ntitle: medium-lean\n---\n\n# medium-lean\n\n" + Array.from({ length: 40 }, (_, i) => `- fact ${i}: the garden shed holds the tools, the seeds and the watering cans`).join("\n") + "\n");
  const env = { MEMGLOW_HOME: home, MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_CONFIG: path.join(home, "none.json"), MEMGLOW_RULES: "0", MEMGLOW_PROXY_LOG: "0", MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_STATE_VIEW: "1" };
  const srv = createMemoryServer({ root: k.root, readOnly: false, watch: false, pollMs: 0, fsync: false, leanAnswers: true, allInOne: { env, name: "memglow-memory", onReport: () => {} } });
  try {
    const modern = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    let id = 0;
    const rpc = async (method, params, ctx = { sessionKey: "s1" }) => (await srv.rpc.handleAny({ jsonrpc: "2.0", id: ++id, method, params }, ctx)).result;
    const list = await rpc("tools/list", { _meta: modern });
    assert.ok(list.tools.length >= 8 && list.tools.filter((t) => !["read_content", "search", "fetch"].includes(t.name)).every((t) => !("outputSchema" in t)));
    const jr = await rpc("tools/call", { name: "read_note", arguments: { identifier: "journal-lean" }, _meta: modern });
    assert.strictEqual(jr.resultType, "complete");
    assert.ok(!("structuredContent" in jr));
    assert.match(text(jr), /journal-style note/, "stateView shortened it");
    assert.ok(!/Update 2026-10-03/.test(jr.content[0].text) && /Update 2026-10-12/.test(jr.content[0].text));
    const first = await rpc("tools/call", { name: "read_note", arguments: { identifier: "medium-lean" } });
    const again = await rpc("tools/call", { name: "read_note", arguments: { identifier: "medium-lean" } });
    assert.ok(!("structuredContent" in first) && !("structuredContent" in again) && !("resultType" in first));
    assert.ok(text(again).length < text(first).length && /unchanged since you read it/.test(text(again)), "dedupe answered the second read");
    const mq = await rpc("tools/call", { name: "search_notes", arguments: { query: "alice", memglow_queries: ["garden", "rugby"] } });
    assert.ok(!("structuredContent" in mq) && !mq.isError);
    assert.ok((text(mq).match(/^- permalink: /gm) || []).length >= 2 && !/- score:/.test(text(mq)), text(mq));
  } finally { srv.close(); k.cleanup(); fs.rmSync(home, { recursive: true, force: true }); }
});
