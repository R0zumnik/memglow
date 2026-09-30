"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { estimateTokens, sectionsOf, packSections, computeCost, dayOf, daysBefore } = require("../lib/cost");
const { createCounters } = require("../lib/counters");
const page = require("../public/cost.js");

const NOW = new Date(2026, 9, 1, 15, 0, 0).getTime(); // Oct 1, 2026, local time
const TODAY = dayOf(NOW);
const note = (id, bytes, extra = {}) => ({ id, label: id.toUpperCase(), theme: "knowledge", subtheme: "general", folder: "knowledge", bytes, ...extra });

test("estimate: ceil(bytes / 4), from a byte count or a UTF-8 string", () => {
  assert.strictEqual(estimateTokens(0), 0);
  assert.strictEqual(estimateTokens(1), 1);
  assert.strictEqual(estimateTokens(20000), 5000);
  assert.strictEqual(estimateTokens("abcd"), 1);
  assert.strictEqual(estimateTokens("é"), 1, "2 bytes in UTF-8");
  assert.strictEqual(estimateTokens(-5), 0);
});

test("sections: ## to ###### headings, outside code blocks, intro kept", () => {
  const s = sectionsOf("intro\n## A\naaaa\n```\n## not a heading\n```\n### B\nbbbb\n# top level is not a cut\n");
  assert.deepStrictEqual(s.map((x) => x.title), ["", "A", "B"]);
  assert.ok(s.every((x) => x.tokens > 0));
  assert.deepStrictEqual(sectionsOf("no heading at all"), [{ title: "", tokens: 5 }]);
  assert.deepStrictEqual(sectionsOf(""), []);
});

test("split: consecutive sections packed greedily, deterministic, oversized section alone", () => {
  const secs = [{ title: "a", tokens: 900 }, { title: "b", tokens: 900 }, { title: "c", tokens: 3000 }, { title: "d", tokens: 100 }, { title: "e", tokens: 1900 }];
  const parts = packSections(secs, 2000);
  assert.deepStrictEqual(parts.map((p) => p.titles), [["a", "b"], ["c"], ["d", "e"]]);
  assert.deepStrictEqual(parts.map((p) => p.tokens), [1800, 3000, 2000]);
  assert.deepStrictEqual(packSections(secs, 2000), parts, "same input, same answer");
});

test("days: local calendar days, DST-safe", () => {
  assert.strictEqual(TODAY, "2026-10-01");
  assert.strictEqual(daysBefore(NOW, 6), "2026-09-25");
  assert.strictEqual(daysBefore(NOW, 29), "2026-09-02");
});

test("cost: tokens read and written, top notes, share, too large, index apart", () => {
  const notes = [note("MEMORY", 4000, { theme: "index" }), note("big", 30000), note("mid", 24000), note("small", 400), note("idle", 1200)];
  const days = {
    [TODAY]: { notes: { big: { read: 2, search: 1, write: 0 }, small: { read: 1, search: 0, write: 1 }, MEMORY: { read: 3, search: 0, write: 0 } } },
    [daysBefore(NOW, 3)]: { notes: { mid: { read: 1, search: 0, write: 0 }, gone: { read: 9, search: 0, write: 0 } } },
    [daysBefore(NOW, 10)]: { notes: { small: { read: 50, search: 0, write: 0 } } }, // outside 7 days
  };
  const c = computeCost(days, notes, NOW, { since: daysBefore(NOW, 10) });
  assert.strictEqual(c.read.today, 2 * 7500 + 100 + 3 * 1000);
  assert.strictEqual(c.read.days7, 2 * 7500 + 100 + 3 * 1000 + 6000, "a deleted note does not count");
  assert.strictEqual(c.written.today, 100);
  assert.strictEqual(c.written.days7, 100);
  assert.deepStrictEqual(c.top.map((n) => n.id), ["big", "mid", "small"], "index kept apart, sorted by tokens read");
  assert.strictEqual(c.top[0].reads7, 2);
  assert.strictEqual(c.top[0].readTokens7, 15000);
  assert.deepStrictEqual(c.share, { notes: 3, tokens: 21100, total: 24100, percent: 88 });
  assert.deepStrictEqual(c.tooLarge.map((n) => n.id), ["big", "mid"]);
  assert.deepStrictEqual(c.index, { id: "MEMORY", label: "MEMORY", tokens: 1000 });
  assert.deepStrictEqual(c.totals, { notes: 4, tokens: 7500 + 6000 + 100 + 300 });
  assert.strictEqual(c.sectionsIncluded, false);
  assert.strictEqual(c.top[0].sections, undefined);
});

test("cost: never read in 30 days only once 30 days of data exist", () => {
  const notes = [note("a", 100), note("b", 100), note("MEMORY", 100, { theme: "index" })];
  const days = { [TODAY]: { notes: { a: { read: 1, search: 0, write: 0 } } } };
  const young = computeCost(days, notes, NOW, { since: daysBefore(NOW, 5) });
  assert.deepStrictEqual(young.neverRead, { available: false, since: daysBefore(NOW, 5), notes: [], total: 0 });
  const old = computeCost(days, notes, NOW, { since: daysBefore(NOW, 40) });
  assert.strictEqual(old.neverRead.available, true);
  assert.deepStrictEqual(old.neverRead.notes.map((n) => n.id), ["b"], "index excluded");
});

