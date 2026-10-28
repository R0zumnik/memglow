"use strict";
/**
 * 0.5.5: PRUNE STALE → ARCHIVE — an AI-driven companion to lib/archive.js's own dormancy-based
 * archive tier. lib/archive.js decides WHAT is dormant purely from usage counters (no reads/
 * searches in `afterDays`); this worker instead asks the AI (lib/ai-provider.js — the same
 * provider lib/auto-split.js and lib/star-audit.js already use) to pick, from an in-scope note's
 * own outline, sections that are CLEARLY obsolete regardless of recent reads: a closed incident, a
 * superseded version, a dated log entry older than `keepDays` (default 60). The AI gets the
 * outline with section ids ("[S1]", same convention as lib/auto-split.js's own buildPrompt()) and
 * any date found in each section, and answers which ids (if any) to move — never a rewrite.
 *
 * Chosen sections move, VERBATIM (lib/split-engine.js's moveSections — same hard zero-loss check
 * as every other automatic action in this codebase), into a sibling note "<slug>-archive": same
 * folder, appended to if it already exists, else created with `part_of` = the note's own hub (its
 * `part_of`, if it has one) or the note itself, and an "Up:" line. The source note keeps a single
 * new line, ADD only: "Archived sections: see [[<slug>-archive]]." (never added twice).
 *
 * OFF by default (`maintenance.archive.enabled` / env MEMGLOW_AUTO_ARCHIVE). Same scope/idle/
 * event-log/status/auth-stop conventions as lib/auto-split.js — its own pure scope helpers
 * (sanitizeExcludeFolders, sanitizeIncludeFolders, underExcluded, underIncluded,
 * effectiveIncludeFolders) are reused directly, never reimplemented. Candidates are only
 * considered by the periodic scan (no write-trigger: unlike a size threshold, "is anything
 * obsolete" is not something a single write can newly prove), at most `maxActionsPerScan`
 * archivings applied per scan.
 *
 * 0.5.5 bug fixes (first real-KB run):
 *   - Sections are now selected by INDEX into the outline (same [S#] numbering), not by heading
 *     TEXT — a note with two identically-worded headings used to make moveSections() refuse
 *     outright ("found 2 time(s)"); lib/split-engine.js's new moveSectionsByIndex() has no such
 *     ambiguity (see buildArchiveTexts()).
 *   - `keepDays` is enforced IN CODE, not just asked of the AI: a chosen section whose most
 *     recent date is NEWER than the keepDays cutoff is dropped before anything is built, however
 *     the AI answered.
 *   - `minTokens` (default 400): the chosen sections' own combined size must reach this floor —
 *     never archive a handful of lines into a brand-new note.
 *   - A "left" verdict (the AI found nothing eligible, or code filtering reduced it to nothing)
 *     is now cached by CONTENT HASH (lib/verdict-cache.js, persisted in the data folder) — a
 *     periodic scan of an unchanged note costs no AI call at all past the first one, across
 *     restarts too (the old in-memory, mtime-keyed `asked` map did not survive a restart).
 */
const path = require("path");
const engine = require("./split-engine");
const { maskSecrets } = require("./memory");
const aiProvider = require("./ai-provider");
const { createEventLog } = require("./event-log");
const { createVerdictCache } = require("./verdict-cache");
const autoSplit = require("./auto-split"); // shared scope helpers only — never its worker
const { buildNote } = require("./store/note-edit");
const { generatePermalink } = require("./store/permalink");

const DEFAULTS = { enabled: false, keepDays: 60, minTokens: 400, idleMinutes: 30, scanHours: 24, maxActionsPerScan: 10, timeoutMs: 180000 };

const SYSTEM = [
  "You find sections of one note of an AI assistant's Markdown memory that are CLEARLY obsolete and safe to archive: a closed incident, a superseded version, an old dated log entry past its keep window.",
  "Answer with ONE JSON object and nothing else (no prose, no code fence): {\"sections\": [\"S2\", \"S5\"], \"reason\": \"...\"}.",
  "sections: 0 to 20 ids from the list below (e.g. \"S3\"), naming WHOLE sections that are obsolete and safe to move to an archive note. Never invent an id not listed. An empty list is a valid, safe answer when nothing is clearly obsolete — never guess just to answer something.",
  "reason: one short English sentence, for a log — why these (or none) were picked.",
].join("\n");

