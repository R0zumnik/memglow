#!/usr/bin/env node
"use strict";
/**
 * memglow bench — FREE replay harness (0.4.2.1b): a self-verification loop for every future
 * change to the MCP proxy levers (`lib/proxy-levers.js`), with zero model calls, zero network,
 * deterministic. Unlike `bench/run.js` (which spends real `claude -p` budget against a real
 * memory server), this file drives `createLevers` directly — the exact same entry points the real
 * proxy uses (`clientMessage`/`serverMessage`) — against a tiny in-process fake upstream that
 * answers from a folder of notes. It measures tokens and calls, and checks a CORRECTNESS GUARD:
 * nothing a lever ever stubs or cuts may be information the model cannot actually still reach.
 *
 *   node bench/replay.js [--memory-dir <dir>] [--events <file>] [--with <lever,lever,...>]...
 *                         [--always-loaded <entry,entry,...>] [--json]
 *
 * --memory-dir   a folder of notes (default demo/memory).
 * --events       a JSONL or JSON-array file of tool calls `{ session, tool, args, t }`, OR a
 *                single JSON object `{ evenements: [...] }` in the r0zumnik portal's own shape
 *                (default bench/replay-demo.jsonl) — see loadEvents() below for both formats.
 * --with a,b,c   adds one more configuration: DEFAULTS with levers a, b, c forced on (repeatable).
 *                Lever names: sizeWarning, indexWarning, searchDetails, suggestions, dedupe, toc,
 *                archiveHint, hideUnsupportedTools, alreadyLoaded.
 * --always-loaded a,b   extra `alwaysLoaded` entries (note references) for lever 8, on top of the
 *                index note(s) it already covers by default.
 * --json         machine-readable output instead of the table.
 *
 * Every configuration gets its OWN throw-away copy of --memory-dir (writes in the event stream
 * never touch the original notes, and never leak between configurations), and is fed the SAME
 * event stream, in order, through `L.createLevers`. Two configurations are always run: "off" (all
 * nine levers off — the baseline every saving is measured against) and "defaults" (the shipped
 * defaults: sizeWarning + searchDetails + suggestions on, everything else off); --with adds more.
 *
 * Exit code 1 if the correctness guard finds ANY violation, in ANY configuration — never 1 for
 * "defaults cost more tokens than off", which is expected (suggestions/searchDetails/sizeWarning
 * add explanatory text, they do not cut anything; only dedupe/toc/alreadyLoaded can save tokens,
 * and only by replacing an answer with a stub — which is exactly what the guard checks).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const L = require("../lib/proxy-levers");
const { estimateTokens } = require("../lib/cost");

const ROOT = path.join(__dirname, "..");
const DEFAULT_MEMORY = path.join(ROOT, "demo", "memory");
const DEFAULT_EVENTS = path.join(__dirname, "replay-demo.jsonl");
const GAP_MS = 30 * 60 * 1000; // portal format: a new session after this much silence

const LEVER_ENV = {
  sizeWarning: "MEMGLOW_PROXY_SIZE_WARNING",
  indexWarning: "MEMGLOW_PROXY_INDEX_WARNING",
  searchDetails: "MEMGLOW_PROXY_SEARCH_DETAILS",
  suggestions: "MEMGLOW_PROXY_SUGGESTIONS",
  dedupe: "MEMGLOW_PROXY_DEDUPE",
  toc: "MEMGLOW_PROXY_TOC",
  archiveHint: "MEMGLOW_PROXY_ARCHIVE_HINT",
  hideUnsupportedTools: "MEMGLOW_PROXY_HIDE_UNSUPPORTED",
  alreadyLoaded: "MEMGLOW_PROXY_ALREADY_LOADED",
};
const LEVER_NAMES = Object.keys(LEVER_ENV);
// The shipped defaults (lib/proxy-levers.js DEFAULTS), named here explicitly so this file keeps
// working unchanged even if that module's own defaults ever drift.
const SHIPPED_DEFAULTS = { sizeWarning: true, indexWarning: false, searchDetails: false, suggestions: false, dedupe: false, toc: false, archiveHint: false, hideUnsupportedTools: false, alreadyLoaded: false };

function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

// ---------------------------------------------------------------------------------------------
// Fixture copy: every configuration gets its own throw-away folder, so write events never leak
// between configurations and never touch the folder the user pointed us at.

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function walkMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Same transform the fake upstream (and the real basic-memory) apply: a `permalink:` line added
 * right after the frontmatter fence, so the proxy's permalink-sniffing (lib/proxy-levers.js
 * `permalinksIn`) can resolve the note the same way it would against a real server. */
