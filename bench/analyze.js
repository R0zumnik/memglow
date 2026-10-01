#!/usr/bin/env node
"use strict";
/**
 * memglow bench — analysis. Reads the JSON lines written by bench/run.js and prints Markdown tables.
 *
 *   node bench/analyze.js bench/results/haiku.jsonl [more.jsonl…] [--tag main] [--model haiku]
 *
 * Per variant: mean, median and standard deviation of each measure; the difference against A
 * (direct, no memglow) as a ratio of means, with a 95 % bootstrap interval that resamples QUESTIONS
 * (paired: every variant answered the same questions), so a difference whose interval contains 0 is
 * reported as not significant; accuracy per variant and per kind of question.
 */
const fs = require("fs");
const { mulberry32 } = require("./generate");

const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));
const opt = (k) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : null; };
let rows = files.flatMap((f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
if (opt("tag")) rows = rows.filter((r) => r.tag === opt("tag"));
if (opt("model")) rows = rows.filter((r) => r.model === opt("model"));
const ok = rows.filter((r) => r.exit === 0 && r.subtype === "success");

const METRICS = [
  ["toolCalls", "memory tool calls", (r) => r.toolCalls],
  ["inTok", "input tokens (all, incl. cache)", (r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate],
  ["outTok", "output tokens", (r) => r.tokens.output],
  ["resTok", "tool results ≈ tokens (chars ÷ 4)", (r) => r.toolResultChars / 4],
  ["dur", "total time (s)", (r) => r.durationMs / 1000],
  ["eng", "engine time, sum per run (ms)", (r) => (r.variant === "A" ? null : r.engine.totalMs)],
  ["cost", "cost ($)", (r) => r.costUsd],
];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const fmt = (x, d = 1) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(d)) : "—");
const pct = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + " %" : "—");

const variants = [...new Set(ok.map((r) => r.variant))].sort();
const questions = [...new Set(ok.map((r) => r.id))].sort();
const by = (v) => ok.filter((r) => r.variant === v);
/** per-question mean of a metric for a variant */
function perQ(v, f) {
  const m = new Map();
  for (const q of questions) { const xs = by(v).filter((r) => r.id === q).map(f).filter((x) => x != null); if (xs.length) m.set(q, mean(xs)); }
  return m;
}
/** ratio of means vs base over the questions both have, with a paired bootstrap 95 % interval */
function relDiff(v, base, f) {
  const a = perQ(v, f), b = perQ(base, f);
  const qs = questions.filter((q) => a.has(q) && b.has(q));
  if (!qs.length) return null;
  const ratio = (list) => { const sb = list.reduce((s, q) => s + b.get(q), 0); return sb ? list.reduce((s, q) => s + a.get(q), 0) / sb - 1 : NaN; };
  const point = ratio(qs);
  const rnd = mulberry32(7), boots = [];
  for (let i = 0; i < 2000; i++) boots.push(ratio(qs.map(() => qs[Math.floor(rnd() * qs.length)])));
  boots.sort((x, y) => x - y);
  return { point, lo: boots[50], hi: boots[1949], n: qs.length };
}

