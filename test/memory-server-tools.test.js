"use strict";
// memglow memory server (stage 0.4.5.1) — the read tools, their basic-memory-compatible output
// shapes, and the read-only / not-supported answers.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { TOOLS } = require("../memory-server/schemas");
const { READ_ONLY_MESSAGE } = require("../memory-server/tools");
const { makeKb } = require("./fixtures/memory-kb");

function setup() {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, watch: false, pollMs: 0, maxFileBytes: 200 * 1024 });
  const call = (name, args = {}) => srv.tools.call(name, args);
  const text = (name, args) => { const r = call(name, args); assert.ok(!r.isError, `${name} failed: ${r.content[0].text}`); return r.content[0].text; };
  const json = (name, args) => JSON.parse(text(name, { ...args, output_format: "json" }));
  return { kb, srv, call, text, json, done: () => { srv.close(); kb.cleanup(); } };
}

test("tools/list mirrors basic-memory's 21 tool names, with schemas and annotations", () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), [
    "basic_memory_diagnostics", "build_context", "create_memory_project", "delete_note", "delete_project", "edit_note", "fetch",
    "list_directory", "list_memory_projects", "list_workspaces", "move_note", "read_content", "read_note", "recent_activity",
    "schema_diff", "schema_infer", "schema_validate", "search", "search_notes", "view_note", "write_note"]);
  for (const t of TOOLS) {
    assert.strictEqual(t.inputSchema.type, "object", t.name);
    assert.ok(t.description && t.annotations && typeof t.annotations.readOnlyHint === "boolean", t.name);
  }
  const sn = TOOLS.find((t) => t.name === "search_notes").inputSchema.properties;
  for (const k of ["query", "project", "project_id", "search_all_projects", "page", "page_size", "search_type", "output_format", "note_types", "entity_types", "categories", "after_date", "metadata_filters", "tags", "status", "min_similarity"]) assert.ok(sn[k], "search_notes." + k);
  assert.deepStrictEqual(TOOLS.find((t) => t.name === "write_note").inputSchema.required, ["title", "content", "directory"]);
});

