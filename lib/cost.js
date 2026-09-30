"use strict";
/**
 * Memory cost — how many tokens an assistant spends reading this memory, and which notes to split.
 *
 * Pure module: no fs, no HTTP. Inputs in, numbers out, so it is fully testable in Node.
 *
 * ESTIMATE — one formula, for a whole note as for one of its sections:
 *   estimateTokens(bytes) = ceil(bytes / 4)
 * It is an estimate (the page says "≈" everywhere), not a tokenizer: good enough to compare notes
 * with each other and to see where the reading goes. memglow promises no saving.
 *
 * COUNTERS (lib/counters.js) — per local day:
 *   days["YYYY-MM-DD"] = { notes: { <id>: { read, search, write } } }
 * A day missing from `days` means "no activity counted that day".
 *
 * Section titles are note content: they are only added when the caller says so (`withSections`,
 * i.e. when the viewer is allowed to see note bodies), after masking secret-looking lines.
 */

const LARGE_NOTE_TOKENS = 5000;  // "too large" threshold, ≈ 20 KB
const CHUNK_TOKENS = 2000;       // target size of each part in a split suggestion
const WINDOW_DAYS = 7;
const NEVER_READ_DAYS = 30;
const TOP_N = 10;
const NEVER_READ_MAX = 50;
const DAY_MS = 86400000;

/** Local calendar day ("YYYY-MM-DD") of a timestamp. */
function dayOf(t) {
  const d = new Date(t);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/** Day that is `n` calendar days before the day of `t` (DST-safe: works on local noon). */
function daysBefore(t, n) {
  const d = new Date(t);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return dayOf(d.getTime());
}

/** Token estimate: `input` is a byte count, or a string (measured in UTF-8 bytes). */
function estimateTokens(input) {
  const bytes = typeof input === "number" ? input : Buffer.byteLength(String(input == null ? "" : input), "utf8");
  return Math.ceil(Math.max(0, bytes || 0) / 4);
}

function codeRanges(text) {
  const out = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Sections of a note BODY (frontmatter already removed): [{ title, tokens }], cut at `##` to
 * `######` headings outside code blocks. `title` is "" for the text before the first heading.
 */
function sectionsOf(body) {
  const text = String(body || "");
  const code = codeRanges(text);
  const re = /^#{2,6}[ \t]+(\S.*)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    heads.push({ index: m.index, title: m[1].trim().slice(0, 120) });
  }
  if (!heads.length) {
    const tokens = estimateTokens(text);
    return tokens > 0 ? [{ title: "", tokens }] : [];
  }
  const out = [];
  const intro = text.slice(0, heads[0].index);
  if (intro.trim()) out.push({ title: "", tokens: estimateTokens(intro) });
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    out.push({ title: heads[i].title, tokens: estimateTokens(text.slice(heads[i].index, end)) });
  }
  return out;
}

/**
 * Groups CONSECUTIVE sections into parts of at most `max` tokens (greedy, in order: the same input
 * always gives the same answer). A single section larger than `max` is a part of its own.
 */
function packSections(sections, max) {
  const limit = max > 0 ? max : CHUNK_TOKENS;
  const parts = [];
  let cur = null;
  for (const s of sections || []) {
    if (cur && cur.tokens + s.tokens <= limit) {
      cur.titles.push(s.title);
      cur.tokens += s.tokens;
    } else {
      cur = { titles: [s.title], tokens: s.tokens };
      parts.push(cur);
    }
  }
  return parts;
}

/**
 * Aggregates the counters and the current notes.
 *   days   : counters (see top of file)
 *   notes  : [{ id, label, theme, subtheme, folder, bytes }] — index notes have theme "index"
 *   now    : timestamp
 *   opts   : { since: "YYYY-MM-DD" (first day counters existed), largeNoteTokens, chunkTokens,
 *              bodies: { id: body } (only when sections may be shown; secrets already masked) }
 */
