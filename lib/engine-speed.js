"use strict";
/**
 * "Memory engine speed" (Memory cost panel): the real response time of the memory MCP server,
 * measured by the memglow MCP proxy (mcp-proxy/memglow-mcp-proxy.js) for each tool call — from
 * the moment the proxy forwards the request to the moment the matching response comes back — and
 * sent along with the activity it already reports (`durationMs`). memglow only stores
 * { type, ms, t }: the activity type (read / search / write) and the duration. Hooks send no
 * duration (an assistant hook is told nothing about how long a tool took).
 *
 * Validation (server side, `cleanDuration`): a finite number between 0 and MAX_MS (10 minutes),
 * rounded to the millisecond; anything else is dropped silently — the activity itself still counts.
 *
 * Summary over 7 days, per type: number of calls, p50 and p95 (nearest-rank percentiles).
 *
 * Slow-search alert (`alert`), deliberately simple and documented in the README:
 *   recent   = searches of the last 24 hours, baseline = searches of the 6 days before;
 *   alert when both have at least MIN_SAMPLES (10) calls AND the recent median is at least
 *   SLOW_FACTOR (2×) the baseline median AND at least SLOW_MIN_DELTA_MS (250 ms) slower.
 *   The absolute floor keeps a 20 ms → 45 ms change (noise on a fast local server) from alerting.
 *
 * Stored in memglow's data folder: <dataDir>/engine-speed.json (lib/event-log.js), 8 days kept,
 * at most 50,000 samples.
 */
const { createEventLog } = require("./event-log");

const FILE = "engine-speed.json";
const DAYS = 7;
const KEEP_MS = (DAYS + 1) * 86400000;
const MAX_SAMPLES = 50000;
const MAX_MS = 10 * 60 * 1000;
const TYPES = ["read", "search", "write"];
const RECENT_MS = 86400000;
const MIN_SAMPLES = 10;
const SLOW_FACTOR = 2;
const SLOW_MIN_DELTA_MS = 250;

/** A duration as sent by the proxy → integer milliseconds, or null if not acceptable. */
function cleanDuration(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_MS) return null;
  return Math.round(v);
}

function clean(e) {
  if (!e || typeof e !== "object" || !TYPES.includes(e.type) || !Number.isFinite(e.t)) return null;
  const ms = cleanDuration(e.ms);
  return ms == null ? null : { type: e.type, ms, t: Math.round(e.t) };
}

/** Nearest-rank percentile (p in 0..100) of numbers; null if empty. */
function percentile(list, p) {
  if (!list || !list.length) return null;
  const a = list.slice().sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * a.length));
  return a[Math.min(a.length, rank) - 1];
}

/** The slow-search alert, or null. `samples` = search samples of the last 7 days. */
function alert(samples, now) {
  const recent = [], base = [];
  for (const s of samples) {
    if (s.type !== "search") continue;
    if (now - s.t <= RECENT_MS) recent.push(s.ms);
    else if (now - s.t <= DAYS * 86400000) base.push(s.ms);
  }
  if (recent.length < MIN_SAMPLES || base.length < MIN_SAMPLES) return null;
  const r = percentile(recent, 50), b = percentile(base, 50);
  if (r >= SLOW_FACTOR * b && r - b >= SLOW_MIN_DELTA_MS) return { type: "search", recentMs: r, baselineMs: b, recentCalls: recent.length, baselineCalls: base.length };
  return null;
}

/** { days, types: { read|search|write: { calls, p50, p95 } }, total, alert } over 7 days. */
function summarize(samples, now) {
  const inWindow = (samples || []).filter((s) => now - s.t <= DAYS * 86400000);
  const types = {};
  for (const type of TYPES) {
    const ms = inWindow.filter((s) => s.type === type).map((s) => s.ms);
    types[type] = { calls: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95) };
  }
  return { days: DAYS, types, total: inWindow.length, alert: alert(inWindow, now) };
}

function createEngineSpeed({ dir, now = Date.now } = {}) {
  const log = createEventLog({ dir, file: FILE, keepMs: KEEP_MS, max: MAX_SAMPLES, clean, now, label: "memory engine speed" });
  return {
    /** One timed call: { type, ms, t }. Returns the stored sample or null (rejected). */
    add(evt) { return log.add({ type: evt && evt.type, ms: evt && evt.ms, t: evt && Number.isFinite(evt.t) ? evt.t : now() }); },
    summary(t = now()) { return summarize(log.events(t - DAYS * 86400000), t); },
    flush: () => log.flush(),
    version: log.version,
    file: log.file,
  };
}

module.exports = { createEngineSpeed, summarize, percentile, alert, cleanDuration, FILE, MAX_MS, MIN_SAMPLES, SLOW_FACTOR, SLOW_MIN_DELTA_MS };
