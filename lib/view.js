"use strict";
/**
 * The saved view of this memglow instance: settings, graph layout (bubble positions, pinned
 * bubbles) and camera. memglow has one user per instance, so there is ONE view, shared by every
 * browser and device that opens the instance: reopen it elsewhere and you get the same picture.
 *
 * Stored in memglow's own data folder (never in MEMORY_DIR, which memglow only reads):
 *   <dataDir>/view.json = { v: 1, updated: <ms>, settings: {…}, positions: { id: [x, y, z] },
 *                           pinned: [ids], camera: { position: [x, y, z], target: [x, y, z] } | null }
 * Atomic write (temporary file, then rename). An unreadable file is an empty view: this is comfort,
 * not access control, and the next save overwrites it.
 *
 * NOTHING IS TAKEN ON TRUST (validateUpdate): a closed list of settings with types and bounds (the
 * ones of public/app.js, see VIEW_SETTINGS there); positions are finite bounded numbers for notes
 * that EXIST or sub-theme bubbles with a strict id pattern, 2000 at most; pinned ⊆ positions;
 * camera = finite bounded numbers. Anything else, `__proto__` included, is ignored. Every value is
 * rebuilt, never written back as received.
 *
 * No HTTP here (server.js mounts GET/PUT /api/view).
 */
const fs = require("fs");
const path = require("path");

const FILE = "view.json";
const MAX_POSITIONS = 2000;
const BOUND = 100000;          // scene coordinates: the graph fits in a few thousand units
const BODY_MAX = 256 * 1024;   // bytes of a PUT body

// Settings accepted: exactly those of the Settings panel (public/app.js, VIEW_SETTINGS).
const SETTINGS = {
  spread: { type: "number", min: 1, max: 30 },
  gravity: { type: "number", min: 0, max: 10 },
  spacing: { type: "number", min: 0, max: 20 },
  bubbleSize: { type: "number", min: 0.5, max: 3 },
  signalSpeed: { type: "number", min: 0.3, max: 2 },
  nameDistance: { type: "number", min: 1, max: 20 },
  glow: { type: "number", min: 0, max: 2 },
  sizeBy: { type: "choice", values: ["links", "tokens"] },
  background: { type: "choice", values: ["deep", "plain", "night", "light"] },
  linksAtRest: { type: "choice", values: ["hidden", "subtle", "visible"] },
  names: { type: "choice", values: ["none", "active", "all"] },
  autoRotate: { type: "bool" },
  ambientFlow: { type: "bool" },
  groupByTheme: { type: "bool" },
  subThemes: { type: "bool" },
  keepDragged: { type: "bool" },
  followActivity: { type: "bool" },
  hiddenThemes: { type: "themes" },
};
const NOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const round = (x) => Math.round(x * 100) / 100;

/** A finite number within ±BOUND, rounded to 0.01; otherwise null. */
function coord(v) {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= BOUND ? round(v) : null;
}
/** A valid [x, y, z], or null. */
function triple(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const t = v.map(coord);
  return t.every((x) => x !== null) ? t : null;
}

/**
 * Rules that depend on the configuration: theme ids (for hidden themes and sub-theme bubble ids)
 * and a note-existence check. `themeIds` come from lib/config.js (already /^[a-z0-9][a-z0-9-]*$/).
 */
function createRules({ themeIds = [], noteExists = () => false } = {}) {
  const themes = themeIds.filter((t) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(t));
  const hideable = themes.concat(["index", "other"]);
  const relayRe = themes.length ? new RegExp("^~(" + themes.join("|") + ")/[a-z0-9][a-z0-9-]{0,40}$") : /^(?!)/;
  return { hideable, relayRe, noteExists };
}

/** Settings: closed list, types and bounds; any other key or value is ignored. */
function validateSettings(raw, rules) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const k of Object.keys(SETTINGS)) {
    if (!own(raw, k)) continue;
    const def = SETTINGS[k], v = raw[k];
    if (def.type === "number") {
      if (typeof v === "number" && Number.isFinite(v) && v >= def.min && v <= def.max) out[k] = round(v);
    } else if (def.type === "choice") {
      if (typeof v === "string" && def.values.includes(v)) out[k] = v;
    } else if (def.type === "bool") {
      if (v === true || v === false) out[k] = v;
    } else if (def.type === "themes") {
      if (Array.isArray(v) && v.length <= rules.hideable.length * 2) out[k] = rules.hideable.filter((t) => v.includes(t));
    }
  }
  return out;
}

/** A node id accepted in a layout: an existing note, or a sub-theme bubble with a strict id. */
function idAllowed(id, rules) {
  if (typeof id !== "string") return false;
  if (id.charAt(0) === "~") return rules.relayRe.test(id);
  return NOTE_RE.test(id) && !!rules.noteExists(id);
}

