#!/usr/bin/env node
"use strict";
/**
 * memglow bench — tokenizer accuracy check (stage 0.4.1 of the v0.5 engine roadmap).
 *
 * Compares memglow's token ESTIMATE (`ceil(bytes / 4)`, `estimateTokens` in lib/cost.js) against
 * the REAL token counts Claude Code reports, using what bench/run.js already recorded in
 * bench/results/*.jsonl. No new dependency, no network call, no `claude` call.
 *
 *   node bench/tokenizer-check.js [file.jsonl ...]     # defaults to every bench/results/*.jsonl
 *
 * HONEST LIMIT — read this before trusting a number below. The recorded runs keep only
 * SESSION-TOTAL figures: Claude Code's `result.usage` is the sum over every turn of the whole
 * `claude -p` call, not the usage of one API call, and `toolResultChars` is the sum of every tool
 * result's character count over the whole run, not the size of one note. Neither pairs ONE note's
 * byte size with the token delta it alone caused — that would need the per-turn `usage` of each
 * individual API call (present in the raw stream-json transcript: every `assistant` message
 * carries its own `usage`) kept alongside the exact tool-result text that turn received as input.
 * bench/run.js only keeps that with `--keep-streams <dir>`, and no run behind today's
 * bench/results/*.jsonl was produced with that flag — the raw transcripts were never saved.
 * Re-running the whole benchmark with `--keep-streams` only to get this would spend real money on
 * a measurement task, which is out of scope here (this repo never makes a paid call to answer a
 * question whose answer is "re-run the benchmark differently").
 *
 * What this script reports instead, clearly as an UPPER BOUND, not a per-note accuracy figure:
 * for each usable run, `estimate = estimateTokens(toolResultChars)` (what the bytes/4 formula
 * would guess for ALL the tool-result text of that run — itself a second approximation:
 * `toolResultChars` is a `String.length` sum, i.e. UTF-16 code units, not UTF-8 bytes; that is what
 * bench/run.js actually recorded, not what we would ideally want) against `actual = ` the run's
 * total real input tokens (`input + cache_creation + cache_read`, which also contains the system
 * prompt, the ~12 MCP tool schemas, the user prompt, and — because each turn resends the growing
 * conversation — every PRIOR turn's text and tool results again, repeated through prompt caching).
 * `estimate` is therefore always a fraction of `actual`: the ratio measures mostly how big that
 * fixed-ish overhead is for a given run shape, not whether bytes/4 is a good tokenizer. Grouped two
 * ways: by question `kind` (small/large/link/none, a category from bench/questions.json) and by the
 * REAL size of the note holding the answer (regenerated locally and deterministically with
 * bench/generate.js's default seed — no network, no model call — a finer bucket than `kind`).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { estimateTokens } = require("../lib/cost");

const RESULTS_DIR = path.join(__dirname, "results");
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8")).questions;
const SIZE_BUCKETS = [
  { label: "< 200 tokens", max: 200 },
  { label: "200 – 1,000 tokens", max: 1000 },
  { label: "1,000 – 5,000 tokens", max: 5000 },
  { label: "> 5,000 tokens", max: Infinity },
];

const CAVEAT = `Honest limit: these are SESSION-TOTAL figures (summed over every turn of a claude -p call),
never the token delta ONE tool result alone caused. Treat every ratio below as an upper bound on
how big the fixed overhead (system prompt, tool schemas, resent history) is for a run shape — not
as a measurement of whether bytes/4 is a good tokenizer for one note. See the header of this file
and bench/RESULTS.md's "Tokenizer accuracy" section for what is actually missing to do better, and
why it is not re-measured here (it would need a paid --keep-streams re-run of the benchmark).`;

/** Every *.jsonl in bench/results/, or [] if the folder does not exist. */
function defaultFiles() {
  try { return fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(RESULTS_DIR, f)); } catch { return []; }
}

/** Usable records (exit 0, a completed answer, both fields this script needs) across every file. */
function loadRecords(files) {
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.exit === 0 && rec.subtype === "success" && rec.tokens && typeof rec.toolResultChars === "number") out.push(rec);
    }
  }
  return out;
}

/** Real total input tokens billed for the whole run (session-total, see the caveat above). */
function actualInputTokens(rec) {
  const t = rec.tokens || {};
  return (t.input || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0);
}

