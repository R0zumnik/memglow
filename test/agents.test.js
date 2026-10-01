"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { parse, patchPaths, AGENTS } = require("../adapters/agents");
const core = require("../lib/agent-core");

const NOTES = path.join(os.tmpdir(), "memglow-notes-x");
const S = { memoryDir: NOTES + path.sep, servers: ["basic-memory", "memory", "obsidian", "notes", "filesystem"] };
const run = (agent, payload, event) => parse(agent, payload, event).map((e) => core.classify(e, S)).filter(Boolean);
const note = (n) => path.join(NOTES, "people", n + ".md");

test("core: tool name → activity type", () => {
  assert.strictEqual(core.mcpType("read_note"), "read");
  assert.strictEqual(core.mcpType("build_context"), "read");
  assert.strictEqual(core.mcpType("search_notes"), "search");
  assert.strictEqual(core.mcpType("write_note"), "write");
  assert.strictEqual(core.mcpType("edit_note"), "write");
  assert.strictEqual(core.mcpType("list_directory"), null);
});

test("core: file events count only for .md inside the notes folder", () => {
  assert.deepStrictEqual(core.classify({ kind: "file", op: "read", path: note("alice") }, S), { type: "read", ids: ["alice"] });
  assert.strictEqual(core.classify({ kind: "file", op: "read", path: "/etc/passwd" }, S), null);
  assert.strictEqual(core.classify({ kind: "file", op: "read", path: path.join(NOTES, "x.txt") }, S), null);
  assert.strictEqual(core.classify({ kind: "file", op: "read", path: note("a") }, { ...S, memoryDir: null }), null);
});

test("core: MCP events need a memory server unless trusted (proxy)", () => {
  const e = { kind: "mcp", server: "github", tool: "read_note", args: { identifier: "alice" } };
  assert.strictEqual(core.classify(e, S), null);
  assert.deepStrictEqual(core.classify({ ...e, trusted: true }, S), { type: "read", ids: ["alice"] });
  assert.deepStrictEqual(core.classify({ ...e, server: "basic_memory" }, S).ids, ["alice"]);
});

test("core: only clean note names leave, never content", () => {
  const r = core.classify({ kind: "mcp", server: "basic-memory", tool: "search_notes", args: { query: "secret stuff" },
    result: { content: [{ type: "text", text: "found memory://people/alice and projects/roadmap.md — password: x" }] } }, S);
  assert.strictEqual(r.type, "search");
  assert.deepStrictEqual(r.ids.sort(), ["alice", "roadmap"]);
  assert.ok(!JSON.stringify(r).includes("secret"));
});

test("core: sanitizeMachine — closed charset, length limit, never a path or an IP", () => {
  assert.strictEqual(core.sanitizeMachine("laptop-2"), "laptop-2", "already valid: unchanged");
  assert.strictEqual(core.sanitizeMachine("My Laptop!"), "My-Laptop", "cleaned, not rejected outright");
  assert.strictEqual(core.sanitizeMachine("../etc/passwd"), "etc-passwd", "path separators stripped, no leading dashes");
  assert.strictEqual(core.sanitizeMachine("x".repeat(80)).length, 32, "truncated to the limit");
  assert.strictEqual(core.sanitizeMachine("!!!"), "host", "nothing usable left: falls back");
  assert.strictEqual(core.sanitizeMachine(""), "host");
  assert.ok(core.MACHINE_RE.test(core.sanitizeMachine("anything at all, really")));
});

