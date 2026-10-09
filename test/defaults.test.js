"use strict";
// 0.4.7.1: lib/defaults.js — the single source of truth for largeNoteTokens/splitChunkTokens/
// indexWarningTokens, the two-location memglow.config.json resolution (project file over the
// home file `memglow init` writes, with a divergence warning) and env > page (setup.json) > file
// > default precedence. Also checks that lib/config.js, lib/proxy-levers.js, lib/memory-rules.js
// and lib/cost.js never drift apart on these numbers.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../lib/defaults");
const { loadConfig } = require("../lib/config");
const L = require("../lib/proxy-levers");
const R = require("../lib/memory-rules");
const cost = require("../lib/cost");

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ---------------------------------------------------------------------------------------------
// No divergence: the one real duplication left (lib/cost.js is kept fs-free on purpose) must
// still equal the single source of truth, and every module's OWN built-in default must too.

test("defaults: lib/cost.js's own fallback constants equal lib/defaults.js", () => {
  assert.strictEqual(cost.LARGE_NOTE_TOKENS, D.LARGE_NOTE_TOKENS);
  assert.strictEqual(cost.CHUNK_TOKENS, D.SPLIT_CHUNK_TOKENS);
});

test("defaults: lib/config.js, lib/proxy-levers.js and lib/memory-rules.js fall back to the exact same numbers with nothing configured", () => {
  const home = tmpDir("memglow-def-none-");
  const cwd = tmpDir("memglow-def-nonecwd-");
  const env = { MEMGLOW_HOME: home, MEMORY_DIR: cwd, MEMGLOW_DATA_DIR: tmpDir("memglow-def-data-") };
  const cfg = loadConfig(env, cwd);
  assert.strictEqual(cfg.largeNoteTokens, D.LARGE_NOTE_TOKENS);
  assert.strictEqual(cfg.splitChunkTokens, D.SPLIT_CHUNK_TOKENS);
  assert.strictEqual(cfg.indexWarningTokens, D.INDEX_WARNING_TOKENS);
  const proxy = L.proxyConfig({ MEMGLOW_HOME: home }, cwd);
  assert.strictEqual(proxy.largeNoteTokens, D.LARGE_NOTE_TOKENS);
  assert.strictEqual(proxy.indexWarningTokens, D.INDEX_WARNING_TOKENS);
  const light = R.lightConfig({ MEMGLOW_HOME: home }, cwd);
  assert.strictEqual(light.largeNoteTokens, D.LARGE_NOTE_TOKENS);
  assert.strictEqual(light.splitChunkTokens, D.SPLIT_CHUNK_TOKENS);
});

// ---------------------------------------------------------------------------------------------
// resolveConfigFiles: one location, two locations, precedence, divergence warning, strict mode.

test("resolveConfigFiles: MEMGLOW_CONFIG alone, never merged with the home file", () => {
  const home = tmpDir("memglow-rc-home-");
  const explicit = path.join(tmpDir("memglow-rc-explicit-"), "x.json");
  fs.writeFileSync(explicit, JSON.stringify({ title: "explicit" }));
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ title: "home", other: 1 }));
  const r = D.resolveConfigFiles({ env: { MEMGLOW_CONFIG: explicit }, home });
  assert.deepStrictEqual(r.config, { title: "explicit" });
  assert.strictEqual(r.file, explicit);
  assert.strictEqual(r.homeFile, null);
  assert.deepStrictEqual(r.warnings, []);
});

