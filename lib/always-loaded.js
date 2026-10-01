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
const fs = require("fs");
const os = require("os");
const path = require("path");
const { estimateTokens, dayOf, daysBefore } = require("./cost");

const FILE_MAX = 64 * 1024 * 1024; // larger: certainly not an instruction file, not counted
const WINDOW = 7;

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

module.exports = { measureFiles, alwaysLoadedCost, resolveEntry };
