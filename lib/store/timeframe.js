"use strict";
/**
 * memglow memory server — timeframes ("7d", "24h", "2 weeks", "3 days ago", "last week",
 * "yesterday", "today", "2024-01-01", "January 5, 2026") → the epoch-ms instant they start at.
 * Returns null for text it cannot read (callers then fall back to their default).
 */
const UNIT_MS = {
  s: 1000, sec: 1000, second: 1000,
  m: 60000, min: 60000, minute: 60000,
  h: 3600000, hr: 3600000, hour: 3600000,
  d: 86400000, day: 86400000,
  w: 604800000, wk: 604800000, week: 604800000,
  mo: 2592000000, mon: 2592000000, month: 2592000000,
  y: 31536000000, yr: 31536000000, year: 31536000000,
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };

function unitMs(u) {
  const k = u.toLowerCase().replace(/s$/, "");
  return UNIT_MS[k] || null;
}

function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** parseTimeframe("7d", now) → epoch ms, or null. */
function parseTimeframe(input, now = Date.now()) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input)) return now - input * 86400000;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s === "today") return startOfDay(now);
  if (s === "yesterday") return startOfDay(now) - 86400000;
  if (s === "now") return now;
  let m = /^(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|ten)\s*([a-z]+)(?:\s+ago)?$/.exec(s);
  if (m) {
    const n = WORD_NUM[m[1]] != null ? WORD_NUM[m[1]] : Number(m[1]);
    const u = unitMs(m[2]);
    if (u != null && Number.isFinite(n)) return now - n * u;
  }
  m = /^(?:last|past|this)\s+(\d+\s+)?([a-z]+)$/.exec(s);
  if (m) {
    const u = unitMs(m[2]);
    if (u != null) return now - (m[1] ? Number(m[1]) : 1) * u;
  }
  // ISO date / date-time.
  if (/^\d{4}-\d{2}-\d{2}([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?$/i.test(s)) {
    const t = Date.parse(s.length === 10 ? s + "T00:00:00" : s.replace(" ", "T"));
    return Number.isFinite(t) ? t : null;
  }
  // "January 5, 2026", "jan 5", "5 january 2026", "January 1st".
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/.exec(s) || null;
  let month = null, day = null, year = null;
  if (m) { month = MONTHS.indexOf(m[1].slice(0, 3)); day = Number(m[2]); year = m[3] ? Number(m[3]) : null; }
  else {
    m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?(?:\s+(\d{4}))?$/.exec(s);
    if (m) { month = MONTHS.indexOf(m[2].slice(0, 3)); day = Number(m[1]); year = m[3] ? Number(m[3]) : null; }
  }
  if (month != null && month >= 0 && day >= 1 && day <= 31) {
    const y = year || new Date(now).getFullYear();
    let t = new Date(y, month, day).getTime();
    if (!year && t > now) t = new Date(y - 1, month, day).getTime();
    return t;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

module.exports = { parseTimeframe };
