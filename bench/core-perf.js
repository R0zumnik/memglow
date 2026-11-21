#!/usr/bin/env node
"use strict";
/**
 * memglow — core engine efficiency benchmark: what one session COSTS (tokens returned per typical
 * call), how fast the engine answers, how heavy it is to start and to keep running.
 *
 *   node bench/core-perf.js                          a synthetic notes folder (480 notes)
 *   node bench/core-perf.js --root path/to/knowledge  a COPY of a real notes folder (the folder
 *                                                    itself is only read; all writes go to the copy)
 *   options: --notes 480  --n 60  --runs 3  --idle-s 17  --queries "a b|c d|e f"
 *            --server-arg ARG (repeatable)  --env KEY=VALUE (repeatable)  --label NAME
 *            --json  --out FILE  --show-names
 *
 * What runs: the REAL server process, started like production (`--levers --poll-ms 15000
 * --read-write --fsync-mode deferred`, the production lever switches), spoken to over real HTTP
 * with MCP 2026-07-28 stateless requests, as Claude Code does. Isolated data / home / config
 * folders in a temp directory; nothing outside it is written.
 *
 * Measured:
 *  - cold start: wall time and CPU time until the index is ready, peak RSS (VmHWM); then the same
 *    for a RESTART on the same data folder (a persistent index cache, when the server has one,
 *    shows here); steady RSS after the calls; idle CPU over `--idle-s` seconds (one poll at least);
 *  - latency p50 / p95 of read_note, search_notes, build_context, memory_core, recent_activity,
 *    write_note and edit_note;
 *  - TOKENS per typical call, the way the model receives them: Claude Code hands the model
 *    `structuredContent` (JSON-encoded) when a result has one, else the text of `content` — both
 *    are reported ("model" = that rule, "text" = content only). Tokens are memglow's own estimate,
 *    ceil(UTF-8 bytes / 4) (lib/cost.js): good for before/after comparisons, not a tokenizer;
 *  - CPU time of one scan of the poll loop (in process, on the store alone).
 *
 * The report holds numbers only — never note text; note names only with --show-names.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const cp = require("child_process");

const ROOT_DIR = path.join(__dirname, "..");
const { estimateTokens } = require("../lib/cost");
const { makeKb } = require("./responsiveness");
const { queriesFrom } = require("./memory-server-speed");

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
// The production lever switches (docker inspect of the production container, 2026-11).
const PROD_ENV = {
  MEMGLOW_PROXY_ORPHAN_HINT: "1", MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_SLUG_HINT: "1", MEMGLOW_PROXY_HUB_HINT: "1",
  MEMGLOW_PROXY_NEGATIVE_CACHE: "1", MEMGLOW_PROXY_STATE_VIEW: "1", MEMGLOW_MEMORY_KEBAB_FILENAMES: "1",
  MEMGLOW_PROXY_SAVINGS_FILE: "1", MEMGLOW_PROXY_DUPLICATE_HINT: "1",
};
const PROD_ARGS = ["--project", "main", "--levers", "--poll-ms", "15000", "--read-write", "--fsync-mode", "deferred"];

function args(argv) {
  const o = { root: "", notes: 480, n: 60, runs: 3, idleS: 17, queries: null, serverArgs: [], env: {}, label: "", json: false, out: "", showNames: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = argv[++i] || "";
    else if (a === "--synthetic") o.root = "";
    else if (a === "--notes") o.notes = Math.max(40, Number(argv[++i]) || 480);
    else if (a === "--n") o.n = Math.max(5, Number(argv[++i]) || 60);
    else if (a === "--runs") o.runs = Math.max(1, Number(argv[++i]) || 3);
    else if (a === "--idle-s") o.idleS = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--queries") o.queries = String(argv[++i] || "").split("|").map((s) => s.trim()).filter(Boolean);
    else if (a === "--server-arg") o.serverArgs.push(argv[++i]);
    else if (a === "--env") { const kv = String(argv[++i] || ""); const k = kv.indexOf("="); if (k > 0) o.env[kv.slice(0, k)] = kv.slice(k + 1); }
    else if (a === "--label") o.label = argv[++i] || "";
    else if (a === "--json") o.json = true;
    else if (a === "--out") o.out = argv[++i] || "";
    else if (a === "--show-names") o.showNames = true;
    else { process.stderr.write(`core-perf: unknown option ${a}\n`); process.exit(2); }
  }
  return o;
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const stats = (xs) => ({ n: xs.length, p50: r2(pct(xs, 50)), p95: r2(pct(xs, 95)) });
const median = (xs) => pct(xs, 50);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * The synthetic folder of bench/responsiveness.js, plus what the production memory is made of and
 * that generator lacks: hubs with parts (`part_of`), journal notes (dated sections, over 1,500
 * tokens: what stateView shortens) and an index note that links them.
 */
