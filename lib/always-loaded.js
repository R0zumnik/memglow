"use strict";
/**
 * Always-loaded cost — what an assistant receives at EVERY session before doing anything: the
 * memory's index note, and instruction files such as CLAUDE.md or AGENTS.md (paths listed by the
 * user in `alwaysLoaded`).
 *
 * measureFiles() only STATS the files: their content is never read, never sent anywhere. The page
 * gets the path as the user wrote it in the config file, found or not, and ≈ tokens (bytes ÷ 4).
 *
 * alwaysLoadedCost() is pure:
 *   per session  = index note(s) + every file found
 *   sessions/day = average number of index-note reads per day, over the days of the last 7 that
 *                  have at least one (an assistant reads the index once per session); when no read
 *                  of the index was counted, the `sessionsPerDay` setting (default 5)
 *   per day      = per session × sessions/day
 * Tips: index above `indexWarningTokens` → "trim the index"; an instruction file above the same
 * size → "trim <file>".
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { estimateTokens, dayOf, daysBefore } = require("./cost");

const FILE_MAX = 64 * 1024 * 1024; // larger: certainly not an instruction file, not counted
const WINDOW = 7;
const PREFIX_HISTORY_FILE = "prefix-history.json";
const PREFIX_HISTORY_MAX_ENTRIES = 400; // one row per actual change: 400 easily covers 30 days
const PREFIX_TIP_THRESHOLD = 3; // changes/week at or above this get the caching tip
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Absolute path of a configured entry ("~" = home folder, relative = from `cwd`). */
function resolveEntry(entry, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const s = String(entry || "").trim();
  if (!s) return null;
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(home, s.slice(2));
  return path.resolve(cwd, s);
}

/** [{ name, found, tokens }] — stat only. `name` is the entry as configured (shortened). */
function measureFiles(entries, opts = {}) {
  const out = [];
  for (const e of entries || []) {
    const name = String(e).length > 80 ? "…" + String(e).slice(-79) : String(e);
    const abs = resolveEntry(e, opts);
    let st = null;
    try { st = abs ? fs.statSync(abs) : null; } catch { st = null; }
    if (!st || !st.isFile() || st.size > FILE_MAX) out.push({ name, found: false, tokens: 0 });
    else out.push({ name, found: true, tokens: estimateTokens(st.size) });
  }
  return out;
}

/**
 * alwaysLoadedCost({ index: [{ id, label, tokens }], files, days, now, sessionsPerDay, indexWarningTokens })
 */
function alwaysLoadedCost({ index = [], files = [], days = null, now = Date.now(), sessionsPerDay = 5, indexWarningTokens = 2000 } = {}) {
  const idx = (index || []).map((n) => ({ id: n.id, label: n.label, tokens: n.tokens || 0 }));
  const indexTokens = idx.reduce((s, n) => s + n.tokens, 0);
  const found = (files || []).filter((f) => f.found);
  const filesTokens = found.reduce((s, f) => s + (f.tokens || 0), 0);
  const perSession = indexTokens + filesTokens;

  // Sessions per day from the counters: index reads on the days that have some.
  let estimated = null;
  if (days && typeof days === "object" && idx.length) {
    const ids = new Set(idx.map((n) => n.id));
    const today = dayOf(now), from = daysBefore(now, WINDOW - 1);
    let total = 0, active = 0;
    for (const [day, o] of Object.entries(days)) {
      if (day < from || day > today || !o || !o.notes) continue;
      let r = 0;
      for (const [id, c] of Object.entries(o.notes)) if (ids.has(id) && c) r += c.read || 0;
      if (r > 0) { total += r; active++; }
    }
    if (active) estimated = Math.max(1, Math.round((total / active) * 10) / 10);
  }
  const perDayCount = estimated != null ? estimated : sessionsPerDay;

  const tips = [];
  if (indexTokens > indexWarningTokens) tips.push({ kind: "index", tokens: indexTokens, threshold: indexWarningTokens, text: `Trim the index: ≈ ${indexTokens} tokens are loaded at every session (tip threshold ${indexWarningTokens}). Keep one short line per note and move details into the notes.` });
  for (const f of found) if (f.tokens > indexWarningTokens) tips.push({ kind: "file", name: f.name, tokens: f.tokens, threshold: indexWarningTokens, text: `Trim ${f.name}: ≈ ${f.tokens} tokens at every session. Move rarely needed instructions into notes the assistant reads on demand.` });

  return {
    index: idx,
    indexTokens,
    files: files || [],
    filesTokens,
    perSession,
    sessionsPerDay: perDayCount,
    sessionsSource: estimated != null ? "index reads" : "setting",
    perDay: Math.round(perSession * perDayCount),
    indexWarningTokens,
    tips,
  };
}

