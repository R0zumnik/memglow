#!/usr/bin/env node
"use strict";
/**
 * memglow memory server — compatibility + speed harness (stage 0.4.5.1, "shadow" comparison).
 *
 * Runs the same MCP tool calls against two servers — A (the reference, e.g. basic-memory) and B
 * (e.g. the memglow memory server) — and reports, per call: latency A / B, whether a read's text
 * is identical, search overlap@k (permalinks found by both), and a structural diff of the text
 * shape (which kinds of lines — headings, "- permalink:" rows, footers… — appear on one side only).
 * Read-only by construction: only read tools should be listed (write tools are refused here).
 *
 *   node bench/compat.js --a http://basic-memory:8000/mcp --b http://127.0.0.1:8001/mcp \
 *        --calls bench/compat-calls.example.json [--k 10] [--mode modern|legacy] [--parallel]
 *        [--timeout-ms 300000] [--json out.json]
 *
 * Calls file: a JSON array of { "label"?: string, "tool": string, "arguments": object }.
 * The committed example uses demo data only; a run on the owner's real notes is an operator's job
 * (its output may quote private note text: keep it out of the repository).
 *
 * Protocol: `--mode modern` (default) sends MCP 2026-07-28 per-request calls (header + _meta, no
 * initialize); `--mode legacy` opens one 2025-06-18 session per server first. JSON or SSE answers
 * are both read. Zero dependencies.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const WRITE_TOOLS = new Set(["write_note", "edit_note", "move_note", "delete_note", "create_memory_project", "delete_project"]);
const SEARCH_TOOLS = new Set(["search_notes", "search"]);
const READ_TOOLS = new Set(["read_note", "read_content", "view_note", "fetch"]);
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

function parseArgs(argv) {
  const o = { a: "", b: "", calls: path.join(__dirname, "compat-calls.example.json"), k: 10, mode: "modern", parallel: false, timeoutMs: 300000, json: "" };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--a") o.a = argv[++i];
    else if (x === "--b") o.b = argv[++i];
    else if (x === "--calls") o.calls = argv[++i];
    else if (x === "--k") o.k = Math.max(1, Number(argv[++i]) || 10);
    else if (x === "--mode") o.mode = argv[++i] === "legacy" ? "legacy" : "modern";
    else if (x === "--parallel") o.parallel = true;
    else if (x === "--timeout-ms") o.timeoutMs = Number(argv[++i]) || 300000;
    else if (x === "--json") o.json = argv[++i];
    else if (x === "-h" || x === "--help") o.help = true;
  }
  return o;
}

/** One JSON-RPC POST; resolves { status, headers, message, ms } (message from JSON or SSE). */
function post(url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const t0 = process.hrtime.bigint();
    const req = lib.request(u, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(data.length), ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const text = Buffer.concat(parts).toString("utf8");
        let message = null;
        if (String(res.headers["content-type"] || "").includes("text/event-stream")) {
          for (const block of text.split(/\r?\n\r?\n/)) {
            const d = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
            if (!d) continue;
            try { const m = JSON.parse(d); if (m && m.id === body.id) { message = m; break; } } catch { /* keep looking */ }
          }
        } else { try { message = JSON.parse(text); } catch { message = null; } }
        resolve({ status: res.statusCode, headers: res.headers, message, ms, raw: message ? null : text.slice(0, 300) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", (e) => resolve({ status: 0, headers: {}, message: null, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.message }));
    req.end(data);
  });
}

/** A client for one server: `call(tool, args)` → { text, isError, ms, error }. */
async function client(url, mode, timeoutMs) {
  let n = 0, session = null;
  const headers = (tool) => (mode === "modern" ? { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": tool } : session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" } : {});
  if (mode === "legacy") {
    const r = await post(url, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "memglow-compat", version: "1" } } }, {}, timeoutMs);
    session = r.headers["mcp-session-id"] || null;
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, session ? { "mcp-session-id": session } : {}, timeoutMs);
  }
  return {
    async call(tool, args) {
      const id = ++n;
      const params = { name: tool, arguments: args || {} };
      if (mode === "modern") params._meta = META;
      const r = await post(url, { jsonrpc: "2.0", id, method: "tools/call", params }, headers(tool), timeoutMs);
      if (!r.message) return { text: "", isError: true, ms: r.ms, error: r.error || `HTTP ${r.status}: ${r.raw || "no JSON-RPC answer"}` };
      if (r.message.error) return { text: "", isError: true, ms: r.ms, error: `JSON-RPC ${r.message.error.code}: ${r.message.error.message}` };
      const res = r.message.result || {};
      const text = (res.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!res.isError, ms: r.ms };
    },
  };
}

