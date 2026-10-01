"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

process.env.MEMGLOW_MEMORY_DIR = "/tmp/memglow-hook-notes";
const { analyse, machineName } = require("../hooks/memglow-activity");

test("MCP tools map to read / search / write", () => {
  assert.deepStrictEqual(analyse({ tool_name: "mcp__basic-memory__read_note", tool_input: { identifier: "project-x" } }).type, "read");
  assert.deepStrictEqual(analyse({ tool_name: "mcp__basic-memory__write_note", tool_input: { title: "a" } }).type, "write");
  const s = analyse({ tool_name: "mcp__basic-memory__search_notes", tool_input: { query: "x" }, tool_response: "### a\n- permalink: main/memory/projects/project-a\n" });
  assert.strictEqual(s.type, "search");
  assert.ok(s.ids.some((i) => i.endsWith("project-a")));
  assert.strictEqual(analyse({ tool_name: "mcp__basic-memory__list_directory", tool_input: {} }), null);
});

test("file tools count only inside MEMGLOW_MEMORY_DIR and only for .md", () => {
  const inside = path.join("/tmp/memglow-hook-notes", "projects", "a.md");
  assert.strictEqual(analyse({ tool_name: "Read", tool_input: { file_path: inside } }).type, "read");
  assert.strictEqual(analyse({ tool_name: "Edit", tool_input: { file_path: inside } }).type, "write");
  assert.strictEqual(analyse({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }), null);
  assert.strictEqual(analyse({ tool_name: "Read", tool_input: { file_path: "/tmp/memglow-hook-notes/x.txt" } }), null);
  assert.strictEqual(analyse({ tool_name: "Bash", tool_input: { command: "cat x.md" } }), null);
});

test("machineName: MEMGLOW_MACHINE, else the short hostname, sanitized, never a path or empty", () => {
  const saved = process.env.MEMGLOW_MACHINE;
  try {
    process.env.MEMGLOW_MACHINE = "laptop-2";
    assert.strictEqual(machineName(), "laptop-2");
    process.env.MEMGLOW_MACHINE = "../etc/passwd";
    assert.strictEqual(machineName(), "etc-passwd");
    delete process.env.MEMGLOW_MACHINE;
    assert.match(machineName(), /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "falls back to a sanitized short hostname");
  } finally {
    if (saved === undefined) delete process.env.MEMGLOW_MACHINE; else process.env.MEMGLOW_MACHINE = saved;
  }
});

test("end to end: the hook script sends channel \"hook\" and this machine's label", async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { got.push(JSON.parse(b)); res.end("{}"); });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-hooknotes-"));
  fs.mkdirSync(path.join(notes, "people"), { recursive: true });
  fs.writeFileSync(path.join(notes, "people", "alice.md"), "x");
  const url = `http://127.0.0.1:${srv.address().port}`;
  const env = { ...process.env, MEMGLOW_URL: url, MEMGLOW_TOKEN: "h".repeat(40), MEMGLOW_MEMORY_DIR: notes, MEMGLOW_MACHINE: "ci-runner" };
  try {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "hooks", "memglow-activity.js")], { env });
    p.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(notes, "people", "alice.md") } }));
    await new Promise((ok) => p.on("exit", ok));
    const t = Date.now();
    while (!got.length && Date.now() - t < 4000) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(got[0], { type: "read", ids: ["alice"], source: "claude", channel: "hook", machine: "ci-runner" });
  } finally { srv.close(); fs.rmSync(notes, { recursive: true, force: true }); }
});