test("core: report() — channel defaults to \"hook\", carries this machine's label, dryRun returns the body unsent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-report-"));
  const saved = { MEMGLOW_HOME: process.env.MEMGLOW_HOME, MEMGLOW_MEMORY_DIR: process.env.MEMGLOW_MEMORY_DIR,
    MEMGLOW_MACHINE: process.env.MEMGLOW_MACHINE, MEMGLOW_TOKEN: process.env.MEMGLOW_TOKEN };
  process.env.MEMGLOW_HOME = home;
  process.env.MEMGLOW_MEMORY_DIR = NOTES;
  process.env.MEMGLOW_MACHINE = "test-rig";
  process.env.MEMGLOW_TOKEN = "k".repeat(40);
  try {
    const evt = { kind: "file", op: "read", path: note("alice") };
    const body = core.report(evt, "claude-code", { dryRun: true });
    assert.deepStrictEqual(body, { type: "read", ids: ["alice"], source: "claude-code", channel: "hook", machine: "test-rig" });
    const proxied = core.report(evt, "mcp", { dryRun: true, channel: "mcp-proxy" });
    assert.strictEqual(proxied.channel, "mcp-proxy");
    const bogus = core.report(evt, "mcp", { dryRun: true, channel: "ssh" });
    assert.strictEqual(bogus.channel, "hook", "an unknown channel falls back to hook, never passed through raw");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claude-code: MCP and file tools", () => {
  assert.deepStrictEqual(run("claude-code", { tool_name: "mcp__basic-memory__write_note", tool_input: { title: "bob", directory: "people" } }), [{ type: "write", ids: ["bob"] }]);
  assert.deepStrictEqual(run("claude-code", { tool_name: "Read", tool_input: { file_path: note("alice") } }), [{ type: "read", ids: ["alice"] }]);
  assert.deepStrictEqual(run("claude-code", { tool_name: "Bash", tool_input: { command: "ls" } }), []);
});

