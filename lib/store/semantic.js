"use strict";
/**
 * memglow memory server — optional, local-first SEMANTIC search: query/chunk embeddings fused
 * with the lexical engine (lib/store/search.js). OFF unless a provider is explicitly configured
 * (no embeddings model ships with memglow, no new dependency — the provider is an HTTP endpoint
 * the user already runs, or points at). When unconfigured every function here is a cheap no-op
 * and `configured()` is false, so lib/store/search.js's own behaviour is byte-identical to before
 * this module existed (see test/semantic-search.test.js "OFF by default").
 *
 * Providers (both are plain HTTP, no SDK — global `fetch`, Node >=18):
 *  - "ollama" (default once configured): POST {url}/api/embed, body { model, input: [...] },
 *    answer { embeddings: [[...], ...] } — https://ollama.com, models "nomic-embed-text",
 *    "bge-m3" (both multilingual FR/EN).
 *  - "openai": POST {url}/v1/embeddings (LM Studio, llama.cpp's server, or a hosted API), body
 *    { model, input: [...] }, answer { data: [{ embedding: [...] }, ...] }. `apiKeyEnv` names an
 *    environment variable holding the key (never a literal key in the config file, same rule as
 *    lib/config.js's own assistant settings) — PRIVACY: with this provider, the chunk/query text
 *    is sent to that endpoint; see the README section "Semantic search (optional)".
 *
 * Config: `search.semantic: { provider, url, model, apiKeyEnv, timeoutMs }` in memglow.config.json
 * (MEMGLOW_CONFIG or ~/.memglow only — never a ./memglow.config.json in a notes folder, same
 * trust boundary as lib/defaults.js's `allowCwd: false` everywhere else in the memory server),
 * plus env MEMGLOW_SEMANTIC_URL / MEMGLOW_SEMANTIC_MODEL / MEMGLOW_SEMANTIC_PROVIDER. "Configured"
 * means at least one of those is actually present — a default provider name alone never turns
 * this on.
 *
 * Storage: `<dataDir>/embeddings.json` (chunk keys, hashes, provider/model) + `embeddings.bin`
 * (one normalised Float32 vector per chunk, concatenated) — a disposable cache: a mismatch
 * (model changed, size inconsistent with the index) is discarded, never trusted half-way.
 *
 * Chunking: one chunk per note section (`## heading` + its text; the whole body when a note has
 * no headings), capped at ~400 tokens (≈1600 characters), longer sections split on paragraph
 * breaks. The embedding input is `title + description + heading + chunk text`; its sha1 is the
 * chunk's content hash — only a chunk whose hash changed since the last pass is re-embedded.
 *
 * Background only: `embedAllOnce()` (the full incremental pass) never runs on a search request —
 * it is scheduled after startup and, debounced, after the store's version changes (a write). The
 * one call that IS on the request path is embedding the QUERY itself (`embedQuery`, see
 * `mergeAsync`), bounded by a short timeout; a timeout or a down provider falls back to the
 * lexical-only ranking for that one query, logging the provider-down condition at most once.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const defaultsLib = require("../defaults");
const { terms } = require("./text");

const DEFAULTS = {
  ollama: { url: "http://localhost:11434", model: "nomic-embed-text" },
  openai: { url: "", model: "" },
};
const CHUNK_TOKENS = 400; // ≈ bytes / 4, same estimate the rest of the codebase uses
const CHUNK_CHARS = CHUNK_TOKENS * 4;
const BATCH_SIZE = 16; // texts per embedding request, background pass only
const RATE_LIMIT_MS = 150; // pause between background batches — never hammer the provider
const QUERY_TOP_K = 50; // vector candidates considered per query, before note-level pooling
const RRF_K = 60; // Reciprocal Rank Fusion constant (0.4.11.1-style: documented, not tuned-to-fit)
const DEFAULT_QUERY_TIMEOUT_MS = 800;
const DEFAULT_EMBED_TIMEOUT_MS = 15000; // background pass: generous, it is never on the request path
const DEFAULT_POLL_MS = 4000; // how often the background loop checks store.version()
const DEFAULT_DEBOUNCE_MS = 1500; // quiet time after a version change before re-embedding

/**
 * Settings: env > memglow.config.json (`search.semantic`), read the same trust-boundary way as
 * lib/levers/config.js's proxyConfig() — `allowCwd: false`: an untrusted notes folder's own
 * `./memglow.config.json` can never turn this on or point it at an attacker's endpoint. Never
 * throws.
 */
