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
 *
 * 0.5.5 bug fixes (first real-KB run — one scan burned ≈60 AI calls although maxActionsPerScan
 * was 3):
 *   - `maxActionsPerScan` only ever capped APPLIED merges — with autoMerge off (the default) it
 *     never fires at all, so EVERY candidate pair got an AI call. `maxChecksPerScan` (default 5)
 *     now caps the AI CALLS themselves, independently of how many (if any) turn into a merge.
 *   - The cheap pre-filter is tighter: it used to reuse lib/levers/duplicate-hint.js's own
 *     (deliberately loose, tuned for a DIFFERENT purpose — a single advisory hint on
 *     `write_note`) thresholds and sent clearly-unrelated pairs (e.g. a feedback note against an
 *     unrelated project-strategy note) to the AI. This module now computes its own overlap
 *     directly off noteWords() (still reused, never reimplemented) with a stricter MIN_SHARED/
 *     MIN_COVERAGE than the proxy lever's.
 *   - A pair where one note is `part_of` the other (parent/child — a hub and its own part, never
 *     "duplicates" of each other) is excluded outright, before any AI call.
 *   - Every verdict (duplicate or not) is now cached by the PAIR's content hash (both notes'
 *     sha1, lib/verdict-cache.js) — a periodic scan never re-asks about two notes whose content
 *     has not changed since, across restarts too.
 *
 * 0.5.5 bug fix (third real-KB run — the pre-filter still paired project-memglow-v04-strategy
 * with feedback-* and reference-ha-* notes, sharing only generic words like "memglow", "project",
 * dates and bare numbers):
 *   - `findDuplicatePairs()` now also requires the SAME declared `theme` when BOTH notes set one
 *     (same "declared beats inferred, never guess across an explicit boundary" spirit as
 *     lib/star-audit.js's own hub-attach guard) — a different, both-declared theme rules a pair
 *     out before the word overlap is even computed.
 *   - The word overlap itself ignores a small GENERIC_WORDS list ("memglow", "project", "note",
 *     …) and any token that is a bare number or a YYYY-MM-DD-shaped date — words so common
 *     across unrelated notes that they were driving false matches on their own.
 *
 * 0.5.6 bug fix (fourth real-KB run — still pairing unrelated notes that merely share the same
 * BROAD theme, e.g. project-memglow-v04-strategy with feedback-autonomy-* and
 * project-r0zumnik-hub-bento-shares-secrets: same `theme: project` on everything, the word overlap
 * above tuned to catch exactly this kind of coincidence, not a real duplicate):
 *   - `findDuplicatePairs()` now ALSO requires, on top of every check above: the SAME declared
 *     `subtheme`/`sous_theme` when BOTH notes set one, OR a title-word overlap of >= 2 significant
 *     words (significantWordsOf() of the LABEL/title alone, the one part of a note a human
 *     actually chose to name it — never the id or description, both noisier). Either is enough;
 *     neither (different sub-themes AND an unrelated title) rules the pair out before any AI call.
 *   - A note whose id starts with `feedback-` is NEVER paired with one starting with `project-`
 *     (or vice versa) — two different KINds of note by construction (an opinion/decision log vs a
 *     project's own working note), whatever words they happen to share.
 */
const engine = require("./split-engine");
const { maskSecrets } = require("./memory");
const aiProvider = require("./ai-provider");
const { createEventLog } = require("./event-log");
const { createVerdictCache } = require("./verdict-cache");
const autoSplit = require("./auto-split"); // shared scope helpers only — never its worker
const { noteWords } = require("./levers/duplicate-hint");
const { significantWords } = require("./learned-aliases");

const DEFAULTS = { enabled: false, autoMerge: false, idleMinutes: 30, scanHours: 24, maxChecksPerScan: 5, maxActionsPerScan: 10, timeoutMs: 180000, maxReported: 50 };
const MAX_NOTES_CHECKED = 300; // cheap-detection pass, same cap spirit as lib/archive.js's own
// 0.5.5: stricter than lib/levers/duplicate-hint.js's own DUPLICATE_HINT_MIN_SHARED/COVERAGE (2,
// 0.6) — those are tuned for a single write_note advisory hint, not for feeding an AI call;
// tighter here measurably cut unrelated pairs in a real-KB run (module doc above).
const MIN_SHARED = 3;
const MIN_COVERAGE = 0.7;
// 0.5.5 bug fix: words common enough across UNRELATED notes (memglow's own name, generic
// note-taking vocabulary) to drive a false match on their own — dropped from the overlap before
// MIN_SHARED/MIN_COVERAGE are checked. Not a linguistic resource, just the words seen doing this.
const GENERIC_WORDS = new Set([
  "memglow", "project", "projects", "note", "notes", "update", "updates", "log", "logs",
  "entry", "entries", "date", "dated", "day", "days", "week", "weeks", "month", "months",
  "year", "years", "today", "status", "summary", "overview", "general", "misc", "draft",
]);
const DATE_WORD_RE = /^\d{4}(-\d{2}(-\d{2})?)?$|^\d+$/; // a bare number, or a YYYY / YYYY-MM / YYYY-MM-DD token

/** `noteWords(n)` (lib/levers/duplicate-hint.js) with GENERIC_WORDS and any bare-number/date
 * token removed — see the module's own 0.5.5 doc above. */
function significantWordsOf(n) {
  return noteWords(n).filter((w) => !GENERIC_WORDS.has(w) && !DATE_WORD_RE.test(w));
}

/** 0.5.6: the note's own LABEL/title alone (never id/description, both noisier) — same
 * GENERIC_WORDS/date filtering as significantWordsOf() above. */
function titleWordsOf(n) {
  return significantWords(String((n && n.label) || "")).filter((w) => !GENERIC_WORDS.has(w) && !DATE_WORD_RE.test(w));
}

/** 0.5.6: the slug's own leading `word-` segment, lowercased — "feedback-autonomy-x" -> "feedback",
 * "project-memglow-v04-strategy" -> "project". Null when the id carries no "-". */
function familyOf(id) {
  const m = /^([a-z0-9]+)-/.exec(String(id || "").toLowerCase());
  return m ? m[1] : null;
}

// 0.5.6: two different KINDs of note by construction — never paired, whatever words they share.
const NEVER_PAIRED_FAMILIES = [["feedback", "project"]];

function neverPaired(idA, idB) {
  const fa = familyOf(idA), fb = familyOf(idB);
  return NEVER_PAIRED_FAMILIES.some(([x, y]) => (fa === x && fb === y) || (fa === y && fb === x));
}

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
    maxChecksPerScan: int(a.maxChecksPerScan, DEFAULTS.maxChecksPerScan, 1, 1000),
    maxActionsPerScan: int(a.maxActionsPerScan, DEFAULTS.maxActionsPerScan, 1, 1000),
    timeoutMs: int(env.MEMGLOW_AI_TIMEOUT_MS || a.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    excludeFolders: autoSplit.sanitizeExcludeFolders(excludeFoldersRaw, a.archiveFolder),
    includeFolders: autoSplit.sanitizeIncludeFolders(includeFoldersRaw),
    ...aiProvider.providerFieldsFrom(a, env),
  };
}

/**
 * Cheap candidate PAIRS among `notes` ([{id,label,description,theme?,tokens}]) — reuses
 * lib/levers/duplicate-hint.js's own noteWords() (the id+label+description significant-word
 * extractor), filtered through significantWordsOf() above (GENERIC_WORDS, bare numbers/dates
 * dropped), and computes its OWN, stricter overlap directly: >= MIN_SHARED significant words in
 * common AND covering >= MIN_COVERAGE of the SHORTER side's own word count (0.5.5: tighter than
 * the proxy lever's own thresholds — module doc above). 0.5.5 bug fix: a pair whose two notes
 * BOTH declare a `theme` and it differs is excluded outright, before the word overlap is even
 * computed — same "declared beats inferred, never guess across an explicit boundary" spirit as
 * lib/star-audit.js's hub-attach guard. Deduped (a,b) == (b,a), ranked by shared-word count then
 * combined size, capped to MAX_NOTES_CHECKED notes checked (biggest first — same bias as
 * lib/archive.js's own detection cap). 0.5.6: ALSO requires — on top of every check above — the
 * SAME declared `subtheme` when BOTH notes set one, OR a title-word overlap of >= 2 significant
 * words (module doc above); and NEVER pairs a `feedback-*` id with a `project-*` one. Pure.
 */
function findDuplicatePairs(notes) {
  const pool = (notes || []).filter((n) => n && n.id).sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, MAX_NOTES_CHECKED);
  const wordsOf = new Map(pool.map((n) => [n.id, new Set(significantWordsOf(n))]));
  const titleWordsOfMap = new Map(pool.map((n) => [n.id, new Set(titleWordsOf(n))]));
  const themeOf = new Map(pool.map((n) => [n.id, n.theme || null]));
  const subthemeOf = new Map(pool.map((n) => [n.id, n.subtheme || null]));
  const pairs = [];
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i], wa = wordsOf.get(a.id);
    if (wa.size < MIN_SHARED) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j], wb = wordsOf.get(b.id);
      if (wb.size < MIN_SHARED) continue;
      if (neverPaired(a.id, b.id)) continue; // 0.5.6: a feedback/* note is never paired with a project/* one
      const ta = themeOf.get(a.id), tb = themeOf.get(b.id);
      if (ta && tb && ta !== tb) continue; // 0.5.5 bug fix: different declared themes, never a pair
      let shared = 0;
      for (const w of wa) if (wb.has(w)) shared++;
      if (shared < MIN_SHARED) continue;
      const coverage = shared / Math.min(wa.size, wb.size);
      if (coverage < MIN_COVERAGE) continue;
      // 0.5.6 bug fix: same broad theme is not enough on its own (module doc above) — also
      // require the same declared subtheme (when both set it) OR a real title-word overlap.
      const sa = subthemeOf.get(a.id), sb = subthemeOf.get(b.id);
      const sameSubtheme = !!sa && !!sb && sa === sb;
      if (!sameSubtheme) {
        const ta2 = titleWordsOfMap.get(a.id), tb2 = titleWordsOfMap.get(b.id);
        let titleOverlap = 0;
        for (const w of ta2) if (tb2.has(w)) titleOverlap++;
        if (titleOverlap < 2) continue;
      }
      pairs.push({ a: a.id, b: b.id, shared, tokens: (a.tokens || 0) + (b.tokens || 0) });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared || y.tokens - x.tokens || (x.a + x.b < y.a + y.b ? -1 : 1));
  return pairs;
}

