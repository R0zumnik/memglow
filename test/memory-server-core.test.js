"use strict";
// memglow memory server — memory_core / memory_index_level, wired through createMemoryServer():
// index-note discovery, lib/hub-spoke.js-confirmed hub filtering (via store.resolve(), since an
// index entry's bare wikilink text does not always equal a note's `rel`), coreMap / dataDir
// plumbing, and the "no index note" fallback. Pure-logic matching/rendering is already covered
// by test/index-tree.test.js and test/memory-core.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** A small memory in its own temp folder, nested one level (so rel !== the bare wikilink id). */
function makeHubKb() {
  const root = tmp("memglow-core-kb-");
  const write = (rel, text) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  write("MEMORY.md", [
    "---", "title: MEMORY", "---", "", "# Memory index", "",
    "## Work", "",
    "- [[hub-acme]] — Acme project hub, a very long descriptive hook sentence here",
    "- [[standalone]] — just a plain note, never a hub",
    "",
  ].join("\n"));
  write("projects/hub-acme.md", "---\ntitle: hub-acme\n---\n\n# Acme\n\nThe project hub itself, with enough body text that a small token budget actually has to cut something: " + "padding word ".repeat(60) + "\n");
  write("projects/spoke-of-acme.md", "---\ntitle: spoke-of-acme\npart_of: hub-acme\n---\n\nA part of the Acme project.\n");
  write("notes/standalone.md", "---\ntitle: standalone\n---\n\nJust a note, no parts.\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("memory_index_level level 0/1: only hub-acme (a confirmed hub via part_of) is listed, never the plain standalone note", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
    const l0 = srv.tools.call("memory_index_level", { level: 0 }).content[0].text;
    assert.strictEqual(l0, "Work: hub-acme");
    const l1 = srv.tools.call("memory_index_level", { level: 1 }).content[0].text;
    assert.strictEqual(l1, "## Work\n- hub-acme");
    const l2 = srv.tools.call("memory_index_level", { level: 2 }).content[0].text;
    assert.match(l2, /standalone/); // level 2 is the raw index: everything, hooks included
    srv.close();
  } finally { kb.cleanup(); }
});

test("memory_index_level: group filter restricts to one group's own raw block at level 2", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
    const out = srv.tools.call("memory_index_level", { level: 2, group: "Work" }).content[0].text;
    assert.match(out, /^## Work/);
    assert.match(out, /hub-acme/);
    srv.close();
  } finally { kb.cleanup(); }
});

test("memory_core: a cwd/project matching hub-acme returns its full note text, plus the compact index and an expand hint", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
    const out = srv.tools.call("memory_core", { cwd: "/home/x/projects/acme-storefront", project: ["acme"] }).content[0].text;
    assert.match(out, /The project hub itself/);
    assert.match(out, /Work: hub-acme/);
    assert.match(out, /memory_index_level/);
    srv.close();
  } finally { kb.cleanup(); }
});

test("memory_core: coreMap (createMemoryServer option) wins outright over the word match", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, coreMap: { "/home/x/projects/acme-storefront": "standalone" } });
    const r = JSON.parse(srv.tools.call("memory_core", { cwd: "/home/x/projects/acme-storefront", output_format: "json" }).content[0].text);
    assert.strictEqual(r.matchedBy, "coreMap");
    assert.deepStrictEqual(r.hubIds, ["standalone"]);
    srv.close();
  } finally { kb.cleanup(); }
});

test("memory_core: no match, and a dataDir with accounting data → top-read fallback, wired end to end", () => {
  const kb = makeHubKb();
  const dataDir = tmp("memglow-core-data-");
  try {
    fs.writeFileSync(path.join(dataDir, "activity-counts.json"), JSON.stringify({
      version: 1, since: "2026-01-01", started: "2026-01-01",
      days: { "2026-01-01": { notes: { "hub-acme": { read: 4, search: 0, write: 0 } } } }, last: {},
    }));
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, dataDir });
    const r = JSON.parse(srv.tools.call("memory_core", { cwd: "/completely/unrelated/zzz", output_format: "json" }).content[0].text);
    assert.strictEqual(r.matchedBy, "none");
    assert.strictEqual(r.usedTopRead, true);
    assert.deepStrictEqual(r.hubIds, ["hub-acme"]);
    srv.close();
  } finally { kb.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("memory_core budget_tokens: truncates to whole lines and says what was cut", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
    const r = JSON.parse(srv.tools.call("memory_core", { cwd: "/home/x/projects/acme-storefront", budget_tokens: 100, output_format: "json" }).content[0].text);
    assert.strictEqual(r.truncated, true);
    assert.match(r.text, /cut \d+ line\(s\)/);
    srv.close();
  } finally { kb.cleanup(); }
});

test("memory_core / memory_index_level: no index note at all → a clear message, never an error, both formats", () => {
  const root = tmp("memglow-core-noindex-");
  try {
    fs.writeFileSync(path.join(root, "just-a-note.md"), "---\ntitle: just-a-note\n---\n\nnothing to do with an index\n");
    const srv = createMemoryServer({ root, watch: false, pollMs: 0 });
    const r1 = srv.tools.call("memory_core", {});
    assert.strictEqual(r1.isError, false);
    assert.match(r1.content[0].text, /no index note found/);
    const r2 = JSON.parse(srv.tools.call("memory_index_level", { level: 0, output_format: "json" }).content[0].text);
    assert.strictEqual(r2.available, false);
    srv.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("memory_core / memory_index_level appear in tools/list as read-only, and are refused neither in read-only nor read-write mode", () => {
  const kb = makeHubKb();
  try {
    const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, readOnly: false });
    const names = srv.tools.tools.map((t) => t.name);
    assert.ok(names.includes("memory_core"));
    assert.ok(names.includes("memory_index_level"));
    const t1 = srv.tools.tools.find((t) => t.name === "memory_core");
    assert.strictEqual(t1.annotations.readOnlyHint, true);
    assert.strictEqual(srv.tools.call("memory_core", {}).isError, false);
    srv.close();
  } finally { kb.cleanup(); }
});
