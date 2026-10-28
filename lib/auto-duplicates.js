"use strict";
/**
 * 0.5.5: DUPLICATES — cheap detection of candidate duplicate PAIRS (title/description/term overlap
 * — lib/levers/duplicate-hint.js's own noteWords()/duplicateHintCandidates(), already used by the
 * MCP proxy's `duplicateHint` lever, reused here rather than reimplemented), confirmed by the AI
 * (lib/ai-provider.js, the same provider lib/auto-split.js/lib/star-audit.js/lib/auto-archive.js
 * already use) with a strict {"duplicate":true|false,"keep":"a"|"b","reason":"..."} verdict.
 *
 * Default behaviour: REPORT ONLY — every confirmed-duplicate pair is kept in `status().reported`
 * (bounded, newest first; `/api/maintenance` + the control panel), nothing is ever written.
 * `maintenance.duplicates.autoMerge: true` additionally applies it: the OTHER note's body is
 * appended under a heading "## Merged from [[x]] (date)" into the KEPT note (ADD only), and the
 * other note becomes a 2-line stub — its OWN frontmatter kept byte-for-byte, body replaced with a
 * single "Merged into [[kept]]." line. A hard zero-loss check (every non-empty line of the
 * merged-away note's original body must still appear, same count, in the kept note's new body)
 * refuses the merge otherwise, same invariant as every other automatic action in this codebase.
 *
 * Auto-merge NEVER crosses hubs: both notes must declare the SAME frontmatter `part_of` (and
 * neither may be hub-less) — two notes with no declared hub, or with different ones, are only
 * ever reported, never merged automatically (picking which "side" is right needs a human, not a
 * coin flip — same spirit as lib/star-audit.js's own R3 "claimed by >1 hub" rule).
 *
 * OFF by default (`maintenance.duplicates.enabled` / env MEMGLOW_AUTO_DUPLICATES); `autoMerge` is
 * its own, separate flag (`maintenance.duplicates.autoMerge` / env MEMGLOW_AUTO_DUPLICATES_MERGE),
 * off by default even when detection itself is on. Same scope (includeFolders/excludeFolders),
 * idle-from-mtime, event-log, status(), auth-error-stop conventions as lib/auto-split.js — its
 * pure scope helpers are reused directly.
 */
const engine = require("./split-engine");
const { maskSecrets } = require("./memory");
const aiProvider = require("./ai-provider");
const { createEventLog } = require("./event-log");
const autoSplit = require("./auto-split"); // shared scope helpers only — never its worker
const { noteWords, duplicateHintCandidates } = require("./levers/duplicate-hint");

const DEFAULTS = { enabled: false, autoMerge: false, idleMinutes: 30, scanHours: 24, maxActionsPerScan: 10, timeoutMs: 180000, maxReported: 50 };
const MAX_NOTES_CHECKED = 300; // cheap-detection pass, same cap spirit as lib/archive.js's own

const SYSTEM = [
  "You decide whether TWO notes of an AI assistant's Markdown memory are true duplicates of each other (the same subject, substantially overlapping content) — not merely related or on a similar topic.",
  "Answer with ONE JSON object and nothing else (no prose, no code fence): {\"duplicate\": true|false, \"keep\": \"a\"|\"b\", \"reason\": \"...\"}.",
  "duplicate: true only when they truly duplicate each other (false for merely related/overlapping-topic notes — never guess true to be helpful).",
  "keep: which one should stay the canonical copy when duplicate is true (\"a\" or \"b\") — the more complete/more recently useful one. Required even when duplicate is false (answer your best guess).",
  "reason: one short English sentence, for a log.",
].join("\n");

function int(v, def, min, max) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; }

