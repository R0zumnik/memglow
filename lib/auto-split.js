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
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1 (lib/maintenance.js: Node's timer clamp, never a runaway)
const TICK_MS = 60000; // the debounce queue is drained at most once a minute
const TARGET_PART_SHARE = 0.6; // "≤ ~60% of threshold" (direction message)
const SYSTEM = [
  "You split one note of an AI assistant's Markdown memory into smaller notes, by naming EXISTING headings (and, rarely, exact loose lines) to move — you never rewrite or summarise content.",
  "Answer with ONE JSON object and nothing else (no prose, no code fence): {\"parts\": [{\"slug\": \"...\", \"description\": \"...\", \"hook\": \"...\", \"sections\": [\"...\"]}], \"hub_summary\": \"...\"}.",
  "parts: 1 to 8 new notes. slug: kebab-case, English, shaped \"<hub>-<topic>\" (the hub's own id, a dash, a short topic). description: one English sentence (what the part holds). hook: a short English clause for the hub's own \"- [[slug]] — hook\" line (defaults to description if omitted). sections: the EXACT heading text of one or more existing top-level sections of the note (verbatim, no \"#\"); its whole section (and any of its own subsections) moves. Only when content is NOT under any heading, \"lines\" may name exact loose lines to move instead (rare).",
  "Group whole, already-adjacent sections into each part, aiming for parts of about the target size given below — never split a single section's own text apart.",
  "hub_summary: 1-3 short English sentences replacing the note's old body (what it covers now, and that it was split) — do not list the parts yourselves, memglow adds that list.",
  "Never invent a heading that is not listed below. Never ask for the same content twice.",
].join("\n");

function int(v, def, min, max) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : def; }
function str(v, max = 200) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : ""; }

/**
 * autoSplitSettings(raw, env) — pure, same shape as lib/archive.js's settings(): `raw` is the
 * "autoSplit" top-level key of memglow.config.json (read by the caller, allowCwd: false — never a
 * notes-folder's own config file: this runs inside the memory server, see module doc), `env` for
 * the MEMGLOW_AUTO_SPLIT / MEMGLOW_AI_* overrides.
 */
function autoSplitSettings(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const envOn = String(env.MEMGLOW_AUTO_SPLIT || "").toLowerCase();
  return {
    enabled: envOn === "1" || envOn === "true" ? true : envOn === "0" || envOn === "false" ? false : a.enabled === true,
    thresholdTokens: int(env.MEMGLOW_LARGE_NOTE_TOKENS || a.thresholdTokens, DEFAULTS.thresholdTokens, 200, 1000000),
    idleMinutes: int(a.idleMinutes, DEFAULTS.idleMinutes, 0, 1440),
    scanHours: int(a.scanHours, DEFAULTS.scanHours, 0, 168),
    maxSplitsPerScan: int(a.maxSplitsPerScan, DEFAULTS.maxSplitsPerScan, 1, 1000),
    timeoutMs: int(env.MEMGLOW_AI_TIMEOUT_MS || a.timeoutMs, DEFAULTS.timeoutMs, 1000, 600000),
    archiveFolder: str(a.archiveFolder, 80) || DEFAULTS.archiveFolder,
    // Provider selection (provider/model/baseUrl/apiKeyEnv/apiKeyFile/command/claudeHome): shared
    // field resolution with lib/star-audit.js's structure.ai, lib/ai-provider.js's own
    // providerFieldsFrom() — same env vars, same per-provider defaults, one place either feature
    // can diverge from if it ever needs to.
    ...aiProvider.providerFieldsFrom(a, env),
  };
}

