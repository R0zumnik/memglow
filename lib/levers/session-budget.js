"use strict";
/**
 * MCP proxy lever — sessionBudgetTokens ("session memory budget", 0.5.6). An OPTIONAL, OFF-by-
 * default per-session read budget: config `proxy.sessionBudgetTokens` / env
 * MEMGLOW_PROXY_SESSION_BUDGET (default 0 = off). lib/proxy-levers.js tallies the ≈tokens
 * RETURNED by every read_note/view_note/read_content/fetch/build_context/search_notes/search
 * answer (readTools ∪ searchTools) against this session's own running total — the EXISTING
 * session identity (lib/proxy-levers.js's `session(key)`, keyed the same way every other lever
 * already is, including the `x-memglow-session` header: nothing new to identify a session here).
 *
 * Once that running total reaches the budget, answers are NEVER blocked — only:
 *   1. every FURTHER read/search answer this session gets ONE short notice line PREPENDED
 *      (budgetNotice() below): "memglow: this session has read ≈N tokens of memory (budget B) —
 *      prefer search_notes + targeted reads.";
 *   2. a full SINGLE-note read (never build_context, which already answers for several notes)
 *      whose own text is still over SESSION_BUDGET_OVER_NOTE_TOKENS (≈2000) is additionally
 *      shortened (shortenOverBudget() below) to an "orientation" slice — its own lead (frontmatter
 *      + intro, before its first heading) plus its own "## Parts" section when it has one, else
 *      just its first heading's own section — followed by one hint line naming how to read the
 *      rest (`memglow_section`). A note already shortened by another lever (dedupe/toc/stateView/
 *      alreadyLoaded/deltaRead) is normally already well under that threshold, so this almost
 *      never doubles up with another lever's own shortening — and when it does not help (no
 *      heading to cut around, or the result would not actually be smaller), it fails open: the
 *      caller falls back to the plain notice prefix instead, never losing content it cannot name
 *      a way to get back.
 *
 * Both functions here are pure (no fs, no session state) — lib/proxy-levers.js owns the running
 * total and decides when to call them. MUST NEVER break a read entirely: shortenOverBudget() only
 * ever returns a shorter, valid answer or null (fail open to the caller's own prefix-only path).
 */
const { estimateTokens, sectionSpans } = require("../cost");

const SESSION_BUDGET_OVER_NOTE_TOKENS = 2000; // "~2k tokens" per the task

/** One short English line, prepended to an answer once this session is over its own budget. */
function budgetNotice(usedTokens, budgetTokens) {
  return `memglow: this session has read ≈${usedTokens} tokens of memory (budget ${budgetTokens}) — prefer search_notes + targeted reads.`;
}

/**
 * `text` (a single note's full upstream text, frontmatter included — same input lever toc/
 * stateView already take) shortened to an "orientation" slice, or `null` (fail open) when it is
 * not actually over `opts.maxTokens` (default SESSION_BUDGET_OVER_NOTE_TOKENS), it has no heading
 * at all (nothing a section hint could point to), or the result would not actually be smaller.
 * `{ kept, hint, respTokens, keptTokens }` — `kept`/`hint` are plain strings, the caller wraps
 * each in its own `block()`, same convention as lib/levers/state-view.js's `stateViewBlocks`.
 */
function shortenOverBudget(text, opts = {}) {
  const raw = String(text == null ? "" : text);
  const maxTokens = opts.maxTokens > 0 ? opts.maxTokens : SESSION_BUDGET_OVER_NOTE_TOKENS;
  const respTokens = estimateTokens(raw);
  if (!(respTokens > maxTokens)) return null; // already short enough: nothing to do here
  const spans = sectionSpans(raw);
  if (!spans.length) return null;
  const lead = spans[0].level === 0 ? spans[0] : null;
  const headed = lead ? spans.slice(1) : spans;
  if (!headed.length) return null; // no heading anywhere: no section a hint could name
  const picked = headed.find((sp) => /^parts$/i.test(String(sp.title || "").trim())) || headed[0];
  const introText = lead ? raw.slice(lead.start, lead.end) : "";
  const pickedText = raw.slice(picked.start, picked.end);
  const kept = (introText + pickedText).replace(/\s+$/, "") + "\n";
  const label = opts.label || "this note";
  const tool = opts.tool || "read_note";
  const argSection = opts.argSection || "memglow_section";
  const argFresh = opts.argFresh || "memglow_fresh";
  const hint = `memglow: "${label}" is ≈${respTokens} tokens — session over budget, so only its intro and "${picked.title || "first section"}" are shown. `
    + `Read the rest with ${tool} and "${argSection}": "<heading>", or the whole note with "${argFresh}": true.`;
  const keptTokens = estimateTokens(kept) + estimateTokens(hint);
  if (!(keptTokens < respTokens)) return null; // fail open: nothing actually saved
  return { kept, hint, respTokens, keptTokens };
}

module.exports = { SESSION_BUDGET_OVER_NOTE_TOKENS, budgetNotice, shortenOverBudget };
