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

const PROVIDERS = {
  "claude-code": claudeCode,
  anthropic: planned("anthropic", "Anthropic API", null, "Not available in this build yet: use the claude-code provider."),
  "openai-compatible": planned("openai-compatible", "OpenAI-compatible API (OpenAI, Mistral, OpenRouter, Ollama, LM Studio)", null, "Not available in this build yet: use the claude-code provider."),
  codex: planned("codex", "Codex CLI", "codex", "Not supported yet: memglow has not verified a way to run it with no tool at all."),
  gemini: planned("gemini", "Gemini CLI", "gemini", "Not supported yet: memglow has not verified a way to run it with no tool at all."),
  cursor: planned("cursor", "Cursor CLI", "cursor-agent", "Not supported yet: its tool permissions are not reliable enough for unattended use."),
};

function get(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** Every known provider with its state here (for the panel). Never a secret. */
function list(ctx) {
  return Object.values(PROVIDERS).map((p) => {
    let d;
    try { d = p.detect(ctx); } catch { d = { available: false, detected: false }; }
    return { id: p.id, label: p.label, kind: p.kind, implemented: !!p.implemented, detected: !!d.detected, available: !!d.available, local: !!p.local };
  });
}

module.exports = { PROVIDERS, get, list };
