"use strict";
// memglow memory server (stage 0.4.5.2) — golden compatibility of the frontmatter write_note
// writes: for representative note shapes (synthetic content, modelled on the shapes the owner's
// basic-memory notes have), the file is laid out exactly as basic-memory lays it out: key order
// (title, type, permalink, metadata keys, tags), quoting (plain / 'single' / "double"), folding
// after column 80 with a 2-space continuation, block lists not indented under their key.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const { makeKb } = require("./fixtures/memory-kb");
const { dumpYaml } = require("../lib/store/yaml-dump");
const { generatePermalink, sanitizeForFilename, sanitizeForDirectory } = require("../lib/store/permalink");

const GOLDEN = [
  {
    name: "project note with tags only",
    args: { title: "project-greenhouse-heating", directory: "memory/project/home", note_type: "project", tags: ["home", "garden", "heating"], content: "# Greenhouse heating\n\nPlan.\n" },
    file: "memory/project/home/project-greenhouse-heating.md",
    fm: "title: project-greenhouse-heating\ntype: project\npermalink: main/memory/project/home/project-greenhouse-heating\ntags:\n- home\n- garden\n- heating\n",
  },
  {
    name: "memory card: name/theme/sous_theme/description, plain short description",
    args: { title: "user-sample-person", directory: "memory/user", note_type: "user", content: "Body.", metadata: { name: "user-sample-person", theme: "family", sous_theme: "household", description: "A sample person of the household" } },
    file: "memory/user/user-sample-person.md",
    fm: "title: user-sample-person\ntype: user\npermalink: main/memory/user/user-sample-person\nname: user-sample-person\ntheme: family\nsous_theme: household\ndescription: A sample person of the household\n",
  },
  {
    name: "description with ': ' → single quotes, folded after column 80",
    args: { title: "reference-sample-api", directory: "memory/reference/tech", note_type: "reference", content: "x", metadata: { theme: "tech", description: "Sample API access: tokens, rate limits, the retry policy and where the credentials live on the server" } },
    file: "memory/reference/tech/reference-sample-api.md",
    fm: "title: reference-sample-api\ntype: reference\npermalink: main/memory/reference/tech/reference-sample-api\ntheme: tech\ndescription: 'Sample API access: tokens, rate limits, the retry policy and where the\n  credentials live on the server'\n",
  },
  {
    name: "apostrophe inside single quotes is doubled",
    args: { title: "feedback-sample-tone", directory: "memory/feedback", note_type: "feedback", content: "x", metadata: { description: "Hard rule: the owner's preferred tone, and when not to use it" } },
    file: "memory/feedback/feedback-sample-tone.md",
    fm: "title: feedback-sample-tone\ntype: feedback\npermalink: main/memory/feedback/feedback-sample-tone\ndescription: 'Hard rule: the owner''s preferred tone, and when not to use it'\n",
  },
  {
    name: "long plain description folded, accents and an em dash kept",
    args: { title: "project-sample-renovation", directory: "memory/project/home", note_type: "project", content: "x", metadata: { description: "Renovation of the kitchen and the bathroom in the summer of 2026 — budget, artisans, planning and décor choices" } },
    file: "memory/project/home/project-sample-renovation.md",
    fm: "title: project-sample-renovation\ntype: project\npermalink: main/memory/project/home/project-sample-renovation\ndescription: Renovation of the kitchen and the bathroom in the summer of 2026 — budget,\n  artisans, planning and décor choices\n",
  },
  {
    name: "nested map, then tags after the metadata keys",
    args: { title: "project-sample-bridge", directory: "memory/project/home", note_type: "project", tags: ["home", "cameras"], content: "x", metadata: { name: "project-sample-bridge", theme: "home", metadata: { type: "project", node_type: "memory" } } },
    file: "memory/project/home/project-sample-bridge.md",
    fm: "title: project-sample-bridge\ntype: project\npermalink: main/memory/project/home/project-sample-bridge\nname: project-sample-bridge\ntheme: home\nmetadata:\n  type: project\n  node_type: memory\ntags:\n- home\n- cameras\n",
  },
  {
    name: "strings that would read back as other types are quoted; real numbers/booleans are not",
    args: { title: "Sample Scalars", directory: "notes", content: "x", metadata: { date: "2026-10-01", count: "12", answer: "yes", nothing: "null", empty: "", real_count: 12, ratio: 1.5, done: true, none: null, version: "1.2.3" } },
    file: "notes/Sample Scalars.md",
    fm: "title: Sample Scalars\ntype: note\npermalink: main/notes/sample-scalars\ndate: '2026-10-01'\ncount: '12'\nanswer: 'yes'\nnothing: 'null'\nempty: ''\nreal_count: 12\nratio: 1.5\ndone: true\nnone: null\nversion: 1.2.3\n",
  },
  {
    name: "multi-line value, tab (double quotes), leading indicator characters",
    args: { title: "sample-specials", directory: "notes", content: "x", metadata: { lines: "first line\nsecond line", tabbed: "a\tb", dash: "- not a list", hash: "#not-a-comment", star: "*bold*", colon_end: "ends with:" } },
    file: "notes/sample-specials.md",
    fm: "title: sample-specials\ntype: note\npermalink: main/notes/sample-specials\nlines: 'first line\n\n  second line'\ntabbed: \"a\\tb\"\ndash: '- not a list'\nhash: '#not-a-comment'\nstar: '*bold*'\ncolon_end: 'ends with:'\n",
  },
  {
    name: "unicode kept as is (emoji, Cyrillic), empty list and map, list of maps",
    args: { title: "Заметка ☕", directory: "notes", content: "x", metadata: { label: "Café ☕ time", ru: "Привет мир", none: [], obj: {}, people: [{ name: "Ann", role: "aunt" }, { name: "Bo" }] } },
    file: "notes/Заметка ☕.md",
    fm: "title: Заметка ☕\ntype: note\npermalink: main/notes/zametka\nlabel: Café ☕ time\nru: Привет мир\nnone: []\nobj: {}\npeople:\n- name: Ann\n  role: aunt\n- name: Bo\n",
  },
  {
    name: "content carrying its own frontmatter: merged, its type wins, body trimmed",
    args: { title: "sample-merged", directory: "notes", note_type: "note", content: "---\ntype: guide\nstatus: draft\nwhen: 2026-01-02\n---\n\n# Body\n\ntext\n\n", metadata: { status: "active" }, tags: "x, y" },
    file: "notes/sample-merged.md",
    fm: "title: sample-merged\ntype: guide\npermalink: main/notes/sample-merged\nstatus: active\nwhen: 2026-01-02\ntags:\n- x\n- y\n",
    body: "\n# Body\n\ntext",
  },
  {
    name: "a title with path and reserved characters, camelCase and an apostrophe",
    args: { title: "Plan: Q3/Q4 \"draft\" — l'été myProject?", directory: "/notes//sub/", content: "x" },
    file: "notes/sub/Plan- Q3-Q4 -draft- — l'été myProject.md",
    fm: "title: 'Plan: Q3/Q4 \"draft\" — l''été myProject?'\ntype: note\npermalink: main/notes/sub/plan-q3-q4-draft-lete-my-project\n",
  },
];

