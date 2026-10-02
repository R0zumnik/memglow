#!/usr/bin/env node
"use strict";
/**
 * memglow bench — runner. Measures what the MCP proxy levers change for a real assistant (the
 * `claude` CLI, non-interactive) answering factual questions from a TEST memory.
 *
 *   node bench/run.js --check --memory-dir <dir>              # questions ↔ notes sanity check
 *   node bench/run.js --upstream http://<host>:8000/mcp --memory-dir <dir> --out bench/results/x.jsonl \
 *        [--variants A,B,C,D,E] [--reps 2] [--model haiku] [--questions all|q01,q02]
 *        [--budget-run 0.30] [--budget-total 5] [--seed 1]
 *
 * Variants: A = the memory server directly; B = through the proxy, every lever off (control: must
 * match A); C = proxy, default levers (sizeWarning + searchDetails + suggestions); D = C + dedupe;
 * E = C + toc. The (question × variant × repetition) list is shuffled with the seed and run one at
 * a time. Each run is a fresh `claude -p` with: an empty working folder, a clean environment
 * (no CLAUDE_* variable of the calling session), --restricted (no user/project settings, so no
 * hooks), --strict-mcp-config with ONE server named "memory", --tools "" (no built-in tool at all:
 * no shell, no files, no web), only the memory tools allowed and its write tools denied,
 * --no-session-persistence, and --max-budget-usd per run. The run stops when --budget-total is
 * reached. Engine timings come from the proxy's own activity reports (durationMs), received here by
 * a small local stand-in for memglow; variant A has none (no proxy).
 *
 * Point it ONLY at a throw-away memory server on a copy of the test notes (see "How to reproduce" in bench/RESULTS.md).
 * Writes one JSON line per run to --out; bench/analyze.js turns that into tables.
 *
 * --mode sessions (stage 0.4.1): several RELATED questions asked in order inside ONE `claude -p`
 * call (one MCP session, same conversation) instead of one question per call — the only way to
 * measure dedupe/toc/context-reuse, which only do anything across turns of the SAME session.
 * Sessions are grouped by topic in bench/sessions.json (`--sessions <file>` to use another one);
 * each still answers from bench/questions.json's `expect` regexes, now graded per question inside
 * one combined answer. Same flags as above, plus:
 *
 *   node bench/run.js --mode sessions --dry-run [--sessions bench/sessions.json] [--variants A,C] [--reps 2]
 *   node bench/run.js --mode sessions --upstream http://<host>:8000/mcp --memory-dir <dir> \
 *        --out bench/results/sessions.jsonl [--variants A,C,D,E] [--reps 2] [--model haiku]
 *
 * `--dry-run` prints the run plan (sessions × variants × reps) and a cost estimate from the
 * average `costUsd` of past single-question runs recorded in bench/results/*.jsonl — no `claude`
 * call, no proxy, no network. A session's budget is still one `--budget-run` (per call, not per
 * question inside it): raise it for topics with several questions, or watch the first few runs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { mulberry32 } = require("./generate");

const ROOT = path.join(__dirname, "..");
const PROXY = path.join(ROOT, "mcp-proxy", "memglow-mcp-proxy.js");
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8")).questions;
const SERVER = "memory";
const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note", "create_memory_project", "delete_project", "schema_validate", "schema_infer", "schema_diff"];
const PROMPT = (q) => "Answer the question below from the user's notes, which you can reach only through the memory tools. " +
  "Reply with the answer in one short sentence. If the notes do not contain the answer, say that you could not find it.\n\nQuestion: " + q;

const LEVERS_OFF = { MEMGLOW_PROXY_SIZE_WARNING: "0", MEMGLOW_PROXY_SEARCH_DETAILS: "0", MEMGLOW_PROXY_SUGGESTIONS: "0", MEMGLOW_PROXY_DEDUPE: "0", MEMGLOW_PROXY_TOC: "0", MEMGLOW_PROXY_INDEX_WARNING: "0", MEMGLOW_PROXY_ARCHIVE_HINT: "0", MEMGLOW_PROXY_HIDE_UNSUPPORTED: "0" };
const DEFAULTS_ON = { ...LEVERS_OFF, MEMGLOW_PROXY_SIZE_WARNING: "1", MEMGLOW_PROXY_SEARCH_DETAILS: "1", MEMGLOW_PROXY_SUGGESTIONS: "1" };
const VARIANTS = {
  A: { label: "direct (no memglow)", proxy: null },
  B: { label: "proxy, all levers off", proxy: LEVERS_OFF },
  C: { label: "proxy, default levers", proxy: DEFAULTS_ON },
  D: { label: "C + dedupe", proxy: { ...DEFAULTS_ON, MEMGLOW_PROXY_DEDUPE: "1" } },
  E: { label: "C + toc", proxy: { ...DEFAULTS_ON, MEMGLOW_PROXY_TOC: "1" } },
  // H = B + hideUnsupportedTools only (isolates lever 7's own effect against the B control).
  H: { label: "B + hideUnsupportedTools", proxy: { ...LEVERS_OFF, MEMGLOW_PROXY_HIDE_UNSUPPORTED: "1" } },
};

function args(argv) {
  const o = { mode: "single", variants: "A,B,C,D,E", reps: 2, model: "haiku", questions: "all", budgetRun: 0.3, budgetTotal: 5, seed: 1, timeoutS: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--check") o.check = true;
    else if (a === "--upstream") o.upstream = v();
    else if (a === "--memory-dir") o.memoryDir = path.resolve(v());
    else if (a === "--out") o.out = path.resolve(v());
    else if (a === "--variants") o.variants = v();
    else if (a === "--reps") o.reps = Number(v());
    else if (a === "--model") o.model = v();
    else if (a === "--questions") o.questions = v();
    else if (a === "--budget-run") o.budgetRun = Number(v());
    else if (a === "--budget-total") o.budgetTotal = Number(v());
    else if (a === "--seed") o.seed = Number(v());
    else if (a === "--timeout") o.timeoutS = Number(v());
    else if (a === "--spent") o.spent = Number(v()); // already spent by earlier runs (shared global cap)
    else if (a === "--proxy-root") o.proxyRoot = path.resolve(v()); // another memglow checkout (e.g. an older version)
    else if (a === "--tag") o.tag = v(); // free label stored with each record
    else if (a === "--resume") o.resume = true; // skip (question, variant, rep) already completed in --out
    else if (a === "--keep-streams") o.keepStreams = path.resolve(v()); // save each raw stream-json transcript there
    else if (a === "--mode") o.mode = v(); // "single" (default) or "sessions"
    else if (a === "--sessions") o.sessionsFile = path.resolve(v()); // bench/sessions.json by default
    else if (a === "--dry-run") o.dryRun = true; // --mode sessions only: print the plan + cost estimate, no claude call
  }
  return o;
}

function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith(".md")) yield p; } }

/** Each expected answer must be found in its notes; for "large" questions the note must be large. */
function check(memoryDir) {
  const files = new Map([...walk(memoryDir)].map((f) => [path.basename(f, ".md"), fs.readFileSync(f, "utf8")]));
  let bad = 0;
  for (const q of QUESTIONS) {
    const re = new RegExp(q.expect, "i");
    const where = [...files].filter(([, t]) => re.test(t)).map(([id]) => id);
    const holder = q.notes[q.notes.length - 1];
    const okHolder = q.kind === "none" ? true : where.includes(holder);
    const large = q.kind === "large" ? (files.get(holder) || "").length / 4 > 5000 : true;
    const missing = q.notes.filter((n) => !files.has(n));
    const ok = okHolder && large && !missing.length;
    if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} ${q.id} ${q.kind.padEnd(5)} holder=${holder || "-"} matches in: ${where.slice(0, 6).join(", ")}${where.length > 6 ? "…" : ""}${missing.length ? " MISSING " + missing : ""}${large ? "" : " NOT LARGE"}`);
  }
  console.log(`${files.size} notes; ${bad ? bad + " problem(s)" : "all questions consistent"}`);
  return bad;
}

/** A local stand-in for memglow's POST /api/activity: keeps every report with its arrival time. */
function receiver() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { try { got.push({ at: Date.now(), ...JSON.parse(b) }); } catch { /* ignore */ } res.statusCode = 204; res.end(); });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, got, url: `http://127.0.0.1:${srv.address().port}` })));
}

