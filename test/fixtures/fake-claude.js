#!/usr/bin/env node
"use strict";
// Fake `claude` CLI for the assistant tests — never the real one. It imitates `claude -p
// --output-format stream-json`: it reads the prompt on stdin, logs its argv and stdin next to
// itself, and answers with a proposal built from the <note> of the prompt. The behaviour is read
// from the file "mode" next to it: split (valid), traversal, overwrite, lose, theme, badjson, huge,
// tool, slow, fail.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
// Loaded by `node --test` (it runs every .js under test/): not a call from memglow, do nothing.
if (!process.argv.includes("-p") && !process.argv.includes("--help")) process.exit(0);
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\n  -p, --print\n  --restricted\n  --tools <tools...>\n  --output-format <format> (text, json, stream-json)\n  --include-partial-messages\n  --permission-mode <mode> (dontAsk)\n  --no-session-persistence\n  --system-prompt <prompt>\n  --strict-mcp-config\n  --disallowedTools <tools...>\n");
  process.exit(0);
}
const mode = (() => { try { return fs.readFileSync(path.join(dir, "mode"), "utf8").trim(); } catch { return "split"; } })();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv: process.argv.slice(2), stdin: input, cwd: process.cwd() }) + "\n");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (mode === "fail") { process.stderr.write("Not logged in\n"); process.exit(1); }
  if (mode === "slow") { setTimeout(() => {}, 60000); return; }
  // Regroup requests (lib/assistant/regroup.js): modes regroup-theme, regroup-foreign, regroup-move.
  if (/^Regroup these notes/m.test(input)) {
    const target = /Suggested sub-theme: ([a-z0-9-]+)\./.exec(input)[1];
    const notes = [...input.matchAll(/^- id: (\S+) \| title: .*? \| sub-theme: (\S+) \| folder: ("[^"]*")/gm)].map((x) => ({ id: x[1], sub: x[2], folder: JSON.parse(x[3]) }));
    const folders = (/Folders of this group \(for the optional "folder"\): (.*)\.$/m.exec(input) || [])[1] || "";
    const r = { subtheme: target, moves: notes.filter((n) => n.sub !== target).map((n) => ({ note: n.id })), notes: "Grouped." };
    if (mode === "regroup-theme") r.theme = "people";
    if (mode === "regroup-foreign") r.moves.push({ note: "outsider-note" });
    if (mode === "regroup-move") {
      const list = folders === "none" ? [] : JSON.parse("[" + folders + "]");
      const mv = r.moves[0];
      const n = notes.find((x) => x.id === mv.note);
      mv.folder = list.find((f) => f !== n.folder);
    }
    const t = JSON.stringify(r);
    out({ type: "result", subtype: "success", is_error: false, result: t });
    return;
  }
  // Archive review (lib/archive.js): archive the first listed section, keep the second.
  if (input.includes("<sections>")) {
    const ids = [...input.matchAll(/^\[(s\d+)\]/gm)].map((x) => x[1]);
    const answer = mode === "archive-bad" ? { archive: ["s99"], notes: "?" } : { archive: ids.slice(0, 1), keep: ids.slice(1, 2).map((id) => ({ id, why: "A durable rule." })), notes: "Archived the old plan." };
    out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer) });
    return;
  }
  const m = /<note>\n([\s\S]*?)\n<\/note>/.exec(input);
  const id = /Note id: (\S+)/.exec(input)[1];
  const body = m ? m[1] : "";
  // Sections: lines before the first "## " go with the first part.
  const lines = body.split("\n");
  const cut = lines.findIndex((l, i) => i > 0 && /^## /.test(l) && lines.slice(0, i).some((x) => /^## /.test(x)));
  const a = lines.slice(0, cut > 0 ? cut : Math.ceil(lines.length / 2)).join("\n");
  const b = lines.slice(cut > 0 ? cut : Math.ceil(lines.length / 2)).join("\n");
  const p = {
    summary: `Short summary of ${id}.\n\n- [[${id}-part-1]]\n- [[${id}-part-2]]`,
    parts: [
      { title: "Part 1", file: `${id}-part-1.md`, content: a },
      { title: "Part 2", file: `${id}-part-2.md`, content: b },
    ],
    linkUpdates: /<linking-lines>\nlinker: /.test(input) ? [{ note: "linker", from: `[[${id}]]`, to: `[[${id}-part-2]]` }] : [],
    notes: "Split in two.",
  };
  if (mode === "traversal") p.parts[0].file = "../evil.md";
  if (mode === "overwrite") p.parts[0].file = "linker.md";
  if (mode === "lose") for (const x of p.parts) x.content = x.content.split("\n").filter((l) => !/Keep this line/.test(l)).join("\n");
  if (mode === "theme") p.parts[0].content = "---\ntheme: other\n---\n" + a;
  let text = JSON.stringify(p);
  if (mode === "badjson") text = "Here is my plan: split it in two (no JSON, sorry)";
  if (mode === "huge") text = "x".repeat(5 * 1024 * 1024);
  if (mode === "tool") out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/x" } }] } });
  // Live deltas, then the final result (like --include-partial-messages).
  for (let i = 0; i < text.length && i < 200000; i += 50) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + 50) } } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
});