test("golden: write_note frontmatter is laid out exactly like basic-memory's", async () => {
  const kb = makeKb();
  const srv = createMemoryServer({ root: kb.root, readOnly: false, watch: false, pollMs: 0, fsync: false });
  try {
    for (const g of GOLDEN) {
      const r = await srv.tools.call("write_note", g.args);
      assert.strictEqual(r.isError, false, g.name + ": " + r.content[0].text);
      assert.match(r.content[0].text, new RegExp("^# Created note\\nproject: main\\nfile_path: " + g.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n"), g.name);
      const text = fs.readFileSync(path.join(kb.root, g.file), "utf8");
      const body = g.body != null ? g.body : "\n" + g.args.content;
      assert.strictEqual(text, "---\n" + g.fm + "---\n" + body, g.name);
    }
  } finally { srv.close(); kb.cleanup(); }
});

test("yaml writer: folding, quoting and indentation rules", () => {
  // A plain scalar breaks at the first single space past column 80.
  const words = "word ".repeat(30).trim();
  const out = dumpYaml({ description: words });
  for (const l of out.split("\n").slice(1, -1)) assert.match(l, /^ {2}\S/);
  assert.ok(out.split("\n")[0].length > 80 && out.split("\n")[0].length < 86);
  assert.strictEqual(dumpYaml({}), "{}\n");
  assert.strictEqual(dumpYaml({ a: [[1, 2], [3]] }), "a:\n- - 1\n  - 2\n- - 3\n");
  assert.strictEqual(dumpYaml({ a: { b: ["x", "y"] } }), "a:\n  b:\n  - x\n  - y\n");
  assert.strictEqual(dumpYaml({ "key: odd": 1, "1x": "x" }), "'key: odd': 1\n1x: x\n");
  assert.strictEqual(dumpYaml({ e: "a\u0007b", u: "😀\tx" }), "e: \"a\\ab\"\nu: \"\\U0001F600\\tx\"\n");
  assert.strictEqual(dumpYaml({ t: " lead", s: "trail ", on: "on", off: "Off", tilde: "~" }), "t: ' lead'\ns: 'trail '\n'on': 'on'\n'off': 'Off'\ntilde: '~'\n");
  assert.strictEqual(dumpYaml({ f: 1.5e-10, g: 0.0001, h: 1e-7, i: 123.456 }), "f: 1.5e-10\ng: 0.0001\nh: 1.0e-07\ni: 123.456\n");
});

test("file names and permalinks follow basic-memory's rules", () => {
  assert.strictEqual(sanitizeForFilename("a/b\\c:d*e?"), "a-b-c-d-e");
  assert.strictEqual(sanitizeForFilename("..hidden.."), "hidden");
  assert.strictEqual(sanitizeForDirectory("./memory//people/ "), "memory/people");
  assert.strictEqual(sanitizeForDirectory("a$b/c!d"), "ab/cd");
  assert.strictEqual(generatePermalink("docs/My Feature.md"), "docs/my-feature");
  assert.strictEqual(generatePermalink("specs/API (v2).md"), "specs/api-v2");
  assert.strictEqual(generatePermalink("design/unified_model_refactor.md"), "design/unified-model-refactor");
  assert.strictEqual(generatePermalink("Version 2.0.0"), "version-2.0.0");
  assert.strictEqual(generatePermalink("notes/Été à l'école — Noël.md"), "notes/ete-a-lecole-noel");
  assert.strictEqual(generatePermalink("notes/Jean-Éric O’Neil.md"), "notes/jean-eric-oneil");
  assert.strictEqual(generatePermalink("people/Жизнь и работа.md"), "people/zhizn-i-rabota");
  assert.strictEqual(generatePermalink("中文/测试文档.md"), "中文/测试文档");
  assert.strictEqual(generatePermalink("x/emoji 🎉 party.md"), "x/emoji-party");
  assert.strictEqual(generatePermalink("x/myCamelCase.md"), "x/my-camel-case");
});
