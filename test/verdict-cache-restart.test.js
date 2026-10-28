"use strict";
// 0.5.5 real-restart reproduction: spawns memory-server/memglow-memory-server.js TWICE, as two
// real OS processes, on the SAME --root and MEMGLOW_DATA_DIR, with a mock AI provider (a real
// local HTTP server, OpenAI-compatible shape — every call goes through the exact
// lib/ai-provider.js code path production uses) counting requests. The 2nd process is stopped
// with a real SIGTERM, same as `docker stop` / systemd would send, and must make ZERO new AI
// calls for notes/pairs/lines the 1st process already resolved.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** A tiny local OpenAI-compatible mock: sniffs the user prompt to answer whichever of the three
 * workers (archive / duplicates / structure R4) is asking, counts every request. */
function startMockAi() {
  let count = 0;
  const prompts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      count++;
      let prompt = "";
      try { prompt = JSON.parse(body).messages[1].content; } catch { /* ignore */ }
      prompts.push(prompt);
      let content;
      if (/^Note A:/m.test(prompt)) content = JSON.stringify({ duplicate: false, keep: "a", reason: "related but distinct" });
      else if (/^The line:/m.test(prompt)) content = JSON.stringify({ action: "keep", reason: "useful reading order" });
      else content = JSON.stringify({ sections: [], reason: "nothing obsolete" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server, count: () => count, prompts,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((ok) => server.close(ok)),
  })));
}

const OLD_SECTION = `## 2020-01-01 Old incident\n${"word ".repeat(500)}\n`;

/** Every note is reachable from the index (hub's own parts, or listed directly) — so the
 * structure guardian's UNCACHED R5/R3-ambiguous judgement pass (a pre-existing, unrelated
 * behaviour: no orphan in this fixture) never fires and adds noise to the call count this test
 * is actually about (R4, archive, duplicates — the three that DO cache). */
