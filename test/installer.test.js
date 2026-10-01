"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const installer = require("../lib/installer");

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-inst-"));
  const j = (rel, data) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); return f; };
  const vault = path.join(home, "vault"); fs.mkdirSync(vault);
  j(".config/obsidian/obsidian.json", { vaults: { a: { path: vault, ts: 1 } } });
  for (const d of [".codex", ".cursor", ".codeium/windsurf", ".copilot", "Documents/Cline"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const claude = j(".claude/settings.json", { model: "x", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } });
  const gemini = j(".gemini/settings.json", "{ not json");
  const desktop = j(".config/Claude/claude_desktop_config.json", { mcpServers: { "basic-memory": { command: "uvx", args: ["basic-memory", "mcp"] }, weather: { command: "wx" } } });
  return { home, vault, claude, gemini, desktop, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("detectNotes: basic-memory project first, then Obsidian", () => {
  const h = fakeHome();
  try {
    assert.strictEqual(installer.detectNotes(h.home)[0].dir, h.vault);
    const bm = path.join(h.home, "bm"); fs.mkdirSync(bm);
    fs.mkdirSync(path.join(h.home, ".basic-memory"));
    fs.writeFileSync(path.join(h.home, ".basic-memory/config.json"), JSON.stringify({ default_project: "main", projects: { main: bm } }));
    assert.strictEqual(installer.detectNotes(h.home)[0].dir, bm);
  } finally { h.done(); }
});

test("init: token, config, hooks merged, foreign entries kept, broken file untouched, backups", async () => {
  const h = fakeHome();
  const geminiBefore = fs.readFileSync(h.gemini, "utf8");
  const claudeBefore = fs.readFileSync(h.claude, "utf8");
  try {
    const r = await installer.init({ home: h.home, wrapMcp: true, docker: true });
    assert.strictEqual(r.notes, h.vault);
    const tok = fs.readFileSync(path.join(h.home, ".memglow/token"), "utf8").trim();
    assert.match(tok, /^[0-9a-f]{48}$/);
    assert.strictEqual(fs.statSync(path.join(h.home, ".memglow/token")).mode & 0o777, 0o600);
    assert.strictEqual(read(path.join(h.home, ".memglow/memglow.config.json")).memoryDir, h.vault);
    assert.ok(fs.existsSync(path.join(h.home, ".memglow/app/adapters/claude-code/hook.js")));
    assert.ok(fs.existsSync(path.join(h.home, ".memglow/app/lib/agent-core.js")));
    for (const f of ["proxy-levers.js", "memory.js", "cost.js", "counters.js", "related.js"]) assert.ok(fs.existsSync(path.join(h.home, ".memglow/app/lib", f)), f);

    const c = read(h.claude);
    assert.strictEqual(c.model, "x");
    assert.strictEqual(c.hooks.PostToolUse.length, 2);
    assert.strictEqual(c.hooks.PostToolUse[0].hooks[0].command, "echo mine");
    assert.match(c.hooks.PostToolUse[1].hooks[0].command, /\.memglow\/app\/adapters\/claude-code\/hook\.js/);
    assert.strictEqual(fs.readFileSync(h.claude + ".memglow-backup", "utf8"), claudeBefore);

    assert.deepStrictEqual(Object.keys(read(path.join(h.home, ".codex/hooks.json")).hooks), ["PostToolUse"]);
    assert.deepStrictEqual(Object.keys(read(path.join(h.home, ".cursor/hooks.json")).hooks), ["beforeReadFile", "afterFileEdit", "afterMCPExecution"]);
    assert.match(read(path.join(h.home, ".cursor/hooks.json")).hooks.afterFileEdit[0].command, / afterFileEdit$/);
    assert.deepStrictEqual(Object.keys(read(path.join(h.home, ".codeium/windsurf/hooks.json")).hooks), ["post_read_code", "post_write_code", "post_mcp_tool_use"]);
    assert.strictEqual(read(path.join(h.home, ".copilot/hooks/memglow.json")).version, 1);
    const cline = path.join(h.home, "Documents/Cline/Rules/Hooks/PostToolUse");
    assert.ok(fs.statSync(cline).mode & 0o100);

    assert.strictEqual(fs.readFileSync(h.gemini, "utf8"), geminiBefore, "unparsable file never rewritten");
    assert.ok(r.skipped.some((s) => s.id === "gemini" && /not valid JSON/.test(s.why)));

    const d = read(h.desktop);
    assert.strictEqual(d.mcpServers["basic-memory"].command, "node");
    assert.deepStrictEqual(d.mcpServers["basic-memory"].args.slice(-4), ["--", "uvx", "basic-memory", "mcp"]);
    assert.deepStrictEqual(d.mcpServers.weather, { command: "wx" }, "non-memory server untouched");

    assert.match(fs.readFileSync(path.join(h.home, ".memglow/docker-compose.yml"), "utf8"), /\/memory:ro/);
    assert.strictEqual(fs.statSync(path.join(h.home, ".memglow/.env")).mode & 0o777, 0o600);
  } finally { h.done(); }
});

test("init twice: idempotent, same token", async () => {
  const h = fakeHome();
  try {
    await installer.init({ home: h.home, wrapMcp: true });
    const tok = fs.readFileSync(path.join(h.home, ".memglow/token"), "utf8");
    const snapshot = [h.claude, h.desktop, path.join(h.home, ".cursor/hooks.json")].map((f) => fs.readFileSync(f, "utf8"));
    await installer.init({ home: h.home, wrapMcp: true });
    assert.strictEqual(fs.readFileSync(path.join(h.home, ".memglow/token"), "utf8"), tok);
    assert.deepStrictEqual([h.claude, h.desktop, path.join(h.home, ".cursor/hooks.json")].map((f) => fs.readFileSync(f, "utf8")), snapshot);
  } finally { h.done(); }
});

test("init: agent selection, declined prompts, no notes folder", async () => {
  const h = fakeHome();
  try {
    const r = await installer.init({ home: h.home, agents: ["codex"], confirm: async (q) => !/Claude Desktop/.test(q), wrapMcp: true });
    assert.deepStrictEqual(r.agents.map((a) => a.id), ["codex"]);
    assert.deepStrictEqual(r.mcp, []);
    assert.strictEqual(read(h.claude).hooks.PostToolUse.length, 1);
    const r2 = await installer.init({ home: h.home, confirm: async () => false });
    assert.deepStrictEqual(r2.agents, []);
    assert.ok(r2.skipped.every((s) => s.why === "declined" || /not valid JSON/.test(s.why)));
  } finally { h.done(); }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-empty-"));
  try { await assert.rejects(installer.init({ home: empty }), /--dir/); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("init: a foreign Cline PostToolUse script is never replaced", async () => {
  const h = fakeHome();
  try {
    const f = path.join(h.home, "Documents/Cline/Rules/Hooks/PostToolUse");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "#!/bin/sh\necho theirs\n");
    const r = await installer.init({ home: h.home });
    assert.ok(r.skipped.some((s) => s.id === "cline"));
    assert.strictEqual(fs.readFileSync(f, "utf8"), "#!/bin/sh\necho theirs\n");
    installer.uninstall({ home: h.home });
    assert.strictEqual(fs.readFileSync(f, "utf8"), "#!/bin/sh\necho theirs\n");
  } finally { h.done(); }
});

test("uninstall: removes only memglow entries, unwraps MCP, deletes files it created", async () => {
  const h = fakeHome();
  const claudeBefore = read(h.claude);
  const desktopBefore = read(h.desktop);
  try {
    await installer.init({ home: h.home, wrapMcp: true });
    // the user edits their settings after install: must survive uninstall
    const c = read(h.claude); c.model = "y"; fs.writeFileSync(h.claude, JSON.stringify(c));
    const r = installer.uninstall({ home: h.home });
    assert.deepStrictEqual(read(h.claude), { ...claudeBefore, model: "y" });
    assert.deepStrictEqual(read(h.desktop), desktopBefore);
    assert.deepStrictEqual(r.mcp, ["basic-memory"]);
    for (const f of [".codex/hooks.json", ".cursor/hooks.json", ".codeium/windsurf/hooks.json", ".copilot/hooks/memglow.json", "Documents/Cline/Rules/Hooks/PostToolUse"]) {
      assert.ok(!fs.existsSync(path.join(h.home, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(h.home, ".memglow/app")));
    assert.ok(fs.existsSync(path.join(h.home, ".memglow/token")), "token kept without --purge");
    assert.deepStrictEqual(installer.uninstall({ home: h.home }), { cleaned: [], restored: [], mcp: [] });
  } finally { h.done(); }
});

test("uninstall --restore-backups puts the original files back; --purge removes ~/.memglow", async () => {
  const h = fakeHome();
  const before = fs.readFileSync(h.claude, "utf8");
  try {
    await installer.init({ home: h.home });
    installer.uninstall({ home: h.home, restoreBackups: true, purge: true });
    assert.strictEqual(fs.readFileSync(h.claude, "utf8"), before);
    assert.ok(!fs.existsSync(path.join(h.home, ".memglow")));
  } finally { h.done(); }
});

test("CLI: memglow init --yes / uninstall in a fake home", async () => {
  const h = fakeHome();
  const { execFileSync } = require("child_process");
  const bin = path.join(__dirname, "..", "bin", "memglow.js");
  try {
    const out = execFileSync(process.execPath, [bin, "init", "--yes", "--home", h.home, "--agents", "claude-code,codex", "--port", "4800"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /claude-code/);
    assert.strictEqual(read(path.join(h.home, ".memglow/memglow.config.json")).port, 4800);
    assert.ok(!fs.existsSync(path.join(h.home, ".cursor/hooks.json")));
    const u = execFileSync(process.execPath, [bin, "uninstall", "--home", h.home], { encoding: "utf8" });
    assert.match(u, /removed memglow from/);
    assert.match(execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" }), /memglow init/);
  } finally { h.done(); }
});

test("server falls back to ~/.memglow only when nothing else is configured", () => {
  const { withInstalledDefaults } = require("../server");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-fb-"));
  try {
    fs.writeFileSync(path.join(home, "memglow.config.json"), "{}");
    fs.writeFileSync(path.join(home, "token"), "z".repeat(40));
    const e = withInstalledDefaults({ MEMGLOW_HOME: home }, home + "/nowhere");
    assert.strictEqual(e.MEMGLOW_CONFIG, path.join(home, "memglow.config.json"));
    assert.strictEqual(e.MEMGLOW_TOKEN, "z".repeat(40));
    const e2 = withInstalledDefaults({ MEMGLOW_HOME: home, MEMORY_DIR: "/x", MEMGLOW_TOKEN: "t".repeat(40) }, home);
    assert.strictEqual(e2.MEMGLOW_CONFIG, undefined);
    assert.strictEqual(e2.MEMGLOW_TOKEN, "t".repeat(40));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
