"use strict";
/**
 * Protected zones — the big groups (top-level themes) the user does not want the assistant to
 * move notes across. Defined by the user, never hard-coded:
 *   - `protectedThemes` in memglow.config.json (theme ids), or
 *   - the first-run screen / Settings of the page, saved in memglow's data folder:
 *       <dataDir>/zones.json = { v: 1, updated: <ms>, protected: [themeId…], labels: { themeId: label } }
 *     Once saved from the page, this file wins over the config file.
 * `labels` only rename the DISPLAY label of a group (legend, Memory cost, prompts): theme ids, and
 * the `theme:` lines of the notes, never change.
 *
 * Effect (checkFiles): the assistant's proposals (lib/assistant) are refused when a file would
 * leave or enter a protected group, when a new file would land in another group than its source,
 * or when the `theme:` frontmatter line of a note in a protected group would change (the archive
 * summary memglow generates and owns is the one exception: isOwnedSummary). The protected
 * groups are also named in the AI's prompt ("never move notes across these groups").
 *
 * NOTHING IS TAKEN ON TRUST (validate): theme ids from the configuration only, labels 1-40
 * characters without control or invisible format characters; anything else is ignored or refused.
 * Atomic write (temporary file, then rename), mode 600. No HTTP here (server.js mounts the routes).
 */
const fs = require("fs");
const path = require("path");

const FILE = "zones.json";
const BODY_MAX = 4096;
const LABEL_MAX = 40;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A display label: trimmed, control and invisible format characters removed, 1-40 characters. */
function cleanLabel(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001F\u007F]|\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return s && s.length <= LABEL_MAX ? s : null;
}

/**
 * A body sent by the page: { protected: [ids], labels: { id: label } }. → validated copy, or null
 * when the shape is wrong (not an object, `protected` not a list, an unknown theme id, a bad label).
 * Strict on purpose: a refused save tells the page, a silently trimmed one would not.
 */
function validate(raw, themeIds) {
  if (!isObject(raw) || !Array.isArray(raw.protected) || raw.protected.length > themeIds.length * 2) return null;
  const ids = new Set(themeIds);
  const prot = [];
  for (const id of raw.protected) {
    if (typeof id !== "string" || !ids.has(id)) return null;
    if (!prot.includes(id)) prot.push(id);
  }
  const labels = {};
  if (own(raw, "labels")) {
    if (!isObject(raw.labels)) return null;
    for (const k of Object.keys(raw.labels)) {
      if (!ids.has(k)) return null;
      const l = cleanLabel(raw.labels[k]);
      if (!l) return null;
      labels[k] = l;
    }
  }
  return { protected: themeIds.filter((t) => prot.includes(t)), labels };
}

/** Saved zones, validated again (a theme removed from the config since then drops out). */
function reread(raw, themeIds) {
  if (!isObject(raw)) return null;
  const ids = new Set(themeIds);
  const prot = Array.isArray(raw.protected) ? themeIds.filter((t) => raw.protected.includes(t)) : [];
  const labels = {};
  if (isObject(raw.labels)) for (const k of Object.keys(raw.labels)) { const l = cleanLabel(raw.labels[k]); if (ids.has(k) && l) labels[k] = l; }
  return { protected: prot, labels, updated: Number.isFinite(raw.updated) ? raw.updated : 0 };
}

/** Read-only view of the zones (memglow-mcp, tests): saved file, else config, else not defined. */
function readZones(dataDir, config) {
  const themeIds = (config.themes || []).map((t) => t.id);
  if (dataDir) {
    try {
      const v = reread(JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")), themeIds);
      if (v) return { defined: true, source: "saved", protected: v.protected, labels: v.labels };
    } catch { /* absent or unreadable: fall back */ }
  }
  if (Array.isArray(config.protectedThemes)) return { defined: true, source: "config", protected: config.protectedThemes.filter((t) => themeIds.includes(t)), labels: {} };
  return { defined: false, source: "none", protected: [], labels: {} };
}

/**
 * The zone store of the viewer. `dir` null: kept in memory only. Writes are rate limited
 * (`burst` writes, one more every `refillMs`).
 */
function createZoneStore({ dir, config, burst = 10, refillMs = 3000, now = Date.now } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  const themeIds = (config.themes || []).map((t) => t.id);
  let inMemory = null;
  let warned = false;
  const bucket = { tokens: burst, t: now() };

  function read() {
    if (inMemory && !file) return { defined: true, source: "saved", protected: inMemory.protected, labels: inMemory.labels };
    const z = readZones(dir, config);
    if (z.source !== "saved" && inMemory) return { defined: true, source: "saved", protected: inMemory.protected, labels: inMemory.labels };
    return z;
  }
  return {
    read,
    /** Theme ids protected now. */
    protectedIds() { return read().protected; },
    /** Display labels: the configured ones, overridden by the saved ones. */
    themes() {
      const labels = read().labels;
      return (config.themes || []).map((t) => ({ ...t, label: labels[t.id] || t.label }));
    },
    rateOk(t = now()) {
      const gained = Math.floor((t - bucket.t) / refillMs);
      if (gained > 0) { bucket.tokens = Math.min(burst, bucket.tokens + gained); bucket.t += gained * refillMs; }
      if (bucket.tokens >= burst) bucket.t = t;
      if (bucket.tokens <= 0) return false;
      bucket.tokens--;
      return true;
    },
    /** Validates and saves a parsed body. → the saved zones, or null when refused. */
    write(body, t = now()) {
      const v = validate(body, themeIds);
      if (!v) return null;
      const out = { v: 1, updated: t, protected: v.protected, labels: v.labels };
      inMemory = out;
      if (file) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (e) {
          if (!warned) { warned = true; console.warn(`memglow: protected groups: cannot write in ${dir} (${e.message}); kept in memory only`); }
        }
      }
      return out;
    },
    file,
  };
}

