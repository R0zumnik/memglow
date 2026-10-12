"use strict";
/**
 * MCP proxy levers — savings (levers 4/5) and per-client accounting (0.4.12.4 split of
 * lib/proxy-levers.js, see that file's own top comment for the full picture): the stderr journal
 * line, memglow's own proxy-savings.json data file, and the client-bucketing used by both it and
 * lever 7's exemption/accounting.
 */
const fs = require("fs");
const path = require("path");
const { CLIENTS } = require("../clients");
const { dayOf } = require("../cost");
const { readJson } = require("./config");
const { clientInfoKnown } = require("./hidden-tools");

// ---------------------------------------------------------------------------------------------
// Savings (levers 4 and 5) + per-client accounting: stderr journal line + memglow's own data file

/**
 * Bucket a session's `clientInfo` (set from `initialize`, see oneFromClient) into one of
 * lib/clients.js's known ids ("claude-code", "cursor", …) when the client's name or title
 * matches one, case-insensitively, by id or by label; else the client's own raw name/title
 * (trimmed, capped), so an unlisted tool still gets its own bucket instead of being lumped
 * together; else "unknown" (no name/title sent at all — never guessed). Purely informative:
 * never used for an access or security decision (unlike lever 7's clientInfoKnown/clientInfoAllowed).
 */
function clientBucket(ci) {
  const raw = (ci && typeof ci.name === "string" && ci.name.trim()) || (ci && typeof ci.title === "string" && ci.title.trim()) || "";
  if (!raw) return "unknown";
  const low = raw.toLowerCase();
  const known = CLIENTS.find((c) => low === c.id || low === c.label.toLowerCase());
  return known ? known.id : raw.slice(0, 60);
}

/**
 * 0.4.10.9 — the clientInfo a single MCP 2026-07-28 request carries in its own `_meta` envelope
 * (`io.modelcontextprotocol/clientInfo`, optional), normalised like `initialize`'s; else null.
 */
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
function metaClientInfo(params) {
  const meta = params && typeof params === "object" ? params._meta : null;
  const ci = meta && typeof meta === "object" && !Array.isArray(meta) ? meta[META_CLIENT_INFO] : null;
  if (!ci || typeof ci !== "object" || Array.isArray(ci)) return null;
  const out = { name: typeof ci.name === "string" ? ci.name : null, title: typeof ci.title === "string" ? ci.title : null, version: typeof ci.version === "string" ? ci.version : null };
  return clientInfoKnown(out) ? out : null;
}

/**
 * 0.4.10.9 — a stand-in clientInfo from an HTTP User-Agent header, for accounting only (never for
 * lever 7 or lever 8's exemption): its first product token ("claude-code/2.1.3 (…)" →
 * "claude-code"), which clientBucket() then maps to a known client id when it is one. null when
 * there is no usable token.
 */
function userAgentClientInfo(ua) {
  if (typeof ua !== "string") return null;
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._+-]{0,59})/.exec(ua);
  return m ? { name: m[1], title: null, version: null, fromUserAgent: true } : null;
}

/** Merges `{ clientBucket: { tokens, calls } }` maps (used when flushing `pending` into the file). */
function mergeClientCounts(base, add) {
  const out = { ...(base || {}) };
  for (const [name, v] of Object.entries(add || {})) {
    const cur = out[name] && typeof out[name] === "object" ? out[name] : { tokens: 0, calls: 0 };
    out[name] = { tokens: (Number(cur.tokens) || 0) + (Number(v.tokens) || 0), calls: (Number(cur.calls) || 0) + (Number(v.calls) || 0) };
  }
  return out;
}

