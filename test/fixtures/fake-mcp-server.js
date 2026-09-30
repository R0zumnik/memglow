"use strict";
// A tiny stdio MCP-like server for the proxy tests: answers tools/call with a canned result,
// errors on tool "boom", echoes a notification, and exits with code 7 on "quit".
// `node --test` also runs every .js under test/: do nothing unless started by the proxy tests.
if (!process.env.MEMGLOW_FAKE_MCP) process.exit(0);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.method === "quit") process.exit(7);
    if (m.method === "tools/call") {
      const out = m.params.name === "boom"
        ? { jsonrpc: "2.0", id: m.id, error: { code: -1, message: "nope" } }
        : { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "see memory://people/alice — secret body text" }] } };
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (m.id != null) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true, ünïcode: "✓" } }) + "\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
