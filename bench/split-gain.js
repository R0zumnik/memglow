#!/usr/bin/env node
"use strict";
/**
 * memglow bench — split gain. Measures what memglow's note-splitting suggestion (lib/cost.js:
 * sectionsOf / packSections, the same grouping the "Memory cost" panel and the assistant's split
 * proposal use) actually saves a real assistant reading the memory, in tokens, tool calls, time,
 * cost and correctness — for the questions that touch a note big enough to be split.
 *
 *   node bench/split-gain.js --out bench/results/split-gain.jsonl [--budget-total 1.5] [--reps 2]
 *        [--model haiku] [--seed 1] [--questions all|q01,s01] [--dry-run]
 *
 * Two memory conditions, one disposable copy of the SAME 225 fictional notes
 * (bench/generate.js, seed 42):
 *   BEFORE — untouched: 9 notes over 5,000 tokens, as generated.
 *   AFTER  — the 9 large notes split by splitLargeNotes() below: sections (lib/cost.js
 *            sectionSpans) packed into parts of <= ~2,000 tokens (same rule as
 *            lib/cost.js packSections / the chunk size lib/assistant/proposal.js suggests to the
 *            AI), each part written as its own note (title/theme/subtheme copied from the
 *            original, same folder), the original note rewritten to a short summary that links to
 *            every part. This is applied by CODE, deterministically — no AI, no cost, reproducible
 *            byte-for-byte — unlike the real split feature (lib/assistant/), which asks an AI to
 *            propose the parts and memglow only validates and writes them. Content safety is
 *            checked the same way proposal.js's validator does: every non-blank line of the
 *            original body must reappear, once, in a part (checked below, not just assumed from
 *            the fact that section spans partition the body).
 *   Original note ids/filenames are KEPT (only their body changes, to the summary) — exactly what
 *   lib/assistant/proposal.js does for the real feature — so every existing [[link]] to a split
 *   note keeps resolving, with no rewrite needed. No `linkUpdates` are produced either: the real
 *   feature only redirects a link when the AI judges a specific part is the better target, which
 *   is optional there too (`[]` is a valid answer) and out of scope for a deterministic, AI-free
 *   split.
 *
 * Memory server: a Node-only, in-process, streamable-HTTP stand-in for basic-memory
 * (startFakeMemory below) — this sandbox has no docker/uvx/python3, so the real
 * ghcr.io/basicmachines-co/basic-memory container used by the rest of bench/ could not be started
 * (checked: `which docker uvx python3` all empty). Like the hideUnsupportedTools mini-bench
 * documented in bench/RESULTS.md, this is a LIMITATION of this run's sandbox, not a change to the
 * protocol: read_note / search_notes (plain case-insensitive substring search, not basic-memory's
 * real SQLite full-text ranking) plus the same always-listed, always-erroring ChatGPT-only
 * `search` / `fetch` pair (ported from basic-memory 0.23's chatgpt_tools.py, same as
 * test/fixtures/fake-memory-mcp.js) over a throw-away copy of the generated notes, and the same
 * `structuredContent` wrapping real basic-memory (FastMCP's wrap_result) uses, which is what the
 * v0.4 proxy fix in this report's main results depends on. Absolute numbers here are therefore
 * NOT comparable to the Haiku table in bench/RESULTS.md (different search quality, no real FTS);
 * only the BEFORE vs AFTER comparison WITHIN this run — same stand-in, same notes, same questions,
 * only the memory changed — is meaningful. The real production basic-memory-server container and
 * the real memory are never touched by this script.
 *
 * Proxy levers: fixed at the C defaults (sizeWarning + searchDetails + suggestions on; dedupe and
 * toc off) on BOTH conditions — only the memory changes, per the task. Client: the real `claude -p`
 * CLI, restricted, Haiku only, same flags as bench/run.js (empty working folder, clean environment,
 * --strict-mcp-config, one memory server, write tools disallowed, --no-session-persistence,
 * --max-budget-usd per run). Budget: a hard total cap (default $1.50): the plan is shuffled and run
 * one call at a time, and the run stops the moment the cap is reached or a call fails before
 * reaching the model (account usage limit) — see bench/RESULTS.md's hideUnsupportedTools section
 * for the same honest-partial-completion approach.
 *
 * Writes one JSON line per run to --out (bench/analyze-style fields, plus `cond`: "before"|"after").
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { mulberry32 } = require("./generate");
const costLib = require("../lib/cost");

const ROOT = path.join(__dirname, "..");
const PROXY = path.join(ROOT, "mcp-proxy", "memglow-mcp-proxy.js");
const GENERATE = path.join(__dirname, "generate.js");
const SERVER = "memory";
const CHUNK_TOKENS = 2000;
const LARGE_TOKENS = 5000;
const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note", "create_memory_project", "delete_project", "schema_validate", "schema_infer", "schema_diff"];
const PROMPT = (q) => "Answer the question below from the user's notes, which you can reach only through the memory tools. " +
  "Reply with the answer in one short sentence. If the notes do not contain the answer, say that you could not find it.\n\nQuestion: " + q;
// Default levers (C in bench/run.js): sizeWarning + searchDetails + suggestions on, dedupe/toc off.
const LEVERS_C = {
  MEMGLOW_PROXY_SIZE_WARNING: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_PROXY_SUGGESTIONS: "1",
  MEMGLOW_PROXY_DEDUPE: "0", MEMGLOW_PROXY_TOC: "0", MEMGLOW_PROXY_INDEX_WARNING: "0",
  MEMGLOW_PROXY_ARCHIVE_HINT: "0", MEMGLOW_PROXY_HIDE_UNSUPPORTED: "0",
};

function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".md")) yield p; } }
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
function norm(line) {
  return String(line).trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "").replace(/\s+/g, " ").trim();
}
function lineBag(text) {
  const m = new Map();
  for (const l of String(text).split("\n")) { const n = norm(l); if (!n) continue; m.set(n, (m.get(n) || 0) + 1); }
  return m;
}

/**
 * Deterministic split of every note over `largeTokens` tokens in `dir`, in place: sections (cut the
 * same way lib/cost.js sectionSpans does) are packed, in order, into parts of at most `chunkTokens`
 * tokens (same greedy rule as lib/cost.js packSections), each written as `<id>-partN.md` next to the
 * original with the original's `theme`/`subtheme` frontmatter lines copied verbatim; the original
 * note is rewritten to a short summary linking to every part. Verifies first that every non-blank
 * line of the original body reappears in the parts (normalized the same way
 * lib/assistant/proposal.js's validator does), and throws if any content would be lost — nothing is
 * written for a note that fails the check. Returns [{ id, beforeTokens, summaryTokens, parts: [{id,
 * tokens}] }] for the notes actually split.
 */
