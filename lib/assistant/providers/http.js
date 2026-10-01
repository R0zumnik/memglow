"use strict";
/**
 * Shared plumbing of the HTTP providers (anthropic, openai-compatible).
 *
 *  - endpoint(url)  HTTPS required, except for a loopback address (127.0.0.0/8, ::1, localhost),
 *                   where plain http is fine: nothing leaves the machine. No credentials in the URL.
 *  - apiKey(ctx)    the key is read ONLY from an environment variable (MEMGLOW_ASSISTANT_API_KEY,
 *                   or the name in assistant.apiKeyEnv) or from a file in memglow's data folder
 *                   (default `assistant-api-key`) that only its owner can read (mode 600). Never
 *                   from memglow.config.json, never sent to the browser, never logged, never put in
 *                   an error message (every message goes through redact()).
 *  - post(...)      native fetch, no redirect followed (a redirect could carry the note elsewhere),
 *                   a time limit, a size limit on the answer, Server-Sent Events read as they come.
 *                   Clean, key-free errors for 401/403, 404, 429, 5xx.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_KEY_ENV = "MEMGLOW_ASSISTANT_API_KEY";
const DEFAULT_KEY_FILE = "assistant-api-key";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_KEY_BYTES = 4096;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

function isLoopback(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return h.split(".").every((x) => Number(x) <= 255);
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

/** → { ok: true, url, host, local } | { ok: false, reason }. `url` has no trailing slash. */
function endpoint(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return { ok: false, reason: "The provider URL is not a valid URL." }; }
  if (u.username || u.password) return { ok: false, reason: "The provider URL must not contain a user name or password: put the key in " + DEFAULT_KEY_ENV + "." };
  if (u.search || u.hash) return { ok: false, reason: "The provider URL must not contain a query string or a fragment." };
  const local = isLoopback(u.hostname);
  if (u.protocol === "http:" && !local) return { ok: false, reason: "Refused: " + u.host + " is not on this machine, so memglow requires https:// (your note would cross the network unencrypted)." };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "The provider URL must start with https:// (or http:// for a model on this machine)." };
  return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, ""), host: u.host, local };
}

/**
 * The API key. → { key, source: "env" | "file" | "", error? }. `error` means a key exists but
 * memglow refuses it (wrong file mode, bad variable name…): the provider is then unavailable.
 */
function apiKey({ config = {}, env = process.env, dataDir } = {}) {
  const envName = config.apiKeyEnv || DEFAULT_KEY_ENV;
  if (!ENV_NAME_RE.test(envName)) return { key: "", source: "", error: "assistant.apiKeyEnv must be the NAME of an environment variable (letters, digits, _), not the key itself." };
  const v = env[envName];
  if (typeof v === "string" && v.trim()) return { key: v.trim(), source: "env" };
  const fileName = config.apiKeyFile || DEFAULT_KEY_FILE;
  if (!FILE_NAME_RE.test(fileName)) return { key: "", source: "", error: "assistant.apiKeyFile must be a plain file name inside memglow's data folder." };
  if (!dataDir) return { key: "", source: "" };
  const file = path.join(dataDir, fileName);
  let st;
  try { st = fs.lstatSync(file); } catch { return { key: "", source: "" }; }
  if (!st.isFile()) return { key: "", source: "", error: "The key file " + file + " must be a regular file (not a link or a folder)." };
  if (process.platform !== "win32" && (st.mode & 0o077)) {
    return { key: "", source: "", error: "Refused: the key file " + file + " can be read by other users (mode " + (st.mode & 0o777).toString(8) + "). Run: chmod 600 " + file };
  }
  if (st.size > MAX_KEY_BYTES) return { key: "", source: "", error: "The key file " + file + " is too large to be an API key." };
  let k;
  try { k = fs.readFileSync(file, "utf8").trim(); } catch { return { key: "", source: "", error: "The key file " + file + " cannot be read." }; }
  if (!k) return { key: "", source: "" };
  if (/[\r\n]/.test(k)) return { key: "", source: "", error: "The key file " + file + " must hold the key alone, on one line." };
  return { key: k, source: "file" };
}

/** Removes the key (and anything shaped like an API key) from a message meant for the user. */
function redact(msg, key) {
  let s = String(msg == null ? "" : msg);
  if (key) s = s.split(key).join("[key]");
  return s
    .replace(/\b(?:sk|pk|rk|key|api|or|ant|gsk|xai)[-_][A-Za-z0-9_*.-]{6,}/gi, "[key]")
    .replace(/\b(?:Bearer|x-api-key:?)\s+\S+/gi, "[key]")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .slice(0, 300);
}

/** A short, key-free message for a non-2xx answer. `detail` = the provider's own message (may be ''). */
function httpError(status, host, detail, retryAfter) {
  const d = detail ? " (" + detail + ")" : "";
  if (status === 401) return "The API key was refused by " + host + " (HTTP 401): check the key you set for memglow.";
  if (status === 403) return host + " refused the request (HTTP 403): the key has no access to this model or API.";
  if (status === 404) return host + " answered HTTP 404: check the base URL and the model name" + d + ".";
  if (status === 429) return host + " is rate limiting or out of credit (HTTP 429)" + (retryAfter ? ": retry in " + retryAfter + " s" : ": try again later") + ".";
  if (status === 529 || status >= 500) return host + " had a server error (HTTP " + status + "): try again later.";
  return host + " refused the request (HTTP " + status + ")" + d + ".";
}

