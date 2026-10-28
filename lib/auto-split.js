"use strict";
/**
 * 0.5.4: the built-in auto-split worker — memglow decides BY ITSELF, with an AI the owner picks
 * (lib/ai-provider.js), when and how to split a note that has grown too large, and applies it
 * through lib/split-engine.js (the same zero-loss, hub-and-spoke-preserving engine `split_plan`'s
 * proposal is built from). OFF by default everywhere (public and NAS): it needs `enabled: true`
 * (or MEMGLOW_AUTO_SPLIT=1) AND a configured, reachable AI provider — `--levers` does not turn it
 * on by itself. Lives in the memory server only (memory-server/memglow-memory-server.js wires it
 * through `writer`'s `onWrote` hook, read-write mode only); the plain viewer never runs it.
 *
 * Triggers:
 *   - a write (write_note/edit_note/move_note, or this worker's own previous split) that leaves a
 *     note over `thresholdTokens`: queued, with the time of that write.
 *   - a periodic full scan (every `scanHours`, default 24; 0 = the worker still watches writes,
 *     but never sweeps the whole folder) of every note over the threshold, so a note grown some
 *     other way (edited on disk, synced in) is found too — at most `maxSplitsPerScan` per sweep.
 * A queued note is only actually split once it has been quiet for `idleMinutes` (default 30: never
 * mid-conversation), one note at a time, never while a write to it could be in flight: right
 * before applying, the note is re-read and its mtime compared to what triggered the attempt —
 * changed since, the attempt is abandoned (the next tick tries again once it is quiet again).
 *
 * Skipped, always: the index note (config.indexNote), anything under an `archive/`-named folder
 * (lib/archive.js's own convention), and a note whose frontmatter has `memglow_split: false` (an
 * explicit opt-out — dropped from the queue, never re-added by a plain re-scan over the
 * threshold; a direct `split_plan`/manual split by the owner still works, this only turns off the
 * automatic one).
 *
 * The AI gets the note's structure (headings, sizes, a masked preview of its untitled intro) and
 * answers with a strict JSON split_apply-shaped plan; lib/split-engine.js validates it — a refused
 * plan is retried exactly once, with the engine's own error list appended to the prompt, then
 * memglow gives up on that note until it is reconsidered (write, or the next full scan).
 */
const path = require("path");
const { maskSecrets } = require("./memory");
const engine = require("./split-engine");
const aiProvider = require("./ai-provider");
const { createEventLog } = require("./event-log");

const DEFAULTS = {
  enabled: false,
  thresholdTokens: 5000,
  idleMinutes: 30,
  scanHours: 24,
  maxSplitsPerScan: 10,
  timeoutMs: 180000,
  archiveFolder: "archive",
};
const DEFAULT_EXCLUDE_FOLDERS = ["archive"];
const MAX_EXCLUDE_FOLDERS = 20;
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1 (lib/maintenance.js: Node's timer clamp, never a runaway)
const TICK_MS = 60000; // the debounce queue is drained at most once a minute
const TARGET_PART_SHARE = 0.6; // "≤ ~60% of threshold" (direction message)
const SYSTEM = [
  "You split one note of an AI assistant's Markdown memory into smaller notes, by naming EXISTING headings (and, rarely, exact loose lines) to move — you never rewrite or summarise content.",
  "Answer with ONE JSON object and nothing else (no prose, no code fence): {\"parts\": [{\"slug\": \"...\", \"description\": \"...\", \"hook\": \"...\", \"sections\": [\"...\"]}], \"hub_summary\": \"...\"}.",
  "parts: 1 to 8 new notes. slug: kebab-case, English, shaped \"<hub>-<topic>\" (the hub's own id, a dash, a short topic). description: one English sentence (what the part holds). hook: a short English clause for the hub's own \"- [[slug]] — hook\" line (defaults to description if omitted). sections: one or more existing top-level sections of the note, each named by its id from the list (\"S3\") — or, failing that, its EXACT heading text (verbatim, no \"#\"); its whole section (and any of its own subsections) moves. Only when content is NOT under any heading, \"lines\" may name exact loose lines to move instead (rare).",
  "Group whole, already-adjacent sections into each part, aiming for parts of about the target size given below — never split a single section's own text apart.",
  "hub_summary: 1-3 short English sentences replacing the note's old body (what it covers now, and that it was split) — do not list the parts yourselves, memglow adds that list.",
  "Never invent a heading that is not listed below. Never ask for the same content twice.",
].join("\n");

function int(v, def, min, max) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; }
function str(v, max = 200) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : ""; }

