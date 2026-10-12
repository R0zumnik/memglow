"use strict";
/**
 * MCP proxy levers — lever 9, multiQuery (0.4.12.4 split of lib/proxy-levers.js, see that file's
 * own top comment for the full picture). Everything here is pure (no `cfg`/`index` closed over
 * by a live session) so it is usable, and unit-testable, on its own — by createLevers
 * (production) and by bench/replay.js (the free replay harness) alike.
 */
const { idsInText } = require("../agent-core");
const searchMeta = require("../search-meta");
const { permalinksIn } = searchMeta;
const { textOf, isTextWrap, block, oneLine } = require("./responses");

const ARG_QUERIES = "memglow_queries";
const MULTI_QUERY_MAX = 4; // memglow_queries: at most this many entries (tools/list maxItems)
const MULTI_QUERY_LEN_MAX = 200; // each phrasing, trimmed

// ---------------------------------------------------------------------------------------------
// Lever 9 — multiQuery: one call, several phrasings (see the module's top comment, and the first
// rule of lib/memory-rules.js). Everything below is pure (no `cfg`/`index` closed over by a live
// session) so it is usable, and unit-testable, on its own — by createLevers (production) and by
// bench/replay.js (the free replay harness) alike.

const QUERY_KEYS = ["query", "q", "search_text", "text", "pattern", "keywords"];

/** The key holding the search text (basic-memory `query`, or a usual name), or null. */
function queryKeyOf(args) {
  if (!args || typeof args !== "object") return null;
  for (const k of QUERY_KEYS) if (typeof args[k] === "string" && args[k].trim()) return k;
  return null;
}
/** The search text the assistant sent, or "" when there is none. */
function queryOf(args) { const k = queryKeyOf(args); return k ? args[k].trim() : ""; }

/** An answer that says "nothing": empty, [], "results": [], "No results", "nothing found"… */
function emptyAnswer(text) {
  const t = String(text).trim();
  return !t || /^\[\s*\]$/.test(t) || /"results"\s*:\s*\[\s*\]/.test(t) || /\b(no (results?|matches|notes?|documents?) (were )?found|no results|no matches|nothing found|0 results)\b/i.test(t);
}

/**
 * `{ phrasings, queryKey }` when `args` carries a usable `memglow_queries` (ARG_QUERIES) on top of
 * its own query argument — `phrasings[0]` is always the original query, never a duplicate of it,
 * at most MULTI_QUERY_MAX total — or null when there is nothing to multiply: no recognisable query
 * argument, no `memglow_queries` array, or every entry in it is blank, not a string, longer than
 * MULTI_QUERY_LEN_MAX, or a repeat of a phrasing already kept. A null plan means "behave exactly
 * like a plain single search" (the caller still strips `memglow_queries` before forwarding).
 */
function planMultiQuery(args) {
  const queryKey = queryKeyOf(args);
  if (!queryKey) return null;
  const main = args[queryKey].trim();
  const raw = args && args[ARG_QUERIES];
  if (!Array.isArray(raw) || !raw.length) return null;
  const seen = new Set([main]);
  const phrasings = [main];
  for (const q of raw) {
    if (phrasings.length >= MULTI_QUERY_MAX) break;
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (!t || t.length > MULTI_QUERY_LEN_MAX || seen.has(t)) continue;
    seen.add(t);
    phrasings.push(t);
  }
  return phrasings.length >= 2 ? { phrasings, queryKey } : null;
}

/**
 * Ranks keys found across several phrasings' ordered hit lists: a key seen by MORE phrasings
 * ranks first ("a note found by several phrasings ranks higher"); ties broken by the best
 * (lowest) rank it had in any one phrasing, then by which phrasing found it first. Pure, no
 * notion of what a "key" is (a note id, or a synthetic one — see mergeSearchResults below).
 */
