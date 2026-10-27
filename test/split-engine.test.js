"use strict";
// lib/split-engine.js — the zero-loss split engine: pure partition logic (computeSplit) and the
// store/writer-backed apply (splitNote), including dry_run, the hub-and-spoke frontmatter/body
// conventions, the hard zero-loss refusal, and the "hub is itself a part" chain.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const engine = require("../lib/split-engine");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeSrv(notes) {
  const root = tmp("memglow-split-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false });
  return { root, srv, cleanup: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const BIG = [
  "---", "title: big-note", "type: note", "permalink: main/memory/big-note", "theme: knowledge", "subtheme: tools",
  "tags:", "- ops", "- infra", "description: A big note", "---", "",
  "Intro line kept at the top.",
  "",
  "## Alpha",
  "Alpha body line one.",
  "Alpha body line two.",
  "",
  "### Alpha detail",
  "A nested detail of Alpha that must move WITH Alpha.",
  "",
  "## Beta",
  "Beta body line.",
  "",
  "## Gamma",
  "Gamma body line.",
  "",
].join("\n");

test("computeSplit: moves whole sections (with their subsections), zero-loss holds", () => {
  const r = engine.computeSplit(require("../lib/store/note-edit").splitNote(BIG).body, {
    parts: [
      { slug: "big-note-alpha", description: "Alpha stuff", hook: "all things alpha", sections: ["Alpha"] },
      { slug: "big-note-beta-gamma", description: "Beta and Gamma", sections: ["Beta", "Gamma"] },
    ],
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.parts[0].content, /Alpha body line one/);
  assert.match(r.parts[0].content, /nested detail of Alpha/, "the ### subsection moved WITH its ## parent");
  assert.match(r.parts[1].content, /Beta body line/);
  assert.match(r.parts[1].content, /Gamma body line/);
  assert.match(r.hubKept, /Intro line kept at the top/);
  assert.doesNotMatch(r.hubKept, /Alpha body/);
});

test("computeSplit: lines (content not under a heading) can be moved too", () => {
  const body = "Intro A.\nIntro B.\n\n## Only\nSection text.\n";
  const r = engine.computeSplit(body, { parts: [{ slug: "note-intro", description: "Just the intro", lines: ["Intro A."] }] });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.parts[0].content, "Intro A.");
  assert.match(r.hubKept, /Intro B\./);
  assert.match(r.hubKept, /Section text\./);
});

test("computeSplit refusals: unknown heading, duplicate assignment (overlap), bad slug, empty part, duplicate slug", () => {
  const body = require("../lib/store/note-edit").splitNote(BIG).body;
  const unknown = engine.computeSplit(body, { parts: [{ slug: "x", description: "d", sections: ["Nope"] }] });
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.errors[0], /found 0 time/);

  const overlap = engine.computeSplit(body, { parts: [
    { slug: "a", description: "d", sections: ["Alpha"] },
    { slug: "b", description: "d", sections: ["Alpha detail"] },
  ] });
  assert.strictEqual(overlap.ok, false);
  assert.match(overlap.errors.join(" "), /overlaps a section already assigned/);

  const badSlug = engine.computeSplit(body, { parts: [{ slug: "Not_Kebab", description: "d", sections: ["Alpha"] }] });
  assert.strictEqual(badSlug.ok, false);
  assert.match(badSlug.errors[0], /kebab/);

  const empty = engine.computeSplit(body, { parts: [{ slug: "a", description: "d" }] });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.errors[0], /no "sections" or "lines"/);

  const dup = engine.computeSplit(body, { parts: [
    { slug: "same", description: "d", sections: ["Alpha"] },
    { slug: "same", description: "d", sections: ["Beta"] },
  ] });
  assert.strictEqual(dup.ok, false);
  assert.match(dup.errors.join(" "), /used twice/);

  const twice = engine.computeSplit(body, { parts: [{ slug: "a", description: "d", sections: ["Alpha", "Alpha"] }] });
  assert.strictEqual(twice.ok, false);
});