test("resolveConfigFiles: no MEMGLOW_CONFIG — the project (cwd) file wins per key over the home file", () => {
  const home = tmpDir("memglow-rc-home2-");
  const cwd = tmpDir("memglow-rc-cwd2-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ title: "home", largeNoteTokens: 1000, port: 9999 }));
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), JSON.stringify({ title: "project", largeNoteTokens: 3000 }));
  const r = D.resolveConfigFiles({ env: {}, cwd, home });
  assert.strictEqual(r.config.title, "project", "cwd wins for a key both set");
  assert.strictEqual(r.config.largeNoteTokens, 3000, "cwd wins for a key both set");
  assert.strictEqual(r.config.port, 9999, "home fills in a key the project file never set");
  assert.strictEqual(r.cwdFile, path.join(cwd, "memglow.config.json"));
  assert.strictEqual(r.homeFile, path.join(home, "memglow.config.json"));
  assert.strictEqual(r.warnings.length, 2, "title and largeNoteTokens both differ");
  assert.match(r.warnings[0], /"(title|largeNoteTokens)"/);
});

test("resolveConfigFiles: only the home file exists — used as is, no warning", () => {
  const home = tmpDir("memglow-rc-home3-");
  const cwd = tmpDir("memglow-rc-cwd3-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ title: "home-only" }));
  const r = D.resolveConfigFiles({ env: {}, cwd, home });
  assert.strictEqual(r.config.title, "home-only");
  assert.strictEqual(r.file, path.join(home, "memglow.config.json"));
  assert.deepStrictEqual(r.warnings, []);
});

test("resolveConfigFiles: no file anywhere — {} config, null file, no warning, no throw", () => {
  const home = tmpDir("memglow-rc-home4-");
  const cwd = tmpDir("memglow-rc-cwd4-");
  const r = D.resolveConfigFiles({ env: {}, cwd, home });
  assert.deepStrictEqual(r.config, {});
  assert.strictEqual(r.file, null);
  assert.deepStrictEqual(r.warnings, []);
});

test("resolveConfigFiles: strict throws on a broken PROJECT file, never on a broken HOME file", () => {
  const home = tmpDir("memglow-rc-home5-");
  const cwd = tmpDir("memglow-rc-cwd5-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), "{not json");
  assert.doesNotThrow(() => D.resolveConfigFiles({ env: {}, cwd, home, strict: true }));
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), "{also not json");
  assert.throws(() => D.resolveConfigFiles({ env: {}, cwd, home, strict: true }), /cannot parse/);
  // Non-strict (the proxy, the MCP server): never throws, whichever file is broken.
  assert.doesNotThrow(() => D.resolveConfigFiles({ env: {}, cwd, home, strict: false }));
});

test("resolveConfigFiles: strict throws on a broken EXPLICIT (MEMGLOW_CONFIG) file", () => {
  const explicit = path.join(tmpDir("memglow-rc-explicit2-"), "x.json");
  fs.writeFileSync(explicit, "{not json");
  assert.throws(() => D.resolveConfigFiles({ env: { MEMGLOW_CONFIG: explicit }, strict: true }), /cannot parse/);
  assert.doesNotThrow(() => D.resolveConfigFiles({ env: { MEMGLOW_CONFIG: explicit }, strict: false }));
});

// ---------------------------------------------------------------------------------------------
// resolveInt: env > page > file > default.

test("resolveInt: priority order, each candidate clamped, invalid value falls straight to default", () => {
  assert.strictEqual(D.resolveInt("3000", 1000, 500, 999, 200, 100000), 3000, "env wins");
  assert.strictEqual(D.resolveInt(undefined, 1000, 500, 999, 200, 100000), 1000, "page wins over file");
  assert.strictEqual(D.resolveInt(undefined, undefined, 500, 999, 200, 100000), 500, "file wins over default");
  assert.strictEqual(D.resolveInt(undefined, undefined, undefined, 999, 200, 100000), 999, "default");
  assert.strictEqual(D.resolveInt("", null, undefined, 999, 200, 100000), 999, "empty/null/undefined all skipped");
  assert.strictEqual(D.resolveInt("not a number", 1000, 500, 999, 200, 100000), 999, "an invalid PRESENT value falls to the default, not the next source");
  assert.strictEqual(D.resolveInt(50, 1000, 500, 999, 200, 100000), 999, "env present but out of range: default, not page");
});

test("readSavedTuning: the tuning section of setup.json, {} when absent/unreadable/no dataDir", () => {
  assert.deepStrictEqual(D.readSavedTuning(null), {});
  const dir = tmpDir("memglow-tuning-");
  assert.deepStrictEqual(D.readSavedTuning(dir), {}, "no setup.json yet");
  fs.writeFileSync(path.join(dir, "setup.json"), JSON.stringify({ tuning: { largeNoteTokens: 4242 } }));
  assert.deepStrictEqual(D.readSavedTuning(dir), { largeNoteTokens: 4242 });
  fs.writeFileSync(path.join(dir, "setup.json"), "{not json");
  assert.deepStrictEqual(D.readSavedTuning(dir), {});
});

// ---------------------------------------------------------------------------------------------
// End to end: the proxy and the rules now pick up the page's saved tuning, with the right
// priority — this is the actual bug fix ("lever 1's threshold must match the UI").

test("proxyConfig: largeNoteTokens — env > page (setup.json tuning) > memglow.config.json > default", () => {
  const home = tmpDir("memglow-lever1-home-");
  const cwd = tmpDir("memglow-lever1-cwd-");
  const data = tmpDir("memglow-lever1-data-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 1500, dataDir: data }));
  // File only.
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home }, cwd).largeNoteTokens, 1500);
  // Page (setup.json tuning) wins over the file.
  fs.writeFileSync(path.join(data, "setup.json"), JSON.stringify({ tuning: { largeNoteTokens: 4000 } }));
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home }, cwd).largeNoteTokens, 4000);
  // Env wins over everything.
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home, MEMGLOW_LARGE_NOTE_TOKENS: "9000" }, cwd).largeNoteTokens, 9000);
});