function resolveSemanticConfig(env = process.env, cwd = process.cwd()) {
  let cfg = {};
  try {
    const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
    cfg = defaultsLib.resolveConfigFiles({ env, cwd, home, allowCwd: false }).config || {};
  } catch { cfg = {}; }
  const search = cfg.search && typeof cfg.search === "object" && !Array.isArray(cfg.search) ? cfg.search : {};
  const s = search.semantic && typeof search.semantic === "object" && !Array.isArray(search.semantic) ? search.semantic : {};
  const str = (v, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
  // "Configured" needs an actual signal — a bare `"semantic": {}` placeholder (no provider/url/
  // model of its own) does NOT turn this on by itself; the three env vars always do, each alone.
  const configured = !!(str(env.MEMGLOW_SEMANTIC_URL) || str(env.MEMGLOW_SEMANTIC_MODEL) || str(env.MEMGLOW_SEMANTIC_PROVIDER) || str(s.provider) || str(s.url) || str(s.model));
  const providerRaw = (str(env.MEMGLOW_SEMANTIC_PROVIDER) || str(s.provider) || "ollama").toLowerCase();
  const provider = providerRaw === "openai" ? "openai" : "ollama"; // anything else: fall back to ollama's shape
  const base = defaultsLib.resolveBase(env, cwd);
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const dataDir = path.resolve(base, env.MEMGLOW_DATA_DIR || cfg.dataDir || home);
  const def = DEFAULTS[provider];
  return {
    configured,
    provider,
    url: (str(env.MEMGLOW_SEMANTIC_URL) || str(s.url) || def.url).replace(/\/+$/, ""),
    model: str(env.MEMGLOW_SEMANTIC_MODEL) || str(s.model) || def.model,
    apiKeyEnv: str(s.apiKeyEnv, 64), // never a literal key — only an env var NAME, read from the file
    queryTimeoutMs: defaultsLib.resolveInt(undefined, undefined, s.timeoutMs, DEFAULT_QUERY_TIMEOUT_MS, 50, 20000),
    embedTimeoutMs: defaultsLib.resolveInt(undefined, undefined, s.embedTimeoutMs, DEFAULT_EMBED_TIMEOUT_MS, 1000, 120000),
    dataDir,
  };
}

/** sha1 hex — the chunk's content-hash key (cheap, not a security boundary). */
function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }

/** A body split on blank-line paragraph breaks into pieces of at most `maxChars` (word-ish, no
 * mid-token cuts beyond a hard wrap for a single giant paragraph). Deterministic. */
function splitLong(text, maxChars) {
  const paras = text.split(/\n{2,}/);
  const out = [];
  let cur = "";
  for (const p of paras) {
    const candidate = cur ? cur + "\n\n" + p : p;
    if (candidate.length > maxChars && cur) { out.push(cur.trim()); cur = p; } else cur = candidate;
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars).trim()); cur = cur.slice(maxChars); }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text.slice(0, maxChars)];
}

/**
 * One note → its chunks: `{ key, heading, text, embedInput, hash }[]`. `key` is stable across
 * passes as long as the note's own section order and split points do not change (permalink +
 * section index + part index) — a key that disappears is pruned from the vector store on the
 * next full pass; a changed `hash` is the only trigger for re-embedding.
 */
function chunkNote(note) {
  const lines = note.lines;
  const secs = note.sections.length ? note.sections : [{ heading: note.title, start: 0, end: lines.length }];
  const raw = [];
  secs.forEach((s, si) => {
    const text = lines.slice(s.start, s.end).join("\n").trim();
    if (!text) return;
    const parts = text.length <= CHUNK_CHARS ? [text] : splitLong(text, CHUNK_CHARS);
    parts.forEach((p, pi) => raw.push({ idx: si, part: pi, heading: s.heading, text: p }));
  });
  if (!raw.length) return [];
  return raw.map((c) => {
    const key = note.permalink + "#" + c.idx + "." + c.part;
    const embedInput = [note.title, note.description, c.heading && c.heading !== note.title ? c.heading : "", c.text]
      .filter(Boolean).join("\n\n").slice(0, CHUNK_CHARS * 2);
    return { key, heading: c.heading, text: c.text, embedInput, hash: sha1(embedInput) };
  });
}

