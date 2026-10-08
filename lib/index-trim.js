"use strict";
/**
 * Index trim (0.4.4.2 "index trim") — the memory index (`config.indexNote`, theme "index") is
 * loaded into EVERY session, so each of its tokens is paid every time. Most real index lines are
 * one hook sentence per note ("- [[slug]] — short hook"); when the hook grows long, the whole
 * index grows with it even though the detail usually already lives in the note itself.
 *
 * This module is PURE (no fs, no network): it only shortens index lines whose dropped text is
 * provably still available to the assistant afterwards — either already in the linked note's
 * frontmatter `description` or body, or, when the note has none, by MOVING the full original hook
 * into a new `description:` line of that note. Nothing is ever just dropped: lib/assistant/index.js
 * (createAssistant's `proposeIndexTrim`) turns the plan below into the usual proposal (diff,
 * confirm token, backup, atomic apply, undo) — this module itself writes nothing.
 *
 * Candidate line, exactly:            - [[target]] <sep> hook
 *   bullet        a literal "-" (optional leading indentation)
 *   target        ONE [[wikilink]] (any |alias or #heading suffix is ignored, just the id matters)
 *   <sep>         whitespace, one of — / – / - , whitespace (the "hook" separator)
 *   hook          the rest of the line
 * Anything else — a heading, prose, a line with no link, a line whose hook itself contains another
 * [[link]] (two notes named in one entry: too ambiguous to cut safely) — is left exactly as it is,
 * not even reported: only a real "- [[target]] — hook" candidate is ever a candidate.
 *
 * A candidate is actually shortened only when ALL of this holds:
 *   - its target resolves to one of the `notes` the caller supplied (candidateTargets() below
 *     tells a caller exactly which notes it ever needs to read — never the whole memory);
 *   - its hook is longer than `maxChars`;
 *   - the dropped text's significant words (lib/learned-aliases.js `significantWords`) are, for
 *     ≥80% of them, already found in the note's `description` or body — "keep as is" — OR the note
 *     has NO `description` at all, in which case the proposal ALSO writes one: the full ORIGINAL
 *     hook (never just the dropped part), YAML-safe quoted, the rest of the frontmatter and the
 *     whole body byte-identical ("moved").
 *   Otherwise (a different, insufficient description already there) the line is left untouched,
 *   reported in `skipped` with a reason — memglow never guesses, never rewrites someone else's
 *   `description`, and never drops text it cannot prove is still reachable.
 *
 * The cut itself is deterministic, never an LLM: the last CLAUSE boundary (" — ", ": ", "; ",
 * " (", ", ") that keeps the kept hook between 20 and `maxChars` characters, else the last WORD
 * boundary at or before `maxChars`. No ellipsis, no paraphrase.
 */