test("memory-rules lightConfig: largeNoteTokens/splitChunkTokens follow the same env > page > file > default priority as the proxy", () => {
  const home = tmpDir("memglow-rules-tuning-home-");
  const cwd = tmpDir("memglow-rules-tuning-cwd-");
  const data = tmpDir("memglow-rules-tuning-data-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 1500, splitChunkTokens: 700, dataDir: data }));
  assert.strictEqual(R.lightConfig({ MEMGLOW_HOME: home }, cwd).largeNoteTokens, 1500);
  fs.writeFileSync(path.join(data, "setup.json"), JSON.stringify({ tuning: { largeNoteTokens: 4000, splitChunkTokens: 1800 } }));
  const light = R.lightConfig({ MEMGLOW_HOME: home }, cwd);
  assert.strictEqual(light.largeNoteTokens, 4000);
  assert.strictEqual(light.splitChunkTokens, 1800);
  const text = R.computeRulesText({ MEMGLOW_HOME: home }, cwd);
  assert.match(text, /under 4000 tokens/, "the rules text itself reflects the page's saved tuning");
});

test("0.4.7.6 trust boundary: a cwd memglow.config.json never reaches the proxy — the viewer still merges it", () => {
  const home = tmpDir("memglow-divergence-home-");
  const cwd = tmpDir("memglow-divergence-cwd-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 1500 }));
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 9999 }));
  // The proxy (and the rules): the cwd file is invisible, home wins outright, no warning at all
  // (resolveConfigFiles with allowCwd:false never even looks at the cwd file).
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: home }, cwd).largeNoteTokens, 1500);
  assert.strictEqual(R.lightConfig({ MEMGLOW_HOME: home }, cwd).largeNoteTokens, 1500);
  // The viewer (lib/config.js): unaffected by the trust boundary — this is ITS OWN project
  // folder, never the notes folder — so the cwd file still legitimately wins, with a warning.
  const dir = tmpDir("memglow-divergence-notes-");
  const dataDir = tmpDir("memglow-divergence-data-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_HOME: home }, cwd);
  assert.strictEqual(config.largeNoteTokens, 9999, "the viewer's own project (cwd) file still wins");
});

