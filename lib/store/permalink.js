"use strict";
/**
 * memglow memory server — file names and permalinks for notes it writes, following the rules
 * basic-memory's files already follow (so a note memglow creates gets the path and permalink
 * basic-memory would have given it):
 *
 *  - file name = the title with path separators and `<>:"|?*` turned into "-", runs of "-"
 *    collapsed, leading/trailing "." and "-" removed (case and spaces kept), plus ".md";
 *  - directory = the folder with characters other than letters, digits, ". -_/\" and spaces
 *    removed, slashes collapsed, no leading/trailing slash;
 *  - permalink = the path without ".md", transliterated to ASCII, "camelCase" split, lower-cased,
 *    "_" → "-", apostrophes dropped, anything but [a-z0-9/.-] → "-", runs collapsed, each segment
 *    trimmed of "-"; CJK ideographs are kept as they are.
 *
 * Transliteration covers Latin (accents, ligatures), Greek, Cyrillic and common symbols; other
 * scripts are dropped from permalinks (documented difference).
 */

const TRANSLIT = {
  "œ": "oe", "Œ": "OE", "æ": "ae", "Æ": "AE", "ß": "ss", "ẞ": "SS", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L",
  "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D", "ı": "i", "ĸ": "q", "ŉ": "'n", "ŋ": "ng", "Ŋ": "Ng", "ħ": "h", "Ħ": "H", "ŧ": "t", "Ŧ": "T",
  "‘": "'", "’": "'", "‚": ",", "‛": "'", "“": "\"", "”": "\"", "„": ",,", "«": "<<", "»": ">>", "‹": "<", "›": ">",
  "–": "-", "—": "--", "―": "--", "‐": "-", "‑": "-", "…": "...", "•": "*", "·": "*", " ": " ", " ": " ", " ": " ",
  "€": "EUR", "£": "PS", "¥": "Y=", "¢": "C/", "°": "deg", "©": "(c)", "®": "(r)", "™": "(tm)", "×": "x", "÷": "/",
  "½": " 1/2", "¼": " 1/4", "¾": " 3/4", "¹": "1", "²": "2", "³": "3", "º": "o", "ª": "a", "§": "SS", "¶": "P", "¿": "?", "¡": "!",
};
const CYR = "А A Б B В V Г G Д D Е E Ё E Ж Zh З Z И I Й I К K Л L М M Н N О O П P Р R С S Т T У U Ф F Х Kh Ц Ts Ч Ch Ш Sh Щ Shch Ъ ' Ы Y Ь ' Э E Ю Iu Я Ia "
  + "а a б b в v г g д d е e ё e ж zh з z и i й i к k л l м m н n о o п p р r с s т t у u ф f х kh ц ts ч ch ш sh щ shch ъ ' ы y ь ' э e ю iu я ia "
  + "Є Ie є ie І I і i Ї Yi ї yi Ґ G ґ g Ў U ў u";
const GRK = "Α A Β B Γ G Δ D Ε E Ζ Z Η E Θ Th Ι I Κ K Λ L Μ M Ν N Ξ Ks Ο O Π P Ρ R Σ S Τ T Υ U Φ Ph Χ Kh Ψ Ps Ω O "
  + "α a β b γ g δ d ε e ζ z η e θ th ι i κ k λ l μ m ν n ξ ks ο o π p ρ r σ s ς s τ t υ u φ ph χ kh ψ ps ω o";
for (const table of [CYR, GRK]) {
  const parts = table.split(" ");
  for (let i = 0; i + 1 < parts.length; i += 2) TRANSLIT[parts[i]] = parts[i + 1];
}

const isCjk = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x3400 && cp <= 0x4dbf);
const isFullwidth = (cp) => cp >= 0xff00 && cp <= 0xffef;

/** One character → ASCII (accents stripped, known letters/symbols transliterated, the rest dropped). */
function asciiOf(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return ch;
  if (TRANSLIT[ch] !== undefined) return TRANSLIT[ch];
  const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
  if (base && /^[\x00-\x7f]+$/.test(base)) return base;
  const greekOrCyr = base && TRANSLIT[base];
  if (greekOrCyr !== undefined && greekOrCyr) return greekOrCyr;
  const compat = ch.normalize("NFKD").replace(/\p{M}+/gu, "");
  if (compat && /^[\x00-\x7f]+$/.test(compat)) return compat;
  if (/\s/u.test(ch)) return " ";
  return "";
}
function unidecode(s) {
  let out = "";
  for (const ch of String(s)) out += asciiOf(ch);
  return out;
}

/**
 * Permalink of a project-relative path ("memory/People/Jean-Éric O'Neil.md" →
 * "memory/people/jean-eric-oneil"), without the project prefix.
 */
function generatePermalink(filePath) {
  let base = String(filePath).replace(/\\/g, "/");
  base = base.replace(/\.(md|markdown|txt)$/i, "");
  const chars = Array.from(base);
  let clean;
  if (chars.some((c) => isCjk(c.codePointAt(0)) || isFullwidth(c.codePointAt(0)))) {
    let r = "";
    for (const c of chars) {
      const cp = c.codePointAt(0);
      if (isCjk(cp)) r += c;
      else if (isFullwidth(cp)) continue;
      else r += asciiOf(c);
    }
    r = r.replace(/([一-鿿　-〿㐀-䶿])([a-zA-Z0-9])/g, "$1-$2").replace(/([a-zA-Z0-9])([一-鿿　-〿㐀-䶿])/g, "$1-$2");
    r = r.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
    r = Array.from(r).map((c) => (c.codePointAt(0) < 0x80 ? c.toLowerCase() : c)).join("");
    r = r.replace(/_/g, "-").replace(/'/g, "");
    clean = r.replace(/[^a-z0-9一-鿿　-〿㐀-䶿/\-.]/g, "-");
  } else {
    let a = unidecode(base);
    a = a.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/_/g, "-").replace(/'/g, "");
    clean = a.replace(/[^a-z0-9/\-.]/g, "-");
  }
  clean = clean.replace(/-+/g, "-");
  return clean.split("/").map((s) => s.replace(/^-+|-+$/g, "")).join("/");
}

/** A title → a safe file name stem (without ".md"). */
function sanitizeForFilename(text, replacement = "-") {
  let t = String(text).replace(/[/\\]/g, replacement).replace(/[<>:"|?*]/g, replacement);
  t = t.replace(/-+/g, replacement);
  t = t.replace(/^\.+|\.+$/g, "");
  return t.replace(/^-+|-+$/g, "");
}

/** A directory argument → a cleaned relative folder ("" = the root). */
function sanitizeForDirectory(directory) {
  if (!directory) return "";
  let s = String(directory).trim();
  if (s.startsWith("./")) s = s.slice(2);
  s = Array.from(s).filter((c) => /[\p{L}\p{N}]/u.test(c) || ". -_\\/".includes(c)).join("").replace(/\s+$/, "");
  s = s.replace(/[\\/]+/g, "/");
  return s.replace(/^[\\/]+|[\\/]+$/g, "");
}

module.exports = { generatePermalink, sanitizeForFilename, sanitizeForDirectory, unidecode };