const { estimateTokens } = require("./cost");
const { significantWords } = require("./learned-aliases");

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
// Bullet, ONE [[link]] (alias/heading suffix ignored), a dash-like separator, then the hook (rest
// of the line). `sep` keeps whatever whitespace/dash the author actually used, unchanged.
const LINE_RE = /^(\s*-[ \t]+)\[\[([^\]|#\r\n]{1,150})(?:[#|][^\]\r\n]*)?\]\](\s*[—–-]\s*)(.*)$/;
const CLAUSE_SEPS = [" — ", ": ", "; ", " (", ", "];
const MIN_KEPT = 20;
const DEFAULT_MAX_CHARS = 90;

function splitFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(String(text || ""));
  return m ? { fm: m[0], body: String(text).slice(m[0].length) } : { fm: "", body: String(text || "") };
}
function eolOf(text) { return String(text || "").includes("\r\n") ? "\r\n" : "\n"; }

function fmValue(fm, key) {
  const m = new RegExp("^[ \\t]*" + key + "[ \\t]*:[ \\t]*(.*)$", "m").exec(String(fm || ""));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Significant-word overlap: true when `dropped` has no significant word at all (nothing meaningful
 * was lost — e.g. only punctuation or stop-words were cut), or when at least 80% of its significant
 * words (lib/learned-aliases.js `significantWords`, already Unicode- and accent-aware) are found
 * among `haystack`'s own significant words.
 */
function detailKept(droppedText, haystack) {
  const dropped = significantWords(droppedText);
  if (!dropped.length) return true;
  if (!haystack) return false;
  const hay = new Set(significantWords(haystack));
  const hit = dropped.filter((w) => hay.has(w)).length;
  return hit / dropped.length >= 0.8;
}

/** The last occurrence of any clause separator that keeps the kept text within [MIN_KEPT, maxChars]. */
function clauseCut(hook, maxChars) {
  let best = -1;
  for (const sep of CLAUSE_SEPS) {
    let idx = hook.lastIndexOf(sep);
    while (idx > maxChars) idx = hook.lastIndexOf(sep, idx - 1);
    if (idx >= MIN_KEPT && idx > best) best = idx;
  }
  return best >= 0 ? hook.slice(0, best) : null;
}
/** The last space at or before `maxChars`; a single word longer than that is hard-cut, no ellipsis. */
function wordCut(hook, maxChars) {
  const idx = hook.lastIndexOf(" ", maxChars);
  return idx > 0 ? hook.slice(0, idx) : hook.slice(0, maxChars);
}
/** Deterministic shortening of one hook to at most `maxChars` characters. */
function shortenHook(hook, maxChars) {
  const clause = clauseCut(hook, maxChars);
  return clause != null ? clause : wordCut(hook, maxChars);
}

/**
 * Ids named by every "- [[target]] <sep> hook" candidate line of an index note's text, whatever
 * their hook's length — the ONLY notes planIndexTrim() ever needs the full text of. A line whose
 * hook already contains another [[link]] is excluded (never a candidate, see module doc).
 */
function candidateTargets(indexText) {
  const { body } = splitFrontmatter(indexText);
  const out = new Set();
  for (const line of body.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m && !/\[\[/.test(m[4])) out.add(m[2].trim());
  }
  return [...out];
}

/**
 * Inserts (or creates) a `description:` frontmatter line carrying `hook` — the FULL original hook,
 * never just the dropped part, so nothing the index named is lost — YAML-safe quoted (same
 * `JSON.stringify` convention as lib/archive.js's note headers). The rest of the frontmatter and
 * the whole body stay byte-identical; a note with none gets a brand new two-line block.
 */
function setDescription(text, hook, eol) {
  const { fm, body } = splitFrontmatter(text);
  const line = "description: " + JSON.stringify(hook);
  if (!fm) return "---" + eol + line + eol + "---" + eol + eol + body;
  const m = /^(---)(\r?\n)([\s\S]*?)(\r?\n)(---)(\r?\n)?$/.exec(fm);
  if (!m) return fm + body; // malformed frontmatter (should not happen): left untouched
  const [, open, nl1, inner, nl2, close, trail] = m;
  return open + nl1 + inner + nl2 + line + nl2 + close + (trail || "") + body;
}

/**
 * planIndexTrim({ indexText, notes, maxChars, tokenize })
 *   indexText  full raw text of the index note (frontmatter included).
 *   notes      [{ id, rel, text }] — full raw text of every note candidateTargets(indexText)
 *              named; a note this plan never heard of (not in the list) counts as "unresolved".
 *   maxChars   a hook longer than this (in characters, not tokens) is a candidate (default 90).
 *   tokenize   token estimator, (bytes|string) → tokens; default lib/cost.js's estimateTokens.
 * → {
 *     lines:             [{ lineNo, id, before, after, droppedText, keptInNote, tokensSaved }],
 *     movedDescriptions: [{ id, rel, before, after }],   // notes that also need a file change
 *     skipped:           [{ lineNo, reason }],           // candidates left untouched, and why
 *     tokensBefore, tokensAfter,                         // of the WHOLE index note
 *     indexAfter,                                        // the index note's full text once trimmed
 *   }
 * `lineNo` is the 0-based index into the index note's BODY lines (frontmatter excluded), matching
 * `indexAfter`'s own line split — the same convention lib/hub-spoke.js and lib/assistant/tidy.js use.
 */
function planIndexTrim({ indexText, notes = [], maxChars = DEFAULT_MAX_CHARS, tokenize = estimateTokens } = {}) {
  const byId = new Map((notes || []).map((n) => [n.id, n]));
  const { fm, body } = splitFrontmatter(indexText);
  const eol = eolOf(body || indexText);
  const rawLines = body.split(/\r?\n/);
  const outLines = rawLines.slice();
  const lines = [];
  const skipped = [];
  const movedDescriptions = [];

  rawLines.forEach((raw, lineNo) => {
    const m = LINE_RE.exec(raw);
    if (!m) return; // heading / prose / anything that is not this exact shape: untouched
    const bullet = m[1], target = m[2].trim(), sep = m[3], hook = m[4];
    if (/\[\[/.test(hook)) return; // more than one note named: ambiguous, untouched
    if (hook.length <= maxChars) return; // already short enough: nothing to do

    const note = byId.get(target);
    if (!note) { skipped.push({ lineNo, reason: "unresolved link" }); return; }

    const { fm: noteFm, body: noteBody } = splitFrontmatter(note.text || "");
    const description = fmValue(noteFm, "description");
    const kept = shortenHook(hook, maxChars);
    const droppedText = hook.slice(kept.length).replace(/^[\s,;:()–—-]+/, "").trim();

    let keptInNote;
    if (description != null && detailKept(droppedText, description)) keptInNote = "description";
    else if (detailKept(droppedText, noteBody)) keptInNote = "body";
    else if (description == null) keptInNote = "moved";
    else { skipped.push({ lineNo, reason: "detail not in note" }); return; }

    const after = bullet + "[[" + target + "]]" + sep + kept;
    outLines[lineNo] = after;
    lines.push({ lineNo, id: target, before: raw, after, droppedText, keptInNote, tokensSaved: tokenize(raw) - tokenize(after) });

    if (keptInNote === "moved") {
      movedDescriptions.push({ id: target, rel: note.rel, before: note.text, after: setDescription(note.text || "", hook, eolOf(note.text || "")) });
    }
  });

  const indexAfter = fm + outLines.join(eol);
  return {
    lines, movedDescriptions, skipped,
    tokensBefore: tokenize(String(indexText || "")),
    tokensAfter: tokenize(indexAfter),
    indexAfter,
  };
}

module.exports = { planIndexTrim, candidateTargets, shortenHook, detailKept, setDescription, DEFAULT_MAX_CHARS, LINE_RE };
