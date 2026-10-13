"use strict";
/**
 * MCP proxy levers — lever 17, stateView ("journal → current state view"). A note the owner keeps
 * appending dated sections to ("## Mise à jour 12/10", "## État au 5/10 soir", "## Chantier en
 * cours (2026-10-11)"…) grows forever, but only the latest state usually matters. This lever never
 * writes anything (memglow never writes a note on its own — see lib/proxy-levers.js's own top
 * comment): it only shapes what a `read_note`-style call gets back, same as lever 5 (toc).
 *
 * Pure module (no fs, no network): `buildStateView(text, opts)` is the one entry point
 * lib/proxy-levers.js calls; everything else here is exported for tests (detection, year
 * inference, ordering) and for the measurement script this stage also runs by hand (never
 * committed) against a real memory copy.
 *
 * DETECTION — a note is "journal-like" when:
 *  - it is larger than `opts.minTokens` (default STATE_VIEW_DEFAULT_TOKENS, config
 *    `stateViewTokens` / MEMGLOW_PROXY_STATE_VIEW_TOKENS — a SEPARATE, smaller threshold than
 *    lever 1/5's own `largeNoteTokens`, since a journal note is worth shrinking well before it
 *    is "too large" outright);
 *  - AND it has at least `opts.minDatedSections` (default STATE_VIEW_MIN_DATED_SECTIONS = 3)
 *    `##`-`######` sections whose HEADING carries a date `extractHeadingDate()` can parse — FR or
 *    EN, numeric or named: `2026-10-12`, `12/10/2026`, `12/10`, `5/10 soir`, `12 oct.`, "Oct 12,
 *    2026"… Keywords such as "Mise à jour"/"État au"/"Update"/"as of" are never required: they
 *    are just what the owner's own headings happen to read like around the date itself, which
 *    the regexes below find regardless of whatever words sit next to it. A heading matching more
 *    than one pattern, or none, costs nothing to the overall result: it only changes whether that
 *    ONE section counts as dated.
 *
 * YEAR INFERENCE — a heading with no year ("12/10") is anchored against the note's own mtime
 * (`opts.mtimeMs`) walking BACKWARD through the document (last section first): the latest
 * yearless date can be no later than `mtimeMs`'s own calendar day (a file cannot contain, as of
 * its last save, a date later than that save); each earlier yearless date can be no later than
 * the date just inferred for the section after it — this is the "order" half of the task's own
 * "infer the year from the note's mtime / order". A heading that DOES carry a year is always
 * trusted outright and becomes the new anchor for anything still earlier in the document.
 *
 * OUTPUT (handleRead in lib/proxy-levers.js builds the two content blocks from the fields below):
 *   1. `kept`    — the frontmatter + intro (everything before the first dated section) followed
 *                  by every UNDATED section (rules, decisions, a "## Parts" list…) followed by
 *                  the `recentCount` (default STATE_VIEW_RECENT_COUNT = 2) most recent dated
 *                  sections, IN FULL, each verbatim (heading included) — concatenated in the
 *                  order they already have in the note, never reordered.
 *   2. `summary` — ONE line naming exactly how many older dated sections were left out, their
 *                  combined ≈tokens, and their headings, plus how to get any of them back
 *                  (`memglow_section`) or the whole note (`memglow_fresh`). Never silent.
 * FAIL OPEN (returns null — the caller then falls through to toc/full delivery, unchanged) when:
 *   - the note is not larger than `minTokens`;
 *   - fewer than `minDatedSections` headings parse as dates;
 *   - the composed `kept` + `summary` would not save at least `minSavingsRatio` (default
 *     STATE_VIEW_MIN_SAVINGS_RATIO = 0.3, i.e. 30 %) of the note's own ≈tokens — a journal shape
 *     with almost nothing to drop (few/short older sections) is not worth the extra moving part.
 * Never throws: `sectionSpans`/date parsing failures are caught by the caller the same way every
 * other lever's own try/catch already protects the relay (lib/proxy-levers.js's golden rule).
 *
 * ORDER WITH OTHER LEVERS (see lib/proxy-levers.js handleRead for the exact placement):
 *  - stateView is tried AFTER dedupe (4) and deltaRead's within-session diff (13), and BEFORE toc
 *    (5) — "stateView applies before toc" per the task: a plain read of a journal-shaped note
 *    never also gets toc's own big-note outline on top. dedupe/deltaRead come first because they
 *    only ever match a note THIS session already delivered in FULL (`s.delivered`/`s.deltaText`
 *    are set only on a full delivery, never on a stateView or toc answer) — when that is true the
 *    model already has the real content to dedupe/diff against, which is strictly better than a
 *    fresh state-view recomputation; stateView only gets a turn when there is nothing to
 *    dedupe/diff against yet (first read this session, or the previous read here was itself
 *    partial).
 *  - deltaRead's mechanism 2 (within-session diff) therefore NEVER diffs against a state-viewed
 *    answer: a stateView reply never populates `s.delivered`/`s.deltaText` (same convention as
 *    toc), so the next read either repeats (forced full — the escape hatch every shortening lever
 *    shares) or is itself re-evaluated for stateView/toc from scratch. This is the safe choice
 *    the task asks to pick explicitly: diffing against a PARTIAL text could manufacture a "change"
 *    out of content that was simply never sent, or hide a real change that fell inside an omitted
 *    older section.
 *  - `memglow_fresh: true` always wins (checked by the caller before this module is even called).
 *  - `memglow_section` keeps working on an older, omitted section: lib/proxy-levers.js's existing
 *    "one section on demand" lookup (lever 5's own 5b) runs over the note's FULL `sectionSpans`,
 *    which includes every heading this module ever omitted — so the exact heading text this
 *    module's own summary line names is always a valid `memglow_section` value, with no change
 *    needed here beyond lib/proxy-levers.js widening that lookup's gate from `cfg.toc` to
 *    `cfg.toc || cfg.stateView`.
 */
