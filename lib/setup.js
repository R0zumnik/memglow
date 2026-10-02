"use strict";
/**
 * First-run set-up and Settings → AI settings: what the page saves on the memglow server.
 *
 *   <dataDir>/setup.json = { v: 1, updated, wizardDone, clients: [ids] | absent,
 *                            assistant: { enabled, provider, providers: { id: {…} } } | absent,
 *                            tuning: { largeNoteTokens?, splitChunkTokens?, allowMissingLines?, backup? } | absent }
 *
 * PRIORITY (documented in the README): environment variable > page (this file) > memglow.config.json.
 * The page shows a setting set by an environment variable as locked ("set by MEMGLOW_…").
 *
 * SECRETS (API keys, the Claude Code subscription token) are NEVER in setup.json: each one is a file
 * of its own in the data folder, mode 600, written atomically (writeSecret), read back only by the
 * provider that uses it (lib/assistant/providers). They are never sent to the browser (only
 * "set" / "not set" / "not needed" and where from), never logged, never in an error message. A body
 * that carries a secret-looking field anywhere else is refused (validate → "secret-field").
 *
 * NOTHING IS TAKEN ON TRUST (validate): a closed list of keys, types and bounds per provider;
 * anything unknown is refused, not ignored (a refused save tells the page, a trimmed one would not).
 * Atomic writes (temporary file, then rename), mode 600. No HTTP here (server.js mounts the routes).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CLIENTS, IDS: CLIENT_IDS, cleanClients, installed, readClients } = require("./clients");
const providers = require("./assistant/providers");
const http = require("./assistant/providers/http");
const claudeCode = require("./assistant/providers/claude-code");
const anthropic = require("./assistant/providers/anthropic");
const openai = require("./assistant/providers/openai-compatible");
const { dayOf, daysBefore } = require("./cost");
const memoryRules = require("./memory-rules");

const FILE = "setup.json";
const USAGE_FILE = "assistant-usage.json";
const BODY_MAX = 16 * 1024;
const SECRET_BODY_MAX = 8 * 1024;
const PROVIDER_IDS = ["claude-code", "anthropic", "openai-compatible", "ollama", "lmstudio"];
const LOCAL_IDS = ["ollama", "lmstudio"];
const CLOUD_PRESETS = ["openai", "mistral", "openrouter"];

// Per provider: the fields the page may set. Bounds below (FIELD). Anything else is refused.
const FIELDS = {
  "claude-code": ["model", "timeoutMinutes", "maxBudgetUsd", "confirmRemote"],
  anthropic: ["model", "baseUrl", "maxTokens", "temperature", "timeoutMinutes", "confirmRemote", "priceIn", "priceOut"],
  "openai-compatible": ["model", "preset", "baseUrl", "maxTokens", "temperature", "timeoutMinutes", "confirmRemote", "priceIn", "priceOut"],
  ollama: ["model", "baseUrl", "maxTokens", "temperature", "timeoutMinutes"],
  lmstudio: ["model", "baseUrl", "maxTokens", "temperature", "timeoutMinutes"],
};
const NUM = {
  maxTokens: [1, 1000000, true],
  temperature: [0, 2, false],
  timeoutMinutes: [1, 60, true],
  maxBudgetUsd: [0.01, 100, false],
  priceIn: [0, 1000, false],
  priceOut: [0, 1000, false],
};
const TUNING = {
  largeNoteTokens: [200, 1000000],
  splitChunkTokens: [100, 1000000],
  allowMissingLines: [0, 50],
};
const BACKUPS = ["auto", "git", "copy"];

// Defaults (what memglow does when nothing is set) — shown in the page, never written.
const DEFAULTS = {
  "claude-code": { model: "", timeoutMinutes: 10, maxBudgetUsd: null, confirmRemote: true },
  anthropic: { model: anthropic.DEFAULT_MODEL, baseUrl: anthropic.DEFAULT_BASE, maxTokens: 32000, temperature: null, timeoutMinutes: 10, confirmRemote: true },
  "openai-compatible": { model: "", preset: "openai", baseUrl: "", maxTokens: null, temperature: null, timeoutMinutes: 10, confirmRemote: true },
  ollama: { model: "", baseUrl: openai.PRESETS.ollama, maxTokens: null, temperature: null, timeoutMinutes: 10 },
  lmstudio: { model: "", baseUrl: openai.PRESETS.lmstudio, maxTokens: null, temperature: null, timeoutMinutes: 10 },
};
// Suggestions for the model field (a free id is accepted too, validated by validModel).
const MODELS = {
  "claude-code": claudeCode.MODEL_ALIASES.slice(),
  anthropic: Object.keys(anthropic.KNOWN_MODELS),
  "openai-compatible": [],
  ollama: ["llama3.1", "qwen2.5", "mistral", "gemma2"],
  lmstudio: [],
};

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A field NAME that holds a secret, anywhere in a body: refused (keys go through POST /api/setup/secret).
const SECRET_NAME = /^(api[_-]?key|apikey|key|keys|token|oauth[_-]?token|secret|password|passwd|authorization|bearer|access[_-]?token|auth[_-]?token|credentials?)$/i;
// A string VALUE shaped like an API key or a subscription token, anywhere in a body: refused too.
const SECRET_VALUE = /^(sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}|^sk-ant-|^Bearer\s/i;
function carriesSecret(v, depth = 0) {
  if (depth > 6) return true;
  if (typeof v === "string") return SECRET_VALUE.test(v.trim());
  if (Array.isArray(v)) return v.some((x) => carriesSecret(x, depth + 1));
  if (isObject(v)) return Object.keys(v).some((k) => SECRET_NAME.test(k) || carriesSecret(v[k], depth + 1));
  return false;
}

/** A model name for a provider, or null. */
function validModel(id, m) {
  if (typeof m !== "string") return false;
  if (id === "claude-code") return claudeCode.validModel(m);
  if (id === "anthropic") return /^claude-[a-z0-9][a-z0-9.-]{1,60}$/.test(m);
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(m) && !SECRET_VALUE.test(m);
}

