"use strict";
// A fake basic-memory-like stdio MCP server for the proxy lever tests. Notes are read from
// FAKE_NOTES_DIR (write_note / edit_note write there: that is the UPSTREAM server writing, never
// the proxy). Arguments received for each call are appended to FAKE_ARGS_LOG (outside the notes).
// `node --test` also runs every .js under test/: do nothing unless started by the proxy tests.
if (!process.env.MEMGLOW_FAKE_MCP) process.exit(0);
const fs = require("fs");
const path = require("path");
const DIR = process.env.FAKE_NOTES_DIR;
const LOG = process.env.FAKE_ARGS_LOG;

const strict = (props, required) => ({ type: "object", properties: props, required, additionalProperties: false });
const TOOLS = [
  { name: "read_note", description: "Read a note", inputSchema: strict({ identifier: { type: "string" }, page: { type: "integer" } }, ["identifier"]) },
  { name: "build_context", description: "Context", inputSchema: strict({ url: { type: "string" } }, ["url"]) },
  { name: "search_notes", description: "Search", inputSchema: strict({ query: { type: "string" } }, []) },
  { name: "write_note", description: "Write", inputSchema: strict({ title: { type: "string" }, content: { type: "string" }, directory: { type: "string" } }, ["title", "content", "directory"]) },
  { name: "edit_note", description: "Edit", inputSchema: strict({ identifier: { type: "string" }, operation: { type: "string" }, content: { type: "string" } }, ["identifier", "operation", "content"]) },
  { name: "list_directory", description: "List", inputSchema: strict({ dir_name: { type: "string" } }, []) },
  // Like real basic-memory: always listed, but it answers "Unsupported MCP client" itself to any
  // caller that is not its OpenAI/ChatGPT adapter — the proxy's hideUnsupportedTools lever is what
  // keeps OTHER clients from ever seeing them in tools/list, not this fixture.
  { name: "search", description: "ChatGPT-compatible search", inputSchema: strict({ query: { type: "string" } }, ["query"]) },
  { name: "fetch", description: "ChatGPT-compatible fetch", inputSchema: strict({ id: { type: "string" } }, ["id"]) },
];

function find(identifier) {
  const id = String(identifier || "").replace(/^memory:\/\//, "").split("/").pop();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  return walk(DIR).find((f) => path.basename(f, ".md") === id) || null;
}
// FAKE_WRAP=1: like basic-memory on FastMCP (`wrap_result`), every text answer also carries
// structuredContent { result: <the same text> } — which is what Claude Code shows the model.
const text = (t) => (process.env.FAKE_WRAP ? { content: [{ type: "text", text: t }], structuredContent: { result: t } } : { content: [{ type: "text", text: t }] });

function call(name, args) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ name, args }) + "\n");
  if (name === "boom") return { error: { code: -32001, message: "upstream exploded" } };
  if (name === "read_note" || name === "build_context") {
    const f = find(args.identifier || args.url);
    if (!f) return { result: { content: [{ type: "text", text: `Note not found: ${args.identifier}` }], isError: true } };
    const rel = path.relative(DIR, f).replace(/\.md$/, "");
    return { result: text(fs.readFileSync(f, "utf8").replace(/^---\n/, `---\npermalink: ${rel}\n`)) };
  }
  if (name === "structured_read") {
    const f = find(args.identifier);
    const t = fs.readFileSync(f, "utf8");
    return { result: { content: [{ type: "text", text: t }], structuredContent: { content: t } } };
  }
  if (name === "search_notes") {
    const q = String(args.query || "").toLowerCase();
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const hits = walk(DIR).filter((f) => fs.readFileSync(f, "utf8").toLowerCase().includes(q));
    return { result: text(hits.map((f) => `### ${path.basename(f, ".md")}\npermalink: ${path.relative(DIR, f).replace(/\.md$/, "")}\nsnippet: ${fs.readFileSync(f, "utf8").trim().split("\n").slice(-1)[0]}`).join("\n\n") || "No results") };
  }
  if (name === "write_note") {
    const d = path.join(DIR, args.directory || "");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, args.title + ".md"), args.content);
    return { result: text(`# Created note\npermalink: ${(args.directory ? args.directory + "/" : "") + args.title}`) };
  }
  if (name === "edit_note") {
    const f = find(args.identifier);
    fs.appendFileSync(f, args.content);
    return { result: text(`# Edited note (${args.operation})\npermalink: ${path.relative(DIR, f).replace(/\.md$/, "")}`) };
  }
  if (name === "list_directory") return { result: text("people/alice.md\nprojects/big.md") };
  if (name === "search" || name === "fetch") return { result: text(`${name}-called:${JSON.stringify(args)}`) };
  return { error: { code: -32601, message: "unknown tool " + name } };
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "quit") process.exit(3);
    let out;
    if (m.method === "tools/list") out = { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
    else if (m.method === "tools/call") out = { jsonrpc: "2.0", id: m.id, ...call(m.params.name, m.params.arguments || {}) };
    else if (m.id != null) {
      var result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
      // FAKE_INSTRUCTIONS=1: this upstream server already has its own `instructions` (so proxy
      // tests can check memglow's rules are appended, not replacing them).
      if (m.method === "initialize" && process.env.FAKE_INSTRUCTIONS) result.instructions = process.env.FAKE_INSTRUCTIONS;
      out = { jsonrpc: "2.0", id: m.id, result: result };
    }
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