function makeSyntheticKb(dir, count) {
  makeKb(dir, count);
  const mem = path.join(dir, "memory");
  const para = (i, k) => `Point ${k} du chantier ${i} : la sauvegarde du serveur est passée, le routeur a été "redémarré", reste à vérifier le conteneur docker et la domotique de la maison avant la fin de la semaine.`;
  const index = ["---", "title: MEMORY", "type: note", "---", "", "# Memory index", ""];
  for (let h = 0; h < 6; h++) {
    const hub = `project-chantier-${h}`;
    const parts = [];
    for (let p = 0; p < 5; p++) {
      const id = `${hub}-part-${p}`;
      parts.push(id);
      const body = Array.from({ length: 12 }, (_, k) => `- ${para(h, k)} [[${hub}]]`).join("\n");
      fs.mkdirSync(path.join(mem, "project"), { recursive: true });
      fs.writeFileSync(path.join(mem, "project", id + ".md"), `---\ntitle: ${id}\ntype: note\npermalink: main/memory/project/${id}\npart_of: ${hub}\ndescription: partie ${p} du chantier ${h}\n---\n\n# ${id}\n\nUp: [[${hub}]]\n\n${body}\n`);
    }
    const hubBody = ["## Parts", "", ...parts.map((p, k) => `- [[${p}]] — partie ${k}, ${para(h, k).slice(0, 60)}`), "", "## Rules", "", ...Array.from({ length: 8 }, (_, k) => `- ${para(h, k)}`)].join("\n");
    fs.writeFileSync(path.join(mem, "project", hub + ".md"), `---\ntitle: ${hub}\ntype: note\npermalink: main/memory/project/${hub}\ndescription: hub du chantier ${h}\n---\n\n# ${hub}\n\n${hubBody}\n`);
    index.push(`- [[${hub}]] — chantier ${h} (hub, ${parts.length} parts)`);
  }
  for (let j = 0; j < 4; j++) {
    const id = `project-journal-${j}`;
    const secs = [];
    for (let d = 1; d <= 14; d++) secs.push(`## Update 2026-10-${String(d).padStart(2, "0")}`, "", ...Array.from({ length: 10 }, (_, k) => `- ${para(j * 20 + d, k)}`), "");
    fs.writeFileSync(path.join(mem, "project", id + ".md"), `---\ntitle: ${id}\ntype: note\npermalink: main/memory/project/${id}\ndescription: journal du chantier ${j}\n---\n\n# ${id}\n\n## Rules\n\n- ${para(j, 0)}\n\n${secs.join("\n")}\n`);
    index.push(`- [[${id}]] — journal ${j}`);
  }
  fs.writeFileSync(path.join(mem, "MEMORY.md"), index.join("\n") + "\n");
}