/** One provider's settings from the page. → { ok, value } | { ok: false, error, field }. */
function validateProvider(id, raw) {
  if (!isObject(raw)) return { ok: false, error: "bad-provider", field: id };
  const out = {};
  for (const k of Object.keys(raw)) {
    const field = id + "." + k;
    if (!FIELDS[id].includes(k)) return { ok: false, error: "unknown-field", field };
    const v = raw[k];
    if (v === null || v === "") continue; // back to the default
    if (k === "model") {
      if (!validModel(id, v)) return { ok: false, error: "bad-model", field };
      out.model = v;
    } else if (k === "baseUrl") {
      const ep = typeof v === "string" && v.length <= 500 ? http.endpoint(v) : { ok: false };
      if (!ep.ok) return { ok: false, error: "bad-url", field };
      if (LOCAL_IDS.includes(id) && !ep.local) return { ok: false, error: "url-not-local", field };
      out.baseUrl = ep.url;
    } else if (k === "preset") {
      if (!CLOUD_PRESETS.includes(v)) return { ok: false, error: "bad-preset", field };
      out.preset = v;
    } else if (k === "confirmRemote") {
      if (typeof v !== "boolean") return { ok: false, error: "bad-value", field };
      out.confirmRemote = v;
    } else {
      const [min, max, integer] = NUM[k];
      const top = k === "temperature" && id === "anthropic" ? 1 : max;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > top || (integer && !Number.isInteger(v))) return { ok: false, error: "out-of-range", field };
      out[k] = integer ? v : Math.round(v * 1000) / 1000;
    }
  }
  if (id === "openai-compatible" && !out.preset && !out.baseUrl) out.preset = "openai";
  if (id === "openai-compatible" && out.baseUrl) delete out.preset;
  if (id === "anthropic" && out.temperature != null && !anthropic.acceptsTemperature(out.model || anthropic.DEFAULT_MODEL)) {
    return { ok: false, error: "temperature-unsupported", field: id + ".temperature" };
  }
  return { ok: true, value: out };
}

/**
 * A body sent by the page. Every part is optional; a part present replaces the saved one.
 * → { ok: true, value } | { ok: false, error, field? } (never the value received).
 */