test("cost: threshold and chunk size are configurable; sections only when bodies are given", () => {
  const body = "## One\n" + "x".repeat(4000) + "\n## Two\n" + "y".repeat(4000) + "\n## Three\n" + "z".repeat(4000);
  const notes = [note("n", 12100)];
  const c = computeCost({}, notes, NOW, { largeNoteTokens: 1000, chunkTokens: 1500, bodies: { n: body } });
  assert.strictEqual(c.largeNoteTokens, 1000);
  assert.deepStrictEqual(c.tooLarge[0].sections.map((s) => s.title), ["One", "Two", "Three"]);
  assert.strictEqual(c.tooLarge[0].split.length, 3, "each ≈ 1,000-token section on its own at 1,500");
  const none = computeCost({}, [note("n", 400)], NOW, {});
  assert.deepStrictEqual(none.tooLarge, []);
});

test("counters: per day, per note, per type; saved atomically; bad input ignored; reloaded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-counters-"));
  const c = createCounters({ dir, now: () => NOW });
  c.add({ type: "read", ids: ["a", "b"], t: NOW });
  c.add({ type: "read", ids: ["a"], t: NOW });
  c.add({ type: "write", ids: ["a"], t: NOW });
  c.add({ type: "delete", ids: ["a"], t: NOW });
  c.add({ type: "read", ids: ["../etc/passwd", "ok"], t: NOW });
  c.flush();
  assert.deepStrictEqual(c.days()[TODAY].notes.a, { read: 2, search: 0, write: 1 });
  assert.ok(!("../etc/passwd" in c.days()[TODAY].notes));
  const again = createCounters({ dir, now: () => NOW });
  assert.deepStrictEqual(again.days(), c.days());
  assert.strictEqual(again.since(), TODAY);
  assert.deepStrictEqual(fs.readdirSync(dir), ["activity-counts.json"], "no temporary file left");
});

test("counters: days older than 90 days are dropped; unwritable folder keeps counting in memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-counters-"));
  const old = NOW - 100 * 86400000;
  fs.writeFileSync(path.join(dir, "activity-counts.json"), JSON.stringify({ version: 1, since: dayOf(old), days: { [dayOf(old)]: { notes: { a: { read: 1 } } } } }));
  const c = createCounters({ dir, now: () => NOW });
  c.add({ type: "read", ids: ["a"], t: NOW });
  assert.deepStrictEqual(Object.keys(c.days()), [TODAY]);
  assert.ok(c.since() >= daysBefore(NOW, 89));

  const file = path.join(dir, "not-a-dir");
  fs.writeFileSync(file, "");
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const m = createCounters({ dir: file, now: () => NOW });
    m.add({ type: "read", ids: ["a"], t: NOW });
    m.flush();
    m.add({ type: "read", ids: ["a"], t: NOW });
    m.flush();
    assert.strictEqual(m.days()[TODAY].notes.a.read, 2);
    assert.strictEqual(warned, 1, "a single warning");
  } finally { console.warn = warn; }
});

// ---- page rendering (public/cost.js) ----

function sample() {
  const notes = [note("big", 30000, { label: "Big <script>alert(1)</script>", folder: "knowledge/ops", subtheme: "ops" }), note("MEMORY", 400, { theme: "index" })];
  const days = { [TODAY]: { notes: { big: { read: 3, search: 0, write: 0 } } } };
  const body = "## Q1 <img src=x onerror=alert(1)>\n" + "a".repeat(6000) + "\n## Q2\n" + "b".repeat(6000) + "\n## Q3\n" + "c".repeat(6000) + "\n## Q4\n" + "d".repeat(6000);
  return computeCost(days, notes, NOW, { since: TODAY, bodies: { big: body } });
}

test("page: every note and section title is escaped", () => {
  const html = page.costRender(sample(), { knowledge: "#4FD1E0" });
  assert.ok(!/<script>alert|<img src=x/.test(html));
  assert.ok(html.includes("Big &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("Q1 &lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes('data-copy="big"'), "copy button on the large note");
  assert.ok(html.includes("1 note</strong> = <strong>100 %"));
  assert.ok(html.includes("Data since Oct 1"));
  assert.ok(!/on[a-z]+="/i.test(html), "no inline handler");
});

test("page: an invalid theme colour never reaches a style attribute", () => {
  const c = sample();
  const html = page.costRender(c, { knowledge: "red;background:url(x)" });
  assert.ok(!html.includes("url(x)"));
});

test("page: the copy prompt carries the note, the numbers, the split and the rules", () => {
  const c = sample();
  const p = page.costSplitPrompt(c.tooLarge[0], c);
  assert.match(p, /id: big, folder: knowledge\/ops, theme: knowledge, subtheme: ops/);
  assert.match(p, /≈ 7,500 tokens/);
  assert.match(p, /Read 3 times in the last 7 days/);
  assert.match(p, /above ≈ 5,000 tokens/);
  assert.match(p, /1\. Q1 <img src=x onerror=alert\(1\)> — ≈ 1,50\d tokens/, "plain text, not HTML");
  for (const rule of [/same theme and the same folder/, /top-level themes/, /\[\[link\]\] valid/, /`theme` and `subtheme`/, /short summary .* or is removed/, /only your memory tool/, /plan .* BEFORE writing|show me the plan/i]) assert.match(p, rule);
  const without = page.costSplitPrompt({ id: "x", label: "X", tokens: 6000, reads7: 1, readTokens7: 6000 }, { largeNoteTokens: 5000, chunkTokens: 2000 });
  assert.match(without, /group consecutive ## sections/);
  assert.match(without, /Read 1 time in/);
});
