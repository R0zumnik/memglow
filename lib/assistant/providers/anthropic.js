"use strict";
/**
 * Provider: the Anthropic Messages API, with the user's own key.
 *
 *   POST <baseUrl>/v1/messages     (baseUrl defaults to https://api.anthropic.com)
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *   body:    { model, max_tokens, system, messages: [{ role: "user", content: <prompt> }], stream: true }
 *
 * NO `tools` field is sent, so the model has no tool; a tool_use block in the answer is a failure
 * anyway. The prompt and the system prompt are exactly the ones built for claude-code
 * (lib/assistant/proposal.js), secret-looking lines already replaced by placeholders, and the
 * answer goes through the same parsing and validation. Format checked against
 * https://platform.claude.com/docs/en/api/messages (streaming events: message_start,
 * content_block_start, content_block_delta/text_delta, message_delta/stop_reason, message_stop,
 * ping, error).
 */
const http = require("./http");

const DEFAULT_BASE = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const DEFAULT_MAX_TOKENS = 32000;
const VERSION = "2023-06-01";

function settings(config = {}) {
  return {
    ep: http.endpoint(config.baseUrl || DEFAULT_BASE),
    model: config.model || DEFAULT_MODEL,
    maxTokens: Number(config.maxTokens) > 0 ? Math.floor(Number(config.maxTokens)) : DEFAULT_MAX_TOKENS,
  };
}

function detect(ctx = {}) {
  const { ep } = settings(ctx.config);
  if (!ep.ok) return { available: false, detected: false, reason: ep.reason };
  const k = http.apiKey(ctx);
  if (k.error) return { available: false, detected: true, reason: k.error };
  if (!k.key && !ep.local) return { available: false, detected: false, reason: "No Anthropic API key: set " + ((ctx.config && ctx.config.apiKeyEnv) || http.DEFAULT_KEY_ENV) + ", or put the key alone in " + http.DEFAULT_KEY_FILE + " in memglow's data folder (chmod 600)." };
  return { available: true, detected: true };
}

function info(ctx = {}) {
  const s = settings(ctx.config);
  return { ...http.describe(s.ep, http.apiKey(ctx), { keyRequired: !(s.ep.ok && s.ep.local) }), model: s.model };
}

/** Maps one streamed event (or the whole non-streamed message) to memglow's events. */
function events(o) {
  if (!o || typeof o !== "object") return [];
  switch (o.type) {
    case "content_block_start": {
      const b = o.content_block || {};
      if (b.type === "text") return b.text ? [{ type: "text", text: String(b.text) }] : [];
      if (/tool_use|tool_result|server_tool/.test(String(b.type))) return [{ type: "tool", name: String(b.name || b.type) }];
      return [];
    }
    case "content_block_delta": {
      const d = o.delta || {};
      if (d.type === "text_delta" && typeof d.text === "string") return [{ type: "text", text: d.text }];
      if (d.type === "input_json_delta") return [{ type: "tool", name: "tool input" }];
      return [];
    }
    case "message_delta": {
      const r = o.delta && o.delta.stop_reason;
      if (r === "tool_use") return [{ type: "tool", name: "tool_use" }];
      if (r === "max_tokens") return [{ type: "result", ok: false, error: "the answer was cut off (max_tokens reached): raise assistant.maxTokens or split the note by hand" }];
      if (r === "refusal") return [{ type: "result", ok: false, error: "the model declined to answer" }];
      return r ? [{ type: "result", ok: true }] : [];
    }
    case "error": {
      const t = o.error && typeof o.error.type === "string" ? o.error.type.replace(/[^a-z_]/g, "").slice(0, 40) : "error";
      return [{ type: "result", ok: false, error: "the API stopped with an error (" + t + ")" + (t === "overloaded_error" ? ": try again later" : "") }];
    }
    case "message": { // non-streamed answer
      const out = [];
      for (const b of Array.isArray(o.content) ? o.content : []) {
        if (b && b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
        else if (b && /tool/.test(String(b.type))) out.push({ type: "tool", name: String(b.name || b.type) });
      }
      return out.concat(events({ type: "message_delta", delta: { stop_reason: o.stop_reason || "end_turn" } }));
    }
    default: return [];
  }
}

async function run(ctx, { system, prompt, onText, signal, timeoutMs }) {
  const d = detect(ctx);
  if (!d.available) return { ok: false, error: d.reason };
  const { ep, model, maxTokens } = settings(ctx.config);
  const k = http.apiKey(ctx);
  const headers = { "content-type": "application/json", "anthropic-version": VERSION, accept: "text/event-stream" };
  if (k.key) headers["x-api-key"] = k.key;
  return http.post({
    url: ep.url + "/v1/messages", host: ep.host, headers, key: k.key, signal, timeoutMs, onText,
    body: { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }], stream: true },
    onEvent: events, fetchImpl: ctx.fetch,
  });
}

module.exports = {
  id: "anthropic",
  label: "Anthropic API (your key)",
  kind: "http",
  implemented: true,
  local: false,
  detect, run, info,
  DEFAULT_MODEL, DEFAULT_BASE,
  _events: events,
};