function validate(raw) {
  if (!isObject(raw)) return { ok: false, error: "bad-body" };
  if (carriesSecret(raw)) return { ok: false, error: "secret-field" };
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!["wizardDone", "clients", "assistant", "tuning", "rules"].includes(k)) return { ok: false, error: "unknown-field", field: k };
  }
  if (own(raw, "rules")) {
    // Hostile-input validation (length, control characters) lives in lib/memory-rules.js — the
    // single source of truth also read (without going through this file) by the MCP proxy and
    // memglow's own MCP server.
    const v = memoryRules.validateRulesInput(raw.rules);
    if (!v) return { ok: false, error: "bad-rules", field: "rules" };
    out.rules = v;
  }
  if (own(raw, "wizardDone")) {
    if (typeof raw.wizardDone !== "boolean") return { ok: false, error: "bad-value", field: "wizardDone" };
    out.wizardDone = raw.wizardDone;
  }
  if (own(raw, "clients")) {
    if (!Array.isArray(raw.clients) || raw.clients.length > CLIENT_IDS.length * 2 || raw.clients.some((c) => typeof c !== "string" || !CLIENT_IDS.includes(c))) {
      return { ok: false, error: "bad-clients", field: "clients" };
    }
    out.clients = cleanClients(raw.clients);
  }
  if (own(raw, "assistant")) {
    const a = raw.assistant;
    if (!isObject(a)) return { ok: false, error: "bad-assistant", field: "assistant" };
    for (const k of Object.keys(a)) if (!["enabled", "provider", "providers"].includes(k)) return { ok: false, error: "unknown-field", field: "assistant." + k };
    const v = { enabled: false, provider: "", providers: {} };
    if (own(a, "enabled")) {
      if (typeof a.enabled !== "boolean") return { ok: false, error: "bad-value", field: "assistant.enabled" };
      v.enabled = a.enabled;
    }
    if (own(a, "providers")) {
      if (!isObject(a.providers)) return { ok: false, error: "bad-providers", field: "assistant.providers" };
      for (const id of Object.keys(a.providers)) {
        if (!PROVIDER_IDS.includes(id)) return { ok: false, error: "unknown-provider", field: "assistant.providers" };
        const p = validateProvider(id, a.providers[id]);
        if (!p.ok) return p;
        v.providers[id] = p.value;
      }
    }
    if (own(a, "provider") && a.provider !== "") {
      if (typeof a.provider !== "string" || !PROVIDER_IDS.includes(a.provider)) return { ok: false, error: "unknown-provider", field: "assistant.provider" };
      if (Object.keys(v.providers).length && !own(v.providers, a.provider)) return { ok: false, error: "default-not-chosen", field: "assistant.provider" };
      v.provider = a.provider;
    }
    if (!v.provider && Object.keys(v.providers).length) v.provider = PROVIDER_IDS.find((id) => own(v.providers, id));
    out.assistant = v;
  }
  if (own(raw, "tuning")) {
    const t = raw.tuning;
    if (!isObject(t)) return { ok: false, error: "bad-tuning", field: "tuning" };
    const v = {};
    for (const k of Object.keys(t)) {
      const x = t[k];
      if (x === null) continue;
      if (k === "backup") {
        if (!BACKUPS.includes(x)) return { ok: false, error: "bad-value", field: "tuning.backup" };
        v.backup = x;
      } else if (own(TUNING, k)) {
        const [min, max] = TUNING[k];
        if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) return { ok: false, error: "out-of-range", field: "tuning." + k };
        v[k] = x;
      } else return { ok: false, error: "unknown-field", field: "tuning." + k };
    }
    if (v.largeNoteTokens != null && v.splitChunkTokens != null && v.splitChunkTokens > v.largeNoteTokens) return { ok: false, error: "parts-larger-than-limit", field: "tuning.splitChunkTokens" };
    out.tuning = v;
  }
  return { ok: true, value: out };
}

/** A stored file, validated again as a whole (an unreadable or tampered part is dropped). */
function reread(raw) {
  if (!isObject(raw)) return null;
  const parts = {};
  for (const k of ["wizardDone", "clients", "assistant", "tuning", "rules"]) {
    if (!own(raw, k)) continue;
    const r = validate({ [k]: raw[k] });
    if (r.ok) Object.assign(parts, r.value);
  }
  parts.updated = Number.isFinite(raw.updated) ? raw.updated : 0;
  return parts;
}

