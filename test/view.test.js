"use strict";
// Saved view (lib/view.js, GET/PUT /api/view), the journal line format, the saved-layout helpers
// of the page, and write de-duplication for Memory cost.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const view = require("../lib/view");
const page = require("../public/app.js");
const { createWriteDedup, createCounters } = require("../lib/counters");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

const rules = view.createRules({ themeIds: ["people", "projects"], noteExists: (id) => ["a", "b", "constructor"].includes(id) });

// ---- validation ----

test("view: settings are a closed list with types and bounds", () => {
  const s = view.validateSettings(JSON.parse(JSON.stringify({
    spread: 12, gravity: 11, spacing: -1, bubbleSize: "2", signalSpeed: 0.5, glow: 1.234,
    sizeBy: "tokens", background: "red", linksAtRest: "subtle", names: "all",
    autoRotate: false, ambientFlow: "true", keepDragged: 1,
    hiddenThemes: ["people", "index", "evil", "__proto__", "other"],
    unknown: 1,
  }).replace("{", '{"__proto__":{"polluted":true},')), rules);
  assert.deepStrictEqual(s, {
    spread: 12, signalSpeed: 0.5, glow: 1.23, sizeBy: "tokens", linksAtRest: "subtle", names: "all",
    autoRotate: false, hiddenThemes: ["people", "index", "other"],
  });
  assert.strictEqual({}.polluted, undefined);
  assert.deepStrictEqual(view.validateSettings("x", rules), {});
  assert.deepStrictEqual(view.validateSettings({ hiddenThemes: new Array(50).fill("people") }, rules), {}, "oversized list ignored");
});

test("view: hostile layout is rebuilt, never copied", () => {
  const body = JSON.parse(JSON.stringify({
    positions: {
      a: [1, 2, 3.14159], b: [1, 2], ghost: [0, 0, 0], "~people/general": [5, 5, 5], "~evil/x": [1, 1, 1],
      "~people/Bad Id": [1, 1, 1], "../etc": [1, 1, 1], constructor: [9, 9, 9], "~people/web": [1e9, 0, 0],
    },
    pinned: ["a", "a", "ghost", "~people/general", 42],
    camera: { position: [0, 0, 100], target: [0, 0, 0], extra: "x" },
    reset: "yes",
  }).replace('"positions":{', '"positions":{"__proto__":[1,1,1],"prototype":[1,1,1],'));
  assert.ok(Object.prototype.hasOwnProperty.call(body.positions, "__proto__"), "own key, as JSON.parse makes it");
  const u = view.validateUpdate(body, rules);
  assert.deepStrictEqual(Object.keys(u.positions).sort(), ["a", "constructor", "~people/general"]);
  assert.deepStrictEqual(u.positions.a, [1, 2, 3.14]);
  assert.strictEqual(Object.getPrototypeOf(u.positions), null);
  assert.deepStrictEqual(u.pinned, ["a", "~people/general"]);
  assert.deepStrictEqual(u.camera, { position: [0, 0, 100], target: [0, 0, 0] });
  assert.strictEqual(u.reset, false, "only a real true resets");
  assert.strictEqual(view.validateUpdate([1], rules), null);
  assert.strictEqual(view.validateUpdate(null, rules), null);
  assert.strictEqual(view.validateCamera({ position: [1, 1, 1], target: [1, 1, 1] }), null, "degenerate camera");
  assert.strictEqual(view.validateCamera({ position: [0, 0, "1"], target: [0, 0, 0] }), null);
  const many = {};
  for (let i = 0; i < 2500; i++) many["~people/s" + i] = [i, 0, 0];
  assert.strictEqual(Object.keys(view.validatePositions(many, rules)).length, view.MAX_POSITIONS);
});

test("view: merge — a part present replaces, reset clears the layout only", () => {
  let v = view.emptyView();
  v = view.merge(v, view.validateUpdate({ settings: { spread: 9 }, positions: { a: [1, 1, 1] }, pinned: ["a"], camera: { position: [0, 0, 9], target: [0, 0, 0] } }, rules), 1);
  v = view.merge(v, view.validateUpdate({ settings: { glow: 1 } }, rules), 2);
  assert.deepStrictEqual(v.settings, { glow: 1 }, "settings replaced as a whole");
  assert.deepStrictEqual(v.positions.a, [1, 1, 1], "layout kept when absent");
  v = view.merge(v, view.validateUpdate({ reset: true }, rules), 3);
  assert.deepStrictEqual([Object.keys(v.positions).length, v.pinned.length, v.camera, v.settings.glow, v.updated], [0, 0, null, 1, 3]);
  // A stored view is validated again: a removed note drops out.
  const r = view.reread({ positions: { a: [1, 1, 1], gone: [2, 2, 2] }, pinned: ["gone"], settings: { names: "all" } }, rules);
  assert.deepStrictEqual(Object.keys(r.positions), ["a"]);
  assert.deepStrictEqual(r.pinned, []);
});

