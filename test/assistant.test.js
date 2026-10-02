"use strict";
// Optional assistant ("the AI proposes, memglow applies"): off by default, access rules, provider
// arguments, strict validation of hostile proposals, diff, one-time confirmation, backup + Undo.
// The AI is ALWAYS a fake `claude` (test/fixtures/fake-claude.js) first on a PATH that holds
// nothing else: the real CLI is never run.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const proposal = require("../lib/assistant/proposal");
const backup = require("../lib/assistant/backup");
const { diffLines } = require("../lib/assistant/diff");
const claudeCode = require("../lib/assistant/providers/claude-code");

const FILLER = Array.from({ length: 12 }, (_, i) => `Line ${i} of filler text that makes this note larger than the threshold.`).join("\n");
const BIG = `---\ntitle: Big note\ntheme: projects\nsubtheme: alpha\npermalink: big\n---\nIntro line about the big note.\n\n## Section A\nKeep this line please.\n${FILLER}\napi_password: hunter2hunter2hunter2\n\n## Section B\nMore about B.\n${FILLER.replace(/Line/g, "Row")}\nSee [[linker]].\n`;
const LINKER = "---\ntheme: knowledge\n---\nDetails are in [[big]].\n";

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeFake(mode = "split") {
  const dir = tmp("memglow-fakeclaude-");
  const src = fs.readFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(path.join(dir, "claude"), src, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mode"), mode);
  return dir;
}
const calls = (fake) => fs.readFileSync(path.join(fake, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function memoryDir({ git = false } = {}) {
  const dir = tmp("memglow-ai-mem-");
  fs.writeFileSync(path.join(dir, "big.md"), BIG);
  fs.writeFileSync(path.join(dir, "linker.md"), LINKER);
  fs.writeFileSync(path.join(dir, "other.md"), "---\ntheme: knowledge\n---\nNothing here.\n");
  if (git) {
    const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q"); g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  }
  return dir;
}

function start({ mode = "split", env = {}, fake = true, git = false, dataDir } = {}) {
  const dir = memoryDir({ git });
  dataDir = dataDir || tmp("memglow-ai-data-");
  const fakeDir = fake ? makeFake(mode) : tmp("memglow-nofake-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1", MEMGLOW_LARGE_NOTE_TOKENS: "200", ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: fakeDir, HOME: os.tmpdir() } });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, fakeDir, port: server.address().port })));
}

function req(port, pathname, { method = "GET", headers = {}, body, host } = {}) {
  return new Promise((ok, ko) => {
    const h = { Host: host || `127.0.0.1:${port}`, ...headers };
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: h, setHost: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* text */ } ok({ status: res.statusCode, body: b, json: j }); });
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
const write = (port, extra = {}) => ({ "Content-Type": "application/json", "X-Memglow": "1", Origin: `http://127.0.0.1:${port}`, ...extra });
const post = (s, action, body, headers) => req(s.port, "/api/assistant/" + action, { method: "POST", headers: headers || write(s.port), body: body || {} });

async function settle(s, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const st = (await req(s.port, "/api/assistant")).json;
    if (st.job && st.job.state !== "running" && st.job.state !== "applying") return st;
    if (Date.now() - t0 > ms) throw new Error("job still running");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ------------------------------------------------------------------ off by default, routes

test("assistant: OFF by default — routes 404 exactly like unknown ones, no panel, no button flag", async () => {
  const dir = memoryDir();
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: tmp("memglow-ai-data-") }, os.tmpdir());
  assert.strictEqual(config.assistant.enabled, false);
  const server = createServer(config, createMemory({ dir, config }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    const unknownGet = await req(port, "/api/nothing");
    const unknownPost = await req(port, "/api/nothing", { method: "POST", headers: write(port), body: "{}" });
    for (const p of ["/api/assistant", "/api/assistant/stream", "/assistant.js"]) {
      const r = await req(port, p);
      assert.strictEqual(r.status, 404, p);
      assert.strictEqual(r.body, unknownGet.body);
    }
    for (const a of ["propose", "confirm", "apply", "undo", "cancel"]) {
      const r = await req(port, "/api/assistant/" + a, { method: "POST", headers: write(port), body: { note: "big" } });
      assert.strictEqual(r.status, 404, a);
      assert.strictEqual(r.body, unknownPost.body);
    }
    const page = (await req(port, "/")).body;
    assert.ok(!page.includes("mg-ai") && !page.includes("assistant.js"), "no panel, no script");
    const cfg = JSON.parse(page.match(/id="memglow-config">([^<]*)</)[1]);
    assert.strictEqual(cfg.assistant, false);
    assert.ok(!fs.readFileSync(path.join(dir, "big.md"), "utf8").includes("part-1"));
  } finally { server.close(); }
});