const out = [];
const models = [...new Set(ok.map((r) => r.model))];
out.push(`Runs: ${rows.length} (${ok.length} completed successfully${rows.length - ok.length ? `, ${rows.length - ok.length} excluded: ${[...new Set(rows.filter((r) => !ok.includes(r)).map((r) => r.subtype + "/exit " + r.exit))].join(", ")}` : ""}), model(s): ${models.join(", ")}, questions: ${questions.length}, total cost ${fmt(rows.reduce((s, r) => s + (r.costUsd || 0), 0), 2)} $.`);
out.push("");
out.push("### Accuracy");
out.push("");
const kinds = [...new Set(ok.map((r) => r.kind))];
out.push(`| Variant | Correct | ${kinds.join(" | ")} |`);
out.push(`|---|---|${kinds.map(() => "---").join("|")}|`);
for (const v of variants) {
  const rs = by(v);
  const c = rs.filter((r) => r.correct).length;
  out.push(`| ${v} | ${c}/${rs.length} (${fmt((100 * c) / rs.length, 0)} %) | ${kinds.map((k) => { const x = rs.filter((r) => r.kind === k); return `${x.filter((r) => r.correct).length}/${x.length}`; }).join(" | ")} |`);
}
out.push("");
out.push("### Measures per run (mean · median · standard deviation), and differences of means");
out.push("");
out.push("Differences: ratio of the per-question means against A (direct) and against B (proxy, levers off — the proper control for a lever, same path), with a 95 % bootstrap interval over questions in brackets; **bold** when the interval excludes 0. Engine time is measured by the proxy only (none for A).");
out.push("");
for (const [key, label, f] of METRICS) {
  out.push(`**${label}**`);
  out.push("");
  const bases = ["A", "B"].filter((b) => variants.includes(b));
  out.push("| Variant | mean | median | sd | " + bases.map((b) => "vs " + b).join(" | ") + " |");
  out.push("|---|---|---|---|" + bases.map(() => "---").join("|") + "|");
  for (const v of variants) {
    const xs = by(v).map(f).filter((x) => x != null);
    if (!xs.length) { out.push(`| ${v} | — | — | — | ${bases.map(() => "—").join(" | ")} |`); continue; }
    const diffs = bases.map((base) => {
      if (v === base || (key === "eng" && base === "A")) return "";
      const r = relDiff(v, base, f);
      if (!r) return "";
      const sig = r.lo > 0 || r.hi < 0; const t = `${pct(r.point)} [${pct(r.lo)}, ${pct(r.hi)}]`;
      return sig ? `**${t}**` : t;
    });
    const dg = key === "cost" ? 4 : key === "toolCalls" ? 2 : 1;
    out.push(`| ${v} | ${fmt(mean(xs), dg)} | ${fmt(median(xs), dg)} | ${fmt(sd(xs), dg)} | ${diffs.join(" | ")} |`);
  }
  out.push("");
}
out.push("### Tool calls by tool (total over all runs)");
out.push("");
const tools = [...new Set(ok.flatMap((r) => Object.keys(r.tools || {})))].sort();
out.push(`| Variant | ${tools.join(" | ")} |`);
out.push(`|---|${tools.map(() => "---").join("|")}|`);
for (const v of variants) out.push(`| ${v} | ${tools.map((t) => by(v).reduce((s, r) => s + ((r.tools || {})[t] || 0), 0)).join(" | ")} |`);
out.push("");
out.push("### Large-note questions only (where dedupe/toc can act)");
out.push("");
out.push("| Variant | correct | tool results ≈ tokens (mean) | input tokens (mean) | calls (mean) | time s (mean) |");
out.push("|---|---|---|---|---|---|");
for (const v of variants) {
  const rs = by(v).filter((r) => r.kind === "large" || r.kind === "link");
  if (!rs.length) continue;
  out.push(`| ${v} | ${rs.filter((r) => r.correct).length}/${rs.length} | ${fmt(mean(rs.map((r) => r.toolResultChars / 4)), 0)} | ${fmt(mean(rs.map((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreate)), 0)} | ${fmt(mean(rs.map((r) => r.toolCalls)), 2)} | ${fmt(mean(rs.map((r) => r.durationMs / 1000)), 1)} |`);
}
out.push("");
const eng = {};
for (const r of ok) for (const [t, xs] of Object.entries(r.engine.byType || {})) (eng[t] = eng[t] || []).push(...xs);
if (Object.keys(eng).length) {
  out.push("### Memory engine response time per call (all proxy variants, ms)");
  out.push("");
  out.push("| Type | calls | p50 | p95 | max |");
  out.push("|---|---|---|---|---|");
  const pctl = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length, Math.max(1, Math.ceil((p / 100) * b.length))) - 1]; };
  for (const [t, xs] of Object.entries(eng)) out.push(`| ${t} | ${xs.length} | ${pctl(xs, 50)} | ${pctl(xs, 95)} | ${Math.max(...xs)} |`);
  out.push("");
}
const wrong = ok.filter((r) => !r.correct);
if (wrong.length) {
  out.push("### Wrong answers (for manual review)");
  out.push("");
  for (const r of wrong) out.push(`- ${r.id} (${r.kind}) ${r.variant}#${r.rep}: ${r.answer.replace(/\s+/g, " ").slice(0, 220)}`);
  out.push("");
}
console.log(out.join("\n"));