function withPermalink(text, rel) {
  return text.replace(/^---\r?\n/, `---\npermalink: ${rel}\n`);
}

/**
 * A tiny fake MCP server answering from `dir` — zero model calls, zero network. Shaped like
 * test/fixtures/fake-memory-mcp.js (the proxy's own test fixture), called in-process instead of
 * over stdio, and returning `{ result }` / `{ error }` the same way.
 */
function makeUpstream(dir) {
  function find(identifier) {
    const id = String(identifier || "").replace(/^memory:\/\//i, "").split("/").pop().replace(/\.md$/i, "");
    if (!id) return null;
    return walkMd(dir).find((f) => path.basename(f, ".md") === id) || null;
  }
  const relOf = (f) => path.relative(dir, f).replace(/\.md$/, "");
  const readFull = (f) => withPermalink(fs.readFileSync(f, "utf8"), relOf(f));

  function call(tool, args) {
    args = args && typeof args === "object" ? args : {};
    const READ = ["read_note", "view_note", "read_content", "fetch", "build_context"];
    if (READ.includes(tool)) {
      const refs = Array.isArray(args.ids) && args.ids.length ? args.ids : [args.identifier || args.id || args.url || args.path].filter(Boolean);
      if (!refs.length) return { result: { content: [{ type: "text", text: "Note not found" }], isError: true } };
      const parts = [];
      for (const ref of refs) {
        const f = find(ref);
        parts.push(f ? readFull(f) : `Note not found: ${ref}`);
      }
      return { result: { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] } };
    }
    if (tool === "search_notes" || tool === "search") {
      let hits;
      if (Array.isArray(args.ids) && args.ids.length) hits = args.ids.map((id) => find(id)).filter(Boolean);
      else {
        const q = String(args.query || "").toLowerCase();
        hits = q ? walkMd(dir).filter((f) => fs.readFileSync(f, "utf8").toLowerCase().includes(q)) : [];
      }
      const text = hits.map((f) => `### ${path.basename(f, ".md")}\npermalink: ${relOf(f)}\nsnippet: ${fs.readFileSync(f, "utf8").trim().split("\n").slice(-1)[0]}`).join("\n\n") || "No results";
      return { result: { content: [{ type: "text", text }] } };
    }
    if (tool === "write_note") {
      const d = path.join(dir, args.directory || "");
      fs.mkdirSync(d, { recursive: true });
      const title = args.title || "untitled";
      fs.writeFileSync(path.join(d, title + ".md"), String(args.content || ""));
      return { result: { content: [{ type: "text", text: `# Created note\npermalink: ${(args.directory ? args.directory + "/" : "") + title}` }] } };
    }
    if (tool === "edit_note") {
      const f = find(args.identifier);
      if (!f) return { result: { content: [{ type: "text", text: `Note not found: ${args.identifier}` }], isError: true } };
      if (args.content) fs.appendFileSync(f, String(args.content));
      return { result: { content: [{ type: "text", text: `# Edited note (${args.operation || "append"})\npermalink: ${relOf(f)}` }] } };
    }
    return { error: { code: -32601, message: "unknown tool " + tool } };
  }
  return { call };
}

// ---------------------------------------------------------------------------------------------
// Events: JSONL or a JSON array of `{ session, tool, args, t }`, or the portal's own
// `{ evenements: [{ type, ids, source, t }] }`.

function normalizeCalls(list) {
  return (list || []).map((e, i) => ({
    session: String((e && e.session) || "default"),
    tool: String((e && e.tool) || ""),
    args: e && e.args && typeof e.args === "object" ? e.args : {},
    t: e && e.t != null ? e.t : i,
  }));
}

/** `{session,tool,args,t}` from the portal's `evenements` (lecture/recherche/ecriture), grouping
 * into sessions by `source` + a silence of more than 30 minutes (see GAP_MS). */