function int(v, def, min, max) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; }

function archiveSettings(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const envOn = String(env.MEMGLOW_AUTO_ARCHIVE || "").toLowerCase();
  const excludeFoldersRaw = typeof env.MEMGLOW_EXCLUDE_FOLDERS === "string" && env.MEMGLOW_EXCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_EXCLUDE_FOLDERS.split(",") : a.excludeFolders;
  const includeFoldersRaw = typeof env.MEMGLOW_INCLUDE_FOLDERS === "string" && env.MEMGLOW_INCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_INCLUDE_FOLDERS.split(",") : a.includeFolders;
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    keepDays: int(env.MEMGLOW_ARCHIVE_KEEP_DAYS || a.keepDays, DEFAULTS.keepDays, 1, 3650),
    minTokens: int(env.MEMGLOW_ARCHIVE_MIN_TOKENS || a.minTokens, DEFAULTS.minTokens, 0, 1000000),
    idleMinutes: int(a.idleMinutes, DEFAULTS.idleMinutes, 0, 1440),
    scanHours: int(a.scanHours, DEFAULTS.scanHours, 0, 168),
    maxActionsPerScan: int(a.maxActionsPerScan, DEFAULTS.maxActionsPerScan, 1, 1000),
    timeoutMs: int(env.MEMGLOW_AI_TIMEOUT_MS || a.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    excludeFolders: autoSplit.sanitizeExcludeFolders(excludeFoldersRaw, a.archiveFolder),
    includeFolders: autoSplit.sanitizeIncludeFolders(includeFoldersRaw),
    ...aiProvider.providerFieldsFrom(a, env),
  };
}

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** The MOST RECENT (not merely the first) YYYY-MM-DD found in `text`, or null — ISO dates sort
 * lexicographically, so a plain string max is exact. Used both for the AI's own hint and for the
 * code-enforced keepDays filter below (0.5.5 bug fix: a section is only truly "old" by its latest
 * date, not whichever one happens to appear first). */
function latestDate(text) {
  let latest = null;
  for (const m of String(text || "").matchAll(DATE_RE)) if (!latest || m[1] > latest) latest = m[1];
  return latest;
}

/** heading text ([S<n>] level text, ≈tokens, date if found) — same id convention as
 * lib/auto-split.js's own outline(), plus the MOST RECENT YYYY-MM-DD found anywhere in the
 * section (heading or body — a cheap, honest hint, not a parser of every possible date format). */
function outline(body) {
  return engine.sectionSpans(body).filter((s) => s.text).map((s) => {
    const text = body.slice(s.start, s.end);
    return { level: s.level, text: s.text, tokens: engine.estimateTokens(text), date: latestDate(text) };
  });
}

function buildPrompt(note, cfg, now) {
  const masked = maskSecrets(note.raw);
  const { body } = engine.splitFM(masked);
  const heads = outline(body);
  const cutoff = engine.dateOf(now - cfg.keepDays * 86400000);
  const lines = [
    `Note: "${note.title}" (id: ${note.slug || note.base})`,
    `Today: ${engine.dateOf(now)}. keepDays: ${cfg.keepDays} (a dated entry older than ${cutoff} may be obsolete).`,
    heads.length ? "Sections ([id] level text, ≈tokens, date if any):" : "No headings at all: nothing this worker can archive.",
    ...heads.map((h, i) => `[S${i + 1}] ${"#".repeat(h.level)} ${h.text} (≈${h.tokens} tokens${h.date ? ", date " + h.date : ""})`),
  ];
  return lines.join("\n");
}