/**
 * 0.5.4: `excludeFolders` — a LIST of folder prefixes (relative to the KB root) neither worker
 * ever touches, shared by lib/auto-split.js (here) and lib/star-audit.js's structure guardian.
 * `archiveFolder` (the original, single-folder setting) is kept as an alias: given alone, it
 * becomes a one-item list; given together with `excludeFolders`, the explicit list wins outright
 * (never merged — one source of truth, same "full replacement" rule every config table in this
 * codebase already follows). Default: `["archive"]`, unchanged from before this existed.
 */
function sanitizeExcludeFolders(raw, archiveFolderAlias) {
  const clean = (s) => String(s == null ? "" : s).trim().replace(/^\/+|\/+$/g, "").slice(0, 200);
  let list = null;
  if (Array.isArray(raw) && raw.length) list = raw.map(clean).filter(Boolean);
  else if (typeof archiveFolderAlias === "string" && archiveFolderAlias.trim()) list = [clean(archiveFolderAlias)];
  if (!list || !list.length) list = DEFAULT_EXCLUDE_FOLDERS.slice();
  const seen = new Set(), out = [];
  for (const f of list) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= MAX_EXCLUDE_FOLDERS) break;
  }
  return out.length ? out : DEFAULT_EXCLUDE_FOLDERS.slice();
}

/** Whether `rel` sits under ANY of `folders` ("archive/…", any nesting, for every entry). */
function underExcluded(rel, folders) {
  if (typeof rel !== "string") return false;
  for (const f of folders || []) if (f && (rel === f || rel.startsWith(f + "/"))) return true;
  return false;
}

/**
 * 0.5.4: `includeFolders` — the MIRROR of `excludeFolders` above, scoping BOTH workers down to a
 * list of folder prefixes instead of walking every note under the KB root. Unlike excludeFolders,
 * there is no static default: a KB root that holds the memory (with its own index note) ALONGSIDE
 * other, one-way-synced content (project docs, a workspace mirror — never meant to be scanned,
 * let alone split or "fixed") needs a SENSIBLE default without the owner having to spell it out —
 * so when `includeFolders` is not explicitly set, the EFFECTIVE scope defaults to the folder that
 * holds the index note itself (`effectiveIncludeFolders()` below, resolved against the live store
 * at scan time, never baked into settings — the index note might not exist yet when settings are
 * first read). An explicit `includeFolders` always wins outright over that default.
 */
function sanitizeIncludeFolders(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const clean = (s) => String(s == null ? "" : s).trim().replace(/^\/+|\/+$/g, "").slice(0, 200);
  const seen = new Set(), out = [];
  for (const f of raw.map(clean).filter(Boolean)) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= MAX_EXCLUDE_FOLDERS) break;
  }
  return out.length ? out : null;
}

/** Whether `rel` sits under ANY of `folders` — `null`/empty `folders` means "no restriction at
 * all" (everything is in scope), the opposite default from underExcluded() above. */
function underIncluded(rel, folders) {
  if (!folders || !folders.length) return true;
  if (typeof rel !== "string") return false;
  for (const f of folders) if (f && (rel === f || rel.startsWith(f + "/"))) return true;
  return false;
}

/** The default include-scope when `includeFolders` is not explicitly set: the folder holding the
 * first `indexNote` candidate that resolves — or `null` (everything) when that note sits at the
 * KB root, or none of the candidates resolve at all (nothing to anchor a default on). */
function defaultIncludeFolders(store, indexNote) {
  for (const name of indexNote || ["MEMORY", "index"]) {
    const n = store.resolve(name);
    if (n) { const dir = n.dir || ""; return dir ? [dir] : null; }
  }
  return null;
}

/** `includeFolders` actually in effect for one scan/check: the explicit setting wins outright;
 * otherwise the index note's own folder (defaultIncludeFolders above); otherwise `null`
 * (everything). Cheap (one or two store.resolve() calls) — recomputed per call on purpose, never
 * cached, since the index note might not have existed yet the first time a worker started. */
function effectiveIncludeFolders(cfg, store, indexNote) {
  if (cfg.includeFolders && cfg.includeFolders.length) return cfg.includeFolders;
  return defaultIncludeFolders(store, indexNote);
}