function duplicatesSettings(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const envOn = String(env.MEMGLOW_AUTO_DUPLICATES || "").toLowerCase();
  const envMergeOn = String(env.MEMGLOW_AUTO_DUPLICATES_MERGE || "").toLowerCase();
  const excludeFoldersRaw = typeof env.MEMGLOW_EXCLUDE_FOLDERS === "string" && env.MEMGLOW_EXCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_EXCLUDE_FOLDERS.split(",") : a.excludeFolders;
  const includeFoldersRaw = typeof env.MEMGLOW_INCLUDE_FOLDERS === "string" && env.MEMGLOW_INCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_INCLUDE_FOLDERS.split(",") : a.includeFolders;
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    autoMerge: envMergeOn === "1" || envMergeOn === "true" ? true : envMergeOn === "0" || envMergeOn === "false" ? false : a.autoMerge === true,
    idleMinutes: int(a.idleMinutes, DEFAULTS.idleMinutes, 0, 1440),
    scanHours: int(a.scanHours, DEFAULTS.scanHours, 0, 168),
    maxActionsPerScan: int(a.maxActionsPerScan, DEFAULTS.maxActionsPerScan, 1, 1000),
    timeoutMs: int(env.MEMGLOW_AI_TIMEOUT_MS || a.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    excludeFolders: autoSplit.sanitizeExcludeFolders(excludeFoldersRaw, a.archiveFolder),
    includeFolders: autoSplit.sanitizeIncludeFolders(includeFoldersRaw),
    ...aiProvider.providerFieldsFrom(a, env),
  };
}

/**
 * Cheap candidate PAIRS among `notes` ([{id,label,description,tokens}]) — reuses
 * lib/levers/duplicate-hint.js's own noteWords()/duplicateHintCandidates() (shares >= 2
 * significant words, covering >= 60% of the shorter side), deduped (a,b) == (b,a), ranked by
 * shared-word count then combined size, capped to MAX_NOTES_CHECKED notes checked (biggest
 * first — same bias as lib/archive.js's own detection cap). Pure.
 */
function findDuplicatePairs(notes) {
  const pool = (notes || []).filter((n) => n && n.id).sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, MAX_NOTES_CHECKED);
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    const n = pool[i];
    const words = noteWords(n);
    if (words.length < 2) continue;
    const rest = pool.filter((_, j) => j !== i);
    for (const otherId of duplicateHintCandidates(words, rest)) {
      const key = [n.id, otherId].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      const other = pool.find((x) => x.id === otherId);
      if (!other) continue;
      const shared = noteWords(n).filter((w) => new Set(noteWords(other)).has(w)).length;
      pairs.push({ a: n.id, b: otherId, shared, tokens: (n.tokens || 0) + (other.tokens || 0) });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared || y.tokens - x.tokens || (x.a + x.b < y.a + y.b ? -1 : 1));
  return pairs;
}

function buildPrompt(a, b) {
  const firstLines = (raw) => String(maskSecrets(raw || "")).split(/\r?\n/).filter((l) => l.trim()).slice(0, 15).join("\n");
  return [
    `Note A: "${a.label || a.id}" (id: ${a.id})`, a.description ? `A description: ${a.description}` : "",
    "A first lines:", firstLines(a.raw) || "(empty)", "",
    `Note B: "${b.label || b.id}" (id: ${b.id})`, b.description ? `B description: ${b.description}` : "",
    "B first lines:", firstLines(b.raw) || "(empty)",
  ].filter((l) => l !== "").join("\n");
}

