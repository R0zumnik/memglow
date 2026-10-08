"use strict";
// memglow memory server, phase B (stage 0.4.5.2): the write tools — write_note, edit_note,
// move_note, delete_note — their answers, their edge cases, and the store/search seeing every
// change at once.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { READ_ONLY_MESSAGE } = require("../memory-server/tools");
const { makeKb, NOTES } = require("./fixtures/memory-kb");

function setup(opts = {}) {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, maxFileBytes: 200 * 1024, fsync: false, ...opts });
  const call = (name, args) => srv.tools.call(name, args);
  const text = async (name, args) => { const r = await call(name, args); return r.content[0].text; };
  const file = (rel) => fs.readFileSync(path.join(kb.root, rel), "utf8");
  const exists = (rel) => fs.existsSync(path.join(kb.root, rel));
  return { kb, srv, call, text, file, exists, done: () => { srv.close(); kb.cleanup(); } };
}

test("write_note: creates the file, answers like basic-memory, and the note is readable and searchable at once", async () => {
  const s = setup();
  try {
    const out = await s.text("write_note", { title: "Zanzibar trip", directory: "memory/projects", content: "# Zanzibar trip\n\n- [plan] Flights in March #travel\n- relates_to [[Garden Project]]\n- see [[Nowhere Note]]\n", tags: "travel, family", metadata: { theme: "family" } });
    assert.match(out, /^# Created note\nproject: main\nfile_path: memory\/projects\/Zanzibar trip\.md\npermalink: main\/memory\/projects\/zanzibar-trip\nchecksum: [0-9a-f]{8}\n/);
    assert.match(out, /\n## Observations\n- plan: 1\n/);
    assert.match(out, /\n## Relations\n- Resolved: 1\n- Unresolved: 1\n/);
    assert.match(out, /\n## Tags\n- travel, family\n\n\[Session: Using project 'main'\]$/);
    const raw = s.file("memory/projects/Zanzibar trip.md");
    assert.strictEqual(raw, "---\ntitle: Zanzibar trip\ntype: note\npermalink: main/memory/projects/zanzibar-trip\ntheme: family\ntags:\n- travel\n- family\n---\n\n# Zanzibar trip\n\n- [plan] Flights in March #travel\n- relates_to [[Garden Project]]\n- see [[Nowhere Note]]\n");
    // Round trip: read_note returns exactly what was written, by permalink, title or path.
    for (const id of ["main/memory/projects/zanzibar-trip", "Zanzibar trip", "memory/projects/Zanzibar trip.md", "memory://memory/projects/zanzibar-trip"]) {
      assert.strictEqual((await s.call("read_note", { identifier: id })).content[0].text, raw, id);
    }
    // Search finds it immediately (no rescan: watch and poll are off).
    assert.match(await s.text("search_notes", { query: "zanzibar" }), /### Zanzibar trip\n- permalink: main\/memory\/projects\/zanzibar-trip/);
    assert.match(await s.text("recent_activity", { timeframe: "1h" }), /Zanzibar trip \(memory\/projects\)/);
    // The relation now resolves from the other side (build_context sees the new link).
    const ctx = JSON.parse(await s.text("build_context", { url: "memory://main/memory/projects/zanzibar-trip" }));
    assert.strictEqual(ctx.results[0].primary_result.title, "Zanzibar trip");
    // JSON output.
    const j = JSON.parse(await s.text("write_note", { title: "Json note", directory: "/", content: "body", output_format: "json" }));
    assert.deepStrictEqual(Object.keys(j), ["title", "permalink", "file_path", "checksum", "action"]);
    assert.strictEqual(j.file_path, "Json note.md");
    assert.strictEqual(j.permalink, "main/json-note");
    assert.strictEqual(j.action, "created");
    assert.strictEqual(j.checksum.length, 64);
  } finally { s.done(); }
});

test("write_note: an existing note is refused unless overwrite=true; overwrite keeps the frontmatter's other keys and the permalink", async () => {
  const s = setup();
  try {
    const before = s.file("memory/people/alice.md");
    const refused = await s.text("write_note", { title: "alice", directory: "memory/people", content: "new" });
    assert.match(refused, /^# Error: Note already exists\n/);
    assert.match(refused, /permalink: `main\/memory\/people\/alice`/);
    assert.match(refused, /overwrite=True/);
    assert.strictEqual(s.file("memory/people/alice.md"), before, "nothing written");
    const j = JSON.parse(await s.text("write_note", { title: "alice", directory: "memory/people", content: "new", output_format: "json", overwrite: false }));
    assert.deepStrictEqual(j, { title: "alice", permalink: "main/memory/people/alice", file_path: null, checksum: null, action: "conflict", error: "NOTE_ALREADY_EXISTS" });

    const out = await s.text("write_note", { title: "Alice Martin", directory: "memory/people", content: "Rewritten body.\n", overwrite: true, metadata: { status: "moved" }, tags: ["friend"] });
    // "Alice Martin" is a new file name (title → file name): a new note, not the alice.md file.
    assert.match(out, /^# Created note\n/);
    const up = await s.text("write_note", { title: "alice", directory: "memory/people", content: "Rewritten body.\n", overwrite: true, metadata: { status: "moved" }, note_type: "person" });
    assert.match(up, /^# Updated note\nproject: main\nfile_path: memory\/people\/alice\.md\npermalink: main\/memory\/people\/alice\n/);
    assert.strictEqual(s.file("memory/people/alice.md"), [
      "---", "title: alice", "type: person", "permalink: main/memory/people/alice", "tags: [family, friend]", "status: moved",
      "description: 'Alice, a close friend who lives in Orléans and loves", "  gardening'", "---", "", "Rewritten body.", "",
    ].join("\n"), "title/status rewritten in place; tags and the folded description byte-for-byte; body replaced");
    // overwrite on a CRLF + BOM note keeps both.
    await s.text("write_note", { title: "crlf", directory: "memory/notes", content: "New windows body\nline 2\n", overwrite: true });
    const crlf = fs.readFileSync(path.join(s.kb.root, "memory/notes/crlf.md"));
    assert.deepStrictEqual([...crlf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM kept");
    assert.ok(!/[^\r]\n/.test(crlf.toString("utf8")), "every line ends with CRLF");
    assert.match(crlf.toString("utf8"), /title: crlf\r\ntype: note\r\n/);
  } finally { s.done(); }
});

test("write_note: --overwrite-default replaces without the flag; overwrite=false still refuses", async () => {
  const s = setup({ overwriteDefault: true });
  try {
    assert.match(await s.text("write_note", { title: "bob", directory: "memory/people", content: "B" }), /^# Updated note/);
    assert.match(await s.text("write_note", { title: "bob", directory: "memory/people", content: "C", overwrite: false }), /^# Error: Note already exists/);
    assert.match(s.file("memory/people/bob.md"), /\n\nB$/);
  } finally { s.done(); }
});

test("write_note: paths stay inside the root; bad arguments are tool errors", async () => {
  const s = setup();
  try {
    for (const dir of ["../outside", "memory/../../x", ".git", "memory/.hidden", "@eaDir"]) {
      const t = await s.text("write_note", { title: "x", directory: dir, content: "x" });
      assert.strictEqual(t, `# Error\n\nDirectory path '${dir}' is not allowed - paths must stay within project boundaries`, dir);
    }
    assert.ok(!fs.existsSync(path.join(path.dirname(s.kb.root), "outside")));
    // A title is a file name, never a path: separators become "-" (and a resulting dot-file is refused).
    assert.match(await s.text("write_note", { title: "a/b\\c", directory: "memory", content: "x" }), /file_path: memory\/a-b-c\.md/);
    const dot = await s.call("write_note", { title: "../../etc/passwd", directory: "memory", content: "x" });
    assert.strictEqual(dot.isError, true);
    assert.match(dot.content[0].text, /not allowed/);
    const e1 = await s.call("write_note", { title: "???", directory: "memory", content: "x" });
    assert.strictEqual(e1.isError, true);
    assert.match(e1.content[0].text, /^Error calling tool 'write_note': title '\?\?\?' gives an empty file name/);
    const e2 = await s.call("write_note", { title: "x", directory: "memory" });
    assert.match(e2.content[0].text, /content is required/);
    const e3 = await s.call("write_note", { title: "x", content: "y" });
    assert.match(e3.content[0].text, /directory is required/);
    // Aliases basic-memory accepts for the directory.
    assert.match(await s.text("write_note", { title: "via folder", folder: "memory/alias", content: "x" }), /file_path: memory\/alias\/via folder\.md/);
    // Content frontmatter that cannot be read is refused, not half-written.
    const e4 = await s.call("write_note", { title: "bad fm", directory: "memory", content: "---\na: [unclosed\n  b: :\n---\nbody" });
    assert.strictEqual(e4.isError, true);
    assert.ok(!s.exists("memory/bad fm.md"));
  } finally { s.done(); }
});

test("write_note: a permalink declared in the content that another note already has gets a -1 suffix", async () => {
  const s = setup();
  try {
    const out = await s.text("write_note", { title: "alice copy", directory: "memory/people", content: "---\npermalink: main/memory/people/alice\n---\nCopy" });
    assert.match(out, /permalink: main\/memory\/people\/alice-1\n/);
    assert.strictEqual((await s.call("read_note", { identifier: "main/memory/people/alice" })).content[0].text, s.file("memory/people/alice.md"), "the original keeps its permalink");
  } finally { s.done(); }
});

test("edit_note append / prepend: frontmatter kept byte-for-byte; prepend goes after it", async () => {
  const s = setup();
  try {
    const before = s.file("memory/people/alice.md");
    const out = await s.text("edit_note", { identifier: "alice", operation: "append", content: "\n## Hobbies\n- [hobby] pottery\n" });
    assert.match(out, /^# Edited note \(append\)\nproject: main\nfile_path: memory\/people\/alice\.md\npermalink: main\/memory\/people\/alice\nchecksum: [0-9a-f]{8}\noperation: Added 4 lines to end of note\n/);
    assert.strictEqual(s.file("memory/people/alice.md"), before + "\n## Hobbies\n- [hobby] pottery\n");
    await s.text("edit_note", { identifier: "main/memory/people/alice", operation: "prepend", content: "> Updated today." });
    const fm = before.slice(0, before.indexOf("---\n", 4) + 4);
    assert.ok(s.file("memory/people/alice.md").startsWith(fm + "\n> Updated today.\nAlice is a friend"), s.file("memory/people/alice.md").slice(0, 400));
    // A note without frontmatter: prepend at the very top.
    await s.text("edit_note", { identifier: "bob", operation: "prepend", content: "# Bob" });
    assert.strictEqual(s.file("memory/people/bob.md"), "# Bob\n" + NOTES["memory/people/bob.md"]);
    // Append to a file without a final newline gets one first.
    await s.text("edit_note", { identifier: "Json-less", operation: "append", content: "seed" }); // creates it
    await s.text("edit_note", { identifier: "Json-less", operation: "append", content: "more" });
    assert.match(s.file("Json-less.md"), /\n\nseed\nmore$/);
  } finally { s.done(); }
});

test("edit_note append/prepend on a missing note creates it (directory from the identifier)", async () => {
  const s = setup();
  try {
    const out = await s.text("edit_note", { identifier: "memory/journal/2026-10-08", operation: "append", content: "- [done] wrote phase B\nline 2", metadata: { theme: "work" } });
    assert.match(out, /^# Created note \(append\)\nproject: main\nfile_path: memory\/journal\/2026-10-08\.md\npermalink: main\/memory\/journal\/2026-10-08\nchecksum: [0-9a-f]{8}\nfileCreated: true\noperation: Created note with 2 lines\n/);
    assert.strictEqual(s.file("memory/journal/2026-10-08.md"), "---\ntitle: '2026-10-08'\ntype: note\npermalink: main/memory/journal/2026-10-08\ntheme: work\n---\n\n- [done] wrote phase B\nline 2");
    const j = JSON.parse(await s.text("edit_note", { identifier: "memory://main/memory/journal/other", operation: "prepend", content: "x", output_format: "json" }));
    assert.strictEqual(j.fileCreated, true);
    assert.strictEqual(j.file_path, "memory/journal/other.md");
    // A traversal in the identifier never creates anything outside.
    const bad = await s.text("edit_note", { identifier: "../../escape/x", operation: "append", content: "x" });
    assert.match(bad, /^# Error\n\nDirectory path '\.\.\/\.\.\/escape' is not allowed/);
    // find_replace / sections need an existing note.
    const nf = await s.call("edit_note", { identifier: "nope-nothing", operation: "find_replace", content: "a", find_text: "b" });
    assert.strictEqual(nf.isError, false);
    assert.match(nf.content[0].text, /^# Edit Failed - Note Not Found\n/);
    assert.ok(!s.exists("nope-nothing.md"));
  } finally { s.done(); }
});

test("edit_note find_replace: exact count, mismatch and absence reported, frontmatter protected", async () => {
  const s = setup();
  try {
    await s.text("edit_note", { identifier: "Garden Project", operation: "find_replace", find_text: "Tomates", content: "Tomatoes" });
    assert.match(s.file("memory/projects/garden-project.md"), /Tomatoes et courgettes/);
    const before = s.file("memory/projects/garden-project.md");
    const wrong = await s.text("edit_note", { identifier: "Garden Project", operation: "find_replace", find_text: "garden", content: "yard" });
    assert.match(wrong, /^# Edit Failed - Wrong Replacement Count\n\nExpected 1 occurrences of 'garden' but found 4\./, "the frontmatter counts too (its tag)");
    assert.match(wrong, /expected_replacements=4/);
    assert.strictEqual(s.file("memory/projects/garden-project.md"), before, "nothing changed");
    await s.text("edit_note", { identifier: "Garden Project", operation: "find_replace", find_text: "garden", content: "yard", expected_replacements: 4 });
    assert.strictEqual((s.file("memory/projects/garden-project.md").match(/yard/g) || []).length, 4);
    assert.match(s.file("memory/projects/garden-project.md"), /\ntags:\n- yard\n- home\n/);
    assert.match(await s.text("edit_note", { identifier: "Garden Project", operation: "find_replace", find_text: "zzz-absent", content: "x" }), /^# Edit Failed - Text Not Found\n/);
    // A replacement that would break the YAML is refused.
    const broke = await s.text("edit_note", { identifier: "alice", operation: "find_replace", find_text: "status: active\n", content: "status: active\n  oops: [x\n" });
    assert.match(broke, /^# Edit Failed\n\n.*break the note's frontmatter/);
    // Argument errors are tool errors.
    for (const [args, re] of [
      [{ operation: "find_replace", content: "x" }, /find_text parameter is required/],
      [{ operation: "replace_section", content: "x" }, /section parameter is required/],
      [{ operation: "rewrite", content: "x" }, /Invalid operation 'rewrite'\. Must be one of: append, prepend, find_replace/],
      [{ operation: "append" }, /content is required/],
      [{ operation: "append", content: "x", metadata: { a: null, b: 1 } }, /metadata values cannot be null \(key deletion is not supported\): a/],
      [{ operation: "find_replace", content: "x", find_text: "   " }, null],
    ]) {
      const r = await s.call("edit_note", { identifier: "alice", ...args });
      if (re) { assert.strictEqual(r.isError, true, JSON.stringify(args)); assert.match(r.content[0].text, re); }
      else assert.match(r.content[0].text, /find_text cannot be empty/);
    }
  } finally { s.done(); }
});

test("edit_note sections: replace (with/without subsections), insert before/after, emoji/accent headings, missing and duplicate headings", async () => {
  const s = setup();
  try {
    s.kb.write("memory/notes/sections.md", [
      "---", "title: Sections", "type: note", "---", "", "# Sections", "", "## Intro 🎉", "old intro", "", "### Detail", "old detail", "",
      "## Été 2026", "summer", "", "```", "## Inside code", "```", "", "## Twice", "a", "", "## Twice", "b", "",
    ].join("\n"));
    s.srv.store.scan();
    await s.text("edit_note", { identifier: "Sections", operation: "replace_section", section: "## Intro 🎉", content: "new intro", replace_subsections: false });
    assert.match(s.file("memory/notes/sections.md"), /## Intro 🎉\nnew intro\n\n### Detail\nold detail\n/);
    await s.text("edit_note", { identifier: "Sections", operation: "replace_section", section: "## Intro 🎉", content: "## Intro 🎉\nreplaced all\n" });
    assert.match(s.file("memory/notes/sections.md"), /## Intro 🎉\nreplaced all\n\n## Été 2026\n/, "subsections replaced too (default), duplicate heading in content dropped");
    await s.text("edit_note", { identifier: "Sections", operation: "insert_before_section", section: "Été 2026", content: "before summer" });
    await s.text("edit_note", { identifier: "Sections", operation: "insert_after_section", section: "## Été 2026", content: "first summer line" });
    assert.match(s.file("memory/notes/sections.md"), /replaced all\n\nbefore summer\n\n## Été 2026\nfirst summer line\nsummer\n/);
    const missing = await s.text("edit_note", { identifier: "Sections", operation: "replace_section", section: "## Nope", content: "x" });
    assert.match(missing, /^# Edit Failed - Section Not Found\n\nSection '## Nope' not found in note/);
    assert.match(await s.text("edit_note", { identifier: "Sections", operation: "insert_after_section", section: "## Inside code", content: "x" }), /Section Not Found/, "a heading inside fenced code is not a section");
    assert.match(await s.text("edit_note", { identifier: "Sections", operation: "replace_section", section: "## Twice", content: "x" }), /^# Edit Failed - Duplicate Section Headers/);
    // The last section of a file (no heading after it).
    s.kb.write("memory/notes/last.md", "# T\n\n## End\nold end");
    s.srv.store.scan();
    await s.text("edit_note", { identifier: "last", operation: "replace_section", section: "## End", content: "new end" });
    assert.strictEqual(s.file("memory/notes/last.md"), "# T\n\n## End\nnew end\n");
  } finally { s.done(); }
});

test("edit_note on a CRLF + BOM note: line endings and BOM kept", async () => {
  const s = setup();
  try {
    await s.text("edit_note", { identifier: "Windows Note", operation: "append", content: "added line\nsecond" });
    await s.text("edit_note", { identifier: "Windows Note", operation: "replace_section", section: "## Heading CRLF", content: "replaced\n" });
    await s.text("edit_note", { identifier: "Windows Note", operation: "append", content: "", metadata: { status: "ok" } });
    const buf = fs.readFileSync(path.join(s.kb.root, "memory/notes/crlf.md"));
    assert.deepStrictEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const t = buf.toString("utf8").slice(1);
    assert.strictEqual(t, "---\r\ntitle: Windows Note\r\ntype: note\r\nstatus: ok\r\n---\r\n\r\n## Heading CRLF\r\nreplaced\r\n");
    assert.ok(!/[^\r]\n/.test(t));
  } finally { s.done(); }
});

test("edit_note metadata: merged into the frontmatter, other bytes untouched, title/type/permalink ignored", async () => {
  const s = setup();
  try {
    const before = s.file("memory/people/alice.md");
    await s.text("edit_note", { identifier: "alice", operation: "append", content: "", metadata: { status: "active", title: "HACK", type: "x", permalink: "y" } });
    assert.strictEqual(s.file("memory/people/alice.md"), before, "same values: not a byte changed");
    await s.text("edit_note", { identifier: "alice", operation: "append", content: "", metadata: { status: "away", theme: "family", nested: { a: 1, list: ["x"] } } });
    assert.strictEqual(s.file("memory/people/alice.md"), before
      .replace("status: active\n", "status: away\n")
      .replace("  gardening'\n---\n", "  gardening'\ntheme: family\nnested:\n  a: 1\n  list:\n  - x\n---\n"));
    // A note without frontmatter gets one (title/type/permalink first).
    await s.text("edit_note", { identifier: "bob", operation: "append", content: "", metadata: { theme: "sport" } });
    assert.strictEqual(s.file("memory/people/bob.md"), "---\ntitle: bob\ntype: note\npermalink: main/memory/people/bob\ntheme: sport\n---\n\n" + NOTES["memory/people/bob.md"]);
    // JSON output; metadata given as a JSON string.
    const j = JSON.parse(await s.text("edit_note", { identifier: "bob", operation: "append", content: "", metadata: "{\"theme\":\"rugby\"}", output_format: "json" }));
    assert.deepStrictEqual(Object.keys(j), ["title", "permalink", "file_path", "checksum", "operation", "fileCreated"]);
    assert.match(s.file("memory/people/bob.md"), /\ntheme: rugby\n/);
    // A frontmatter that cannot be read safely is never rewritten.
    const r = await s.text("edit_note", { identifier: "Broken Yaml", operation: "append", content: "", metadata: { a: 1 } });
    assert.match(r, /^# Edit Failed/);
  } finally { s.done(); }
});

test("move_note: path or folder, never over an existing file, permalink kept, directories", async () => {
  const s = setup();
  try {
    const alice = s.file("memory/people/alice.md");
    const out = await s.text("move_note", { identifier: "alice", destination_path: "memory/friends/alice.md" });
    assert.match(out, /^✅ Note moved successfully\n\n📁 \*\*alice\*\* → \*\*memory\/friends\/alice\.md\*\*\n🔗 Permalink: main\/memory\/people\/alice\n/);
    assert.ok(!s.exists("memory/people/alice.md"));
    assert.strictEqual(s.file("memory/friends/alice.md"), alice, "content untouched");
    assert.strictEqual((await s.call("read_note", { identifier: "main/memory/people/alice" })).content[0].text, alice, "the declared permalink still finds it");
    // Folder form keeps the file name.
    await s.text("move_note", { identifier: "bob", destination_folder: "memory/friends" });
    assert.ok(s.exists("memory/friends/bob.md"));
    assert.match(await s.text("search_notes", { query: "rugby stade" }), /memory\/friends\/bob/);
    // Collision: nothing moved, nothing overwritten.
    const garden = s.file("memory/projects/garden-project.md");
    const col = await s.text("move_note", { identifier: "Rugby Club", destination_path: "memory/projects/garden-project.md" });
    assert.match(col, /^# Move Failed - Destination Already Exists/);
    assert.strictEqual(s.file("memory/projects/garden-project.md"), garden);
    assert.ok(s.exists("memory/projects/rugby-club.md"));
    // Parameter and path checks.
    assert.match(await s.text("move_note", { identifier: "Rugby Club" }), /^# Move Failed - Missing Destination/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: "a.md", destination_folder: "b" }), /^# Move Failed - Invalid Parameters/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: "memory/projects/rugby-club.md" }), /^# Move Failed - Destination Same As Source/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: "memory/x/rugby" }), /^# Move Failed - File Extension Required/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: "memory/x/rugby.txt" }), /^# Move Failed - File Extension Mismatch/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: "../rugby.md" }), /^# Move Failed - Security Validation Error/);
    assert.match(await s.text("move_note", { identifier: "Rugby Club", destination_path: ".trash/rugby.md" }), /^# Move Failed - Security Validation Error/);
    assert.match(await s.text("move_note", { identifier: "nobody-here", destination_path: "x.md" }), /^# Move Failed - Note Not Found/);
    const j = JSON.parse(await s.text("move_note", { identifier: "Rugby Club", destination_folder: "archive", output_format: "json" }));
    assert.deepStrictEqual(j, { moved: true, title: "Rugby Club", permalink: "main/archive/rugby-club", file_path: "archive/rugby-club.md", source: "Rugby Club", destination: "archive/rugby-club.md" });
    // Directory move, and a refused one onto an existing folder.
    const dirOut = await s.text("move_note", { identifier: "memory/friends", destination_path: "memory/people-old", is_directory: true });
    assert.match(dirOut, /^# Directory Moved Successfully\n[\s\S]*- Total files: 2\n[\s\S]*- `memory\/people-old\/alice\.md`/);
    assert.ok(s.exists("memory/people-old/bob.md") && !s.exists("memory/friends"));
    assert.match(await s.text("read_note", { identifier: "bob" }), /Bob plays rugby/);
    assert.match(await s.text("move_note", { identifier: "memory/people-old", destination_path: "memory/projects", is_directory: true }), /^# Move Failed - Destination Already Exists/);
    assert.match(await s.text("move_note", { identifier: "memory/none", destination_path: "memory/y", is_directory: true }), /^# Directory Move Failed - No Files Found/);
  } finally { s.done(); }
});

test("move_note --update-permalinks-on-move: the permalink follows the new path", async () => {
  const s = setup({ updatePermalinksOnMove: true });
  try {
    const out = await s.text("move_note", { identifier: "alice", destination_path: "memory/friends/Alice M.md" });
    assert.match(out, /🔗 Permalink: main\/memory\/friends\/alice-m\n/);
    assert.match(s.file("memory/friends/Alice M.md"), /\npermalink: main\/memory\/friends\/alice-m\n/);
  } finally { s.done(); }
});

test("delete_note: moved to .trash (never deleted), invisible to read/search/list; directories; not found → false", async () => {
  const s = setup();
  try {
    const bob = s.file("memory/people/bob.md");
    const r = await s.call("delete_note", { identifier: "bob" });
    assert.deepStrictEqual(r, { content: [{ type: "text", text: "true" }], structuredContent: { result: true }, isError: false });
    assert.ok(!s.exists("memory/people/bob.md"));
    const trashed = fs.readdirSync(path.join(s.kb.root, ".trash"));
    assert.strictEqual(trashed.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(s.kb.root, ".trash", trashed[0], "memory/people/bob.md"), "utf8"), bob, "the file is intact in the trash");
    assert.match(await s.text("read_note", { identifier: "bob" }), /^# Note Not Found/);
    assert.match(await s.text("search_notes", { query: "saturday" }), /^No results found/);
    assert.ok(!/bob/.test(await s.text("list_directory", { dir_name: "/memory/people" })));
    const rc = await s.call("read_content", { path: `.trash/${trashed[0]}/memory/people/bob.md` });
    assert.strictEqual(rc.isError, true, "the trash is not readable through the tools");
    s.srv.store.scan();
    assert.match(await s.text("read_note", { identifier: "bob" }), /^# Note Not Found/, "a full rescan does not bring it back");
    assert.deepStrictEqual((await s.call("delete_note", { identifier: "bob" })).structuredContent, { result: false });
    assert.deepStrictEqual(JSON.parse(await s.text("delete_note", { identifier: "Rugby Club", output_format: "json" })).deleted, true);
    // A directory.
    const d = await s.text("delete_note", { identifier: "memory/notes", is_directory: true });
    assert.match(d, /^# Directory Deleted Successfully\n[\s\S]*- Successfully deleted: \d+\n- Failed: 0\n/);
    assert.match(d, /Moved to the trash folder `\.trash\/[^`]+\/`/);
    assert.ok(!s.srv.store.notes().some((n) => n.rel.startsWith("memory/notes/")));
    assert.match(await s.text("delete_note", { identifier: "memory/void", is_directory: true }), /^# Directory Delete Failed - No Files Found/);
    assert.match(await s.text("delete_note", { identifier: "../x", is_directory: true }), /^# Directory Delete Failed/);
  } finally { s.done(); }
});

test("read-only server: every write tool answers the read-only error and nothing changes", async () => {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0 });
  try {
    for (const [name, args] of [["write_note", { title: "x", content: "y", directory: "" }], ["edit_note", { identifier: "alice", operation: "append", content: "x" }], ["move_note", { identifier: "alice", destination_path: "a.md" }], ["delete_note", { identifier: "alice" }]]) {
      const r = srv.tools.call(name, args);
      assert.strictEqual(typeof r.then, "undefined", "answered synchronously");
      assert.deepStrictEqual(r, { content: [{ type: "text", text: READ_ONLY_MESSAGE }], isError: true });
    }
    assert.strictEqual(fs.readFileSync(path.join(kb.root, "memory/people/alice.md"), "utf8"), NOTES["memory/people/alice.md"]);
    assert.ok(!fs.existsSync(path.join(kb.root, ".trash")));
  } finally { srv.close(); kb.cleanup(); }
});

test("edit/move/delete never guess: an identifier matching several notes by title or file name is refused", async () => {
  const s = setup();
  try {
    s.kb.write("memory/a/twin.md", "---\ntitle: Twin\npermalink: main/memory/a/twin\n---\nA\n");
    s.kb.write("memory/b/twin.md", "---\ntitle: Twin\npermalink: main/memory/b/twin\n---\nB\n");
    s.srv.store.scan();
    for (const [name, args] of [["delete_note", { identifier: "Twin" }], ["edit_note", { identifier: "twin", operation: "append", content: "x" }], ["move_note", { identifier: "Twin", destination_path: "t.md" }]]) {
      const r = await s.call(name, args);
      assert.strictEqual(r.isError, true, name);
      assert.match(r.content[0].text, /'[Tt]win' matches several notes \(main\/memory\/a\/twin, main\/memory\/b\/twin\); use the permalink/);
    }
    assert.ok(s.exists("memory/a/twin.md") && s.exists("memory/b/twin.md"));
    assert.strictEqual((await s.call("delete_note", { identifier: "main/memory/b/twin" })).structuredContent.result, true);
    assert.ok(s.exists("memory/a/twin.md") && !s.exists("memory/b/twin.md"));
    // Now unique: the title works again.
    assert.match(await s.text("edit_note", { identifier: "Twin", operation: "append", content: "more" }), /^# Edited note/);
    // A path identifier with ".md" creates that file, not "x.md.md".
    assert.match(await s.text("edit_note", { identifier: "memory/new/fresh.md", operation: "append", content: "x" }), /file_path: memory\/new\/fresh\.md\n/);
  } finally { s.done(); }
});