function rankKeys(perPhrasingKeyLists) {
  const score = new Map();
  (perPhrasingKeyLists || []).forEach((keys, pi) => (keys || []).forEach((key, ri) => {
    if (!key) return;
    const cur = score.get(key);
    if (!cur) score.set(key, { count: 1, bestRank: ri, firstPhrasing: pi });
    else cur.count++;
  }));
  return [...score.keys()].sort((a, b) => {
    const A = score.get(a), B = score.get(b);
    return B.count - A.count || A.bestRank - B.bestRank || A.firstPhrasing - B.firstPhrasing;
  });
}
/** rankKeys(), deduped by note id and capped to the upstream's usual result count. Pure, tested. */
function mergeRankedIds(perPhrasingIds, cap) {
  const order = rankKeys(perPhrasingIds);
  return cap > 0 ? order.slice(0, cap) : order;
}

/** Search results split into per-hit blocks the way basic-memory (and this proxy's own test
 * fixtures) separate them: a blank line. Good enough to reorder/dedup hits without understanding
 * any server's schema; text with no blank line is a single block. */
function chunksOf(text) {
  return String(text).split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
}
/**
 * 0.4.5.1b — chunksOf() for a page of `### ` hit blocks (basic-memory's layout): one hit is
 * everything from its `### ` heading to the next `### ` heading, or to the page footer (a block
 * starting with `---` after which no `### ` heading follows). basic-memory's `- match:` excerpt
 * can itself contain blank lines; split on blank lines alone, such a hit became several blocks
 * and its continuation blocks were deduped away or shuffled by the merge. Text without any
 * `### ` block is split exactly as before.
 */
function hitChunksOf(text) {
  const raw = chunksOf(text);
  if (!raw.some((c) => c.startsWith("### "))) return raw;
  let lastHeading = -1;
  raw.forEach((c, i) => { if (c.startsWith("### ")) lastHeading = i; });
  const out = [];
  let cur = null, footer = false;
  raw.forEach((c, i) => {
    if (c.startsWith("### ")) { cur = c; out.push(cur); return; }
    if (!footer && i > lastHeading && /^-{3,}\s*(\n|$)/.test(c)) footer = true;
    if (cur !== null && !footer) { cur = cur + "\n\n" + c; out[out.length - 1] = cur; return; }
    out.push(c); // the header before the first hit, or the footer and what follows it
  });
  return out;
}
/** The first of these references that resolves to a note id, or null. */
function firstResolved(index, refs) {
  for (const r of refs || []) { const id = index.resolve(r); if (id) return id; }
  return null;
}

/** The note id a hit block names, via the same permalink/id sniffing the rest of this module uses. */
function chunkId(index, chunk) {
  for (const r of permalinksIn(chunk)) { const id = index.resolve(r); if (id) return id; }
  for (const r of idsInText(chunk)) { const id = index.resolve(r); if (id) return id; }
  return null;
}

/**
 * 0.4.9.1 — the dedupe key of a hit block: the note id when one resolves; else the block's OWN
 * permalink line ("- permalink: x", the first permalink in it, lower-cased), so the same note
 * found by two phrasings still merges even when the levers' note index cannot resolve it (a note
 * outside the index folder, a file name that differs from its permalink, an index not yet
 * refreshed) — its score / match lines differ per phrasing, so its text never matches; else the
 * block's text.
 */
