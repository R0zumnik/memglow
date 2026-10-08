"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createContext, createRpc, validate, TOOLS } = require("../mcp-server/memglow-mcp");
const { dayOf, daysBefore } = require("../lib/cost");

const SERVER = path.join(__dirname, "..", "mcp-server", "memglow-mcp.js");
const DEMO_MEMORY = path.join(__dirname, "..", "demo", "memory");

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function note(dir, name, frontmatter, body) {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n");
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

/** A small, deterministic fixture: alpha -> beta, gamma; delta shares alpha's sub-theme; big is oversized. */
function buildFixture() {
  const dir = tmpDir("memglow-mcp-notes-");
  note(dir, "alpha", { title: "Alpha", theme: "knowledge", subtheme: "ops", description: "Alpha note" }, "# Alpha\nSee [[beta]] and [[gamma]].");
  note(dir, "beta", { title: "Beta", theme: "knowledge", subtheme: "ops", description: "Beta note" }, "# Beta\nNothing more.");
  note(dir, "gamma", { title: "Gamma", theme: "knowledge", subtheme: "misc", description: "Gamma note" }, "# Gamma\nNothing more.");
  note(dir, "delta", { title: "Delta", theme: "knowledge", subtheme: "ops", description: "Delta note" }, "# Delta\nNot linked to alpha.");
  const filler = "x".repeat(12000);
  note(dir, "big", { title: "Big note", theme: "knowledge", subtheme: "misc", description: "Candidate for a split" },
    `## Part 1\n${filler}\n\n## Part 2\n${filler}\n\n## Part 3\n${filler}`);
  return dir;
}

function writeCounters(dataDir, notesDir) {
  const now = Date.now();
  const since = daysBefore(now, 34);
  const today = dayOf(now);
  // "big" is read on a different day than "alpha"/"beta": it must NOT show up as a co-usage of
  // alpha, even though it is read often enough to be the 7-day top note.
  const dayBig = daysBefore(now, 2);
  const dayAlphaBeta = daysBefore(now, 3);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "activity-counts.json"), JSON.stringify({
    version: 1,
    since,
    days: {
      [dayBig]: { notes: { big: { read: 4, search: 0, write: 0 } } },
      [dayAlphaBeta]: { notes: { alpha: { read: 2, search: 0, write: 0 }, beta: { read: 1, search: 0, write: 0 } } },
      [today]: { notes: {} },
    },
  }));
  return { since, today, dayBig, dayAlphaBeta };
}

/** ctx + a collector of every message the server sent, built without spawning a process. */
function harness(notesDir, dataDir) {
  const sent = [];
  const handle = createRpc((s) => sent.push(JSON.parse(s.trim())));
  const ctx = createContext({ MEMORY_DIR: notesDir, MEMGLOW_DATA_DIR: dataDir || tmpDir("memglow-mcp-data-") }, os.tmpdir());
  return { ctx, handle, sent, last: () => sent[sent.length - 1] };
}
function call(h, id, name, args) { h.sent.length = 0; h.handle(h.ctx, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } }); return h.last(); }

test("inputSchema validator: object/string/integer, required, additionalProperties", () => {
  const schema = { type: "object", properties: { a: { type: "string", minLength: 1, maxLength: 3 }, n: { type: "integer", minimum: 1, maximum: 5 } }, required: ["a"], additionalProperties: false };
  assert.strictEqual(validate(schema, { a: "x" }), null);
  assert.match(validate(schema, {}), /missing required property "a"/);
  assert.match(validate(schema, { a: "x", z: 1 }), /unexpected property "z"/);
  assert.match(validate(schema, { a: "toolong" }), /too long/);
  assert.match(validate(schema, { a: "x", n: 1.5 }), /expected an integer/);
  assert.match(validate(schema, { a: "x", n: 9 }), /must be <= 5/);
  assert.match(validate(schema, "nope"), /expected an object/);
});

test("tool registry: eight read-only tools, strict schemas, no write tool", () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), ["archive_lookup", "index_trim_plan", "maintenance_proposals", "memory_health", "note_cost", "organisation_suggestions", "related_notes", "split_plan"]);
  for (const t of TOOLS) {
    assert.strictEqual(t.inputSchema.type, "object");
    assert.strictEqual(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 20, t.name);
  }
});