/** Whether `rel` sits under memglow's own archive folder ("archive/…", any nesting). */
function underArchive(rel, folder) { return typeof rel === "string" && (rel === folder || rel.startsWith(folder + "/")); }

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
    heads.length ? "Sections (exact text, level, ≈tokens):" : "No headings: everything is loose text (use \"lines\").",
    ...heads.map((h) => `${"#".repeat(h.level)} ${h.text} (≈${h.tokens} tokens)`),
    "",
    "Untitled intro (masked where it looked like a secret):",
    intro.trim() || "(none)",
  ];
  if (retryErrors && retryErrors.length) {
    lines.push("", "Your last answer was refused for these reasons — fix them and answer again with the full JSON object:", ...retryErrors.map((e) => "- " + e));
  }
  return lines.join("\n");
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
function createAutoSplitWorker({ store, writer, project = "main", config, dataDir = null, env = process.env, log = () => {}, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval, aiRun = null }) {
  // autoSplitSettings() is idempotent on an already-resolved object (every field re-validated to
  // the same value), so a caller may pass either the raw "autoSplit" config-file key or a
  // previously resolved settings object — always through here, so a partial test fixture still
  // gets every default field.
  const cfg = autoSplitSettings(config, env);
  const events = createEventLog({ dir: dataDir, file: "auto-split-log.json", keepMs: 90 * 86400000, max: 500, now, label: "auto-split", clean: (e) => (e && typeof e.t === "number" && typeof e.kind === "string" ? { t: e.t, kind: e.kind, note: String(e.note || "").slice(0, 200), detail: String(e.detail || "").slice(0, 500) } : null) });
  const runAi = aiRun || ((prompt) => aiProvider.run(cfg, { system: SYSTEM, prompt, timeoutMs: cfg.timeoutMs }, { dataDir, env }));
  let lastScanAt = null;
  /** `/api/maintenance` (memory-server/http.js) and memory_core's own status line — never the
   * key itself, only whether one resolved ("set"/"not set"/"not needed"). */
  function status(pendingCount = 0) {
    let keySet = false;
    try { keySet = aiProvider.describe(cfg, { dataDir, env }).key === "set"; } catch { keySet = false; }
    const nextScanAt = cfg.scanHours > 0 && lastScanAt != null ? lastScanAt + cfg.scanHours * 3600000 : null;
    return { enabled: !!cfg.enabled, provider: cfg.provider, model: cfg.model, keySet, thresholdTokens: cfg.thresholdTokens, pendingCount, lastScanAt, nextScanAt };
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

  function candidate(n) {
    if (!n) return false;
    if (n.type === "index") return false;
    if (underArchive(n.rel, cfg.archiveFolder)) return false;
    if (n.frontmatter && n.frontmatter.memglow_split === false) return false;
    return true;
  }

  function noteWritten(rels) {
    for (const rel of rels || []) {
      const n = store.resolve(rel);
      if (!candidate(n)) { pending.delete(rel); continue; }
      pending.set(n.rel, now());
    }
  }

  async function runScan() {
    lastScanAt = now();
    let added = 0;
    for (const n of store.notes()) {
      if (added >= cfg.maxSplitsPerScan) break;
      if (pending.has(n.rel)) continue;
      if (!candidate(n)) continue;
      if (engine.estimateTokens(n.size || 0) <= cfg.thresholdTokens) continue;
      pending.set(n.rel, n.mtimeMs || now());
      added++;
    }
  }

  async function attempt(rel) {
    // "Idle" is measured against OUR OWN clock (`now()`, injectable) from the moment the note
    // became a candidate (noteWritten()/runScan() below) — never the file's real mtime, which a
    // network volume or a clock that does not track `now()` 1:1 (every test here) could disagree
    // with; it is also exactly the timestamp a concurrent write refreshes (noteWritten() bumps it
    // again), so a note edited twice in quick succession always waits the full idle window from
    // its LAST edit, not its first.
    const since = pending.get(rel);
    let n = store.resolve(rel);
    if (!candidate(n)) { pending.delete(rel); return; }
    if (engine.estimateTokens(n.size || 0) <= cfg.thresholdTokens) { pending.delete(rel); return; }
    if (now() - (since || 0) < cfg.idleMinutes * 60000) return; // still being worked on: try later
    if (!cfg.provider) return; // inert without a provider (logged once at start())

    let result = null, lastErrors = null;
    for (let attemptN = 0; attemptN < 2; attemptN++) {
      const prompt = buildPrompt(n, cfg, { retryErrors: attemptN ? lastErrors : null });
      let ai;
      try { ai = await runAi(prompt); } catch (e) { ai = { ok: false, error: e.message }; }
      if (!ai || !ai.ok) { lastErrors = [ai && ai.error ? ai.error : "the AI provider failed"]; continue; }
      let plan;
      try { plan = parsePlan(ai.text); } catch (e) { lastErrors = [e.message]; continue; }
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

module.exports = { createAutoSplitWorker, autoSplitSettings, buildPrompt, parsePlan, outline, underArchive, DEFAULTS, SYSTEM, TARGET_PART_SHARE };