test("assistant: config file and MEMGLOW_ASSISTANT switch", () => {
  const d = tmp("memglow-ai-cfg-");
  const f = path.join(d, "c.json");
  fs.writeFileSync(f, JSON.stringify({ assistant: { enabled: true, provider: "claude-code", timeoutMinutes: 999, backup: "nope" } }));
  const c = loadConfig({ MEMGLOW_CONFIG: f }, d);
  assert.strictEqual(c.assistant.enabled, true);
  assert.strictEqual(c.assistant.timeoutMinutes, 10);
  assert.strictEqual(c.assistant.backup, "auto");
  assert.strictEqual(loadConfig({ MEMGLOW_CONFIG: f, MEMGLOW_ASSISTANT: "0" }, d).assistant.enabled, false);
  assert.strictEqual(loadConfig({ MEMGLOW_ASSISTANT: "1" }, d).assistant.enabled, true);
});

test("assistant: enabled — panel, script, button flag; `claude` missing → clear message and 503", async () => {
  const s = await start({ fake: false });
  try {
    const page = (await req(s.port, "/")).body;
    assert.ok(page.includes('id="mg-ai"') && /<script src="\/assistant\.js\?v=[0-9a-f]+"><\/script>/.test(page));
    assert.strictEqual(JSON.parse(page.match(/id="memglow-config">([^<]*)</)[1]).assistant, true);
    assert.strictEqual((await req(s.port, "/assistant.js")).status, 200);
    const st = (await req(s.port, "/api/assistant")).json;
    assert.strictEqual(st.available, false);
    assert.match(st.reason, /not found/);
    assert.ok(st.providers.some((p) => p.id === "claude-code" && !p.detected));
    const r = await post(s, "propose", { note: "big" });
    assert.strictEqual(r.status, 503);
  } finally { s.server.close(); }
});

test("assistant: access — foreign host, password, CSRF header and origin", async () => {
  const s = await start();
  try {
    assert.strictEqual((await req(s.port, "/api/assistant", { host: "evil.example" })).status, 403);
    assert.strictEqual((await req(s.port, "/api/assistant/propose", { method: "POST", host: "evil.example", headers: write(s.port, { Origin: "http://evil.example" }), body: { note: "big" } })).status, 403);
    const noHeader = write(s.port); delete noHeader["X-Memglow"];
    assert.strictEqual((await post(s, "propose", { note: "big" }, noHeader)).status, 403);
    assert.strictEqual((await post(s, "propose", { note: "big" }, write(s.port, { Origin: "http://evil.example" }))).status, 403);
    const noOrigin = write(s.port); delete noOrigin.Origin;
    assert.strictEqual((await post(s, "propose", { note: "big" }, noOrigin)).status, 403);
    assert.strictEqual((await post(s, "propose", { note: "big" }, write(s.port, { "Sec-Fetch-Site": "cross-site" }))).status, 403);
    assert.ok(!fs.existsSync(path.join(s.fakeDir, "calls.log")), "nothing was started");
  } finally { s.server.close(); }
  const pw = "correct horse battery";
  const s2 = await start({ env: { MEMGLOW_PASSWORD: pw } });
  try {
    assert.strictEqual((await req(s2.port, "/api/assistant")).status, 401);
    assert.strictEqual((await post(s2, "propose", { note: "big" })).status, 401);
    const auth = "Basic " + Buffer.from("memglow:" + pw).toString("base64");
    assert.strictEqual((await req(s2.port, "/api/assistant", { headers: { Authorization: auth } })).status, 200);
  } finally { s2.server.close(); }
});

