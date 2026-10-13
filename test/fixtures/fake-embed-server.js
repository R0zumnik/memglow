"use strict";
// Fake embeddings provider for the semantic search tests (test/semantic-search.test.js) — never a
// real model. Serves BOTH shapes lib/store/semantic.js knows how to call: Ollama's POST /api/embed
// ({model, input: [...]} → {embeddings: [[...], ...]}) and the OpenAI-compatible POST
// /v1/embeddings ({model, input: [...]} → {data: [{embedding: [...]}, ...]}). Deterministic:
// tokenises each input (lowercase letters/digits runs), folds a few synonyms to one canonical
// token (so "car"/"auto"/"automobile" land in the same hashed bucket — enough to exercise vector
// ranking without any real model), hashes each surviving token into one of `dim` buckets and
// L2-normalises the bag-of-words count vector. Requiring this file has no side effect.
const http = require("http");

const DEFAULT_SYNONYMS = {
  bike: "cycle", bikes: "cycle", bicycle: "cycle", bicycles: "cycle", velo: "cycle", velos: "cycle",
  dog: "canine", dogs: "canine", chien: "canine", chiens: "canine",
};

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function embedOne(text, { dim = 32, synonyms = DEFAULT_SYNONYMS } = {}) {
  const v = new Float32Array(dim);
  const tokens = String(text).toLowerCase().match(/[a-z0-9àâäéèêëîïôöùûüç]+/gu) || [];
  for (const t of tokens) {
    const canon = synonyms[t] || t;
    v[fnv1a(canon) % dim] += 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n) for (let i = 0; i < dim; i++) v[i] /= n;
  return [...v];
}

/**
 * createFakeEmbedServer({ dim, synonyms, delayMs, failing }) → { url, calls, requests, setFailing,
 * setDelayMs, close() }. `calls` counts embedding requests received (one call may embed several
 * texts — `requests` is the flat count of individual texts embedded, across all calls).
 * `setFailing(true)` makes every request answer 500 (provider "down"); `setDelayMs(ms)` adds a
 * response delay (timeout-fallback tests) — both can be changed between requests.
 */
function createFakeEmbedServer({ dim = 32, synonyms = DEFAULT_SYNONYMS, delayMs = 0, failing = false } = {}) {
  let calls = 0, requests = 0;
  let curDelay = delayMs, curFailing = failing;
  const server = http.createServer((req, res) => {
    // A caller with a short timeout (semantic.js's AbortController) aborts and closes its socket
    // long before a delayed fake answer is ready — swallow the resulting write error instead of
    // letting Node turn it into an uncaught exception that would take the whole test file down.
    req.on("error", () => {});
    res.on("error", () => {});
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const respond = () => {
        if (req.destroyed || res.writableEnded || res.destroyed) return; // the client already gave up
        try {
          if (curFailing) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "fake provider: forced failure" })); return; }
          let parsed;
          try { parsed = JSON.parse(body || "{}"); } catch { res.writeHead(400); res.end("{}"); return; }
          const texts = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input || "")];
          calls++; requests += texts.length;
          const vecs = texts.map((t) => embedOne(t, { dim, synonyms }));
          res.writeHead(200, { "content-type": "application/json" });
          if (req.url === "/v1/embeddings") res.end(JSON.stringify({ data: vecs.map((embedding) => ({ embedding })) }));
          else res.end(JSON.stringify({ embeddings: vecs }));
        } catch { /* the socket went away mid-write: nothing to do */ }
      };
      if (curDelay > 0) setTimeout(respond, curDelay); else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        get calls() { return calls; },
        get requests() { return requests; },
        setFailing: (v) => { curFailing = v; },
        setDelayMs: (ms) => { curDelay = ms; },
        close: () => new Promise((ok) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(ok); }),
      });
    });
  });
}

module.exports = { createFakeEmbedServer, embedOne, DEFAULT_SYNONYMS };
