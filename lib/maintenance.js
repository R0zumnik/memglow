"use strict";
/**
 * Scheduled maintenance proposals (0.4.4.3) — memglow never applies maintenance by itself. This
 * module only DETECTS opportunities already governed by their own deterministic tiers:
 *
 *   archive    dormant sections (lib/archive.js detectDormant)
 *   split      notes above `largeNoteTokens`, with the split_plan packing as a hint
 *   indexTrim  the index-trim plan summary (lib/index-trim.js), only when it saves enough tokens
 *
 * computeMaintenance() is read-only with respect to the notes: it never writes one, and never
 * calls anything in lib/assistant. It is NOT read-only with respect to memglow's own data folder —
 * exactly like server.js's own archive detection, it advances the archive tier's section log
 * (<dataDir>/section-ages.json) so "edited within the window" stays accurate over time. Turning a
 * listed item into an actual change still goes through the normal assistant pipeline (propose →
 * diff → confirm token → backup → atomic apply → undo): a maintenance item only carries what that
 * pipeline needs to start (its `kind` and `target`), never a file content.
 *
 * Ids are STABLE: a hash of kind + target, so the same opportunity always gets the same id and a
 * dismissed item (createMaintenanceStore below) stays dismissed across rescans, even though the
 * ranking or the exact wording of "why" may change from one scan to the next.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { estimateTokens, sectionsOf, packSections } = require("./cost");
const { createCounters } = require("./counters");
const archiveLib = require("./archive");
const indexTrimLib = require("./index-trim");

const FILE = "maintenance.json";
const DISMISSED_FILE = "maintenance-dismissed.json";
const DEFAULT_EVERY_HOURS = 24;
const MIN_INDEX_TRIM_GAIN = 20;  // tokens/session: below this, not worth a maintenance item
const DISMISSED_MAX = 500;       // oldest dropped first (a data folder, never unbounded)

function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }
/** A hash of kind + target — see module doc. 16 hex characters, the same shape as lib/archive.js's own section keys. */
function itemId(kind, target) { return kind + "-" + sha1(kind + "\0" + String(target)).slice(0, 16); }

