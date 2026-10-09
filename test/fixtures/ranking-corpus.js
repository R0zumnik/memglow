"use strict";
// Ranking regression corpus (0.4.10.2): the memory-server test fixture plus a larger synthetic
// notes folder (bench/responsiveness.js makeKb, accented FR/EN text), and a fixed query list.
// `rankingSnapshot(engine)` → the top-10 of every query (permalink, score, kind, match): compared
// against test/fixtures/ranking-golden.json, generated with the search code of 0.4.10.1 (before
// the tokenise-once / chunked warm-up changes), by `node test/fixtures/ranking-corpus.js --write`.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeKb: makeSynthetic } = require("../../bench/responsiveness");
const { makeKb } = require("./memory-kb");

function buildCorpus() {
  const kb = makeKb();
  makeSynthetic(path.join(kb.root, "synthetic"), 400);
  // A few notes with unusual text: NFD accents, ligatures, Greek final sigma, CRLF, emoji, a
  // standalone combining mark, digits, very long lines.
  const extra = {
    "memory/edge/nfd.md": "---\ntitle: Ecole NFD\n---\n\nL'école d'été à Orléans, café crème.\n",
    "memory/edge/ligatures.md": "---\ntitle: Œuvres et Æsir\n---\n\nL'œuvre de Straße, Ørsted et Łódź — ﬁn, ½ litre, ǣ.\n",
    "memory/edge/greek.md": "---\ntitle: ΟΔΥΣΣΕΥΣ\n---\n\nΟΔΥΣΣΕΥΣ ΚΑΙ ΠΗΝΕΛΟΠΗ. Σοφία σοφός.\n",
    "memory/edge/crlf.md": "---\r\ntitle: CRLF note\r\n---\r\n\r\nLine one café\r\nLine two école 😀 test\r\n---\r\nq́uestion 2026 v0.4.10\r\n",
    "memory/edge/long.md": "---\ntitle: Long line\n---\n\n" + "Le jardin et la forêt sont à côté du château; ".repeat(60) + "\n",
  };
  for (const [rel, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(kb.root, rel)), { recursive: true }); fs.writeFileSync(path.join(kb.root, rel), text); }
  // Fixed modification times (filter-only searches rank by mtime): the snapshot never depends on "now".
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
  walk(kb.root);
  all.forEach((p, i) => { const t = (Date.UTC(2026, 0, 1) + i * 3600000) / 1000; fs.utimesSync(p, t, t); });
  return kb;
}

const W = ("garden tomate rugby stade wifi routeur kayak pagaie recette pain école vacances budget facture médecin dentiste voiture garage piano leçon train billet musée livre roman film série serveur sauvegarde photo album été hiver forêt rivière château "
  + "memglow proxy levier index recherche mémoire note projet famille maison réseau domotique synology docker conteneur").split(" ");

function queries() {
  const q = [
    { query: "reseau" }, { query: "RÉSEAU" }, { query: "été" }, { query: "ete" }, { query: "le réseau de la maison" }, { query: "tomate" },
    { query: "garden" }, { query: "Rugby Club" }, { query: "rugby stade" }, { query: "alice" }, { query: '"vegetable garden"' },
    { query: "garden -rugby" }, { query: "garden NOT rugby" }, { query: "garden AND stade" }, { query: "garden OR zebra" }, { query: "courg" },
    { query: "court*" }, { query: "tag:friend" }, { query: "Garden", search_type: "title" }, { query: "garden project", search_type: "title" },
    { query: "memory/people", search_type: "permalink" }, { query: "memory://memory/people/*" }, { query: "garden", note_types: ["project"] },
    { query: "tea", entity_types: ["observation"] }, { query: "bob", entity_types: ["relation"] }, { query: "kumquat", page_size: 30 },
    { query: "arrosage" }, { query: "école" }, { query: "ecole" }, { query: "oeuvre" }, { query: "œuvre" }, { query: "strasse" }, { query: "orsted" },
    { query: "odysseus" }, { query: "οδυσσευς" }, { query: "σοφια" }, { query: "café crème" }, { query: '"jardin et la forêt"' }, { query: "question" },
    { query: "v0.4.10" }, { query: "2026" }, { query: "fin litre" }, { query: "chateau" }, { query: "the" }, { query: "les" },
  ];
  for (let i = 0; i < 40; i++) {
    const a = W[(i * 7) % W.length], b = W[(i * 11 + 3) % W.length], c = W[(i * 5 + 1) % W.length];
    q.push({ query: a }, { query: `${a} ${b}` }, { query: `${a} ${b} ${c}` });
    if (i % 4 === 0) q.push({ query: a.slice(0, 4) + "*" }, { query: `"${a} ${b}"` }, { query: `${a} -${b}` }, { query: `${a} AND ${c}` }, { query: `tag:${["family", "work", "home", "tech"][i % 4]} ${b}` });
  }
  return q;
}

function rankingSnapshot(engine) {
  return queries().map((args) => {
    const r = engine.search({ page_size: 10, ...args }, Date.UTC(2026, 9, 9));
    return { args, total: r.total, top: r.results.map((h) => ({ p: h.note.permalink, k: h.kind, s: Number(h.score.toPrecision(12)), m: h.match || "" })) };
  });
}

module.exports = { buildCorpus, queries, rankingSnapshot };

if (require.main === module && process.argv.includes("--write")) {
  const { createStore } = require("../../lib/store/store");
  const { createSearch } = require("../../lib/store/search");
  const kb = buildCorpus();
  const store = createStore({ root: kb.root, watch: false, pollMs: 0 }).start();
  const snap = rankingSnapshot(createSearch(store));
  fs.writeFileSync(path.join(__dirname, "ranking-golden.json"), JSON.stringify(snap, null, 0) + "\n");
  process.stdout.write(`wrote ${snap.length} queries, ${snap.reduce((a, x) => a + x.top.length, 0)} hits\n`);
  fs.rmSync(kb.root, { recursive: true, force: true });
  void os;
}