function freePort() {
  return new Promise((ok, ko) => { const s = net.createServer(); s.once("error", ko); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

function post(url, agent, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const t0 = process.hrtime.bigint();
    const req = http.request(url, { method: "POST", agent, headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "user-agent": "claude-code/2.1 (bench)", "content-length": data.length, ...headers } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => { const buf = Buffer.concat(parts); resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.statusCode, bytes: buf.length, text: buf.toString() }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** /proc figures of a child: RSS now, peak RSS, CPU seconds used so far. null off Linux. */
function procOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k) => { const m = new RegExp("^" + k + ":\\s+(\\d+) kB", "m").exec(st); return m ? Number(m[1]) / 1024 : null; };
    const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return { rssMB: r2(kb("VmRSS")), peakMB: r2(kb("VmHWM")), cpuS: (Number(f[11]) + Number(f[12])) / 100 };
  } catch { return null; }
}

/** Starts the real server on `root`; resolves once the index is ready and a call was answered. */
async function startServer(o, root, base, tag) {
  const port = await freePort();
  const env = { ...process.env, ...PROD_ENV, MEMGLOW_HOME: path.join(base, "home"), MEMGLOW_CONFIG: path.join(base, "none.json"), MEMGLOW_DATA_DIR: path.join(base, "data"), MEMGLOW_PROXY_LOG: "0", MEMGLOW_URL: "http://127.0.0.1:9", ...o.env };
  delete env.MEMGLOW_MEMORY_TOKEN;
  const t0 = Date.now();
  const p = cp.spawn(process.execPath, [path.join(ROOT_DIR, "memory-server", "memglow-memory-server.js"), "--root", root, "--listen", `127.0.0.1:${port}`, ...PROD_ARGS, ...o.serverArgs], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "", exited = false;
  p.on("exit", () => { exited = true; });
  const indexed = new Promise((ok, ko) => {
    p.stderr.on("data", (c) => { err += c; const m = /(\d+) notes indexed from .* in (\d+) ms/.exec(err); if (m) ok({ notes: Number(m[1]), indexMs: Number(m[2]) }); });
    p.on("exit", () => ko(new Error(`server (${tag}) exited: ${err.slice(-600)}`)));
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let id = 0, sess = 0;
  /** One MCP request. `session`: a session name (levers keep per-session state); default: a new one. */
  const rpc = async (method, params, session) => {
    const r = await post(url, agent, { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: META } }, { "x-memglow-session": session || `bench-${tag}-${++sess}` });
    let j = null;
    try { j = JSON.parse(r.text); } catch { /* not JSON */ }
    return { ...r, json: j, result: j && j.result };
  };
  const call = (name, a, session) => rpc("tools/call", { name, arguments: a }, session);
  const info = await indexed;
  const readyMs = Date.now() - t0;
  let first = null;
  for (let i = 0; i < 200 && !exited; i++) { try { first = await call("list_directory", { dir_name: "/" }); break; } catch { await sleep(25); } }
  if (!first) throw new Error(`server (${tag}) never answered: ${err.slice(-600)}`);
  const at = procOf(p.pid);
  return {
    pid: p.pid, rpc, call, info, readyMs, firstAnswerMs: Date.now() - t0, atReady: at,
    proc: () => procOf(p.pid),
    stop: async () => { agent.destroy(); if (!exited) { p.kill("SIGTERM"); await new Promise((ok) => { p.on("exit", ok); setTimeout(ok, 30000).unref(); }); } },
  };
}

/** Sizes of one answer: wire bytes, tokens as the model gets them, tokens of the text content. */
function sizeOf(r) {
  const res = r.result || {};
  const text = Array.isArray(res.content) ? res.content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n") : "";
  const model = res.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : text;
  return { wireBytes: r.bytes, model: estimateTokens(model), text: estimateTokens(text), isError: !!res.isError || !r.result };
}

/** The notes the typical calls use, picked from the folder itself (deterministic). */
function pickNotes(root) {
  const { createStore } = require("../lib/store/store");
  const stateView = require("../lib/levers/state-view");
  const store = createStore({ root, watch: false, pollMs: 0 });
  store.start();
  const notes = store.notes().filter((n) => !/(^|\/)bench\//.test(n.rel));
  const byKey = new Map();
  for (const n of notes) for (const k of [n.base, n.slug, n.title]) if (k && !byKey.has(String(k).toLowerCase())) byKey.set(String(k).toLowerCase(), n);
  const partsOf = new Map();
  for (const n of notes) {
    const raw = n.frontmatter && (n.frontmatter.part_of != null ? n.frontmatter.part_of : n.frontmatter.parent);
    if (raw == null) continue;
    const key = String(Array.isArray(raw) ? raw[0] : raw).replace(/^\[\[|\]\]$/g, "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const hub = byKey.get(key);
    if (hub && hub !== n) partsOf.set(hub, (partsOf.get(hub) || 0) + 1);
  }
  const index = notes.find((n) => /^(memory|index)$/i.test(n.base)) || null;
  const hub = [...partsOf.entries()].sort((a, b) => b[1] - a[1] || (a[0].rel < b[0].rel ? -1 : 1)).map((e) => e[0])[0]
    || notes.slice().sort((a, b) => b.relations.length - a.relations.length || (a.rel < b.rel ? -1 : 1))[0];
  let journal = null;
  for (const n of notes.slice().sort((a, b) => b.size - a.size || (a.rel < b.rel ? -1 : 1))) {
    let v = null;
    try { v = stateView.buildStateView(n.raw, { mtimeMs: n.mtimeMs }); } catch { v = null; }
    if (v) { journal = n; break; }
  }
  const bySize = notes.slice().sort((a, b) => a.size - b.size || (a.rel < b.rel ? -1 : 1));
  const typical = bySize[bySize.length >> 1];
  const largest = bySize[bySize.length - 1];
  const out = { store, notes, index, hub, journal, typical, largest, hubParts: hub ? partsOf.get(hub) || 0 : 0 };
  return out;
}

async function tokensSection(srv, pk, queries) {
  const rows = [];
  const add = async (label, fn) => {
    try { const r = await fn(); rows.push({ call: label, ...sizeOf(r) }); return r; }
    catch (e) { rows.push({ call: label, error: String(e && e.message).slice(0, 80) }); return null; }
  };
  const tl = await srv.rpc("tools/list", {});
  const tools = tl.result && tl.result.tools ? tl.result.tools : [];
  rows.push({ call: "tools/list (fixed reference)", wireBytes: tl.bytes, model: estimateTokens(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })))), text: estimateTokens(JSON.stringify(tools)), tools: tools.length });
  await add("memory_core", () => srv.call("memory_core", {}));
  if (pk.index) await add("read_note: index note", () => srv.call("read_note", { identifier: pk.index.permalink }));
  if (pk.hub) await add("read_note: hub", () => srv.call("read_note", { identifier: pk.hub.permalink }));
  if (pk.journal) await add("read_note: big journal", () => srv.call("read_note", { identifier: pk.journal.permalink }));
  if (pk.typical) await add("read_note: median-size note", () => srv.call("read_note", { identifier: pk.typical.permalink }));
  if (pk.largest) await add("read_note: largest note", () => srv.call("read_note", { identifier: pk.largest.permalink }));
  if (pk.hub) await add("read_note: hub, 2nd read in the same session", async () => { await srv.call("read_note", { identifier: pk.hub.permalink }, "bench-same-session"); return srv.call("read_note", { identifier: pk.hub.permalink }, "bench-same-session"); });
  for (let i = 0; i < queries.length; i++) await add(`search_notes: query ${i + 1} (${queries[i].split(/\s+/).length} words)`, () => srv.call("search_notes", { query: queries[i] }));
  if (pk.hub) {
    await add("build_context: hub, depth 1 (default format)", () => srv.call("build_context", { url: "memory://" + pk.hub.permalink, depth: 1 }));
    await add("build_context: hub, depth 1, output_format text", () => srv.call("build_context", { url: "memory://" + pk.hub.permalink, depth: 1, output_format: "text" }));
  }
  await add("recent_activity (default)", () => srv.call("recent_activity", {}));
  await add("recent_activity (timeframe 30d)", () => srv.call("recent_activity", { timeframe: "30d" }));
  await add("list_directory: memory, depth 2", () => srv.call("list_directory", { dir_name: "memory", depth: 2 }));
  await add("write_note (small new note)", () => srv.call("write_note", { title: "bench token note", directory: "memory/bench", content: "A small note written by the benchmark.\n\n- one\n- two\n" }));
  await add("edit_note (append)", () => srv.call("edit_note", { identifier: "bench token note", operation: "append", content: "\n- three\n" }));
  return rows;
}

async function latencySection(srv, pk, o) {
  const out = {};
  const notes = pk.notes;
  const time = async (label, n, fn) => {
    const ms = [];
    for (let i = 0; i < n; i++) { const r = await fn(i); if (!r.result) throw new Error(`${label}: no result (${r.text.slice(0, 200)})`); ms.push(r.ms); }
    out[label] = stats(ms);
  };
  const qs = queriesFrom(notes, o.n);
  await time("search_notes", o.n, (i) => srv.call("search_notes", qs[i % qs.length]));
  await time("read_note", o.n, (i) => srv.call("read_note", { identifier: notes[(i * 104729) % notes.length].permalink }));
  await time("build_context", o.n, (i) => srv.call("build_context", { url: "memory://" + notes[(i * 7919) % notes.length].permalink, depth: 1 }));
  await time("memory_core", o.n, () => srv.call("memory_core", {}));
  await time("recent_activity", o.n, () => srv.call("recent_activity", {}));
  const w = Math.min(o.n, 20);
  await time("write_note", w, (i) => srv.call("write_note", { title: `bench latency ${i}`, directory: "memory/bench", content: `Bench note ${i}.\n` }));
  await time("edit_note (append)", w, (i) => srv.call("edit_note", { identifier: `bench latency ${i}`, operation: "append", content: `\n- line ${i}\n` }));
  await time("search_notes right after a write", w, async (i) => { await srv.call("edit_note", { identifier: `bench latency ${i}`, operation: "append", content: `\n- again ${i}\n` }); return srv.call("search_notes", qs[i % qs.length]); });
  return out;
}

/** CPU and wall time of one poll-loop scan, on the store alone (nothing changed on disk). */
async function pollSection(root) {
  const { createStore } = require("../lib/store/store");
  const store = createStore({ root, watch: false, pollMs: 0 });
  store.start();
  const N = 30, cpuMs = [], wallMs = [];
  for (let i = 0; i < N; i++) {
    const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
    await store.scanAsync();
    const c = process.cpuUsage(c0);
    cpuMs.push((c.user + c.system) / 1000);
    wallMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const st = store.stats();
  store.stop();
  return { notes: st.notes, scans: N, cpuMsPerScan: stats(cpuMs), wallMsPerScan: stats(wallMs) };
}

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] == null ? "" : r[c]).length)));
  const line = (vals) => vals.map((v, i) => (i === 0 ? String(v).padEnd(w[i]) : String(v).padStart(w[i]))).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => (r[c] == null ? "" : r[c]))))].join("\n");
}

