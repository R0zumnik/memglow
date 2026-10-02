"use strict";
// "Tidy into hub and spoke" (lib/hub-spoke.js detection, lib/assistant/tidy.js fixes), end to end
// through the same job machinery as split/regroup/archive: propose → diff → confirm → apply →
// Undo. The AI is ALWAYS the fake `claude` of test/fixtures/fake-claude.js (mode "tidy"), never
// the real CLI — and the deterministic fixes need no AI call at all.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeFake(mode = "tidy") {
  const dir = tmp("memglow-fakeclaude-tidy-");
  const src = fs.readFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(path.join(dir, "claude"), src, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mode"), mode);
  return dir;
}

// Same shape validated note by note in test/hub-spoke.test.js: one real hub ("project-x") with
// three sub-notes, one of them already redundant in the index, a pure "Siblings:" line, an
// ambiguous cross-link inside prose, a missing uplink and a missing hub line — plus a stand-alone
// note that must stay exactly as it is.
function hubSpokeMemory() {
  const dir = tmp("memglow-tidy-mem-");
  const write = (name, body) => fs.writeFileSync(path.join(dir, name + ".md"), body);
  write("index", [
    "# Memory index",
    "- [[project-x]]: summary of the project.",
    "- [[project-x-api]]: the API part (redundant with project-x).",
    "- [[standalone-note]]: a note on its own.",
  ].join("\n") + "\n");
  write("project-x", [
    "Summary of project X.",
    "- [[project-x-api]]: the API design.",
    "- [[project-x-infra]]: infrastructure notes.",
    "- [[project-x-orphan]]: never links back (missing uplink).",
  ].join("\n") + "\n");
  write("project-x-api", [
    "The API design.",
    "Back to [[project-x]].",
    "Siblings: [[project-x-orphan]], [[project-x-unlisted]]",
  ].join("\n") + "\n");
  write("project-x-infra", [
    "Infrastructure notes.",
    "Back to [[project-x]].",
    "As discussed in [[project-x-orphan]] and [[project-x-unlisted]], the deploy pipeline reuses the same cluster.",
  ].join("\n") + "\n");
  write("project-x-orphan", "Some content with no backlink at all.\n");
  write("project-x-unlisted", ["This note is about project X.", "See [[project-x]] for the summary."].join("\n") + "\n");
  write("standalone-note", ["Just a note on its own, no hub.", "Mentions [[project-x-infra]] once, in passing."].join("\n") + "\n");
  return dir;
}

function start({ fake = false, mode = "tidy", env = {} } = {}) {
  const dir = hubSpokeMemory();
  const dataDir = tmp("memglow-tidy-data-");
  const fakeDir = fake ? makeFake(mode) : tmp("memglow-tidy-nofake-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1", ...env }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: fakeDir, HOME: os.tmpdir() } });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, port: server.address().port })));
}