test("initialize: echoes a well-formed protocolVersion, falls back otherwise; serverInfo present", () => {
  const h = harness(buildFixture());
  h.handle(h.ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.strictEqual(h.last().result.protocolVersion, "2025-06-18");
  assert.strictEqual(h.last().result.capabilities.tools && typeof h.last().result.capabilities.tools, "object");
  assert.strictEqual(h.last().result.serverInfo.name, "memglow-mcp");

  h.handle(h.ctx, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.strictEqual(h.last().result.protocolVersion, "2024-11-05");

  h.handle(h.ctx, { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "not-a-version" } });
  assert.strictEqual(h.last().result.protocolVersion, "2024-11-05");
});

test("notifications (no id) get no response; unknown method is a protocol error; ping answers", () => {
  const h = harness(buildFixture());
  h.handle(h.ctx, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.strictEqual(h.sent.length, 0);
  h.handle(h.ctx, { jsonrpc: "2.0", id: 9, method: "resources/list" });
  assert.strictEqual(h.last().error.code, -32601);
  h.handle(h.ctx, { jsonrpc: "2.0", id: 10, method: "ping" });
  assert.deepStrictEqual(h.last().result, {});
});

test("tools/call: unknown tool and invalid arguments are tool errors (isError), not protocol errors", () => {
  const h = harness(buildFixture());
  let r = call(h, 1, "no_such_tool", {});
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown tool/);

  r = call(h, 2, "split_plan", {});
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /missing required property "note"/);

  r = call(h, 3, "related_notes", {});
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /either "note" or "topic"/);

  r = call(h, 4, "split_plan", { note: "does-not-exist" });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /Note not found/);

  r = call(h, 5, "memory_health", { nope: 1 });
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /unexpected property/);
});

test("empty / missing notes folder: every tool answers cleanly, none crash", () => {
  const empty = tmpDir("memglow-mcp-empty-");
  const h = harness(empty);
  for (const [name, args] of [["memory_health", {}], ["split_plan", { note: "x" }], ["related_notes", { topic: "x" }], ["note_cost", { note: "x" }], ["index_trim_plan", {}]]) {
    const r = call(h, 1, name, args);
    assert.strictEqual(r.result.isError, false, name);
    assert.match(r.result.content[0].text, /No notes found/, name);
  }
  const missing = path.join(os.tmpdir(), "memglow-mcp-does-not-exist-" + Date.now());
  const h2 = harness(missing);
  const r = call(h2, 1, "memory_health", {});
  assert.strictEqual(r.result.isError, false);
  assert.match(r.result.content[0].text, /No notes found/);
});