// ---------------------------------------------------------------------------------------------
// Cache-stable always-loaded prefix (0.4.4.4) — the part of every session's first prompt that
// NEVER changes unless the memory's own index or memglow's built-in memory rules do: the index
// note's text and the rendered memory-rules text (lib/memory-rules.js's buildRulesText, same
// bytes for the same config — no dates, no unordered object iteration). An unchanged literal
// prefix is what lets an LLM provider's prompt cache actually hit; a one-line index edit at the
// end of a long index invalidates it just as much as a rewrite of the whole thing, so what is
// tracked here is not "how big" but "how often it changes".

/** A stable hash of the prefix (index text + rendered rules text), hex, 16 characters. */
function prefixHash(indexText, rulesText) {
  return crypto.createHash("sha256").update(String(indexText || "") + "\u0000" + String(rulesText || "")).digest("hex").slice(0, 16);
}

/**
 * createPrefixHistory({ dir, now }) — <dataDir>/prefix-history.json = { version: 1, entries: [{
 * day, hash }] }. Only CHANGES are logged (a call with the same hash as the last entry is a no-op):
 * the list is therefore already "how many times it changed", read straight off its length within a
 * window. The very first entry ever written is a bootstrap (there was no previous prefix to change
 * from), so it never counts towards changesLast7d/changesLast30d.
 */
function createPrefixHistory({ dir, now = Date.now } = {}) {
  const file = dir ? path.join(dir, PREFIX_HISTORY_FILE) : null;
  let entries = [];
  let warned = false;
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && Array.isArray(raw.entries)) {
        entries = raw.entries.filter((e) => e && DAY_RE.test(String(e.day)) && typeof e.hash === "string" && /^[0-9a-f]{1,32}$/.test(e.hash));
      }
    } catch (e) {
      if (e.code !== "ENOENT") console.warn(`memglow: always-loaded prefix history: cannot read ${file} (${e.message}); starting over`);
    }
  }
  function save() {
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!warned) { warned = true; console.warn(`memglow: always-loaded prefix history: cannot write in ${dir} (${e.message})`); }
    }
  }
  return {
    /** Records the prefix's current hash; a no-op unless it differs from the last recorded one. */
    record(hash) {
      const last = entries[entries.length - 1];
      if (last && last.hash === hash) return;
      entries.push({ day: dayOf(now()), hash });
      if (entries.length > PREFIX_HISTORY_MAX_ENTRIES) entries = entries.slice(-PREFIX_HISTORY_MAX_ENTRIES);
      save();
    },
    /** { changesLast7d, changesLast30d } — the bootstrap entry (if still the only one) never counts. */
    summary(nowMs = now()) {
      const changed = entries.slice(1); // every entry after the first is an actual change
      const from7 = daysBefore(nowMs, WINDOW - 1), from30 = daysBefore(nowMs, 29);
      return {
        changesLast7d: changed.filter((e) => e.day >= from7 && e.day <= dayOf(nowMs)).length,
        changesLast30d: changed.filter((e) => e.day >= from30 && e.day <= dayOf(nowMs)).length,
      };
    },
    file,
  };
}

/**
 * prefixStatus({ dataDir, indexText, rulesText, now }) → { hash, changesLast7d, changesLast30d, tip }
 * Records this call's hash (createPrefixHistory above) and reports how often the prefix actually
 * changed recently. `tip` is "" unless it changed often (>= PREFIX_TIP_THRESHOLD times this week).
 */
function prefixStatus({ dataDir, indexText, rulesText, now = Date.now } = {}) {
  const hash = prefixHash(indexText, rulesText);
  const hist = createPrefixHistory({ dir: dataDir, now });
  hist.record(hash);
  const { changesLast7d, changesLast30d } = hist.summary(now());
  const tip = changesLast7d >= PREFIX_TIP_THRESHOLD
    ? `The always-loaded prefix changed ${changesLast7d} times this week; every change invalidates prompt caching (cached input costs ≈0.1×). Batch index edits.`
    : "";
  return { hash, changesLast7d, changesLast30d, tip };
}

/**
 * Share of `before` that is still the literal, unbroken START of `after` (0..1; 1 when identical).
 * A prompt cache keys off the longest unchanged prefix, so this is the practical measure of "how
 * cache-friendly was this edit" between two scans of the same always-loaded text — not a diff size.
 */
function shareStable(before, after) {
  const a = String(before == null ? "" : before);
  const b = String(after == null ? "" : after);
  if (!a.length) return a === b ? 1 : 0;
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  return i / a.length;
}

module.exports = { measureFiles, alwaysLoadedCost, resolveEntry, prefixHash, createPrefixHistory, prefixStatus, shareStable, PREFIX_TIP_THRESHOLD };