function chunkKey(c) {
  if (c.id) return c.id;
  const pl = (c.perm || permalinksIn(c.text))[0];
  return pl ? "permalink:" + pl.toLowerCase().replace(/^memory:\/\//, "").replace(/\.md$/, "") : "text:" + c.text;
}

/** One compact hit row for a note id — the "upstream's own format" lever 9 falls back to for its
 * tier B, and lever 10 (aliases) reuses verbatim for its own "upstream's own format" case below. */
function hitRow(index, id) { const n = index.note(id); return n ? `- ${oneLine(n.label, 80)} \`${n.id}\`` : `- \`${id}\``; }

/** True when `r` is a plain-text answer — every `content` item is text, and any
 * `structuredContent` is only the FastMCP text wrap (isTextWrap) — the shape mergeSearchResults'
 * tier A, and lever 10's own "upstream's own format" case, both require to be safe to add to. */
function isPlainTextResult(r) {
  return !!(r && Array.isArray(r.content) && r.content.length > 0
    && r.content.every((c) => c && c.type === "text" && typeof c.text === "string")
    && (!("structuredContent" in r) || isTextWrap(r)));
}

/** Indexes of a phrasing's frame chunks: the un-identified "# Heading" blocks before its first
 * other block, and the un-identified "---" blocks (plus what follows them) after its last one. */
function frameOf(chunks) {
  const out = new Set();
  for (let j = 0; j < chunks.length && !chunks[j].id && /^# /.test(chunks[j].text); j++) out.add(j);
  // 0.4.9.1: a page of `### ` hit blocks (hitChunksOf) — the footer is the first "---" block after
  // the last hit heading, and EVERYTHING after it is frame too (a related-notes section, a lever's
  // own block…), not only a run of trailing "---" blocks: such a section used to become a "hit"
  // of its own, and could list a note already merged above a second time.
  let lastHeading = -1;
  chunks.forEach((c, j) => { if (c.text.startsWith("### ")) lastHeading = j; });
  if (lastHeading >= 0) {
    for (let j = lastHeading + 1; j < chunks.length; j++) {
      if (!chunks[j].text.startsWith("### ") && /^-{3,}\s*(\n|$)/.test(chunks[j].text)) { for (let k = j; k < chunks.length; k++) out.add(k); break; }
    }
  }
  for (let j = chunks.length - 1; j >= 0 && !chunks[j].id && !out.has(j); j--) {
    if (/^-{3,}\s*(\n|$)/.test(chunks[j].text)) { for (let k = j; k < chunks.length; k++) out.add(k); }
    else if (!out.has(j + 1)) break;
  }
  return out;
}

/**
 * Merges several phrasings' successful search `result`s (responses[0] = the original query) into
 * ONE `result`, or null when it cannot be done safely — the caller then relays `responses[0]`
 * unchanged ("fail open"; see runSearchCall below). Three tiers:
 *  A. Every response is plain text (no `structuredContent` other than the FastMCP text wrap,
 *     isTextWrap()): split into hit blocks (chunksOf), dedup/rank by note id when one resolves,
 *     else by the block's own text (two byte-identical un-identifiable blocks still dedup; two
 *     different ones are both kept) — reassembled from the SERVER'S OWN blocks, "the upstream's
 *     own format", just reordered and deduped.
 *  B. Otherwise (a response has other structured content, or a non-text part): a compact text
 *     listing of whatever note ids resolve from each phrasing's full text, same style as lever 2
 *     (searchDetails).
 *  C. Neither tier found a single resolvable hit anywhere → null (fail open).
 * Capped to `cap` = the largest single phrasing's own hit count ("the upstream's usual result
 * count") in both tiers A and B.
 */
/**
 * The merged result keeps every top-level field of the first phrasing's own result
 * (`resultType`, `isError`, `_meta`, …) except the content it rebuilds itself. 0.4.10.8:
 * without this, MCP 2026-07-28 clients rejected merged answers ("missing required resultType").
 */
function withResultFields(responses, merged) {
  const base = responses.find((r) => r && typeof r === "object") || {};
  const out = { ...base, ...merged };
  if (!("structuredContent" in merged)) delete out.structuredContent;
  return searchMeta.get(merged) ? searchMeta.copy(merged, out) : out;
}

function mergeSearchResults(index, responses) {
  const merged = mergeSearchContent(index, responses);
  return merged ? withResultFields(responses, merged) : merged;
}

function mergeSearchContent(index, responses) {
  const isPlainText = isPlainTextResult;
  const perPhrasing = responses.map((r) => {
    const text = r ? textOf(r.content || []) : "";
    if (!text || emptyAnswer(text)) return { chunks: [] };
    // 0.4.10.5: the in-process server's structured blocks (lib/search-meta.js) — exactly the
    // blocks hitChunksOf() would cut, with the references chunkId() would find — instead of
    // re-splitting and re-scanning the text.
    const m = searchMeta.get(r);
    if (m) return m.chunks.map((c) => ({ text: c.text, perm: c.perm, refs: c.ids, pure: m.pure, id: firstResolved(index, c.perm) || firstResolved(index, c.ids) }));
    return hitChunksOf(text).map((c) => ({ text: c, id: chunkId(index, c) }));
  }).map((chunks) => ({ chunks: Array.isArray(chunks) ? chunks : [] }));
  const cap = Math.max(0, ...perPhrasing.map((p) => p.chunks.length));
  if (!cap) return null; // nothing anywhere: let the caller relay responses[0] ("No results") as is

  if (responses.every(isPlainText)) {
    // 0.4.5.1: a page's own frame — a leading "# Title" block, a trailing "---" footer, as in
    // basic-memory's "# Search Results: q" / "---\n*N results | page …*" — is not a hit: identical
    // footers would otherwise rank first (found by every phrasing) and, with small pages, push the
    // real hits out of the cap. The first phrasing's frame is kept around the merged hits, the
    // other phrasings' frames are dropped; text without any frame block merges exactly as before.
    const frameIdx = perPhrasing.map((p) => frameOf(p.chunks));
    const hitsOf = (p, i) => p.chunks.filter((c, j) => !frameIdx[i].has(j));
    const hitLists = perPhrasing.map(hitsOf);
    const hitCap = Math.max(0, ...hitLists.map((h) => h.length));
    if (!hitCap) return null; // only frames (e.g. headers of empty pages): relay responses[0] as is
    const keysPerPhrasing = hitLists.map((h) => h.map(chunkKey));
    const textByKey = new Map();
    hitLists.forEach((h) => h.forEach((c) => { const k = chunkKey(c); if (!textByKey.has(k)) textByKey.set(k, c.text); }));
    // Blocks with metadata, by text (all-in-one): the merged result keeps them as its own.
    let chunkByText = perPhrasing.every((p) => p.chunks.every((c) => c.perm)) ? new Map() : null;
    if (chunkByText) for (const p of perPhrasing) for (const c of p.chunks) if (!chunkByText.has(c.text)) chunkByText.set(c.text, c);
    const order = rankKeys(keysPerPhrasing).slice(0, hitCap);
    // The frame kept around the merged hits never repeats a note already listed among them.
    const listed = new Set(order.filter((k) => !k.startsWith("text:")));
    const frameText = (c) => (c.id && listed.has(c.id)) || listed.has(chunkKey(c)) ? null : c.text;
    const first = perPhrasing[0].chunks;
    const firstHit = first.findIndex((c, j) => !frameIdx[0].has(j));
    const head = (firstHit < 0 ? [] : first.slice(0, firstHit)).map(frameText).filter((t) => t != null);
    let lastHit = -1;
    first.forEach((c, j) => { if (!frameIdx[0].has(j)) lastHit = j; });
    const tail = (lastHit < 0 ? [] : first.slice(lastHit + 1)).map(frameText).filter((t) => t != null);
    const mergedText = head.concat(order.map((k) => textByKey.get(k)), tail).join("\n\n");
    const result0 = { content: [block(mergedText)] };
    const result = isTextWrap(responses[0]) ? { ...result0, structuredContent: { result: mergedText } } : result0;
    // The merged result's own metadata, when every block came with some (all-in-one).
    if (chunkByText) {
      const parts = head.concat(order.map((k) => textByKey.get(k)), tail).map((t) => chunkByText.get(t));
      if (parts.every(Boolean)) searchMeta.set(result, { pure: parts.every((c) => c.pure), chunks: parts.map((c) => ({ text: c.text, perm: c.perm, ids: c.refs })) });
    }
    return result;
  }

  const idsPerPhrasing = responses.map((r) => {
    const text = (r ? textOf(r.content || []) : "") + (r && r.structuredContent ? "\n" + JSON.stringify(r.structuredContent) : "");
    const ids = [];
    for (const ref of [...permalinksIn(text), ...idsInText(text)]) { const id = index.resolve(ref); if (id && !ids.includes(id)) ids.push(id); }
    return ids;
  });
  const merged = mergeRankedIds(idsPerPhrasing, cap);
  if (!merged.length) return null; // fail open: nothing resolvable at all
  const rows = merged.map((id) => hitRow(index, id));
  return { content: [block(`memglow: merged results across ${responses.length} phrasings:\n` + rows.join("\n"))] };
}

/**
 * Lever 10 (aliases) — the block added at the TOP of a search answer for a learned candidate
 * note `id` that this search's own results did not include. "The upstream's own format if
 * possible": when `result` is plain text (isPlainTextResult — reusing lever 9's own definition
 * of "safe to add a hit row to"), one more row in the exact shape lever 9's own tier B already
 * uses for a note it cannot otherwise show (`hitRow`) — it then reads like one more ordinary hit,
 * not a one-off marker. Otherwise (structured or non-text content, where no row shape can be
 * borrowed) a single compact, explicitly-labelled line, so the note is still named without
 * fabricating a shape this answer never had.
 */


/**
 * Runs one search `tools/call`'s arguments through the multiQuery lever. `sendUpstream(args) ->
 * Promise<{result}|{error}>` makes ONE upstream call with these exact arguments (never
 * `memglow_queries`) — the tool name is fixed by the caller (the real proxy writes a request and
 * awaits the matching response; bench/replay.js calls its in-process fake upstream). When
 * `cfg.multiQuery` is off, or `planMultiQuery` finds nothing to multiply, exactly one call is
 * made (memglow_queries stripped) — unchanged behaviour. Otherwise one call per phrasing,
 * SEQUENTIALLY, the original query first; any rejected or errored call stops the run and "fails
 * open": the FIRST phrasing's own result (or error) — what a plain single search would have
 * returned — is what comes back, never a partial merge. Never throws. Returns `{ message:
 * {result}|{error}, calls }`, `calls` being how many upstream calls were actually made.
 */
async function runSearchCall(cfg, index, args, sendUpstream) {
  const clean = { ...(args || {}) };
  delete clean[ARG_QUERIES];
  const plan = cfg.multiQuery ? planMultiQuery(args || {}) : null;
  if (!plan) {
    let message;
    try { message = await sendUpstream(clean); } catch (e) { message = { error: { code: -32000, message: "memglow multiQuery: " + ((e && e.message) || "upstream failed") } }; }
    return { message, calls: 1 };
  }
  const responses = [];
  for (const phrasing of plan.phrasings) {
    let r;
    try { r = await sendUpstream({ ...clean, [plan.queryKey]: phrasing }); } catch (e) { r = { error: { code: -32000, message: "memglow multiQuery: " + ((e && e.message) || "upstream failed") } }; }
    if (!r || r.error) return { message: responses.length ? { result: responses[0] } : (r || { error: { code: -32000, message: "memglow multiQuery: no response" } }), calls: responses.length + 1 };
    responses.push(r.result);
  }
  let merged = null;
  try { merged = mergeSearchResults(index, responses); } catch { merged = null; }
  return { message: { result: merged || responses[0] }, calls: responses.length };
}

/**
 * createLevers({ config, index, savings, serverName }) → { clientMessage(msg, sessionKey), serverMessage(msg, sessionKey) }
 * Both return { msg, changed }. `msg` may be a JSON-RPC object or a batch (array). `serverName` is
 * the upstream server's `--name` (or guessed label): only used to pick the right
 * `unsupportedTools` table entry for lever 7.
 */


module.exports = {
  ARG_QUERIES, MULTI_QUERY_MAX, MULTI_QUERY_LEN_MAX,
  queryKeyOf, queryOf, emptyAnswer, planMultiQuery, rankKeys, mergeRankedIds, chunksOf,
  hitChunksOf, firstResolved, chunkId, chunkKey, hitRow, isPlainTextResult, frameOf,
  withResultFields, mergeSearchResults, mergeSearchContent, runSearchCall,
};
