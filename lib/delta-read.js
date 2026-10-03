"use strict";
/**
 * delta-read (0.4.3 "cross-session delta reads", MCP proxy lever `deltaRead`,
 * lib/proxy-levers.js) — two mechanisms, both about not re-sending text the model has already
 * seen, that lever 4 (`dedupe`) cannot cover:
 *
 *  1. CROSS-SESSION: the owner's own usage log shows the hottest notes re-read in every new
 *     session (one note at ≈21 reads/7 days) — a brand new session has an EMPTY context, so a
 *     short "unchanged" stub (what `dedupe` sends for a re-read in the SAME session) would be
 *     wrong here: the model has never seen this note's text in this session. The first read of a
 *     note in a session therefore always gets the FULL current text (never shortened) — the only
 *     thing this mechanism adds is a one-line header, at most once, when the note changed since
 *     the LAST time this same client read it, in an EARLIER session: "memglow: changed since your
 *     last read on <date> — sections changed: <## titles>". This costs tokens (never saves any):
 *     it helps the model focus on what changed, it does not shorten anything. Needs to remember,
 *     per client, across process restarts — a small persisted ledger (createDeltaReadStore below).
 *  2. WITHIN-SESSION, note CHANGED: `dedupe` already handles "re-read, unchanged" (a stub). The
 *     gap is "re-read, CHANGED since this same session's own earlier full read" — today that
 *     falls through to a second full delivery. Since the model already has version A in its
 *     context (delivered earlier, this session), only the DIFF between A and the current version
 *     B needs to cross the wire — reusing lib/assistant/diff.js's line diff (prefix/suffix +
 *     bounded LCS), rendered as a compact, self-contained, line-oriented format (renderDiff below)
 *     that `applyDiff` can turn back into B given A, the same way bench/replay.js's correctness
 *     guard needs to: "the full text is reachable because A was delivered earlier this session,
 *     and this diff, applied to A, reconstructs B." Too large a diff (> DIFF_FALLBACK_RATIO of
 *     B) falls back to the full text instead — a diff is only worth it when it is actually small.
 *
 * Pure (no fs): sha1Hex, sectionFingerprints, changedSectionTitles, crossSessionHeader, renderDiff,
 *   applyDiff, DELTA_READ_MARKER, GAP_MARK, DIFF_FALLBACK_RATIO.
 * The only fs-touching piece: createDeltaReadStore (same house style as lib/negative-cache.js and
 *   lib/learned-aliases.js — atomic write, mode 600, bounded, debounced, never throws).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { diffLines, splitLines } = require("./assistant/diff");
const { sectionSpans, dayOf } = require("./cost");

const MAX_LEDGER_DEFAULT = 5000;
const MAX_DIFF_LINES = 400; // hard safety bound on the rendered diff's own line count
const DIFF_FALLBACK_RATIO = 0.6; // > this share of the CURRENT note's length -> deliver it in full instead
const MAX_SECTION_TITLES = 5;
// Self-describing markers: DELTA_READ_MARKER lets any reader (the real proxy, bench/replay.js's
// correctness guard, a future client-side helper) recognise "this content is a delta-read diff"
// without guessing from prose; GAP_MARK separates hunks (an unshown, unchanged stretch of the
// note lies between two hunks — present in both the before and after text, just not repeated).
const DELTA_READ_MARKER = "@@@memglow:delta-read@@@";
const GAP_MARK = "@@@memglow:gap@@@";

function sha1Hex(s) { return crypto.createHash("sha1").update(String(s == null ? "" : s)).digest("hex"); }

/**
 * Section fingerprints of a note's full text (frontmatter and all — same input lever `toc`
 * already runs sectionSpans() over, see lib/proxy-levers.js handleRead): [{ title, hash }], one
 * per span `lib/cost.js`'s sectionSpans() cuts (title "" = the untitled lead section). Pure.
 */
function sectionFingerprints(text) {
  const t = String(text == null ? "" : text);
  return sectionSpans(t).map((s) => ({ title: s.title, hash: sha1Hex(t.slice(s.start, s.end)) }));
}

/**
 * Titles of sections that changed between a PREVIOUS fingerprint list (as stored in the ledger)
 * and the CURRENT one — matched by title; a title present now but not before, or whose hash
 * differs from the matching previous title, counts as changed. Current order, capped to `max`.
 * "" (the untitled lead section) is reported as "(intro)", same label lever `toc` already uses
 * for it. Pure.
 */