test("codex: apply_patch paths and MCP", () => {
  const patch = `*** Begin Patch\n*** Update File: ${note("alice")}\n@@\n-a\n+b\n*** Add File: ${note("carol")}\n+hi\n*** End Patch`;
  assert.deepStrictEqual(patchPaths(patch), [note("alice"), note("carol")]);
  assert.deepStrictEqual(run("codex", { tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/" }), [{ type: "write", ids: ["alice"] }, { type: "write", ids: ["carol"] }]);
  assert.deepStrictEqual(run("codex", { tool_name: "mcp__memory__read_note", tool_input: { identifier: "people/bob" } }), [{ type: "read", ids: ["bob"] }]);
});

test("gemini: built-in file tools and MCP tools", () => {
  assert.deepStrictEqual(run("gemini", { tool_name: "read_file", tool_input: { absolute_path: note("alice") } }), [{ type: "read", ids: ["alice"] }]);
  assert.deepStrictEqual(run("gemini", { tool_name: "replace", tool_input: { file_path: note("bob") } }), [{ type: "write", ids: ["bob"] }]);
  assert.deepStrictEqual(run("gemini", { tool_name: "mcp_basic-memory_read_note", tool_input: { identifier: "carol" },
    mcp_context: { server_name: "basic-memory", tool_name: "read_note" }, tool_response: { llmContent: "…" } }), [{ type: "read", ids: ["carol"] }]);
});

test("cursor: event passed as argument", () => {
  assert.deepStrictEqual(run("cursor", { file_path: note("alice"), content: "x" }, "beforeReadFile"), [{ type: "read", ids: ["alice"] }]);
  assert.deepStrictEqual(run("cursor", { file_path: note("alice"), edits: [] }, "afterFileEdit"), [{ type: "write", ids: ["alice"] }]);
  assert.deepStrictEqual(run("cursor", { mcp_server_name: "basic-memory", tool_name: "search_notes", tool_input: "{\"query\":\"q\"}", result_json: "{\"r\":\"memory://people/bob\"}" }, "afterMCPExecution"), [{ type: "search", ids: ["bob"] }]);
});

test("windsurf: post_read_code / post_write_code / post_mcp_tool_use", () => {
  assert.deepStrictEqual(run("windsurf", { agent_action_name: "post_read_code", tool_info: { file_path: note("alice") } }), [{ type: "read", ids: ["alice"] }]);
  assert.deepStrictEqual(run("windsurf", { agent_action_name: "post_write_code", tool_info: { file_path: note("alice"), edits: [] } }), [{ type: "write", ids: ["alice"] }]);
  assert.deepStrictEqual(run("windsurf", { agent_action_name: "post_mcp_tool_use", tool_info: { mcp_server_name: "obsidian", mcp_tool_name: "read_note", mcp_tool_arguments: { path: "people/bob.md" } } }), [{ type: "read", ids: ["bob"] }]);
});

test("copilot: view / edit / MCP", () => {
  assert.deepStrictEqual(run("copilot", { toolName: "view", toolArgs: { path: note("alice") } }), [{ type: "read", ids: ["alice"] }]);
  assert.deepStrictEqual(run("copilot", { toolName: "edit", toolArgs: JSON.stringify({ path: note("bob") }) }), [{ type: "write", ids: ["bob"] }]);
  assert.deepStrictEqual(run("copilot", { toolName: "basic-memory-read_note", toolArgs: { identifier: "carol" } }), [{ type: "read", ids: ["carol"] }]);
  assert.deepStrictEqual(run("copilot", { toolName: "bash", toolArgs: { command: "cat x" } }), []);
});

test("cline: use_mcp_tool and file tools", () => {
  assert.deepStrictEqual(run("cline", { postToolUse: { tool: "use_mcp_tool", parameters: { server_name: "basic-memory", tool_name: "write_note", arguments: { title: "dave" } } } }), [{ type: "write", ids: ["dave"] }]);
  assert.deepStrictEqual(run("cline", { workspaceRoots: [NOTES], postToolUse: { toolName: "read_file", parameters: { path: "people/alice.md" } } }), [{ type: "read", ids: ["alice"] }]);
});

test("every parser survives junk", () => {
  for (const a of AGENTS) for (const junk of [null, 1, "x", {}, { tool_input: 5, toolArgs: "{", tool_info: [] }]) assert.deepStrictEqual(parse(a, junk, "afterFileEdit"), []);
});

// End to end: the real hook script, a fake memglow receiver, the agent's expected stdout.
function receiver() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { got.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(b) }); res.end("{}"); });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}
function hook(agent, payload, args, env) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "adapters", agent, "hook.js"), ...args], { env: { ...process.env, ...env } });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => ok({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

test("hook scripts: expected stdout, exit 0, one POST with ids only", async () => {
  const { srv, got, url } = await receiver();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-home-"));
  const env = { MEMGLOW_URL: url, MEMGLOW_TOKEN: "k".repeat(40), MEMGLOW_HOME: home, MEMGLOW_MEMORY_DIR: NOTES, MEMGLOW_MACHINE: "ci-runner" };
  try {
    const g = await hook("gemini", { tool_name: "read_file", tool_input: { absolute_path: note("alice") } }, [], env);
    assert.deepStrictEqual([g.code, g.out], [0, "{}"]);
    const c = await hook("cursor", { file_path: note("bob"), content: "private text" }, ["beforeReadFile"], env);
    assert.deepStrictEqual([c.code, JSON.parse(c.out)], [0, { permission: "allow" }]);
    const k = await hook("cline", { postToolUse: { tool: "use_mcp_tool", parameters: { server_name: "memory", tool_name: "read_note", arguments: { identifier: "carol" } } } }, [], env);
    assert.deepStrictEqual([k.code, JSON.parse(k.out)], [0, { cancel: false }]);
    const x = await hook("claude-code", { tool_name: "Bash", tool_input: {} }, [], env);
    assert.deepStrictEqual([x.code, x.out], [0, ""]);
    await waitFor(() => got.length >= 3);
    assert.strictEqual(got.length, 3);
    for (const r of got) {
      assert.strictEqual(r.url, "/api/activity");
      assert.strictEqual(r.auth, "Bearer " + "k".repeat(40));
      assert.deepStrictEqual(Object.keys(r.body).sort(), ["channel", "ids", "machine", "source", "type"]);
      assert.strictEqual(r.body.channel, "hook", "every bundled adapter reports over the hook channel");
      assert.strictEqual(r.body.machine, "ci-runner");
    }
    assert.deepStrictEqual(got.map((r) => r.body.ids[0]).sort(), ["alice", "bob", "carol"]);
    assert.ok(!JSON.stringify(got).includes("private text"));
  } finally { srv.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("hook scripts: memglow down or no token → still silent, exit 0", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-home-"));
  try {
    const r = await hook("claude-code", { tool_name: "Read", tool_input: { file_path: note("a") } }, [],
      { MEMGLOW_URL: "http://127.0.0.1:9", MEMGLOW_TOKEN: "k".repeat(40), MEMGLOW_HOME: home, MEMGLOW_MEMORY_DIR: NOTES });
    assert.deepStrictEqual([r.code, r.out], [0, ""]);
    const n = await hook("gemini", { junk: true }, [], { MEMGLOW_HOME: home, MEMGLOW_TOKEN: "" });
    assert.deepStrictEqual([n.code, n.out], [0, "{}"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