async function main() {
  const o = args(process.argv.slice(2));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-core-perf-"));
  const root = path.join(base, "kb");
  const report = { label: o.label || (o.root ? "real-copy" : "synthetic"), kb: o.root ? "copy of a real folder" : `synthetic (${o.notes} notes + hubs, parts, journals)`, node: process.version, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || "", serverArgs: PROD_ARGS.concat(o.serverArgs).join(" "), extraEnv: Object.keys(o.env) };
  try {
    if (o.root) fs.cpSync(path.resolve(o.root), root, { recursive: true, preserveTimestamps: true, filter: (src) => !/(^|\/)\.git(\/|$)/.test(path.relative(path.resolve(o.root), src)) });
    else { fs.mkdirSync(root, { recursive: true }); makeSyntheticKb(root, o.notes); }
    for (const d of ["home", "data"]) fs.mkdirSync(path.join(base, d), { recursive: true });

    // ---- start-up: `runs` cold starts (data folder emptied first), then `runs` restarts ----
    const cold = [], warm = [];
    for (let i = 0; i < o.runs * 2; i++) {
      const isCold = i < o.runs;
      if (isCold) { fs.rmSync(path.join(base, "data"), { recursive: true, force: true }); fs.mkdirSync(path.join(base, "data"), { recursive: true }); }
      const s = await startServer(o, root, base, "start" + i);
      (isCold ? cold : warm).push({ indexMs: s.info.indexMs, readyMs: s.readyMs, firstAnswerMs: s.firstAnswerMs, cpuS: s.atReady && s.atReady.cpuS, peakMB: s.atReady && s.atReady.peakMB });
      report.notes = s.info.notes;
      await s.stop();
    }
    const fold = (runs) => ({ runs: runs.length, indexMs: median(runs.map((r) => r.indexMs)), firstAnswerMs: median(runs.map((r) => r.firstAnswerMs)), cpuS: r2(median(runs.map((r) => r.cpuS))), peakRssMB: r2(median(runs.map((r) => r.peakMB))), indexMsAll: runs.map((r) => r.indexMs) });
    report.coldStart = fold(cold);
    report.restart = fold(warm);

    // ---- the measured server ----
    const pk = pickNotes(root);
    const queries = o.queries && o.queries.length ? o.queries : (() => {
      const good = (n) => n && n.title.split(/[\s-]+/).filter((w) => w.length > 3).slice(0, 3).join(" ");
      return [pk.hub, pk.typical, pk.notes[(pk.notes.length * 2 / 3) | 0]].map(good).filter(Boolean);
    })();
    report.picked = {
      index: pk.index ? { tokens: estimateTokens(pk.index.raw) } : null,
      hub: pk.hub ? { tokens: estimateTokens(pk.hub.raw), parts: pk.hubParts, links: pk.hub.relations.length } : null,
      journal: pk.journal ? { tokens: estimateTokens(pk.journal.raw) } : null,
      typical: pk.typical ? { tokens: estimateTokens(pk.typical.raw) } : null,
      largest: pk.largest ? { tokens: estimateTokens(pk.largest.raw) } : null,
      totalNoteTokens: pk.notes.reduce((a, n) => a + estimateTokens(n.raw), 0),
    };
    if (o.showNames) for (const k of ["index", "hub", "journal", "typical", "largest"]) if (pk[k]) report.picked[k].rel = pk[k].rel;
    pk.store.stop();
    const srv = await startServer(o, root, base, "main");
    try {
      report.tokens = await tokensSection(srv, pk, queries);
      report.latencyMs = await latencySection(srv, pk, o);
      const afterCalls = srv.proc();
      if (o.idleS > 0) {
        await sleep(1500);
        const a = srv.proc(), t0 = Date.now();
        await sleep(o.idleS * 1000);
        const b = srv.proc();
        if (a && b) report.idle = { seconds: o.idleS, cpuPct: r2(((b.cpuS - a.cpuS) / ((Date.now() - t0) / 1000)) * 100), rssMB: b.rssMB };
      }
      const end = srv.proc();
      report.memory = { rssAtReadyMB: srv.atReady && srv.atReady.rssMB, rssAfterCallsMB: afterCalls && afterCalls.rssMB, steadyRssMB: end && end.rssMB, peakRssMB: end && end.peakMB };
    } finally { await srv.stop(); }
    report.pollScan = await pollSection(root);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(report, null, 2) + "\n");
  if (o.json) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return; }
  const L = [];
  L.push(`memglow core-perf — ${report.label} — ${report.kb}, ${report.notes} notes, Node ${report.node}, ${report.cpus} × ${report.cpuModel}`);
  L.push("", "Start-up (median of " + report.coldStart.runs + ")");
  L.push(table([{ "": "cold start", ...report.coldStart }, { "": "restart (same data folder)", ...report.restart }].map((r) => ({ "": r[""], "index ms": r.indexMs, "first answer ms": r.firstAnswerMs, "CPU s": r.cpuS, "peak RSS MB": r.peakRssMB })), ["", "index ms", "first answer ms", "CPU s", "peak RSS MB"]));
  L.push("", "Memory: " + JSON.stringify(report.memory) + (report.idle ? `   idle CPU ${report.idle.cpuPct} % over ${report.idle.seconds} s` : ""));
  L.push("", "Poll loop: one scan = " + JSON.stringify(report.pollScan.cpuMsPerScan) + " ms CPU, " + JSON.stringify(report.pollScan.wallMsPerScan) + " ms wall");
  L.push("", "Latency (ms)");
  L.push(table(Object.entries(report.latencyMs).map(([k, v]) => ({ call: k, n: v.n, p50: v.p50, p95: v.p95 })), ["call", "n", "p50", "p95"]));
  L.push("", "Tokens per call (≈ bytes / 4): model = what Claude Code hands the model, text = content only");
  L.push(table(report.tokens.map((r) => ({ call: r.call, model: r.model, text: r.text, "wire bytes": r.wireBytes, note: r.error || (r.isError ? "ERROR" : "") })), ["call", "model", "text", "wire bytes", "note"]));
  process.stdout.write(L.join("\n") + "\n");
}

if (require.main === module) main().catch((e) => { process.stderr.write("core-perf: " + (e && e.stack || e) + "\n"); process.exit(1); });

module.exports = { makeSyntheticKb, sizeOf, pickNotes, PROD_ENV, PROD_ARGS };