const { sectionSpans, estimateTokens } = require("../cost");
const { block, oneLine } = require("./responses");

const STATE_VIEW_DEFAULT_TOKENS = 1500;
const STATE_VIEW_MIN_DATED_SECTIONS = 3;
const STATE_VIEW_RECENT_COUNT = 2;
const STATE_VIEW_MIN_SAVINGS_RATIO = 0.3;
const HEADING_MAX = 120; // sectionSpans() itself already caps a heading's title at 120 chars

// FR + EN month names/abbreviations → month number. Longer keys first so the alternation below
// never stops at a short prefix of a longer word (e.g. "sept" vs "septembre") — harmless here
// since both map to the same month, but kept correct on principle.
const MONTHS = {
  janvier: 1, janv: 1, jan: 1, january: 1,
  février: 2, fevrier: 2, févr: 2, fevr: 2, fév: 2, fev: 2, feb: 2, february: 2,
  mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, apr: 4, april: 4,
  mai: 5, may: 5,
  juin: 6, jun: 6, june: 6,
  juillet: 7, juil: 7, juill: 7, jul: 7, july: 7,
  août: 8, aout: 8, aug: 8, august: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  décembre: 12, decembre: 12, déc: 12, dec: 12, december: 12,
};
const MONTH_WORDS = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
// "<day> <month>[.]? [<year>]" — "12 oct.", "5 novembre 2026", "5/10 soir" is handled by the plain
// numeric pattern below, not this one.
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_WORDS})\\.?\\s*(\\d{4})?\\b`, "i");
// "<month>[.]? <day>[st|nd|rd|th][,]? [<year>]" — "Oct 12, 2026".
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b`, "i");

/** { year, month, day } (year null when not validated to 1900-2999) when every field is a
 * plausible calendar date, else null — never throws, never accepts month>12 or day>31. */
function mk(year, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  if (year != null && !(year >= 1900 && year <= 2999)) return null;
  return { year: year == null ? null : year, month, day };
}

/**
 * The date a section HEADING carries, or null when none of the recognised formats match. Order
 * matters: ISO (`2026-10-12`) first, then `DD/MM/YYYY`, then `DD/MM` (no year — numeric dates are
 * always read day-first, the owner's own convention, FR or EN heading alike), then a day+month
 * word ("12 oct.") and finally a month-word+day ("Oct 12, 2026"). Pure; never throws.
 */