test("splitNote (apply): hub frontmatter byte-identical, ## Parts created, parts' frontmatter and Up: line, zero loss end to end", async () => {
  const { root, srv, cleanup } = makeSrv({ "memory/big-note.md": BIG });
  try {
    const before = fs.readFileSync(path.join(root, "memory/big-note.md"), "utf8");
    const beforeFm = require("../lib/store/note-edit").splitNote(before).block;
    const plan = {
      hub_summary: "Split into alpha and beta/gamma parts.",
      parts: [
        { slug: "big-note-alpha", description: "Alpha stuff", hook: "all things alpha", sections: ["Alpha"] },
        { slug: "big-note-beta-gamma", description: "Beta and Gamma", hook: "the rest", sections: ["Beta", "Gamma"] },
      ],
    };
    const res = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "big-note", plan, now: Date.parse("2026-10-27") });
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    assert.strictEqual(res.dryRun, false);

    const hubAfter = fs.readFileSync(path.join(root, "memory/big-note.md"), "utf8");
    const hubSplit = require("../lib/store/note-edit").splitNote(hubAfter);
    assert.strictEqual(hubSplit.block, beforeFm, "hub frontmatter kept byte-for-byte");
    assert.match(hubAfter, /Intro line kept at the top\./);
    assert.match(hubAfter, /Split into alpha and beta\/gamma parts\./);
    assert.match(hubAfter, /## Parts\n- \[\[big-note-alpha\]\] — all things alpha\n- \[\[big-note-beta-gamma\]\] — the rest/);
    assert.doesNotMatch(hubAfter, /Alpha body line/);

    const alphaText = fs.readFileSync(path.join(root, "memory/big-note-alpha.md"), "utf8");
    assert.match(alphaText, /^---\ntitle: Big Note Alpha\ntype: note\npermalink: main\/memory\/big-note-alpha\nname: big-note-alpha\ntheme: knowledge\nsubtheme: tools\ndescription: Alpha stuff\npart_of: big-note\ntags:\n- ops\n- infra\n---\n/);
    assert.match(alphaText, /Up: \[\[big-note\]\] — split on 2026-10-27: Alpha stuff\./);
    assert.match(alphaText, /Alpha body line one\./);
    assert.match(alphaText, /nested detail of Alpha/);

    const bgText = fs.readFileSync(path.join(root, "memory/big-note-beta-gamma.md"), "utf8");
    assert.match(bgText, /Beta body line\./);
    assert.match(bgText, /Gamma body line\./);

    // Zero loss across the whole set of files.
    const concat = hubAfter + alphaText + bgText;
    for (const l of ["Intro line kept at the top.", "Alpha body line one.", "Alpha body line two.", "A nested detail of Alpha that must move WITH Alpha.", "Beta body line.", "Gamma body line."]) {
      assert.ok(concat.includes(l), `line kept somewhere: ${l}`);
    }
  } finally { cleanup(); }
});

test("splitNote: appends to an existing ## Parts section instead of creating a second one", async () => {
  const note = [
    "---", "title: hub-with-parts", "---", "",
    "Intro.", "",
    "## Parts", "- [[hub-with-parts-existing]] — already there", "",
    "## Zeta", "Zeta body.", "",
  ].join("\n");
  const { root, srv, cleanup } = makeSrv({ "memory/hub-with-parts.md": note });
  try {
    const res = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "hub-with-parts", plan: { parts: [{ slug: "hub-with-parts-zeta", description: "Zeta", sections: ["Zeta"] }] } });
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    const after = fs.readFileSync(path.join(root, "memory/hub-with-parts.md"), "utf8");
    const partsBlocks = after.match(/## Parts/g) || [];
    assert.strictEqual(partsBlocks.length, 1, "only one ## Parts section");
    assert.match(after, /- \[\[hub-with-parts-existing\]\] — already there\n- \[\[hub-with-parts-zeta\]\] — Zeta/);
  } finally { cleanup(); }
});