// ------------------------------------------------------------------ provider arguments

test("claude-code provider: no tool, no shell, prompt on stdin, never a bypass", async () => {
  const s = await start();
  try {
    const r = await post(s, "propose", { note: "big", extra: "keep API together" });
    assert.strictEqual(r.status, 200, r.body);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job.errors));
    const [c] = calls(s.fakeDir);
    const a = c.argv;
    const after = (flag) => a[a.indexOf(flag) + 1];
    assert.strictEqual(a[0], "-p");
    assert.strictEqual(after("--tools"), "", "no built-in tool");
    assert.ok(a.includes("--strict-mcp-config") && !a.includes("--mcp-config"), "no MCP server");
    assert.ok(a.includes("--restricted"));
    assert.strictEqual(after("--permission-mode"), "dontAsk");
    assert.deepStrictEqual(JSON.parse(after("--settings")).permissions.deny, ["*"]);
    for (const t of ["Bash", "Write", "Edit", "WebFetch"]) assert.ok(a.includes(t), t + " disallowed");
    assert.strictEqual(after("--output-format"), "stream-json");
    assert.ok(a.includes("--verbose") && a.includes("--no-session-persistence"));
    for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--allowedTools", "--add-dir"]) assert.ok(!a.includes(bad), bad);
    assert.ok(!a.some((x) => x.includes("Intro line about the big note")), "note never in argv");
    assert.ok(c.stdin.includes("Intro line about the big note"), "note on stdin");
    assert.ok(c.stdin.includes("<user-request>\nkeep API together\n</user-request>"));
    assert.ok(!c.stdin.includes("hunter2"), "secret-looking line never sent");
    assert.ok(c.stdin.includes("⟦memglow-secret-1⟧"));
    assert.match(after("--system-prompt"), /DATA from the user's notes/);
    assert.ok(c.cwd.startsWith(s.dataDir), "runs in memglow's data folder, not in the notes");
  } finally { s.server.close(); }
});

test("claude-code provider: a tool call, a crash or a huge answer is a failure", async () => {
  for (const mode of ["tool", "fail", "huge"]) {
    const s = await start({ mode });
    try {
      await post(s, "propose", { note: "big" });
      const st = await settle(s);
      assert.strictEqual(st.job.state, "failed", mode);
      assert.ok(st.job.error, mode);
    } finally { s.server.close(); }
  }
});

test("claude-code parser: stream-json deltas and result", () => {
  const p = claudeCode._createParser();
  const ev = p.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ab"}}}\n{"type":"res');
  assert.deepStrictEqual(ev, [{ type: "text", text: "ab" }]);
  const ev2 = p.push('ult","subtype":"success","is_error":false,"result":"{}"}\n');
  assert.strictEqual(ev2[0].type, "result");
  assert.strictEqual(ev2[0].ok, true);
});

// ------------------------------------------------------------------ hostile proposals

test("assistant: hostile or broken proposals are refused, nothing written", async () => {
  const cases = { traversal: /plain file name/, overwrite: /existing note/, lose: /missing from the proposal/, theme: /frontmatter/, badjson: /not a JSON object|not valid JSON/ };
  for (const [mode, re] of Object.entries(cases)) {
    const s = await start({ mode });
    try {
      await post(s, "propose", { note: "big" });
      const st = await settle(s);
      assert.strictEqual(st.job.state, "invalid", mode);
      assert.ok(st.job.errors.some((e) => re.test(e)), mode + ": " + JSON.stringify(st.job.errors));
      assert.strictEqual((await post(s, "confirm", { job: st.job.id })).status, 409, "no token for a refused proposal");
      assert.strictEqual(fs.readFileSync(path.join(s.dir, "big.md"), "utf8"), BIG);
      assert.deepStrictEqual(fs.readdirSync(s.dir).sort(), ["big.md", "linker.md", "other.md"]);
      assert.ok(!fs.existsSync(path.join(path.dirname(s.dir), "evil.md")));
    } finally { s.server.close(); }
  }
});

