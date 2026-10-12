"use strict";
/**
 * MCP proxy levers — lever 10, aliases/learnAliases (0.4.12.4 split of lib/proxy-levers.js, see
 * that file's own top comment and lib/learned-aliases.js).
 */
const { significantWords } = require("../learned-aliases");
const { block, oneLine, resultIds } = require("./responses");
const { hitRow, isPlainTextResult } = require("./multi-query");

// Lever 10 (aliases): a read within this long after a search, with no OTHER search in between,
// may still teach that search's words to the note it reads (see lib/learned-aliases.js).
const ALIAS_LEARN_WINDOW_MS = 2 * 60 * 1000;

function aliasInjection(index, id, result) {
  if (isPlainTextResult(result)) return block(hitRow(index, id));
  const n = index.note(id);
  const label = n ? oneLine(n.label, 80) : id;
  return block(`memglow: likely relevant — ${label} (${id}), learned from your past searches`);
}

/**
 * Lever 10 (aliases/learnAliases) for a multiQuery (lever 9) MERGED search result — the slice of
 * `handleSearch` below that `createLevers.multiQuery.run` cannot reach any other way: a request
 * carrying `memglow_queries` bypasses the normal `clientMessage`/`serverMessage` cycle entirely
 * (see the comment above `multiQuery` in `createLevers`'s return value), so without this call,
 * lever 10 neither learns from a multi-phrasing search (`s.lastSearch` is never set for it) nor
 * injects a learned candidate into one (the merged result never passes through `handleSearch`).
 *
 * `phrasings` is every phrasing actually sent upstream (the original query first, same as
 * `planMultiQuery`) — `s.lastSearch.words` is the UNION of each phrasing's own significant words
 * (order preserved, first occurrence wins), not just the main query's, so a note read right after
 * learns from every phrasing the model tried, not only the first. `resultIds` and the injection
 * rule (first learned candidate, prepended, never removing a row; upstream's-own-format when the
 * merged result is plain text) are otherwise identical to `handleSearch`'s own lever-10 slice.
 * Pure given its inputs; `aliases` may be the real store or `NOOP_ALIAS_STORE`. Returns `result`
 * unchanged (same reference) when there is nothing to learn or inject.
 */
function applyAliasesToSearch(cfg, index, aliases, s, phrasings, result) {
  if (!cfg.aliases && !cfg.learnAliases && !cfg.indexHint) return result;
  if (!result || !Array.isArray(result.content)) return result;
  const ids = resultIds(index, result, cfg.searchDetailsMax);

  const words = [];
  const seen = new Set();
  for (const p of phrasings || []) for (const w of significantWords(p)) { if (!seen.has(w)) { seen.add(w); words.push(w); } }

  // Same correlation bookkeeping as handleSearch's 0.4.2.3 comment: refreshed regardless of
  // which part of this function ends up using it. 0.4.2.6: lever 12 (indexHint) needs it too —
  // see the same comment in handleSearch.
  if ((cfg.learnAliases || cfg.indexHint) && s) s.lastSearch = { words, resultIds: new Set(ids), t: Date.now() };

  if (cfg.aliases && aliases.available() && words.length) {
    aliases.forgetMissing((noteId) => !!index.note(noteId));
    const candidate = aliases.match(words, new Set(ids), (noteId) => !!index.note(noteId));
    if (candidate) return { ...result, content: [aliasInjection(index, candidate, result), ...result.content] };
  }
  return result;
}

module.exports = { ALIAS_LEARN_WINDOW_MS, aliasInjection, applyAliasesToSearch };