function extractHeadingDate(titleRaw) {
  const title = String(titleRaw == null ? "" : titleRaw);
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(title);
  if (m) { const r = mk(+m[1], +m[2], +m[3]); if (r) return r; }
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(title);
  if (m) { const r = mk(+m[3], +m[2], +m[1]); if (r) return r; }
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(title);
  if (m) { const r = mk(null, +m[2], +m[1]); if (r) return r; }
  m = DAY_MONTH_RE.exec(title);
  if (m) { const month = MONTHS[m[2].toLowerCase()]; if (month) { const r = mk(m[3] ? +m[3] : null, month, +m[1]); if (r) return r; } }
  m = MONTH_DAY_RE.exec(title);
  if (m) { const month = MONTHS[m[1].toLowerCase()]; if (month) { const r = mk(m[3] ? +m[3] : null, month, +m[2]); if (r) return r; } }
  return null;
}

/**
 * Fills in `.year` for every date of `dates` (document order, each `{ year, month, day }` as
 * `extractHeadingDate` returns them — `year` possibly null) using `mtimeMs` as the anchor for
 * the LAST yearless date and each earlier yearless date's own successor as the anchor for IT —
 * see the module's own top comment ("YEAR INFERENCE"). Returns a NEW array, same order, same
 * length, every entry now `{ year, month, day, ts }` (`ts` = that calendar day at UTC midnight,
 * the single comparable value the rest of this module sorts/compares on). Pure; never throws (a
 * non-finite `mtimeMs` falls back to `Date.now()`).
 */
function inferYears(dates, mtimeMs) {
  const anchorMs = Number.isFinite(mtimeMs) ? mtimeMs : Date.now();
  const out = new Array(dates.length);
  let anchor = anchorMs;
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    let year = d.year;
    if (year == null) {
      const anchorDate = new Date(anchor);
      year = anchorDate.getUTCFullYear();
      let ts = Date.UTC(year, d.month - 1, d.day);
      if (ts > anchor) { year -= 1; ts = Date.UTC(year, d.month - 1, d.day); }
      out[i] = { year, month: d.month, day: d.day, ts };
      anchor = ts;
    } else {
      const ts = Date.UTC(year, d.month - 1, d.day);
      out[i] = { year, month: d.month, day: d.day, ts };
      anchor = ts;
    }
  }
  return out;
}

/**
 * Splits a note's sections (lib/cost.js `sectionSpans`, run over the FULL upstream text —
 * frontmatter included, same input lever `toc`/`deltaRead` already use) into:
 *   lead     the untitled lead span (frontmatter + intro), or null when the note starts with a
 *            heading;
 *   dated    headed sections whose title `extractHeadingDate` parses, in document order, each
 *            `{ ...span, date: { year, month, day } }`;
 *   undated  every other headed section, in document order.
 * Pure; never throws on its own (a caller-provided `text` that is not a string is treated as "").
 */
function classifySections(text) {
  const spans = sectionSpans(text);
  if (!spans.length) return { lead: null, dated: [], undated: [] };
  const lead = spans[0].level === 0 ? spans[0] : null;
  const headed = lead ? spans.slice(1) : spans;
  const dated = [], undated = [];
  for (const sp of headed) {
    const d = extractHeadingDate(sp.title);
    if (d) dated.push({ ...sp, date: d });
    else undated.push(sp);
  }
  return { lead, dated, undated };
}

/**
 * The lever's main entry point. `opts`:
 *   mtimeMs        the note's own mtime (ms) — year inference's anchor; falls back to
 *                  `Date.now()` when absent/non-finite (a note whose mtime cannot be read is
 *                  still handled, just anchored on "now" instead of its real last-save time).
 *   minTokens      size gate (config `stateViewTokens`, default STATE_VIEW_DEFAULT_TOKENS).
 *   minDatedSections, recentCount, minSavingsRatio — see the module's own top comment; default to
 *                  STATE_VIEW_MIN_DATED_SECTIONS / STATE_VIEW_RECENT_COUNT /
 *                  STATE_VIEW_MIN_SAVINGS_RATIO.
 *   label          the note's own label, for the summary line ("this note" when unresolved).
 *   tool           the tool name to repeat in the summary line's instructions (e.g. "read_note").
 *   argSection, argFresh — the escape-hatch argument names (ARG_SECTION/ARG_FRESH in
 *                  lib/proxy-levers.js), passed in rather than imported, to keep this module pure
 *                  and dependency-free of the proxy's own constants.
 * Returns null (fail open — see the module's own top comment) or
 *   { kept, summary, respTokens, keptTokens, savedTokens, datedCount, undatedCount, olderCount, olderTokens }
 * `kept`/`summary` are plain strings; the caller (lib/proxy-levers.js) wraps each in its own
 * `block()`. Pure; never throws on its own.
 */
