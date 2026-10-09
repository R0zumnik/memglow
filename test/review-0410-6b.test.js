"use strict";
// 0.4.10.6b — fixes from the adversarial review of 0.4.9.1 → 0.4.10.6.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { childEnv } = require("../lib/assistant/providers/cli");
const { createRulesRelay } = require("../lib/memory-rules");
const { makeKb: makeSynthetic } = require("../bench/responsiveness");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10); } return true; }
const has = (store, rel) => store.notes().some((n) => n.rel === rel);

test("a folder deleted and recreated is watched again (no poll)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-6b-"));
  fs.mkdirSync(path.join(root, "x"));
  fs.writeFileSync(path.join(root, "x", "a.md"), "# a\n");
  const store = createStore({ root, pollMs: 0 }).start();
  try {
    fs.rmSync(path.join(root, "x"), { recursive: true });
    assert.ok(await until(() => !has(store, "x/a.md")));
    fs.mkdirSync(path.join(root, "x"));
    await sleep(500);
    fs.writeFileSync(path.join(root, "x", "b.md"), "# b\n");
    assert.ok(await until(() => has(store, "x/b.md"), 2000), "a note in the recreated folder is seen");
  } finally { store.stop(); }
});

test("a rescan dropped because a write landed meanwhile is redone (no poll)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-6b-w-"));
  makeSynthetic(root, 200);
  const srv = createMemoryServer({ root, readOnly: false, pollMs: 0, fsync: false });
  try {
    let stop = false, i = 0;
    const writes = (async () => { while (!stop) { await srv.rawRpc.handle({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "write_note", arguments: { title: "w" + i++, directory: "memory/family", content: "x" } } }, {}); } })();
    await sleep(50);
    fs.mkdirSync(path.join(root, "memory", "fresh"));
    fs.writeFileSync(path.join(root, "memory", "fresh", "new.md"), "# new\n\nfreshword\n");
    await sleep(400);
    stop = true; await writes;
    assert.ok(await until(() => has(srv.store, "memory/fresh/new.md"), 3000), "the new folder's note is indexed");
  } finally { srv.close(); }
});

test("a note created during the chunked startup load is not missed (no poll)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-6b-s-"));
  makeSynthetic(root, 800);
  const store = createStore({ root, pollMs: 0 });
  const p = store.startAsync({ chunk: 8 });
  await sleep(40);
  fs.writeFileSync(path.join(root, "memory", "family", "during-load.md"), "# during\n");
  await p;
  assert.ok(await until(() => has(store, "memory/family/during-load.md"), 2000));
  store.stop();
});

test("childEnv keeps Claude Code's Foundry key; the rules relay's session set is bounded", () => {
  assert.strictEqual(childEnv({ ANTHROPIC_FOUNDRY_API_KEY: "f" }).ANTHROPIC_FOUNDRY_API_KEY, "f");
  const r = createRulesRelay({ text: "R" });
  for (let i = 0; i < 6000; i++) { r.clientMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, "k" + i); r.serverMessage({ jsonrpc: "2.0", id: 1, result: {} }, "k" + i); }
  // The oldest key was forgotten: it would get the rules again (bounded memory, never fewer rules).
  r.clientMessage({ jsonrpc: "2.0", id: 2, method: "initialize" }, "k0");
  assert.ok(r.serverMessage({ jsonrpc: "2.0", id: 2, result: {} }, "k0").changed);
});
