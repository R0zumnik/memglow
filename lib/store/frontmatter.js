"use strict";
/**
 * memglow memory server — frontmatter (YAML subset) reader. Written for the frontmatter notes
 * actually carry: `key: value` scalars (plain, 'single' or "double" quoted, folded over several
 * indented lines), `[a, b]` flow lists, `- item` block lists, `|` / `>` block scalars and one or
 * more levels of nested maps (`metadata:\n  type: x`). Never throws: a block it cannot read gives
 * `{ data: {}, error }` and the note is still indexed (body = the whole text after the block).
 */

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a note's text into `{ raw, block, body, bodyOffset }` (block = YAML text, or null). */
function splitFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) {
    // "---\n---" (an empty block) is not matched by FM_RE's lazy middle group.
    const e = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (e) return { block: "", body: text.slice(e[0].length), bodyOffset: e[0].length };
    return { block: null, body: text, bodyOffset: 0 };
  }
  return { block: m[1], body: text.slice(m[0].length), bodyOffset: m[0].length };
}

const DQ_ESCAPES = { '"': '"', "\\": "\\", "/": "/", " ": " ", "\t": "\t", "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029" };
function unquoteDouble(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, c) => {
    if (c.length > 1) return String.fromCodePoint(parseInt(c.slice(1), 16));
    return Object.prototype.hasOwnProperty.call(DQ_ESCAPES, c) ? DQ_ESCAPES[c] : all;
  });
}

