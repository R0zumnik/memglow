#!/usr/bin/env node
"use strict";
/**
 * memglow memory server — all-in-one (--levers) vs "memglow-mcp-proxy → memory server", latency
 * of search, multiQuery search, read and write over real local HTTP (stage 0.4.8.1).
 *
 *   node bench/all-in-one-speed.js [--notes 200] [--n 60] [--json]
 *
 * Generates a synthetic notes folder (<tmp>/memory/…, --notes notes), copies it twice, starts both
 * set-ups in this process with the DEFAULT lever settings (isolated data folders), opens one legacy
 * session on each, and alternates calls between the two (so machine load hits both alike).
 * Prints median / p95 in ms. Nothing outside the temp folders is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createHttpProxy, setupLevers, setupRules } = require("../mcp-proxy/memglow-mcp-proxy");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { createHttpServer } = require("../memory-server/http");

function args(argv) {
  const o = { notes: 200, n: 60, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--notes") o.notes = Math.max(10, Number(argv[++i]) || 200);
    else if (argv[i] === "--n") o.n = Math.max(5, Number(argv[++i]) || 60);
    else if (argv[i] === "--json") o.json = true;
  }
  return o;
}

const WORDS = "garden tomato rugby stade wifi router kayak paddle recipe bread school holiday budget invoice doctor dentist car garage piano lesson train ticket museum book novel film series server backup photo album".split(" ");
const pick = (i, k) => WORDS[(i * 7 + k * 13) % WORDS.length];

function makeNotes(dir, count) {
  for (let i = 0; i < count; i++) {
    const folder = ["people", "projects", "notes", "home"][i % 4];
    const id = `note-${i}`;
    const body = [`---`, `title: ${pick(i, 0)} ${pick(i, 1)} ${i}`, `type: note`, `---`, ``, `# ${pick(i, 2)} ${pick(i, 3)}`, ``]
      .concat(Array.from({ length: 10 + (i % 30) }, (_, l) => `- ${pick(i, l)} ${pick(i + l, 4)} ${pick(l, 5)} line ${l} [[note-${(i + l + 1) % count}]]`)).join("\n") + "\n";
    fs.mkdirSync(path.join(dir, "memory", folder), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", folder, id + ".md"), body);
  }
}

function post(url, agent, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const t0 = process.hrtime.bigint();
    const req = http.request(url, { method: "POST", agent, headers: { "content-type": "application/json", accept: "application/json", "content-length": data.length, ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, headers: res.headers, text: Buffer.concat(parts).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };

async function main() {
  const o = args(process.argv.slice(2));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-aio-bench-"));
  const src = path.join(base, "src");
  makeNotes(src, o.notes);
  const roots = { proxy: path.join(base, "a"), aio: path.join(base, "b") };
  for (const r of Object.values(roots)) fs.cpSync(src, r, { recursive: true });
  const envOf = (k) => ({ MEMGLOW_HOME: path.join(base, "home-" + k), MEMGLOW_CONFIG: path.join(base, "none.json"), MEMGLOW_DATA_DIR: path.join(base, "data-" + k), MEMGLOW_PROXY_LOG: "0" });
  const quiet = { MEMGLOW_PROXY_LOG: "0" };
  const closers = [];
  // proxy → memory server
  const s1 = createMemoryServer({ root: roots.proxy, readOnly: false, watch: false, pollMs: 3000, fsync: false });
  const up = createHttpServer({ rpc: s1.rpc, store: s1.store });
  await new Promise((ok) => up.listen(0, "127.0.0.1", ok));
  const envA = { ...envOf("a"), MEMGLOW_MEMORY_DIR: path.join(roots.proxy, "memory"), ...quiet };
  const px = createHttpProxy({ upstream: `http://127.0.0.1:${up.address().port}/mcp`, name: "memglow-memory", onReport: () => {}, levers: setupLevers(envA, "memglow-memory"), rules: setupRules(envA) });
  await new Promise((ok) => px.listen(0, "127.0.0.1", ok));
  closers.push(() => { px.closeAllConnections(); px.close(); up.closeAllConnections(); up.close(); s1.close(); });
  // all-in-one
  const s2 = createMemoryServer({ root: roots.aio, readOnly: false, watch: false, pollMs: 3000, fsync: false, allInOne: { env: { ...envOf("b"), ...quiet }, name: "memglow-memory", onReport: () => {} } });
  const aio = createHttpServer({ rpc: s2.rpc, store: s2.store });
  await new Promise((ok) => aio.listen(0, "127.0.0.1", ok));
  closers.push(() => { aio.closeAllConnections(); aio.close(); s2.close(); });

  const sides = {
    proxy: { url: `http://127.0.0.1:${px.address().port}/mcp`, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }), t: {} },
    aio: { url: `http://127.0.0.1:${aio.address().port}/mcp`, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }), t: {} },
  };
  for (const s of Object.values(sides)) {
    const r = await post(s.url, s.agent, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "bench" } } }, {});
    s.h = { "mcp-session-id": r.headers["mcp-session-id"] };
  }
  let id = 1;
  const calls = {
    search: (i) => ({ name: "search_notes", arguments: { query: `${pick(i, 1)} ${pick(i, 2)}` } }),
    multiQuery: (i) => ({ name: "search_notes", arguments: { query: pick(i, 1), memglow_queries: [pick(i, 3), pick(i, 5)] } }),
    read: (i) => ({ name: "read_note", arguments: { identifier: `note-${(i * 37) % o.notes}`, memglow_fresh: true } }),
    write: (i) => ({ name: "edit_note", arguments: { identifier: `note-${(i * 11) % o.notes}`, operation: "append", content: `\n- bench line ${i}` } }),
  };
  // Warm-up (index builds), not counted.
  for (let i = 0; i < 5; i++) for (const s of Object.values(sides)) for (const k of Object.keys(calls)) await post(s.url, s.agent, { jsonrpc: "2.0", id: id++, method: "tools/call", params: calls[k](i + 1000) }, s.h);
  for (let i = 0; i < o.n; i++) {
    for (const k of Object.keys(calls)) {
      const order = i % 2 ? ["proxy", "aio"] : ["aio", "proxy"];
      for (const side of order) {
        const s = sides[side];
        const r = await post(s.url, s.agent, { jsonrpc: "2.0", id: id++, method: "tools/call", params: calls[k](i) }, s.h);
        if (!/"result"/.test(r.text)) throw new Error(`${side} ${k}: ${r.text.slice(0, 200)}`);
        (s.t[k] = s.t[k] || []).push(r.ms);
      }
    }
  }
  const out = { notes: o.notes, n: o.n };
  for (const [side, s] of Object.entries(sides)) { out[side] = {}; for (const [k, a] of Object.entries(s.t)) out[side][k] = stats(a); s.agent.destroy(); }
  for (const c of closers) c();
  fs.rmSync(base, { recursive: true, force: true });
  if (o.json) { process.stdout.write(JSON.stringify(out, null, 2) + "\n"); return; }
  process.stdout.write(`all-in-one vs proxy → memory server — ${o.notes} notes, ${o.n} calls each, ms (median / p95)\n`);
  for (const k of Object.keys(calls)) process.stdout.write(`  ${k.padEnd(11)} proxy ${String(out.proxy[k].median).padStart(7)} / ${String(out.proxy[k].p95).padStart(7)}    all-in-one ${String(out.aio[k].median).padStart(7)} / ${String(out.aio[k].p95).padStart(7)}\n`);
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
