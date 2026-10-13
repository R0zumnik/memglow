#!/usr/bin/env node
"use strict";
/**
 * Semantic search eval — the real-quality check for lib/store/semantic.js. Replays a JSONL of
 * search→read pairs against a REAL notes folder and a REAL embeddings provider (Ollama, LM
 * Studio, llama.cpp's server, or any OpenAI-compatible endpoint — see README "Semantic search
 * (optional)"), and reports lexical ("text") vs the requested semantic search_type: rank of the
 * first result matching the pair's target note (1-based; 0 = not found on the page), MRR, and how
 * many pairs were found anywhere on the page — the same shape as the README/CHANGELOG's own
 * "N real search→read pairs" duels (e.g. basic-memory vs memglow's lexical engine).
 *
 * Committed generic, with NO private data: both the pairs file and the notes folder are given on
 * the command line. Nothing here is specific to any one person's memory.
 *
 *   # start a local embeddings model first, e.g.:
 *   ollama pull nomic-embed-text && ollama serve   # http://localhost:11434
 *
 *   node bench/semantic-eval.js --pairs eval-pairs.jsonl --memory ~/my-memory
 *   MEMGLOW_SEMANTIC_URL=http://localhost:11434 MEMGLOW_SEMANTIC_MODEL=nomic-embed-text \
 *     node bench/semantic-eval.js --pairs eval-pairs.jsonl --memory ~/my-memory --search-type hybrid
 *
 * Pairs file: one JSON object per line, `{"query": "...", "target": "<note slug, base name, or
 * permalink suffix>"}` (any other fields — e.g. the "bmRank"/"bmHits"/"file" a prior basic-memory
 * duel recorded — are read back and printed for comparison when present, otherwise ignored).
 *
 * The embeddings provider is read exactly the way the memory server itself reads it
 * (lib/store/semantic.js's resolveSemanticConfig: MEMGLOW_SEMANTIC_URL / _MODEL / _PROVIDER env,
 * or memglow.config.json's `search.semantic` section in MEMGLOW_CONFIG/~/.memglow) — if neither is
 * set, this script refuses to run rather than silently comparing lexical against itself.
 */
const fs = require("fs");
const path = require("path");
const { createStore } = require("../lib/store/store");
const { createSearch } = require("../lib/store/search");
const { createSemanticSearch } = require("../lib/store/semantic");

function parseArgs(argv) {
  const o = { pageSize: 10, searchType: "hybrid" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairs") o.pairs = argv[++i];
    else if (a === "--memory") o.memory = argv[++i];
    else if (a === "--search-type") o.searchType = argv[++i];
    else if (a === "--page-size") o.pageSize = Math.max(1, Number(argv[++i]) || 10);
    else if (a === "-h" || a === "--help") o.help = true;
    else o.unknown = (o.unknown || []).concat(a);
  }
  return o;
}

const HELP = `bench/semantic-eval.js — real-quality check for optional semantic search

usage:
  node bench/semantic-eval.js --pairs <pairs.jsonl> --memory <notes-dir> [--search-type hybrid|vector|semantic] [--page-size 10]

Configure the embeddings provider the same way the memory server reads it:
  MEMGLOW_SEMANTIC_URL=http://localhost:11434 MEMGLOW_SEMANTIC_MODEL=nomic-embed-text node bench/semantic-eval.js ...
or a "search": { "semantic": { "provider", "url", "model" } } section of memglow.config.json
(MEMGLOW_CONFIG, or ~/.memglow/memglow.config.json). See README "Semantic search (optional)".
`;

/** A note matches a pair's `target` by permalink, slug, base name, or a trailing path segment —
 * whatever form the pairs file happens to use (a prior basic-memory duel's own export, or a
 * hand-written one). */
function matchesTarget(note, target) {
  const t = String(target || "").trim().toLowerCase();
  if (!t) return false;
  const candidates = [note.permalink, note.slug, note.base, note.title].filter(Boolean).map((s) => String(s).toLowerCase());
  if (candidates.some((c) => c === t)) return true;
  return candidates.some((c) => c.endsWith("/" + t));
}

function rankOf(results, target) {
  for (let i = 0; i < results.length; i++) if (matchesTarget(results[i].note, target)) return i + 1;
  return 0;
}

function mrr(ranks) { return ranks.length ? ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length : 0; }
function inResults(ranks) { return ranks.filter((r) => r > 0).length; }

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (!o.pairs || !o.memory || o.unknown) { process.stderr.write(HELP); return 2; }
  if (!["hybrid", "vector", "semantic"].includes(o.searchType)) { process.stderr.write(`bad --search-type "${o.searchType}" (expected hybrid, vector or semantic)\n`); return 2; }

  const pairsFile = path.resolve(o.pairs);
  const pairs = fs.readFileSync(pairsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  if (!pairs.length) { process.stderr.write(`${pairsFile}: no pairs\n`); return 2; }

  const root = path.resolve(o.memory);
  const store = createStore({ root, watch: false, pollMs: 0 }).start();
  const semantic = createSemanticSearch({ store, autostart: false });
  if (!semantic.configured()) {
    process.stderr.write("semantic search is not configured — set MEMGLOW_SEMANTIC_URL/_MODEL/_PROVIDER, or memglow.config.json's search.semantic section. See README \"Semantic search (optional)\".\n");
    store.stop();
    return 2;
  }
  const s = semantic.stats();
  process.stderr.write(`Provider: ${s.provider} ${s.model || "(no model set)"} ${s.url || ""}\n`);
  process.stderr.write(`Notes: ${store.notes().length} under ${root}\n`);
  process.stderr.write("Embedding the notes folder (first run can take a while; cached afterwards in <dataDir>/embeddings.*)...\n");
  const t0 = Date.now();
  await semantic.embedAllOnce();
  process.stderr.write(`Embedding pass: ${Date.now() - t0} ms, ${semantic.stats().chunks} chunk(s) over ${semantic.stats().notes} note(s)${semantic.stats().down ? " — provider unreachable, results below are lexical-only" : ""}\n\n`);

  const lexical = createSearch(store, null);
  const engine = createSearch(store, semantic);

  const lexRanks = [], semRanks = [];
  process.stdout.write(`lexical\t${o.searchType}\tquery → target\n`);
  for (const p of pairs) {
    const lr = lexical.search({ query: p.query, page_size: o.pageSize, search_type: "text" });
    const lexRank = rankOf(lr.results, p.target);
    const srRaw = engine.search({ query: p.query, page_size: o.pageSize, search_type: o.searchType });
    const sr = srRaw && typeof srRaw.then === "function" ? await srRaw : srRaw;
    const semRank = rankOf(sr.results, p.target);
    lexRanks.push(lexRank); semRanks.push(semRank);
    process.stdout.write(`${lexRank ? "#" + lexRank : "—"}\t${semRank ? "#" + semRank : "—"}\t${JSON.stringify(p.query)} → ${p.target}\n`);
  }
  process.stdout.write(`\n${pairs.length} pairs\n`);
  process.stdout.write(`lexical    : MRR ${mrr(lexRanks).toFixed(3)}, in-results ${inResults(lexRanks)}/${lexRanks.length}\n`);
  process.stdout.write(`${o.searchType.padEnd(11)}: MRR ${mrr(semRanks).toFixed(3)}, in-results ${inResults(semRanks)}/${semRanks.length}\n`);

  semantic.stop();
  store.stop();
  return 0;
}

main().then((code) => { process.exitCode = code || 0; }, (e) => { process.stderr.write(String((e && e.stack) || e) + "\n"); process.exitCode = 1; });
