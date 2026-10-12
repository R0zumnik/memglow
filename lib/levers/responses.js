"use strict";
/**
 * MCP proxy levers — shared response-shaping helpers (0.4.12.4 split of lib/proxy-levers.js, see
 * that file's own top comment for the full picture). Not a lever of its own: `textOf`,
 * `isTextWrap`, `block`, `oneLine`, `noteRefsInArgs` and `resultIds` are the small building
 * blocks several levers (7, 9, 10, 11, 12, 14, 15, 16) share — moved out once, here, instead of
 * staying copied or scattered.
 */
const { maskSecrets } = require("../memory");
const { idsInText } = require("../agent-core");
const searchMeta = require("../search-meta");

const textOf = (content) => content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");

/**
 * FastMCP servers (basic-memory among them, `wrap_result`) send every text answer twice: in
 * `content`, and as structuredContent { result: <the same text> }. Some clients — Claude Code
 * included, checked with v2.1 — give the MODEL the structuredContent when there is one, so a lever
 * that changed only `content` would be invisible to it. Such a wrapper is recognised strictly (an
 * object with the single key `result`, a string equal to the text of an all-text `content`) and
 * kept in step with any change (oneFromServer); any other structuredContent is left alone, and
 * levers 4/5 still never replace such an answer.
 */
function isTextWrap(result) {
  const sc = result && result.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return false;
  const keys = Object.keys(sc);
  if (keys.length !== 1 || keys[0] !== "result" || typeof sc.result !== "string") return false;
  const c = result.content;
  return Array.isArray(c) && c.length > 0 && c.every((x) => x && x.type === "text" && typeof x.text === "string") && textOf(c) === sc.result;
}
const block = (text) => ({ type: "text", text });
const oneLine = (s, max) => { const t = maskSecrets(String(s || "")).replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

function noteRefsInArgs(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  for (const k of ["identifier", "url", "uri", "id", "permalink", "path", "file_path", "filePath", "note", "name"]) {
    if (typeof args[k] === "string" && args[k]) out.push(args[k]);
  }
  if (typeof args.title === "string" && args.title) {
    if (typeof args.directory === "string") out.push(args.directory.replace(/^\/+|\/+$/g, "") + "/" + args.title);
    out.push(args.title);
  }
  return out;
}
const { permalinksIn } = searchMeta;

/**
 * 0.4.10.5 — the note ids a search result names, in order, deduped, at most `cap`: what the levers
 * used to find by scanning the result's text (and its FastMCP structuredContent copy). With the
 * in-process server's metadata (lib/search-meta.js) and a "pure" result — no reference other than
 * each hit's own permalink line — that is exactly the hits' resolved permalinks, read from the
 * metadata instead of the text. Anything else: the text scan, as before.
 */
function resultIds(index, result, cap) {
  const ids = [];
  const m = searchMeta.get(result);
  if (m && m.pure && result.content && (!result.structuredContent || isTextWrap(result))) {
    for (const c of m.chunks) for (const r of c.perm) {
      const id = index.resolve(r);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= cap) return ids;
    }
    return ids;
  }
  const text = textOf(result.content) + (result.structuredContent ? "\n" + JSON.stringify(result.structuredContent) : "");
  for (const r of [...permalinksIn(text), ...idsInText(text)]) {
    const id = index.resolve(r);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= cap) break;
  }
  return ids;
}

module.exports = { textOf, isTextWrap, block, oneLine, noteRefsInArgs, resultIds };