function freePort() {
  return new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

async function startProxy(variant, levers, o, rx, work) {
  const port = await freePort();
  const home = path.join(work, "home-" + variant);
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: home, MEMGLOW_HOME: home, MEMGLOW_URL: rx.url, MEMGLOW_TOKEN: "bench-token-not-secret-0123456789abcdef",
    MEMGLOW_MEMORY_DIR: o.memoryDir, MEMGLOW_DATA_DIR: path.join(home, "data"), MEMGLOW_MACHINE: "bench", ...levers,
  };
  const log = fs.openSync(path.join(work, `proxy-${variant}.log`), "a");
  const p = spawn(process.execPath, [o.proxyRoot ? path.join(o.proxyRoot, "mcp-proxy", "memglow-mcp-proxy.js") : PROXY, "--upstream", o.upstream, "--listen", "127.0.0.1:" + port, "--name", SERVER, "--source", "bench-" + variant.toLowerCase()], { env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((ok) => { const r = http.get(`http://127.0.0.1:${port}/`, () => ok(true)); r.on("error", () => ok(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url: `http://127.0.0.1:${port}/mcp`, proc: p };
}

/** Clean environment for the CLI: no variable of the calling Claude session leaks in. */
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

/** Everything measured from the stream-json transcript. */
function parseStream(out) {
  const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r = { tools: {}, toolCalls: 0, toolResultChars: 0, answer: "", result: null, init: null };
  for (const m of lines) {
    if (m.type === "system" && m.subtype === "init") r.init = { tools: m.tools, mcp: m.mcp_servers, model: m.model };
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_use") { const n = String(c.name).replace(`mcp__${SERVER}__`, ""); r.tools[n] = (r.tools[n] || 0) + 1; r.toolCalls++; }
      }
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

// ---------------------------------------------------------------------------------------------
// --mode sessions: several related questions, one `claude -p` call, one MCP session.

const SESSIONS_FILE_DEFAULT = path.join(__dirname, "sessions.json");

/** Prompt that asks every question of the session in order, graded line by line (see parseSessionAnswer). */
function buildSessionPrompt(questions) {
  const lines = questions.map((q, i) => `Q${i + 1}: ${q.q}`);
  return "You will be asked several related questions in a row, from the user's notes, which you can reach only "
    + "through the memory tools. Answer them IN ORDER, one per line, each starting with \"A<n>: \" where <n> is "
    + "the question number, followed by the answer in one short sentence. Never skip a question: if its answer is "
    + "not in the notes, say on its own line that you could not find it instead of guessing.\n\n" + lines.join("\n");
}

/**
 * Grades a combined session answer against each question's `expect` regex. A line "A<n>: ..." is
 * matched to question n (1-based); a question whose line is missing (the model did not number its
 * answers) falls back to testing its regex against the WHOLE answer — lenient, so a plain assistant
 * that ignores the numbering instruction is not unfairly marked wrong on every question.
 * → { per: [{ id, answered, correct }], correctCount, total }
 */
function parseSessionAnswer(text, questions) {
  const t = String(text || "");
  const byIndex = new Map();
  const re = /^A(\d+)\s*:\s*(.*)$/gim;
  let m;
  while ((m = re.exec(t))) byIndex.set(Number(m[1]), m[2]);
  const per = questions.map((q, i) => {
    const n = i + 1;
    const line = byIndex.has(n) ? byIndex.get(n) : null;
    const correct = new RegExp(q.expect, "i").test(line != null ? line : t);
    return { id: q.id, answered: line != null, correct };
  });
  return { per, correctCount: per.filter((p) => p.correct).length, total: per.length };
}

/** bench/sessions.json (or `file`), resolved against `questions` (bench/questions.json) — throws on an unknown id. */
function loadSessions(file, questions) {
  const raw = JSON.parse(fs.readFileSync(file || SESSIONS_FILE_DEFAULT, "utf8"));
  const byId = new Map((questions || []).map((q) => [q.id, q]));
  const list = Array.isArray(raw.sessions) ? raw.sessions : [];
  return list.map((s) => {
    const ids = Array.isArray(s.questions) ? s.questions : [];
    const qs = ids.map((id) => {
      const q = byId.get(id);
      if (!q) throw new Error(`bench sessions: session "${s.id}" refers to unknown question id "${id}"`);
      return q;
    });
    if (!qs.length) throw new Error(`bench sessions: session "${s.id}" has no questions`);
    return { id: String(s.id), topic: s.topic ? String(s.topic) : String(s.id), questions: qs };
  });
}

/** (session × variant × repetition), shuffled with `seed` — same scheme as the single-question plan. */
function planSessions(sessions, variants, reps, seed) {
  const plan = [];
  for (const s of sessions) for (const v of variants) for (let r = 1; r <= reps; r++) plan.push({ s, v, r });
  const rnd = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  return plan;
}

/** Average `costUsd` of past completed single-question runs in every *.jsonl of `dir` — or null (none found). */
function avgCostPerQuestion(dir = path.join(__dirname, "results")) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  let sum = 0, n = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.exit === 0 && rec.subtype === "success" && typeof rec.costUsd === "number") { sum += rec.costUsd; n++; }
    }
  }
  return n ? { avg: sum / n, samples: n } : null;
}

/** Human-readable plan + cost estimate for `--dry-run` (pure: takes the already-computed plan and avg). */
function formatSessionPlan(plan, avgInfo) {
  const bySession = new Map();
  for (const { s } of plan) if (!bySession.has(s.id)) bySession.set(s.id, { topic: s.topic, questions: s.questions.length, runs: 0 });
  for (const { s } of plan) bySession.get(s.id).runs++;
  const totalQuestionTurns = plan.reduce((sum, { s }) => sum + s.questions.length, 0);
  const lines = [`bench (sessions): ${plan.length} run(s) over ${bySession.size} session(s), ${totalQuestionTurns} question-turns total`];
  for (const [id, e] of bySession) lines.push(`  ${id} (${e.topic}, ${e.questions} question${e.questions === 1 ? "" : "s"}) × ${e.runs} run(s)`);
  if (avgInfo) {
    const estimate = totalQuestionTurns * avgInfo.avg;
    lines.push(`estimated cost ≈$${estimate.toFixed(3)} (avg ≈$${avgInfo.avg.toFixed(4)}/question from ${avgInfo.samples} historical single-question run(s) in bench/results/*.jsonl)`);
  } else {
    lines.push("no historical bench/results/*.jsonl found: cost cannot be estimated — run bench/run.js in single mode first, or set --budget-run/--budget-total and watch the first few runs");
  }
  return lines.join("\n");
}

async function mainSessions(o) {
  // Question ids inside a session always resolve against the FULL set (bench/questions.json);
  // `--questions` here picks which SESSIONS to run, by session id (default: all of them).
  let sessions;
  try { sessions = loadSessions(o.sessionsFile, QUESTIONS); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  if (o.check) { process.exit(o.memoryDir ? (check(o.memoryDir) ? 1 : 0) : 0); }
  if (o.questions !== "all") { const ids = new Set(o.questions.split(",")); sessions = sessions.filter((s) => ids.has(s.id)); }
  const variants = o.variants.split(",").filter((v) => VARIANTS[v]);
  const plan = planSessions(sessions, variants, o.reps, o.seed);
  if (o.dryRun) { console.error(formatSessionPlan(plan, avgCostPerQuestion())); return; }
  if (!o.upstream || !o.memoryDir || !o.out) { console.error("usage: see the header of bench/run.js (--mode sessions)"); process.exit(2); }
  if (check(o.memoryDir)) { console.error("questions and notes disagree: fix before running"); process.exit(1); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-bench-sessions-"));
  const rx = await receiver();
  const endpoints = {}, procs = [];
  for (const v of variants) {
    if (!VARIANTS[v].proxy) { endpoints[v] = o.upstream; continue; }
    const p = await startProxy(v, VARIANTS[v].proxy, o, rx, work);
    endpoints[v] = p.url; procs.push(p.proc);
  }
  const configs = {};
  for (const v of variants) {
    configs[v] = path.join(work, `mcp-${v}.json`);
    fs.writeFileSync(configs[v], JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: endpoints[v] } } }));
  }
  let spent = o.spent || 0, n = 0;
  console.error(`bench (sessions): ${plan.length} runs, model ${o.model}, budget ${o.budgetTotal} $ (already spent ${spent.toFixed(3)} $), work ${work}`);
  for (const { s, v, r } of plan) {
    if (spent >= o.budgetTotal) { console.error(`bench: global budget reached (${spent.toFixed(3)} $) after ${n} runs — stopping`); break; }
    const cwd = fs.mkdtempSync(path.join(work, "cwd-"));
    const from = rx.got.length;
    const res = await runClaude({ prompt: buildSessionPrompt(s.questions), model: o.model, mcpConfig: configs[v], cwd, budget: o.budgetRun, timeoutS: o.timeoutS });
    await new Promise((ok) => setTimeout(ok, 400)); // let the proxy's detached reports land
    const parsed = parseStream(res.out);
    if (o.keepStreams) { fs.mkdirSync(o.keepStreams, { recursive: true }); fs.writeFileSync(path.join(o.keepStreams, `${s.id}-${v}-${r}-${o.model}.jsonl`), res.out); }
    const reports = rx.got.slice(from).filter((x) => x.source === "bench-" + v.toLowerCase());
    const engine = { calls: 0, totalMs: 0, byType: {} };
    for (const x of reports) {
      if (typeof x.durationMs !== "number") continue;
      engine.calls++; engine.totalMs += x.durationMs;
      (engine.byType[x.type] = engine.byType[x.type] || []).push(x.durationMs);
    }
    const grade = parseSessionAnswer(parsed.answer, s.questions);
    const u = (parsed.result && parsed.result.usage) || {};
    const cost = (parsed.result && parsed.result.total_cost_usd) || 0;
    spent += cost; n++;
    const rec = {
      id: s.id, topic: s.topic, questionIds: s.questions.map((q) => q.id), variant: v, rep: r, model: o.model, tag: o.tag || null, t: new Date().toISOString(),
      correct: grade.per.map((p) => p.correct), correctCount: grade.correctCount, total: grade.total,
      answer: parsed.answer.slice(0, 1600),
      costUsd: cost, durationMs: parsed.result ? parsed.result.duration_ms : res.wallMs, apiMs: parsed.result ? parsed.result.duration_api_ms : null, wallMs: res.wallMs,
      turns: parsed.result ? parsed.result.num_turns : null, subtype: parsed.result ? parsed.result.subtype : "no-result", isError: parsed.result ? !!parsed.result.is_error : true,
      tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
      toolCalls: parsed.toolCalls, tools: parsed.tools, toolResultChars: parsed.toolResultChars, engine,
      exit: res.code, stderr: res.code ? res.err.slice(0, 400) : undefined,
    };
    fs.appendFileSync(o.out, JSON.stringify(rec) + "\n");
    console.error(`[${n}/${plan.length}] ${s.id} ${v}#${r} ${grade.correctCount}/${grade.total} correct calls=${rec.toolCalls} in=${rec.tokens.input + rec.tokens.cacheRead + rec.tokens.cacheCreate} out=${rec.tokens.output} ${(rec.durationMs / 1000).toFixed(1)}s $${cost.toFixed(4)} total $${spent.toFixed(3)}`);
    if (rec.exit !== 0 && !rec.toolCalls && !rec.tokens.output) { console.error(`bench: run failed before reaching the model (${rec.answer.slice(0, 120) || rec.stderr || "no output"}) — stopping`); break; }
  }
  for (const p of procs) p.kill("SIGTERM");
  rx.srv.close();
  console.error(`bench (sessions): done, ${n} runs, ${spent.toFixed(3)} $ spent; proxy logs in ${work}`);
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.mode === "sessions") return mainSessions(o);
  if (o.check) process.exit(check(o.memoryDir) ? 1 : 0);
  if (!o.upstream || !o.memoryDir || !o.out) { console.error("usage: see the header of bench/run.js"); process.exit(2); }
  if (check(o.memoryDir)) { console.error("questions and notes disagree: fix before running"); process.exit(1); }
  const qs = o.questions === "all" ? QUESTIONS : QUESTIONS.filter((q) => o.questions.split(",").includes(q.id));
  const variants = o.variants.split(",").filter((v) => VARIANTS[v]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-bench-"));
  const rx = await receiver();
  const endpoints = {};
  const procs = [];
  for (const v of variants) {
    if (!VARIANTS[v].proxy) { endpoints[v] = o.upstream; continue; }
    const p = await startProxy(v, VARIANTS[v].proxy, o, rx, work);
    endpoints[v] = p.url; procs.push(p.proc);
  }
  const configs = {};
  for (const v of variants) {
    configs[v] = path.join(work, `mcp-${v}.json`);
    fs.writeFileSync(configs[v], JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: endpoints[v] } } }));
  }
  let plan = [];
  for (const q of qs) for (const v of variants) for (let r = 1; r <= o.reps; r++) plan.push({ q, v, r });
  const rnd = mulberry32(o.seed);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  if (o.resume && fs.existsSync(o.out)) {
    const done = new Set(fs.readFileSync(o.out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((x) => x.exit === 0 && x.subtype === "success" && x.model === o.model).map((x) => `${x.id}|${x.variant}|${x.rep}`));
    plan = plan.filter(({ q, v, r }) => !done.has(`${q.id}|${v}|${r}`));
  }
  let spent = o.spent || 0, n = 0;
  console.error(`bench: ${plan.length} runs, model ${o.model}, budget ${o.budgetTotal} $ (already spent ${spent.toFixed(3)} $), work ${work}`);
  for (const { q, v, r } of plan) {
    if (spent >= o.budgetTotal) { console.error(`bench: global budget reached (${spent.toFixed(3)} $) after ${n} runs — stopping`); break; }
    const cwd = fs.mkdtempSync(path.join(work, "cwd-"));
    const from = rx.got.length;
    const res = await runClaude({ prompt: PROMPT(q.q), model: o.model, mcpConfig: configs[v], cwd, budget: o.budgetRun, timeoutS: o.timeoutS });
    await new Promise((ok) => setTimeout(ok, 400)); // let the proxy's detached reports land
    const s = parseStream(res.out);
    if (o.keepStreams) { fs.mkdirSync(o.keepStreams, { recursive: true }); fs.writeFileSync(path.join(o.keepStreams, `${q.id}-${v}-${r}-${o.model}.jsonl`), res.out); }
    const reports = rx.got.slice(from).filter((x) => x.source === "bench-" + v.toLowerCase());
    const engine = { calls: 0, totalMs: 0, byType: {} };
    for (const x of reports) {
      if (typeof x.durationMs !== "number") continue;
      engine.calls++; engine.totalMs += x.durationMs;
      (engine.byType[x.type] = engine.byType[x.type] || []).push(x.durationMs);
    }
    const u = (s.result && s.result.usage) || {};
    const cost = (s.result && s.result.total_cost_usd) || 0;
    spent += cost; n++;
    const rec = {
      id: q.id, kind: q.kind, variant: v, rep: r, model: o.model, tag: o.tag || null, proxyRoot: o.proxyRoot ? "other" : null, t: new Date().toISOString(),
      correct: new RegExp(q.expect, "i").test(s.answer), answer: s.answer.slice(0, 600),
      costUsd: cost, durationMs: s.result ? s.result.duration_ms : res.wallMs, apiMs: s.result ? s.result.duration_api_ms : null, wallMs: res.wallMs,
      turns: s.result ? s.result.num_turns : null, subtype: s.result ? s.result.subtype : "no-result", isError: s.result ? !!s.result.is_error : true,
      tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
      modelUsage: s.result ? s.result.modelUsage || null : null,
      toolCalls: s.toolCalls, tools: s.tools, toolResultChars: s.toolResultChars, engine,
      init: n === 1 ? s.init : undefined, exit: res.code, stderr: res.code ? res.err.slice(0, 400) : undefined,
    };
    fs.appendFileSync(o.out, JSON.stringify(rec) + "\n");
    console.error(`[${n}/${plan.length}] ${q.id} ${v}#${r} ${rec.correct ? "OK " : "BAD"} calls=${rec.toolCalls} in=${rec.tokens.input + rec.tokens.cacheRead + rec.tokens.cacheCreate} out=${rec.tokens.output} ${(rec.durationMs / 1000).toFixed(1)}s $${cost.toFixed(4)} total $${spent.toFixed(3)}`);
    // A usage limit of the account (subscription) or any run that never reached the model: stop
    // at once instead of burning through the plan with empty runs.
    if (rec.exit !== 0 && !rec.toolCalls && !rec.tokens.output) { console.error(`bench: run failed before reaching the model (${rec.answer.slice(0, 120) || rec.stderr || "no output"}) — stopping`); break; }
  }
  for (const p of procs) p.kill("SIGTERM");
  rx.srv.close();
  console.error(`bench: done, ${n} runs, ${spent.toFixed(3)} $ spent; proxy logs in ${work}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = {
  parseStream, check, VARIANTS, PROMPT,
  buildSessionPrompt, parseSessionAnswer, loadSessions, planSessions, avgCostPerQuestion, formatSessionPlan, SESSIONS_FILE_DEFAULT,
};