/** Server-Sent Events parser. push(text) → [{ event, data }]. */
function createSse() {
  let rest = "";
  let event = "", data = [];
  function line(l) {
    if (l === "") {
      const out = data.length ? [{ event: event || "message", data: data.join("\n") }] : [];
      event = ""; data = [];
      return out;
    }
    if (l.startsWith(":")) return [];
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    const value = i < 0 ? "" : l.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return [];
  }
  return {
    push(chunk) {
      rest += chunk;
      const out = [];
      let i;
      while ((i = rest.search(/\r?\n/)) >= 0) {
        const l = rest.slice(0, i);
        rest = rest.slice(rest[i] === "\r" ? i + 2 : i + 1);
        out.push(...line(l));
      }
      return out;
    },
    end() { const out = rest ? line(rest) : []; rest = ""; return out.concat(line("")); },
  };
}

/**
 * POSTs `body` (JSON) and reads the answer. `onEvent(obj)` gets each SSE `data` parsed as JSON
 * (or the whole JSON body if the server did not stream); it returns events like the CLI parsers:
 * { type: "text", text } | { type: "tool", name } | { type: "result", ok, error }.
 * Resolves { ok, text, error } — never rejects, never with the key in `error`.
 */
async function post({ url, host, headers, body, key, onEvent, onText, signal, timeoutMs = 600000, maxBytes = MAX_ANSWER_BYTES, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "This Node.js has no fetch: memglow needs Node 18 or later." };
  const ctl = new AbortController();
  let why = "";
  const stop = (w) => { if (!why) why = w; ctl.abort(); };
  const timer = setTimeout(() => stop("timed out"), timeoutMs);
  const onAbort = () => stop("cancelled");
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  let text = "", error = "", result = null;
  const tools = [];
  const handle = (events) => {
    for (const e of events || []) {
      if (e.type === "text") { text += e.text; if (onText) onText(e.text); }
      else if (e.type === "tool") tools.push(e.name);
      else if (e.type === "result") result = e;
    }
  };
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: ctl.signal });
    } catch (e) {
      if (why) return { ok: false, error: why };
      const cause = (e && e.cause) || {};
      const c = cause.code || (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code) || "";
      return { ok: false, error: redact("Could not reach " + host + (c ? " (" + c + ")" : "") + ".", key) };
    }
    if (res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: false, error: host + " answered with a redirect (HTTP " + res.status + "): memglow does not follow it. Check the base URL." };
    }
    const reader = res.body ? res.body.getReader() : null;
    const dec = new TextDecoder();
    let size = 0;
    const readAll = async (each) => {
      if (!reader) return;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { stop("answer too large"); try { await reader.cancel(); } catch { /* ignore */ } break; }
        each(dec.decode(value, { stream: true }));
      }
      each(dec.decode());
    };
    if (!res.ok) {
      let raw = "";
      try { await readAll((s) => { if (raw.length < 65536) raw += s; }); } catch { /* ignore */ }
      let detail = "";
      if (res.status !== 401 && res.status !== 403) {
        try {
          const o = JSON.parse(raw);
          const m = o && o.error && (typeof o.error === "string" ? o.error : o.error.message);
          if (typeof m === "string") detail = m.slice(0, 160);
        } catch { /* not JSON */ }
      }
      const ra = Number(res.headers.get("retry-after"));
      return { ok: false, error: redact(httpError(res.status, host, redact(detail, key), Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 0), key) };
    }
    const type = String(res.headers.get("content-type") || "");
    if (/text\/event-stream/i.test(type)) {
      const sse = createSse();
      const feed = (evts) => {
        for (const ev of evts) {
          if (ev.data === "[DONE]") continue;
          let o;
          try { o = JSON.parse(ev.data); } catch { continue; }
          handle(onEvent(o, ev.event));
        }
      };
      await readAll((s) => feed(sse.push(s)));
      feed(sse.end());
    } else {
      let raw = "";
      await readAll((s) => { raw += s; });
      if (!why) {
        let o;
        try { o = JSON.parse(raw); } catch { return { ok: false, error: host + " sent an answer memglow cannot read (not JSON)." }; }
        handle(onEvent(o, "json"));
      }
    }
  } catch (e) {
    if (!why) error = redact("Connection to " + host + " failed" + (e && e.name ? " (" + e.name + ")" : "") + ".", key);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (why) error = why;
  if (!error && tools.length) error = "the AI tried to use a tool (" + String(tools[0]).slice(0, 60) + "); memglow gives it none";
  if (!error && result && !result.ok) error = result.error || "error";
  if (!error && !result) error = "the answer from " + host + " ended before it was complete";
  return { ok: !error, text, error: redact(error, key) };
}

/** What the panel may know about an HTTP provider here (never the key). */
function describe(ep, k, { keyRequired }) {
  return {
    destination: ep && ep.ok ? ep.host : "",
    local: !!(ep && ep.ok && ep.local),
    key: k.key ? "set" : keyRequired ? "not set" : "not needed",
  };
}

module.exports = { endpoint, apiKey, redact, httpError, createSse, post, describe, isLoopback, DEFAULT_KEY_ENV, DEFAULT_KEY_FILE, MAX_ANSWER_BYTES };