function writeAtomic(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

/** The set-up store. `dir` null: kept in memory only. Rate limited like the zones. */
function createSetupStore({ dir, burst = 20, refillMs = 3000, now = Date.now } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  let inMemory = null;
  let warned = false;
  const bucket = { tokens: burst, t: now() };
  function read() {
    if (file) {
      try { return reread(JSON.parse(fs.readFileSync(file, "utf8"))) || inMemory || {}; } catch { return inMemory || {}; }
    }
    return inMemory || {};
  }
  return {
    read,
    file,
    rateOk(t = now()) {
      const gained = Math.floor((t - bucket.t) / refillMs);
      if (gained > 0) { bucket.tokens = Math.min(burst, bucket.tokens + gained); bucket.t += gained * refillMs; }
      if (bucket.tokens >= burst) bucket.t = t;
      if (bucket.tokens <= 0) return false;
      bucket.tokens--;
      return true;
    },
    /** Merges a VALIDATED update (validate().value) into the saved set-up and writes it. */
    write(update, t = now()) {
      const cur = read();
      const next = { v: 1, ...cur, ...update, updated: t };
      delete next.v; // rebuilt below, in a fixed order
      const out = { v: 1, updated: t };
      for (const k of ["wizardDone", "clients", "assistant", "tuning", "rules"]) if (own(next, k)) out[k] = next[k];
      inMemory = reread(out);
      if (file) {
        try { writeAtomic(dir, FILE, JSON.stringify(out)); } catch (e) {
          if (!warned) { warned = true; console.warn(`memglow: set-up: cannot write in ${dir} (${e.code || "error"}); kept in memory only`); }
        }
      }
      return inMemory;
    },
  };
}

// ----------------------------------------------------------------------------------------------
// Effective configuration: environment > page > file.

/** What the file (and the environment) gave at start-up: kept to recompute after each save. */
function baseOf(config) {
  return JSON.parse(JSON.stringify({
    assistant: config.assistant, largeNoteTokens: config.largeNoteTokens, splitChunkTokens: config.splitChunkTokens, clients: config.clients,
  }));
}

/** Settings an environment variable sets (shown locked in the page). */
function envLocks(env) {
  const set = (k) => typeof env[k] === "string" && env[k].trim() !== "";
  return {
    enabled: /^(1|0|true|false)$/i.test(String(env.MEMGLOW_ASSISTANT || "").trim()) ? "MEMGLOW_ASSISTANT" : "",
    provider: set("MEMGLOW_ASSISTANT_PROVIDER") ? "MEMGLOW_ASSISTANT_PROVIDER" : "",
    model: set("MEMGLOW_ASSISTANT_MODEL") ? "MEMGLOW_ASSISTANT_MODEL" : "",
    baseUrl: set("MEMGLOW_ASSISTANT_BASE_URL") ? "MEMGLOW_ASSISTANT_BASE_URL" : "",
    preset: set("MEMGLOW_ASSISTANT_PRESET") ? "MEMGLOW_ASSISTANT_PRESET" : "",
    largeNoteTokens: set("MEMGLOW_LARGE_NOTE_TOKENS") ? "MEMGLOW_LARGE_NOTE_TOKENS" : "",
    clients: cleanClients(env.MEMGLOW_CLIENTS) ? "MEMGLOW_CLIENTS" : "",
  };
}

/**
 * The configuration in effect for `saved` (the page's set-up) over `base` (file + environment).
 * → { assistant, largeNoteTokens, splitChunkTokens, clients, clientsSource }. Pure.
 */
function effective(base, saved, env = process.env) {
  const locks = envLocks(env);
  const a = JSON.parse(JSON.stringify(base.assistant || {}));
  a.sections = a.sections || {};
  a.fromPage = [];
  const s = saved || {};
  if (s.assistant) {
    if (!locks.enabled) a.enabled = !!s.assistant.enabled;
    if (!locks.provider && s.assistant.provider) a.provider = s.assistant.provider;
    for (const [id, fields] of Object.entries(s.assistant.providers || {})) {
      a.sections[id] = { ...(a.sections[id] || {}), ...fields };
      a.fromPage.push(id);
    }
    // Environment > page: the variables that set the default provider's model, URL or preset.
    const sec = (a.sections[a.provider] = a.sections[a.provider] || {});
    if (locks.model) sec.model = String(env.MEMGLOW_ASSISTANT_MODEL).trim().slice(0, 100);
    if (locks.baseUrl) sec.baseUrl = String(env.MEMGLOW_ASSISTANT_BASE_URL).trim().slice(0, 500);
    if (locks.preset) sec.preset = String(env.MEMGLOW_ASSISTANT_PRESET).trim().toLowerCase().slice(0, 20);
  }
  const t = s.tuning || {};
  if (t.allowMissingLines != null) a.allowMissingLines = t.allowMissingLines;
  if (t.backup) a.backup = t.backup;
  let largeNoteTokens = base.largeNoteTokens;
  if (t.largeNoteTokens != null && !locks.largeNoteTokens) largeNoteTokens = t.largeNoteTokens;
  const splitChunkTokens = t.splitChunkTokens != null ? t.splitChunkTokens : base.splitChunkTokens;
  let clients = base.clients, clientsSource = Array.isArray(base.clients) ? "config" : "none";
  if (s.clients) { clients = s.clients; clientsSource = "page"; }
  if (locks.clients) { clients = cleanClients(env.MEMGLOW_CLIENTS); clientsSource = "env"; }
  return { assistant: a, largeNoteTokens, splitChunkTokens, clients, clientsSource };
}

/** Applies effective() to the live configuration object (in place: the assistant reads it live). */
function apply(config, base, saved, env = process.env) {
  const e = effective(base, saved, env);
  config.assistant = e.assistant;
  config.largeNoteTokens = e.largeNoteTokens;
  config.splitChunkTokens = e.splitChunkTokens;
  config.clients = e.clients;
  config.clientsSource = e.clientsSource;
  return e;
}

// ----------------------------------------------------------------------------------------------
// Secrets: API keys and the Claude Code subscription token.

/** The file of the data folder a provider's secret typed in the page goes to; null = no secret. */
function secretFile(id) {
  if (id === "claude-code") return claudeCode.OAUTH_FILE;
  if (id === "anthropic" || id === "openai-compatible") return http.providerKeyFile(id);
  return null;
}
/** A secret as typed: printable ASCII without spaces, 8 to 4096 characters. */
function validSecret(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return s.length >= 8 && s.length <= 4096 && /^[\x21-\x7E]+$/.test(s);
}
function writeSecret(dataDir, id, value) {
  const name = secretFile(id);
  if (!name || !dataDir || !validSecret(value)) return false;
  writeAtomic(dataDir, name, value.trim() + "\n");
  return true;
}
function removeSecret(dataDir, id) {
  const name = secretFile(id);
  if (!name || !dataDir) return false;
  try { fs.rmSync(path.join(dataDir, name), { force: true }); return true; } catch { return false; }
}

const LOOPBACK_ADDR = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
/**
 * May a secret be typed in the page for this request? Only when the browser is on this machine,
 * or when a password protects memglow AND the browser's connection is HTTPS.
 *   local: the connection comes from a loopback address, carries no proxy header (a reverse proxy
 *          on this machine would make every visitor look local), and the page's Origin is a
 *          loopback name too.
 *   https: MEMGLOW_PASSWORD is set, and the connection is TLS — memglow itself does not do TLS,
 *          so behind a reverse proxy only when MEMGLOW_TRUST_PROXY is on and X-Forwarded-Proto
 *          says https (and the Origin is https).
 * → { allowed, why: "local" | "https" | "" , reason: "remote" | "no-password" | "not-https" }.
 */
function secretEntry(req, config) {
  const h = req.headers || {};
  let origin = null;
  try { origin = new URL(String(h.origin || "")); } catch { origin = null; }
  const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].some((k) => h[k] != null);
  const addr = String((req.socket && req.socket.remoteAddress) || "");
  const originLocal = !!origin && (origin.protocol === "http:" || origin.protocol === "https:") && http.isLoopback(origin.hostname);
  if (LOOPBACK_ADDR.test(addr) && !forwarded && originLocal) return { allowed: true, why: "local", reason: "" };
  if (!config.password) return { allowed: false, why: "", reason: "no-password" };
  const proto = String(h["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const tls = !!(req.socket && req.socket.encrypted) || (config.trustProxy && proto === "https");
  if (tls && origin && origin.protocol === "https:") return { allowed: true, why: "https", reason: "" };
  return { allowed: false, why: "", reason: config.trustProxy ? "not-https" : "not-https-untrusted" };
}

// ----------------------------------------------------------------------------------------------
// Usage: requests per provider and day (for the usage box). Numbers only, never any text.

function createUsage({ dir, now = Date.now, keepDays = 31 } = {}) {
  const file = dir ? path.join(dir, USAGE_FILE) : null;
  let data = { v: 1, days: {} };
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isObject(raw) && isObject(raw.days)) data = { v: 1, days: raw.days };
    } catch { /* absent or unreadable: start again */ }
  }
  const n = (x) => (Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  function save() {
    if (!file) return;
    try { writeAtomic(dir, USAGE_FILE, JSON.stringify(data)); } catch { /* counting is best effort */ }
  }
  return {
    add({ provider, ok, inChars, outChars }, t = now()) {
      if (!PROVIDER_IDS.includes(provider)) return;
      const day = dayOf(t);
      const d = (data.days[day] = isObject(data.days[day]) ? data.days[day] : {});
      const p = (d[provider] = isObject(d[provider]) ? d[provider] : { n: 0, failed: 0, in: 0, out: 0 });
      p.n = n(p.n) + 1; if (!ok) p.failed = n(p.failed) + 1;
      p.in = n(p.in) + n(inChars); p.out = n(p.out) + n(outChars);
      const oldest = daysBefore(t, keepDays);
      for (const k of Object.keys(data.days)) if (k < oldest) delete data.days[k];
      save();
    },
    /**
     * Per provider, last 7 and 30 days: requests, failed, tokens in/out (≈ characters ÷ 4) and an
     * estimated cost when a price is known (`priceOf(id)` → [in, out] USD per million tokens, or null).
     */
    summary(priceOf = () => null, t = now()) {
      const out = {};
      for (const [win, days] of [["d7", 7], ["d30", 30]]) {
        const from = daysBefore(t, days - 1);
        for (const [day, per] of Object.entries(data.days)) {
          if (day < from || !isObject(per)) continue;
          for (const [id, p] of Object.entries(per)) {
            if (!PROVIDER_IDS.includes(id) || !isObject(p)) continue;
            const row = (out[id] = out[id] || { d7: { n: 0, failed: 0, inTokens: 0, outTokens: 0 }, d30: { n: 0, failed: 0, inTokens: 0, outTokens: 0 } });
            const w = row[win];
            w.n += n(p.n); w.failed += n(p.failed);
            w.inTokens += Math.ceil(n(p.in) / 4); w.outTokens += Math.ceil(n(p.out) / 4);
          }
        }
      }
      for (const [id, row] of Object.entries(out)) {
        const price = priceOf(id);
        for (const w of [row.d7, row.d30]) w.cost = price ? Math.round(((w.inTokens * price[0] + w.outTokens * price[1]) / 1e6) * 10000) / 10000 : null;
        row.billing = id === "claude-code" ? "subscription" : LOCAL_IDS.includes(id) ? "local" : price ? "api" : "unknown";
      }
      return out;
    },
  };
}

