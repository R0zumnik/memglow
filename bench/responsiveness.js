#!/usr/bin/env node
"use strict";
/**
 * memglow memory server — responsiveness measurements for the all-in-one production set-up
 * (stage 0.4.10.x): startup, `initialize`, search / multiQuery / read latency, a write in each
 * fsync mode, the first search after a write, tokens per 10-hit search, child processes spawned
 * per call, activity reports delivered, and idle CPU of a real server process.
 *
 *   node bench/responsiveness.js [--notes 265] [--n 40] [--idle-s 10] [--json] [--no-proc]
 *
 * Everything runs on a synthetic notes folder in a temp directory (accented FR/EN text,
 * wikilinks, a `.git` folder with many objects), with isolated memglow data folders and a local
 * fake viewer that counts the activity reports. Nothing outside the temp folders is touched.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cp = require("child_process");

// Count every child process started in this process (activity reports used to spawn one per call).
let spawned = 0;
const realSpawn = cp.spawn;
function countSpawns() { cp.spawn = function (...a) { spawned++; return realSpawn.apply(this, a); }; }

const ROOT_DIR = path.join(__dirname, "..");
// Loaded by main() AFTER countSpawns(): modules that keep a reference to child_process.spawn.
let createMemoryServer, createHttpServer;
function load() {
  ({ createMemoryServer } = require("../memory-server/memglow-memory-server"));
  ({ createHttpServer } = require("../memory-server/http"));
}

function args(argv) {
  const o = { notes: 265, n: 40, idleS: 10, json: false, proc: true, leversOn: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--notes") o.notes = Math.max(20, Number(argv[++i]) || 265);
    else if (argv[i] === "--n") o.n = Math.max(5, Number(argv[++i]) || 40);
    else if (argv[i] === "--idle-s") o.idleS = Math.max(1, Number(argv[++i]) || 10);
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--no-proc") o.proc = false;
    else if (argv[i] === "--levers-on") o.leversOn = true; // the levers that read the note index, on
  }
  return o;
}

const WORDS = ("garden tomate rugby stade wifi routeur kayak pagaie recette pain école vacances budget facture médecin dentiste voiture garage piano leçon train billet musée livre roman film série serveur sauvegarde photo album été hiver forêt rivière château "
  + "memglow proxy levier index recherche mémoire note projet famille maison réseau domotique synology docker conteneur").split(" ");
const pick = (i, k) => WORDS[(i * 7 + k * 13 + ((i * k) % 5)) % WORDS.length];

/** A synthetic notes folder shaped like the production one (~265 notes, 1–8 KB each). */
function makeKb(dir, count) {
  const themes = ["family", "work", "home", "tech", "archive"];
  for (let i = 0; i < count; i++) {
    const theme = themes[i % themes.length];
    const id = `${theme}-${pick(i, 1)}-${pick(i, 2)}-${i}`;
    const lines = [];
    const paras = 4 + (i % 14);
    for (let p = 0; p < paras; p++) {
      lines.push(`## ${pick(i + p, 3)} ${pick(i, p + 4)}`, "");
      for (let l = 0; l < 3 + ((i + p) % 6); l++) {
        lines.push(`- ${pick(i + l, p)} ${pick(i + p, l + 2)} ${pick(l, i)} — détail ${l} « ${pick(p, l)} » [[${themes[(i + l) % 5]}-${pick((i + l + 1) % count, 1)}-${pick((i + l + 1) % count, 2)}-${(i + l + 1) % count}]]`);
      }
      lines.push("", `${pick(i, p)} ${pick(p, i)} ${pick(i + 1, p + 1)} : une phrase plus longue sur le ${pick(i, 9)} et la ${pick(p, 8)}, écrite en été.`, "");
    }
    const text = ["---", `title: ${id}`, `type: note`, `permalink: main/memory/${theme}/${id}`, `tags: [${theme}, ${pick(i, 6)}]`, `description: ${pick(i, 7)} ${pick(i, 8)} ${pick(i, 9)}`, "---", "", `# ${id}`, ""].concat(lines).join("\n") + "\n";
    fs.mkdirSync(path.join(dir, "memory", theme), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", theme, id + ".md"), text);
  }
  fs.writeFileSync(path.join(dir, "memory", "MEMORY.md"), "---\ntitle: MEMORY\ntype: note\n---\n\n# Memory index\n\n" + Array.from({ length: 30 }, (_, i) => `- [[${pick(i, 1)}]] ${pick(i, 2)}`).join("\n") + "\n");
  // A git snapshot folder, as on the NAS (the old recursive fs.watch woke up on every object).
  for (let i = 0; i < 300; i++) { const d = path.join(dir, ".git", "objects", (i % 256).toString(16).padStart(2, "0")); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "obj" + i), "x".repeat(100)); }
}

