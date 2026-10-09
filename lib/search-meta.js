"use strict";
/**
 * memglow — structured search metadata handed from the in-process memory server to the levers
 * (0.4.10.5, all-in-one mode). A search_notes TEXT result built by memory-server/tools.js carries,
 * out of band (a WeakMap keyed by the result object: never serialised, never sent to a client),
 * the blocks its text is made of — exactly the blocks lib/proxy-levers.js hitChunksOf() would cut
 * it into — each with the note references the levers' own parsers (permalinksIn, idsInText) find
 * in it. The levers then merge multiQuery phrasings and list a search's notes from these blocks
 * instead of re-splitting and re-scanning the text. `pure`: no reference in the result other than
 * each hit's own permalink line (no path in a title, snippet or the query) — then the hit ids are
 * exactly the hits' resolved permalinks, in order. A result without metadata (the standalone
 * proxy, any other server, a lever-modified result) goes through the text parsers as before.
 *
 *   meta = { pure: boolean, chunks: [{ text, perm: [ref…], ids: [ref…] }] }
 */
const META = new WeakMap();

// The levers' own note-reference parsers (lib/proxy-levers.js uses these very functions).
const PERMALINK_RE = /permalink["']?\s*[:=]\s*["']?([A-Za-z0-9_./-]{1,200})/gi;
function permalinksIn(text) {
  const out = [];
  for (const m of String(text).slice(0, 200000).matchAll(PERMALINK_RE)) out.push(m[1]);
  return out;
}

function set(result, meta) { if (result && typeof result === "object" && meta) META.set(result, meta); return result; }
function get(result) { return result && typeof result === "object" ? META.get(result) || null : null; }
/** `to` (a copy of `from`, e.g. with resultType added) keeps `from`'s metadata. */
function copy(from, to) { const m = get(from); if (m) set(to, m); return to; }

module.exports = { set, get, copy, permalinksIn, PERMALINK_RE };
