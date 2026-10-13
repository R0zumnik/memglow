"use strict";
/**
 * MCP proxy levers — control panel (0.4.12.4 split of lib/proxy-levers.js, see that file's own
 * top comment for the full picture). A read-only, resolved view of every lever's current value,
 * where it comes from, and whether an environment variable locks it — same values proxyConfig()
 * (lib/levers/config.js) resolves, for Settings → Control.
 */
const os = require("os");
const path = require("path");
const defaultsLib = require("../defaults");
const { proxyConfig } = require("./config");

// ---------------------------------------------------------------------------------------------
// Control panel (0.4.7.2+): a read-only, then (0.4.7.3) writable view of the lever booleans for
// Settings → Control. `day1: true` = shown first, outside the "Advanced" section (sizeWarning,
// multiQuery, aliases, learnAliases, indexWarning — see the task's own "day-one levers" list).
// Help text for each lever is an i18n key (public/control.js), never hard-coded English here.
const LEVER_META = [
  { key: "sizeWarning", env: "MEMGLOW_PROXY_SIZE_WARNING", day1: true },
  { key: "multiQuery", env: "MEMGLOW_PROXY_MULTI_QUERY", day1: true },
  { key: "aliases", env: "MEMGLOW_PROXY_ALIASES", day1: true },
  { key: "learnAliases", env: "MEMGLOW_PROXY_LEARN_ALIASES", day1: true },
  { key: "indexWarning", env: "MEMGLOW_PROXY_INDEX_WARNING", day1: true },
  { key: "searchDetails", env: "MEMGLOW_PROXY_SEARCH_DETAILS" },
  { key: "suggestions", env: "MEMGLOW_PROXY_SUGGESTIONS" },
  { key: "dedupe", env: "MEMGLOW_PROXY_DEDUPE" },
  { key: "toc", env: "MEMGLOW_PROXY_TOC" },
  { key: "archiveHint", env: "MEMGLOW_PROXY_ARCHIVE_HINT" },
  { key: "hideUnsupportedTools", env: "MEMGLOW_PROXY_HIDE_UNSUPPORTED" },
  { key: "alreadyLoaded", env: "MEMGLOW_PROXY_ALREADY_LOADED" },
  { key: "negativeCache", env: "MEMGLOW_PROXY_NEGATIVE_CACHE" },
  { key: "indexHint", env: "MEMGLOW_PROXY_INDEX_HINT" },
  { key: "deltaRead", env: "MEMGLOW_PROXY_DELTA_READ" },
  { key: "duplicateHint", env: "MEMGLOW_PROXY_DUPLICATE_HINT" },
  { key: "slugHint", env: "MEMGLOW_PROXY_SLUG_HINT" },
  { key: "hubHint", env: "MEMGLOW_PROXY_HUB_HINT" },
  { key: "stateView", env: "MEMGLOW_PROXY_STATE_VIEW" },
];
// A few integer caps, read-only even once 0.4.7.3 ships the lever switches (never a free-form
// table like unsupportedTools/readTools — those stay out of the UI per the task's own exclusion
// list). `tuningKey`: the matching key in <dataDir>/setup.json's "tuning" section, once one
// exists (0.4.7.1 for largeNoteTokens, 0.4.7.4 for indexWarningTokens) — enables the "page" source.
const LEVER_INT_CAPS = [
  { key: "indexWarningTokens", tuningKey: "indexWarningTokens", min: 100, max: 1000000 },
  { key: "largeNoteTokens", tuningKey: "largeNoteTokens", min: 200, max: 1000000, env: "MEMGLOW_LARGE_NOTE_TOKENS" },
];

/**
 * Settings → Control, "Économies de jetons" (Token savings): the levers' current value, where it
 * comes from (env / page / file / default) and whether an environment variable locks it — without
 * re-parsing memglow.config.json/setup.json a second, differently, time: the exact SAME resolved
 * values as `proxyConfig()` above (so what the panel shows a running proxy started with this same
 * environment would use), plus a `source` computed the same env > page > file > default way.
 * `page` = the "proxy" section of <dataDir>/setup.json (0.4.7.3, lib/defaults.js readSavedProxy;
 * read from 0.4.7.2 onward even though nothing can write it yet, so "source" is already right the
 * moment saving ships). Never throws.
 */
function proxyControl(env = process.env, cwd = process.cwd()) {
  const full = proxyConfig(env, cwd);
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  // Same trust boundary as proxyConfig() above: never a cwd file, so "source: file" here can
  // never point at a value this function's own `full` (proxyConfig()) would not actually use.
  const { config: cfg } = defaultsLib.resolveConfigFiles({ env, cwd, home, allowCwd: false });
  const p = cfg.proxy && typeof cfg.proxy === "object" ? cfg.proxy : {};
  const base = defaultsLib.resolveBase(env, cwd); // minor 4 (0.4.7.6): one shared rule
  const dataDir = path.resolve(base, env.MEMGLOW_DATA_DIR || cfg.dataDir || home);
  const savedProxy = defaultsLib.readSavedProxy(dataDir);
  const savedTuning = defaultsLib.readSavedTuning(dataDir);
  const present = (v) => v != null && v !== "";
  const levers = LEVER_META.map((m) => {
    const envLocked = !!(m.env && present(env[m.env]));
    const source = envLocked ? "env" : typeof savedProxy[m.key] === "boolean" ? "page" : typeof p[m.key] === "boolean" ? "file" : "default";
    // Minor 3 (0.4.7.6): the env var's own NAME, so the "Locked by …" badge has something after
    // it — envLocked is only ever true when `m.env` is set, but the field is returned regardless.
    return { key: m.key, value: !!full[m.key], source, envLocked, env: m.env || "", day1: !!m.day1 };
  });
  const caps = LEVER_INT_CAPS.map((c) => {
    const envLocked = !!(c.env && present(env[c.env]));
    const source = envLocked ? "env" : typeof savedTuning[c.tuningKey] === "number" ? "page" : typeof cfg[c.tuningKey] === "number" ? "file" : "default";
    return { key: c.key, value: full[c.key], source, envLocked, env: c.env || "", min: c.min, max: c.max };
  });
  return { levers, caps, dataDir };
}



module.exports = { LEVER_META, LEVER_INT_CAPS, proxyControl };