/** Positions: { id: [x, y, z] }, allowed ids only, MAX_POSITIONS at most. */
function validatePositions(raw, rules) {
  const out = Object.create(null);
  if (!isObject(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= MAX_POSITIONS) break;
    if (!idAllowed(id, rules)) continue;
    const t = triple(raw[id]);
    if (!t) continue;
    out[id] = t;
    n++;
  }
  return out;
}

/** Pinned bubbles: a de-duplicated subset of the ids that have a position. */
function validatePinned(raw, positions) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const id of raw.slice(0, MAX_POSITIONS)) {
    if (typeof id !== "string" || seen.has(id) || !own(positions, id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Camera: { position, target }, finite bounded numbers, not at the same point; otherwise null. */
function validateCamera(raw) {
  if (!isObject(raw)) return null;
  const position = triple(raw.position), target = triple(raw.target);
  if (!position || !target) return null;
  if (Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 0.01) return null;
  return { position, target };
}

/**
 * An update sent by the page. Every part is OPTIONAL (settings and layout are saved at different
 * paces). Returns null when the body is not an object; otherwise { reset, settings?, positions?,
 * pinned?, camera? } with only the parts present in the body, validated.
 */
function validateUpdate(raw, rules) {
  if (!isObject(raw)) return null;
  const out = { reset: raw.reset === true };
  if (own(raw, "settings")) out.settings = validateSettings(raw.settings, rules);
  if (own(raw, "positions")) {
    out.positions = validatePositions(raw.positions, rules);
    out.pinned = validatePinned(raw.pinned, out.positions);
  }
  if (own(raw, "camera")) out.camera = raw.camera === null ? null : validateCamera(raw.camera);
  return out;
}

function emptyView() {
  return { v: 1, updated: 0, settings: {}, positions: Object.create(null), pinned: [], camera: null };
}

/**
 * Applies a validated update: a part present REPLACES the old one; `reset` first clears the
 * layout (positions, pinned, camera) — the "Rearrange" button — never the settings.
 */
function merge(view, update, now) {
  const out = { ...emptyView(), ...view };
  if (update.reset) { out.positions = Object.create(null); out.pinned = []; out.camera = null; }
  if (update.settings) out.settings = update.settings;
  if (update.positions) { out.positions = update.positions; out.pinned = update.pinned || []; }
  if (own(update, "camera")) out.camera = update.camera;
  out.updated = now;
  return out;
}

/** A stored view, validated again as a whole (notes removed since then drop out). */
function reread(raw, rules) {
  const v = emptyView();
  if (!isObject(raw)) return v;
  v.updated = Number.isFinite(raw.updated) ? raw.updated : 0;
  v.settings = validateSettings(raw.settings, rules);
  v.positions = validatePositions(raw.positions, rules);
  v.pinned = validatePinned(raw.pinned, v.positions);
  v.camera = validateCamera(raw.camera);
  return v;
}

/**
 * The view store. `dir` null: kept in memory only (no data folder). Writes are rate limited with a
 * token bucket (`burst` writes, one more every `refillMs`).
 */
function createViewStore({ dir, rules, burst = 30, refillMs = 1000, now = Date.now } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  let inMemory = null;
  let warned = false;
  const bucket = { tokens: burst, t: now() };

  function readRaw() {
    if (!file) return inMemory;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return inMemory; }
  }
  function writeRaw(view) {
    inMemory = view;
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(view), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!warned) { warned = true; console.warn(`memglow: saved view: cannot write in ${dir} (${e.message}); kept in memory only`); }
    }
  }

  return {
    /** The view, validated again against the current notes. */
    read() { return reread(readRaw(), rules); },
    /** True if a write is allowed now (and uses one token). */
    rateOk(t = now()) {
      const gained = Math.floor((t - bucket.t) / refillMs);
      if (gained > 0) { bucket.tokens = Math.min(burst, bucket.tokens + gained); bucket.t += gained * refillMs; }
      if (bucket.tokens >= burst) bucket.t = t;
      if (bucket.tokens <= 0) return false;
      bucket.tokens--;
      return true;
    },
    /** Applies a parsed body. Returns the view written, or null if the body is not an object. */
    write(body, t = now()) {
      const update = validateUpdate(body, rules);
      if (!update) return null;
      const view = merge(reread(readRaw(), rules), update, t);
      writeRaw(view);
      return view;
    },
    file,
  };
}

/** Public shape of a view (what GET /api/view answers). */
function publicView(v) {
  return { settings: v.settings, positions: v.positions, pinned: v.pinned, camera: v.camera, updated: v.updated };
}

module.exports = {
  SETTINGS, MAX_POSITIONS, BOUND, BODY_MAX, FILE,
  createRules, validateSettings, validatePositions, validatePinned, validateCamera, validateUpdate,
  merge, reread, emptyView, createViewStore, publicView,
};