/**
 * autoSplitSettings(raw, env) — pure, same shape as lib/archive.js's settings(): `raw` is the
 * "autoSplit" top-level key of memglow.config.json (read by the caller, allowCwd: false — never a
 * notes-folder's own config file: this runs inside the memory server, see module doc), `env` for
 * the MEMGLOW_AUTO_SPLIT / MEMGLOW_AI_* overrides.
 */
function autoSplitSettings(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const envOn = String(env.MEMGLOW_AUTO_SPLIT || "").toLowerCase();
  const archiveFolder = str(a.archiveFolder, 80) || DEFAULTS.archiveFolder;
  const excludeFoldersRaw = typeof env.MEMGLOW_EXCLUDE_FOLDERS === "string" && env.MEMGLOW_EXCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_EXCLUDE_FOLDERS.split(",") : a.excludeFolders;
  const includeFoldersRaw = typeof env.MEMGLOW_INCLUDE_FOLDERS === "string" && env.MEMGLOW_INCLUDE_FOLDERS.trim()
    ? env.MEMGLOW_INCLUDE_FOLDERS.split(",") : a.includeFolders;
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    thresholdTokens: int(env.MEMGLOW_LARGE_NOTE_TOKENS || a.thresholdTokens, DEFAULTS.thresholdTokens, 200, 1000000),
    idleMinutes: int(a.idleMinutes, DEFAULTS.idleMinutes, 0, 1440),
    scanHours: int(a.scanHours, DEFAULTS.scanHours, 0, 168),
    maxSplitsPerScan: int(a.maxSplitsPerScan, DEFAULTS.maxSplitsPerScan, 1, 1000),
    timeoutMs: int(env.MEMGLOW_AI_TIMEOUT_MS || a.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    archiveFolder, // kept: back-compat / display only — excludeFolders is what candidate() reads
    excludeFolders: sanitizeExcludeFolders(excludeFoldersRaw, archiveFolder),
    // null (not explicitly set) → effectiveIncludeFolders() falls back to the index note's own
    // folder at scan time (see that function's own doc above) — never baked in here, since the
    // index note may not exist yet when settings are first resolved.
    includeFolders: sanitizeIncludeFolders(includeFoldersRaw),
    // Provider selection (provider/model/baseUrl/apiKeyEnv/apiKeyFile/command/claudeHome): shared
    // field resolution with lib/star-audit.js's structure.ai, lib/ai-provider.js's own
    // providerFieldsFrom() — same env vars, same per-provider defaults, one place either feature
    // can diverge from if it ever needs to.
    ...aiProvider.providerFieldsFrom(a, env),
  };
}

/** Whether `rel` sits under memglow's own archive folder ("archive/…", any nesting). Kept for
 * back-compat (a single folder); excludeFolders/underExcluded above is the general form. */
function underArchive(rel, folder) { return underExcluded(rel, [folder]); }

/** heading text → token-estimated size, nested cut (lib/split-engine.js's sectionSpans). */
function outline(maskedBody) {
  return engine.sectionSpans(maskedBody).filter((s) => s.text).map((s) => ({ level: s.level, text: s.text, tokens: engine.estimateTokens(maskedBody.slice(s.start, s.end)) }));
}

function buildPrompt(note, cfg, { retryErrors = null } = {}) {
  const masked = maskSecrets(note.raw);
  const { body } = engine.splitFM(masked);
  const spans = engine.sectionSpans(body);
  const intro = spans.length && spans[0].level === 0 ? body.slice(spans[0].start, spans[0].end) : (spans.length ? "" : body);
  const heads = outline(body);
  const target = Math.max(200, Math.round(cfg.thresholdTokens * TARGET_PART_SHARE));
  const lines = [
    `Note: "${note.title}" (id: ${note.slug || note.base})`,
    `Size: ≈${engine.estimateTokens(note.raw)} tokens (threshold ${cfg.thresholdTokens}). Target part size: ≈${target} tokens or less.`,
    heads.length ? "Sections ([id] level text, ≈tokens) — name them in \"sections\" by their id, e.g. \"S3\":" : "No headings: everything is loose text (use \"lines\").",
    ...heads.map((h, i) => `[S${i + 1}] ${"#".repeat(h.level)} ${h.text} (≈${h.tokens} tokens)`),
    "",
    "Untitled intro (masked where it looked like a secret):",
    intro.trim() || "(none)",
  ];
  if (retryErrors && retryErrors.length) {
    lines.push("", "Your last answer was refused for these reasons — fix them and answer again with the full JSON object:", ...retryErrors.map((e) => "- " + e));
  }
  return lines.join("\n");
}