function ctxFor(dir) {
  return proposal.buildRequest({
    memoryDir: dir, note: { id: "big", rel: "big.md", label: "Big note", theme: "projects", subtheme: "alpha", folder: "" },
    incoming: [{ id: "linker", rel: "linker.md" }], existingIds: ["big", "linker", "other"],
  });
}
function goodProposal(req) {
  const body = req.ctx.maskedBody.split("\n");
  const cut = body.indexOf("## Section B");
  return {
    summary: "Summary.\n[[big-a]]\n[[big-b]]",
    parts: [{ title: "A", file: "big-a.md", content: body.slice(0, cut).join("\n") }, { title: "B", file: "big-b.md", content: body.slice(cut).join("\n") }],
    linkUpdates: [], notes: "",
  };
}

test("proposal validation: unit cases (paths, names, secrets, links, keys)", () => {
  const dir = memoryDir();
  const r = ctxFor(dir);
  const ok = proposal.validate(goodProposal(r), r.ctx);
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  const part = ok.files.find((f) => f.rel === "big-a.md");
  assert.match(part.after, /^---\ntitle: "A"\npart_of: big\ntheme: projects\nsubtheme: alpha\n---\n/, "group copied, no permalink, part_of set for lib\/hub-spoke.js");
  assert.ok(part.after.includes("api_password: hunter2hunter2hunter2"), "secret restored");
  const orig = ok.files.find((f) => f.role === "original");
  assert.ok(orig.after.startsWith("---\ntitle: Big note\ntheme: projects\nsubtheme: alpha\npermalink: big\n---\n"), "frontmatter kept byte for byte");
  const bad = (mut) => { const p = goodProposal(r); mut(p); return proposal.validate(p, r.ctx); };
  for (const f of ["/etc/passwd.md", "sub/x.md", "..md", "x.txt", "", ".hidden.md"]) assert.ok(!bad((p) => { p.parts[0].file = f; }).ok, f);
  assert.ok(!bad((p) => { p.parts[1].file = "BIG-A.md"; }).ok, "duplicate (case-insensitive)");
  assert.ok(!bad((p) => { p.parts[0].file = "Other.md"; }).ok, "existing note");
  assert.ok(!bad((p) => { p.summary = "no links"; }).ok, "summary must link every part");
  assert.ok(!bad((p) => { p.extra = 1; }).ok, "unknown key");
  assert.ok(!bad((p) => { p.parts[0].title = "a\nb"; }).ok, "multi-line title");
  assert.ok(!bad((p) => { p.parts[0].content = p.parts[0].content.replace("⟦memglow-secret-1⟧", ""); }).ok, "secret dropped");
  assert.ok(!bad((p) => { p.parts[1].content += "\n⟦memglow-secret-1⟧"; }).ok, "secret duplicated");
  assert.ok(!bad((p) => { p.parts[1].content += "\n⟦memglow-secret-9⟧"; }).ok, "unknown secret");
  assert.ok(!bad((p) => { p.linkUpdates = [{ note: "other", from: "[[big]]", to: "[[big-a]]" }]; }).ok, "not a linker");
  assert.ok(!bad((p) => { p.linkUpdates = [{ note: "linker", from: "[[other]]", to: "[[big-a]]" }]; }).ok, "from must target the original");
  assert.ok(!bad((p) => { p.linkUpdates = [{ note: "linker", from: "[[big]]", to: "[[elsewhere]]" }]; }).ok, "to must target a part");
  const lu = bad((p) => { p.linkUpdates = [{ note: "linker", from: "[[big]]", to: "[[big-b]]" }]; });
  assert.ok(lu.ok);
  assert.strictEqual(lu.files.find((f) => f.rel === "linker.md").after, "---\ntheme: knowledge\n---\nDetails are in [[big-b]].\n");
  // Tolerance for missing lines.
  const lose = (p) => { p.parts[0].content = p.parts[0].content.replace("Keep this line please.\n", ""); };
  assert.ok(!bad(lose).ok);
  const p2 = goodProposal(r); lose(p2);
  assert.ok(proposal.validate(p2, r.ctx, { allowMissingLines: 1 }).ok);
  // Headings may change level; list markers ignored.
  const p3 = goodProposal(r); p3.parts[1].content = p3.parts[1].content.replace("## Section B", "# Section B");
  assert.ok(proposal.validate(p3, r.ctx).ok);
  assert.throws(() => proposal.parseAnswer("nothing"), /JSON/);
  assert.deepStrictEqual(proposal.parseAnswer("```json\n{\"a\":1}\n```"), { a: 1 });
});

