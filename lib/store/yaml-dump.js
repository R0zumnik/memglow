"use strict";
/**
 * memglow memory server — YAML writer for note frontmatter, laid out the way basic-memory's files
 * already are, so a note written by memglow looks like one written before: block style, keys in
 * insertion order, sequences inside a mapping not indented ("tags:\n- a"), two-space nesting,
 * strings plain when they can be, else 'single-quoted', else "double-quoted" with escapes, long
 * scalars folded after column 80 with a two-space continuation, non-ASCII text kept as is.
 *
 * memglow's own implementation of those layout rules (the YAML 1.1 plain-scalar rules: which
 * strings would read back as booleans, numbers, dates or null and so need quotes; which
 * characters force quoting; where a long line may be folded). JSON-like values only: string,
 * number, boolean, null, arrays, plain objects, plus `RawScalar` (a value copied verbatim, used to
 * keep a date the user wrote unquoted).
 */

const BEST_WIDTH = 80;
const BEST_INDENT = 2;
const BREAKS = new Set(["\n", "\x85", " ", " "]);
const WS_OR_END = new Set(["\0", " ", "\t", "\r", "\n", "\x85", " ", " "]);

/** A scalar written exactly as given, unquoted (e.g. a date the note already had). */
class RawScalar {
  constructor(text) { this.text = String(text); }
}

// ---- which plain scalars would NOT read back as a string (YAML 1.1 implicit types) ----
const RESOLVERS = [
  ["yYnNtTfFoO", /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/],
  ["-+0123456789.", /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/],
  ["-+0123456789", /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/],
  ["<", /^(?:<<)$/],
  ["~nN", /^(?:~|null|Null|NULL|)$/],
  ["0123456789", /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/],
  ["=", /^(?:=)$/],
];
/** True when `s`, written plain, reads back as a string. (`$` also matches before one final "\n", as in the reference resolver.) */
function plainIsString(s) {
  if (s === "") return false; // reads back as null
  const c = s[0];
  const variants = s.endsWith("\n") ? [s, s.slice(0, -1)] : [s];
  for (const [first, re] of RESOLVERS) if (first.includes(c) && variants.some((v) => re.test(v))) return false;
  return true;
}
/** Same rule, exported for callers that want to know whether an unquoted value is a date. */
const TIMESTAMP_RE = RESOLVERS[5][1];

// ---- scalar analysis: which styles a string may use ----
function isPrintableUnicode(cp) {
  return cp === 0x85 || (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp < 0x10ffff);
}
function analyze(text) {
  const chars = Array.from(text);
  const n = chars.length;
  if (!n) return { chars, empty: true, multiline: false, allowFlowPlain: false, allowBlockPlain: true, allowSingle: true, allowDouble: true, allowBlock: false };
  let blockInd = false, flowInd = false, lineBreaks = false, special = false;
  let leadingSpace = false, leadingBreak = false, trailingSpace = false, trailingBreak = false, breakSpace = false, spaceBreak = false;
  if (text.startsWith("---") || text.startsWith("...")) { blockInd = true; flowInd = true; }
  let precededByWs = true;
  let followedByWs = n === 1 || WS_OR_END.has(chars[1]);
  let prevSpace = false, prevBreak = false;
  for (let i = 0; i < n; i++) {
    const ch = chars[i];
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) { flowInd = true; blockInd = true; }
      if (ch === "?" || ch === ":") { flowInd = true; if (followedByWs) blockInd = true; }
      if (ch === "-" && followedByWs) { flowInd = true; blockInd = true; }
    } else {
      if (",?[]{}".includes(ch)) flowInd = true;
      if (ch === ":") { flowInd = true; if (followedByWs) blockInd = true; }
      if (ch === "#" && precededByWs) { flowInd = true; blockInd = true; }
    }
    if (BREAKS.has(ch)) lineBreaks = true;
    const cp = ch.codePointAt(0);
    if (!(ch === "\n" || (cp >= 0x20 && cp <= 0x7e))) {
      if (!(isPrintableUnicode(cp) && cp !== 0xfeff)) special = true;
    }
    if (ch === " ") {
      if (i === 0) leadingSpace = true;
      if (i === n - 1) trailingSpace = true;
      if (prevBreak) breakSpace = true;
      prevSpace = true; prevBreak = false;
    } else if (BREAKS.has(ch)) {
      if (i === 0) leadingBreak = true;
      if (i === n - 1) trailingBreak = true;
      if (prevSpace) spaceBreak = true;
      prevSpace = false; prevBreak = true;
    } else { prevSpace = false; prevBreak = false; }
    precededByWs = WS_OR_END.has(ch);
    followedByWs = i + 2 >= n || WS_OR_END.has(chars[i + 2]);
  }
  let allowFlowPlain = true, allowBlockPlain = true, allowSingle = true, allowDouble = true, allowBlock = true;
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) allowFlowPlain = allowBlockPlain = false;
  if (trailingSpace) allowBlock = false;
  if (breakSpace) allowFlowPlain = allowBlockPlain = allowSingle = false;
  if (spaceBreak || special) allowFlowPlain = allowBlockPlain = allowSingle = allowBlock = false;
  if (lineBreaks) allowFlowPlain = allowBlockPlain = false;
  if (flowInd) allowFlowPlain = false;
  if (blockInd) allowBlockPlain = false;
  return { chars, empty: false, multiline: lineBreaks, allowFlowPlain, allowBlockPlain, allowSingle, allowDouble, allowBlock };
}