function portalToCalls(evenements) {
  const calls = [];
  let prevSource = null, prevT = null, sessionIdx = 0, key = null;
  for (const ev of evenements || []) {
    const source = String((ev && ev.source) || "unknown");
    const t = Number(ev && ev.t) || 0;
    if (prevSource === null || source !== prevSource || (prevT != null && t - prevT > GAP_MS)) { sessionIdx++; key = `${source}-${sessionIdx}`; }
    prevSource = source; prevT = t;
    const ids = Array.isArray(ev && ev.ids) ? ev.ids.filter((x) => typeof x === "string" && x) : [];
    const type = ev && ev.type;
    if (type === "lecture" && ids[0]) calls.push({ session: key, tool: "read_note", args: { identifier: ids[0] }, t });
    else if (type === "recherche") calls.push({ session: key, tool: "search_notes", args: { query: ids.join(" "), ids }, t });
    else if (type === "ecriture" && ids[0]) calls.push({ session: key, tool: "edit_note", args: { identifier: ids[0], operation: "append", content: "" }, t });
  }
  return calls;
}

function loadEvents(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  let whole;
  try { whole = JSON.parse(raw); } catch { whole = null; }
  if (Array.isArray(whole)) return normalizeCalls(whole);
  if (whole && typeof whole === "object" && Array.isArray(whole.evenements)) return portalToCalls(whole.evenements);
  // JSONL: one JSON object per line.
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  return normalizeCalls(lines);
}

// ---------------------------------------------------------------------------------------------
// Correctness guard (pure, exported, tested on its own in test/bench-replay.test.js)

/**
 * Is the note's full CURRENT text still reachable for the model, given what was just delivered?
 *   - delivered in full just now (`deliveredText` contains `upstreamFull` verbatim) → yes
 *   - delivered in full earlier in this SAME session and unchanged since (`previousFullHash`
 *     equals the note's current hash) → yes
 *   - in the always-loaded context (index note, or a configured `alwaysLoaded` entry) and
 *     unchanged since the session began (`baselineHash` equals the current hash) → yes
 *   - the stub names the escape hatch (`memglow_fresh`, `L.ARG_FRESH`) → yes, the model can ask again
 *   - otherwise → NO: a violation.
 */
function isReachable({ deliveredText, upstreamFull, previousFullHash = null, baselineHash = null }) {
  const currentHash = sha1(upstreamFull);
  const deliveredFull = deliveredText.includes(upstreamFull);
  if (deliveredFull) return { reachable: true, deliveredFull: true, hash: currentHash };
  const reachable = previousFullHash === currentHash || baselineHash === currentHash || deliveredText.includes(L.ARG_FRESH);
  return { reachable, deliveredFull: false, hash: currentHash };
}