function splitLargeNotes(dir, { largeTokens = LARGE_TOKENS, chunkTokens = CHUNK_TOKENS } = {}) {
  const out = [];
  for (const f of [...walk(dir)]) {
    const raw = fs.readFileSync(f, "utf8");
    if (costLib.estimateTokens(raw) <= largeTokens) continue;
    const fmM = FRONTMATTER_RE.exec(raw);
    const fm = fmM ? fmM[0] : "";
    const body = raw.slice(fm.length);
    const spans = costLib.sectionSpans(body);
    if (spans.length < 2) continue; // no heading to cut on: nothing to split
    const groups = [];
    let cur = null;
    for (const s of spans) {
      if (cur && cur.tokens + s.tokens <= chunkTokens) { cur.spans.push(s); cur.tokens += s.tokens; }
      else { cur = { spans: [s], tokens: s.tokens }; groups.push(cur); }
    }
    if (groups.length < 2) continue; // already fits in one chunk-sized part
    const id = path.basename(f, ".md");
    const folder = path.dirname(f);
    const titleM = /^title:\s*(.*)$/m.exec(fm);
    const title = titleM ? titleM[1].trim() : id;
    const groupFmLines = fm.split(/\r?\n/).filter((l) => /^\s*(theme|subtheme|sous_theme):/.test(l));

    const parts = groups.map((g, i) => ({
      n: i + 1, slug: `${id}-part${i + 1}`,
      titles: g.spans.map((s) => s.title || "(introduction)"),
      text: g.spans.map((s) => body.slice(s.start, s.end)).join(""),
    }));

    // No content lost: every non-blank normalized line of the original body must appear in the
    // parts at least as many times as in the body (parts only ADD boilerplate frontmatter, never
    // drop a body line).
    const before = lineBag(body);
    const after = lineBag(parts.map((p) => p.text).join("\n"));
    const missing = [];
    for (const [l, c] of before) { const have = after.get(l) || 0; for (let k = have; k < c; k++) missing.push(l); }
    if (missing.length) throw new Error(`splitLargeNotes: ${id} would lose ${missing.length} line(s), e.g. ${JSON.stringify(missing[0].slice(0, 80))}`);

    for (const p of parts) {
      const partFm = ["---", `title: ${JSON.stringify(title + " — part " + p.n)}`].concat(groupFmLines, ["---", ""]).join("\n");
      const content = partFm + "\n" + p.text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "") + "\n";
      fs.writeFileSync(path.join(folder, p.slug + ".md"), content);
    }
    const summaryBody = `# ${title}\n\nThis note was split into ${parts.length} parts for easier reading:\n\n` +
      parts.map((p) => `- [[${p.slug}]] — ${p.titles.join(", ")}`).join("\n") + "\n";
    const newOriginal = fm + (fm && !/\n\s*$/.test(fm) ? "\n" : "") + summaryBody;
    fs.writeFileSync(f, newOriginal);
    out.push({
      id, beforeTokens: costLib.estimateTokens(raw), summaryTokens: costLib.estimateTokens(newOriginal),
      parts: parts.map((p) => ({ id: p.slug, tokens: costLib.estimateTokens(fs.readFileSync(path.join(folder, p.slug + ".md"), "utf8")) })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fake memory server (see header comment): streamable-HTTP, in-process, one per condition.
// ---------------------------------------------------------------------------------------------
function startFakeMemory(memoryDir) {
  const files = () => [...walk(memoryDir)];
  function find(identifier) {
    const id = String(identifier || "").replace(/^memory:\/\//, "").split("/").pop().replace(/\.md$/, "");
    return files().find((f) => path.basename(f, ".md") === id) || null;
  }
  const text = (t) => ({ content: [{ type: "text", text: t }], structuredContent: { result: t } });
  const strict = (props, required) => ({ type: "object", properties: props, required, additionalProperties: false });
  const TOOLS = [
    { name: "read_note", description: "Read a note", inputSchema: strict({ identifier: { type: "string" }, page: { type: "integer" } }, ["identifier"]) },
    { name: "search_notes", description: "Search notes", inputSchema: strict({ query: { type: "string" } }, []) },
    { name: "build_context", description: "Context", inputSchema: strict({ url: { type: "string" } }, ["url"]) },
    { name: "list_directory", description: "List", inputSchema: strict({ dir_name: { type: "string" } }, []) },
    { name: "write_note", description: "Write", inputSchema: strict({ title: { type: "string" }, content: { type: "string" }, directory: { type: "string" } }, ["title", "content", "directory"]) },
    { name: "edit_note", description: "Edit", inputSchema: strict({ identifier: { type: "string" }, operation: { type: "string" }, content: { type: "string" } }, ["identifier", "operation", "content"]) },
    // Always listed, always "Unsupported MCP client" to a non-OpenAI caller — basic-memory 0.23's
    // own behaviour (chatgpt_tools.py), ported to test/fixtures/fake-memory-mcp.js. hideUnsupportedTools
    // is off on both conditions here, so both sides pay the same wasted-call tax (observation 5 of
    // the main report), symmetrically.
    { name: "search", description: "ChatGPT-compatible search", inputSchema: strict({ query: { type: "string" } }, ["query"]) },
    { name: "fetch", description: "ChatGPT-compatible fetch", inputSchema: strict({ id: { type: "string" } }, ["id"]) },
  ];
  function call(name, args) {
    if (name === "read_note" || name === "build_context") {
      const f = find(args.identifier || args.url);
      if (!f) return { result: { content: [{ type: "text", text: `Note not found: ${args.identifier || args.url}` }], isError: true } };
      const rel = path.relative(memoryDir, f).replace(/\.md$/, "");
      return { result: text(fs.readFileSync(f, "utf8").replace(/^---\n/, `---\npermalink: ${rel}\n`)) };
    }
    if (name === "search_notes") {
      const q = String(args.query || "").toLowerCase();
      const hits = files().filter((f) => fs.readFileSync(f, "utf8").toLowerCase().includes(q));
      return { result: text(hits.map((f) => `### ${path.basename(f, ".md")}\npermalink: ${path.relative(memoryDir, f).replace(/\.md$/, "")}\nsnippet: ${fs.readFileSync(f, "utf8").trim().split("\n").slice(-1)[0]}`).join("\n\n") || "No results") };
    }
    if (name === "list_directory") return { result: text("people/alice.md\nprojects/big.md") };
    if (name === "search" || name === "fetch") return { result: { results: [], error: "Unsupported MCP client", content: [{ type: "text", text: "Unsupported MCP client" }] } };
    if (name === "write_note" || name === "edit_note") return { error: { code: -32601, message: "write tools are disallowed in this bench" } };
    return { error: { code: -32601, message: "unknown tool " + name } };
  }
  const server = http.createServer((req, res) => {
    if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "not supported" }, id: null })); return; }
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      let msg; try { msg = JSON.parse(b); } catch { res.writeHead(400).end(); return; }
      const sid = req.headers["mcp-session-id"] || "fake-session";
      const send = (obj) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sid }); res.end(JSON.stringify(obj)); };
      if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "memglow-bench-fake-memory", version: "0.0.0" } } });
      if (msg.id == null) { res.writeHead(202).end(); return; } // a notification (e.g. notifications/initialized): no response body
      if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      if (msg.method === "tools/call") return send({ jsonrpc: "2.0", id: msg.id, ...call(msg.params.name, msg.params.arguments || {}) });
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

