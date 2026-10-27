"use strict";
/**
 * 0.5.4: a small, PLUGGABLE AI provider facade for memglow's own automated features — the
 * auto-split worker (lib/auto-split.js) and the star-structure guardian's judgement calls
 * (lib/star-audit.js). Never the interactive assistant (lib/assistant/*), which has its own,
 * richer per-provider configuration (several sections, a budget, AI settings in the panel); this
 * one picks exactly ONE provider for a background job and reuses the exact same, already-reviewed
 * HTTP/CLI plumbing the interactive assistant uses (lib/assistant/providers/*) — never a second
 * client for the same API:
 *
 *   anthropic          the Anthropic Messages API, your own key (apiKeyEnv / apiKeyFile)
 *   openai-compatible  any OpenAI-compatible Chat Completions endpoint — OpenAI, Mistral,
 *                      OpenRouter, Groq, LM Studio, Ollama's own `/v1` … (base URL + optional key)
 *   claude-code        the `claude` CLI, given NO tool at all, using your Claude subscription
 *                      (`claude setup-token`, or an existing `claude` login on this machine)
 *
 * Gemini: point `openai-compatible` at its own OpenAI-compatible endpoint (README) — not a fourth
 * client here; one HTTP shape already covers it.
 *
 * Config shape (reused as-is by `autoSplit` and `structure.ai` in lib/config.js):
 *   { provider: "anthropic" | "openai-compatible" | "claude-code",
 *     model, baseUrl, apiKeyEnv, apiKeyFile, command, maxTokens, temperature, timeoutMs }
 * The key itself never appears here beyond "set" / "not set" (describe()) — read once by
 * lib/assistant/providers/http.js's own apiKey(), from an environment variable or a mode-600 file
 * in memglow's data folder, exactly as the interactive assistant already does.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const providers = require("./assistant/providers");

const ALLOWED = new Set(["anthropic", "openai-compatible", "claude-code"]);
const DEFAULT_TIMEOUT_MS = 180000;
const KEY_ENV_INTERNAL = "MEMGLOW_AI_RESOLVED_KEY"; // never written to disk, never logged
const KEY_FILE_MAX_BYTES = 4096;

function writableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function strOf(v, max = 500) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : ""; }

/**
 * The provider-selection fields shared by every memglow feature built on run()/detect() above
 * (lib/auto-split.js's `autoSplit`, lib/star-audit.js's `structure.ai`) — same env var names,
 * same per-provider defaults, so ONE key/provider choice can power every one of them unless a
 * feature's own config section overrides it. `raw` = that feature's own config object (its
 * `provider`/`model`/`baseUrl`/`apiKeyEnv`/`apiKeyFile`/`command`/`claudeHome`, if any).
 */
function providerFieldsFrom(raw = {}, env = {}) {
  const a = raw && typeof raw === "object" ? raw : {};
  const provider = strOf(env.MEMGLOW_AI_PROVIDER || a.provider, 40).toLowerCase();
  const p = ALLOWED.has(provider) ? provider : "";
  const model = strOf(env.MEMGLOW_AI_MODEL || a.model, 100) || (p === "anthropic" ? "claude-haiku-4-5" : p === "claude-code" ? "haiku" : "");
  return {
    provider: p,
    model,
    baseUrl: strOf(env.MEMGLOW_AI_BASE_URL || a.baseUrl, 500),
    apiKeyEnv: strOf(a.apiKeyEnv, 64),
    apiKeyFile: strOf(a.apiKeyFile, 500),
    command: strOf(a.command || env.MEMGLOW_AI_CLAUDE_BIN, 200),
    claudeHome: strOf(a.claudeHome, 500),
  };
}

/** The provider module for `cfg.provider`, or null when unset/unknown. */
function providerOf(cfg) {
  if (!cfg || !ALLOWED.has(cfg.provider)) return null;
  return providers.get(cfg.provider);
}

/**
 * A key alone in a plain file, ANY path (this is an admin-set config value — never an untrusted
 * notes folder's own content — so unlike lib/assistant/providers/http.js's own readSecretFile()
 * this is not confined to memglow's data folder: Florent's own use is a key file elsewhere on the
 * NAS). Same safety checks: a regular file, not readable by other users, one line, trimmed.
 */
function readKeyFile(absPath) {
  let st;
  try { st = fs.lstatSync(absPath); } catch (e) { return { error: `the key file ${absPath} cannot be read: ${e.code || e.message}` }; }
  if (!st.isFile()) return { error: `the key file ${absPath} must be a regular file (not a link or a folder)` };
  if (process.platform !== "win32" && (st.mode & 0o077)) return { error: `refused: the key file ${absPath} can be read by other users (mode ${(st.mode & 0o777).toString(8)}) — chmod 600 it` };
  if (st.size > KEY_FILE_MAX_BYTES) return { error: `the key file ${absPath} is too large to be an API key` };
  let k;
  try { k = fs.readFileSync(absPath, "utf8").trim(); } catch (e) { return { error: `the key file ${absPath} cannot be read: ${e.code || e.message}` }; }
  if (/[\r\n]/.test(k)) return { error: `the key file ${absPath} must hold the key alone, on one line` };
  return { value: k };
}