/** Note ids a read-kind call targets, resolved through the SAME `index.resolve` the engine uses. */
function idsOfReadCall(args, index) {
  const out = [];
  const add = (ref) => { const id = index.resolve(ref); if (id && !out.includes(id)) out.push(id); };
  if (Array.isArray(args.ids)) for (const r of args.ids) add(r);
  for (const k of ["identifier", "id", "url", "path"]) if (typeof args[k] === "string") add(args[k]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// One configuration, run over the whole event stream.

function namedConfigs(withCombos) {
  const off = Object.fromEntries(LEVER_NAMES.map((n) => [n, false]));
  const list = [{ key: "off", label: "off", flags: off }, { key: "defaults", label: "defaults", flags: { ...SHIPPED_DEFAULTS } }];
  for (const names of withCombos || []) {
    const flags = { ...SHIPPED_DEFAULTS };
    for (const n of names) flags[n] = true;
    list.push({ key: "+" + names.join(","), label: "+" + names.join(","), flags });
  }
  return list;
}

/** One configuration per lever (`--each`): every lever OFF except the one named, so each row is
 * directly comparable to "off" and shows exactly what THAT lever alone adds or saves — unlike the
 * "+lever" rows from `--with` (above), which start from the shipped DEFAULTS. This is what stage
 * 0.4.2.2 used to decide, per lever, whether to keep it as is, shorten its text, or turn it off by
 * default (see lib/proxy-levers.js DEFAULTS and its comment). */
function eachLeverConfigs() {
  const off = Object.fromEntries(LEVER_NAMES.map((n) => [n, false]));
  return LEVER_NAMES.map((name) => ({ key: "alone:" + name, label: name + " (alone)", flags: { ...off, [name]: true } }));
}

function runConfig(flags, events, { memoryDir, alwaysLoaded }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-replay-"));
  const notesDir = path.join(work, "notes");
  copyDir(memoryDir, notesDir);
  const dataDir = path.join(work, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  let configFile = null;
  if (alwaysLoaded && alwaysLoaded.length) {
    configFile = path.join(work, "memglow.config.json");
    fs.writeFileSync(configFile, JSON.stringify({ alwaysLoaded }));
  }
  const env = {
    MEMGLOW_MEMORY_DIR: notesDir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_HOME: dataDir,
    MEMGLOW_LARGE_NOTE_TOKENS: "5000", MEMGLOW_POLL_MS: "500",
    MEMGLOW_PROXY_SAVINGS_FILE: "0", MEMGLOW_PROXY_LOG: "0",
  };
  if (configFile) env.MEMGLOW_CONFIG = configFile;
  for (const name of LEVER_NAMES) env[LEVER_ENV[name]] = flags[name] ? "1" : "0";

  const config = L.proxyConfig(env);
  const index = L.createNoteIndex(config);
  const savings = L.createSavings(config, () => {});
  const engine = L.createLevers({ config, index, savings, serverName: "basic-memory" });
  const upstream = makeUpstream(notesDir);
  const memory = index._memory();

  let nextId = 1, calls = 0, tokensTotal = 0, violations = 0;
  const violationDetails = [];
  const sessions = new Map();

  function sessionState(key) {
    let s = sessions.get(key);
    if (s) return s;
    if (memory) memory.scan();
    const baseline = new Map();
    if (index.available()) {
      for (const id of index.alwaysLoadedIds(config.alwaysLoaded)) {
        const h = index.fileHash(id);
        if (h) baseline.set(id, h);
      }
    }
    s = { fullDelivered: new Map(), baseline };
    sessions.set(key, s);
    return s;
  }

  for (const ev of events) {
    if (memory) memory.scan(); // deterministic: metadata is never stale across a synchronous replay
    const s = sessionState(ev.session);
    const reqId = nextId++;
    const req = { jsonrpc: "2.0", id: reqId, method: "tools/call", params: { name: ev.tool, arguments: ev.args } };
    const afterClient = engine.clientMessage(req, ev.session).msg;
    const upRes = upstream.call(afterClient.params.name, afterClient.params.arguments);
    if (memory) memory.scan(); // a write just happened: see it before the next call
    const resMsg = { jsonrpc: "2.0", id: reqId, ...upRes };
    const afterServer = engine.serverMessage(resMsg, ev.session).msg;
    calls++;

    const contentArr = afterServer.result && Array.isArray(afterServer.result.content) ? afterServer.result.content : [];
    const texts = contentArr.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text);
    const deliveredText = texts.join("\n");
    tokensTotal += texts.reduce((sum, t) => sum + estimateTokens(t), 0);

    if (config.readTools.includes(ev.tool)) {
      for (const id of idsOfReadCall(ev.args, index)) {
        const note = index.note(id);
        if (!note) continue; // unresolved note: nothing on disk to check reachability against
        const rel = memory.fileOf(id);
        if (!rel) continue;
        let upstreamFull;
        try { upstreamFull = withPermalink(fs.readFileSync(path.join(notesDir, rel), "utf8"), rel.replace(/\.md$/i, "")); } catch { continue; }
        const r = isReachable({ deliveredText, upstreamFull, previousFullHash: s.fullDelivered.get(id) || null, baselineHash: s.baseline.get(id) || null });
        if (r.deliveredFull) s.fullDelivered.set(id, r.hash);
        if (!r.reachable) { violations++; violationDetails.push({ session: ev.session, tool: ev.tool, id }); }
      }
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { calls, tokensTotal, violations, violationDetails };
}

function summarize(results, baselineKey = "off") {
  const baseline = results.find((r) => r.key === baselineKey);
  return results.map((r) => {
    const savingsAbs = baseline ? baseline.tokensTotal - r.tokensTotal : null;
    const savingsPct = baseline && baseline.tokensTotal > 0 ? (savingsAbs / baseline.tokensTotal) * 100 : null;
    return { ...r, savingsAbs, savingsPct };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

// Every flag this CLI understands. "--memory" is an alias for "--memory-dir" (the real flag):
// before this stage, typing "--memory" was silently ignored (treated as a bare positional token
// and dropped), running against the DEFAULT memory folder instead of the one the caller meant —
// now it works as an alias, and any OTHER unrecognised flag is a hard error instead of silently
// doing nothing.
const FLAG_ALIASES = { "--memory": "--memory-dir" };

function parseArgs(argv) {
  const o = { memoryDir: DEFAULT_MEMORY, events: DEFAULT_EVENTS, withCombos: [], alwaysLoaded: [], json: false, each: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (Object.prototype.hasOwnProperty.call(FLAG_ALIASES, a)) a = FLAG_ALIASES[a];
    const v = () => argv[++i];
    if (a === "--memory-dir") o.memoryDir = path.resolve(v());
    else if (a === "--events") o.events = path.resolve(v());
    else if (a === "--with") o.withCombos.push(String(v()).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--always-loaded") o.alwaysLoaded.push(...String(v()).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--json") o.json = true;
    else if (a === "--each") o.each = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else o.unknown.push(argv[i]); // the ORIGINAL token (pre-alias), so the error names what was typed
  }
  return o;
}

function printTable(rows) {
  const head = `${"configuration".padEnd(26)}${"calls".padStart(6)}${"tokens".padStart(9)}${"savings vs off".padStart(20)}${"violations".padStart(13)}`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    const savings = r.savingsAbs == null ? "n/a" : `${r.savingsAbs >= 0 ? "+" : ""}${r.savingsAbs} (${r.savingsPct >= 0 ? "+" : ""}${r.savingsPct.toFixed(1)}%)`;
    console.log(`${r.label.padEnd(26)}${String(r.calls).padStart(6)}${String(r.tokensTotal).padStart(9)}${savings.padStart(20)}${String(r.violations).padStart(13)}`);
  }
}

/** `--each`: one line per lever, isolated against "off" — exactly what that lever alone adds or
 * saves on this event file, independent of every other lever's own effect. */
function printEachBreakdown(rows) {
  const alone = rows.filter((r) => r.key.startsWith("alone:"));
  if (!alone.length) return;
  console.log("\nper-lever breakdown (each lever alone, vs off):");
  const head = `${"lever".padEnd(24)}${"tokens added/saved".padStart(20)}${"violations".padStart(13)}`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of alone) {
    const name = r.key.slice("alone:".length);
    const delta = -r.savingsAbs; // positive = this lever ADDS tokens, negative = it SAVES tokens
    const text = delta === 0 ? "0" : `${delta > 0 ? "+" : ""}${delta} ${delta > 0 ? "added" : "saved"}`;
    console.log(`${name.padEnd(24)}${text.padStart(20)}${String(r.violations).padStart(13)}`);
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("usage: node bench/replay.js [--memory-dir <dir> | --memory <dir>] [--events <file>] [--with lever,lever]... [--always-loaded entry,entry] [--each] [--json]");
    return;
  }
  if (o.unknown.length) {
    console.error(`bench/replay: unknown flag${o.unknown.length > 1 ? "s" : ""}: ${o.unknown.join(", ")} — run with --help for the list of flags`);
    process.exitCode = 2; return;
  }
  for (const combo of o.withCombos) for (const n of combo) {
    if (!LEVER_NAMES.includes(n)) { console.error(`bench/replay: unknown lever "${n}" — one of: ${LEVER_NAMES.join(", ")}`); process.exitCode = 2; return; }
  }
  let events;
  try { events = loadEvents(o.events); } catch (e) { console.error("bench/replay: failed to load events: " + (e && e.message || e)); process.exitCode = 2; return; }
  if (!events.length) { console.error("bench/replay: no events to replay"); process.exitCode = 2; return; }

  const configs = [...namedConfigs(o.withCombos), ...(o.each ? eachLeverConfigs() : [])];
  const results = configs.map((c) => ({ key: c.key, label: c.label, ...runConfig(c.flags, events, { memoryDir: o.memoryDir, alwaysLoaded: o.alwaysLoaded }) }));
  const rows = summarize(results);
  const anyViolations = rows.some((r) => r.violations > 0);

  if (o.json) console.log(JSON.stringify({ events: events.length, rows, anyViolations }, null, 2));
  else {
    printTable(rows.filter((r) => !r.key.startsWith("alone:")));
    if (o.each) printEachBreakdown(rows);
    if (anyViolations) console.error("\nbench/replay: CORRECTNESS GUARD FAILED — see violations above");
  }
  process.exitCode = anyViolations ? 1 : 0;
}

if (require.main === module) main();
module.exports = {
  loadEvents, normalizeCalls, portalToCalls, namedConfigs, eachLeverConfigs, runConfig, summarize,
  isReachable, idsOfReadCall, withPermalink, makeUpstream, sha1, parseArgs, LEVER_NAMES, SHIPPED_DEFAULTS, GAP_MS,
};