function req(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
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
const post = (s, action, body) => req(s.port, "/api/assistant/" + action, { method: "POST", headers: write(s.port), body: body || {} });
const read = (dir, name) => fs.readFileSync(path.join(dir, name + ".md"), "utf8");

async function settle(s, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const st = (await req(s.port, "/api/assistant")).json;
    if (st.job && st.job.state !== "running" && st.job.state !== "applying") return st;
    if (Date.now() - t0 > ms) throw new Error("job still running");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("tidy: deterministic fixes alone (ai: false) need no provider call", async () => {
  const s = await start({ fake: false });
  try {
    const p = await post(s, "propose", { kind: "tidy", ai: false });
    assert.strictEqual(p.status, 200, p.body);
    assert.strictEqual(p.json.job.state, "proposed", JSON.stringify(p.json));
    const rels = p.json.job.files.map((f) => f.rel).sort();
    // index.md (redundant line gone), project-x-api.md (pure Siblings: line gone), project-x.md
    // (missing hub line added) and project-x-orphan.md (missing uplink added) — but NOT
    // project-x-infra.md, whose only finding is the ambiguous cross-link, untouched without AI.
    assert.deepStrictEqual(rels, ["index.md", "project-x-api.md", "project-x-orphan.md", "project-x.md"].sort());
    assert.match(p.json.job.notes, /ambiguous cross-link/);

    const c = await post(s, "confirm", { job: p.json.job.id });
    assert.strictEqual(c.status, 200);
    const a = await post(s, "apply", { job: p.json.job.id, token: c.json.token });
    assert.strictEqual(a.status, 200, a.body);
    assert.strictEqual(a.json.job.state, "applied");

    const index = read(s.dir, "index");
    assert.ok(!index.includes("[[project-x-api]]"), "redundant index line removed");
    assert.ok(index.includes("[[project-x]]") && index.includes("[[standalone-note]]"), "stand-alone and hub entries stay");

    const api = read(s.dir, "project-x-api");
    assert.ok(!api.includes("Siblings:"), "pure sibling line removed outright");

    const orphan = read(s.dir, "project-x-orphan");
    assert.match(orphan, /\[\[project-x\]\]/, "missing uplink added");
    assert.ok(orphan.includes("Some content with no backlink at all."), "original content kept");

    const px = read(s.dir, "project-x");
    assert.match(px, /-\s*\[\[project-x-unlisted\]\]/, "missing hub line added");

    // The ambiguous prose line is untouched when there was no AI review.
    const infra = read(s.dir, "project-x-infra");
    assert.ok(infra.includes("[[project-x-orphan]]") && infra.includes("[[project-x-unlisted]]"));

    // Undo restores everything, byte for byte.
    const u = await post(s, "undo", { job: p.json.job.id });
    assert.strictEqual(u.status, 200, u.body);
    assert.ok(read(s.dir, "index").includes("[[project-x-api]]"), "redundant index line restored");
    assert.match(read(s.dir, "project-x-api"), /Siblings:/);
    assert.ok(!read(s.dir, "project-x-orphan").includes("[[project-x]]"));
  } finally { s.server.close(); }
});

test("tidy: an ambiguous cross-link is only touched after AI review (fake claude, mode 'tidy')", async () => {
  const s = await start({ fake: true, mode: "tidy" });
  try {
    const p = await post(s, "propose", { kind: "tidy", ai: true, provider: "claude-code" });
    assert.strictEqual(p.status, 200, p.body);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st));
    const rels = st.job.files.map((f) => f.rel);
    assert.ok(rels.includes("project-x-infra.md"), "the ambiguous line's note is now part of the proposal");

    const c = await post(s, "confirm", { job: st.job.id });
    const a = await post(s, "apply", { job: st.job.id, token: c.json.token });
    assert.strictEqual(a.status, 200, a.body);

    // fake-claude (mode "tidy") removes the FIRST candidate link of every ambiguous line.
    const infra = read(s.dir, "project-x-infra");
    assert.ok(!infra.includes("[[project-x-orphan]]"), "the link the AI chose to remove is gone");
    assert.ok(infra.includes("[[project-x-unlisted]]"), "the link the AI chose to keep stays");
    assert.ok(infra.includes("the deploy pipeline reuses the same cluster"), "the rest of the sentence is untouched");
  } finally { s.server.close(); }
});

test("tidy: a bad AI answer (unknown id) is refused, nothing written", async () => {
  const s = await start({ fake: true, mode: "tidy-bad" });
  try {
    const p = await post(s, "propose", { kind: "tidy", ai: true, provider: "claude-code" });
    const st = await settle(s);
    assert.strictEqual(st.job.state, "invalid", JSON.stringify(st));
    assert.ok(st.job.errors.some((e) => /unknown id/.test(e)));
    assert.ok(read(s.dir, "project-x-infra").includes("[[project-x-orphan]]"), "nothing was written");
  } finally { s.server.close(); }
});

test("tidy: a memory that already follows hub and spoke has nothing to tidy", async () => {
  const dir = tmp("memglow-tidy-clean-");
  fs.writeFileSync(path.join(dir, "alpha.md"), "Just a note.\n");
  fs.writeFileSync(path.join(dir, "beta.md"), "Another note, unrelated.\n");
  const dataDir = tmp("memglow-tidy-clean-data-");
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1" }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: tmp("memglow-tidy-clean-nofake-"), HOME: os.tmpdir() } });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    const p = await post({ port }, "propose", { kind: "tidy", ai: false });
    assert.strictEqual(p.status, 200, p.body);
    assert.strictEqual(p.json.job.state, "invalid");
    assert.ok(p.json.job.errors.some((e) => /nothing to tidy/i.test(e)));
  } finally { server.close(); }
});