/**
 * 0.5.4.2: the AI names sections by the ids of buildPrompt()'s outline ("S3"), because a heading
 * that looked like a secret is shown MASKED there ("[line hidden: …]") and its real text could not
 * be echoed back (seen in production: a heading holding a commit hash). Maps every "S<n>" — and
 * any masked heading text echoed verbatim — to the REAL heading text of the unmasked note, same
 * order as outline() (masking keeps headings and line count, so the spans line up). Anything else
 * passes through untouched for the engine's own exact-match validation.
 */
function resolveSectionRefs(plan, rawNote) {
  if (!plan || !Array.isArray(plan.parts)) return plan;
  const realHeads = engine.sectionSpans(engine.splitFM(rawNote).body).filter((x) => x.text).map((x) => x.text);
  const maskedHeads = engine.sectionSpans(engine.splitFM(maskSecrets(rawNote)).body).filter((x) => x.text).map((x) => x.text);
  const byMasked = new Map();
  maskedHeads.forEach((t, i) => { if (t !== realHeads[i]) byMasked.set(t, byMasked.has(t) ? null : realHeads[i]); });
  const one = (ref) => {
    const m = /^\[?S(\d{1,4})\]?$/i.exec(String(ref).trim());
    if (m) { const i = Number(m[1]) - 1; return i >= 0 && i < realHeads.length ? realHeads[i] : ref; }
    const r = byMasked.get(ref);
    return r || ref;
  };
  return { ...plan, parts: plan.parts.map((p) => (p && Array.isArray(p.sections) ? { ...p, sections: p.sections.map(one) } : p)) };
}

