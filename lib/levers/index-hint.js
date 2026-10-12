"use strict";
/**
 * MCP proxy levers — lever 12, indexHint (0.4.12.4 split of lib/proxy-levers.js, see that file's
 * own top comment and lib/negative-cache.js for lever 11, its sibling switch).
 */
const { block, oneLine } = require("./responses");

const INDEX_HINT_MAX_LINES = 3;
const INDEX_HINT_LINE_MAX = 160;

/**
 * Lines of the index note's OWN text that mention at least one of `words` — "the index already
 * says" (lever 12, indexHint): grepped straight through the memory layer's own masked body
 * (lib/memory.js `maskedBody`, already secret-masked; `oneLine` masks again on top, harmless),
 * never more than INDEX_HINT_MAX_LINES, each capped to INDEX_HINT_LINE_MAX. Returns [] when
 * there is nothing to grep (no words, no readable body, no match) — the caller then adds
 * nothing, never a bare "says:" line with nothing after it.
 */
function indexHintLines(index, id, words) {
  if (!Array.isArray(words) || !words.length) return [];
  const mem = index && typeof index._memory === "function" ? index._memory() : null;
  const body = mem ? mem.maskedBody(id) : null;
  if (!body) return [];
  const lower = words.map((w) => w.toLowerCase());
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lc = line.toLowerCase();
    if (lower.some((w) => lc.includes(w))) {
      out.push(oneLine(line, INDEX_HINT_LINE_MAX));
      if (out.length >= INDEX_HINT_MAX_LINES) break;
    }
  }
  return out;
}
const indexHintBlock = (lines) => block("memglow: the index already says:\n" + lines.map((l) => "- " + l).join("\n"));



module.exports = { INDEX_HINT_MAX_LINES, INDEX_HINT_LINE_MAX, indexHintLines, indexHintBlock };