test("memory_health: too-large note, 7-day cost and 30-day never-read, without and with counters", () => {
  const dir = buildFixture();
  const noCounters = harness(dir, tmpDir("memglow-mcp-nodata-"));
  const r1 = call(noCounters, 1, "memory_health", {});
  const d1 = JSON.parse(r1.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(d1.available, true);
  assert.strictEqual(d1.countersAvailable, false);
  assert.deepStrictEqual(d1.tooLarge.map((n) => n.id), ["big"]);
  assert.strictEqual(d1.mostExpensive7d, null);
  assert.strictEqual(d1.neverRead30d, null);

  const dataDir = tmpDir("memglow-mcp-data-");
  writeCounters(dataDir, dir);
  const withCounters = harness(dir, dataDir);
  const r2 = call(withCounters, 1, "memory_health", {});
  const d2 = JSON.parse(r2.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(d2.countersAvailable, true);
  assert.strictEqual(d2.mostExpensive7d[0].id, "big");
  assert.strictEqual(d2.mostExpensive7d[0].reads7, 4);
  assert.deepStrictEqual(new Set(d2.neverRead30d.notes.map((n) => n.id)), new Set(["gamma", "delta"]));
  assert.strictEqual(d2.neverRead30d.total, 2);
});

test("split_plan: honest 'no split needed' under the threshold, a real plan + English copy prompt above it", () => {
  const h = harness(buildFixture());
  const small = call(h, 1, "split_plan", { note: "alpha" });
  const ds = JSON.parse(small.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(ds.split, null);
  assert.match(small.result.content[0].text, /no split needed/);

  const big = call(h, 2, "split_plan", { note: "big" });
  const db = JSON.parse(big.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(db.split.length, 3);
  assert.deepStrictEqual(db.split.map((p) => p.titles), [["Part 1"], ["Part 2"], ["Part 3"]]);
  assert.match(db.copyPrompt, /Split the note "Big note"/);
  assert.match(db.copyPrompt, /memglow never modifies notes itself/);
  // no note body (the filler text) ever leaks into the answer
  assert.ok(!big.result.content[0].text.includes("x".repeat(100)));
});

test("split_plan: \"sections\" (raw per-heading breakdown) and \"split\" (packed parts) always total the same — split only groups, it never drops or re-estimates", () => {
  const h = harness(buildFixture());
  const big = call(h, 1, "split_plan", { note: "big" });
  const db = JSON.parse(big.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.deepStrictEqual(db.sections.map((s) => s.title), ["Part 1", "Part 2", "Part 3"]);
  const sectionsTotal = db.sections.reduce((s, x) => s + x.tokens, 0);
  const splitTotal = db.split.reduce((s, p) => s + p.tokens, 0);
  assert.strictEqual(splitTotal, sectionsTotal, "packing into parts never changes the total token count");
  // "no split needed" (small note): no body is read, so no "sections" key at all — never an empty one.
  const small = call(h, 2, "split_plan", { note: "alpha" });
  const ds = JSON.parse(small.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.ok(!("sections" in ds), "small note: split_plan does not read its body at all");
});

test("related_notes: links, sub-theme and co-usage combine; topic search over metadata only", () => {
  const dir = buildFixture();
  const dataDir = tmpDir("memglow-mcp-data-");
  writeCounters(dataDir, dir);
  const h = harness(dir, dataDir);

  const r = call(h, 1, "related_notes", { note: "alpha", limit: 10 });
  const d = JSON.parse(r.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  const byId = new Map(d.related.map((n) => [n.id, n]));
  assert.deepStrictEqual(d.related.map((n) => n.id), ["beta", "gamma", "delta"], "ranked by combined score");
  assert.deepStrictEqual(new Set(byId.get("beta").reasons), new Set(["outgoing link", "same sub-theme", "co-usage"]));
  assert.deepStrictEqual(byId.get("gamma").reasons, ["outgoing link"]);
  assert.deepStrictEqual(byId.get("delta").reasons, ["same sub-theme"]);
  for (const n of d.related) { assert.ok(typeof n.tokens === "number"); assert.ok(!("body" in n)); }

  const t = call(h, 2, "related_notes", { topic: "split", limit: 10 });
  const dt = JSON.parse(t.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.deepStrictEqual(dt.related.map((n) => n.id), ["big"]);
  assert.deepStrictEqual(dt.related[0].reasons, ["topic match"]);
});

test("note_cost: tokens, threshold, status, and 7-day reads when counters exist", () => {
  const dir = buildFixture();
  const dataDir = tmpDir("memglow-mcp-data-");
  writeCounters(dataDir, dir);
  const h = harness(dir, dataDir);

  const big = call(h, 1, "note_cost", { note: "big" });
  const db = JSON.parse(big.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(db.status, "too_large");
  assert.strictEqual(db.reads7, 4);

  const alpha = call(h, 2, "note_cost", { note: "alpha" });
  const da = JSON.parse(alpha.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(da.status, "ok");
  assert.strictEqual(da.reads7, 2);

  const noCounters = harness(dir, tmpDir("memglow-mcp-nodata-"));
  const r = call(noCounters, 3, "note_cost", { note: "alpha" });
  const d = JSON.parse(r.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(d.reads7, null);
});

test("note_cost: per-section breakdown (lib/cost.js's sectionsOf), bodyTokens is EXACTLY the sum of sections — by construction, not a second rounded estimate", () => {
  const h = harness(buildFixture());

  const big = call(h, 1, "note_cost", { note: "big" });
  const db = JSON.parse(big.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.deepStrictEqual(db.sections.map((s) => s.title), ["Part 1", "Part 2", "Part 3"]);
  assert.ok(db.sections.every((s) => s.tokens > 0));
  assert.strictEqual(db.bodyTokens, db.sections.reduce((s, x) => s + x.tokens, 0));
  assert.ok(db.bodyTokens > db.threshold, "the big note's body alone is already over threshold");
  // no filler text leaks: only titles and numbers
  assert.ok(!big.result.content[0].text.includes("x".repeat(100)));

  // a note with no "##" heading at all still gets a one-part breakdown (sectionsOf's own rule)
  const alpha = call(h, 2, "note_cost", { note: "alpha" });
  const da = JSON.parse(alpha.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(da.sections.length, 1);
  assert.strictEqual(da.sections[0].title, "");
  assert.strictEqual(da.bodyTokens, da.sections[0].tokens);
  assert.ok(da.bodyTokens < da.tokens, "bodyTokens excludes the frontmatter that `tokens` (whole file) includes");
});

test("note resolution accepts a bare id, a .md path and an underscore/case variant", () => {
  const h = harness(buildFixture());
  for (const given of ["alpha", "alpha.md", "people/alpha.md", "ALPHA".toLowerCase()]) {
    const r = call(h, 1, "note_cost", { note: given });
    assert.strictEqual(r.result.isError, false, given);
  }
});

test("never writes to the notes folder", () => {
  const dir = buildFixture();
  const before = fs.readdirSync(dir).sort().map((f) => {
    const full = path.join(dir, f);
    return [f, fs.statSync(full).mtimeMs, fs.readFileSync(full, "utf8")];
  });
  const h = harness(dir, tmpDir("memglow-mcp-data-"));
  call(h, 1, "memory_health", {});
  call(h, 2, "split_plan", { note: "big" });
  call(h, 3, "related_notes", { note: "alpha" });
  call(h, 4, "note_cost", { note: "alpha" });
  call(h, 5, "index_trim_plan", {});
  const after = fs.readdirSync(dir).sort().map((f) => {
    const full = path.join(dir, f);
    return [f, fs.statSync(full).mtimeMs, fs.readFileSync(full, "utf8")];
  });
  assert.deepStrictEqual(after, before);
});

test("index_trim_plan: shortens an over-length hook, flags a note with no description, writes nothing", () => {
  const dir = tmpDir("memglow-mcp-idx-");
  fs.writeFileSync(path.join(dir, "index.md"), [
    "# Memory index",
    "- [[project-long]] — Project long: build the pipeline, ship the dashboard, and write the docs",
    "- [[project-nodesc]] — Needs a home lab server with backups and a media center setup done right",
  ].join("\n") + "\n");
  note(dir, "project-long", { title: "project-long", description: "Project long: build the pipeline, ship the dashboard, and write the docs" }, "Nothing more to add here.");
  note(dir, "project-nodesc", { title: "project-nodesc" }, "Just a stub note, nothing else written here yet.");
  const before = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  const h = harness(dir);
  const r = call(h, 1, "index_trim_plan", { maxChars: 40 });
  assert.strictEqual(r.result.isError, false, r.result.content[0].text);
  const d = JSON.parse(r.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.maxChars, 40);
  assert.strictEqual(d.lines.length, 2);
  assert.deepStrictEqual(d.skipped, []);
  assert.strictEqual(d.movedDescriptions, 1, "only project-nodesc has no description to keep the detail in");
  assert.ok(d.tokensSaved > 0);
  for (const l of d.lines) assert.ok(l.after.length < l.before.length, l.id);
  // Read-only: the index note itself is untouched (the actual proposal/apply is a separate, non-MCP call).
  assert.strictEqual(fs.readFileSync(path.join(dir, "index.md"), "utf8"), before);
});

test("index_trim_plan: no index note → an honest answer, not an error", () => {
  const dir = tmpDir("memglow-mcp-noidx-");
  note(dir, "alpha", { title: "Alpha" }, "Just a note.");
  const h = harness(dir);
  const r = call(h, 1, "index_trim_plan", {});
  assert.strictEqual(r.result.isError, false);
  const d = JSON.parse(r.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(d.available, false);
});

// ---- real process, real stdio: initialize, tools/list, tools/call on the shipped demo memory ----

function spawnServer(env) {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, ...env } });
}
function readLines(child, n, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("timed out waiting for " + n + " line(s), got: " + out)), timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      const lines = out.split("\n").filter(Boolean);
      if (lines.length >= n) { clearTimeout(t); resolve(lines.slice(0, n).map((l) => JSON.parse(l))); }
    });
  });
}

test("real process: initialize + tools/list + tools/call over actual stdio, demo memory", async () => {
  const dataDir = tmpDir("memglow-mcp-demo-data-");
  const child = spawnServer({ MEMORY_DIR: DEMO_MEMORY, MEMGLOW_DATA_DIR: dataDir });
  try {
    const wire = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_health", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "split_plan", arguments: { note: "reference-incident-log" } } },
    ].map((m) => JSON.stringify(m) + "\n").join("");
    child.stdin.write(wire);
    const [initRes, listRes, healthRes, splitRes] = await readLines(child, 4);
    assert.strictEqual(initRes.result.serverInfo.name, "memglow-mcp");
    assert.strictEqual(listRes.result.tools.length, 8);
    assert.match(healthRes.result.content[0].text, /Incident log/);
    const splitData = JSON.parse(splitRes.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
    assert.strictEqual(splitData.split.length, 4, "the demo's Incident log splits into 4 parts");
  } finally { child.kill(); }
});

test("real process: starts on its own with an empty / absent notes folder (no crash, no upstream server needed)", async () => {
  const missing = path.join(os.tmpdir(), "memglow-mcp-missing-" + Date.now());
  const child = spawnServer({ MEMORY_DIR: missing, MEMGLOW_DATA_DIR: tmpDir("memglow-mcp-data-") });
  try {
    const wire = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((m) => JSON.stringify(m) + "\n").join("");
    child.stdin.write(wire);
    const [initRes, listRes] = await readLines(child, 2);
    assert.ok(initRes.result.protocolVersion);
    assert.strictEqual(listRes.result.tools.length, 8);
  } finally { child.kill(); }
});