test("view: the page's settings map matches the server's list exactly", () => {
  const apiKeys = Object.values(page.VIEW_SETTINGS).map((d) => d[0]).sort();
  assert.deepStrictEqual(apiKeys, Object.keys(view.SETTINGS).sort());
  for (const d of Object.values(page.VIEW_SETTINGS)) {
    const s = view.SETTINGS[d[0]];
    assert.strictEqual(s.type, d[1], d[0]);
    if (s.type === "number") assert.deepStrictEqual([s.min, s.max], [d[2], d[3]], d[0]);
    if (s.type === "choice") assert.deepStrictEqual(Object.values(d[2]).sort(), s.values.slice().sort(), d[0]);
  }
  // Round trip: local strings → typed → local strings.
  const local = { ecart: "12.5", taille: "jetons", fond: "nuit", rotation: "0", masquesThemes: '{"people":true,"x":false}', noms: "bogus", gravite: "99" };
  const typed = page.settingsFromLocal((k) => (k in local ? local[k] : null));
  assert.deepStrictEqual(typed, { spread: 12.5, sizeBy: "tokens", background: "night", autoRotate: false, hiddenThemes: ["people"] });
  assert.deepStrictEqual(view.validateSettings(typed, rules), typed, "what the page sends passes validation");
  assert.deepStrictEqual(page.settingsToLocal(typed), { ecart: "12.5", taille: "jetons", fond: "nuit", rotation: "0", masquesThemes: '{"people":true}' });
  // "Light" round-trips the same way as the three existing presets.
  const typedClair = page.settingsFromLocal((k) => (k === "fond" ? "clair" : null));
  assert.deepStrictEqual(typedClair, { background: "light" });
  assert.deepStrictEqual(view.validateSettings(typedClair, rules), typedClair);
  assert.deepStrictEqual(page.settingsToLocal(typedClair), { fond: "clair" });
});

test("view: saved layout seeds the nodes, new notes go near their bubble", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "new1" }, { id: "new2" }];
  const r = page.seedPositions(nodes, { positions: { a: [10, 20, 30], b: [0, 0, 0] }, pinned: ["a"] }, () => ({ x: 100, y: 0, z: 0 }), 12);
  assert.deepStrictEqual(r, { restored: 2, placed: 2 });
  assert.deepStrictEqual([nodes[0].x, nodes[0].fx, nodes[1].fx], [10, 10, undefined]);
  const d = (n) => Math.hypot(n.x - 100, n.y, n.z);
  assert.ok(Math.abs(d(nodes[2]) - 12) < 1e-9 && Math.abs(d(nodes[3]) - 12) < 1e-9, "at the given distance of their bubble");
  assert.ok(nodes[2].x !== nodes[3].x || nodes[2].y !== nodes[3].y, "never on the same point");
  const again = [{ id: "a" }, { id: "new1" }];
  page.seedPositions(again, { positions: { a: [1, 1, 1] } }, () => ({ x: 100, y: 0, z: 0 }), 12);
  assert.strictEqual(again[1].x, nodes[2].x, "deterministic");
  const none = [{ id: "a" }];
  assert.deepStrictEqual(page.seedPositions(none, { positions: {} }, () => ({ x: 1, y: 1, z: 1 })), { restored: 0, placed: 0 });
  assert.strictEqual(none[0].x, undefined, "nothing saved: the simulation starts from scratch");
  const l = page.layoutOf([{ id: "a", x: 1.234, y: 2, z: 3, fx: 1.234 }, { id: "b", x: NaN, y: 0, z: 0 }, { id: "c", x: 1, y: 1, z: 1 }], 2);
  assert.deepStrictEqual(l, { positions: { a: [1.23, 2, 3], c: [1, 1, 1] }, pinned: ["a"] });
});

// ---- journal ----