function post(url, agent, body, headers = {}) {
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

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const stats = (xs) => ({ p50: r2(pct(xs, 50)), p95: r2(pct(xs, 95)) });

/** A fake viewer counting POST /api/activity. */
async function fakeViewer() {
  const got = [];
  const srv = http.createServer((req, res) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => { if (req.url === "/api/activity") got.push(Buffer.concat(parts).toString()); res.end("{}"); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, got, close: () => { srv.closeAllConnections(); srv.close(); } };
}

function supports(opt) {
  try { return require("../memory-server/memglow-memory-server").HELP.includes(opt); } catch { return false; }
}

async function inProcess(o, base, viewer) {
  const root = path.join(base, "kb-a");
  fs.cpSync(path.join(base, "src"), root, { recursive: true });
  const home = path.join(base, "home-a");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "token"), "t".repeat(40));
  const env = { MEMGLOW_HOME: home, MEMGLOW_CONFIG: path.join(base, "none.json"), MEMGLOW_DATA_DIR: path.join(base, "data-a"), MEMGLOW_PROXY_LOG: "0", MEMGLOW_URL: viewer.url, MEMGLOW_TOKEN: "t".repeat(40),
    ...(o.leversOn ? { MEMGLOW_PROXY_ALREADY_LOADED: "1", MEMGLOW_PROXY_DEDUPE: "1", MEMGLOW_PROXY_DELTA_READ: "1", MEMGLOW_PROXY_DUPLICATE_HINT: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_PROXY_INDEX_HINT: "1", MEMGLOW_PROXY_NEGATIVE_CACHE: "1" } : {}) };
  // agent-core reads these from process.env (activity reports): point them at the fake viewer.
  Object.assign(process.env, { MEMGLOW_HOME: home, MEMGLOW_URL: viewer.url, MEMGLOW_TOKEN: "t".repeat(40) });
  const out = {};
  const t0 = process.hrtime.bigint();
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 15000, fsync: true, allInOne: { env, name: "memglow-memory" } });
  const server = createHttpServer({ rpc: srv.rpc, store: srv.store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  out.createMs = r2(Number(process.hrtime.bigint() - t0) / 1e6);
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const init = await post(url, agent, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } });
  out.initializeMs = r2(init.ms);
  out.startupToFirstAnswerMs = r2(Number(process.hrtime.bigint() - t0) / 1e6);
  const H = { "mcp-session-id": init.headers["mcp-session-id"] };
  let id = 1;
  const call = (name, a) => post(url, agent, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: a } }, H);
  const first = await call("search_notes", { query: "jardin tomate" });
  out.firstSearchMs = r2(first.ms);
  const t = { search: [], multiQuery: [], read: [], writeSync: [], searchAfterWrite: [] };
  const spawned0 = spawned, reports0 = viewer.got.length;
  let calls = 0;
  for (let i = 0; i < o.n; i++) {
    let r = await call("search_notes", { query: `${pick(i, 1)} ${pick(i, 2)}` }); t.search.push(r.ms); calls++;
    r = await call("search_notes", { query: pick(i, 1), memglow_queries: [pick(i, 3), pick(i, 5)] }); t.multiQuery.push(r.ms); calls++;
    r = await call("read_note", { identifier: fs.readdirSync(path.join(root, "memory", "family"))[i % 10].replace(/\.md$/, ""), memglow_fresh: true }); t.read.push(r.ms); calls++;
  }
  for (let i = 0; i < Math.min(o.n, 20); i++) {
    let r = await call("write_note", { title: `bench sync ${i}`, directory: "memory/bench", content: `Bench note ${i} ${pick(i, 1)} ${pick(i, 2)}.` }); t.writeSync.push(r.ms); calls++;
    if (!/"isError":false/.test(r.text)) throw new Error("write failed: " + r.text.slice(0, 300));
    r = await call("search_notes", { query: `${pick(i, 3)} ${pick(i, 4)}` }); t.searchAfterWrite.push(r.ms); calls++;
  }
  await new Promise((ok) => setTimeout(ok, 1500));
  out.spawnedPerCall = r2((spawned - spawned0) / calls);
  out.reportsDelivered = `${viewer.got.length - reports0}/${calls}`;
  for (const [k, v] of Object.entries(t)) out[k] = stats(v);
  // Tokens per 10-hit search (text answer, the way a client reads it).
  const toks = [];
  for (let i = 0; i < 20; i++) {
    const r = await call("search_notes", { query: `${pick(i, 1)} ${pick(i, 4)}`, page_size: 10 });
    const j = JSON.parse(r.text);
    const text = (j.result.content || []).map((c) => c.text || "").join("");
    const sc = j.result.structuredContent ? JSON.stringify(j.result.structuredContent) : "";
    if ((text.match(/^### /gm) || []).length >= 10) toks.push(Math.ceil(Buffer.byteLength(text) / 4) + Math.ceil(Buffer.byteLength(sc) / 4));
  }
  out.tokensPer10HitSearch = toks.length ? Math.round(toks.reduce((a, b) => a + b, 0) / toks.length) : null;
  agent.destroy();
  server.closeAllConnections(); server.close(); srv.close();
  return out;
}

/** Write latency per fsync mode, on a plain server (no levers). */
async function writeModes(base) {
  const out = {};
  const modes = supports("--fsync-mode") ? ["sync", "deferred", "none"] : ["sync", "none"];
  for (const mode of modes) {
    const root = path.join(base, "kb-w-" + mode);
    fs.mkdirSync(path.join(root, "memory"), { recursive: true });
    const opts = supports("--fsync-mode") ? { fsyncMode: mode } : { fsync: mode !== "none" };
    const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, ...opts });
    const ms = [];
    for (let i = 0; i < 30; i++) {
      const t0 = process.hrtime.bigint();
      const r = await srv.rawRpc.handle({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "write_note", arguments: { title: "w " + i, directory: "memory/w", content: "write " + i } } }, {});
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.result.isError) throw new Error(JSON.stringify(r));
    }
    if (srv.writer && srv.writer.idle) await srv.writer.idle();
    srv.close();
    out[mode] = stats(ms);
  }
  return out;
}