test("search_notes text: header, one blank-line-separated block per hit with permalink/external_id/score/match, footer", () => {
  const s = setup();
  try {
    const out = s.text("search_notes", { query: "garden", page_size: 2, project: "whatever", project_id: "x", search_all_projects: true });
    const blocks = out.split(/\n\s*\n/);
    assert.strictEqual(blocks[0], "# Search Results: garden\n*project: main*");
    assert.match(blocks[1], /^### Garden Project\n- permalink: main\/memory\/projects\/garden-project\n- external_id: [0-9a-f-]{36}\n- score: \d+\.\d{4}\n- match: .+$/);
    assert.match(out, /\n---\n\*2 results \| page 1, page_size 2 \| more available\*$/);
    const none = s.text("search_notes", { query: "nothingmatchesthis" });
    assert.match(none, /^No results found for 'nothingmatchesthis' in project 'main'/);
    assert.match(s.text("search_notes", {}), /^# No Search Criteria/);
    const bad = s.call("search_notes", { query: "x", search_type: "fuzzy" });
    assert.ok(bad.isError);
    const r = s.call("search_notes", { query: "garden" });
    assert.deepStrictEqual(r.structuredContent, { result: r.content[0].text }, "FastMCP-style text wrap");
  } finally { s.done(); }
});

test("search_notes json: basic-memory field names, pagination fields", () => {
  const s = setup();
  try {
    const j = s.json("search_notes", { query: "garden", page_size: 2 });
    assert.deepStrictEqual(Object.keys(j), ["results", "current_page", "page_size", "total", "total_is_exact", "has_more"]);
    const h = j.results[0];
    for (const k of ["title", "type", "score", "entity", "external_id", "permalink", "content", "matched_chunk", "file_path", "updated_at", "metadata", "entity_id"]) assert.ok(k in h, k);
    assert.strictEqual(h.type, "entity");
    assert.strictEqual(h.file_path, "memory/projects/garden-project.md");
    assert.deepStrictEqual(h.metadata, { note_type: "project" });
    assert.strictEqual(j.has_more, true);
    const obs = s.json("search_notes", { query: "tea", entity_types: ["observation"] });
    assert.strictEqual(obs.results[0].type, "observation");
    assert.strictEqual(obs.results[0].category, "preference");
  } finally { s.done(); }
});

test("read_note: the file as stored; json with/without frontmatter; helpful fallback on a miss", () => {
  const s = setup();
  try {
    const raw = fs.readFileSync(path.join(s.kb.root, "memory/people/alice.md"), "utf8");
    for (const id of ["main/memory/people/alice", "memory://memory/people/alice", "Alice Martin", "alice", "memory/people/alice.md"]) {
      assert.strictEqual(s.text("read_note", { identifier: id }), raw, id);
    }
    const j = s.json("read_note", { identifier: "alice" });
    assert.deepStrictEqual(Object.keys(j), ["title", "permalink", "file_path", "content", "frontmatter"]);
    assert.strictEqual(j.title, "Alice Martin");
    assert.strictEqual(j.content, raw.slice(raw.indexOf("---\n", 4) + 4), "content = everything after the frontmatter block");
    assert.deepStrictEqual(j.frontmatter.tags, ["family", "friend"]);
    assert.strictEqual(s.json("read_note", { identifier: "alice", include_frontmatter: true }).content, raw);
    const miss = s.text("read_note", { identifier: "vegetable garden plans" });
    assert.match(miss, /^# Note Not Found in main: "vegetable garden plans"/);
    assert.match(miss, /## 1\. Garden Project\n- \*\*Type\*\*: entity\n- \*\*Permalink\*\*: main\/memory\/projects\/garden-project/);
    const missJ = s.json("read_note", { identifier: "vegetable garden plans" });
    assert.strictEqual(missJ.title, null);
    assert.ok(missJ.related_results.some((x) => x.permalink === "main/memory/projects/garden-project"));
    assert.match(s.text("read_note", { identifier: "qqqzzzxxx" }), /^# Note Not Found in main: "qqqzzzxxx"\n\nNo note matches/);
    const crlf = s.text("read_note", { identifier: "Windows Note" });
    assert.ok(crlf.startsWith("---\r\ntitle: Windows Note"), "BOM stripped, CRLF kept as stored");
  } finally { s.done(); }
});

test("view_note, read_content, fetch, search (ChatGPT shapes)", () => {
  const s = setup();
  try {
    const raw = fs.readFileSync(path.join(s.kb.root, "memory/people/bob.md"), "utf8");
    assert.ok(s.text("view_note", { identifier: "bob" }).includes(raw));
    assert.match(s.text("view_note", { identifier: "nope-nope" }), /^# Note Not Found/);
    const rc = s.call("read_content", { path: "memory/people/bob.md" });
    assert.deepStrictEqual(rc.structuredContent, { type: "text", text: raw, content_type: "text/markdown; charset=utf-8", encoding: "utf-8" });
    assert.deepStrictEqual(JSON.parse(rc.content[0].text), rc.structuredContent);
    assert.strictEqual(s.call("read_content", { path: "memory://main/memory/people/bob" }).structuredContent.text, raw);
    s.kb.write("docs/data.json", '{"a":1}');
    assert.strictEqual(s.call("read_content", { path: "docs/data.json" }).structuredContent.text, '{"a":1}', "any text file under the root");
    assert.ok(s.call("read_content", { path: "../../etc/passwd" }).isError, "path traversal refused");
    assert.ok(s.call("read_content", { path: "memory/nope.md" }).isError);
    const f = JSON.parse(s.call("fetch", { id: "bob" }).content[0].text);
    assert.deepStrictEqual(f, { id: "bob", title: "bob", text: raw, url: "bob", metadata: { format: "markdown" } });
    assert.strictEqual(JSON.parse(s.call("fetch", { id: "nope-nope" }).content[0].text).metadata.error, "Document not found");
    const sr = JSON.parse(s.call("search", { query: "garden" }).content[0].text);
    assert.strictEqual(sr.query, "garden");
    assert.deepStrictEqual(sr.results[0], { id: "main/memory/projects/garden-project", title: "Garden Project", url: "main/memory/projects/garden-project" });
  } finally { s.done(); }
});

test("build_context: json shape, relations both ways, depth, timeframe, max_related, folder/* pattern, text format", () => {
  const s = setup();
  try {
    const j = s.json("build_context", { url: "memory://main/memory/people/alice" });
    assert.deepStrictEqual(Object.keys(j), ["results", "metadata", "page", "page_size", "has_more"]);
    const r = j.results[0];
    assert.strictEqual(r.primary_result.permalink, "main/memory/people/alice");
    assert.ok(r.primary_result.content.startsWith("Alice is a friend"), "body, trimmed, no frontmatter");
    assert.deepStrictEqual(r.observations.map((o) => o.category), ["fact", "preference"]);
    const rels = r.related_results.filter((x) => x.type === "relation").map((x) => `${x.from_entity} ${x.relation_type} ${x.to_name}`).sort();
    assert.deepStrictEqual(rels, ["Alice Martin knows bob", "Alice Martin works_with Garden Project", "Garden Project links_to alice", "MEMORY links_to alice", "bob links_to alice"].sort());
    const ents = r.related_results.filter((x) => x.type === "entity").map((x) => x.permalink).sort();
    assert.deepStrictEqual(ents, ["main/memory/memory", "main/memory/people/bob", "main/memory/projects/garden-project"]);
    assert.strictEqual(j.metadata.depth, 1);
    assert.strictEqual(j.metadata.primary_count, 1);
    // depth: alice's own links are reached from bob only at depth 2.
    const d1 = s.json("build_context", { url: "bob", max_related: 100 }).results[0].related_results.filter((x) => x.type === "entity").map((x) => x.permalink);
    const d2 = s.json("build_context", { url: "bob", depth: 2, max_related: 100 }).results[0].related_results.filter((x) => x.type === "entity").map((x) => x.permalink);
    assert.ok(!d1.includes("main/memory/projects/garden-project") && d2.includes("main/memory/projects/garden-project"));
    // timeframe: a 40-day-old note linking to bob is a related note with 60d, not with the default 7d
    // (its relation row is listed either way).
    s.kb.write("memory/old-friend.md", "---\ntitle: Old Friend\n---\nKnew [[bob]] long ago.\n");
    const old = Date.now() / 1000 - 40 * 86400;
    fs.utimesSync(path.join(s.kb.root, "memory/old-friend.md"), old, old);
    s.srv.store.scan();
    const tf7 = s.json("build_context", { url: "bob", max_related: 100 }).results[0].related_results;
    const tf60 = s.json("build_context", { url: "bob", timeframe: "60d", max_related: 100 }).results[0].related_results;
    assert.ok(tf7.some((x) => x.type === "relation" && x.from_entity === "Old Friend"));
    assert.ok(!tf7.some((x) => x.type === "entity" && x.title === "Old Friend"));
    assert.ok(tf60.some((x) => x.type === "entity" && x.title === "Old Friend"));
    const capped = s.json("build_context", { url: "alice", max_related: 2 });
    assert.strictEqual(capped.results[0].related_results.length, 2);
    // folder pattern
    const pat = s.json("build_context", { url: "memory://memory/people/*" });
    assert.deepStrictEqual(pat.results.map((x) => x.primary_result.permalink).sort(), ["main/memory/people/alice", "main/memory/people/bob"]);
    // text
    const t = s.text("build_context", { url: "memory://alice", output_format: "text" });
    assert.match(t, /^# Context: Alice Martin\n\n## Alice Martin\npermalink: main\/memory\/people\/alice\n\nAlice is a friend/);
    assert.match(t, /\n### Observations\n- \[fact\] Alice lives in Orléans\n- \[preference\] Alice prefers tea over coffee\n/);
    assert.match(t, /\n### Relations\n(- \S+ \[\[[^\]]+\]\]\n)+/);
    assert.match(t, /\n### Related\n- \[\[[^\]]+\]\] \(main\/memory\/[^)]+\)/);
    assert.match(t, /\n---\n\*1 primary, \d+ related \| depth=1 \| project: main\*$/);
    assert.strictEqual(s.text("build_context", { url: "memory://nothing/here", output_format: "text" }), "No results found for 'nothing/here' in project 'main'.");
    assert.ok(s.call("build_context", { url: "alice", page_size: 51 }).isError);
    assert.ok(s.call("build_context", { url: "alice", depth: "deep" }).isError);
  } finally { s.done(); }
});

test("recent_activity: newest first within the timeframe, type filter, pagination, json rows", () => {
  const s = setup();
  try {
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(s.kb.root, "memory/people/bob.md"), now, now);
    s.srv.store.scan();
    const t = s.text("recent_activity", {});
    assert.match(t, /^## Recent Activity: main \(7d\)\n\n\*\*📄 Recent Notes & Documents \(\d+\):\*\*\n  • bob \(memory\/people\) \[id: [0-9a-f-]{36}\]/);
    assert.ok(!t.includes("Rugby Club"), "40-day-old note outside 7d");
    assert.ok(s.text("recent_activity", { timeframe: "60d", page_size: 50 }).includes("Rugby Club"));
    const p1 = s.text("recent_activity", { page_size: 2 });
    assert.match(p1, /\*\*Activity Summary:\*\* Showing 2 items \(page 1\)\. Use page=2 to see more\.$/);
    const obs = s.text("recent_activity", { type: "observation" });
    assert.match(obs, /\*\*🔍 Recent Observations \(\d+\):\*\*\n  \*\*/);
    const rel = s.text("recent_activity", { type: ["relation"] });
    assert.match(rel, /  • \[\[bob\]\] → links_to → \[\[alice\]\]/);
    const rows = JSON.parse(s.call("recent_activity", { output_format: "json", page_size: 3 }).content[0].text);
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(Object.keys(rows[0]), ["type", "title", "permalink", "file_path", "created_at"]);
    assert.strictEqual(rows[0].title, "bob");
    assert.match(s.text("recent_activity", { timeframe: "1h", type: "entity" }), /bob/);
    assert.match(s.text("recent_activity", { page: 9 }), /Nothing on page 9/);
    assert.ok(s.call("recent_activity", { type: "nonsense" }).isError);
  } finally { s.done(); }
});

test("list_directory: depth, folders first, glob, sort, pagination, json", () => {
  const s = setup();
  try {
    const root = s.text("list_directory", {});
    assert.match(root, /^Contents of '\/' \(depth 1\):\nPage 1 \(page size 10, 2 total items\)\n\n📁 docs {27}\/docs\n📁 memory {25}\/memory\n\nTotal: 2 items \(2 directories\)$/);
    const mem = s.text("list_directory", { dir_name: "/memory", depth: 1 });
    assert.match(mem, /📁 notes +\/memory\/notes\n📁 people +\/memory\/people\n📁 projects +\/memory\/projects\n\n📄 MEMORY\.md +memory\/MEMORY\.md \| MEMORY \| \d{4}-\d\d-\d\d \| id: /);
    const deep = s.json("list_directory", { dir_name: "memory", depth: 2, page_size: 200 });
    assert.ok(deep.nodes.some((n) => n.type === "file" && n.path === "memory/people/alice.md" && n.title === "Alice Martin"));
    const glob = s.text("list_directory", { dir_name: "/memory/people", file_name_glob: "a*" });
    assert.match(glob, /^Files in '\/memory\/people' matching 'a\*' \(depth 1\):/);
    assert.ok(glob.includes("alice.md") && !glob.includes("bob.md"));
    const byTitleDesc = s.json("list_directory", { dir_name: "/memory/people", sort: "title_desc" });
    assert.deepStrictEqual(byTitleDesc.nodes.map((n) => n.name), ["bob.md", "alice.md"]);
    const paged = s.text("list_directory", { dir_name: "/memory", depth: 3, page_size: 2 });
    assert.match(paged, /More entries on the next page: list_directory\(dir_name='\/memory', depth=3, page=2, page_size=2\)$/);
    assert.match(s.text("list_directory", { dir_name: "/nowhere" }), /^No files found in directory '\/nowhere'/);
    assert.ok(s.call("list_directory", { dir_name: "/../.." }).isError);
  } finally { s.done(); }
});

test("projects, workspaces, diagnostics; write tools read-only; schema/project tools not supported; unknown tool → null", () => {
  const s = setup();
  try {
    assert.match(s.text("list_memory_projects", {}), /^Available projects:\n- main \(local\) \[[0-9a-f-]{36}\]/);
    assert.strictEqual(s.json("list_memory_projects", {}).projects[0].name, "main");
    assert.match(s.text("list_workspaces", {}), /^Available workspaces:/);
    const d = s.text("basic_memory_diagnostics", {});
    assert.match(d, /notes indexed: 9/);
    assert.match(d, /memory\/notes\/latin1\.md: not valid UTF-8/);
    assert.match(d, /memory\/notes\/huge\.md: too large/);
    for (const name of ["write_note", "edit_note", "move_note", "delete_note"]) {
      const r = s.call(name, { title: "x", content: "y", directory: "z", identifier: "alice", operation: "append" });
      assert.strictEqual(r.isError, true, name);
      assert.strictEqual(r.content[0].text, READ_ONLY_MESSAGE);
    }
    assert.ok(fs.readFileSync(path.join(s.kb.root, "memory/people/alice.md"), "utf8").includes("Alice is a friend"), "nothing written");
    for (const name of ["schema_validate", "schema_infer", "schema_diff", "create_memory_project", "delete_project"]) {
      const r = s.call(name, {});
      assert.strictEqual(r.isError, true);
      assert.match(r.content[0].text, /not supported by memglow memory server/);
    }
    assert.strictEqual(s.call("no_such_tool", {}), null);
  } finally { s.done(); }
});