function freePort() { return new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); }); }

/** A local stand-in for memglow's POST /api/activity (same as bench/run.js's receiver()). */
function receiver() {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { got.push({ at: Date.now(), ...JSON.parse(b) }); } catch { /* ignore */ } res.statusCode = 204; res.end(); }); });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function startProxy(cond, upstreamUrl, rx, work) {
  const port = await freePort();
  const home = path.join(work, "home-" + cond);
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, MEMGLOW_HOME: home, MEMGLOW_URL: rx.url, MEMGLOW_TOKEN: "bench-token-not-secret-0123456789abcdef", MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_MACHINE: "bench", ...LEVERS_C };
  const log = fs.openSync(path.join(work, `proxy-${cond}.log`), "a");
  const p = spawn(process.execPath, [PROXY, "--upstream", upstreamUrl, "--listen", "127.0.0.1:" + port, "--name", SERVER, "--source", "split-" + cond], { env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((ok) => { const r = http.get(`http://127.0.0.1:${port}/`, () => ok(true)); r.on("error", () => ok(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url: `http://127.0.0.1:${port}/mcp`, proc: p };
}

function cleanEnv() {
  const env = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "TZ", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function runClaude({ prompt, model, mcpConfig, cwd, budget, timeoutS }) {
  const argv = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", model,
    "--mcp-config", mcpConfig, "--strict-mcp-config", "--tools", "",
    "--allowedTools", "mcp__" + SERVER, "--disallowedTools", ...WRITE_TOOLS.map((t) => `mcp__${SERVER}__${t}`),
    "--permission-mode", "dontAsk", "--no-session-persistence", "--max-budget-usd", String(budget),
    "--restricted", "--disable-slash-commands"];
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn("claude", argv, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), timeoutS * 1000);
    p.on("close", (code) => { clearTimeout(timer); ok({ code, out, err, wallMs: Date.now() - t0 }); });
  });
}

function parseStream(out) {
  const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r = { tools: {}, toolCalls: 0, toolResultChars: 0, answer: "", result: null, init: null };
  for (const m of lines) {
    if (m.type === "system" && m.subtype === "init") r.init = { tools: m.tools, mcp: m.mcp_servers, model: m.model };
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) if (c.type === "tool_use") { const n = String(c.name).replace(`mcp__${SERVER}__`, ""); r.tools[n] = (r.tools[n] || 0) + 1; r.toolCalls++; }
    }
    if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type !== "tool_result") continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: "text", text: String(c.content || "") }];
        for (const x of parts) if (x && x.type === "text") r.toolResultChars += String(x.text).length;
      }
    }
    if (m.type === "result") r.result = m;
  }
  if (r.result) r.answer = String(r.result.result || "");
  return r;
}