test("journal: ACTION · GROUP · NOTE · SOURCE, group spelled out", () => {
  const names = { projects: "Work", index: "Index" };
  const f = page.formatJournalLine({ type: "write", theme: "projects", label: "Project notes", source: "claude-code" }, names);
  assert.strictEqual(f.text, "Write · Work · Project notes · Claude Code");
  assert.deepStrictEqual([f.action, f.group, f.theme], ["Write", "Work", "projects"]);
  assert.strictEqual(page.formatJournalLine({ type: "read", theme: "projects", label: "X", more: 2, source: "codex" }, names).text, "Read · Work · X +2 · Codex");
  assert.strictEqual(page.formatJournalLine({ type: "changed", theme: "nope", label: "Y", source: "file" }, names).text, "Note changed · Other · Y · File");
  assert.strictEqual(page.formatJournalLine({ type: "removed", theme: "index", label: "Memory", source: "file" }, names).text, "Note removed · Index · Memory · File");
  assert.strictEqual(page.formatJournalLine({ type: "search", theme: "projects", label: "Z", source: "my-tool" }, names).text, "Search · Work · Z · my-tool", "unknown source shown as sent");
  assert.strictEqual(page.formatJournalLine({ type: "added", label: "N" }, names).text, "New note · Other · N");
});

test("journal: machine and channel (v0.4), backward compatible when absent", () => {
  const names = { projects: "Work" };
  // Full line: ACTION · GROUP · NOTE · MACHINE · CHANNEL · TOOL.
  const f = page.formatJournalLine({
    type: "write", theme: "projects", label: "Smart home", source: "claude-code", machine: "laptop", channel: "hook",
  }, names);
  assert.strictEqual(f.text, "Write · Work · Smart home · laptop · hook · Claude Code");
  assert.strictEqual(
    page.formatJournalLine({ type: "read", theme: "projects", label: "X", source: "cursor", channel: "mcp-proxy" }, names).text,
    "Read · Work · X · MCP proxy · Cursor", "channel label, no machine configured"
  );
  assert.strictEqual(
    page.formatJournalLine({ type: "changed", theme: "projects", label: "Y", channel: "file" }, names).text,
    "Note changed · Work · Y · file", "a note seen on disk: channel only, no tool"
  );
  assert.strictEqual(
    page.formatJournalLine({ type: "write", theme: "projects", label: "Z", source: "my-agent", channel: "api" }, names).text,
    "Write · Work · Z · API · my-agent"
  );
  assert.strictEqual(
    page.formatJournalLine({ type: "write", theme: "projects", label: "Z", channel: "unknown-channel" }, names).text,
    "Write · Work · Z · unknown-channel", "an unrecognised channel is shown as sent, not dropped"
  );
  // No machine or channel at all (every sender before v0.4, or one that chooses not to send them):
  // identical to the pre-v0.4 line.
  assert.strictEqual(
    page.formatJournalLine({ type: "write", theme: "projects", label: "Project notes", source: "claude-code" }, names).text,
    "Write · Work · Project notes · Claude Code"
  );
});

// ---- write de-duplication ----

test("dedup: a write seen twice is counted once, in both orders; a file-only write counts", () => {
  const d = createWriteDedup(15000);
  // File change first, then the hook reports it.
  assert.strictEqual(d.changed("a", 1000), true);
  assert.deepStrictEqual(d.reported(["a", "b"], 3000), ["b"]);
  // Hook first (b above), then the file change.
  assert.strictEqual(d.changed("b", 5000), false);
  // Outside the window: two different writes.
  assert.strictEqual(d.changed("c", 10000), true);
  assert.deepStrictEqual(d.reported(["c"], 26000), ["c"]);
  // A second body change of the same note, no hook: counted again.
  assert.strictEqual(d.changed("e", 30000), true);
  assert.strictEqual(d.changed("e", 31000), true);
  assert.deepStrictEqual(d._state().reported, ["c"], "consumed entries are gone");
});

// ---- HTTP ----