const ESCAPES = { "\0": "0", "\x07": "a", "\x08": "b", "\x09": "t", "\x0A": "n", "\x0B": "v", "\x0C": "f", "\x0D": "r", "\x1B": "e", "\"": "\"", "\\": "\\", "\x85": "N", "\xA0": "_", " ": "L", " ": "P" };

/** Python-style repr of a non-integer float, as the reference writer prints it. */
function floatText(x) {
  if (Number.isNaN(x)) return ".nan";
  if (x === Infinity) return ".inf";
  if (x === -Infinity) return "-.inf";
  const [mant, e] = x.toExponential().split("e");
  const exp = Number(e);
  let s;
  if (exp < -4 || exp >= 16) s = mant + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  else { s = x.toFixed(Math.max(0, (mant.replace(/^-/, "").replace(".", "").length - 1) - exp)); if (!s.includes(".")) s += ".0"; }
  s = s.toLowerCase();
  if (!s.includes(".") && s.includes("e")) s = s.replace("e", ".0e");
  return s;
}

class Emitter {
  constructor() {
    this.out = [];
    this.column = 0;
    this.whitespace = true;
    this.indention = true;
    this.indent = null;
    this.indents = [];
    this.flowLevel = 0;
  }
  write(s) { this.out.push(s); }
  increaseIndent(flow = false, indentless = false) {
    this.indents.push(this.indent);
    if (this.indent == null) this.indent = flow ? BEST_INDENT : 0;
    else if (!indentless) this.indent += BEST_INDENT;
  }
  writeIndicator(ind, needWhitespace, whitespace = false, indention = false) {
    const data = this.whitespace || !needWhitespace ? ind : " " + ind;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.column += data.length;
    this.write(data);
  }
  writeIndent() {
    const indent = this.indent || 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) this.writeLineBreak();
    if (this.column < indent) {
      this.whitespace = true;
      this.write(" ".repeat(indent - this.column));
      this.column = indent;
    }
  }
  writeLineBreak(data) {
    this.whitespace = true;
    this.indention = true;
    this.column = 0;
    this.write(data == null ? "\n" : data);
  }
  writePlain(chars, split) {
    if (!chars.length) return;
    if (!this.whitespace) { this.column += 1; this.write(" "); }
    this.whitespace = false;
    this.indention = false;
    let spaces = false, breaks = false, start = 0, end = 0;
    while (end <= chars.length) {
      const ch = end < chars.length ? chars[end] : null;
      if (spaces) {
        if (ch !== " ") {
          if (start + 1 === end && this.column > BEST_WIDTH && split) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
          } else {
            const data = chars.slice(start, end).join("");
            this.column += end - start;
            this.write(data);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch == null || !BREAKS.has(ch)) {
          if (chars[start] === "\n") this.writeLineBreak();
          for (const br of chars.slice(start, end)) { if (br === "\n") this.writeLineBreak(); else this.writeLineBreak(br); }
          this.writeIndent();
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else if (ch == null || ch === " " || BREAKS.has(ch)) {
        this.column += end - start;
        this.write(chars.slice(start, end).join(""));
        start = end;
      }
      if (ch != null) { spaces = ch === " "; breaks = BREAKS.has(ch); }
      end++;
    }
  }
  writeSingleQuoted(chars, split) {
    this.writeIndicator("'", true);
    let spaces = false, breaks = false, start = 0, end = 0;
    while (end <= chars.length) {
      const ch = end < chars.length ? chars[end] : null;
      if (spaces) {
        if (ch == null || ch !== " ") {
          if (start + 1 === end && this.column > BEST_WIDTH && split && start !== 0 && end !== chars.length) {
            this.writeIndent();
          } else {
            this.column += end - start;
            this.write(chars.slice(start, end).join(""));
          }
          start = end;
        }
      } else if (breaks) {
        if (ch == null || !BREAKS.has(ch)) {
          if (chars[start] === "\n") this.writeLineBreak();
          for (const br of chars.slice(start, end)) { if (br === "\n") this.writeLineBreak(); else this.writeLineBreak(br); }
          this.writeIndent();
          start = end;
        }
      } else if (ch == null || ch === " " || BREAKS.has(ch) || ch === "'") {
        if (start < end) {
          this.column += end - start;
          this.write(chars.slice(start, end).join(""));
          start = end;
        }
      }
      if (ch === "'") { this.column += 2; this.write("''"); start = end + 1; }
      if (ch != null) { spaces = ch === " "; breaks = BREAKS.has(ch); }
      end++;
    }
    this.writeIndicator("'", false);
  }
  writeDoubleQuoted(chars, split) {
    this.writeIndicator("\"", true);
    let start = 0, end = 0;
    while (end <= chars.length) {
      const ch = end < chars.length ? chars[end] : null;
      const cp = ch == null ? 0 : ch.codePointAt(0);
      if (ch == null || "\"\\\x85  ﻿".includes(ch)
          || !((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd))) {
        if (start < end) {
          this.column += end - start;
          this.write(chars.slice(start, end).join(""));
          start = end;
        }
        if (ch != null) {
          let data;
          if (Object.prototype.hasOwnProperty.call(ESCAPES, ch)) data = "\\" + ESCAPES[ch];
          else if (cp <= 0xff) data = "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
          else if (cp <= 0xffff) data = "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
          else data = "\\U" + cp.toString(16).toUpperCase().padStart(8, "0");
          this.column += data.length;
          this.write(data);
          start = end + 1;
        }
      }
      if (end > 0 && end < chars.length - 1 && (ch === " " || start >= end) && this.column + (end - start) > BEST_WIDTH && split) {
        const data = chars.slice(start, end).join("") + "\\";
        if (start < end) start = end;
        this.column += data.length; // a JS-length count is fine here: only ASCII + already-counted text
        this.write(data);
        this.writeIndent();
        this.whitespace = false;
        this.indention = false;
        if (chars[start] === " ") { this.column += 1; this.write("\\"); }
      }
      end++;
    }
    this.writeIndicator("\"", false);
  }

  /** A scalar node. `value` is already a string (its text) with `isStr` telling its type. */
  scalar(text, isStr, simpleKey) {
    this.increaseIndent(true);
    const a = analyze(text);
    let style;
    const implicit = isStr ? plainIsString(text) : true;
    if (implicit && !(simpleKey && (a.empty || a.multiline)) && ((this.flowLevel && a.allowFlowPlain) || (!this.flowLevel && a.allowBlockPlain))) style = "";
    // NEL / LINE SEPARATOR / PARAGRAPH SEPARATOR are line breaks to a YAML reader, but not to a
    // line-based one: they are only ever written escaped, in double quotes.
    else if (a.allowSingle && !(simpleKey && a.multiline) && !/[\x85\u2028\u2029]/.test(text)) style = "'";
    else style = "\"";
    const split = !simpleKey;
    if (style === "\"") this.writeDoubleQuoted(a.chars, split);
    else if (style === "'") this.writeSingleQuoted(a.chars, split);
    else this.writePlain(a.chars, split);
    this.indent = this.indents.pop();
  }

  node(v, ctx = {}) {
    if (v instanceof RawScalar) {
      this.increaseIndent(true);
      const chars = Array.from(v.text);
      this.writePlain(chars, false);
      this.indent = this.indents.pop();
      return;
    }
    if (v === null || v === undefined) return this.scalar("null", false, ctx.simpleKey);
    if (typeof v === "boolean") return this.scalar(v ? "true" : "false", false, ctx.simpleKey);
    if (typeof v === "number") return this.scalar(Number.isInteger(v) ? String(v) : floatText(v), false, ctx.simpleKey);
    if (typeof v === "bigint") return this.scalar(String(v), false, ctx.simpleKey);
    if (typeof v === "string") return this.scalar(v, true, ctx.simpleKey);
    if (Array.isArray(v)) {
      if (!v.length || this.flowLevel) return this.flowEmpty("[", "]");
      const indentless = !!ctx.mapping && !this.indention;
      this.increaseIndent(false, indentless);
      for (const item of v) {
        this.writeIndent();
        this.writeIndicator("-", true, false, true);
        this.node(item, { sequence: true });
      }
      this.indent = this.indents.pop();
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (!keys.length || this.flowLevel) return this.flowEmpty("{", "}");
      this.increaseIndent(false);
      for (const k of keys) {
        this.writeIndent();
        const ka = analyze(k);
        if (ka.multiline || ka.chars.length >= 128) throw new Error(`frontmatter key too long or multi-line: ${JSON.stringify(k.slice(0, 40))}`);
        this.node(k, { mapping: true, simpleKey: true });
        this.writeIndicator(":", false);
        this.node(v[k], { mapping: true });
      }
      this.indent = this.indents.pop();
      return;
    }
    return this.scalar(String(v), true, ctx.simpleKey);
  }
  flowEmpty(open, close) {
    this.writeIndicator(open, true, true);
    this.writeIndicator(close, false);
  }
}

/**
 * dumpYaml(object) → the YAML text of a mapping, ending with "\n" ("{}\n" for an empty one).
 * Throws on a key it cannot write as a simple key (multi-line, or 128+ characters).
 */
function dumpYaml(obj) {
  const e = new Emitter();
  e.node(obj, {});
  e.writeIndent(); // document end: closes the last line
  return e.out.join("");
}

module.exports = { dumpYaml, RawScalar, plainIsString, analyze, TIMESTAMP_RE, floatText };
