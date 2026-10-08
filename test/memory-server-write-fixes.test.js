"use strict";
// memglow memory server, stage 0.4.5.2c: regression tests for the cold review of the write side
// (one test per finding).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { ownershipWarning } = require("../memory-server/writer");
const E = require("../lib/store/note-edit");
const { RawScalar } = require("../lib/store/yaml-dump");
const { parseYaml, splitFrontmatter } = require("../lib/store/frontmatter");
const { makeKb } = require("./fixtures/memory-kb");

function setup(opts = {}) {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false, ...opts });
  const call = (n, a) => srv.tools.call(n, a);
  const text = async (n, a) => (await call(n, a)).content[0].text;
  const file = (rel) => fs.readFileSync(path.join(kb.root, rel), "utf8");
  const exists = (rel) => fs.existsSync(path.join(kb.root, rel));
  const put = (rel, t) => { kb.write(rel, t); srv.store.scan(); };
  return { kb, srv, call, text, file, exists, put, done: () => { srv.close(); kb.cleanup(); } };
}

test("1. append/prepend on a missing note named by a project-prefixed permalink: created at the path, no 'main/' tree", async () => {
  const s = setup();
  try {
    const out = await s.text("edit_note", { identifier: "main/memory/people/new-person", operation: "append", content: "hello" });
    assert.match(out, /^# Created note \(append\)\nproject: main\nfile_path: memory\/people\/new-person\.md\npermalink: main\/memory\/people\/new-person\n/);
    assert.ok(!s.exists("main"), "no stray main/ folder");
    await s.text("edit_note", { identifier: "memory://main/memory/people/other", operation: "prepend", content: "x" });
    assert.ok(s.exists("memory/people/other.md"));
  } finally { s.done(); }
});

test("2. a case-insensitive name collision is the same note (SMB): write_note refuses / overwrites it, move_note refuses", async () => {
  const s = setup();
  try {
    const alice = s.file("memory/people/alice.md");
    assert.match(await s.text("write_note", { title: "Alice", directory: "memory/people", content: "x" }), /^# Error: Note already exists/);
    assert.deepStrictEqual(fs.readdirSync(path.join(s.kb.root, "memory/people")).sort(), ["alice.md", "bob.md"]);
    assert.strictEqual(s.file("memory/people/alice.md"), alice);
    assert.match(await s.text("write_note", { title: "Alice", directory: "Memory/People", content: "new body", overwrite: true }), /^# Updated note\nproject: main\nfile_path: memory\/people\/alice\.md\n/);
    assert.match(await s.text("move_note", { identifier: "bob", destination_path: "memory/people/ALICE.md" }), /^# Move Failed - Destination Already Exists/);
    assert.ok(s.exists("memory/people/bob.md"));
  } finally { s.done(); }
});

test("3. a metadata merge keeps comment and blank lines of the frontmatter", async () => {
  const s = setup();
  try {
    s.put("memory/c.md", "---\ntitle: C\n# a comment about status\nstatus: draft\n\n# trailing comment\nother: 1\n---\nbody\n");
    await s.text("edit_note", { identifier: "C", operation: "append", content: "", metadata: { status: "done", other: 2 } });
    assert.strictEqual(s.file("memory/c.md"), "---\ntitle: C\n# a comment about status\nstatus: done\n\n# trailing comment\nother: 2\n---\nbody\n");
  } finally { s.done(); }
});

test("4. setext headings are section boundaries; an unclosed code fence makes section operations refuse", async () => {
  const s = setup();
  try {
    s.put("memory/setext.md", "---\ntitle: Setext\n---\n\nSetext A\n--------\ntext a\n\nSetext B\n--------\nimportant\n");
    await s.text("edit_note", { identifier: "Setext", operation: "replace_section", section: "## Setext A", content: "new a" });
    assert.strictEqual(s.file("memory/setext.md"), "---\ntitle: Setext\n---\n\nSetext A\n--------\nnew a\n\nSetext B\n--------\nimportant\n", "Setext B (same level) and its text kept");
    // A level-1 setext section with replace_subsections=false stops at the level-2 one.
    s.put("memory/setext1.md", "Top\n===\nintro\n\nSub\n---\nkeep\n");
    await s.text("edit_note", { identifier: "setext1", operation: "replace_section", section: "# Top", content: "new intro", replace_subsections: false });
    assert.strictEqual(s.file("memory/setext1.md"), "Top\n===\nnew intro\n\nSub\n---\nkeep\n");
    await s.text("edit_note", { identifier: "Setext", operation: "replace_section", section: "## Setext B", content: "new b" });
    assert.match(s.file("memory/setext.md"), /Setext B\n--------\nnew b\n$/);
    // A "---" after a blank line is a rule, not a heading; a list item is not a setext title.
    assert.deepStrictEqual(E.headingsOf("a\n\n---\n- item\n---\nPara\n---\n").map((h) => [h.level, h.text]), [[2, "Para"]]);
    s.put("memory/fence.md", "## A\n```\ncode\n## B\nkeep me\n");
    const before = s.file("memory/fence.md");
    assert.match(await s.text("edit_note", { identifier: "fence", operation: "replace_section", section: "## A", content: "x" }), /^# Edit Failed[\s\S]*never closed/);
    assert.strictEqual(s.file("memory/fence.md"), before);
  } finally { s.done(); }
});

test("5. frontmatter written for a new note is read back; odd keys and line-separator characters survive", async () => {
  const s = setup();
  try {
    await s.text("write_note", { title: "odd", directory: "memory", content: "x", metadata: { "a:b": 1, ls: "x y", nel: "p\u0085q", ps: "1 2" } });
    const fm = parseYaml(splitFrontmatter(s.file("memory/odd.md")).block);
    assert.strictEqual(fm.error, null);
    assert.deepStrictEqual([fm.data["a:b"], fm.data.ls, fm.data.nel, fm.data.ps], [1, "x y", "p\u0085q", "1 2"]);
    assert.match(s.file("memory/odd.md"), /\na:b: 1\nls: "x\\Ly"\nnel: "p\\Nq"\nps: "1\\P2"\n/);
    // Anything that would not read back as written is refused, never written half-right.
    assert.throws(() => E.buildNote({ title: "t", k: new RawScalar("x\nother: 2") }, "b"), (e) => e.code === "BAD_FRONTMATTER");
  } finally { s.done(); }
});

test("6. moving a symlinked note is refused (it is not moved, nothing breaks)", async (t) => {
  const s = setup();
  try {
    try { fs.symlinkSync("alice.md", path.join(s.kb.root, "memory/people/alias.md")); } catch { t.skip("no symlinks"); return; }
    s.srv.store.scan();
    const out = await s.text("move_note", { identifier: "memory/people/alias.md", destination_folder: "memory/archive" });
    assert.match(out, /^# Move Failed - Symbolic Link/);
    assert.ok(fs.lstatSync(path.join(s.kb.root, "memory/people/alias.md")).isSymbolicLink());
    assert.ok(!s.exists("memory/archive"));
    assert.match(await s.text("move_note", { identifier: "memory/people", destination_path: "memory/folks", is_directory: true }), /symbolic links/);
    assert.ok(s.exists("memory/people/alice.md"));
  } finally { s.done(); }
});

test("7. ownership: startup warning when the server's user does not own the folder; as root, group-write follows the parent", async () => {
  assert.match(ownershipWarning({ uid: 1045, gid: 100 }, 1000), /running as uid 1000 but the notes folder belongs to uid 1045:100/);
  assert.strictEqual(ownershipWarning({ uid: 1000, gid: 100 }, 1000), null);
  assert.strictEqual(ownershipWarning({ uid: 1045, gid: 100 }, 0), null, "root: files get the folder's owner anyway");
  const s = setup({ chownToParent: true });
  try {
    fs.mkdirSync(path.join(s.kb.root, "memory/shared"));
    fs.chmodSync(path.join(s.kb.root, "memory/shared"), 0o775);
    await s.text("write_note", { title: "g", directory: "memory/shared/sub", content: "x" });
    assert.ok(fs.statSync(path.join(s.kb.root, "memory/shared/sub")).mode & 0o020, "new folder group-writable");
    assert.ok(fs.statSync(path.join(s.kb.root, "memory/shared/sub/g.md")).mode & 0o020, "new file group-writable");
  } finally { s.done(); }
});

test("8. leftover temp files are cleaned at startup (exact pattern only); same-file twins are reported", async () => {
  const kb = makeKb();
  try {
    kb.write("memory/people/.mg-0123abcd.tmp", "half");
    kb.write("memory/.alice.md.memglow-tmp-42-0123456789", "half");
    kb.write("memory/.mg-notes.tmp", "not ours");
    fs.linkSync(path.join(kb.root, "memory/people/alice.md"), path.join(kb.root, "memory/alice-twin.md"));
    const logs = [];
    const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false, cleanupTempsMinAgeMs: 0, log: (l) => logs.push(l) });
    try {
      assert.ok(!fs.existsSync(path.join(kb.root, "memory/people/.mg-0123abcd.tmp")));
      assert.ok(!fs.existsSync(path.join(kb.root, "memory/.alice.md.memglow-tmp-42-0123456789")));
      assert.ok(fs.existsSync(path.join(kb.root, "memory/.mg-notes.tmp")), "a name not matching exactly stays");
      assert.ok(logs.some((l) => /removed 2 temp file/.test(l)));
      assert.ok(logs.some((l) => /several paths or permalinks/.test(l)));
      const diag = srv.tools.call("basic_memory_diagnostics", {}).content[0].text;
      assert.match(diag, /## Same file under several paths[^\n]*\n- memory\/alice-twin\.md, memory\/people\/alice\.md/);
    } finally { srv.close(); }
  } finally { kb.cleanup(); }
});

test("9. a long title (any name the file system accepts) is written: the temp name is short", async () => {
  const s = setup();
  try {
    const title = "t".repeat(240);
    const out = await s.text("write_note", { title, directory: "memory", content: "x" });
    assert.match(out, /^# Created note/);
    assert.ok(s.exists(`memory/${title}.md`));
  } finally { s.done(); }
});

test("10. '## C#' is the heading 'C#' (a closing # run needs a space before it)", async () => {
  const s = setup();
  try {
    s.put("memory/langs.md", "## C#\nsharp\n\n## C\nplain\n\n## Go ##\ngo\n");
    await s.text("edit_note", { identifier: "langs", operation: "replace_section", section: "## C#", content: "dotnet" });
    await s.text("edit_note", { identifier: "langs", operation: "replace_section", section: "## Go", content: "gopher" });
    assert.strictEqual(s.file("memory/langs.md"), "## C#\ndotnet\n\n## C\nplain\n\n## Go ##\ngopher\n");
    assert.deepStrictEqual(s.srv.store.resolve("langs").sections.map((x) => x.heading), ["C#", "C", "Go"]);
  } finally { s.done(); }
});

test("11. mixed line endings: untouched lines keep theirs, new lines take the dominant one", async () => {
  const s = setup();
  try {
    s.put("memory/mixed.md", "---\r\ntitle: Mixed\r\n---\r\n\r\nline1\nline2\r\nline3\r\n");
    await s.text("edit_note", { identifier: "Mixed", operation: "append", content: "added\nmore\n", metadata: { status: "x" } });
    assert.strictEqual(s.file("memory/mixed.md"), "---\r\ntitle: Mixed\r\nstatus: x\r\n---\r\n\r\nline1\nline2\r\nline3\r\nadded\r\nmore\r\n");
    s.put("memory/mostly-lf.md", "a\nb\r\nc\n");
    await s.text("edit_note", { identifier: "mostly-lf", operation: "find_replace", find_text: "c", content: "C" });
    assert.strictEqual(s.file("memory/mostly-lf.md"), "a\nb\r\nC\n");
  } finally { s.done(); }
});