/** A real server process: time to first answer, and idle CPU over `idleS` seconds. */
async function realProcess(o, base, extra) {
  const root = path.join(base, "kb-p-" + extra.join("").replace(/[^a-z]/g, ""));
  fs.cpSync(path.join(base, "src"), root, { recursive: true });
  const env = { ...process.env, MEMGLOW_HOME: path.join(base, "home-p"), MEMGLOW_CONFIG: path.join(base, "none.json"), MEMGLOW_DATA_DIR: path.join(base, "data-p"), MEMGLOW_PROXY_LOG: "0" };
  const t0 = Date.now();
  const p = realSpawn(process.execPath, [path.join(ROOT_DIR, "memory-server", "memglow-memory-server.js"), "--root", root, "--project", "main", "--listen", "127.0.0.1:0", "--levers", "--read-write", ...extra], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  const port = await new Promise((ok, ko) => {
    p.stderr.on("data", (c) => { err += c; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(err); if (m) ok(Number(m[1])); });
    p.on("exit", () => ko(new Error("server exited: " + err)));
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const url = `http://127.0.0.1:${port}/mcp`;
  const init = await post(url, agent, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench" } } });
  const firstAnswerMs = Date.now() - t0;
  const H = { "mcp-session-id": init.headers["mcp-session-id"] };
  await post(url, agent, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query: "jardin" } } }, H);
  // Freshness: a file changed behind the server's back, how long until a search sees it?
  const target = path.join(root, "memory", "family", fs.readdirSync(path.join(root, "memory", "family"))[0]);
  fs.appendFileSync(target, "\nzorglubfreshness\n");
  const tf = Date.now();
  let freshMs = null;
  while (Date.now() - tf < 20000) {
    const r = await post(url, agent, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_notes", arguments: { query: "zorglubfreshness" } } }, H);
    if (/### /.test(r.text)) { freshMs = Date.now() - tf; break; }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  agent.destroy();
  await new Promise((ok) => setTimeout(ok, 500));
  const cpu = () => { try { const f = fs.readFileSync(`/proc/${p.pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; /* USER_HZ */ } catch { return null; } };
  const c0 = cpu(), w0 = Date.now();
  // Some writes in .git during the idle window (a git snapshot): must cost nothing.
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, ".git", "objects", "00", "storm" + i), "y");
  await new Promise((ok) => setTimeout(ok, o.idleS * 1000));
  const c1 = cpu();
  p.kill("SIGTERM");
  await new Promise((ok) => p.on("exit", ok));
  return { flags: extra.join(" "), firstAnswerMs, freshMs, idleCpuPct: c0 == null ? null : r2(((c1 - c0) / ((Date.now() - w0) / 1000)) * 100) };
}

async function main() {
  countSpawns();
  load();
  const o = args(process.argv.slice(2));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-resp-bench-"));
  makeKb(path.join(base, "src"), o.notes);
  const viewer = await fakeViewer();
  const out = { notes: o.notes, n: o.n, node: process.version, cpus: os.cpus().length };
  try {
    out.allInOne = await inProcess(o, base, viewer);
    out.write = await writeModes(base);
    if (o.proc) {
      out.process = [await realProcess(o, base, ["--no-watch", "--poll-ms", "15000"])];
      out.process.push(await realProcess(o, base, ["--poll-ms", "15000"]));
    }
  } finally {
    viewer.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(out, null, o.json ? 2 : 1) + "\n");
  // Lingering detached children / timers must not keep the bench alive.
  setTimeout(() => process.exit(0), 200).unref();
}

if (require.main === module) main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });

module.exports = { makeKb };