test("0.4.7.6 (minor 1): loadConfig's divergence warning fires once per process per file pair, not on every call", () => {
  D._resetWarnOnce();
  const home = tmpDir("memglow-warnonce-home-");
  const cwd = tmpDir("memglow-warnonce-cwd-");
  fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 1500 }));
  fs.writeFileSync(path.join(cwd, "memglow.config.json"), JSON.stringify({ largeNoteTokens: 9999 }));
  const dir = tmpDir("memglow-warnonce-notes-");
  const dataDir = tmpDir("memglow-warnonce-data-");
  const orig = console.warn;
  const lines = [];
  console.warn = (s) => lines.push(String(s));
  try {
    loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_HOME: home }, cwd);
    loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_HOME: home }, cwd);
    loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_HOME: home }, cwd);
  } finally { console.warn = orig; }
  assert.strictEqual(lines.length, 1, "warned exactly once across three calls with the same file pair");
  assert.match(lines[0], /largeNoteTokens.*differently/);
});

test("0.4.7.6 trust boundary: a hostile cwd memglow.config.json + setup.json has no effect on proxyConfig, computeRulesText or the all-in-one server's levers", () => {
  const { setupServerLevers } = require("../memory-server/all-in-one");
  const hostileCwd = tmpDir("memglow-hostile-cwd-");
  const home = tmpDir("memglow-hostile-home-");
  const hostileData = tmpDir("memglow-hostile-data-");
  fs.mkdirSync(hostileData, { recursive: true });
  // A ./memglow.config.json as a cloned, untrusted notes repository might ship one.
  fs.writeFileSync(path.join(hostileCwd, "memglow.config.json"), JSON.stringify({
    largeNoteTokens: 1,
    dataDir: hostileData,
    memoryDir: "/etc",
    proxy: { unsupportedTools: { evil: { x: ["y"] } }, readTools: ["evil_tool"] },
  }));
  // Its own setup.json (in the hostile dataDir it tried to claim), trying to inject rules text.
  fs.writeFileSync(path.join(hostileData, "setup.json"), JSON.stringify({
    rules: { enabled: true, override: "INJECTED RULES TEXT FROM A CLONED REPO" },
  }));
  const env = { MEMGLOW_HOME: home };
  const before = process.cwd();
  process.chdir(hostileCwd);
  try {
    const cfg = L.proxyConfig(env); // no cwd argument: must resolve process.cwd() itself
    assert.strictEqual(cfg.largeNoteTokens, D.LARGE_NOTE_TOKENS, "hostile largeNoteTokens ignored");
    assert.notStrictEqual(cfg.memoryDir, "/etc");
    assert.deepStrictEqual(cfg.unsupportedTools, L.DEFAULT_UNSUPPORTED_TOOLS, "hostile tool-mapping table ignored");
    assert.deepStrictEqual(cfg.readTools, ["read_note", "view_note", "read_content", "fetch", "build_context"], "hostile readTools ignored");
    assert.ok(!cfg.dataDir.startsWith(hostileData), "hostile dataDir never used");

    const text = R.computeRulesText(env);
    assert.ok(!text.includes("INJECTED RULES TEXT"), "hostile setup.json rules override never used");
    assert.match(text, /memory-hygiene rules/, "the built-in template is used instead");

    const notesRoot = tmpDir("memglow-hostile-notes-");
    const engine = setupServerLevers({ root: notesRoot, env });
    assert.ok(engine, "levers still set up (defaults alone turn some on)");
    assert.deepStrictEqual(engine.config.unsupportedTools, L.DEFAULT_UNSUPPORTED_TOOLS, "the all-in-one server's own levers ignore the hostile table too");
    assert.notStrictEqual(engine.config.largeNoteTokens, 1);
  } finally { process.chdir(before); }
});