function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeJsonAtomic(dir, file, obj) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Detection — read only with respect to the notes. By default (readOnly: false, the scheduler's
// own use) it may also advance <dataDir>/section-ages.json, exactly like server.js's own archive
// detection already does — memglow's own bookkeeping, never a note. A caller that must never touch
// the data folder either (mcp-server's read-only tool) passes readOnly: true: dormancy then falls
// back to note-level precision (no section log), still correct, just slightly more conservative.

/** archive: one item per dormant section (lib/archive.js detectDormant), target = the section's key. */
function archiveItems({ memory, config, dataDir, now, readOnly }) {
  const notes = memory.costNotes();
  let sectionLog = null;
  if (!readOnly) {
    sectionLog = archiveLib.createSectionLog({ dir: dataDir, now: () => now });
    for (const n of notes) sectionLog.observe(n.id, memory.rawBody ? memory.rawBody(n.id) : null);
    sectionLog.keep(new Set(notes.map((n) => n.id)));
    sectionLog.flush();
  }
  // Activity counters live in the same data folder (never re-threaded through the caller): without
  // one (a fresh install, or no data folder at all) `started` stays null and detectDormant honestly
  // answers "not enough data yet" — exactly as server.js's own archive detection would. Reading them
  // never writes: `.add()`/`.flush()` are never called here.
  const counters = createCounters({ dir: dataDir, now: () => now });
  let rep;
  try {
    rep = archiveLib.detectDormant({
      notes, last: counters.last(), started: counters.started(), now, settings: config.archive, sectionLog,
      readBody: (id) => (memory.rawBody ? memory.rawBody(id) : null), withTitles: true,
    });
  } catch { rep = null; }
  if (!rep || !rep.available) return [];
  const out = [];
  for (const s of rep.sections) {
    const gainTokens = Math.max(0, s.tokens - (s.stubTokens || 0));
    const title = s.title ? `Archive "${s.title}" (from "${s.label}")` : `Archive a dormant section of "${s.label}"`;
    const why = s.lastRead || s.lastSearch
      ? `Not read or searched since ${s.lastRead || s.lastSearch}, not edited in ${rep.afterDays} days.`
      : `Not read, searched or edited since counting began, ${rep.afterDays}+ days ago.`;
    out.push({ id: itemId("archive", s.key), kind: "archive", title, why, gainTokens, target: s.key });
  }
  return out;
}

/** split: notes above config.largeNoteTokens, the split_plan packing (lib/cost.js) as the hint. */
function splitItems({ memory, config }) {
  const large = config.largeNoteTokens;
  const chunk = config.splitChunkTokens;
  const out = [];
  for (const n of memory.costNotes()) {
    const tokens = Math.ceil((n.bytes || 0) / 4);
    if (n.theme === "index" || tokens <= large) continue;
    let hint = "";
    const body = memory.maskedBody ? memory.maskedBody(n.id) : null;
    if (body != null) {
      const parts = packSections(sectionsOf(body), chunk);
      hint = ` split_plan suggests ${parts.length} part(s) of ≈${chunk} tokens each.`;
    }
    const over = tokens - large;
    out.push({
      id: itemId("split", n.id), kind: "split", title: `Split "${n.label}" (≈${tokens} tokens)`,
      why: `≈${over} tokens over the ${large}-token threshold.${hint}`, gainTokens: over, target: n.id,
    });
  }
  return out;
}

/** indexTrim: the index note's trim plan (lib/index-trim.js), only when it saves enough tokens. */
function indexTrimItems({ memory, config }) {
  const idx = memory.costNotes().find((n) => n.theme === "index");
  if (!idx || !idx.rel) return [];
  let indexText;
  try { indexText = fs.readFileSync(path.join(config.memoryDir, idx.rel), "utf8"); } catch { return []; }
  const archiveFolder = (config.archive && config.archive.folder) || "archive";
  const notes = [];
  for (const id of indexTrimLib.candidateTargets(indexText)) {
    const r = memory.fileOf(id);
    if (!r || r === idx.rel || r.startsWith(archiveFolder + "/")) continue;
    let text;
    try { text = fs.readFileSync(path.join(config.memoryDir, r), "utf8"); } catch { continue; }
    notes.push({ id, rel: r, text });
  }
  const maxChars = config.indexTrimMaxChars || indexTrimLib.DEFAULT_MAX_CHARS;
  const plan = indexTrimLib.planIndexTrim({ indexText, notes, maxChars });
  const saved = Math.max(0, plan.tokensBefore - plan.tokensAfter);
  if (!plan.lines.length || saved < MIN_INDEX_TRIM_GAIN) return [];
  return [{
    id: itemId("indexTrim", idx.id), kind: "indexTrim",
    title: `Trim the memory index (${idx.label})`,
    why: `${plan.lines.length} index line(s) could be shortened; loaded at every session.`,
    gainTokens: saved, target: idx.id,
  }];
}

/**
 * computeMaintenance({ memory, config, dataDir, now, readOnly }) → { generatedAt, items }
 *   items: [{ id, kind: "archive"|"split"|"indexTrim", title, why, gainTokens, target }], ranked by
 *   gainTokens (ties broken by id, so the order is always the same for the same inputs).
 * Never writes a note. Reads memglow's own activity counters straight from `dataDir` (so the
 * caller never has to thread them through) — without any (a fresh install, or no data folder),
 * the archive tier simply has "not enough data yet" and contributes no item. `readOnly: true`
 * (mcp-server's read-only tool) additionally guarantees the data folder itself is never touched.
 */
function computeMaintenance({ memory, config, dataDir, now = Date.now(), readOnly = false } = {}) {
  const items = [
    ...archiveItems({ memory, config, dataDir, now, readOnly }),
    ...splitItems({ memory, config }),
    ...indexTrimItems({ memory, config }),
  ];
  items.sort((a, b) => b.gainTokens - a.gainTokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { generatedAt: now, items };
}

// ---------------------------------------------------------------------------------------------
// Persistence — <dataDir>/maintenance.json (the latest scan, dismissed items already removed) and
// <dataDir>/maintenance-dismissed.json (ids dismissed from the page, kept forever — until the data
// folder is cleared — so a rescan never brings one back).

/** createMaintenanceStore({ dir }) → { read(), write(result), dismiss(id), dismissedIds(), file, dismissedFile } */
function createMaintenanceStore({ dir } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  const dismissedFile = dir ? path.join(dir, DISMISSED_FILE) : null;
  let cached = { generatedAt: null, items: [] };
  let dismissed = {}; // id -> ms dismissed at
  if (file) { const raw = readJsonFile(file); if (raw && Array.isArray(raw.items)) cached = { generatedAt: raw.generatedAt || null, items: raw.items }; }
  if (dismissedFile) { const raw = readJsonFile(dismissedFile); if (raw && raw.ids && typeof raw.ids === "object") dismissed = raw.ids; }

  function saveDismissed() { if (dir) writeJsonAtomic(dir, dismissedFile, { version: 1, ids: dismissed }); }

  return {
    read() { return cached; },
    dismissedIds() { return new Set(Object.keys(dismissed)); },
    /** Stores a freshly computed result, with every already-dismissed id filtered out. */
    write(result) {
      const keep = result.items.filter((i) => !Object.prototype.hasOwnProperty.call(dismissed, i.id));
      cached = { generatedAt: result.generatedAt, items: keep };
      if (dir) writeJsonAtomic(dir, file, cached);
      return cached;
    },
    /** Marks `id` dismissed: persists it, and drops it from the cached result right away. */
    dismiss(id, now = Date.now()) {
      dismissed[id] = now;
      const keys = Object.keys(dismissed);
      if (keys.length > DISMISSED_MAX) {
        keys.sort((a, b) => dismissed[a] - dismissed[b]);
        for (const k of keys.slice(0, keys.length - DISMISSED_MAX)) delete dismissed[k];
      }
      saveDismissed();
      if (cached.items.some((i) => i.id === id)) {
        cached = { ...cached, items: cached.items.filter((i) => i.id !== id) };
        if (dir) writeJsonAtomic(dir, file, cached);
      }
      return cached;
    },
    file, dismissedFile,
  };
}

// ---------------------------------------------------------------------------------------------
// Scheduler — at start, then every `everyHours` (0 = no repeat, but the start-up scan still runs).
// `setInterval`/`clearInterval` are injectable so tests can drive it without a real timer.

function createScheduler({ memory, config, dataDir, everyHours, store, now = Date.now, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let timer = null;
  function runOnce() {
    let result;
    try { result = computeMaintenance({ memory, config, dataDir, now: now() }); }
    catch (e) { log("maintenance scan failed: " + e.message); return store ? store.read() : null; }
    const saved = store ? store.write(result, now()) : result;
    log(`scan: ${result.items.length} item(s)` + (saved && saved.items.length !== result.items.length ? ` (${saved.items.length} after dismissed)` : ""));
    return saved;
  }
  function start() {
    runOnce();
    const ms = Number(everyHours) > 0 ? Number(everyHours) * 3600 * 1000 : 0;
    if (ms > 0) {
      timer = setIntervalFn(runOnce, ms);
      if (timer && timer.unref) timer.unref();
    }
  }
  function stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } }
  return { start, stop, runOnce };
}

module.exports = {
  computeMaintenance, createMaintenanceStore, createScheduler, itemId,
  FILE, DISMISSED_FILE, DEFAULT_EVERY_HOURS, MIN_INDEX_TRIM_GAIN,
};