test("splitNote: refusals — missing lines, slug already exists; nothing written on failure", async () => {
  const { root, srv, cleanup } = makeSrv({ "memory/big-note.md": BIG, "memory/taken.md": "---\ntitle: taken\n---\n\nAlready here.\n" });
  try {
    const noMatch = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "big-note", plan: { parts: [{ slug: "x", description: "d", lines: ["Not a real line in the note"] }] } });
    assert.strictEqual(noMatch.ok, false);
    assert.match(noMatch.errors[0], /found 0 eligible time/);

    const existing = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "big-note", plan: { parts: [{ slug: "taken", description: "d", sections: ["Alpha"] }] } });
    assert.strictEqual(existing.ok, false);
    assert.match(existing.errors.join(" "), /already names an existing note/);
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/big-note.md"), "utf8"), BIG, "hub untouched on refusal");
  } finally { cleanup(); }
});

test("splitNote: dry_run returns previews and sizes, writes nothing", async () => {
  const { root, srv, cleanup } = makeSrv({ "memory/big-note.md": BIG });
  try {
    const res = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "big-note", plan: { parts: [{ slug: "big-note-alpha", description: "Alpha", sections: ["Alpha"] }] }, dryRun: true, threshold: 1 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(typeof res.hub.tokens, "number");
    assert.strictEqual(res.parts.length, 1);
    assert.match(res.parts[0].preview, /Alpha body line one/);
    assert.ok(res.warnings.length >= 0);
    assert.strictEqual(fs.existsSync(path.join(root, "memory/big-note-alpha.md")), false, "dry_run writes nothing");
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/big-note.md"), "utf8"), BIG, "hub untouched by dry_run");
  } finally { cleanup(); }
});

test("splitNote: the hub itself already a part (part_of: X) — new parts chain to X, bullets go to X's ## Parts, the hub gets no ## Parts of its own", async () => {
  const parent = ["---", "title: parent-hub", "---", "", "# Parent", "", "## Parts", "- [[child-spoke]] — the child", "",].join("\n");
  const child = [
    "---", "title: child-spoke", "part_of: parent-hub", "---", "",
    "Up: [[parent-hub]] — split on 2026-01-01: the child.", "",
    "Child intro.", "",
    "## Deep", "Deep content that is large enough to split out.", "",
  ].join("\n");
  const { root, srv, cleanup } = makeSrv({ "memory/parent-hub.md": parent, "memory/child-spoke.md": child });
  try {
    const res = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "child-spoke", plan: { parts: [{ slug: "child-spoke-deep", description: "Deep part", hook: "deep stuff", sections: ["Deep"] }] } });
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    const childAfter = fs.readFileSync(path.join(root, "memory/child-spoke.md"), "utf8");
    assert.doesNotMatch(childAfter, /## Parts/, "the split sub-note does not get its own ## Parts");
    const parentAfter = fs.readFileSync(path.join(root, "memory/parent-hub.md"), "utf8");
    assert.match(parentAfter, /- \[\[child-spoke\]\] — the child\n- \[\[child-spoke-deep\]\] — deep stuff/, "the new part's bullet went to the grandparent's ## Parts");
    const deepAfter = fs.readFileSync(path.join(root, "memory/child-spoke-deep.md"), "utf8");
    assert.match(deepAfter, /part_of: parent-hub/, "the new part chains to the grandparent, not the immediate hub");
    assert.match(deepAfter, /Up: \[\[parent-hub\]\]/);
  } finally { cleanup(); }
});

test("splitNote: read-only server refuses like other writes", async () => {
  const root = tmp("memglow-split-ro-");
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory/big-note.md"), BIG);
  const srv = createMemoryServer({ root, readOnly: true, watch: false, pollMs: 0 });
  try {
    const res = await engine.splitNote({ store: srv.store, writer: srv.writer, project: "main", identifier: "big-note", plan: { parts: [{ slug: "big-note-alpha", description: "d", sections: ["Alpha"] }] } });
    assert.strictEqual(res.ok, false);
    assert.match(res.errors[0], /read-only/);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
