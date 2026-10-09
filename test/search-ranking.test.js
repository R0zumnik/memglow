"use strict";
// 0.4.10.2 — ranking must not drift: the top-10 of 215 queries over the memory-server fixture plus
// a 400-note synthetic corpus (accented FR text, NFD, ligatures, Greek, CRLF…) is compared with a
// snapshot taken with the search code of 0.4.10.1 (test/fixtures/ranking-golden.json): same
// notes, same order, same kind and match snippet, same score (to 1e-9, relative).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { buildCorpus, rankingSnapshot } = require("./fixtures/ranking-corpus");
const { createStore } = require("../lib/store/store");
const { createSearch } = require("../lib/store/search");
const { fold } = require("../lib/store/text");

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ranking-golden.json"), "utf8"));

function compare(snap) {
  assert.strictEqual(snap.length, golden.length);
  for (let i = 0; i < golden.length; i++) {
    const g = golden[i], s = snap[i], label = JSON.stringify(g.args);
    assert.strictEqual(s.total, g.total, "total of " + label);
    assert.deepStrictEqual(s.top.map((h) => h.p + "|" + h.k), g.top.map((h) => h.p + "|" + h.k), "order of " + label);
    s.top.forEach((h, j) => {
      assert.strictEqual(h.m, g.top[j].m, "match of " + label + " #" + j);
      assert.ok(Math.abs(h.s - g.top[j].s) <= 1e-9 * Math.max(1, Math.abs(g.top[j].s)), `score of ${label} #${j}: ${h.s} vs ${g.top[j].s}`);
    });
  }
}

test("ranking: identical top-10 to the 0.4.10.1 snapshot (index built synchronously)", () => {
  const kb = buildCorpus();
  try {
    const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
    compare(rankingSnapshot(createSearch(store)));
  } finally { fs.rmSync(kb.root, { recursive: true, force: true }); }
});

test("ranking: identical after the chunked warm-up (warmAsync)", async () => {
  const kb = buildCorpus();
  try {
    const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
    const engine = createSearch(store);
    await engine.warmAsync();
    compare(rankingSnapshot(engine));
  } finally { fs.rmSync(kb.root, { recursive: true, force: true }); }
});

test("fold(): an NFD + strip-marks reference gives the same output as fold() on accented French text and on every code point", () => {
  // The reference: whole-string NFD, combining marks stripped, with the exact rules of the
  // per-character fold (ligatures, a mark or surrogate in the input → a space, the 5 BMP
  // characters whose canonical decomposition is ASCII punctuation → a space).
  const LIG = { "œ": "oe", "æ": "ae", "ß": "ss", "ø": "o", "đ": "d", "ł": "l", "ı": "i" };
  const ref = (s) => {
    let t = String(s).toLowerCase();
    if (!/[^\x00-\x7f]/.test(t)) return t;
    t = t.replace(/[\ud800-\udfff]/g, " ").replace(/[\p{M};`≠≮≯]/gu, " ").replace(/[œæßøđłı]/g, (c) => LIG[c]);
    return t.normalize("NFD").replace(/\p{M}+/gu, "").replace(/[^\x00-\x7f]/gu, (c) => (/^[\p{L}\p{N}]+$/u.test(c) ? c : " "));
  };
  const fr = ["Été à l'école, les élèves réfléchissent à la forêt.", "Ça déçoit : où est le cœur ? Noël, maïs, aïeul, Pâques, crème brûlée.",
    "L'ŒUVRE D'ÉTÉ — « garçon » naïf, ÀÉÈÙÂÊÎÔÛÄËÏÖÜŸÇ", "Straße, Ørsted, Łódź, æther, ½, ﬁn"];
  for (const s of fr) assert.strictEqual(fold(s), ref(s), s);
  for (let cp = 0x80; cp < 0x30000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const s = "x" + String.fromCodePoint(cp) + "y";
    if (fold(s) !== ref(s)) assert.fail(`U+${cp.toString(16)}: ${JSON.stringify(fold(s))} vs ${JSON.stringify(ref(s))}`);
  }
});