/** A scalar's value: quotes removed, true/false/null/numbers typed, `[a, b]` → array. */
function scalar(raw) {
  let s = raw.trim();
  if (s === "") return null;
  // A quoted scalar followed by a comment.
  const qc = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s+#.*$/.exec(s);
  if (qc) s = qc[1];
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return unquoteDouble(s.slice(1, -1));
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(scalar).filter((v) => v !== null);
  if (s.startsWith("{") && s.endsWith("}")) {
    const o = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = part.indexOf(":");
      if (i > 0) o[part.slice(0, i).trim().replace(/^["']|["']$/g, "")] = scalar(part.slice(i + 1));
    }
    return o;
  }
  // A comment after a plain scalar.
  s = s.replace(/\s+#.*$/, "");
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^(null|Null|NULL|~)$/.test(s)) return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

/** Splits a flow collection's inside on top-level commas (quotes and nested brackets respected). */
function splitFlow(s) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

const indentOf = (l) => l.length - l.replace(/^ +/, "").length;

/**
 * Joins the lines of a quoted scalar spread over several lines, with YAML's folding: a line break
 * between two text lines is a space, each empty line is a "\n", leading/trailing blanks of the
 * continuation lines go, and in double quotes an escaped line break ("\" at the end) joins with
 * nothing. Returns { text, next }.
 */
function readQuoted(first, lines, i) {
  let raw = first, out = first.replace(/[ \t]+$/, ""), blanks = 0;
  const dq = first.trim().startsWith('"');
  while (i < lines.length && openQuote(raw)) {
    const l = lines[i++];
    raw += " " + l;
    const t = l.trim();
    if (!t) { blanks++; continue; }
    const trailing = /(\\*)$/.exec(out)[1].length;
    if (blanks) out += "\n".repeat(blanks);
    else if (dq && trailing % 2 === 1) out = out.slice(0, -1);
    else out += " ";
    out += t;
    blanks = 0;
  }
  return { text: out, next: i };
}

/** True when a quoted scalar started on this line is not closed on it. */
function openQuote(v) {
  const s = v.trim();
  if (s.startsWith("'")) return !/^'(?:[^']|'')*'\s*(#.*)?$/.test(s);
  if (s.startsWith('"')) return !/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(s);
  return false;
}

/**
 * Parses lines[start..] at indentation > `parentIndent` as a map or a list. Returns
 * `{ value, next }`. Throws on structure it does not understand (caught by parseYaml).
 */
function parseNode(lines, start, parentIndent) {
  let i = start;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++;
  if (i >= lines.length) return { value: null, next: i };
  const ind = indentOf(lines[i]);
  if (ind <= parentIndent && parentIndent >= 0) return { value: null, next: i };
  const isList = /^-( |$)/.test(lines[i].slice(ind));
  if (isList) {
    const arr = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "" || l.trim().startsWith("#")) { i++; continue; }
      const li = indentOf(l);
      if (li < ind || (li === ind && !/^-( |$)/.test(l.slice(li)))) break;
      if (li > ind) throw new Error("bad list indentation");
      const rest = l.slice(li + 1).trim();
      if (rest === "") {
        const sub = parseNode(lines, i + 1, ind);
        arr.push(sub.value); i = sub.next; continue;
      }
      const km = /^([^'"\s](?:[^:]|:(?=\S))*?|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"):(?:\s+|$)(.*)$/.exec(rest);
      if (km && !/^\[|^\{/.test(rest)) {
        // A map inside a list item ("- key: value" + more keys indented under it).
        const fake = [" ".repeat(li + 2) + rest];
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > li)) { fake.push(lines[j]); j++; }
        arr.push(parseNode(fake, 0, li + 1).value);
        i = j; continue;
      }
      let v = rest;
      i++;
      if (openQuote(v)) { const q = readQuoted(v, lines, i); v = q.text; i = q.next; }
      else {
        // A plain item folded over more-indented lines.
        while (i < lines.length && lines[i].trim() !== "" && indentOf(lines[i]) > li && !/^\s*#/.test(lines[i])) { v += " " + lines[i].trim(); i++; }
      }
      arr.push(scalar(v));
    }
    return { value: arr, next: i };
  }
  const obj = {};
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "" || l.trim().startsWith("#")) { i++; continue; }
    const li = indentOf(l);
    if (li < ind) break;
    if (li > ind) throw new Error("bad map indentation at line " + (i + 1));
    const km = /^([^'"\s#:](?:[^:]|:(?=\S))*?|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"):(?:\s+|$)(.*)$/.exec(l.slice(li));
    if (!km) throw new Error("not a key: value line at line " + (i + 1));
    const key = /^'.*'$/.test(km[1]) ? km[1].slice(1, -1).replace(/''/g, "'") : /^".*"$/.test(km[1]) ? unquoteDouble(km[1].slice(1, -1)) : km[1];
    let v = km[2];
    i++;
    if (/^[|>][+-]?\s*$/.test(v.trim())) {
      // Block scalar: every following line more indented than the key.
      const folded = v.trim()[0] === ">";
      const keep = v.trim().endsWith("+"), strip = v.trim().endsWith("-");
      const block = [];
      let bi = -1;
      while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > li)) {
        if (lines[i].trim() !== "" && bi < 0) bi = indentOf(lines[i]);
        block.push(lines[i]); i++;
      }
      while (block.length && block[block.length - 1].trim() === "" && !keep) block.pop();
      const body = block.map((x) => x.slice(Math.max(0, bi)));
      let s = folded ? body.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : body.join("\n");
      if (!strip) s += "\n";
      obj[key] = s;
      continue;
    }
    if (v.trim() === "" || v.trim().startsWith("#")) {
      // Nested map/list, or an empty value.
      const sub = parseNode(lines, i, li);
      // "key:\n- a\n- b" at the SAME indentation is a list too (common YAML style).
      if (sub.value === null && i < lines.length && indentOf(lines[i]) === li && /^-( |$)/.test(lines[i].slice(li))) {
        const s2 = parseNode(lines, i, li - 1);
        obj[key] = s2.value; i = s2.next; continue;
      }
      obj[key] = sub.value; i = sub.next; continue;
    }
    // Plain or quoted scalar, possibly continued on more-indented lines.
    if (openQuote(v)) {
      const q = readQuoted(v, lines, i); v = q.text; i = q.next;
    } else {
      while (i < lines.length && lines[i].trim() !== "" && indentOf(lines[i]) > li && !/^\s*#/.test(lines[i])) {
        if (/^\s*[^\s'"]+:(\s|$)/.test(lines[i])) throw new Error("mapping inside a plain scalar at line " + (i + 1));
        v += " " + lines[i].trim(); i++;
      }
    }
    obj[key] = scalar(v);
  }
  return { value: obj, next: i };
}

/** Parses a frontmatter block. `{ data, error }`: data is always a plain object. */
function parseYaml(block) {
  if (block == null || !String(block).trim()) return { data: {}, error: null };
  const lines = String(block).replace(/\t/g, "  ").split(/\r?\n/);
  try {
    const { value } = parseNode(lines, 0, -1);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { data: {}, error: "frontmatter is not a map" };
    return { data: value, error: null };
  } catch (e) {
    // Best effort: keep the top-level "key: value" lines that do parse.
    const data = {};
    for (const l of lines) {
      const m = /^([A-Za-z_][\w.-]*):\s+(.+)$/.exec(l);
      if (m) { try { data[m[1]] = scalar(m[2]); } catch { /* skip */ } }
    }
    return { data, error: e.message };
  }
}

module.exports = { splitFrontmatter, parseYaml, scalar };