function computeCost(days, notes, now, opts = {}) {
  const d = days && typeof days === "object" ? days : {};
  const large = opts.largeNoteTokens > 0 ? opts.largeNoteTokens : LARGE_NOTE_TOKENS;
  const chunk = opts.chunkTokens > 0 ? opts.chunkTokens : CHUNK_TOKENS;
  const bodies = opts.bodies || null;

  const byId = new Map((notes || []).map((n) => [n.id, n]));
  const isIndex = (n) => n && n.theme === "index";
  const regular = (notes || []).filter((n) => !isIndex(n));
  const tokensOf = (id) => { const n = byId.get(id); return n ? estimateTokens(n.bytes || 0) : 0; };

  const today = dayOf(now);
  const from7 = daysBefore(now, WINDOW_DAYS - 1);
  const from30 = daysBefore(now, NEVER_READ_DAYS - 1);

  let readToday = 0, read7 = 0, written7 = 0;
  const readTokens7 = new Map();
  const reads7 = new Map();
  for (const [day, o] of Object.entries(d)) {
    if (day < from7 || day > today || !o || !o.notes) continue;
    for (const [id, c] of Object.entries(o.notes)) {
      if (!byId.has(id)) continue; // deleted since: its size is unknown
      const t = tokensOf(id);
      const r = c.read || 0, w = c.write || 0;
      if (r > 0) {
        read7 += r * t;
        readTokens7.set(id, (readTokens7.get(id) || 0) + r * t);
        reads7.set(id, (reads7.get(id) || 0) + r);
        if (day === today) readToday += r * t;
      }
      if (w > 0) written7 += w * t;
    }
  }
  let writtenToday = 0;
  if (d[today] && d[today].notes) {
    for (const [id, c] of Object.entries(d[today].notes)) if (byId.has(id)) writtenToday += (c.write || 0) * tokensOf(id);
  }

  const item = (n) => ({
    id: n.id, label: n.label, theme: n.theme, subtheme: n.subtheme || "", folder: n.folder || "",
    tokens: estimateTokens(n.bytes || 0), reads7: reads7.get(n.id) || 0, readTokens7: readTokens7.get(n.id) || 0,
  });

  const top = [...readTokens7.entries()]
    .filter(([id]) => !isIndex(byId.get(id)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_N)
    .map(([id]) => item(byId.get(id)));
  const topSum = top.reduce((s, x) => s + x.readTokens7, 0);
  const share = top.length && read7 > 0 ? { notes: top.length, tokens: topSum, total: read7, percent: Math.round((topSum / read7) * 100) } : null;

  const tooLarge = regular
    .map(item)
    .filter((n) => n.tokens > large)
    .sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1));

  if (bodies) {
    for (const n of tooLarge.concat(top)) {
      if (n.sections || typeof bodies[n.id] !== "string") continue;
      n.sections = sectionsOf(bodies[n.id]);
      const parts = packSections(n.sections, chunk);
      n.split = parts.length > 1 ? parts : null;
    }
  }

  // Never read in 30 days: only once 30 days of counting exist; before that, say since when.
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.since || "")) ? opts.since : null;
  let neverRead = { available: false, since, notes: [], total: 0 };
  if (since && since <= from30) {
    const read = new Set();
    for (const [day, o] of Object.entries(d)) {
      if (day < from30 || day > today || !o || !o.notes) continue;
      for (const [id, c] of Object.entries(o.notes)) if ((c.read || 0) > 0) read.add(id);
    }
    const list = regular.filter((n) => !read.has(n.id)).map((n) => ({ id: n.id, label: n.label, theme: n.theme, tokens: estimateTokens(n.bytes || 0) }))
      .sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1));
    neverRead = { available: true, since, notes: list.slice(0, NEVER_READ_MAX), total: list.length };
  }

  const indexes = (notes || []).filter(isIndex).map((n) => ({ id: n.id, label: n.label, tokens: estimateTokens(n.bytes || 0) }));

  return {
    largeNoteTokens: large,
    chunkTokens: chunk,
    since,
    totals: {
      notes: regular.length,
      tokens: regular.reduce((s, n) => s + estimateTokens(n.bytes || 0), 0),
    },
    index: indexes.length ? { id: indexes[0].id, label: indexes[0].label, tokens: indexes.reduce((s, n) => s + n.tokens, 0) } : null,
    // complete7: false while counting started less than 7 days ago (figures "since …").
    read: { today: readToday, days7: read7, complete7: !(since && since > from7) },
    written: { today: writtenToday, days7: written7 },
    top,
    share,
    tooLarge,
    neverRead,
    sectionsIncluded: !!bodies,
  };
}

module.exports = {
  estimateTokens, sectionsOf, packSections, computeCost, dayOf, daysBefore,
  LARGE_NOTE_TOKENS, CHUNK_TOKENS, WINDOW_DAYS, NEVER_READ_DAYS,
};
