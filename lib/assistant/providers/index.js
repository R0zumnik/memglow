"use strict";
/**
 * Providers of the optional assistant: the AI that PROPOSES a change (memglow validates it, shows
 * the diff, and writes only what the user approved). One adapter per AI, the same way adapters/
 * holds one hook translator per assistant.
 *
 * A provider declares:
 *   id, label, kind ("cli" | "http"), implemented, local (can run without any cloud)
 *   detect(ctx)        → { available, detected, reason? }  (installed? configured? recent enough?)
 *   run(ctx, request)  → Promise<{ ok, text, error }>      request = { system, prompt, onText, signal, timeoutMs }
 * ctx = { config: <assistant config>, env, dataDir, workDir }.
 *
 * A provider must give the model NO TOOL: it receives the note in the prompt and answers with text
 * (a JSON proposal). Only providers where that can be enforced are implemented.
 */
const { which } = require("./cli");
const claudeCode = require("./claude-code");
const anthropic = require("./anthropic");
const openaiCompatible = require("./openai-compatible");

/** Listed (and detected) but not usable yet; `why` is shown in the panel. */
function planned(id, label, command, why) {
  return {
    id, label, kind: command ? "cli" : "http", implemented: false, local: false,
    detect({ env = process.env } = {}) {
      const found = command ? !!which(command, env) : false;
      return { available: false, detected: found, reason: why };
    },
    async run() { return { ok: false, error: why }; },
  };
}

/**
 * A local model server (Ollama, LM Studio) as a provider of its own, so it can be configured next to
 * a cloud `openai-compatible` one: same code, its own section (`assistant.ollama`), its preset URL
 * by default. Listed as "detected" only once configured (a model set), so the panel does not show
 * two idle rows to everyone.
 */
function localVariant(id, label) {
  const withPreset = (ctx = {}) => ({ ...ctx, config: { preset: id, ...(ctx.config || {}) } });
  return {
    ...openaiCompatible, id, label, local: true,
    detect(ctx = {}) {
      const d = openaiCompatible.detect(withPreset(ctx));
      return ctx.config && ctx.config.model ? d : { ...d, detected: false };
    },
    info(ctx) { return openaiCompatible.info(withPreset(ctx)); },
    run(ctx, req) { return openaiCompatible.run(withPreset(ctx), req); },
  };
}

const PROVIDERS = {
  "claude-code": claudeCode,
  anthropic,
  "openai-compatible": openaiCompatible,
  ollama: localVariant("ollama", "Ollama (on this machine)"),
  lmstudio: localVariant("lmstudio", "LM Studio (on this machine)"),
  codex: planned("codex", "Codex CLI", "codex", "Not supported yet: memglow has not verified a way to run it with no tool at all."),
  gemini: planned("gemini", "Gemini CLI", "gemini", "Not supported yet: memglow has not verified a way to run it with no tool at all."),
  cursor: planned("cursor", "Cursor CLI", "cursor-agent", "Not supported yet: its tool permissions are not reliable enough for unattended use."),
};

function get(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** Settings that belong to one provider: never carried over to another one. */
const OWN = ["model", "baseUrl", "preset", "apiKeyEnv", "apiKeyFile", "maxTokens", "command", "maxBudgetUsd",
  "temperature", "confirmRemote", "priceIn", "priceOut"];
// Shared by every provider, but a provider's own section may set its own value (AI settings).
const OVERRIDABLE = ["timeoutMinutes"];

/**
 * The settings a provider runs with: the top-level `assistant.model`, `baseUrl`, … apply to the
 * provider named in `assistant.provider`; a section named after a provider (`assistant.anthropic`,
 * `assistant["openai-compatible"]`, kept in `sections` by lib/config.js) applies to that provider
 * and wins. So several providers can be configured and picked in the panel.
 */
function configFor(ac = {}, id) {
  const out = {};
  for (const [k, v] of Object.entries(ac)) if (!OWN.includes(k) && k !== "sections") out[k] = v;
  if (ac.provider === id) for (const k of OWN) if (ac[k] != null && ac[k] !== "") out[k] = ac[k];
  const own = ac.sections && ac.sections[id];
  if (own && typeof own === "object") {
    for (const k of OWN) if (own[k] != null && own[k] !== "") out[k] = own[k];
    for (const k of OVERRIDABLE) if (own[k]) out[k] = own[k];
  }
  return out;
}

/**
 * Every known provider with its state here (for the panel). `ctxFor(id)` = the provider's ctx.
 * Never a secret: for HTTP providers, the destination host, whether it is on this machine, the
 * model, and the key only as "set" / "not set" / "not needed".
 */
function list(ctxFor) {
  return Object.values(PROVIDERS).map((p) => {
    const ctx = ctxFor(p.id);
    let d;
    try { d = p.detect(ctx); } catch { d = { available: false, detected: false }; }
    const row = { id: p.id, label: p.label, kind: p.kind, implemented: !!p.implemented, detected: !!d.detected, available: !!d.available, local: !!p.local, reason: p.implemented && !d.available ? String(d.reason || "") : "" };
    if (p.info) {
      try {
        const i = p.info(ctx);
        Object.assign(row, { destination: i.destination, local: i.local, key: i.key, model: i.model });
      } catch { /* left out */ }
    }
    // "Always ask before sending to a remote provider" (AI settings): on by default off this machine.
    const own = ctx && ctx.config ? ctx.config.confirmRemote : null;
    row.confirmRemote = !row.local && own !== false;
    return row;
  });
}

module.exports = { PROVIDERS, get, list, configFor };
