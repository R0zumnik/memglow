#!/usr/bin/env node
"use strict";
/**
 * memglow memory server — speed measurement over a notes folder (stage 0.4.5.1). Read-only.
 *
 *   node bench/memory-server-speed.js --root path/to/knowledge [--n 50] [--json]
 *
 * Starts the server in-process on a random local port, then measures over real HTTP (MCP
 * 2026-07-28 per-request calls): startup (scan + index), `--n` varied searches and `--n` reads
 * (median, p95, max), 20 searches fired at once (wall time), and memory use. Queries are derived
 * from the notes themselves (title words, body words, a phrase, NOT, title / permalink search
 * types) — the report prints numbers only, never note text.
 */
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");
const { words, STOP_WORDS } = require("../lib/store/text");

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

function args(argv) {
  const o = { root: "", n: 50, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") o.root = argv[++i];
    else if (argv[i] === "--n") o.n = Math.max(5, Number(argv[++i]) || 50);
    else if (argv[i] === "--json") o.json = true;
  }
  return o;
}

const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const r2 = (x) => Math.round(x * 100) / 100;
const stats = (xs) => ({ n: xs.length, median: r2(pct(xs, 50)), p95: r2(pct(xs, 95)), max: r2(Math.max(...xs)) });

/** Deterministic, varied queries built from the notes' own words. */
function queriesFrom(notes, n) {
  const good = (w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w);
  const out = [];
  for (let i = 0; out.length < n && notes.length; i++) {
    const note = notes[(i * 7919) % notes.length];
    const tw = words(note.title).filter(good);
    const bw = words(note.body.slice(0, 4000)).filter(good);
    const pick = (list, k) => list.length ? list[(i * 31 + k * 17) % list.length] : null;
    switch (i % 8) {
      case 0: out.push({ query: tw.slice(0, 2).join(" ") || pick(bw, 0) }); break;
      case 1: out.push({ query: [pick(bw, 1), pick(bw, 2)].filter(Boolean).join(" ") }); break;
      case 2: out.push({ query: [pick(bw, 3), pick(bw, 4), pick(bw, 5)].filter(Boolean).join(" ") }); break;
      case 3: { const s = words(note.body.slice(0, 2000)).filter((w) => w.length > 2); const j = s.length > 3 ? (i * 13) % (s.length - 2) : 0; out.push({ query: s.length > 2 ? `"${s[j]} ${s[j + 1]}"` : note.title }); break; }
      case 4: out.push({ query: `${pick(bw, 6) || note.title} -${pick(bw, 7) || "zzz"}` }); break;
      case 5: out.push({ query: note.title, search_type: "title" }); break;
      case 6: out.push({ query: note.permalink.split("/").slice(0, -1).join("/") + "/*", search_type: "permalink" }); break;
      default: out.push({ query: (pick(bw, 8) || "note").slice(0, 4) }); // a prefix
    }
  }
  return out.map((q) => ({ ...q, query: q.query || "memory" }));
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.root) { process.stderr.write("usage: node bench/memory-server-speed.js --root DIR [--n 50] [--json]\n"); process.exit(2); }
  const rssBefore = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  const srv = createMemoryServer({ root: path.resolve(o.root), watch: true, pollMs: 3000 });
  const startupMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let id = 0;
  const call = async (name, a) => {
    const t = process.hrtime.bigint();
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: a, _meta: META } }) });
    const j = await r.json();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (!j.result || j.result.isError) throw new Error(`${name} failed: ${JSON.stringify(j).slice(0, 200)}`);
    return { ms, text: j.result.content[0].text };
  };
  const notes = srv.store.notes();
  await call("list_memory_projects", {}); // warm the HTTP path
  const queries = queriesFrom(notes, o.n);
  const searchMs = [];
  let hits = 0;
  for (const q of queries) { const r = await call("search_notes", q); searchMs.push(r.ms); if (r.text.startsWith("# Search Results")) hits++; }
  const readMs = [];
  for (let i = 0; i < o.n; i++) {
    const n = notes[(i * 104729) % notes.length];
    const ident = i % 3 === 0 ? n.title : i % 3 === 1 ? n.permalink : "memory://" + n.permalink;
    readMs.push((await call("read_note", { identifier: ident })).ms);
  }
  const otherMs = {};
  for (const [name, a] of [["recent_activity", {}], ["build_context", { url: "memory://" + notes[0].permalink, depth: 2 }], ["list_directory", { dir_name: "/", depth: 3 }]]) otherMs[name] = r2((await call(name, a)).ms);
  const tp = process.hrtime.bigint();
  await Promise.all(queries.slice(0, 20).map((q) => call("search_notes", q)));
  const parallel20Ms = Number(process.hrtime.bigint() - tp) / 1e6;
  const mem = process.memoryUsage();
  const report = {
    root: o.root.replace(/^.*\/(?=[^/]+\/?$)/, "…/"),
    notes: notes.length,
    startupMs: r2(startupMs),
    firstScanMs: srv.store.stats().firstScanMs,
    search: { ...stats(searchMs), withHits: `${hits}/${queries.length}` },
    read: stats(readMs),
    other: otherMs,
    parallel20SearchesWallMs: r2(parallel20Ms),
    memory: { rssMB: r2(mem.rss / 1048576), heapUsedMB: r2(mem.heapUsed / 1048576), rssGrowthMB: r2((mem.rss - rssBefore) / 1048576) },
    node: process.version,
  };
  process.stdout.write(o.json ? JSON.stringify(report) + "\n" : JSON.stringify(report, null, 2) + "\n");
  server.closeAllConnections(); server.close(); srv.close();
}

if (require.main === module) main().catch((e) => { process.stderr.write("speed: " + e.message + "\n"); process.exit(1); });

module.exports = { queriesFrom };
