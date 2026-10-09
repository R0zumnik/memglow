"use strict";
/**
 * Single source of truth (0.4.7.1) for the handful of numeric settings that used to be duplicated
 * across lib/config.js, lib/proxy-levers.js, lib/memory-rules.js and lib/cost.js: largeNoteTokens
 * (a note is "too large" above this many tokens), splitChunkTokens (target size of a split's
 * parts) and indexWarningTokens (the index note's own "too large" line). lib/cost.js stays a pure
 * module (no fs) and keeps its OWN copy of these three numbers as the fallback it uses when a
 * caller passes no `opts` at all — but that copy must equal the constants below (checked by a
 * test), so there is still exactly one set of numbers, even though there are two places they are
 * written down.
 *
 * Also the small helpers that:
 *  - resolve memglow.config.json across its two possible locations (resolveConfigFiles), and
 *  - read a saved setup.json's "tuning" section directly (readSavedTuning) — used by the MCP
 *    proxy and memglow's own MCP server, neither of which goes through lib/setup.js's full
 *    read/validate/write pipeline (that one lives in the viewer process only).
 *
 * CONFIG FILE LOCATION (documented in the README): a caller that sets MEMGLOW_CONFIG uses exactly
 * that file, alone — no merge with the other location. Otherwise BOTH locations are read when
 * present: ./memglow.config.json (the current directory) and ~/.memglow/memglow.config.json (the
 * home folder `memglow init` writes to). Keys are merged per TOP-LEVEL key (never deep-merged,
 * same "full replacement" rule every table in this codebase already follows), the project (cwd)
 * file winning whenever both set the same key. A key set to a genuinely different value in both
 * files is reported once in `warnings` (the caller decides what to do with it — usually
 * console.warn); this never throws: an unrelated, stray home file must never stop memglow.
 *
 * SETTINGS PRIORITY (documented in the README): environment variable > Settings page (the value
 * saved in <dataDir>/setup.json) > memglow.config.json > this module's built-in default.
 */
const fs = require("fs");
const path = require("path");

const LARGE_NOTE_TOKENS = 5000; // "too large" threshold, ≈ 20 KB
const SPLIT_CHUNK_TOKENS = 2000; // target size of each part in a split suggestion
const INDEX_WARNING_TOKENS = 2000; // the index note's own "trim me" threshold

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * → { config, file, cwdFile, homeFile, warnings }. See the module comment above for the
 * precedence. `strict`: throws `Error("memglow: cannot parse <file>: …")` when the EXPLICIT
 * (MEMGLOW_CONFIG) or the project (cwd) file exists but fails to parse — never for the home file,
 * and never at all unless `strict` is set (the main viewer wants a loud, early error; the proxy
 * and the MCP server must never throw for a configuration problem).
 */
function resolveConfigFiles({ env = process.env, cwd = process.cwd(), home, strict = false } = {}) {
  home = home || env.MEMGLOW_HOME || path.join(require("os").homedir(), ".memglow");
  const readMaybeStrict = (file) => {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) {
      if (strict) throw new Error(`memglow: cannot parse ${file}: ${e.message}`);
      return null;
    }
  };
  if (env.MEMGLOW_CONFIG) {
    const file = env.MEMGLOW_CONFIG;
    return { config: readMaybeStrict(file) || {}, file, cwdFile: null, homeFile: null, warnings: [] };
  }
  const cwdFile = path.join(cwd, "memglow.config.json");
  const homeFile = path.join(home, "memglow.config.json");
  const fromCwd = readMaybeStrict(cwdFile);
  const fromHome = cwdFile === homeFile ? null : readJsonFile(homeFile); // home file: never thrown
  const warnings = [];
  if (fromCwd && typeof fromCwd === "object" && fromHome && typeof fromHome === "object") {
    for (const k of Object.keys(fromHome)) {
      if (Object.prototype.hasOwnProperty.call(fromCwd, k) && JSON.stringify(fromCwd[k]) !== JSON.stringify(fromHome[k])) {
        warnings.push(`memglow: "${k}" is set differently in ${cwdFile} and ${homeFile}; the project file (${cwdFile}) wins.`);
      }
    }
  }
  const config = { ...(fromHome && typeof fromHome === "object" ? fromHome : {}), ...(fromCwd && typeof fromCwd === "object" ? fromCwd : {}) };
  return {
    config, warnings,
    file: fromCwd ? cwdFile : fromHome ? homeFile : null,
    cwdFile: fromCwd ? cwdFile : null,
    homeFile: fromHome ? homeFile : null,
  };
}

/**
 * One setting, resolved env > page > file > def, each candidate tried in turn (an absent/empty
 * candidate — null, undefined or "" — is skipped, NOT treated as a present-but-invalid value), the
 * first present one clamped to [min,max]; an out-of-range or non-numeric present value falls back
 * straight to `def` (same as the pre-0.4.7.1 behaviour of lib/config.js's own `int()|flag()`
 * helpers — it does not keep trying lower-priority sources).
 */
function resolveInt(envVal, pageVal, fileVal, def, min, max) {
  const present = (v) => v !== undefined && v !== null && v !== "";
  const raw = present(envVal) ? envVal : present(pageVal) ? pageVal : present(fileVal) ? fileVal : undefined;
  if (raw === undefined) return def;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/**
 * One boolean lever, resolved env > page > file > def — same shape and the same "a present but
 * unrecognisable value falls straight to `def`" rule as `resolveInt` above. `envVal` is the raw
 * environment string (e.g. "0"/"false"/"off"/"no" → false, anything else non-empty → true, same
 * as lib/proxy-levers.js's own `flag()`); `pageVal`/`fileVal` are already booleans or undefined.
 */
function resolveBool(envVal, pageVal, fileVal, def) {
  if (envVal != null && envVal !== "") return !/^(0|false|off|no)$/i.test(String(envVal).trim());
  if (typeof pageVal === "boolean") return pageVal;
  if (typeof fileVal === "boolean") return fileVal;
  return def;
}

/**
 * The "tuning" section of <dataDir>/setup.json, read directly — never throws, {} when absent,
 * unreadable or there is no data folder at all. lib/setup.js's own validate() already guarded
 * what got written there; this is a read-only, read-again helper for callers (the MCP proxy, the
 * MCP server) that do not load lib/setup.js at all.
 */
function readSavedTuning(dataDir) {
  if (!dataDir) return {};
  const raw = readJsonFile(path.join(dataDir, "setup.json"));
  return raw && typeof raw === "object" && !Array.isArray(raw) && raw.tuning && typeof raw.tuning === "object" && !Array.isArray(raw.tuning)
    ? raw.tuning : {};
}

/**
 * The "proxy" section of <dataDir>/setup.json (0.4.7.3: lever switches saved from the control
 * panel) — read directly, never throws, {} when absent/unreadable/no dataDir. Read from 0.4.7.2
 * onward even though nothing writes it until 0.4.7.3, so the control panel's "source" column is
 * already correct the moment saving ships.
 */
function readSavedProxy(dataDir) {
  if (!dataDir) return {};
  const raw = readJsonFile(path.join(dataDir, "setup.json"));
  return raw && typeof raw === "object" && !Array.isArray(raw) && raw.proxy && typeof raw.proxy === "object" && !Array.isArray(raw.proxy)
    ? raw.proxy : {};
}

module.exports = {
  LARGE_NOTE_TOKENS, SPLIT_CHUNK_TOKENS, INDEX_WARNING_TOKENS,
  readJsonFile, resolveConfigFiles, resolveInt, resolveBool, readSavedTuning, readSavedProxy,
};
