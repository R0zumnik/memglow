"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

process.env.MEMGLOW_MEMORY_DIR = "/tmp/memglow-hook-notes";
const { analyse } = require("../hooks/memglow-activity");

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