/** The price used for the estimate: the one set in AI settings, else the known list price. */
function priceOf(cfg, id) {
  if (id === "claude-code" || LOCAL_IDS.includes(id)) return null;
  if (typeof cfg.priceIn === "number" && typeof cfg.priceOut === "number") return [cfg.priceIn, cfg.priceOut];
  if (id === "anthropic") return anthropic.KNOWN_MODELS[cfg.model || anthropic.DEFAULT_MODEL] || null;
  return null;
}

// ----------------------------------------------------------------------------------------------
// Test connection: one minimal request, no note content.

const TEST_SYSTEM = "This is a connection test from memglow. Answer with the single word OK.";
const TEST_PROMPT = "Reply with OK.";

/**
 * → Promise<{ ok, ms, error?, models? }>. `error` is redacted with every secret memglow holds for
 * this provider. For a model on this machine, `models` lists what its server offers (GET /models,
 * loopback only, no key sent), so the page can propose them.
 */
async function testConnection({ id, assistantConfig, env = process.env, dataDir, workDir, fetchImpl = globalThis.fetch }) {
  const prov = providers.get(id);
  if (!prov || !PROVIDER_IDS.includes(id)) return { ok: false, ms: 0, error: "Unknown provider." };
  const cfg = providers.configFor(assistantConfig || {}, id);
  const ctx = { config: { ...cfg, maxTokens: id === "claude-code" ? cfg.maxTokens : 1024 }, env, dataDir, workDir, fetch: fetchImpl, providerId: id };
  const secrets = [];
  try { const k = http.apiKey(ctx); if (k.key) secrets.push(k.key); } catch { /* none */ }
  try { const o = claudeCode.oauth(ctx); if (o.token) secrets.push(o.token); } catch { /* none */ }
  if (env[claudeCode.OAUTH_ENV]) secrets.push(String(env[claudeCode.OAUTH_ENV]));
  const clean = (m) => secrets.reduce((s, k) => http.redact(s, k), String(m || ""));
  const t0 = Date.now();
  let models;
  if (LOCAL_IDS.includes(id) && typeof fetchImpl === "function") {
    const ep = http.endpoint(cfg.baseUrl || openai.PRESETS[id]);
    if (ep.ok && ep.local) {
      try {
        const r = await fetchImpl(ep.url + "/models", { redirect: "manual", signal: AbortSignal.timeout(3000) });
        const j = r.ok ? await r.json() : null;
        if (j && Array.isArray(j.data)) models = j.data.map((m) => m && m.id).filter((m) => typeof m === "string" && validModel(id, m)).slice(0, 50);
      } catch { /* the test below says what is wrong */ }
    }
  }
  let d;
  try { d = prov.detect(ctx); } catch { d = { available: false, reason: "This provider is not available." }; }
  if (!d.available) return { ok: false, ms: 0, error: clean(d.reason), models };
  if (workDir) fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  let r;
  try {
    r = await prov.run(ctx, { system: TEST_SYSTEM, prompt: TEST_PROMPT, timeoutMs: id === "claude-code" ? 120000 : 30000 });
  } catch (e) { r = { ok: false, error: "provider error" }; }
  const ok = !!(r && (r.ok || String(r.text || "").trim()));
  return { ok, ms: Date.now() - t0, error: ok ? "" : clean(r && r.error ? r.error : "failed"), models };
}