/**
 * 0.5.5 bug fix: `a`/`b` are real STORE note records here (title/slug/base/description/raw — see
 * scanOnce() below), never the slim {id,label,...} shape the pure unit tests use — `a.label`/
 * `a.id` were always undefined in production, so the AI was literally shown
 * `Note A: "undefined" (id: undefined)` for every real pair. `idOf()`/`labelOf()` below accept
 * either shape (id/label win when present, for the pure tests), so this never regresses either.
 */
function idOf(n) { return (n && (n.id || n.slug || n.base)) || ""; }
function labelOf(n) { return (n && (n.label || n.title)) || idOf(n); }

function buildPrompt(a, b) {
  const firstLines = (raw) => String(maskSecrets(raw || "")).split(/\r?\n/).filter((l) => l.trim()).slice(0, 15).join("\n");
  return [
    `Note A: "${labelOf(a)}" (id: ${idOf(a)})`, a.description ? `A description: ${a.description}` : "",
    "A first lines:", firstLines(a.raw) || "(empty)", "",
    `Note B: "${labelOf(b)}" (id: ${idOf(b)})`, b.description ? `B description: ${b.description}` : "",
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
  // 0.5.5: every verdict (duplicate or not) cached by the PAIR's own content hash (both notes'
  // sha1, order-independent) — never re-asked about two notes whose content has not changed,
  // surviving a restart (module doc above).
  const verdictCache = createVerdictCache({ dataDir, file: "auto-duplicates-cache.json", now });
  let lastScanAt = null, lastError = null;
  let reported = []; // [{a,b,duplicate,keep,reason,merged,t}], newest first, bounded

  function status() {
    let keySet = false;
    try { keySet = aiProvider.describe(cfg, { dataDir, env }).key === "set"; } catch { keySet = false; }
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return { enabled: !!cfg.enabled, autoMerge: !!cfg.autoMerge, provider: cfg.provider, model: cfg.model, keySet, lastScanAt, nextScanAt, reported: reported.slice(0, DEFAULTS.maxReported), lastError: lastError ? { t: lastError.t, message: lastError.message } : null };
  }
  if (!cfg.enabled || !store) return { start() {}, stop() {}, scanOnce: async () => [], recentEvents: () => [], status, inert: true };

  function logEvent(kind, note, detail) { events.add({ t: now(), kind, note, detail }); log(`memglow auto-duplicates: ${kind}${note ? " " + note : ""}${detail ? " — " + detail.slice(0, 200) : ""}`); }

  // 0.5.6 bug fix: the age must never go negative (a freshly written file's mtime can land a
  // fraction of a ms AFTER now() on a fast runner), and idleMinutes <= 0 means "always idle"
  // outright, never a real-valued comparison against a possibly-negative age.
  function isIdle(n) {
    if (cfg.idleMinutes <= 0) return true;
    return Math.max(0, now() - (n.mtimeMs || 0)) >= cfg.idleMinutes * 60000;
  }
  function liveNotes() {
    const includeFolders = autoSplit.effectiveIncludeFolders(cfg, store, indexNote);
    return store.notes().filter((n) => n && n.type !== "index" && autoSplit.underIncluded(n.rel, includeFolders) && !autoSplit.underExcluded(n.rel, cfg.excludeFolders) && isIdle(n));
  }

  async function scanOnce() {
    lastScanAt = now();
    if (!cfg.provider) { logEvent("inert", null, "no AI provider configured"); return []; }
    if (lastError) return [];
    const d = aiRun ? { available: true } : aiProvider.detect(cfg, { dataDir, env });
    if (!d.available) { logEvent("inert", null, d.reason || "no AI provider available"); return []; }
    const notes = liveNotes();
    const byId = new Map(notes.map((n) => [n.slug || n.base, n]));
    const slim = notes.map((n) => ({
      id: n.slug || n.base, label: n.title, description: n.description,
      theme: n.frontmatter && typeof n.frontmatter.theme === "string" ? n.frontmatter.theme.trim() : null,
      // 0.5.6: `subtheme` (or its French alias `sous_theme`) — n.frontmatter keeps whichever key
      // the note's own frontmatter used verbatim (lib/store/frontmatter.js's YAML reader never
      // normalizes it), so both are checked here, same as lib/auto-archive.js's own grouping.
      subtheme: n.frontmatter && typeof n.frontmatter.subtheme === "string" && n.frontmatter.subtheme.trim() ? n.frontmatter.subtheme.trim()
        : n.frontmatter && typeof n.frontmatter.sous_theme === "string" && n.frontmatter.sous_theme.trim() ? n.frontmatter.sous_theme.trim() : null,
      tokens: n.size ? engine.estimateTokens(n.size) : 0,
    }));
    // 0.5.5 bug fix: a pair where one note is `part_of` the other (parent/child — a hub and its
    // own part, already structurally linked) is never a "duplicate" pair at all — excluded
    // before any AI call, not merely before a merge.
    const pairs = findDuplicatePairs(slim).filter((p) => {
      const a = byId.get(p.a), b = byId.get(p.b);
      if (!a || !b) return false;
      const ha = hubOf(a), hb = hubOf(b);
      return !((ha && ha === p.b) || (hb && hb === p.a));
    });
    const applied = [];
    let checks = 0; // 0.5.5 bug fix: caps AI CALLS themselves — maxActionsPerScan below still
    // caps applied MERGES separately (it used to be the only cap, and never fired at all with
    // autoMerge off, the default — see module doc).
    let cacheHits = 0; // 0.5.5 bug fix: a cached verdict is never logged as its own event (looked
    // like a fresh AI call) — counted here instead, for the one optional summary line below.
    for (const p of pairs) {
      if (checks >= cfg.maxChecksPerScan) break;
      const a = byId.get(p.a), b = byId.get(p.b);
      const cacheKey = verdictCache.key(...[verdictCache.sha1(a.raw), verdictCache.sha1(b.raw)].sort());
      let decision = verdictCache.get(cacheKey);
      const fromCache = !!decision;
      if (!decision) {
        checks++;
        const prompt = buildPrompt(a, b);
        let ai;
        try { ai = await runAi(prompt); } catch (e) { ai = { ok: false, error: e.message }; }
        if (!ai || !ai.ok) {
          const errMsg = (ai && ai.error) || "the AI provider failed";
          if (aiProvider.isAuthError(errMsg)) { lastError = { t: now(), message: errMsg.slice(0, 300) }; logEvent("auth-error", null, errMsg); break; }
          logEvent("ask-failed", `${p.a} / ${p.b}`, errMsg);
          continue;
        }
        try { decision = parseDecision(ai.text); } catch (e) { logEvent("ask-failed", `${p.a} / ${p.b}`, e.message); continue; }
        verdictCache.set(cacheKey, decision);
      } else {
        cacheHits++;
      }
      const entry = { a: p.a, b: p.b, duplicate: decision.duplicate, keep: decision.keep, reason: decision.reason || "", merged: false, t: now() };
      // 0.5.5 bug fix: a cache HIT is silent — `reported` still reflects the current scan (the
      // panel/API stays accurate), but no event/log line is added for a verdict that is not new.
      if (!decision.duplicate) { reported = [entry, ...reported].slice(0, DEFAULTS.maxReported); if (!fromCache) logEvent("not-duplicate", `${p.a} / ${p.b}`, decision.reason); continue; }
      if (applied.length >= cfg.maxActionsPerScan) { reported = [entry, ...reported].slice(0, DEFAULTS.maxReported); continue; }
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
      if (!merged && !fromCache) logEvent("duplicate", `${p.a} / ${p.b}`, decision.reason);
    }
    // 0.5.5 bug fix: one optional summary line per scan — never one line per cache hit.
    if (cacheHits > 0) logEvent("cache-reused", null, `${cacheHits} cached verdict${cacheHits === 1 ? "" : "s"} reused`);
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
  function stop() { if (timer) clearIntervalFn(timer); timer = null; events.flush(); verdictCache.flush(); }
  return { start, stop, scanOnce, recentEvents: (since) => events.events(since), status, inert: false };
}

module.exports = {
  duplicatesSettings, findDuplicatePairs, significantWordsOf, titleWordsOf, familyOf, neverPaired, GENERIC_WORDS,
  buildPrompt, parseDecision, hubOf, checkMergeZeroLoss, buildMergeTexts, createDuplicatesWorker, DEFAULTS, SYSTEM,
};