function start(env = {}, dirs = {}) {
  const dir = dirs.dir || fs.mkdtempSync(path.join(os.tmpdir(), "memglow-view-"));
  if (!dirs.dir) {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ntheme: people\n---\nA [[b]]");
    fs.writeFileSync(path.join(dir, "b.md"), "---\ntheme: projects\n---\nB");
  }
  const dataDir = dirs.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "memglow-vdata-"));
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const counters = createCounters({ dir: dirs.countersDir === null ? null : dataDir });
  const server = createServer(config, memory, { counters });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    ok({ server, dir, dataDir, base, counters, host: `127.0.0.1:${server.address().port}` });
  }));
}
const put = (s, body, headers = {}) => fetch(s.base + "/api/view", {
  method: "PUT",
  headers: { "Content-Type": "application/json", "X-Memglow": "1", Origin: s.base, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const listFiles = (d) => fs.readdirSync(d).sort();

test("view route: GET empty, PUT validated, saved in the data folder only, kept after a restart", async () => {
  const s = await start();
  const before = listFiles(s.dir);
  try {
    const empty = await (await fetch(s.base + "/api/view")).json();
    assert.deepStrictEqual(empty, { settings: {}, positions: {}, pinned: [], camera: null, updated: 0 });
    const r = await put(s, { settings: { spread: 10, names: "all", evil: 1 }, positions: { a: [1, 2, 3], zz: [0, 0, 0], "~people/general": [4, 5, 6] }, pinned: ["a"], camera: { position: [0, 0, 50], target: [0, 0, 0] } });
    assert.strictEqual(r.status, 204);
    const v = await (await fetch(s.base + "/api/view")).json();
    assert.deepStrictEqual(v.settings, { spread: 10, names: "all" });
    assert.deepStrictEqual(v.positions, { a: [1, 2, 3], "~people/general": [4, 5, 6] });
    assert.deepStrictEqual(v.pinned, ["a"]);
    assert.ok(fs.existsSync(path.join(s.dataDir, "view.json")), "written in the data folder");
    assert.strictEqual((fs.statSync(path.join(s.dataDir, "view.json")).mode & 0o777), 0o600);
    assert.deepStrictEqual(listFiles(s.dir), before, "the notes folder is untouched");
    assert.strictEqual(fs.readdirSync(s.dataDir).filter((f) => f.endsWith(".tmp")).length, 0, "no temporary file left");
  } finally { s.server.close(); }
  // Restart on the same folders: same view.
  const s2 = await start({}, { dir: s.dir, dataDir: s.dataDir });
  try {
    const v = await (await fetch(s2.base + "/api/view")).json();
    assert.deepStrictEqual(v.positions.a, [1, 2, 3]);
    assert.deepStrictEqual(v.camera, { position: [0, 0, 50], target: [0, 0, 0] });
    // A note removed since then drops out of the saved layout.
    fs.unlinkSync(path.join(s.dir, "a.md"));
    await new Promise((ok) => setTimeout(ok, 600));
    const v2 = await (await fetch(s2.base + "/api/view")).json();
    assert.deepStrictEqual(Object.keys(v2.positions), ["~people/general"]);
    assert.deepStrictEqual(v2.pinned, []);
  } finally { s2.server.close(); }
});

test("view route: CSRF guard, size limit, bad bodies, rate limit", async () => {
  const s = await start();
  try {
    const ok = { settings: { spread: 5 } };
    assert.strictEqual((await put(s, ok, { "X-Memglow": "" })).status, 403, "custom header required");
    assert.strictEqual((await put(s, ok, { Origin: "http://evil.example" })).status, 403, "foreign origin");
    assert.strictEqual((await put(s, ok, { Origin: "null" })).status, 403);
    assert.strictEqual((await fetch(s.base + "/api/view", { method: "PUT", headers: { "X-Memglow": "1" }, body: "{}" })).status, 403, "no Origin");
    assert.strictEqual((await put(s, ok, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.strictEqual((await put(s, ok, { "Sec-Fetch-Site": "same-origin" })).status, 204);
    // Behind a reverse proxy: the public host arrives in X-Forwarded-Host.
    assert.strictEqual((await put(s, ok, { Origin: "https://memory.example", "X-Forwarded-Host": "memory.example" })).status, 204);
    assert.strictEqual((await put(s, "x".repeat(view.BODY_MAX + 10))).status, 413);
    assert.strictEqual((await put(s, "{not json")).status, 400);
    assert.strictEqual((await put(s, "[1,2]")).status, 400);
    assert.strictEqual((await put(s, "null")).status, 400);
    assert.strictEqual((await fetch(s.base + "/api/view", { method: "POST", body: "{}" })).status, 404, "other methods: unknown route");
    const v = await (await fetch(s.base + "/api/view")).json();
    assert.deepStrictEqual(v.settings, { spread: 5 }, "refused writes changed nothing");
    let limited = 0;
    for (let i = 0; i < 40; i++) if ((await put(s, ok)).status === 429) limited++;
    assert.ok(limited > 0, "rate limited");
  } finally { s.server.close(); }
});

test("view route: same password as the page", async () => {
  const s = await start({ MEMGLOW_PASSWORD: "correct horse battery" });
  const auth = "Basic " + Buffer.from("memglow:correct horse battery").toString("base64");
  try {
    assert.strictEqual((await fetch(s.base + "/api/view")).status, 401);
    assert.strictEqual((await put(s, { settings: {} })).status, 401);
    assert.strictEqual((await fetch(s.base + "/api/view", { headers: { Authorization: auth } })).status, 200);
    assert.strictEqual((await put(s, { settings: { glow: 1 } }, { Authorization: auth })).status, 204);
  } finally { s.server.close(); }
});

test("view route: a data folder inside the notes folder is never written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-inside-"));
  fs.writeFileSync(path.join(dir, "a.md"), "A");
  const inside = path.join(dir, "data");
  const warn = console.warn; console.warn = () => {};
  const s = await start({}, { dir, dataDir: inside, countersDir: null });
  try {
    assert.strictEqual((await put(s, { settings: { glow: 1 } })).status, 204);
    assert.deepStrictEqual((await (await fetch(s.base + "/api/view")).json()).settings, { glow: 1 }, "kept in memory");
    assert.ok(!fs.existsSync(inside), "nothing written in the notes folder");
  } finally { s.server.close(); console.warn = warn; }
});

// ---- counters: file writes, de-duplicated with reported writes, Memory cost refreshed ----

const TOKEN = "k".repeat(40);
const writes = (c) => Object.values(c.days()).reduce((s, d) => s + Object.values(d.notes).reduce((t, n) => t + n.write, 0), 0);
const report = (s, body) => fetch(s.base + "/api/activity", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(body) });
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

test("counters: a file change counts as a write, never twice with the reported write (both orders)", async () => {
  const s = await start({ MEMGLOW_TOKEN: TOKEN });
  try {
    await fetch(s.base + "/api/cost"); // first scan: the starting point, not a write
    assert.strictEqual(writes(s.counters), 0);
    // 1. Written on disk only (an assistant without a hook, an edit by hand).
    fs.writeFileSync(path.join(s.dir, "b.md"), "---\ntheme: projects\n---\nB, edited by hand");
    await wait(600);
    let c = await (await fetch(s.base + "/api/cost")).json();
    assert.strictEqual(writes(s.counters), 1);
    assert.ok(c.written.today > 0, "Memory cost sees the write (cache invalidated)");
    // 2. File change first, then the hook reports it: still one.
    fs.writeFileSync(path.join(s.dir, "a.md"), "---\ntheme: people\n---\nA [[b]] and more");
    await wait(600);
    await fetch(s.base + "/api/cost");
    assert.strictEqual(writes(s.counters), 2);
    assert.strictEqual((await report(s, { type: "write", ids: ["a"], source: "claude" })).status, 204);
    assert.strictEqual(writes(s.counters), 2, "not counted twice");
    // 3. Hook first (the file does not change yet), then the file change: still one. ("a" was
    // consumed by step 2; "b" still has its step-1 file write within the 15 s window.)
    await wait(1100);
    assert.strictEqual((await report(s, { type: "write", ids: ["a"], source: "codex" })).status, 204);
    assert.strictEqual(writes(s.counters), 3);
    fs.writeFileSync(path.join(s.dir, "a.md"), "---\ntheme: people\n---\nA [[b]], written by the assistant");
    await wait(600);
    await fetch(s.base + "/api/cost");
    assert.strictEqual(writes(s.counters), 3, "the change was the reported write");
    // 4. Demo activity is never counted, and a frontmatter-only change is not a write.
    await report(s, { type: "write", ids: ["a"], demo: true });
    fs.writeFileSync(path.join(s.dir, "b.md"), "---\ntheme: projects\ndescription: new\n---\nB, edited by hand");
    await wait(600);
    c = await (await fetch(s.base + "/api/cost")).json();
    assert.strictEqual(writes(s.counters), 3);
    // 5. A read changes the Memory cost answer at once (cache keyed on the counters).
    const before = c.read.today;
    await report(s, { type: "read", ids: ["a"] });
    c = await (await fetch(s.base + "/api/cost")).json();
    assert.ok(c.read.today > before);
  } finally { s.server.close(); }
});