/**
 * 0.5.5 bug fix: "S<n>" (or, failing that, an exact heading text that appears exactly once) →
 * the 0-based INDEX into `heads` (outline() order) — never the heading TEXT: a note with two
 * identically-worded headings must still resolve exactly, and only an index can (moveSections()
 * — the TEXT-based selector — refuses a duplicate heading outright as ambiguous). Unresolvable or
 * duplicate ids are dropped (never invented, never thrown on); de-duplicated, order preserved.
 */
function resolveIndices(ids, heads) {
  const out = [];
  const seen = new Set();
  for (const ref of ids || []) {
    const m = /^\[?S(\d{1,4})\]?$/i.exec(String(ref).trim());
    let i = -1;
    if (m) { const k = Number(m[1]) - 1; if (k >= 0 && k < heads.length) i = k; }
    else { const hits = heads.map((h, idx) => (h.text === ref ? idx : -1)).filter((idx) => idx >= 0); if (hits.length === 1) i = hits[0]; }
    if (i >= 0 && !seen.has(i)) { seen.add(i); out.push(i); }
  }
  return out;
}

function parsePlan(text) {
  let s = String(text || "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("the AI's answer is not a JSON object");
  const parsed = JSON.parse(s.slice(a, b + 1));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sections)) throw new Error('the answer must have a "sections" array (possibly empty)');
  return parsed;
}

const ARCHIVED_LINE_RE = /^Archived sections: see \[\[([^\]]+)\]\]\.$/m;

/** The archive slug for `note` — "<slug>-archive", kebab, same naming the rest of the codebase
 * already uses for a sibling note. */
function archiveSlugFor(note) { return `${note.slug || note.base}-archive`; }

/**
 * Builds the two (or one, when the archive note already exists and is simply appended to) new
 * file texts for archiving the sections at `sectionIndices` (0-based, outline()/[S#] order) out
 * of `note` — pure, no I/O; throws only when moveSectionsByIndex itself refuses (overlap,
 * out-of-range, zero-loss failure — see lib/split-engine.js). `existingArchive` is the
 * already-resolved archive note record, or null to create one.
 */
function buildArchiveTexts({ note, sectionIndices, existingArchive, now }) {
  const { block, head, body } = engine.splitFM(note.raw);
  const r = engine.moveSectionsByIndex(body == null ? "" : body, sectionIndices);
  if (!r.ok) throw new engine.SplitError(r.errors.join("; "));
  const already = ARCHIVED_LINE_RE.test(r.kept);
  const archiveSlug = archiveSlugFor(note);
  const newSourceBody = already ? r.kept : r.kept.replace(/\s+$/, "") + `\n\nArchived sections: see [[${archiveSlug}]].\n`;
  const sourceHeadOut = block == null ? "" : (head.endsWith("\n") ? head : head + "\n");
  const sourceText = block == null ? newSourceBody : sourceHeadOut + "\n" + newSourceBody;

  const hubPartOf = note.frontmatter && typeof note.frontmatter.part_of === "string" ? note.frontmatter.part_of.trim() : "";
  const idOf = (n) => n.slug || n.base;
  const partOfId = hubPartOf || idOf(note);
  const date = engine.dateOf(now);

  let archiveText, archiveRel;
  if (existingArchive) {
    const { block: ab, head: ah, body: abody } = engine.splitFM(existingArchive.raw);
    const newBody = String(abody || "").replace(/\s+$/, "") + `\n\n${r.moved}\n`;
    const ahOut = ab == null ? "" : (ah.endsWith("\n") ? ah : ah + "\n");
    archiveText = ab == null ? newBody : ahOut + "\n" + newBody;
    archiveRel = existingArchive.rel;
  } else {
    const folder = note.dir || "";
    archiveRel = (folder ? folder + "/" : "") + archiveSlug + ".md";
    const group = {};
    for (const k of ["theme", "subtheme", "sous_theme"]) if (note.frontmatter && note.frontmatter[k] != null) group[k] = note.frontmatter[k];
    const fm = {
      title: archiveSlug, type: "note", permalink: generatePermalink(archiveRel), name: archiveSlug,
      ...group, description: `Archived sections from [[${idOf(note)}]].`, part_of: partOfId,
    };
    const upLine = `Up: [[${partOfId}]] — archived from ${idOf(note)} on ${date}.`;
    archiveText = buildNote(fm, `${upLine}\n\n${r.moved}\n`);
  }
  return { sourceText, archiveRel, archiveText, already };
}