/** The AI's raw text → the parsed plan object, or throws with a short reason. */
function parsePlan(text) {
  let s = String(text || "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("the AI's answer is not a JSON object");
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * createAutoSplitWorker({ store, writer, project, config, dataDir, env, log, now, setTimeoutFn,
 * clearTimeoutFn, aiRun }) → { start(), stop(), noteWritten(rels), tick(), recentEvents(),
 * pendingCount(), inert }. `aiRun` is injectable (tests: a fake that never touches the network).
 */
function createAutoSplitWorker({ store, writer, project = "main", config, dataDir = null, env = process.env, log = () => {}, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval, aiRun = null, indexNote = ["MEMORY", "index"] }) {
  // autoSplitSettings() is idempotent on an already-resolved object (every field re-validated to
  // the same value), so a caller may pass either the raw "autoSplit" config-file key or a
  // previously resolved settings object — always through here, so a partial test fixture still
  // gets every default field.
  const cfg = autoSplitSettings(config, env);
  const events = createEventLog({ dir: dataDir, file: "auto-split-log.json", keepMs: 90 * 86400000, max: 500, now, label: "auto-split", clean: (e) => (e && typeof e.t === "number" && typeof e.kind === "string" ? { t: e.t, kind: e.kind, note: String(e.note || "").slice(0, 200), detail: String(e.detail || "").slice(0, 500) } : null) });
  const runAi = aiRun || ((prompt) => aiProvider.run(cfg, { system: SYSTEM, prompt, timeoutMs: cfg.timeoutMs }, { dataDir, env }));
  let lastScanAt = null;
  // 0.5.4 bug fix: a bad credential (auth error) is never fixed by retrying — once seen, it is
  // kept here (never cleared automatically: only a restart, after the key/token is actually
  // fixed, re-reads it) and surfaced in status(); every tick() below bails out at once while it
  // is set, so one bad key never gets hammered once per candidate per scan.
  let lastError = null;
  /** `/api/maintenance` (memory-server/http.js) and memory_core's own status line — never the
   * key itself, only whether one resolved ("set"/"not set"/"not needed"). */
  function status(pendingCount = 0) {
    let keySet = false;
    try { keySet = aiProvider.describe(cfg, { dataDir, env }).key === "set"; } catch { keySet = false; }
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return {
      enabled: !!cfg.enabled, provider: cfg.provider, model: cfg.model, keySet, thresholdTokens: cfg.thresholdTokens, pendingCount, lastScanAt, nextScanAt,
      lastError: lastError ? { t: lastError.t, message: lastError.message } : null,
    };
  }

  if (!cfg.enabled || !writer || !store) {
    return { start() {}, stop() {}, noteWritten() {}, tick: async () => {}, recentEvents: () => [], pendingCount: () => 0, status: () => status(0), inert: true };
  }

  const pending = new Map(); // rel -> since-ms (when it became a candidate / was last written)
  let warnedNoProvider = false;
  let processing = false;
  let tickTimer = null, scanTimer = null, started = false;

  function logEvent(kind, note, detail) {
    events.add({ t: now(), kind, note, detail });
    log(`memglow auto-split: ${kind}${note ? " " + note : ""}${detail ? " — " + detail.slice(0, 200) : ""}`);
  }

  /**
   * 0.5.4 bug fix: SCOPE — a KB root holding the memory (with its own index note) alongside
   * other, one-way-synced content (project docs, a workspace mirror) must never have this
   * worker wander into that other content at all — `includeFolders` (explicit, or defaulted to
   * the index note's own folder; see effectiveIncludeFolders()'s own doc) is checked FIRST, before
   * excludeFolders, on every candidate check.
   */
  function candidate(n, includeFolders) {
    if (!n) return false;
    if (n.type === "index") return false;
    if (!underIncluded(n.rel, includeFolders)) return false;
    if (underExcluded(n.rel, cfg.excludeFolders)) return false;
    if (n.frontmatter && n.frontmatter.memglow_split === false) return false;
    return true;
  }

  function noteWritten(rels) {
    const includeFolders = effectiveIncludeFolders(cfg, store, indexNote);
    for (const rel of rels || []) {
      const n = store.resolve(rel);
      if (!candidate(n, includeFolders)) { pending.delete(rel); continue; }
      pending.set(n.rel, now());
    }
  }

  /**
   * 0.5.4 bug fix: a note the periodic scan finds waits `idleMinutes` from its own file mtime
   * (the note's real last-edit time), same as a write-triggered one waits from "since our own
   * write" — a note last touched long before this server even started (the common case for most
   * of an established KB on every restart) is correctly already idle and eligible at once; one
   * genuinely edited minutes ago is not, however long ago the scan itself ran.  A note that is
   * BOTH already queued (a recent write) AND re-seen by this scan keeps whichever of the two
   * signals is MORE RECENT (`Math.max`): a write still in flight must never look idle just
   * because the scan also noticed it, and vice versa.
   */
  async function runScan() {
    lastScanAt = now();
    const includeFolders = effectiveIncludeFolders(cfg, store, indexNote);
    let added = 0;
    for (const n of store.notes()) {
      if (added >= cfg.maxSplitsPerScan) break;
      if (!candidate(n, includeFolders)) continue;
      if (engine.estimateTokens(n.size || 0) <= cfg.thresholdTokens) continue;
      const mtimeSince = n.mtimeMs || now();
      if (pending.has(n.rel)) { pending.set(n.rel, Math.max(pending.get(n.rel), mtimeSince)); continue; }
      pending.set(n.rel, mtimeSince);
      added++;
    }
  }

  async function attempt(rel) {
    // "Idle" is measured against OUR OWN clock (`now()`, injectable) FROM the moment `pending`
    // last recorded for this note — which noteWritten() sets to "now" (our own write clock) and
    // runScan() sets to the note's real file mtime, Math.max'd with any existing entry (see that
    // function's own doc above): a note edited twice in quick succession always waits the full
    // idle window from its LAST edit, not its first; one the scan found quietly sitting there for
    // days is correctly already idle, however recently the scan itself happened to run.
    const since = pending.get(rel);
    let n = store.resolve(rel);
    const includeFolders = effectiveIncludeFolders(cfg, store, indexNote);
    if (!candidate(n, includeFolders)) { pending.delete(rel); return; }
    if (engine.estimateTokens(n.size || 0) <= cfg.thresholdTokens) { pending.delete(rel); return; }
    if (now() - (since || 0) < cfg.idleMinutes * 60000) return; // still being worked on: try later
    if (!cfg.provider) return; // inert without a provider (logged once at start())

    let result = null, lastErrors = null;
    for (let attemptN = 0; attemptN < 2; attemptN++) {
      const prompt = buildPrompt(n, cfg, { retryErrors: attemptN ? lastErrors : null });
      let ai;
      try { ai = await runAi(prompt); } catch (e) { ai = { ok: false, error: e.message }; }
      if (!ai || !ai.ok) {
        const errMsg = (ai && ai.error) || "the AI provider failed";
        // 0.5.4 bug fix: a bad credential is never fixed by a retry with error feedback (that is
        // for a malformed JSON plan, not an auth failure) — stop THIS attempt at once, and every
        // other candidate still queued in this (and every future) scan, rather than hammer the
        // provider with the same doomed call once per note.
        if (aiProvider.isAuthError(errMsg)) {
          lastError = { t: now(), message: errMsg.slice(0, 300) };
          logEvent("auth-error", n.slug || n.base, errMsg);
          return;
        }
        lastErrors = [errMsg]; continue;
      }
      let plan;
      try { plan = resolveSectionRefs(parsePlan(ai.text), n.raw); } catch (e) { lastErrors = [e.message]; continue; }
      // Abort if the note changed since it was queued (a write could be in flight): the mtime
      // seen right before this round must still be the one from the queue, AND re-read fresh now.
      store.refreshNote && store.refreshNote(rel);
      const fresh = store.resolve(rel);
      if (!fresh || fresh.mtimeMs !== n.mtimeMs) { logEvent("split-aborted", n.slug || n.base, "the note changed while the AI was deciding"); pending.delete(rel); return; }
      result = await engine.splitNote({ store, writer, project, identifier: rel, plan, threshold: cfg.thresholdTokens, now: now() });
      if (result.ok) break;
      lastErrors = result.errors;
    }
    pending.delete(rel);
    if (!result || !result.ok) {
      logEvent("split-failed", n.slug || n.base, lastErrors ? lastErrors.join("; ") : "unknown error");
      return;
    }
    logEvent("split", n.slug || n.base, `${result.parts.length} part(s): ${result.parts.map((p) => p.slug).join(", ")}`);
  }

  async function tick() {
    if (processing || !pending.size) return;
    if (lastError) return; // a bad credential was already seen: stop hammering it (see attempt())
    if (!cfg.provider) {
      if (!warnedNoProvider) { warnedNoProvider = true; log("memglow auto-split: enabled, but no AI provider is configured — set autoSplit.provider (anthropic, openai-compatible or claude-code); staying inert"); }
      return;
    }
    const d = aiProvider.detect(cfg, { dataDir, env });
    if (!d.available) {
      if (!warnedNoProvider) { warnedNoProvider = true; log(`memglow auto-split: enabled, but the AI provider is not available (${d.reason || "unknown reason"}); staying inert`); }
      return;
    }
    // Oldest-queued first, deterministic.
    const [rel] = [...pending.entries()].sort((a, b) => a[1] - b[1]).map(([r]) => r);
    if (!rel) return;
    processing = true;
    try { await attempt(rel); }
    catch (e) { logEvent("split-failed", rel, e.message); pending.delete(rel); }
    finally { processing = false; }
  }

  function start() {
    if (started) return;
    started = true;
    tickTimer = setIntervalFn(() => { tick().catch(() => {}); }, TICK_MS);
    if (tickTimer && tickTimer.unref) tickTimer.unref();
    if (cfg.scanHours > 0) {
      const ms = Math.min(cfg.scanHours * 3600000, MAX_TIMEOUT_MS);
      runScan().catch(() => {});
      scanTimer = setIntervalFn(() => { runScan().catch(() => {}); }, ms);
      if (scanTimer && scanTimer.unref) scanTimer.unref();
    }
  }
  function stop() {
    started = false;
    if (tickTimer) clearIntervalFn(tickTimer);
    if (scanTimer) clearIntervalFn(scanTimer);
    tickTimer = scanTimer = null;
    events.flush();
  }

  return { start, stop, noteWritten, tick, runScan, recentEvents: (since) => events.events(since), pendingCount: () => pending.size, status: () => status(pending.size), inert: false };
}

module.exports = {
  resolveSectionRefs, createAutoSplitWorker, autoSplitSettings, buildPrompt, parsePlan, outline,
  underArchive, underExcluded, sanitizeExcludeFolders, DEFAULT_EXCLUDE_FOLDERS,
  sanitizeIncludeFolders, underIncluded, defaultIncludeFolders, effectiveIncludeFolders,
  DEFAULTS, SYSTEM, TARGET_PART_SHARE,
};