/** The `theme:` line(s) of a file's frontmatter, verbatim ("" when none). */
function themeLines(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!m) return "";
  return m[1].split(/\r?\n/).filter((l) => /^\s*theme\s*:/.test(l)).join("\n");
}

/**
 * The archive summary memglow generates (lib/archive.js planArchive) is a file memglow owns, not
 * user content: the protected groups do not apply to it. It has no group of its own and, without an
 * `archive` theme, falls in `defaultTheme`, which may be protected — that used to refuse every
 * archive. All of these are required: the plan built by memglow's own code marks it (`owner:
 * "memglow"`, `role: "summary"` — the AI never builds file objects, only text), it is created or
 * modified (never deleted), and its frontmatter carries the summary flag after, and before when it
 * already existed. A file that merely writes the flag in its text, or any other role, is checked
 * like every other file.
 */
function isOwnedSummary(f) {
  if (!f || f.owner !== "memglow" || f.role !== "summary") return false;
  if (f.kind !== "create" && f.kind !== "modify") return false;
  const { SUMMARY_FLAG, splitFrontmatter } = require("./archive"); // lazy: archive.js loads memory.js
  const flagged = (text) => typeof text === "string" && splitFrontmatter(text).fm.split(/\r?\n/).some((l) => l.trim() === SUMMARY_FLAG);
  if (!flagged(f.after)) return false;
  return f.kind === "create" ? f.before == null : flagged(f.before);
}

/**
 * Checks the files of a proposal against the protected groups. → [error messages] (empty = ok).
 *   files    : [{ rel, kind: "create" | "modify" | "delete", before, after, source? }]
 *              `source` (for a created file) = the theme it must stay in (the note it comes from).
 *   resolver : lib/memory.js themeResolver(config)
 *   protect  : iterable of protected theme ids
 *   name     : theme id → display label
 */
function checkFiles(files, { resolver, protect, name = (t) => t }) {
  const zone = new Set(protect || []);
  const errors = [];
  if (!zone.size) return errors;
  const z = (t) => zone.has(t);
  for (const f of files || []) {
    if (isOwnedSummary(f)) continue;
    const before = f.before != null ? resolver.themeOfText(f.rel, f.before) : null;
    const after = f.after != null ? resolver.themeOfText(f.rel, f.after) : null;
    if (f.kind === "create") {
      const from = f.source || null;
      if (from && after !== from && (z(from) || z(after))) {
        errors.push(`${f.rel} would be created in the group "${name(after)}" instead of "${name(from)}" — "${name(z(from) ? from : after)}" is a protected group`);
      } else if (!from && z(after)) {
        errors.push(`${f.rel} would be added to the protected group "${name(after)}" from outside it`);
      }
    } else if (f.kind === "modify") {
      if (before !== after && (z(before) || z(after))) {
        errors.push(`${f.rel} would move from the group "${name(before)}" to "${name(after)}" — protected groups never change`);
      } else if (z(before) && themeLines(f.before) !== themeLines(f.after)) {
        errors.push(`${f.rel}: the "theme" line of a note in the protected group "${name(before)}" must not change`);
      }
    } else if (f.kind === "delete") {
      const dest = f.movedTo ? (files.find((x) => x.rel === f.movedTo && x.kind === "create") || null) : null;
      const destTheme = dest ? resolver.themeOfText(dest.rel, dest.after) : null;
      if (!dest) errors.push(`${f.rel} would be removed — notes are never deleted`);
      else if (destTheme !== before && (z(before) || z(destTheme))) errors.push(`${f.rel} would move out of the protected group "${name(z(before) ? before : destTheme)}"`);
    }
  }
  return errors;
}

/** One line for the AI's prompt, or "" when no group is protected. */
function promptLine(protect, name = (t) => t) {
  const list = [...(protect || [])];
  if (!list.length) return "";
  return "Protected groups (never move notes across these groups, never create a note in another group, never change their `theme`): " + list.map(name).join(", ") + ".";
}

/**
 * What the first-run screen shows: every configured theme with its note count and the top-level
 * folders its notes live in (from the scan; names of folders and counts only).
 */
function overview(config, notes, labels = {}) {
  return (config.themes || []).map((t) => {
    const mine = (notes || []).filter((n) => n.theme === t.id);
    const folders = [...new Set(mine.map((n) => String(n.folder || "").split("/")[0]).filter(Boolean))].sort().slice(0, 8);
    return { id: t.id, label: labels[t.id] || t.label, defaultLabel: t.label, color: t.color, notes: mine.length, folders };
  });
}

module.exports = { isOwnedSummary, FILE, BODY_MAX, validate, reread, readZones, createZoneStore, checkFiles, promptLine, overview, themeLines, cleanLabel };