function writeKb(root) {
  const files = {
    "memory/project/ops.md": `---\ntitle: ops\ntheme: project\n---\n\n## Current status\nStill going.\n\n${OLD_SECTION}`,
    "memory/project/coffee-a.md": `---\ntitle: Espresso Grind Timing Notes\ndescription: Grind size and timing notes for espresso brewing\ntheme: project\n---\n\nBody A.\n`,
    "memory/project/coffee-b.md": `---\ntitle: Espresso Grind Timing Guide\ndescription: Grind size and timing guide for espresso brewing\ntheme: project\n---\n\nBody B.\n`,
    "memory/project/hub.md": `---\ntitle: hub\ntheme: project\n---\n\n## Parts\n- [[a]] — a\n- [[b]] — b\n- [[c]] — c\n`,
    "memory/project/a.md": `---\ntitle: a\npart_of: hub\ntheme: project\n---\n\nUp: [[hub]] — part of hub.\n\n- See also: [[b]], [[c]]\n\nBody of a.\n`,
    "memory/project/b.md": `---\ntitle: b\npart_of: hub\ntheme: project\n---\n\nUp: [[hub]] — part of hub.\n\nBody of b.\n`,
    "memory/project/c.md": `---\ntitle: c\npart_of: hub\ntheme: project\n---\n\nUp: [[hub]] — part of hub.\n\nBody of c.\n`,
    "memory/MEMORY.md": `---\ntitle: MEMORY\n---\n\n- [[hub]] — the hub\n- [[ops]] — ops\n- [[coffee-a]] — a\n- [[coffee-b]] — b\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

/** Waits until `mock`'s call count has not moved for `quietMs`, or `maxMs` elapses. */
async function waitQuiet(mock, quietMs = 200, maxMs = 15000) {
  const start = Date.now();
  let last = -1, lastChangeAt = Date.now();
  for (;;) {
    const c = mock.count();
    if (c !== last) { last = c; lastChangeAt = Date.now(); }
    if (Date.now() - lastChangeAt >= quietMs) return;
    if (Date.now() - start >= maxMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Spawns the real CLI, waits for it to report "listening", waits for the AI traffic to go
 * quiet, then sends a real SIGTERM and waits for the process to actually exit — the exact
 * sequence `docker stop`/systemd would produce. */
function spawnAndStop(root, dataDir, configPath, mock) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "..", "memory-server", "memglow-memory-server.js");
    const child = spawn(process.execPath, [script, "--root", root, "--read-write", "--no-fsync", "--poll-ms", "0", "--no-watch", "--listen", "127.0.0.1:0"], {
      env: { ...process.env, MEMGLOW_CONFIG: configPath, MEMGLOW_DATA_DIR: dataDir },
    });
    let ready = false, err = "";
    child.stderr.on("data", (d) => { err += d.toString(); if (!ready && /listening on/.test(err)) ready = true; });
    child.on("error", reject);
    const start = Date.now();
    (async () => {
      while (!ready && Date.now() - start < 10000) await new Promise((r) => setTimeout(r, 25));
      if (!ready) { child.kill("SIGKILL"); return reject(new Error("server never reported listening — stderr: " + err)); }
      await waitQuiet(mock);
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 8000).unref();
    })();
  });
}

test("real restart (two spawned OS processes, SIGTERM, same --root/MEMGLOW_DATA_DIR): process 2 makes 0 new AI calls for notes/pairs/lines process 1 already resolved", async () => {
  const root = tmp("memglow-restart-kb-");
  const dataDir = tmp("memglow-restart-data-");
  writeKb(root);
  const mock = await startMockAi();
  const provider = { provider: "openai-compatible", baseUrl: mock.baseUrl, model: "mock" };
  const configPath = path.join(tmp("memglow-restart-cfg-"), "memglow.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    maintenance: {
      // archive: no includeFolders given — relies on its own 0.5.5 default (["memory/project"]),
      // which already covers this fixture's "ops" note. duplicates/structure are left unscoped
      // (their shared default: the index note's own folder, here the KB root — i.e. everything)
      // so MEMORY.md itself stays in scope for R5 reachability; scoping them to memory/project/
      // only would wrongly exclude MEMORY.md and turn every note in it into a spurious R5
      // orphan — unrelated noise this test is not about.
      archive: { enabled: true, idleMinutes: 0, minTokens: 400, ...provider },
      duplicates: { enabled: true, idleMinutes: 0, ...provider },
      structure: { enabled: true, ai: { enabled: true, maxDecisionsPerScan: 10, ...provider } },
    },
  }));
  try {
    await spawnAndStop(root, dataDir, configPath, mock);
    const afterRun1 = mock.count();
    assert.ok(afterRun1 >= 3, `expected at least 3 real AI calls (archive + duplicates + R4) in process 1, got ${afterRun1}`);
    assert.ok(!mock.prompts.some((p) => /"undefined"/.test(p)), "every prompt names the real note(s) — never \"undefined\"");

    await spawnAndStop(root, dataDir, configPath, mock);
    const afterRun2 = mock.count();
    assert.strictEqual(afterRun2, afterRun1, `process 2 (same root + same MEMGLOW_DATA_DIR, unchanged notes) made ${afterRun2 - afterRun1} extra AI call(s) — the verdict cache did not survive the restart`);

    const archiveCache = JSON.parse(fs.readFileSync(path.join(dataDir, "auto-archive-cache.json"), "utf8"));
    const dupCache = JSON.parse(fs.readFileSync(path.join(dataDir, "auto-duplicates-cache.json"), "utf8"));
    const r4Cache = JSON.parse(fs.readFileSync(path.join(dataDir, "structure-r4-cache.json"), "utf8"));
    assert.strictEqual(Object.keys(dupCache.entries).length, 1, "one duplicate pair cached, never doubled under a second key by process 2");
    assert.strictEqual(Object.keys(r4Cache.entries).length, 1, "the one R4 line cached, never doubled by process 2");
    assert.strictEqual(Object.keys(archiveCache.entries).length, 1);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});
