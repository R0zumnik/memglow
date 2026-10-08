"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemory, linksOf, parseFrontmatter } = require("../lib/memory");
const { loadConfig } = require("../lib/config");

function tmpMemory(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-mem-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const config = loadConfig({}, os.tmpdir());

test("links ignore code spans and code blocks", () => {
  assert.deepStrictEqual(linksOf("see [[a]] and `[[b]]`\n```\n[[c]]\n```\n[[d|alias]] [[e#section]]"), ["a", "d", "e"]);
});

test("frontmatter: theme, subtheme and the sous_theme alias", () => {
  const { fm, body } = parseFrontmatter("---\ntitle: x\ntheme: projects\nsous_theme: home-lab\n---\nbody");
  assert.strictEqual(fm.theme, "projects");
  assert.strictEqual(fm.subtheme, "home-lab");
  assert.strictEqual(body, "body");
});

test("graph: nodes, deduplicated links, index node, unknown targets dropped", () => {
  const dir = tmpMemory({
    "MEMORY.md": "[[a]] [[b]]",
    "projects/a.md": "---\ntheme: projects\n---\n[[b]] [[missing]]",
    "knowledge/b.md": "---\ntheme: knowledge\nsubtheme: web\n---\n[[a]]",
  });
  const m = createMemory({ dir, config });
  const g = m.graph();
  assert.strictEqual(g.nodes.length, 3);
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.strictEqual(byId.MEMORY.theme, "index");
  assert.strictEqual(byId.b.subtheme, "web");
  const ab = g.links.filter((l) => [l.source, l.target].sort().join() === "a,b");
  assert.strictEqual(ab.length, 1, "a↔b counted once");
  assert.ok(!g.links.some((l) => l.target === "missing"));
});

test("a frontmatter-only change is not a write; a body change is", () => {
  const dir = tmpMemory({ "a.md": "---\ntitle: a\n---\nhello" });
  const m = createMemory({ dir, config });
  m.scan();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "---\ntitle: a\npermalink: x\n---\nhello");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.deepStrictEqual(m.scan(), []);
  fs.writeFileSync(f, "---\ntitle: a\n---\nhello again");
  fs.utimesSync(f, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  assert.deepStrictEqual(m.scan(), [{ type: "changed", id: "a" }]);
});

test("note body: secret-looking lines are masked", () => {
  const dir = tmpMemory({ "a.md": "api_key: sk-abcdefghijklmnop1234\nnormal line\ntoken = abcdefghijklmnopqrstuvwxyz0123456789" });
  const m = createMemory({ dir, config });
  const n = m.note("a", { withBody: true });
  assert.ok(!/sk-abc|abcdefghijklmnopqrstuvwxyz/.test(n.body));
  assert.ok(n.body.includes("normal line"));
  assert.strictEqual(m.note("a", { withBody: false }).body, undefined);
  assert.strictEqual(m.note("../etc/passwd", { withBody: true }), null);
});

test("activity: types, id resolution, unknown ids, rate limit", () => {
  const dir = tmpMemory({ "notes/my-note.md": "x", "other.md": "y" });
  const m = createMemory({ dir, config });
  m.scan();
  assert.deepStrictEqual(m.activity({ type: "read", ids: ["memory/notes/my_note.md"] }).ids, ["my-note"]);
  assert.strictEqual(m.activity({ type: "delete", ids: ["other"] }).reason, "type");
  assert.strictEqual(m.activity({ type: "read", ids: ["nope"] }).reason, "unknown");
  assert.strictEqual(m.activity([]).reason, "shape");
  let limited = false;
  for (let i = 0; i < 40; i++) if (m.activity({ type: "read", ids: ["other"] }).reason === "rate") limited = true;
  assert.ok(limited, "rate limit reached");
});

test("activity: machine and channel are validated, optional, additive", () => {
  const dir = tmpMemory({ "a.md": "x" });
  const m = createMemory({ dir, config });
  m.scan();
  // Valid: kept on the event.
  let r = m.activity({ type: "read", ids: ["a"], machine: "laptop-2", channel: "hook" });
  assert.strictEqual(r.ok, true);
  let evt = m.graph().activities.at(-1);
  assert.strictEqual(evt.machine, "laptop-2");
  assert.strictEqual(evt.channel, "hook");
  // Unknown channel, hostile machine (a path, an IP, too long, bad characters): dropped, never
  // reject the whole event — the ids still count and the activity is still shown.
  r = m.activity({ type: "read", ids: ["a"], machine: "../etc/passwd", channel: "ssh" });
  assert.strictEqual(r.ok, true);
  evt = m.graph().activities.at(-1);
  assert.strictEqual(evt.machine, undefined);
  assert.strictEqual(evt.channel, undefined);
  r = m.activity({ type: "read", ids: ["a"], machine: "192.168.1.5" });
  evt = m.graph().activities.at(-1);
  assert.strictEqual(evt.machine, undefined, "an IP is never accepted as a machine label");
  r = m.activity({ type: "read", ids: ["a"], machine: "x".repeat(40) });
  evt = m.graph().activities.at(-1);
  assert.strictEqual(evt.machine, undefined, "over the length limit");
  // An activity sent without them at all (every sender before v0.4) gets neither key.
  r = m.activity({ type: "read", ids: ["a"] });
  evt = m.graph().activities.at(-1);
  assert.ok(!("machine" in evt) && !("channel" in evt));
});

test("recent activity kept for the graph, demo activity is not", () => {
  const dir = tmpMemory({ "a.md": "x" });
  const m = createMemory({ dir, config });
  m.scan();
  m.activity({ type: "write", ids: ["a"], demo: true });
  assert.strictEqual(m.graph().activities.length, 0);
  m.activity({ type: "write", ids: ["a"] });
  assert.strictEqual(m.graph().activities.length, 1);
});

test("createMemory (0.4.4.4): costNotes()/graph() are sorted by relative path — deterministic regardless of creation order", () => {
  // Written in reverse alphabetical order (and across folders) on purpose: a plain readdirSync
  // would often just mirror that order back. costNotes()/graph() must come out sorted by relative
  // path every time, so every list derived from them (the always-loaded prefix's hash included)
  // never changes just because a filesystem happened to list entries differently.
  const dir = tmpMemory({
    "zeta.md": "z",
    "projects/y.md": "---\ntheme: projects\n---\ny",
    "alpha.md": "a",
    "projects/beta.md": "---\ntheme: projects\n---\nb",
  });
  const memory = createMemory({ dir, config });
  const ids1 = memory.costNotes().map((n) => n.rel);
  const sorted = ids1.slice().sort();
  assert.deepStrictEqual(ids1, sorted, "costNotes() already sorted by relative path");
  assert.deepStrictEqual(ids1, ["alpha.md", "projects/beta.md", "projects/y.md", "zeta.md"]);
  // graph() nodes come from the same sorted iteration.
  const nodeIds = memory.graph().nodes.map((n) => n.id);
  assert.deepStrictEqual(nodeIds, ["alpha", "beta", "y", "zeta"]);
  // Rescanning (e.g. after a poll) keeps the same order.
  memory.scan();
  assert.deepStrictEqual(memory.costNotes().map((n) => n.rel), ids1);
});

test("config: default themes, token and password minimum lengths", () => {
  assert.ok(config.themes.length >= 3);
  assert.throws(() => loadConfig({ MEMGLOW_TOKEN: "short" }, os.tmpdir()), /32/);
  assert.throws(() => loadConfig({ MEMGLOW_PASSWORD: "short" }, os.tmpdir()), /12/);
});