test("diff: hunks, counts, new file", () => {
  const d = diffLines("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nX\ne\nf\ng\nh\n", { context: 1 });
  assert.strictEqual(d.added, 1); assert.strictEqual(d.removed, 1);
  assert.deepStrictEqual(d.hunks[0].lines.map((l) => l.t + l.s), [" c", "-d", "+X", " e"]);
  const n = diffLines(null, "x\ny\n");
  assert.strictEqual(n.added, 2); assert.strictEqual(n.removed, 0);
});

// ------------------------------------------------------------------ confirmation, apply, undo

test("assistant: confirmation token — missing, wrong, expired, reused", async () => {
  const s = await start();
  try {
    await post(s, "propose", { note: "big" });
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed");
    const job = st.job.id;
    assert.ok(st.job.files.some((f) => f.rel === "big-part-1.md" && f.kind === "create"));
    assert.ok(!JSON.stringify(st.job.files).includes("hunter2"), "secret masked in the diff shown");
    assert.ok(!st.job.files.some((f) => f.hunks.some((h) => h.lines.some((l) => /permalink/.test(l.s) && l.t === "+" ))), "no copied permalink");
    assert.strictEqual((await post(s, "apply", { job })).status, 403, "no token");
    assert.strictEqual((await post(s, "apply", { job, token: "0".repeat(64) })).status, 403, "never issued");
    let t = (await post(s, "confirm", { job })).json.token;
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.strictEqual((await post(s, "apply", { job, token: t.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).status, 403, "wrong");
    assert.strictEqual((await post(s, "apply", { job, token: t })).status, 403, "consumed by the wrong attempt");
    t = (await post(s, "confirm", { job })).json.token;
    // Expire it.
    const stopped = s.server; // the token map is internal: age it through Date.now
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60 * 1000;
    try { assert.strictEqual((await post(s, "apply", { job, token: t })).status, 403, "expired"); } finally { Date.now = realNow; }
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "big.md"), "utf8"), BIG, "nothing written so far");
    // A typed "yes" is not a token.
    assert.strictEqual((await post(s, "apply", { job, token: "yes" })).status, 403);
    t = (await post(s, "confirm", { job })).json.token;
    const ok = await post(s, "apply", { job, token: t });
    assert.strictEqual(ok.status, 200, ok.body);
    assert.strictEqual(ok.json.job.state, "applied");
    assert.strictEqual((await post(s, "apply", { job, token: t })).status, 403, "reused");
    assert.ok(stopped);
  } finally { s.server.close(); }
});

