"use strict";
/**
 * memglow memory server — text helpers shared by the store and the search engine: accent folding,
 * tokenizing, a light plural stemmer, stop-words (English + French, reusing lib/learned-aliases.js'
 * list), permalink generation and stable pseudo-UUIDs. Pure functions, no fs.
 */
const crypto = require("crypto");
const { STOP_WORDS: BASE_STOP_WORDS } = require("../learned-aliases");

/**
 * Lower-case, accents removed ("Été" → "ete"), ligatures expanded; any other non-ASCII character
 * that is not a letter or a digit (dashes, arrows, emoji…) becomes a space. Per-character and
 * cached, so the common all-ASCII case is a plain toLowerCase().
 */
const NON_ASCII = /[^\x00-\x7f]/;
const NON_ASCII_G = /[^\x00-\x7f]/g;
const FOLD_CACHE = new Map([["œ", "oe"], ["æ", "ae"], ["ß", "ss"], ["ø", "o"], ["đ", "d"], ["ł", "l"], ["ı", "i"]]);
function foldChar(ch) {
  let v = FOLD_CACHE.get(ch);
  if (v === undefined) {
    v = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    if (!/^[\p{L}\p{N}]+$/u.test(v)) v = " ";
    if (FOLD_CACHE.size < 20000) FOLD_CACHE.set(ch, v);
  }
  return v;
}
function fold(s) {
  const str = String(s == null ? "" : s).toLowerCase();
  return NON_ASCII.test(str) ? str.replace(NON_ASCII_G, foldChar) : str;
}

// Short words that never identify a note, in folded form (so "été" and "ete" are both dropped).
const STOP_WORDS = new Set();
for (const w of BASE_STOP_WORDS) STOP_WORDS.add(fold(w));
// "été" is also "summer": too useful a search word to drop.
STOP_WORDS.delete("ete");
for (const w of ["a", "an", "of", "to", "in", "on", "at", "by", "or", "is", "it", "as", "be", "if", "so", "no", "do",
  "le", "la", "de", "du", "un", "et", "en", "au", "aux", "ce", "ou", "ne", "pas", "se", "sa", "il", "elle", "on",
  "je", "tu", "nous", "vous", "ils", "elles", "mon", "ma", "mes", "ton", "ta", "tes", "y", "d", "l", "s", "qu"]) STOP_WORDS.add(w);

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const ASCII_TOKEN_RE = /[a-z0-9]+/g;

/** Light plural stemmer shared by the index and the queries (both sides agree, so it is safe). */
function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && (t.endsWith("s") || t.endsWith("x")) && !t.endsWith("ss") && !/\d$/.test(t.slice(0, -1))) return t.slice(0, -1);
  return t;
}

/** Folded word tokens of a text, in order (stop-words kept: callers decide). */
function words(text) {
  const f = fold(text);
  return f.match(NON_ASCII.test(f) ? TOKEN_RE : ASCII_TOKEN_RE) || [];
}

/** Index terms of a text: folded, stemmed, numbers and words of 1+ chars (stop-words dropped). */
function terms(text) {
  const out = [];
  for (const w of words(text)) {
    if (STOP_WORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/**
 * Permalink form of a path or title: accents folded, lower-case, every run of characters other
 * than letters, digits, ".", "/" and "-" becomes one "-"; no leading/trailing "-" per segment.
 * "docs/My Feature.md" → "docs/my-feature".
 */
function slugify(s, { keepSlashes = true } = {}) {
  let t = fold(s).replace(/\\/g, "/");
  t = t.replace(/\.md$/i, "");
  const seg = (x) => x.replace(/[^a-z0-9.\p{L}\p{N}-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "");
  if (!keepSlashes) return seg(t.replace(/\//g, "-"));
  return t.split("/").map(seg).filter(Boolean).join("/");
}

/** A stable UUID-shaped id derived from a string (same input → same id, across restarts). */
function stableId(s) {
  const h = crypto.createHash("sha1").update(String(s)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A small stable integer id (for the `entity_id` fields basic-memory clients may read). */
function stableInt(s) {
  return parseInt(crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 7), 16);
}

/** Simple glob ("*" = any run, "?" = one char) → anchored, case-insensitive RegExp. */
function globToRegExp(glob, { slashStar = true } = {}) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, slashStar ? ".*" : "[^/]*").replace(/\?/g, ".");
  return new RegExp("^" + esc + "$", "i");
}

module.exports = { fold, words, terms, stem, slugify, stableId, stableInt, globToRegExp, STOP_WORDS };