/**
 * The API key for `cfg` (anthropic / openai-compatible only), first found wins:
 *   1. `cfg.apiKeyEnv` — the NAME of an environment variable, read from `env`
 *   2. `MEMGLOW_AI_API_KEY` — the key itself, directly
 *   3. `cfg.apiKeyFile` — a file path (absolute, or relative to the current folder)
 *   4. `MEMGLOW_AI_API_KEY_FILE` — same, from the environment
 * → { value } | { error }. Never both set and silently ignored: a key FILE that exists but
 * cannot be read safely is a hard error, not a fall-through to "no key".
 */
function resolveKey(cfg, env = process.env) {
  if (cfg.apiKeyEnv) {
    const v = env[cfg.apiKeyEnv];
    if (typeof v === "string" && v.trim()) return { value: v.trim() };
  }
  if (typeof env.MEMGLOW_AI_API_KEY === "string" && env.MEMGLOW_AI_API_KEY.trim()) return { value: env.MEMGLOW_AI_API_KEY.trim() };
  const file = cfg.apiKeyFile || env.MEMGLOW_AI_API_KEY_FILE;
  if (file) {
    const r = readKeyFile(path.resolve(String(file)));
    if (r.error) return { error: r.error };
    if (r.value) return { value: r.value };
  }
  return { value: "" };
}

/**
 * The ctx a provider's own detect()/run() expects (lib/assistant/providers/index.js's doc),
 * built for one background-job call — never shared state, never cached across calls. For
 * anthropic/openai-compatible, the key this module itself resolved (see resolveKey() above) is
 * handed to lib/assistant/providers/http.js's OWN apiKey() through a fixed internal env var name
 * — one tested key-reading code path, never a second one for the same purpose.
 */
function ctxFor(cfg, { dataDir, env = process.env } = {}) {
  const p = providerOf(cfg);
  const workDir = path.join(dataDir || os.tmpdir(), "ai-provider-work");
  if (p && p.id === "claude-code") {
    const home = cfg.claudeHome || path.join(os.tmpdir(), "memglow-claude");
    const childEnv = { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    if (!env.HOME || !writableDir(env.HOME)) {
      try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { /* run() will then fail cleanly */ }
      childEnv.HOME = home;
    }
    return { config: { command: cfg.command, model: cfg.model, maxBudgetUsd: 0 }, env: childEnv, workDir, dataDir };
  }
  if (p && (p.id === "anthropic" || p.id === "openai-compatible")) {
    const k = resolveKey(cfg, env);
    const childEnv = { ...env };
    let apiKeyEnv = cfg.apiKeyEnv;
    if (k.value) { childEnv[KEY_ENV_INTERNAL] = k.value; apiKeyEnv = KEY_ENV_INTERNAL; }
    return { config: { ...cfg, apiKeyEnv, apiKeyFile: "" }, env: childEnv, dataDir, workDir };
  }
  return { config: cfg, env, dataDir, workDir };
}

/** → { available, detected, reason? } — never throws. */
function detect(cfg, opts = {}) {
  const p = providerOf(cfg);
  if (!p) return { available: false, detected: false, reason: cfg && cfg.provider ? `Unknown AI provider "${cfg.provider}" (expected anthropic, openai-compatible or claude-code)` : "No AI provider configured" };
  if (p.id === "anthropic" || p.id === "openai-compatible") {
    const k = resolveKey(cfg, opts.env || process.env);
    if (k.error) return { available: false, detected: true, reason: k.error };
  }
  try { return p.detect(ctxFor(cfg, opts)); }
  catch (e) { return { available: false, detected: false, reason: e.message }; }
}

/** What the control panel may show: provider id/label, destination, model, "key set"/"not set" — never the key itself. */
function describe(cfg, opts = {}) {
  const p = providerOf(cfg);
  if (!p) return { provider: cfg && cfg.provider ? cfg.provider : "", available: false, reason: "not configured" };
  const d = detect(cfg, opts);
  let info = {};
  try { info = p.info ? p.info(ctxFor(cfg, opts)) : {}; } catch { info = {}; }
  return { provider: p.id, label: p.label, available: d.available, reason: d.available ? "" : d.reason || "", destination: info.destination || "", model: info.model || cfg.model || "", key: info.key || "" };
}

/**
 * run(cfg, { system, prompt, timeoutMs }, opts) → Promise<{ ok, text, error }>. `opts` =
 * { dataDir, env } (dataDir: where a claude-code token file / Anthropic key file would live).
 */
async function run(cfg, { system, prompt, timeoutMs }, opts = {}) {
  const p = providerOf(cfg);
  if (!p) return { ok: false, error: "No AI provider configured" };
  const d = detect(cfg, opts);
  if (!d.available) return { ok: false, error: d.reason || "the AI provider is not available" };
  try {
    return await p.run(ctxFor(cfg, opts), { system, prompt, timeoutMs: timeoutMs || cfg.timeoutMs || DEFAULT_TIMEOUT_MS });
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { ALLOWED, providerOf, ctxFor, detect, describe, run, providerFieldsFrom, DEFAULT_TIMEOUT_MS };