test("assistant: apply writes after a COPY backup, Undo restores (and never clobbers a later edit)", async () => {
  const s = await start();
  try {
    await post(s, "propose", { note: "big" });
    const job = (await settle(s)).job.id;
    const t = (await post(s, "confirm", { job })).json.token;
    const r = await post(s, "apply", { job, token: t });
    assert.strictEqual(r.json.job.backup.kind, "copy");
    const big = fs.readFileSync(path.join(s.dir, "big.md"), "utf8");
    assert.ok(big.startsWith("---\ntitle: Big note\n") && big.includes("[[big-part-1]]"));
    const p1 = fs.readFileSync(path.join(s.dir, "big-part-1.md"), "utf8");
    assert.ok(p1.includes("api_password: hunter2hunter2hunter2") && p1.includes("theme: projects"));
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "linker.md"), "utf8"), "---\ntheme: knowledge\n---\nDetails are in [[big-part-2]].\n");
    const bdir = r.json.job.backup.dir;
    assert.ok(bdir.startsWith(path.join(s.dataDir, "backups")));
    assert.strictEqual(fs.readFileSync(path.join(bdir, "files", "big.md"), "utf8"), BIG);
    assert.ok(JSON.parse(fs.readFileSync(path.join(bdir, "job.json"), "utf8")).changes.length >= 3);
    // The user edits a part afterwards: Undo leaves it alone.
    fs.appendFileSync(path.join(s.dir, "big-part-2.md"), "my own edit\n");
    const u = await post(s, "undo", { job });
    assert.strictEqual(u.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "big.md"), "utf8"), BIG);
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "linker.md"), "utf8"), LINKER);
    assert.ok(!fs.existsSync(path.join(s.dir, "big-part-1.md")));
    assert.ok(fs.existsSync(path.join(s.dir, "big-part-2.md")), "edited since: kept");
    assert.deepStrictEqual(u.json.undo.skipped.map((x) => x.rel), ["big-part-2.md"]);
    assert.strictEqual((await post(s, "undo", { job })).status, 409, "once");
  } finally { s.server.close(); }
});

test("assistant: git memory → snapshot commit before writing, Undo from it", async () => {
  const s = await start({ git: true });
  try {
    fs.appendFileSync(path.join(s.dir, "big.md"), "uncommitted line\n");
    await new Promise((r) => setTimeout(r, 600));
    await post(s, "propose", { note: "big" });
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job));
    const job = st.job.id;
    const r = await post(s, "apply", { job, token: (await post(s, "confirm", { job })).json.token });
    assert.strictEqual(r.json.job.backup.kind, "git");
    const log = execFileSync("git", ["log", "--format=%an %s"], { cwd: s.dir, encoding: "utf8" });
    assert.match(log.split("\n")[0], /^memglow memglow: snapshot before assistant job [0-9a-f]{16}$/);
    const before = BIG + "uncommitted line\n";
    assert.strictEqual(execFileSync("git", ["show", "HEAD:big.md"], { cwd: s.dir, encoding: "utf8" }), before);
    await post(s, "undo", { job });
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "big.md"), "utf8"), before);
    assert.ok(!fs.existsSync(path.join(s.dir, "big-part-1.md")));
  } finally { s.server.close(); }
});

test("assistant: backup failure → nothing is written", async () => {
  const s = await start();
  try {
    await post(s, "propose", { note: "big" });
    const job = (await settle(s)).job.id;
    // The data folder becomes unusable: a FILE where the backups folder should be.
    fs.writeFileSync(path.join(s.dataDir, "backups"), "not a folder");
    const r = await post(s, "apply", { job, token: (await post(s, "confirm", { job })).json.token });
    assert.strictEqual(r.status, 500);
    assert.match(r.json.error, /Backup failed, nothing was written/);
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "big.md"), "utf8"), BIG);
    assert.strictEqual(fs.readFileSync(path.join(s.dir, "linker.md"), "utf8"), LINKER);
    assert.deepStrictEqual(fs.readdirSync(s.dir).sort(), ["big.md", "linker.md", "other.md"]);
  } finally { s.server.close(); }
});

test("assistant: a note changed after the proposal → refused, nothing written", async () => {
  const s = await start();
  try {
    await post(s, "propose", { note: "big" });
    const job = (await settle(s)).job.id;
    fs.appendFileSync(path.join(s.dir, "big.md"), "edited meanwhile\n");
    const r = await post(s, "apply", { job, token: (await post(s, "confirm", { job })).json.token });
    assert.strictEqual(r.status, 409);
    assert.ok(!fs.existsSync(path.join(s.dir, "big-part-1.md")));
  } finally { s.server.close(); }
});

test("backup module: copy mode refuses when the data folder is missing", () => {
  const dir = memoryDir();
  assert.throws(() => backup.create({ memoryDir: dir, dataDir: null, jobId: "ab", files: [{ rel: "big.md", kind: "modify", beforeHash: backup.sha(BIG) }] }), /data folder/);
});

// ------------------------------------------------------------------ one job at a time, cancel, rate