/** Permalinks a search answer lists, in order (text "- permalink:" rows, or JSON results). */
function permalinksOf(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const list = Array.isArray(j.results) ? j.results : [];
      return list.map((r) => r.permalink || r.id || r.url).filter(Boolean);
    } catch { /* fall through to text */ }
  }
  const out = [];
  for (const m of t.matchAll(/^- permalink: (\S+)\s*$/gm)) out.push(m[1]);
  return out;
}

/** The kinds of lines a text is made of: "# ", "### ", "- permalink: ", "---", "*…*", "blank", "text"… */
function shapeOf(text) {
  const kinds = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    let k;
    if (!line.trim()) k = "blank";
    else if (/^#{1,6} /.test(line)) k = line.match(/^#{1,6} /)[0] + (line.match(/^#{1,6} ([A-Za-z][A-Za-z ]{0,30}?)[:(]/) || ["", ""])[1];
    else if (/^-{3,}\s*$/.test(line)) k = "---";
    else if (/^- ([a-z_]+): /.test(line)) k = "- " + line.match(/^- ([a-z_]+): /)[1] + ":";
    else if (/^- \*\*[^*]+\*\*:/.test(line)) k = "- **" + line.match(/^- \*\*([^*]+)\*\*:/)[1] + "**:";
    else if (/^[a-z_]+: /.test(line)) k = line.match(/^([a-z_]+): /)[1] + ":";
    else if (/^\*[^*].*\*$/.test(line)) k = "*italic line*";
    else if (/^\s*[•📄📁🔍🔗]/u.test(line)) k = "bullet " + [...line.trim()][0];
    else continue; // free text: content, not shape
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  return kinds;
}

function shapeDiff(a, b) {
  const A = shapeOf(a), B = shapeOf(b);
  const onlyA = [...A.keys()].filter((k) => !B.has(k));
  const onlyB = [...B.keys()].filter((k) => !A.has(k));
  return { same: !onlyA.length && !onlyB.length, onlyA, onlyB };
}

function firstDifference(a, b) {
  const la = String(a).split("\n"), lb = String(b).split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return { line: i + 1, a: (la[i] || "").slice(0, 120), b: (lb[i] || "").slice(0, 120) };
  return null;
}

/** compare({ a, b, calls, k, mode, parallel, timeoutMs }) → { rows, summary }. */
async function compare({ a, b, calls, k = 10, mode = "modern", parallel = false, timeoutMs = 300000, log = () => {} }) {
  const ca = await client(a, mode, timeoutMs), cb = await client(b, mode, timeoutMs);
  const rows = [];
  for (const [i, c] of calls.entries()) {
    const tool = c.tool, args = c.arguments || {};
    const label = c.label || `${tool} ${JSON.stringify(args).slice(0, 60)}`;
    if (WRITE_TOOLS.has(tool)) { rows.push({ label, tool, skipped: "write tool: never sent by this harness" }); continue; }
    const [ra, rb] = parallel ? await Promise.all([ca.call(tool, args), cb.call(tool, args)]) : [await ca.call(tool, args), await cb.call(tool, args)];
    const row = { label, tool, msA: Math.round(ra.ms), msB: Math.round(rb.ms), errorA: ra.error || (ra.isError ? ra.text.slice(0, 200) : null), errorB: rb.error || (rb.isError ? rb.text.slice(0, 200) : null) };
    if (READ_TOOLS.has(tool)) {
      row.identical = ra.text === rb.text;
      if (!row.identical) row.firstDifference = firstDifference(ra.text, rb.text);
    }
    if (SEARCH_TOOLS.has(tool)) {
      const pa = permalinksOf(ra.text).slice(0, k), pb = permalinksOf(rb.text).slice(0, k);
      const inter = pa.filter((p) => pb.includes(p));
      row.overlap = pa.length ? +(inter.length / Math.min(k, pa.length)).toFixed(3) : (pb.length ? 0 : 1);
      row.top1Same = !!pa.length && pa[0] === pb[0];
      row.onlyA = pa.filter((p) => !pb.includes(p));
      row.onlyB = pb.filter((p) => !pa.includes(p));
    }
    row.shape = shapeDiff(ra.text, rb.text);
    rows.push(row);
    log(row, i);
  }
  const done = rows.filter((r) => !r.skipped);
  const med = (xs) => { const s = xs.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const searches = done.filter((r) => SEARCH_TOOLS.has(r.tool));
  const reads = done.filter((r) => READ_TOOLS.has(r.tool));
  const summary = {
    calls: done.length,
    medianMsA: med(done.map((r) => r.msA)), medianMsB: med(done.map((r) => r.msB)),
    totalMsA: done.reduce((s, r) => s + r.msA, 0), totalMsB: done.reduce((s, r) => s + r.msB, 0),
    readsIdentical: `${reads.filter((r) => r.identical).length}/${reads.length}`,
    meanOverlap: searches.length ? +(searches.reduce((s, r) => s + r.overlap, 0) / searches.length).toFixed(3) : null,
    top1Same: `${searches.filter((r) => r.top1Same).length}/${searches.length}`,
    sameShape: `${done.filter((r) => r.shape.same).length}/${done.length}`,
    errorsA: done.filter((r) => r.errorA).length, errorsB: done.filter((r) => r.errorB).length,
  };
  return { rows, summary };
}

function printRow(r) {
  if (r.skipped) { process.stdout.write(`- ${r.label}: skipped (${r.skipped})\n`); return; }
  const parts = [`A ${r.msA} ms / B ${r.msB} ms`];
  if ("identical" in r) parts.push(r.identical ? "identical" : `DIFFERENT (line ${r.firstDifference && r.firstDifference.line})`);
  if ("overlap" in r) parts.push(`overlap@k ${r.overlap}${r.top1Same ? ", same top hit" : ""}`);
  parts.push(r.shape.same ? "same shape" : `shape: A-only [${r.shape.onlyA.join(" | ")}] B-only [${r.shape.onlyB.join(" | ")}]`);
  if (r.errorA) parts.push(`A error: ${r.errorA}`);
  if (r.errorB) parts.push(`B error: ${r.errorB}`);
  process.stdout.write(`- ${r.label}: ${parts.join(" · ")}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help || !o.a || !o.b) {
    process.stdout.write("usage: node bench/compat.js --a URL --b URL [--calls file.json] [--k 10] [--mode modern|legacy] [--parallel] [--timeout-ms N] [--json out.json]\n");
    return o.help ? 0 : 2;
  }
  const calls = JSON.parse(fs.readFileSync(o.calls, "utf8"));
  if (!Array.isArray(calls)) throw new Error("the calls file must hold a JSON array");
  process.stdout.write(`compat: A = ${o.a}\n        B = ${o.b}\n        ${calls.length} calls, mode ${o.mode}${o.parallel ? ", A and B in parallel" : ""}\n\n`);
  const r = await compare({ ...o, calls, log: printRow });
  process.stdout.write("\nsummary: " + JSON.stringify(r.summary) + "\n");
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(r, null, 2));
  return 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write("compat: " + e.message + "\n"); process.exitCode = 1; });

module.exports = { compare, permalinksOf, shapeOf, shapeDiff, parseArgs };
