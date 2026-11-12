"use strict";
// 0.6.0: tools.profile, stateView default, removed-lever tolerance, D1 duplicates (no AI), the
// "À regarder" line, session-start accounting, store polling under fs.watch. No timing assertions.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../lib/proxy-levers");
const star = require("../lib/star-audit");
const dupCand = require("../lib/duplicate-candidates");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { TOOLS } = require("../memory-server/schemas");
const { estimateTokens } = require("../lib/cost");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function engineFor(env = {}) {
  const home = tmp("memglow-060-home-");
  const cfg = L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_PROXY_SAVINGS_FILE: "0", MEMGLOW_PROXY_LOG: "0", ...env });
  const savings = L.createSavings({ ...cfg, savingsFile: false, log: false });
  const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings, serverName: "memglow-memory" });
  return { cfg, engine, savings, home };
}
function list(engine, clientInfo, sid = "s") {
  engine.clientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo } }, sid);
  engine.clientMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const out = engine.serverMessage({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } }, sid);
  return out.msg.result.tools;
}

test("tools.profile: minimal is the default and hides the compat tools from tools/list; full lists everything; env and config both work", () => {
  const { engine, cfg } = engineFor();
  assert.strictEqual(cfg.toolsProfile, "minimal");
  const names = list(engine, { name: "claude-code" }).map((t) => t.name);
  for (const h of ["schema_infer", "schema_validate", "schema_diff", "create_memory_project", "delete_project", "list_memory_projects", "list_workspaces", "view_note", "read_content", "basic_memory_diagnostics", "search", "fetch"]) assert.ok(!names.includes(h), h);
  for (const k of ["read_note", "write_note", "edit_note", "move_note", "delete_note", "search_notes", "build_context", "recent_activity", "list_directory", "memory_core", "memory_index_level"]) assert.ok(names.includes(k), k);
  const full = engineFor({ MEMGLOW_TOOLS_PROFILE: "full" });
  assert.strictEqual(full.cfg.toolsProfile, "full");
  assert.strictEqual(list(full.engine, { name: "claude-code" }).length, TOOLS.length + 0);
  // an unknown value falls back to the default instead of crashing
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: tmp("h-"), MEMGLOW_TOOLS_PROFILE: "bogus" }).toolsProfile, "minimal");
  // config file: "tools": { "profile": "full" }; env wins over the file
  const home = tmp("memglow-060-cfg-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ tools: { profile: "full" } }));
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home }).toolsProfile, "full");
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_TOOLS_PROFILE: "minimal" }).toolsProfile, "minimal");
});

test("tools.profile minimal: the tools/list answer is clearly smaller; OpenAI's MCP client keeps search/fetch", () => {
  const minimal = engineFor().engine, full = engineFor({ MEMGLOW_TOOLS_PROFILE: "full" }).engine;
  const tMin = estimateTokens(JSON.stringify(list(minimal, { name: "claude-code" })));
  const tFull = estimateTokens(JSON.stringify(list(full, { name: "claude-code" })));
  assert.ok(tMin < tFull * 0.7, `minimal ${tMin} vs full ${tFull}`);
  const names = list(engineFor().engine, { name: "openai-mcp" }).map((t) => t.name);
  assert.ok(names.includes("search") && names.includes("fetch"));
  assert.ok(!names.includes("schema_infer"));
});

test("stateView is on by default; its env opt-out is kept", () => {
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: tmp("h-") }).stateView, true);
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: tmp("h-"), MEMGLOW_PROXY_STATE_VIEW: "0" }).stateView, false);
  const home = tmp("h-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ proxy: { stateView: false } }));
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home }).stateView, false);
});

test("removed levers: their env and config keys are accepted and ignored, with one log line each", () => {
  const home = tmp("h-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ proxy: { deltaRead: true, sessionBudgetTokens: 5000, alreadyLoadedExemptClients: ["x"] } }));
  const cfg = L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_PROXY_INDEX_HINT: "1", MEMGLOW_PROXY_SUGGESTIONS: "0" });
  assert.deepStrictEqual(cfg.ignoredLevers.sort(), ["alreadyLoaded", "deltaRead", "indexHint", "searchDetails", "sessionBudget", "suggestions"]);
  assert.strictEqual(cfg.dedupe, true, "kept levers still work next to the removed ones");
  const lines = [];
  L.logIgnoredLevers(cfg, (l) => lines.push(l));
  assert.strictEqual(lines.length, 6);
  assert.ok(lines.every((l) => /^memglow: ignored: lever \w+ removed in 0\.6\.0$/.test(l)), lines.join("|"));
  assert.deepStrictEqual(L.proxyConfig({ MEMGLOW_HOME: tmp("h-") }).ignoredLevers, []);
});