test("assistant: one job at a time, cancel, unknown notes, rate limit", async () => {
  const s = await start({ mode: "slow" });
  try {
    assert.strictEqual((await post(s, "propose", { note: "other" })).status, 404, "not a note to split");
    assert.strictEqual((await post(s, "propose", { note: "../etc/passwd" })).status, 404);
    const a = await post(s, "propose", { note: "big" });
    assert.strictEqual(a.status, 200);
    assert.strictEqual((await post(s, "propose", { note: "big" })).status, 409, "busy");
    const st = (await req(s.port, "/api/assistant")).json;
    assert.strictEqual(st.busy, true);
    assert.strictEqual((await post(s, "cancel", { job: a.json.job.id })).status, 200);
    const after = (await req(s.port, "/api/assistant")).json;
    assert.strictEqual(after.job.state, "cancelled");
    let last;
    for (let i = 0; i < 8; i++) {
      last = await post(s, "propose", { note: "big" });
      if (last.status === 200) await post(s, "cancel", { job: last.json.job.id });
    }
    assert.strictEqual(last.status, 429, "starts are rate limited");
  } finally { s.server.close(); }
});

test("assistant: SSE stream reports the job", async () => {
  const s = await start();
  try {
    const events = [];
    await new Promise((ok, ko) => {
      const r = http.request({ host: "127.0.0.1", port: s.port, path: "/api/assistant/stream", headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
        assert.strictEqual(res.headers["content-type"], "text/event-stream; charset=utf-8");
        res.setEncoding("utf8");
        res.on("data", (d) => {
          events.push(d);
          if (/"state":"proposed"/.test(events.join(""))) { res.destroy(); ok(); }
        });
        post(s, "propose", { note: "big" });
      });
      r.on("error", ko);
      r.end();
    });
    assert.match(events.join(""), /event: job/);
  } finally { s.server.close(); }
});

// ------------------------------------------------------------------ panel rendering (no browser)

test("assistant panel: rendering escapes note and AI text, Apply only on a proposal", () => {
  const ui = require("../public/assistant.js");
  const evil = '<img src=x onerror="alert(1)">';
  const job = {
    id: "0123456789abcdef", state: "proposed", note: { id: "big", label: evil }, notes: evil, warnings: [evil],
    gain: { before: 1200, summary: 100, saved: 1100, parts: [{ id: evil, tokens: 600 }] },
    files: [{ rel: "big.md", kind: "modify", role: "original", added: 1, removed: 1, hunks: [{ lines: [{ t: "-", s: evil }, { t: "+", s: "ok" }] }] }],
  };
  const html = ui.aiRenderJob(job, "Claude Code");
  assert.ok(!html.includes("<img"), "escaped");
  assert.ok(html.includes('data-ai="apply"'));
  const invalid = ui.aiRenderJob({ ...job, state: "invalid", errors: [evil] });
  assert.ok(!invalid.includes('data-ai="apply"') && !invalid.includes("<img"));
  assert.ok(ui.aiRenderJob({ ...job, state: "applied", backup: { kind: "copy", dir: "/d" } }).includes('data-ai="undo"'));
  assert.strictEqual(ui.aiRenderJob(null), "");
  assert.ok(!ui.aiAskForm("big", evil).includes("<img"));
  assert.ok(!ui.aiRenderProviders([{ id: "x", label: evil, implemented: false }], "x").includes("<img"));
});

test("cost panel: the 'Do it with Claude' button exists only when the assistant is on", () => {
  const cost = require("../public/cost.js");
  const c = { read: { today: 0, days7: 0 }, written: { days7: 0 }, totals: { tokens: 1, notes: 1 }, index: null, share: null, top: [], largeNoteTokens: 200, chunkTokens: 100,
    tooLarge: [{ id: "big", label: "Big", theme: "projects", tokens: 900, sections: [], split: null }], neverRead: { available: false } };
  assert.ok(!cost.costRender(c, {}).includes("data-assist"));
  cost.setAssistant(true);
  try { assert.ok(cost.costRender(c, {}).includes('data-assist="big"')); } finally { cost.setAssistant(false); }
});