function createArchiveWorker({ store, writer, config, dataDir = null, env = process.env, log = () => {}, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, aiRun = null, indexNote = ["MEMORY", "index"] }) {
  const cfg = archiveSettings(config, env);
  const events = createEventLog({ dir: dataDir, file: "auto-archive-log.json", keepMs: 90 * 86400000, max: 500, now, label: "auto-archive", clean: (e) => (e && typeof e.t === "number" && typeof e.kind === "string" ? { t: e.t, kind: e.kind, note: String(e.note || "").slice(0, 200), detail: String(e.detail || "").slice(0, 500) } : null) });
  const runAi = aiRun || ((prompt) => aiProvider.run(cfg, { system: SYSTEM, prompt, timeoutMs: cfg.timeoutMs }, { dataDir, env }));
  // 0.5.5: a "left" verdict (nothing eligible, whether the AI's own call or this file's own
  // keepDays/minTokens filtering) is cached by the note's own CONTENT hash — never re-asked
  // until that content actually changes, surviving a restart (module doc above).
  const leftCache = createVerdictCache({ dataDir, file: "auto-archive-cache.json", now });
  let lastScanAt = null, lastError = null;

  function status() {
    let keySet = false;
    try { keySet = aiProvider.describe(cfg, { dataDir, env }).key === "set"; } catch { keySet = false; }
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return { enabled: !!cfg.enabled, provider: cfg.provider, model: cfg.model, keySet, keepDays: cfg.keepDays, lastScanAt, nextScanAt, lastError: lastError ? { t: lastError.t, message: lastError.message } : null };
  }
  if (!cfg.enabled || !writer || !store) return { start() {}, stop() {}, scanOnce: async () => [], recentEvents: () => [], status, inert: true };

  function logEvent(kind, note, detail) { events.add({ t: now(), kind, note, detail }); log(`memglow auto-archive: ${kind}${note ? " " + note : ""}${detail ? " — " + detail.slice(0, 200) : ""}`); }

  function candidates() {
    const includeFolders = autoSplit.effectiveIncludeFolders(cfg, store, indexNote);
    return store.notes().filter((n) => n && n.type !== "index" && autoSplit.underIncluded(n.rel, includeFolders) && !autoSplit.underExcluded(n.rel, cfg.excludeFolders) && !(n.frontmatter && n.frontmatter.memglow_split === false) && !n.rel.endsWith("-archive.md"));
  }

  /** → true (archived), false (a transient failure — ask-failed/no-provider/aborted; never
   * cached, retried next scan regardless of content), "left" (the AI or this file's own
   * keepDays/minTokens filtering found nothing eligible — the caller caches this by content
   * hash), or "auth-error". */
  async function attemptOne(n) {
    if (!cfg.provider) return false;
    const masked = maskSecrets(n.raw);
    const { body } = engine.splitFM(masked);
    const heads = outline(body == null ? "" : body);
    if (!heads.length) return "left"; // nothing headed to archive — stable for this content
    const prompt = buildPrompt(n, cfg, now());
    let ai;
    try { ai = await runAi(prompt); } catch (e) { ai = { ok: false, error: e.message }; }
    if (!ai || !ai.ok) {
      const errMsg = (ai && ai.error) || "the AI provider failed";
      if (aiProvider.isAuthError(errMsg)) { lastError = { t: now(), message: errMsg.slice(0, 300) }; logEvent("auth-error", n.slug || n.base, errMsg); return "auth-error"; }
      logEvent("ask-failed", n.slug || n.base, errMsg);
      return false;
    }
    let plan;
    try { plan = parsePlan(ai.text); } catch (e) { logEvent("ask-failed", n.slug || n.base, e.message); return false; }
    let indices = resolveIndices(plan.sections, heads);
    // 0.5.5 bug fix: keepDays is enforced HERE, in code — a chosen section whose most recent
    // date is newer than the cutoff is dropped, whatever the AI itself answered.
    const cutoff = engine.dateOf(now() - cfg.keepDays * 86400000);
    const tooRecent = indices.filter((i) => heads[i].date && heads[i].date > cutoff);
    indices = indices.filter((i) => !(heads[i].date && heads[i].date > cutoff));
    if (!indices.length) {
      logEvent("left", n.slug || n.base, tooRecent.length ? "every chosen section is more recent than keepDays" : (plan.reason || "nothing clearly obsolete"));
      return "left";
    }
    // 0.5.5 bug fix: minTokens — never archive a handful of lines into a brand-new note.
    const totalTokens = indices.reduce((s, i) => s + heads[i].tokens, 0);
    if (totalTokens < cfg.minTokens) {
      logEvent("left", n.slug || n.base, `chosen sections total ≈${totalTokens} tokens, below minTokens (${cfg.minTokens})`);
      return "left";
    }
    store.refreshNote && store.refreshNote(n.rel);
    const fresh = store.resolve(n.rel);
    if (!fresh || fresh.mtimeMs !== n.mtimeMs) { logEvent("archive-aborted", n.slug || n.base, "the note changed while the AI was deciding"); return false; }
    let built;
    try { built = buildArchiveTexts({ note: fresh, sectionIndices: indices, existingArchive: store.resolve(archiveSlugFor(fresh)), now: now() }); }
    catch (e) { logEvent("archive-failed", n.slug || n.base, e.message); return false; }
    // `built.already`: the source already carries the "Archived sections: see […]" link from an
    // earlier pass (buildArchiveTexts never duplicates that one line) — the archiving itself
    // still goes ahead, this is purely informational.
    const st = await writer.target(fresh.rel);
    const newSt = await writer.writeAtomic(st.abs, built.sourceText, st.stat);
    store.noteWritten(st.rel, built.sourceText, newSt);
    writer.wrote([st.rel]);
    const at = await writer.target(built.archiveRel);
    const aSt = await writer.writeAtomic(at.abs, built.archiveText, at.stat);
    store.noteWritten(at.rel, built.archiveText, aSt);
    writer.wrote([at.rel]);
    logEvent("archived", n.slug || n.base, `${indices.length} section(s) → ${path.basename(built.archiveRel, ".md")}: ${plan.reason || ""}`);
    return true;
  }

  async function scanOnce() {
    lastScanAt = now();
    if (lastError) return [];
    const d = aiRun ? { available: true } : aiProvider.detect(cfg, { dataDir, env });
    if (!d.available) { logEvent("inert", null, d.reason || "no AI provider available"); return []; }
    const applied = [];
    const cands = candidates()
      .filter((n) => (now() - (n.mtimeMs || 0)) >= cfg.idleMinutes * 60000)
      .sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
    for (const n of cands) {
      if (applied.length >= cfg.maxActionsPerScan) break;
      const hash = leftCache.sha1(n.raw);
      if (leftCache.get(hash) === "left") continue; // unchanged since it was last found to have nothing eligible
      const r = await attemptOne(n);
      if (r === "auth-error") break;
      if (r === "left") leftCache.set(hash, "left");
      else if (r) applied.push(n.rel);
    }
    return applied;
  }

  let timer = null;
  function start() {
    scanOnce().catch((e) => log(`memglow auto-archive: scan failed: ${e.message}`));
    if (cfg.scanHours > 0) {
      const ms = Math.min(cfg.scanHours * 3600000, 2147483647);
      timer = setIntervalFn(() => { scanOnce().catch(() => {}); }, ms);
      if (timer && timer.unref) timer.unref();
    }
  }
  function stop() { if (timer) clearIntervalFn(timer); timer = null; events.flush(); leftCache.flush(); }
  return { start, stop, scanOnce, recentEvents: (since) => events.events(since), status, inert: false };
}

module.exports = { archiveSettings, outline, latestDate, buildPrompt, resolveIndices, parsePlan, archiveSlugFor, buildArchiveTexts, createArchiveWorker, DEFAULTS, SYSTEM };
