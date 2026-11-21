"use strict";
// core-perf: the search index keeps a note's text as word ids (lib/store/search.js textOf) instead
// of a phrase string plus one Set of terms per line. These tests pin the BEHAVIOUR to the plain
// definitions the old structures implemented — a snippet is the best body line by the documented
// arithmetic, a phrase is a run of whole words in title + description + tags + body — computed
// here the naive way, and compared on a generated notes folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createSearch, snippet, clip, buildIndex } = require("../lib/store/search");
const { words, terms } = require("../lib/store/text");
const { makeSyntheticKb } = require("../bench/core-perf");

function kb(count = 60) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-core-perf-index-"));
  makeSyntheticKb(dir, count);
  const store = createStore({ root: dir, watch: false, pollMs: 0 });
  store.start();
  return { dir, store, close: () => { store.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The documented snippet rule, line by line with plain Sets. */
function naiveSnippet(note, qterms) {
  if (!qterms.length) return "";
  const want = [...new Set(qterms)];
  const lines = note.lines;
  let best = -1, bestHits = 0;
  lines.forEach((line, li) => {
    const ts = new Set(terms(line));
    let hits = 0;
    for (const q of want) {
      if (ts.has(q)) hits += 1;
      else if (q.length >= 3 && [...ts].some((t) => t !== q && t.startsWith(q))) hits += 0.6;
    }
    if (hits > bestHits) { bestHits = hits; best = li; }
  });
  const text = best >= 0 ? lines[best].trim() : "";
  return text ? clip(text.replace(/\s+/g, " "), want, 200) : "";
}

const naivePhraseText = (n) => " " + words(n.title).concat(words(n.description), words(n.tags.join(" ")), words(n.body)).join(" ") + " ";

test("core-perf index: a snippet is the best line by the documented arithmetic (naive reference)", () => {
  const k = kb();
  try {
    const notes = k.store.notes();
    const queries = [["tomate"], ["serveur", "sauvegarde"], ["rout"], ["sauvegard", "docker", "maison"], ["zzzabsent"], ["chantier", "chantier"], ["de"], ["2026", "10"], ["partie", "hub", "rugby", "wifi"]];
    let checked = 0;
    for (const n of notes) for (const q of queries) { assert.strictEqual(snippet(n, q), naiveSnippet(n, q), `${n.rel} / ${q.join(" ")}`); checked++; }
    assert.ok(checked > 500);
  } finally { k.close(); }
});


test("core-perf index: a snippet with more than 30 query terms follows the same rule", () => {
  const k = kb(40);
  try {
    const vocab = [...new Set(k.store.notes().flatMap((n) => terms(n.body.slice(0, 3000))))].sort();
    const many = vocab.filter((_, i) => i % 2 === 0).slice(0, 64).map((t, i) => (i % 5 === 0 && t.length > 4 ? t.slice(0, 3) : t));
    assert.ok(many.length > 40, "enough terms for several passes");
    for (const n of k.store.notes().slice(0, 25)) assert.strictEqual(snippet(n, many), naiveSnippet(n, many), n.rel);
  } finally { k.close(); }
});

test("core-perf index: a quoted phrase matches exactly the notes whose words hold it in a row", () => {
  const k = kb();
  try {
    const eng = createSearch(k.store, null, null);
    const notes = k.store.notes();
    const phrases = ["sauvegarde du serveur", "du serveur est", "de la", "partie 3 du chantier", "serveur sauvegarde", "journal du chantier 2", "le conteneur docker et la domotique", "zzz absent"];
    // A phrase running from the end of a title into the description, and one from the tags into the body.
    const n0 = notes.find((n) => n.description && words(n.title).length > 1);
    phrases.push(words(n0.title).slice(-1).concat(words(n0.description).slice(0, 2)).join(" "));
    let nonEmpty = 0;
    for (const p of phrases) {
      const needle = " " + words(p).join(" ") + " ";
      const expected = notes.filter((n) => naivePhraseText(n).includes(needle)).map((n) => n.permalink).sort();
      const got = eng.search({ query: `"${p}"`, page_size: 1000 }).results.map((h) => h.note.permalink).sort();
      assert.deepStrictEqual(got, expected, `phrase "${p}"`);
      if (expected.length) nonEmpty++;
      // The same phrase excluded: every other note that matches the remaining word.
      const kept = eng.search({ query: `chantier NOT "${p}"`, page_size: 1000 }).results.map((h) => h.note.permalink);
      for (const pl of kept) assert.ok(!expected.includes(pl), `NOT "${p}" still returned ${pl}`);
    }
    assert.ok(nonEmpty >= 5, "the fixture exercises real matches");
  } finally { k.close(); }
});

test("core-perf index: words written together (a hyphenated query word) still earn the phrase bonus", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-core-perf-phrase-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ntitle: alpha\n---\n\nThe basic memory sync runs nightly.\n");
    fs.writeFileSync(path.join(dir, "b.md"), "---\ntitle: beta\n---\n\nThe memory of a basic sync runs nightly.\n");
    const store = createStore({ root: dir, watch: false, pollMs: 0 });
    store.start();
    const r = createSearch(store, null, null).search({ query: "basic-memory" }).results;
    store.stop();
    assert.deepStrictEqual(r.map((h) => h.note.title), ["alpha", "beta"]);
    assert.ok(r[0].score > r[1].score * 1.25, "the note with the words in a row ranks clearly first");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("core-perf index: an index updated after writes answers exactly like one built from scratch", () => {
  const k = kb(50);
  try {
    const eng = createSearch(k.store, null, null);
    eng.warm();
    const notes = k.store.notes();
    // Change two notes, remove one, add one — through the store's own write path.
    const st = (rel) => fs.statSync(path.join(k.dir, rel));
    k.store.noteWritten(notes[3].rel, notes[3].raw + "\n\n## Zorglub\n\nun paragraphe tout neuf sur le zorglub du serveur\n", st(notes[3].rel));
    k.store.noteWritten(notes[7].rel, notes[7].raw.replace(/serveur/g, "ordinateur"), st(notes[7].rel));
    k.store.noteRemoved(notes[11].rel);
    k.store.noteWritten("memory/new-note.md", "---\ntitle: new note\n---\n\nle zorglub du serveur est neuf\n", st(notes[3].rel));
    const fresh = createSearch(k.store, null, null);
    const sig = (e, q) => JSON.stringify(e.search(q, 1e12).results.map((h) => [h.note.permalink, h.score, h.match]));
    for (const q of [{ query: "zorglub" }, { query: '"zorglub du serveur"' }, { query: "serveur sauvegarde", page_size: 50 }, { query: "ordinateur" }, { query: notes[11].title }, { query: "chantier AND zorglub" }, { query: "sauvegard*" }, { query: "serveurr" }]) {
      assert.strictEqual(sig(eng, q), sig(fresh, q), JSON.stringify(q));
    }
  } finally { k.close(); }
});

test("core-perf index: an entry keeps numbers, not a second copy of the note's words", () => {
  const k = kb(40);
  try {
    const I = buildIndex(k.store.notes());
    for (const d of I.docs) {
      assert.ok(d.text.seq instanceof Int32Array && d.text.lineEnd instanceof Int32Array);
      assert.strictEqual(d.text.lineEnd.length, d.note.lines.length, "one end offset per body line");
      assert.strictEqual(d.text.seq.length, words(d.note.title).length + words(d.note.description).length + words(d.note.tags.join(" ")).length + words(d.note.body).length);
      for (const key of ["phrase", "all", "fields"]) assert.ok(!(key in d), `no "${key}" kept per note`);
    }
    // One shared string per index term, whatever the number of notes holding it.
    const byTerm = new Map();
    for (const d of I.docs) for (const t of d.wtf.keys()) { const first = byTerm.get(t); if (first === undefined) byTerm.set(t, t); }
    assert.strictEqual(byTerm.size, I.vocab.length);
  } finally { k.close(); }
});

// ---- per-note keys kept between rebuilds (store lookups, hub resolver, levers' note index) ----

test("core-perf caches: a note's lookup keys follow the note — renamed, retitled, moved or removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-core-perf-keys-"));
  try {
    fs.mkdirSync(path.join(dir, "memory/a"), { recursive: true });
    const file = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); return fs.statSync(path.join(dir, rel)); };
    file("memory/a/First Note.md", "---\ntitle: Première Note\npermalink: main/custom/first\n---\n\nbody one\n");
    file("memory/a/second.md", "body two [[Première Note]]\n");
    const store = createStore({ root: dir, watch: false, pollMs: 0 });
    store.start();
    const rel = (id) => { const n = store.resolve(id); return n ? n.rel : null; };
    for (let round = 0; round < 2; round++) { // twice: the second pass reads the kept keys
      for (const id of ["main/custom/first", "custom/first", "memory://main/custom/first", "Première Note", "premiere note", "First Note", "first-note", "memory/a/First Note.md", "memory/a/first note", "main/memory/a/first-note", "memory/a/first-note"]) assert.strictEqual(rel(id), "memory/a/First Note.md", id);
      assert.strictEqual(rel("second"), "memory/a/second.md");
      assert.strictEqual(store.graph().incoming.get("memory/a/First Note.md")[0].from.rel, "memory/a/second.md");
    }
    // Retitled and given another permalink (same path): the old title and permalink no longer resolve.
    store.noteWritten("memory/a/First Note.md", "---\ntitle: Autre Titre\npermalink: main/custom/other\n---\n\nbody one\n", file("memory/a/First Note.md", "---\ntitle: Autre Titre\npermalink: main/custom/other\n---\n\nbody one\n"));
    assert.strictEqual(rel("Première Note"), null);
    assert.strictEqual(rel("main/custom/first"), null);
    assert.strictEqual(rel("autre titre"), "memory/a/First Note.md");
    assert.strictEqual(rel("custom/other"), "memory/a/First Note.md");
    assert.strictEqual(rel("first-note"), "memory/a/First Note.md", "the file name still resolves");
    // Moved: the old path is gone, the new one resolves, the other note is untouched.
    const text = store.resolve("custom/other").raw;
    store.noteRemoved("memory/a/First Note.md");
    store.noteWritten("memory/b/Moved.md", text, file("memory/b/Moved.md", text));
    assert.strictEqual(rel("memory/a/First Note.md"), null);
    assert.strictEqual(rel("first-note"), null);
    assert.strictEqual(rel("memory/b/moved"), "memory/b/Moved.md");
    assert.strictEqual(rel("custom/other"), "memory/b/Moved.md");
    assert.strictEqual(rel("second"), "memory/a/second.md");
    // A hub named by a part is found again by the search index after the hub itself was retitled.
    file("memory/hub.md", "---\ntitle: Jardin\ndescription: potager tomates\n---\n\nhub\n");
    file("memory/part.md", "---\ntitle: part\npart_of: hub\n---\n\nnothing about it here\n");
    store.scan();
    const eng = createSearch(store, null, null);
    assert.ok(eng.search({ query: "potager" }).results.some((h) => h.note.rel === "memory/part.md"), "the part is found by its hub's words");
    store.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("core-perf caches: the levers' note order on pre-split paths is lib/memory.js's walk order", () => {
  const { walkOrder, walkOrderSegs } = require("../memory-server/store-memory");
  const paths = ["a.md", "a/b.md", "a/b/c.md", "a-b.md", "b.md", "a/a.md", "Z.md", "a/B.md", "a/b", "ab/c.md", "a/b/c/d.md", "é.md", "a/é.md", "", "a"];
  for (const x of paths) for (const y of paths) assert.strictEqual(Math.sign(walkOrderSegs(x.split("/"), y.split("/"))), Math.sign(walkOrder(x, y)), `${x} / ${y}`);
  assert.deepStrictEqual(paths.slice().sort((a, b) => walkOrderSegs(a.split("/"), b.split("/"))), paths.slice().sort(walkOrder));
});

test("core-perf caches: the duplicate hint's note words are the same on every call, and never shared with a changed note", () => {
  const { duplicateHintCandidates } = require("../lib/levers/duplicate-hint");
  const notes = [{ id: "garden-watering-plan", label: "Garden watering plan", description: "summer schedule", tokens: 10 }, { id: "router-setup", label: "Router setup", description: "", tokens: 5 }];
  const first = duplicateHintCandidates(["garden", "watering", "plan"], notes);
  assert.deepStrictEqual(first, ["garden-watering-plan"]);
  assert.deepStrictEqual(duplicateHintCandidates(["garden", "watering", "plan"], notes), first);
  // Same id, another label: its words are looked up again, not taken from the previous version.
  assert.deepStrictEqual(duplicateHintCandidates(["garden", "watering", "plan"], [{ ...notes[0], label: "Kitchen recipes", id: "kitchen-recipes" }, notes[1]]), []);
});