function changedSectionTitles(prevSections, curSections, max = MAX_SECTION_TITLES) {
  const prevByTitle = new Map();
  for (const s of Array.isArray(prevSections) ? prevSections : []) if (s && typeof s.title === "string") prevByTitle.set(s.title, s.hash);
  const out = [];
  for (const s of Array.isArray(curSections) ? curSections : []) {
    if (!s || typeof s.title !== "string") continue;
    if (prevByTitle.get(s.title) !== s.hash) out.push(s.title || "(intro)");
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The cross-session header (mechanism 1) for THIS client's first read of a note in a NEW
 * session, or null when there is nothing to say: no ledger entry at all for this client+note
 * (never read before, by this client — nothing to compare against), or its stored hash still
 * matches the note's CURRENT full text (unchanged since). `prevEntry` is whatever the ledger
 * returned (`{ hash, time, sections }` or null); `curText` is the note's current full text, byte
 * for byte what the upstream server just answered with. Pure.
 */
function crossSessionHeader(prevEntry, curText, { max = MAX_SECTION_TITLES } = {}) {
  if (!prevEntry || typeof prevEntry.hash !== "string" || !prevEntry.hash || !Number.isFinite(prevEntry.time)) return null;
  const curHash = sha1Hex(curText);
  if (prevEntry.hash === curHash) return null;
  const titles = changedSectionTitles(prevEntry.sections, sectionFingerprints(curText), max);
  const tail = titles.length ? ` — sections changed: ${titles.join(", ")}` : "";
  return `memglow: changed since your last read on ${dayOf(prevEntry.time)}${tail}`;
}

/**
 * Renders a compact, bounded, self-describing diff of `before` -> `after` (mechanism 2): reuses
 * lib/assistant/diff.js's `diffLines` (common prefix/suffix + bounded LCS, grouped into hunks
 * with context) for the actual comparison, then renders each hunk as plain " "/"+"/"-" prefixed
 * lines (classic unified-diff style), hunks separated by GAP_MARK (never shown further apart than
 * `context` lines from a change, same as the source hunks). Always starts with DELTA_READ_MARKER
 * on its own line, so a reader can recognise "this is a delta-read diff" without any other clue.
 * `truncated: true` means MAX_DIFF_LINES was hit — the caller must not treat this text as
 * reconstructable (applyDiff on a truncated text returns null by construction: see below) and
 * should fall back to the full note instead. Pure.
 */
function renderDiff(before, after, { context = 3, maxLines = MAX_DIFF_LINES } = {}) {
  const d = diffLines(before, after, { context });
  const raw = [];
  d.hunks.forEach((h, hi) => {
    if (hi > 0) raw.push(GAP_MARK);
    for (const l of h.lines) raw.push((l.t === "+" ? "+" : l.t === "-" ? "-" : " ") + " " + l.s);
  });
  const truncated = raw.length > maxLines;
  const lines = truncated ? raw.slice(0, maxLines) : raw;
  return { text: DELTA_READ_MARKER + "\n" + lines.join("\n"), added: d.added, removed: d.removed, hunkCount: d.hunks.length, truncated };
}

/**
 * Reconstructs `after` from `before` and a diff rendered by renderDiff — the exact check
 * bench/replay.js's correctness guard needs ("full text reachable = version A delivered earlier
 * this session + this diff"). Each hunk's context+removed lines must appear, in order, as one
 * CONTIGUOUS run of `before`'s lines (guaranteed by construction when `diffText` really came from
 * renderDiff(before, after) unmodified) — located by a forward scan from where the previous hunk
 * left off, so two identical hunks never match out of order. Returns null — never throws — when
 * `diffText` does not start with DELTA_READ_MARKER, or any hunk cannot be located: a diff that
 * cannot be verified must never be treated as having reconstructed anything.
 */
function applyDiff(before, diffText) {
  const raw = String(diffText == null ? "" : diffText);
  if (!raw.startsWith(DELTA_READ_MARKER)) return null;
  const body = raw.slice(DELTA_READ_MARKER.length).replace(/^\n/, "");
  const bodyLines = body.length ? body.split("\n") : [];
  // The SAME line-splitting convention diffLines() itself used to produce this diff (lib/
  // assistant/diff.js's own `split`, exported as `splitLines`) — an empty `before` must mean
  // ZERO lines here too, or a hunk made of pure "+" lines (nothing from `before`) would wrongly
  // believe there is one (empty) line left over to copy at the end.
  const beforeLines = splitLines(before);
  const hunks = [[]];
  for (const l of bodyLines) {
    if (l === GAP_MARK) { hunks.push([]); continue; }
    hunks[hunks.length - 1].push(l);
  }
  const out = [];
  let pos = 0;
  for (const hunkRaw of hunks) {
    if (!hunkRaw.length) continue;
    const parsed = hunkRaw.map((l) => ({ t: l[0] === "+" || l[0] === "-" ? l[0] : " ", s: l.slice(2) }));
    const matchSeq = parsed.filter((l) => l.t !== "+").map((l) => l.s);
    let idx = -1;
    for (let i = pos; i + matchSeq.length <= beforeLines.length; i++) {
      let ok = true;
      for (let j = 0; j < matchSeq.length; j++) if (beforeLines[i + j] !== matchSeq[j]) { ok = false; break; }
      if (ok) { idx = i; break; }
    }
    if (idx < 0) return null; // this hunk cannot be located in `before`: not safely reconstructable
    for (let i = pos; i < idx; i++) out.push(beforeLines[i]); // an unshown, unchanged stretch
    let bp = idx;
    for (const l of parsed) {
      if (l.t === " ") { out.push(beforeLines[bp]); bp++; }
      else if (l.t === "-") bp++;
      else out.push(l.s);
    }
    pos = bp;
  }
  for (let i = pos; i < beforeLines.length; i++) out.push(beforeLines[i]);
  return out.join("\n") + "\n"; // notes are assumed to end with exactly one trailing newline
}

/** True when the rendered diff is small enough, and reconstructable, to deliver instead of the
 * full `afterText` — "> 60% of the note -> fall back to the full note" (ratio on character
 * length, the same unit the rest of this module already measures notes in bytes/tokens with). */
function worthDelivering(diff, afterText) {
  return !!diff && !diff.truncated && diff.text.length > 0 && diff.text.length <= DIFF_FALLBACK_RATIO * Math.max(1, String(afterText || "").length);
}

// ---------------------------------------------------------------------------------------------
// The persisted ledger (mechanism 1) — one small, atomic, bounded, mode-600 file, `delta-read.json`,
// next to `negative-cache.json`/`learned-aliases.json` in memglow's data folder: `{ version: 1,
// entries: { "<client>\u0000<noteId>": { hash, time, sections } } }`. Same house style as
// lib/negative-cache.js's createNegativeCacheStore: debounced atomic write, never throws — a
// write failure only means the header is never shown again for this client+note, the relay is
// never affected.

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function entryKey(client, noteId) { return `${client}\u0000${noteId}`; }
function isValidEntry(e) {
  return !!e && typeof e === "object" && typeof e.hash === "string" && e.hash && Number.isFinite(e.time)
    && (e.sections === undefined || (Array.isArray(e.sections) && e.sections.every((s) => s && typeof s.title === "string" && typeof s.hash === "string")));
}

/**
 * createDeltaReadStore({ dataDir, deltaRead, deltaReadMax }) -> { available, get, set, flush, size, file }
 * `available()` is false (every call a safe no-op) without a data folder, or with `deltaRead` off.
 */
function createDeltaReadStore(cfg = {}) {
  const dataDir = cfg.dataDir;
  const max = Number.isFinite(cfg.deltaReadMax) && cfg.deltaReadMax > 0 ? Math.floor(cfg.deltaReadMax) : MAX_LEDGER_DEFAULT;
  const enabled = !!(dataDir && cfg.deltaRead);
  const file = enabled ? path.join(dataDir, "delta-read.json") : null;
  const entries = new Map();
  if (file) {
    const raw = readJson(file);
    if (raw && raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries)) {
      for (const [k, v] of Object.entries(raw.entries)) if (isValidEntry(v)) entries.set(k, v);
    }
  }
  let timer = null, dirty = false;
  function save() {
    timer = null;
    if (!file || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* best effort: this header is never allowed to break the relay */ }
  }
  function schedule() {
    dirty = true;
    if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
  }
  function prune() {
    if (entries.size <= max) return;
    const sorted = [...entries.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
    for (let i = 0; i < sorted.length - max; i++) entries.delete(sorted[i][0]);
  }
  return {
    available: () => !!file,
    /** The ledger entry for this client+note, or null (never recorded, or disabled). */
    get(client, noteId) {
      if (!file) return null;
      return entries.get(entryKey(client, String(noteId))) || null;
    },
    /** Records/overwrites the entry for this client+note. A no-op when disabled. */
    set(client, noteId, entry) {
      if (!file || !isValidEntry(entry)) return;
      entries.set(entryKey(client, String(noteId)), entry);
      prune();
      schedule();
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    size: () => entries.size,
    file,
  };
}

module.exports = {
  MAX_LEDGER_DEFAULT, MAX_DIFF_LINES, DIFF_FALLBACK_RATIO, MAX_SECTION_TITLES,
  DELTA_READ_MARKER, GAP_MARK,
  sha1Hex, sectionFingerprints, changedSectionTitles, crossSessionHeader,
  renderDiff, applyDiff, worthDelivering,
  createDeltaReadStore,
};