const note = (id, label, description, extra = {}) => ({ id, label, description, text: `---\ntitle: ${label}\n---\n\nbody\n`, folder: "", rel: id + ".md", theme: "knowledge", ...extra });

test("D1: near-duplicate notes are reported by the structure audit, report-only (no fix, no AI), after the R rules; unrelated notes are not", () => {
  const notes = [
    note("MEMORY", "MEMORY", "index"),
    note("coffee-a", "Espresso Grind Timing Notes", "Grind size and timing notes for espresso brewing"),
    note("coffee-b", "Espresso Grind Timing Guide", "Grind size and timing guide for espresso brewing"),
    note("garden", "Garden Watering", "watering schedule for the vegetable garden"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  const d1 = issues.filter((i) => i.rule === "D1");
  assert.strictEqual(d1.length, 1, JSON.stringify(d1));
  assert.strictEqual(d1[0].fix, null);
  assert.ok(typeof d1[0].score === "number" && d1[0].score > 0 && d1[0].score <= 1);
  assert.deepStrictEqual([d1[0].note, d1[0].other].sort(), ["coffee-a", "coffee-b"]);
  assert.ok(!d1.some((i) => i.note === "garden" || i.other === "garden"));
  assert.strictEqual(issues[issues.length - 1].rule, "D1", "D1 sits after the R-rule issues so the bounded issueList never loses an R issue to it");
  const list = star.issueList(issues);
  assert.match(list.find((i) => i.rule === "D1").detail, /possible duplicate of .* \(score [\d.]+/);
  assert.strictEqual(star.summarize(issues).byRule.D1, 1);
});

test("old maintenance.duplicates config / env: ignored with one explanatory note, never an error", () => {
  assert.strictEqual(dupCand.ignoredDuplicatesNote({}, {}), null);
  assert.match(dupCand.ignoredDuplicatesNote({ enabled: true, autoMerge: true }, {}), /ignored: maintenance\.duplicates/);
  assert.match(dupCand.ignoredDuplicatesNote(null, { MEMGLOW_AUTO_DUPLICATES: "1" }), /ignored/);
  const root = tmp("memglow-060-kb-");
  fs.writeFileSync(path.join(root, "MEMORY.md"), "---\ntitle: MEMORY\n---\n\n- [[a]] — a\n");
  fs.writeFileSync(path.join(root, "a.md"), "---\ntitle: a\n---\n\nx\n");
  const srv = createMemoryServer({ root, watch: false, pollMs: 0, duplicates: { enabled: true, autoMerge: true } });
  try { assert.ok(srv.tools.call("memory_core", {}).content[0].text.length > 0); } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function kbWith(files) {
  const root = tmp("memglow-060-kb-");
  for (const [rel, text] of Object.entries(files)) { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); }
  return root;
}

test("memory_core \"À regarder\" line: omitted when nothing is pending; lists unfixed structure issues by rule and D1 candidates when there are some", async () => {
  const clean = kbWith({ "MEMORY.md": "---\ntitle: MEMORY\n---\n\n## Work\n\n- [[solo]] — a note\n", "solo.md": "---\ntitle: solo\n---\n\nbody\n" });
  const a = createMemoryServer({ root: clean, watch: false, pollMs: 0, readOnly: false, structure: { enabled: true } });
  try {
    await a.structure.scanOnce();
    assert.ok(!/À regarder/.test(a.tools.call("memory_core", {}).content[0].text), "nothing pending: no line at all");
  } finally { a.close(); fs.rmSync(clean, { recursive: true, force: true }); }

  const messy = kbWith({
    "MEMORY.md": "---\ntitle: MEMORY\n---\n\n## Work\n\n- [[solo]] — a note\n",
    "solo.md": "---\ntitle: solo\n---\n\nbody\n",
    "orphan.md": "---\ntitle: orphan\n---\n\nnot in the index, no hub\n",
    "coffee-a.md": "---\ntitle: Espresso Grind Timing Notes\ndescription: Grind size and timing notes for espresso brewing\ntheme: knowledge\n---\n\nbody\n",
    "coffee-b.md": "---\ntitle: Espresso Grind Timing Guide\ndescription: Grind size and timing guide for espresso brewing\ntheme: knowledge\n---\n\nbody\n",
  });
  const b = createMemoryServer({ root: messy, watch: false, pollMs: 0, readOnly: false, structure: { enabled: true } });
  try {
    await b.structure.scanOnce();
    const text = b.tools.call("memory_core", {}).content[0].text;
    const line = text.split("\n").filter((l) => l.startsWith("À regarder"));
    assert.strictEqual(line.length, 1, text);
    assert.match(line[0], /structure issues? \(R5 ×\d+/);
    assert.match(line[0], /1 possible duplicate \(D1\)/);
    assert.ok(!/last AI error/.test(line[0]));
  } finally { b.close(); fs.rmSync(messy, { recursive: true, force: true }); }
});

test("session-start accounting: tools/list and memory_core answers are recorded per day and surface as 'Session start ≈ N tokens'", () => {
  const dir = tmp("memglow-060-acct-");
  const savings = L.createSavings({ dataDir: dir, savingsFile: true, log: false });
  savings.addSessionStart("toolsList", 3000);
  savings.addSessionStart("toolsList", 3200);
  savings.addSessionStart("memoryCore", 1000);
  savings.addSessionStart("bogus", 5);
  savings.addSessionStart("memoryCore", -3);
  savings.flush();
  const r = L.readClientSavings(dir);
  assert.deepStrictEqual(r.sessionStart, { memoryCoreAvg: 1000, toolsListAvg: 3100, total: 4100, memoryCoreServed: 1, toolsListServed: 2 });
  const mc = require("../lib/memory-core");
  assert.match(mc.accountingSummary({ dataDir: dir }), /Session start ≈ 4100 tokens \(memory_core ≈1000 \+ tools\/list ≈3100\)\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("session-start accounting through the engine: a tools/list and a memory_core answer are measured", () => {
  const { engine, savings } = engineFor();
  const seen = [];
  const orig = savings.addSessionStart.bind(savings);
  savings.addSessionStart = (k, t) => { seen.push([k, t]); orig(k, t); };
  list(engine, { name: "claude-code" });
  engine.clientMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_core", arguments: {} } }, "s");
  engine.serverMessage({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "x".repeat(400) }] } }, "s");
  assert.deepStrictEqual(seen.map((s) => s[0]), ["toolsList", "memoryCore"]);
  assert.ok(seen[0][1] > 500 && seen[1][1] > 50);
});

test("store polling: with fs.watch active and healthy the effective poll is max(configured, 15 s); the configured value is kept when watch is off", async () => {
  const root = kbWith({ "MEMORY.md": "---\ntitle: MEMORY\n---\n\nx\n", "a.md": "---\ntitle: a\n---\n\nx\n" });
  const watched = createMemoryServer({ root, watch: true, pollMs: 500 });
  const unwatched = createMemoryServer({ root, watch: false, pollMs: 500 });
  try {
    await watched.ready; await unwatched.ready;
    const sw = watched.store.stats(), su = unwatched.store.stats();
    assert.strictEqual(sw.pollMs, 500, "the configured value is untouched");
    if (sw.watching) assert.ok(sw.effectivePollMs >= 15000, JSON.stringify(sw));
    else assert.strictEqual(sw.effectivePollMs, 500, "watch unavailable on this filesystem: configured value kept");
    assert.strictEqual(su.effectivePollMs, 500);
    const big = createMemoryServer({ root, watch: true, pollMs: 60000 });
    try { await big.ready; if (big.store.stats().watching) assert.strictEqual(big.store.stats().effectivePollMs, 60000, "a configured value above 15 s is never lowered"); } finally { big.close(); }
  } finally { watched.close(); unwatched.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