test("tidy: the MCP read-only tool and /api/cost agree on the same structure counts", async () => {
  const s = await start({ fake: false });
  try {
    const r = await req(s.port, "/api/cost");
    assert.strictEqual(r.status, 200, r.body);
    assert.deepStrictEqual(r.json.structure.counts, {
      hubs: 1, indexRedundant: 1, siblingLines: 2, pureSiblingLines: 1, missingUplinks: 1, missingHubLines: 1,
    });

    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp-server", "memglow-mcp.js")], {
      env: { ...process.env, MEMORY_DIR: s.dir, MEMGLOW_DATA_DIR: s.dataDir },
    });
    try {
      const wire = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_health", arguments: {} } },
      ].map((m) => JSON.stringify(m) + "\n").join("");
      child.stdin.write(wire);
      const [, healthRes] = await new Promise((resolve, reject) => {
        let out = "";
        const t = setTimeout(() => reject(new Error("timed out: " + out)), 5000);
        child.stdout.on("data", (d) => {
          out += d.toString("utf8");
          const lines = out.split("\n").filter(Boolean);
          if (lines.length >= 2) { clearTimeout(t); resolve(lines.slice(0, 2).map((l) => JSON.parse(l))); }
        });
      });
      const data = JSON.parse(healthRes.result.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
      assert.deepStrictEqual(data.structure, r.json.structure.counts);
    } finally { child.kill(); }
  } finally { s.server.close(); }
});

// ---- rendering: the "Structure" dashboard block and the assistant panel's "tidy" job ----

test("costStructure: counts, pure-removal note, 'Tidy' buttons only when the assistant is on", () => {
  const cost = require("../public/cost.js");
  cost.setAssistant(false);
  const counts = { hubs: 1, indexRedundant: 1, siblingLines: 2, pureSiblingLines: 1, missingUplinks: 1, missingHubLines: 1 };
  let html = cost.costStructure({ counts }, undefined);
  assert.ok(html.includes("1 hub") && html.includes("1 index line already covered by its hub"));
  assert.ok(html.includes("2 notes link to several") && html.includes("1 removable outright, no AI needed"));
  assert.ok(html.includes("1 note missing its link back to the hub") && html.includes("1 hub missing a line for one of its notes"));
  assert.ok(!html.includes("data-tidy"), "no action buttons without the assistant");
  cost.setAssistant(true, "Claude Code");
  html = cost.costStructure({ counts }, undefined);
  assert.ok(html.includes('data-tidy="1"') && html.includes('data-tidy-ai="1"') && html.includes("Do it with Claude Code"));
  cost.setAssistant(false);
  // Nothing to tidy: the empty message, no list, no buttons.
  const clean = { hubs: 2, indexRedundant: 0, siblingLines: 0, pureSiblingLines: 0, missingUplinks: 0, missingHubLines: 0 };
  assert.match(cost.costStructure({ counts: clean }, undefined), /Nothing to tidy/);
  assert.strictEqual(cost.costStructure(null, undefined), '<p class="mg-cost__empty">Memory cost is not available.</p>');
});

test("aiRenderJob: a 'tidy' job gets its own title and checked-message, not the split ones", () => {
  const ai = require("../public/assistant.js");
  const proposed = ai.aiRenderJob({ id: "j", kind: "tidy", state: "proposed", note: { label: "memory structure" }, files: [{ rel: "index.md", kind: "modify", role: "tidy", added: 0, removed: 1, hunks: [] }], notes: "Tidied." }, "Claude Code");
  assert.ok(proposed.includes("Tidy <strong>memory structure") && !proposed.includes("Split <strong>"));
  assert.ok(proposed.includes("only the targeted lines changed"));
  const running = ai.aiRenderJob({ id: "j", kind: "tidy", state: "running", note: { label: "memory structure" }, chars: 0 }, "Claude Code");
  assert.ok(running.includes("Tidy <strong>memory structure"));
});