function loadQuestions(which) {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8")).questions;
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, "split-gain-questions.json"), "utf8")).questions.map((q) => ({ ...q, isNew: true }));
  const all = base.concat(extra);
  if (which === "all" || !which) return all;
  const ids = new Set(which.split(","));
  return all.filter((q) => ids.has(q.id));
}

/** Every question's holder note must contain the expected answer, and be large when kind=="large". */
function sanityCheck(memoryDir, questions) {
  const filesByBase = new Map([...walk(memoryDir)].map((f) => [path.basename(f, ".md"), fs.readFileSync(f, "utf8")]));
  let bad = 0;
  for (const q of questions) {
    const re = new RegExp(q.expect, "i");
    const holder = q.notes[q.notes.length - 1];
    if (q.kind === "none") continue;
    const t = filesByBase.get(holder);
    const ok = t != null && re.test(t) && (q.kind !== "large" || costLib.estimateTokens(t) > LARGE_TOKENS);
    if (!ok) { bad++; console.error(`BAD ${q.id}: holder=${holder} missing=${t == null} matches=${t != null && re.test(t)}`); }
  }
  return bad;
}

function args(argv) {
  const o = { out: path.join(__dirname, "results", "split-gain.jsonl"), budgetTotal: 1.5, budgetRun: 0.05, reps: 2, model: "haiku", seed: 1, timeoutS: 300, questions: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--out") o.out = path.resolve(v());
    else if (a === "--budget-total") o.budgetTotal = Number(v());
    else if (a === "--budget-run") o.budgetRun = Number(v());
    else if (a === "--reps") o.reps = Number(v());
    else if (a === "--model") o.model = v();
    else if (a === "--seed") o.seed = Number(v());
    else if (a === "--timeout") o.timeoutS = Number(v());
    else if (a === "--questions") o.questions = v();
    else if (a === "--spent") o.spent = Number(v());
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--keep") o.keep = true; // keep the temp memory copies and servers' logs afterwards
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const questions = loadQuestions(o.questions);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-split-bench-"));
  const beforeDir = path.join(work, "before");
  const afterDir = path.join(work, "after");
  console.error(`split-gain: generating test notes (seed 42) in ${work}`);
  const gen = spawnSync(process.execPath, [GENERATE, beforeDir, "--seed", "42"], { encoding: "utf8" });
  if (gen.status !== 0) { console.error(gen.stderr || gen.stdout); process.exit(1); }
  console.error(gen.stdout.trim());
  fs.cpSync(beforeDir, afterDir, { recursive: true });
  const splits = splitLargeNotes(afterDir);
  console.error(`split-gain: split ${splits.length} large note(s):`);
  for (const s of splits) console.error(`  ${s.id}: ${s.beforeTokens} -> summary ${s.summaryTokens} + ${s.parts.length} part(s) [${s.parts.map((p) => p.tokens).join(", ")}]`);
  fs.writeFileSync(path.join(work, "splits.json"), JSON.stringify(splits, null, 2));

  const badBefore = sanityCheck(beforeDir, questions);
  const badAfter = sanityCheck(afterDir, questions); // parts still contain the facts verbatim
  if (badBefore) { console.error(`split-gain: ${badBefore} question(s) disagree with the BEFORE notes — aborting`); process.exit(1); }
  console.error(`split-gain: ${questions.length} questions sanity-checked (before: ok; after: ${badAfter} no longer match a single file verbatim by design, expected for split notes whose holder is now a summary — see splits.json)`);

  if (o.dryRun) { console.error("split-gain: --dry-run, stopping before any claude call"); fs.rmSync(work, { recursive: true, force: true }); return; }

  const rx = await receiver();
  const fakeBefore = await startFakeMemory(beforeDir);
  const fakeAfter = await startFakeMemory(afterDir);
  const proxyBefore = await startProxy("before", fakeBefore.url, rx, work);
  const proxyAfter = await startProxy("after", fakeAfter.url, rx, work);
  const configs = {
    before: path.join(work, "mcp-before.json"),
    after: path.join(work, "mcp-after.json"),
  };
  fs.writeFileSync(configs.before, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: proxyBefore.url } } }));
  fs.writeFileSync(configs.after, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: proxyAfter.url } } }));

  let plan = [];
  for (const q of questions) for (const cond of ["before", "after"]) for (let r = 1; r <= o.reps; r++) plan.push({ q, cond, r });
  const rnd = mulberry32(o.seed);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  fs.mkdirSync(path.dirname(o.out), { recursive: true });

  let spent = o.spent || 0, n = 0;
  console.error(`split-gain: ${plan.length} runs planned, model ${o.model}, budget $${o.budgetTotal} (already spent $${spent.toFixed(3)})`);
  for (const { q, cond, r } of plan) {
    if (spent >= o.budgetTotal) { console.error(`split-gain: budget reached ($${spent.toFixed(3)}) after ${n} runs — stopping`); break; }
    const cwd = fs.mkdtempSync(path.join(work, "cwd-"));
    const res = await runClaude({ prompt: PROMPT(q.q), model: o.model, mcpConfig: configs[cond], cwd, budget: o.budgetRun, timeoutS: o.timeoutS });
    await new Promise((ok) => setTimeout(ok, 300));
    const s = parseStream(res.out);
    const u = (s.result && s.result.usage) || {};
    const cost = (s.result && s.result.total_cost_usd) || 0;
    spent += cost; n++;
    const rec = {
      id: q.id, kind: q.kind, isNew: !!q.isNew, cond, rep: r, model: o.model, t: new Date().toISOString(),
      correct: new RegExp(q.expect, "i").test(s.answer), answer: s.answer.slice(0, 600),
      costUsd: cost, durationMs: s.result ? s.result.duration_ms : res.wallMs, apiMs: s.result ? s.result.duration_api_ms : null,
      turns: s.result ? s.result.num_turns : null, subtype: s.result ? s.result.subtype : "no-result", isError: s.result ? !!s.result.is_error : true,
      tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
      toolCalls: s.toolCalls, tools: s.tools, toolResultChars: s.toolResultChars,
      exit: res.code, stderr: res.code ? res.err.slice(0, 400) : undefined,
    };
    fs.appendFileSync(o.out, JSON.stringify(rec) + "\n");
    console.error(`[${n}/${plan.length}] ${q.id} ${cond}#${r} ${rec.correct ? "OK " : "BAD"} calls=${rec.toolCalls} in=${rec.tokens.input + rec.tokens.cacheRead + rec.tokens.cacheCreate} out=${rec.tokens.output} resChars=${rec.toolResultChars} ${(rec.durationMs / 1000).toFixed(1)}s $${cost.toFixed(4)} total $${spent.toFixed(3)}`);
    if (rec.exit !== 0 && !rec.toolCalls && !rec.tokens.output) { console.error(`split-gain: run failed before reaching the model (${rec.answer.slice(0, 120) || rec.stderr || "no output"}) — stopping immediately (usage limit?)`); break; }
  }
  proxyBefore.proc.kill("SIGTERM"); proxyAfter.proc.kill("SIGTERM");
  rx.srv.close(); fakeBefore.server.close(); fakeAfter.server.close();
  console.error(`split-gain: done, ${n} runs, $${spent.toFixed(3)} spent; temp memory in ${work}`);
  if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`split-gain: --keep passed, not deleting ${work}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { splitLargeNotes, startFakeMemory, loadQuestions, sanityCheck, parseStream };