/** In place: v / ||v||2 (a zero vector is returned unchanged — never divide by zero). */
function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!n || !Number.isFinite(n)) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** One HTTP call to the configured provider, `texts.length` embeddings back, same order. Throws
 * on a non-OK answer, a bad shape, or the timeout (AbortController) — the caller decides what a
 * failure means (background: stop this pass; query: fall back to lexical). */
async function embedBatch(texts, cfg, { timeoutMs, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("global fetch is not available (Node < 18?)");
  if (!cfg.url || !cfg.model) throw new Error("semantic search: no url/model configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    let res;
    if (cfg.provider === "openai") {
      const headers = { "content-type": "application/json" };
      const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : "";
      if (key) headers.authorization = "Bearer " + key;
      res = await fetchImpl(cfg.url + "/v1/embeddings", { method: "POST", headers, body: JSON.stringify({ model: cfg.model, input: texts }), signal: ctrl.signal });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      const j = await res.json();
      const data = Array.isArray(j && j.data) ? j.data : null;
      if (!data || data.length !== texts.length) throw new Error("embeddings: unexpected response shape");
      return data.map((d) => Float32Array.from(d.embedding || []));
    }
    res = await fetchImpl(cfg.url + "/api/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: cfg.model, input: texts }), signal: ctrl.signal });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const j = await res.json();
    const embeddings = Array.isArray(j && j.embeddings) ? j.embeddings : (j && Array.isArray(j.embedding) ? [j.embedding] : null);
    if (!embeddings || embeddings.length !== texts.length) throw new Error("embed: unexpected response shape");
    return embeddings.map((e) => Float32Array.from(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Reciprocal Rank Fusion of two RANKED key lists (1-based rank, best first) → fused score per
 * key present in either list, highest first. Pure, exported for its own unit tests. */
function rrf(lexicalKeysRanked, vectorKeysRanked, k = RRF_K) {
  const score = new Map();
  lexicalKeysRanked.forEach((key, i) => score.set(key, (score.get(key) || 0) + 1 / (k + i + 1)));
  vectorKeysRanked.forEach((key, i) => score.set(key, (score.get(key) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key, s]) => ({ key, score: s }));
}

/** Binary JSON+bin persistence: `{ version, provider, model, dim, entries: [{key, permalink,
 * heading, hash}] }` + one Float32 vector per entry, same order, in the .bin file. Mismatched
 * sizes or a different provider/model are discarded — never half-trusted. */
function loadVectors(dataDir, cfg) {
  const jsonFile = path.join(dataDir, "embeddings.json");
  const binFile = path.join(dataDir, "embeddings.bin");
  const map = new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(jsonFile, "utf8")); } catch { return map; }
  if (!raw || typeof raw !== "object" || raw.provider !== cfg.provider || raw.model !== cfg.model || !Array.isArray(raw.entries) || !(raw.dim > 0)) return map;
  let bin;
  try { bin = fs.readFileSync(binFile); } catch { return map; }
  const dim = raw.dim;
  if (bin.length !== raw.entries.length * dim * 4) return map;
  for (let i = 0; i < raw.entries.length; i++) {
    const e = raw.entries[i];
    if (!e || typeof e.key !== "string" || typeof e.hash !== "string") continue;
    const off = i * dim * 4;
    const vector = new Float32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + dim * 4));
    map.set(e.key, { vector, hash: e.hash, permalink: e.permalink, heading: e.heading || "" });
  }
  return map;
}

function saveVectors(dataDir, cfg, map) {
  const entries = [];
  const dim = map.size ? map.values().next().value.vector.length : 0;
  const buf = Buffer.alloc(map.size * dim * 4);
  let i = 0;
  for (const [key, v] of map) {
    entries.push({ key, permalink: v.permalink, heading: v.heading, hash: v.hash });
    Buffer.from(v.vector.buffer, v.vector.byteOffset, v.vector.byteLength).copy(buf, i * dim * 4);
    i++;
  }
  const json = JSON.stringify({ version: 1, provider: cfg.provider, model: cfg.model, dim, savedAt: Date.now(), entries });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // json written BEFORE bin, pointing at the content about to be written: a crash between the
    // two leaves a json whose entry count/dim will not match the OLD bin's byte length (the size
    // check in loadVectors above), so a half-written pair is discarded wholesale, never misread
    // key-to-vector (see this module's header comment, "Storage").
    const jsonTmp = path.join(dataDir, ".embeddings.json.tmp");
    fs.writeFileSync(jsonTmp, json);
    fs.renameSync(jsonTmp, path.join(dataDir, "embeddings.json"));
    const binTmp = path.join(dataDir, ".embeddings.bin.tmp");
    fs.writeFileSync(binTmp, buf);
    fs.renameSync(binTmp, path.join(dataDir, "embeddings.bin"));
  } catch { /* best effort: the cache rebuilds from the provider next pass */ }
}

const INERT = {
  configured: () => false,
  embedQuery: async () => null,
  mergeAsync: async ({ lexicalHits }) => lexicalHits,
  embedAllOnce: async () => {},
  stats: () => ({ configured: false, chunks: 0 }),
  start: () => {},
  stop: () => {},
};

/**
 * createSemanticSearch({ store, env, cwd, log, autostart, fetchImpl, pollMs, debounceMs }) →
 * engine. `store` is lib/store/store.js's own store (notes()/version()). Fully self-configuring
 * (reads env/config the same way lib/levers/config.js's proxyConfig() does) — a caller normally
 * passes nothing but `store`. When not configured, every method is the shared INERT no-op object
 * above: no timer, no fs access, no behaviour change at all (see this module's header comment).
 */
function createSemanticSearch({ store, env = process.env, cwd = process.cwd(), log = () => {}, autostart = true, fetchImpl = global.fetch, pollMs = DEFAULT_POLL_MS, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const cfg = resolveSemanticConfig(env, cwd);
  if (!cfg.configured) return INERT;

  let vectors = loadVectors(cfg.dataDir, cfg);
  let warnedDown = false;
  let dirty = false;
  let embedding = false; // one background pass at a time
  let lastVersion = -1;
  let pollTimer = null, debounceTimer = null;
  let closed = false;

  const warnOnce = (e) => {
    if (warnedDown) return;
    warnedDown = true;
    log(`memglow memory server: semantic search provider unreachable (${cfg.provider} ${cfg.url}): ${e && e.message} — serving lexical search only until it recovers`);
  };

  async function embedAllOnce() {
    if (closed || embedding) return;
    embedding = true;
    try {
      const wanted = new Map();
      for (const n of store.notes()) {
        for (const c of chunkNote(n)) wanted.set(c.key, { ...c, permalink: n.permalink });
      }
      let pruned = false;
      for (const key of vectors.keys()) if (!wanted.has(key)) { vectors.delete(key); pruned = true; }
      const todo = [];
      for (const [key, c] of wanted) {
        const existing = vectors.get(key);
        if (!existing || existing.hash !== c.hash) todo.push(c);
      }
      if (!todo.length) { if (pruned) saveVectors(cfg.dataDir, cfg, vectors); return; }
      for (let i = 0; i < todo.length && !closed; i += BATCH_SIZE) {
        const batch = todo.slice(i, i + BATCH_SIZE);
        let vecs;
        try { vecs = await embedBatch(batch.map((b) => b.embedInput), cfg, { timeoutMs: cfg.embedTimeoutMs, fetchImpl }); }
        catch (e) { warnOnce(e); return; } // provider down mid-pass: keep what we have, retry next pass
        warnedDown = false; // a successful call: the provider is back
        batch.forEach((b, j) => { const v = vecs[j]; if (v && v.length) vectors.set(b.key, { vector: normalize(v), hash: b.hash, permalink: b.permalink, heading: b.heading }); });
        dirty = true;
        if (i + BATCH_SIZE < todo.length) await new Promise((ok) => setTimeout(ok, RATE_LIMIT_MS));
      }
      if (dirty || pruned) { saveVectors(cfg.dataDir, cfg, vectors); dirty = false; }
    } catch { /* never throw out of the background loop */ }
    finally { embedding = false; }
  }

  function scheduleDebounced() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; embedAllOnce(); }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  function pollLoop() {
    if (closed) return;
    try {
      const v = store.version();
      if (v !== lastVersion) { lastVersion = v; scheduleDebounced(); }
    } catch { /* store not ready yet: next tick */ }
    pollTimer = setTimeout(pollLoop, pollMs);
    if (pollTimer.unref) pollTimer.unref();
  }

  function start() {
    if (pollTimer || closed) return;
    // First pass after a short delay (let the store finish its own initial scan), then poll.
    const t = setTimeout(() => { if (!closed) embedAllOnce(); }, Math.min(pollMs, 1000));
    if (t.unref) t.unref();
    pollTimer = setTimeout(pollLoop, pollMs);
    if (pollTimer.unref) pollTimer.unref();
  }

  function stop() {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    pollTimer = null; debounceTimer = null;
  }

  /** Query embedding, short timeout — null (never throws) on a timeout or a down provider. */
  async function embedQuery(text, { timeoutMs } = {}) {
    try {
      const [v] = await embedBatch([text], cfg, { timeoutMs: timeoutMs || cfg.queryTimeoutMs, fetchImpl });
      warnedDown = false;
      return v && v.length ? normalize(v) : null;
    } catch (e) { warnOnce(e); return null; }
  }

  /** Cosine top-k over the in-memory vectors (brute force — fine for the thousands-of-chunks
   * scale this is designed for; see bench/semantic-eval.js for a real measurement). */
  function vectorSearch(qVec, topK = QUERY_TOP_K) {
    const out = [];
    for (const [key, v] of vectors) {
      const vec = v.vector;
      let dot = 0;
      const n = Math.min(qVec.length, vec.length);
      for (let i = 0; i < n; i++) dot += qVec[i] * vec[i];
      out.push({ key, permalink: v.permalink, score: dot });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  /**
   * mergeAsync({ type, query, lexicalHits, docs, timeoutMs }) → Promise<hit[]> — `hits` in the
   * same shape lib/store/search.js's own textHits() produces (`{ kind: "entity", note, score,
   * key, match, qterms }`), ready to be concatenated with observation/relation hits and sorted,
   * paginated and snippet'd exactly as before. `docs` is the ALREADY FILTERED candidate set (note
   * filters/tags/metadata/date applied) — a vector hit outside it is dropped, so filters keep
   * meaning whatever the search_type.
   *
   * - "vector" / "semantic": pure vector ranking (lexicalHits ignored for ranking, only used as a
   *   fallback on a timeout/down provider).
   * - "hybrid": Reciprocal Rank Fusion of the lexical ranking and the vector ranking.
   * A null query embedding (timeout or provider down) returns `lexicalHits` unchanged — the
   * caller never sees a rejected promise from this path.
   */
  async function mergeAsync({ type, query, lexicalHits, docs, timeoutMs }) {
    const qVec = await embedQuery(query, { timeoutMs });
    if (!qVec) return lexicalHits;
    const allowed = new Map(docs.map((d) => [d.note.permalink, d]));
    const raw = vectorSearch(qVec, QUERY_TOP_K).filter((r) => allowed.has(r.permalink));
    // Max-pool chunk scores up to one entry per note.
    const byNote = new Map();
    for (const r of raw) { const prev = byNote.get(r.permalink); if (!prev || r.score > prev.score) byNote.set(r.permalink, r); }
    const vectorRanked = [...byNote.values()].sort((a, b) => b.score - a.score);
    const qterms = [...new Set(terms(query))];
    const buildVectorOnly = (permalink, score) => {
      const d = allowed.get(permalink);
      return d ? { kind: "entity", note: d.note, score, key: permalink, match: "", qterms } : null;
    };

    if (type === "vector" || type === "semantic") {
      const out = [];
      for (const v of vectorRanked) { const h = buildVectorOnly(v.permalink, v.score); if (h) out.push(h); }
      return out;
    }

    // hybrid: RRF over the two RANKED key lists.
    const lexicalRankedKeys = lexicalHits.map((h) => h.key);
    const vectorRankedKeys = vectorRanked.map((v) => v.permalink);
    const fused = rrf(lexicalRankedKeys, vectorRankedKeys, RRF_K);
    const byKey = new Map(lexicalHits.map((h) => [h.key, h]));
    const out = [];
    for (const f of fused) {
      const base = byKey.get(f.key);
      if (base) out.push({ ...base, score: f.score });
      else { const h = buildVectorOnly(f.key, f.score); if (h) out.push(h); }
    }
    return out;
  }

  function stats() {
    return { configured: true, provider: cfg.provider, model: cfg.model, url: cfg.url, chunks: vectors.size, notes: new Set([...vectors.values()].map((v) => v.permalink)).size, down: warnedDown };
  }

  if (autostart) start();

  return { configured: () => true, embedQuery, mergeAsync, embedAllOnce, stats, start, stop };
}

module.exports = {
  createSemanticSearch, resolveSemanticConfig, chunkNote, rrf, normalize, embedBatch,
  loadVectors, saveVectors, splitLong, sha1, RRF_K, CHUNK_TOKENS, CHUNK_CHARS,
};
