"use strict";
/**
 * Provider: any OpenAI-compatible Chat Completions API — OpenAI, Mistral, OpenRouter, or a model
 * running on this machine (Ollama, LM Studio).
 *
 *   POST <baseUrl>/chat/completions
 *   headers: content-type: application/json, Authorization: Bearer <key> (only if a key is set:
 *            Ollama and LM Studio need none)
 *   body:    { model, messages: [{ role: "system", … }, { role: "user", content: <prompt> }],
 *              stream: true, max_tokens? }
 *
 * NO `tools` / `functions` field is sent; a tool call in the answer (delta.tool_calls,
 * finish_reason "tool_calls" / "function_call") is a failure anyway. Same prompt and same
 * validation as claude-code. `preset` fills the base URL:
 */
const http = require("./http");

const PRESETS = {
  openai: "https://api.openai.com/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

function settings(config = {}) {
  const base = config.baseUrl || PRESETS[config.preset] || "";
  return {
    ep: base ? http.endpoint(base) : { ok: false, reason: "Set assistant.baseUrl (or assistant.preset: " + Object.keys(PRESETS).join(", ") + ") for the openai-compatible provider." },
    model: config.model || "",
    maxTokens: Number(config.maxTokens) > 0 ? Math.floor(Number(config.maxTokens)) : 0,
  };
}

function detect(ctx = {}) {
  const s = settings(ctx.config);
  if (!s.ep.ok) return { available: false, detected: false, reason: s.ep.reason };
  const k = http.apiKey(ctx);
  if (k.error) return { available: false, detected: true, reason: k.error };
  if (!s.model) return { available: false, detected: true, reason: "Set assistant.model (the model name your server knows, e.g. llama3.1 for Ollama)." };
  if (!k.key && !s.ep.local) return { available: false, detected: true, reason: "No API key for " + s.ep.host + ": set " + ((ctx.config && ctx.config.apiKeyEnv) || http.DEFAULT_KEY_ENV) + ", or put the key alone in " + http.DEFAULT_KEY_FILE + " in memglow's data folder (chmod 600)." };
  return { available: true, detected: true };
}

function info(ctx = {}) {
  const s = settings(ctx.config);
  return { ...http.describe(s.ep, http.apiKey(ctx), { keyRequired: !(s.ep.ok && s.ep.local) }), model: s.model };
}

function finish(r) {
  if (!r) return [];
  if (r === "tool_calls" || r === "function_call") return [{ type: "tool", name: r }];
  if (r === "length") return [{ type: "result", ok: false, error: "the answer was cut off (length limit reached): raise assistant.maxTokens or use a model with a larger context" }];
  if (r === "content_filter") return [{ type: "result", ok: false, error: "the model's content filter stopped the answer" }];
  return [{ type: "result", ok: true }];
}

/** Maps one streamed chunk (or the whole non-streamed completion) to memglow's events. */
function events(o) {
  if (!o || typeof o !== "object") return [];
  if (o.error) {
    const t = typeof o.error === "object" && typeof (o.error.type || o.error.code) === "string" ? String(o.error.type || o.error.code).replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "error";
    return [{ type: "result", ok: false, error: "the API stopped with an error (" + t + ")" }];
  }
  const c = Array.isArray(o.choices) ? o.choices[0] : null;
  if (!c) return [];
  const out = [];
  const part = c.delta || c.message || {};
  if (typeof part.content === "string" && part.content) out.push({ type: "text", text: part.content });
  if ((Array.isArray(part.tool_calls) && part.tool_calls.length) || part.function_call) out.push({ type: "tool", name: "tool_calls" });
  return out.concat(finish(c.finish_reason));
}

async function run(ctx, { system, prompt, onText, signal, timeoutMs }) {
  const d = detect(ctx);
  if (!d.available) return { ok: false, error: d.reason };
  const { ep, model, maxTokens } = settings(ctx.config);
  const k = http.apiKey(ctx);
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (k.key) headers.authorization = "Bearer " + k.key;
  const body = { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], stream: true };
  if (maxTokens) body.max_tokens = maxTokens;
  // Only when set (AI settings): some models refuse the field, so it is never sent by default.
  if (typeof ctx.config.temperature === "number") body.temperature = ctx.config.temperature;
  return http.post({ url: ep.url + "/chat/completions", host: ep.host, headers, key: k.key, signal, timeoutMs, onText, body, onEvent: events, fetchImpl: ctx.fetch });
}

module.exports = {
  id: "openai-compatible",
  label: "OpenAI-compatible API (OpenAI, Mistral, OpenRouter, Ollama, LM Studio)",
  kind: "http",
  implemented: true,
  local: true,
  detect, run, info,
  PRESETS,
  _events: events,
};