function mean(xs) {
  const ys = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

/** One summary row (n, mean estimate/actual/ratio/gap) for a bucket of records. */
function summarize(label, recs) {
  const estimates = recs.map((r) => estimateTokens(r.toolResultChars));
  const actuals = recs.map(actualInputTokens);
  const ratios = estimates.map((e, i) => (actuals[i] > 0 ? e / actuals[i] : null));
  const gaps = estimates.map((e, i) => actuals[i] - e);
  return { label, n: recs.length, meanEstimate: mean(estimates), meanActual: mean(actuals), meanRatio: mean(ratios), meanGap: mean(gaps) };
}

function pushTo(map, key, val) {
  const g = map.get(key);
  if (g) g.push(val);
  else map.set(key, [val]);
}

/** Grouped by question `kind` (bench/questions.json: small/large/link/none). */
function byKind(records) {
  const groups = new Map();
  for (const rec of records) pushTo(groups, rec.kind, rec);
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([kind, recs]) => summarize(kind, recs));
}

/** Which size bucket a token count falls into (SIZE_BUCKETS, ascending, last one is "the rest"). */
function bucketOf(tokens) {
  const b = SIZE_BUCKETS.find((x) => tokens <= x.max);
  return (b || SIZE_BUCKETS[SIZE_BUCKETS.length - 1]).label;
}

/** Grouped by the REAL size (tokens) of the note holding each question's answer — `sizes`: Map<questionId, tokens>. */
function byNoteSize(records, sizes) {
  const groups = new Map();
  for (const rec of records) {
    const size = sizes.get(rec.id);
    if (size == null) continue; // "none" questions (no holder note), or an id unknown to `sizes`
    pushTo(groups, bucketOf(size), rec);
  }
  return SIZE_BUCKETS.map((b) => b.label).filter((label) => groups.has(label)).map((label) => summarize(label, groups.get(label)));
}

/** basename(file, ".md") === id, walked from `dir`; null if not found. */
function findNote(dir, id) {
  for (const f of walkMd(dir)) if (path.basename(f, ".md") === id) return f;
  return null;
}
function* walkMd(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

/**
 * Real size (tokens) of the note holding each question's answer: Map<questionId, tokens>.
 * Regenerates the deterministic test memory locally (bench/generate.js's default seed — same seed,
 * byte-identical files every time — no network, no model call) into a throw-away folder, measures
 * each holder note's file size, then deletes the folder.
 */
function noteSizes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-tokenizer-check-"));
  try {
    execFileSync(process.execPath, [path.join(__dirname, "generate.js"), dir], { stdio: ["ignore", "ignore", "inherit"] });
    const sizes = new Map();
    for (const q of QUESTIONS) {
      const holder = q.notes[q.notes.length - 1];
      if (!holder) continue;
      const file = findNote(dir, holder);
      if (file) sizes.set(q.id, estimateTokens(fs.statSync(file).size));
    }
    return sizes;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fmt(n) { return n == null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(3); }
function printTable(rows) {
  if (!rows.length) { console.log("  (nothing to show)"); return; }
  const header = ["bucket", "n", "mean estimate", "mean actual", "mean ratio", "mean gap (actual − estimate)"];
  const data = rows.map((r) => [r.label, String(r.n), fmt(r.meanEstimate), fmt(r.meanActual), fmt(r.meanRatio), fmt(r.meanGap)]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of data) console.log(line(row));
}

function main() {
  const given = process.argv.slice(2);
  const files = given.length ? given.map((f) => path.resolve(f)) : defaultFiles();
  if (!files.length) { console.error("tokenizer-check: no bench/results/*.jsonl found — run bench/run.js first, or pass file(s) explicitly"); process.exit(1); }
  const records = loadRecords(files);
  if (!records.length) { console.error("tokenizer-check: no usable (exit 0, success) record in the given file(s)"); process.exit(1); }
  console.log(CAVEAT);
  console.log(`\n${records.length} usable run(s) from ${files.length} file(s).\n`);
  console.log("By question kind (a category, not a measurement):");
  printTable(byKind(records));
  console.log("\nBy the holder note's REAL size (regenerated locally, bench/generate.js, no network, no model call):");
  printTable(byNoteSize(records, noteSizes()));
}

if (require.main === module) main();
module.exports = {
  loadRecords, actualInputTokens, summarize, byKind, byNoteSize, bucketOf, noteSizes, defaultFiles, findNote, SIZE_BUCKETS, CAVEAT,
};