function parseDecision(text) {
  let s = String(text || "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("the AI's answer is not a JSON object");
  const d = JSON.parse(s.slice(a, b + 1));
  if (!d || typeof d !== "object" || typeof d.duplicate !== "boolean") throw new Error('the answer must have a boolean "duplicate"');
  if (d.keep !== "a" && d.keep !== "b") throw new Error('"keep" must be "a" or "b"');
  return d;
}

/** `part_of`, trimmed, or null — "no declared hub" (never a merge target when either side is this). */
function hubOf(n) { return n && n.frontmatter && typeof n.frontmatter.part_of === "string" && n.frontmatter.part_of.trim() ? n.frontmatter.part_of.trim() : null; }

/** Zero-loss check for a merge: every non-empty (trimEnd) line of `otherBody` must appear, same
 * count, in `keptNewBody` — never trusted from "we only append" alone. */
function checkMergeZeroLoss(otherBody, keptNewBody) {
  const countLines = (text) => { const m = new Map(); for (const l of String(text || "").split("\n")) { const t = l.replace(/\s+$/, ""); if (!t.trim()) continue; m.set(t, (m.get(t) || 0) + 1); } return m; };
  const before = countLines(otherBody);
  const after = countLines(keptNewBody);
  const missing = [];
  for (const [l, c] of before) { const have = after.get(l) || 0; for (let k = have; k < c; k++) missing.push(l); }
  return missing;
}

/** Builds the kept note's new text and the stub's new text — pure, no I/O. Throws on a zero-loss
 * failure (never trusted from "we only append" alone). */
function buildMergeTexts({ kept, other, now }) {
  const { block: kb, head: kh, body: kBody } = engine.splitFM(kept.raw);
  const { body: oBody } = engine.splitFM(other.raw);
  const otherId = other.slug || other.base;
  const heading = `## Merged from [[${otherId}]] (${engine.dateOf(now)})`;
  const newKeptBody = String(kBody || "").replace(/\s+$/, "") + `\n\n${heading}\n\n${String(oBody || "").trim()}\n`;
  const missing = checkMergeZeroLoss(oBody, newKeptBody);
  if (missing.length) throw new engine.SplitError(`zero-loss check failed: ${missing.length} line(s) of "${otherId}" would be lost on merge`);
  const keptHeadOut = kb == null ? "" : (kh.endsWith("\n") ? kh : kh + "\n");
  const keptText = kb == null ? newKeptBody : keptHeadOut + "\n" + newKeptBody;

  // The stub: its OWN frontmatter kept byte-for-byte (module doc) — only the body is replaced.
  const { block: ob, head: oh } = engine.splitFM(other.raw);
  const stubBody = `Merged into [[${kept.slug || kept.base}]].\n`;
  const stubHeadOut = ob == null ? "" : (oh.endsWith("\n") ? oh : oh + "\n");
  const stubText = ob == null ? stubBody : stubHeadOut + "\n" + stubBody;
  return { keptText, stubText };
}

function createDuplicatesWorker({ store, writer, config, dataDir = null, env = process.env, log = () => {}, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, aiRun = null, indexNote = ["MEMORY", "index"] }) {
  const cfg = duplicatesSettings(config, env);
  const events = createEventLog({ dir: dataDir, file: "auto-duplicates-log.json", keepMs: 90 * 86400000, max: 500, now, label: "auto-duplicates", clean: (e) => (e && typeof e.t === "number" && typeof e.kind === "string" ? { t: e.t, kind: e.kind, note: String(e.note || "").slice(0, 200), detail: String(e.detail || "").slice(0, 500) } : null) });
  const runAi = aiRun || ((prompt) => aiProvider.run(cfg, { system: SYSTEM, prompt, timeoutMs: cfg.timeoutMs }, { dataDir, env }));
  let lastScanAt = null, lastError = null;
  let reported = []; // [{a,b,duplicate,keep,reason,merged,t}], newest first, bounded
  const asked = new Set(); // pair keys already asked this process lifetime — never re-asked

  function status() {
    let keySet = false;
    try { keySet = aiProvider.describe(cfg, { dataDir, env }).key === "set"; } catch { keySet = false; }
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return { enabled: !!cfg.enabled, autoMerge: !!cfg.autoMerge, provider: cfg.provider, model: cfg.model, keySet, lastScanAt, nextScanAt, reported: reported.slice(0, DEFAULTS.maxReported), lastError: lastError ? { t: lastError.t, message: lastError.message } : null };
  }
  if (!cfg.enabled || !store) return { start() {}, stop() {}, scanOnce: async () => [], recentEvents: () => [], status, inert: true };

  function logEvent(kind, note, detail) { events.add({ t: now(), kind, note, detail }); log(`memglow auto-duplicates: ${kind}${note ? " " + note : ""}${detail ? " — " + detail.slice(0, 200) : ""}`); }

  function liveNotes() {
    const includeFolders = autoSplit.effectiveIncludeFolders(cfg, store, indexNote);
    return store.notes().filter((n) => n && n.type !== "index" && autoSplit.underIncluded(n.rel, includeFolders) && !autoSplit.underExcluded(n.rel, cfg.excludeFolders) && (now() - (n.mtimeMs || 0)) >= cfg.idleMinutes * 60000);
  }

  async function scanOnce() {
    lastScanAt = now();
    if (!cfg.provider) { logEvent("inert", null, "no AI provider configured"); return []; }
    if (lastError) return [];
    const d = aiRun ? { available: true } : aiProvider.detect(cfg, { dataDir, env });
    if (!d.available) { logEvent("inert", null, d.reason || "no AI provider available"); return []; }
    const notes = liveNotes();
    const byId = new Map(notes.map((n) => [n.slug || n.base, n]));
    const slim = notes.map((n) => ({ id: n.slug || n.base, label: n.title, description: n.description, tokens: n.size ? engine.estimateTokens(n.size) : 0 }));
    const pairs = findDuplicatePairs(slim).filter((p) => !asked.has([p.a, p.b].sort().join("::")));
    const applied = [];
    for (const p of pairs) {
      if (applied.length >= cfg.maxActionsPerScan) break;
      const key = [p.a, p.b].sort().join("::");
      asked.add(key);
      const a = byId.get(p.a), b = byId.get(p.b);
      if (!a || !b) continue;
      const prompt = buildPrompt(a, b);
      let ai;
      try { ai = await runAi(prompt); } catch (e) { ai = { ok: false, error: e.message }; }
      if (!ai || !ai.ok) {
        const errMsg = (ai && ai.error) || "the AI provider failed";
        if (aiProvider.isAuthError(errMsg)) { lastError = { t: now(), message: errMsg.slice(0, 300) }; logEvent("auth-error", null, errMsg); break; }
        logEvent("ask-failed", `${p.a} / ${p.b}`, errMsg);
        continue;
      }
      let decision;
      try { decision = parseDecision(ai.text); } catch (e) { logEvent("ask-failed", `${p.a} / ${p.b}`, e.message); continue; }
      const entry = { a: p.a, b: p.b, duplicate: decision.duplicate, keep: decision.keep, reason: decision.reason || "", merged: false, t: now() };
      if (!decision.duplicate) { reported = [entry, ...reported].slice(0, DEFAULTS.maxReported); logEvent("not-duplicate", `${p.a} / ${p.b}`, decision.reason); continue; }
      const kept = decision.keep === "a" ? a : b, other = decision.keep === "a" ? b : a;
      let merged = false;
      if (cfg.autoMerge && writer) {
        const hk = hubOf(kept), ho = hubOf(other);
        if (hk && ho && hk === ho) {
          try {
            store.refreshNote && store.refreshNote(kept.rel); store.refreshNote && store.refreshNote(other.rel);
            const freshKept = store.resolve(kept.rel), freshOther = store.resolve(other.rel);
            if (freshKept && freshOther) {
              const built = buildMergeTexts({ kept: freshKept, other: freshOther, now: now() });
              const kt = await writer.target(freshKept.rel);
              const kst = await writer.writeAtomic(kt.abs, built.keptText, kt.stat);
              store.noteWritten(kt.rel, built.keptText, kst);
              writer.wrote([kt.rel]);
              const ot = await writer.target(freshOther.rel);
              const ost = await writer.writeAtomic(ot.abs, built.stubText, ot.stat);
              store.noteWritten(ot.rel, built.stubText, ost);
              writer.wrote([ot.rel]);
              merged = true;
              applied.push(`${kept.slug || kept.base} <- ${other.slug || other.base}`);
              logEvent("merged", `${kept.slug || kept.base} <- ${other.slug || other.base}`, decision.reason);
            }
          } catch (e) { logEvent("merge-failed", `${p.a} / ${p.b}`, e.message); }
        } else {
          logEvent("merge-skipped", `${p.a} / ${p.b}`, "different (or no declared) hub — never auto-merged across hubs");
        }
      }
      entry.merged = merged;
      reported = [entry, ...reported].slice(0, DEFAULTS.maxReported);
      if (!merged) logEvent("duplicate", `${p.a} / ${p.b}`, decision.reason);
    }
    return applied;
  }

  let timer = null;
  function start() {
    scanOnce().catch((e) => log(`memglow auto-duplicates: scan failed: ${e.message}`));
    if (cfg.scanHours > 0) {
      const ms = Math.min(cfg.scanHours * 3600000, 2147483647);
      timer = setIntervalFn(() => { scanOnce().catch(() => {}); }, ms);
      if (timer && timer.unref) timer.unref();
    }
  }
  function stop() { if (timer) clearIntervalFn(timer); timer = null; events.flush(); }
  return { start, stop, scanOnce, recentEvents: (since) => events.events(since), status, inert: false };
}

module.exports = {
  duplicatesSettings, findDuplicatePairs, buildPrompt, parseDecision, hubOf,
  checkMergeZeroLoss, buildMergeTexts, createDuplicatesWorker, DEFAULTS, SYSTEM,
};