function createSavings(cfg, write = (s) => process.stderr.write(s)) {
  const pending = {};
  let timer = null;
  const file = cfg.savingsFile && cfg.dataDir ? path.join(cfg.dataDir, "proxy-savings.json") : null;
  function save() {
    timer = null;
    if (!file) return;
    try {
      const cur = readJson(file) || {};
      const out = { version: 1, days: cur.days && typeof cur.days === "object" ? cur.days : {} };
      for (const [day, v] of Object.entries(pending)) {
        const o = out.days[day] && typeof out.days[day] === "object" ? out.days[day] : {};
        for (const k of ["dedupe", "toc", "alreadyLoaded", "deltaRead", "dedupeCalls", "tocCalls", "alreadyLoadedCalls", "deltaReadCalls"]) o[k] = (Number(o[k]) || 0) + (v[k] || 0);
        if (v.clients) o.clients = mergeClientCounts(o.clients, v.clients);
        out.days[day] = o;
        delete pending[day];
      }
      const keep = Object.keys(out.days).sort().slice(-90);
      out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* savings are informative only */ }
  }
  let total = { dedupe: 0, toc: 0, alreadyLoaded: 0, deltaRead: 0 };
  return {
    add(kind, tokens, id) {
      if (!(tokens > 0)) return;
      total[kind] = (total[kind] || 0) + tokens;
      if (cfg.log) { try { write(`memglow-mcp-proxy: ${kind} saved ≈${tokens} tokens${id ? ` on ${id}` : ""} (session total ≈${total.dedupe + total.toc + total.alreadyLoaded + total.deltaRead})\n`); } catch { /* ignore */ } }
      const day = dayOf(Date.now());
      const o = pending[day] || (pending[day] = {});
      o[kind] = (o[kind] || 0) + tokens;
      o[kind + "Calls"] = (o[kind + "Calls"] || 0) + 1;
      if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
    },
    /**
     * Baseline tokens relayed to this client for one read — BEFORE dedupe/toc shorten it, so two
     * clients reading the same notes compare on what memory they touched, not on which lever
     * happened to be on. Tallied per calendar day, per client bucket (clientBucket above).
     */
    addClient(clientInfo, tokens) {
      // 0.4.10.9: every tools/call is one call, even one whose answer is empty (0 tokens).
      tokens = Number(tokens);
      if (!Number.isFinite(tokens) || tokens < 0) tokens = 0;
      const name = clientBucket(clientInfo);
      const day = dayOf(Date.now());
      const o = pending[day] || (pending[day] = {});
      o.clients = o.clients || {};
      const cur = o.clients[name] || (o.clients[name] = { tokens: 0, calls: 0 });
      cur.tokens += tokens; cur.calls++;
      if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    total: () => ({ ...total }),
    file,
  };
}

const CLIENT_TOKENS_WINDOW_DAYS = 7;

/**
 * Reads the per-client baseline tokens createSavings/addClient wrote, summed over the last
 * `windowDays` days of <dataDir>/proxy-savings.json — for the Memory cost panel's "By AI tool"
 * line (server.js, `/api/cost`). Also, since 0.4.7.5 (Settings → Control, "Mesures"), `byLever`:
 * the SAME file's per-lever savings createSavings.add() already wrote (`dedupe`/`toc`/
 * `alreadyLoaded`/`deltaRead`, the only levers with a measurable per-call token saving — see that
 * function's own `kind` values), summed the same way over the same window; a day missing
 * `clients` entirely still contributes its lever figures (the two were always independent writes,
 * never gated on each other). Counts only, never note content. Absent, unreadable or empty file →
 * `{ days, byClient: {}, byLever: {} }` (an empty, still-valid answer, not an error); no `dataDir`
 * at all → null. Never throws.
 */
const SAVINGS_LEVER_KINDS = ["dedupe", "toc", "alreadyLoaded", "deltaRead"];
function readClientSavings(dataDir, { now = Date.now(), windowDays = CLIENT_TOKENS_WINDOW_DAYS } = {}) {
  if (!dataDir) return null;
  const raw = readJson(path.join(dataDir, "proxy-savings.json"));
  const byClient = {};
  const byLever = {};
  if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
    const from = dayOf(now - (windowDays - 1) * 86400000);
    const today = dayOf(now);
    for (const [day, o] of Object.entries(raw.days)) {
      if (day < from || day > today || !o || typeof o !== "object") continue;
      if (o.clients && typeof o.clients === "object") {
        for (const [name, v] of Object.entries(o.clients)) {
          if (!name || !v || typeof v !== "object") continue;
          const cur = byClient[name] || (byClient[name] = { tokens: 0, calls: 0 });
          cur.tokens += Number(v.tokens) || 0;
          cur.calls += Number(v.calls) || 0;
        }
      }
      for (const kind of SAVINGS_LEVER_KINDS) {
        const tokens = Number(o[kind]) || 0;
        const calls = Number(o[kind + "Calls"]) || 0;
        if (!tokens && !calls) continue;
        const cur = byLever[kind] || (byLever[kind] = { tokens: 0, calls: 0 });
        cur.tokens += tokens;
        cur.calls += calls;
      }
    }
  }
  return { days: windowDays, byClient, byLever };
}



module.exports = {
  clientBucket, metaClientInfo, userAgentClientInfo, mergeClientCounts, createSavings,
  CLIENT_TOKENS_WINDOW_DAYS, readClientSavings,
};
