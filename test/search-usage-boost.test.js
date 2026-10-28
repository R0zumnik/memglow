"use strict";
// lib/store/search.js — 0.5.5 (E, usage-aware search): the small, capped ranking boost from
// lib/learned-aliases.js's own usageBoosts(). `usage` is injected here as a plain
// `{ boostsFor(words, now) }` fake — never a real alias store — so this stays about the WIRING
// (does createSearch apply it, does it respect the cap, is it a no-op without one) rather than
// re-testing computeUsageBoosts' own decay math (test/learned-aliases.test.js already does that).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createSearch } = require("../lib/store/search");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function makeStore(notes) {
  const root = tmp("memglow-usage-boost-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const store = createStore({ root, watch: false, pollMs: 0 }).start();
  return { root, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("usage boost: null/omitted usage is byte-identical to before (no 3rd arg at all)", () => {
  const { store, cleanup } = makeStore({ "memory/broker.md": "---\ntitle: broker\n---\n\nBroker reconnect settings.\n" });
  try {
    const a = createSearch(store).search({ query: "broker" });
    const b = createSearch(store, null).search({ query: "broker" });
    assert.deepStrictEqual(a, b);
  } finally { cleanup(); }
});

test("usage boost: nudges a weaker-but-still-matching note ahead of an equally weak one", () => {
  // The boost only ever re-ranks notes the lexical engine ALREADY matched (it never fabricates a
  // result for a note with zero match at all — same conservative spirit as every other
  // score-only tie-breaker in this file, e.g. FIELD_WEIGHTS.hub).
  const { store, cleanup } = makeStore({
    "memory/other.md": "---\ntitle: other\n---\n\nSomewhere in the body, widget is mentioned once.\n",
    "memory/target.md": "---\ntitle: target\n---\n\nSomewhere in the body, widget is also mentioned once.\n",
  });
  try {
    const withoutUsage = createSearch(store).search({ query: "widget" });
    assert.strictEqual(withoutUsage.results.length, 2, "both match equally — a genuine near-tie");
    const usage = { boostsFor: (words) => (words.includes("widget") ? new Map([["target", 0.5]]) : new Map()) };
    const r = createSearch(store, null, usage).search({ query: "widget" });
    assert.strictEqual(r.results[0].note.title, "target", "the boosted note now wins the near-tie");
  } finally { cleanup(); }
});

test("usage boost: capped — never outranks a real, much stronger text match", () => {
  const { store, cleanup } = makeStore({
    "memory/strong-match.md": "---\ntitle: widget widget widget\n---\n\nwidget widget widget widget.\n",
    "memory/boosted-only.md": "---\ntitle: boosted-only\n---\n\nNo mention of the query term at all.\n",
  });
  try {
    // An absurdly large raw boost — computeUsageBoosts itself caps this long before it reaches
    // here, but the search-side wiring must never trust an unbounded value either.
    const usage = { boostsFor: () => new Map([["boosted-only", 1e9]]) };
    const engine = createSearch(store, null, usage);
    const r = engine.search({ query: "widget" });
    assert.strictEqual(r.results[0].note.title, "widget widget widget", "the real text match still wins — a title match alone outscores the boost");
  } finally { cleanup(); }
});

test("usage boost: never applied to a permalink/title lookup or an empty query (nothing to decay words from)", () => {
  const { store, cleanup } = makeStore({ "memory/n.md": "---\ntitle: n\n---\n\nBody.\n" });
  try {
    let calls = 0;
    const usage = { boostsFor: () => { calls++; return new Map(); } };
    const engine = createSearch(store, null, usage);
    engine.search({ query: "n", search_type: "title" });
    engine.search({ query: "" });
    assert.strictEqual(calls, 0);
  } finally { cleanup(); }
});