// ----------------------------------------------------------------------------------------------
// What GET /api/setup answers (never a secret).

/**
 * `ctx` = { config, saved, env, dataDir, memglowHome, req, assistantStatus? , usage }.
 */
function publicSetup({ config, saved, env = process.env, dataDir, memglowHome, req, usage }) {
  const locks = envLocks(env);
  const inst = memglowHome ? installed(memglowHome) : { detected: [], hooks: [], chosen: null };
  const chosen = Array.isArray(config.clients) ? config.clients : inst.chosen;
  const ac = config.assistant || {};
  const sections = ac.sections || {};
  const fromPage = new Set(ac.fromPage || []);
  const list = PROVIDER_IDS.map((id) => {
    const p = providers.get(id);
    const cfg = providers.configFor(ac, id);
    const ctx = { config: cfg, env, dataDir, providerId: id };
    let d = { available: false, detected: false };
    try { d = p.detect(ctx); } catch { /* left as not available */ }
    let info = {};
    try { info = p.info ? p.info(ctx) : {}; } catch { info = {}; }
    const configured = own(sections, id) || ac.provider === id;
    const settings = {};
    for (const k of FIELDS[id]) settings[k] = cfg[k] != null && cfg[k] !== "" && cfg[k] !== 0 ? cfg[k] : null;
    if (id !== "claude-code" && settings.timeoutMinutes == null && own(sections, id) && sections[id].timeoutMinutes) settings.timeoutMinutes = sections[id].timeoutMinutes;
    return {
      id, label: p.label, local: LOCAL_IDS.includes(id), kind: p.kind,
      configured, source: fromPage.has(id) ? "page" : configured ? "config" : "",
      detected: !!d.detected, available: !!d.available, reason: d.available ? "" : String(d.reason || ""),
      destination: info.destination || "", key: info.key || (LOCAL_IDS.includes(id) ? "not needed" : "not set"),
      keySource: info.keySource || "", keyName: info.keyName || "",
      secret: secretFile(id) ? (id === "claude-code" ? "oauth" : "apikey") : "",
      keyEnv: id === "claude-code" ? claudeCode.OAUTH_ENV : LOCAL_IDS.includes(id) ? "" : http.providerKeyEnv(id),
      fields: FIELDS[id], settings, defaults: DEFAULTS[id], models: MODELS[id],
      presets: id === "openai-compatible" ? CLOUD_PRESETS.map((x) => ({ id: x, url: openai.PRESETS[x] })) : [],
      temperatureMax: id === "anthropic" ? 1 : 2,
      temperatureSupported: id === "claude-code" ? false : id === "anthropic" ? anthropic.acceptsTemperature(cfg.model || anthropic.DEFAULT_MODEL) : true,
      price: priceOf(cfg, id),
      locked: ac.provider === id ? { model: locks.model, baseUrl: locks.baseUrl, preset: locks.preset } : {},
    };
  });
  const s = saved || {};
  const blocked = Array.isArray(ac.keyInConfig) && ac.keyInConfig.length ? "key-in-config"
    : !config.showBodies ? "no-bodies" : !dataDir ? "no-data-dir" : "";
  return {
    wizard: { done: s.wizardDone === true },
    docker: !!config.docker,
    activityToken: !!config.token,
    clients: {
      list: CLIENTS.map((c) => ({ ...c, detected: inst.detected.includes(c.id), hook: inst.hooks.includes(c.id) })),
      chosen: chosen || null, source: config.clientsSource || (Array.isArray(config.clients) ? "config" : inst.chosen ? "init" : "none"),
      locked: locks.clients,
    },
    assistant: {
      enabled: !!ac.enabled, provider: ac.provider || "", blocked,
      locked: { enabled: locks.enabled, provider: locks.provider },
      providers: list,
    },
    tuning: {
      largeNoteTokens: config.largeNoteTokens, splitChunkTokens: config.splitChunkTokens,
      allowMissingLines: ac.allowMissingLines || 0, backup: ac.backup || "auto",
      locked: { largeNoteTokens: locks.largeNoteTokens },
    },
    // Memory rules (lib/memory-rules.js): same storage as everything else here (setup.json,
    // through this file's own validate()/write()). `preview` is the EXACT text memglow would
    // deliver right now (through the MCP proxy and its own MCP server) — "" when off, whether
    // from MEMGLOW_RULES or from `enabled: false` here. `defaultPreview` is the built-in template
    // alone (enabled, no extra lines, no override): what "Reset" puts back.
    rules: (() => {
      const r = memoryRules.withDefaults(s.rules);
      const envOff = memoryRules.envDisabled(env);
      return {
        enabled: r.enabled, extra: r.extra, override: r.override,
        preview: envOff ? "" : memoryRules.buildRulesText(config, r),
        defaultPreview: memoryRules.buildRulesText(config, { enabled: true, extra: [], override: "" }),
        envDisabled: envOff,
        limits: { extraMaxItems: memoryRules.EXTRA_MAX_ITEMS, extraItemMax: memoryRules.EXTRA_ITEM_MAX, overrideMax: memoryRules.OVERRIDE_MAX },
      };
    })(),
    secretEntry: req ? secretEntry(req, config) : { allowed: false, why: "", reason: "remote" },
    usage: usage ? usage.summary((id) => priceOf(providers.configFor(ac, id), id)) : {},
  };
}

module.exports = {
  FILE, USAGE_FILE, BODY_MAX, SECRET_BODY_MAX, PROVIDER_IDS, LOCAL_IDS, CLOUD_PRESETS, FIELDS, DEFAULTS, MODELS,
  validate, validateProvider, validModel, carriesSecret, reread, createSetupStore,
  baseOf, envLocks, effective, apply,
  secretFile, validSecret, writeSecret, removeSecret, secretEntry,
  createUsage, priceOf, testConnection, publicSetup, readClients,
};