function buildStateView(text, opts = {}) {
  const raw = String(text == null ? "" : text);
  const respTokens = estimateTokens(raw);
  const minTokens = opts.minTokens > 0 ? opts.minTokens : STATE_VIEW_DEFAULT_TOKENS;
  if (!(respTokens > minTokens)) return null;
  const minDated = opts.minDatedSections > 0 ? opts.minDatedSections : STATE_VIEW_MIN_DATED_SECTIONS;
  const recentCount = opts.recentCount > 0 ? opts.recentCount : STATE_VIEW_RECENT_COUNT;
  const minSavingsRatio = opts.minSavingsRatio >= 0 ? opts.minSavingsRatio : STATE_VIEW_MIN_SAVINGS_RATIO;

  const { lead, dated, undated } = classifySections(raw);
  if (dated.length < minDated) return null; // fail open: not journal-like (or dates unparseable)

  const years = inferYears(dated.map((s) => s.date), opts.mtimeMs);
  dated.forEach((s, i) => { s.date = years[i]; s.ts = years[i].ts; });

  const byRecency = [...dated].sort((a, b) => b.ts - a.ts || b.start - a.start);
  const recentStarts = new Set(byRecency.slice(0, recentCount).map((s) => s.start));
  const recent = dated.filter((s) => recentStarts.has(s.start)); // document order preserved
  const older = dated.filter((s) => !recentStarts.has(s.start)); // document order preserved

  const introText = lead ? raw.slice(lead.start, lead.end) : "";
  const undatedText = undated.map((s) => raw.slice(s.start, s.end)).join("");
  const recentText = recent.map((s) => raw.slice(s.start, s.end)).join("");
  const kept = [introText, undatedText, recentText].filter((t) => t && t.length).join("");

  const label = opts.label || "this note";
  const tool = opts.tool || "read_note";
  const argSection = opts.argSection || "memglow_section";
  const argFresh = opts.argFresh || "memglow_fresh";
  const olderTokens = older.reduce((sum, s) => sum + s.tokens, 0);
  const summary = older.length
    ? `memglow: "${label}" is a journal-style note — showing the intro/rules and its ${recent.length} most recent dated section(s) in full. `
      + `${older.length} older section${older.length === 1 ? "" : "s"} left out (≈${olderTokens} tokens): `
      + `${older.map((s) => `"${oneLine(s.title || "(intro)", HEADING_MAX)}"`).join(", ")}. `
      + `Read one with ${tool} and "${argSection}": "<heading>", or the whole note with "${argFresh}": true.`
    : `memglow: "${label}" is a journal-style note — showing the intro/rules and all ${recent.length} dated section(s) in full; nothing was left out.`;

  const keptTokens = estimateTokens(kept) + estimateTokens(summary);
  const savedTokens = respTokens - keptTokens;
  if (!(savedTokens > 0) || savedTokens < minSavingsRatio * respTokens) return null; // fail open

  return {
    kept, summary, respTokens, keptTokens, savedTokens,
    datedCount: dated.length, undatedCount: undated.length, olderCount: older.length, olderTokens,
    recentCount: recent.length,
  };
}

/** Convenience for lib/proxy-levers.js: the two content blocks `buildStateView`'s result becomes. */
function stateViewBlocks(sv) { return [block(sv.kept), block(sv.summary)]; }

module.exports = {
  STATE_VIEW_DEFAULT_TOKENS, STATE_VIEW_MIN_DATED_SECTIONS, STATE_VIEW_RECENT_COUNT, STATE_VIEW_MIN_SAVINGS_RATIO,
  MONTHS, extractHeadingDate, inferYears, classifySections, buildStateView, stateViewBlocks,
};
