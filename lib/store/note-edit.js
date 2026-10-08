"use strict";
/**
 * memglow memory server — pure text operations behind write_note / edit_note: building a new
 * note (frontmatter + body), changing some frontmatter keys while leaving every other byte of the
 * block as it was, and the edit_note operations (append, prepend, find_replace and the three
 * section operations). No fs here.
 *
 * Line endings: a note using CRLF is edited as LF and written back with CRLF; a UTF-8 BOM is kept.
 */
const { splitFrontmatter, parseYaml, scalar } = require("./frontmatter");
const { dumpYaml, RawScalar, TIMESTAMP_RE } = require("./yaml-dump");
const { codeMask } = require("./note");

class EditError extends Error {
  constructor(message, code) { super(message); this.code = code || "EDIT_FAILED"; }
}

// ---- text envelope (BOM, CRLF) ----

function unwrap(text) {
  let t = String(text);
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);
  const crlf = /\r\n/.test(t);
  if (crlf) t = t.replace(/\r\n/g, "\n");
  return { text: t, bom, crlf };
}
function rewrap(text, env) {
  let t = env.crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  if (env.bom) t = "﻿" + t;
  return t;
}
const lf = (s) => String(s == null ? "" : s).replace(/\r\n/g, "\n");

// ---- frontmatter blocks as top-level key segments ----

const KEY_LINE = /^(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([^\s#'"\-[\]{},&*!|>%@`][^:]*?|-[^\s:][^:]*?))[ \t]*:(?:[ \t]|$)/;

function keyOfLine(line) {
  const m = KEY_LINE.exec(line);
  if (!m) return null;
  if (m[1] != null) return m[1].replace(/''/g, "'");
  if (m[2] != null) { try { return JSON.parse('"' + m[2] + '"'); } catch { return m[2]; } }
  return m[3];
}

/** A frontmatter block (LF text between the fences) → { prelude: [lines], segs: [{ key, lines }] }. */
function segments(block) {
  const prelude = [], segs = [];
  if (block == null || block === "") return { prelude, segs };
  for (const line of block.split("\n")) {
    const k = /^[ \t]/.test(line) ? null : keyOfLine(line);
    if (k != null) segs.push({ key: k, lines: [line] });
    else if (segs.length) segs[segs.length - 1].lines.push(line);
    else prelude.push(line);
  }
  return { prelude, segs };
}
function joinSegments({ prelude, segs }) {
  return prelude.concat(...segs.map((s) => s.lines)).join("\n");
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** The YAML lines of one `key: value` (no trailing newline). */
function keyLines(key, value) {
  return dumpYaml({ [key]: value }).replace(/\n$/, "").split("\n");
}

/** Same value, as read back (a number written as "1.0e-07" reads back as that text). */
function sameValue(read, want) {
  if (want instanceof RawScalar) want = scalar(want.text);
  if (typeof want === "number" && typeof read === "string") return Number(read.replace(/_/g, "")) === want;
  if (Array.isArray(want) && Array.isArray(read)) return want.length === read.length && want.every((w, i) => sameValue(read[i], w));
  if (want && typeof want === "object" && read && typeof read === "object" && !Array.isArray(want) && !Array.isArray(read)) {
    const kw = Object.keys(want), kr = Object.keys(read);
    return kw.length === kr.length && kw.every((k) => Object.prototype.hasOwnProperty.call(read, k) && sameValue(read[k], want[k]));
  }
  return deepEqual(read, want);
}

/**
 * Sets keys in a frontmatter block, keeping every other line exactly as it was. A key already
 * present (its last occurrence: the one a YAML reader keeps) is rewritten in place — or left
 * untouched when it already holds that value; a new key goes at the end. Returns the new block.
 * The result is read back and checked: every key changed holds its new value, every other key
 * its old one — else EditError (nothing is written), never a corrupted block.
 */
function setKeys(block, updates) {
  const out = setKeysRaw(block, updates);
  const before = parseYaml(block), after = parseYaml(out);
  const fail = () => { throw new EditError("the frontmatter could not be updated safely (it would not read back as intended); no change made", "BAD_FRONTMATTER"); };
  if (after.error || before.error) fail();
  const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data), ...Object.keys(updates).filter((k) => updates[k] !== undefined)]);
  for (const k of keys) {
    const has = Object.prototype.hasOwnProperty.call(updates, k) && updates[k] !== undefined;
    if (has ? !sameValue(after.data[k], updates[k]) : !deepEqual(after.data[k], before.data[k])) fail();
    if (!Object.prototype.hasOwnProperty.call(after.data, k)) fail();
  }
  return out;
}

function setKeysRaw(block, updates) {
  const sg = segments(block);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    let idx = -1;
    for (let i = sg.segs.length - 1; i >= 0; i--) if (sg.segs[i].key === k) { idx = i; break; }
    if (idx >= 0) {
      const cur = parseYaml(sg.segs[idx].lines.join("\n"));
      if (!cur.error && Object.prototype.hasOwnProperty.call(cur.data, k) && deepEqual(cur.data[k], v)) continue;
      sg.segs[idx] = { key: k, lines: keyLines(k, v) };
    } else {
      // A new key: after the last non-blank line, so trailing blank lines stay at the end.
      const lines = keyLines(k, v);
      sg.segs.push({ key: k, lines });
    }
  }
  return joinSegments(sg);
}

/** Removes keys from a block (every occurrence). */
function removeKeys(block, keys) {
  const sg = segments(block);
  sg.segs = sg.segs.filter((s) => !keys.includes(s.key));
  return joinSegments(sg);
}

/**
 * The values of a block, for re-writing it with dumpYaml: a plain (unquoted) date or timestamp
 * is kept verbatim (RawScalar), so it stays a date for a YAML 1.1 reader instead of becoming a
 * quoted string.
 */
function valuesForDump(block) {
  const sg = segments(block);
  const { data, error } = parseYaml(block);
  if (error) throw new EditError("Invalid YAML in frontmatter: " + error, "BAD_FRONTMATTER");
  const out = {};
  for (const s of sg.segs) {
    if (!Object.prototype.hasOwnProperty.call(data, s.key)) continue;
    const m = /^[^:]*:[ \t]+(.+?)[ \t]*$/.exec(s.lines[0]);
    if (s.lines.length === 1 && m && typeof data[s.key] === "string" && TIMESTAMP_RE.test(m[1])) out[s.key] = new RawScalar(m[1]);
    else out[s.key] = data[s.key];
  }
  return out;
}

/** Splits a note (LF, no BOM) into { block (string|null), head (text up to the body), body }. */
function splitNote(text) {
  const s = splitFrontmatter(text);
  if (s.block == null) return { block: null, head: "", body: text };
  return { block: s.block, head: text.slice(0, s.bodyOffset), body: s.body };
}

/**
 * The note head (opening fence, block, closing fence — as split by splitNote) with its block
 * replaced; both fence lines stay byte-for-byte.
 */
function replaceBlock(head, block, newBlock) {
  const openLen = head.indexOf("\n") + 1;
  if (block === "") return head.slice(0, openLen) + (newBlock ? newBlock + "\n" : "") + head.slice(openLen);
  return head.slice(0, openLen) + newBlock + head.slice(openLen + block.length);
}

/** A new note's text: frontmatter (an ordered object) then the body, as basic-memory lays it out. */
function buildNote(frontmatter, body) {
  const yaml = dumpYaml(frontmatter);
  return body ? `---\n${yaml}---\n\n${body}` : `---\n${yaml}---\n`;
}

// ---- edit operations (on LF text without BOM) ----

function appendText(current, content) {
  if (!content) return current; // a metadata-only edit: the body is not touched
  if (current && !current.endsWith("\n")) return current + "\n" + content;
  return current + content;
}

function prependText(current, content) {
  const { block, head, body } = splitNote(current);
  if (block == null) {
    if (!content) return current;
    return content + (content.endsWith("\n") ? "" : "\n") + current;
  }
  // Keep the frontmatter bytes and the blank line(s) after it; the new text goes first in the body.
  const lead = /^\n*/.exec(body)[0];
  const rest = body.slice(lead.length);
  if (!content) return current;
  return head + (lead || "\n") + content + (content.endsWith("\n") || !rest ? "" : "\n") + rest;
}

function findReplace(current, findText, content, expected) {
  if (typeof findText !== "string" || !findText) throw new EditError("find_text is required for find_replace operation", "INVALID");
  if (!findText.trim()) throw new EditError("find_text cannot be empty or whitespace only", "INVALID");
  const count = current.split(findText).length - 1;
  if (count !== expected) {
    if (count === 0) throw new EditError(`Text to replace not found: '${findText}'`, "TEXT_NOT_FOUND");
    throw new EditError(`Expected ${expected} occurrences of '${findText}', but found ${count}`, "WRONG_COUNT");
  }
  const out = current.split(findText).join(content);
  // The frontmatter must still be readable afterwards (a replacement can reach into it).
  const before = splitNote(current), after = splitNote(out);
  if (before.block != null && !parseYaml(before.block).error) {
    if (after.block == null || parseYaml(after.block).error) throw new EditError("the replacement would break the note's frontmatter; no change made", "BAD_FRONTMATTER");
  }
  return out;
}

/** Headings of a body: [{ level, text, start, lineEnd, line }] (char offsets), fenced code ignored. */
function headingsOf(body) {
  const lines = body.split("\n");
  const masked = codeMask(lines);
  const out = [];
  let off = 0;
  lines.forEach((l, i) => {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(masked[i]);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), start: off, lineEnd: off + l.length, line: l });
    off += l.length + 1;
  });
  return out;
}

/** The one heading a `section` argument designates, or an EditError (not found / several). */
function findSection(body, section) {
  const want = String(section || "").trim();
  if (!want) throw new EditError("section parameter is required for section-based operations", "INVALID");
  const hs = headingsOf(body);
  const m = /^(#{1,6})[ \t]*(.*?)[ \t]*#*[ \t]*$/.exec(want);
  let found;
  let label = want;
  if (m && want.startsWith("#")) {
    found = hs.filter((h) => h.level === m[1].length && h.text === m[2].trim());
  } else {
    // Without "#": a level-2 heading first (as "## <section>"), else a heading of any level.
    found = hs.filter((h) => h.level === 2 && h.text === want);
    label = "## " + want;
    if (!found.length) { found = hs.filter((h) => h.text === want); if (found.length) label = want; }
  }
  if (!found.length) throw new EditError(`Section '${label}' not found in note`, "SECTION_NOT_FOUND");
  if (found.length > 1) throw new EditError(`Multiple sections found with header '${label}'. Section replacement requires unique headers.`, "SECTION_AMBIGUOUS");
  return { h: found[0], hs };
}

function withBody(current, fn) {
  const { block, head, body } = splitNote(current);
  const nb = fn(body);
  return block == null ? nb : head + nb;
}

function stripDuplicateHeading(content, headingLine) {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && lines[i].trim() === headingLine.trim()) return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
  return content;
}

function replaceSection(current, section, content, replaceSubsections = true) {
  return withBody(current, (body) => {
    const { h, hs } = findSection(body, section);
    const after = hs.filter((x) => x.start > h.start);
    const next = after.find((x) => (replaceSubsections ? x.level <= h.level : true));
    const end = next ? next.start : body.length;
    let payload = stripDuplicateHeading(content, h.line);
    const headEnd = h.lineEnd < body.length ? h.lineEnd + 1 : body.length;
    const prefix = body.slice(0, headEnd) + (h.lineEnd < body.length ? "" : "\n");
    if (payload && !payload.endsWith("\n")) payload += "\n";
    if (next && payload && !payload.endsWith("\n\n")) payload += "\n";
    return prefix + payload + body.slice(end);
  });
}

function insertBeforeSection(current, section, content) {
  return withBody(current, (body) => {
    const { h } = findSection(body, section);
    let payload = content;
    if (!payload) return body;
    if (!payload.endsWith("\n")) payload += "\n";
    if (!payload.endsWith("\n\n")) payload += "\n";
    let before = body.slice(0, h.start);
    if (before && !before.endsWith("\n\n")) before += before.endsWith("\n") ? "\n" : "\n\n";
    return before + payload + body.slice(h.start);
  });
}

function insertAfterSection(current, section, content) {
  return withBody(current, (body) => {
    const { h } = findSection(body, section);
    if (!content) return body;
    let payload = content;
    if (!payload.endsWith("\n")) payload += "\n";
    const headEnd = h.lineEnd < body.length ? h.lineEnd + 1 : body.length;
    const prefix = body.slice(0, headEnd) + (h.lineEnd < body.length ? "" : "\n");
    return prefix + payload + body.slice(headEnd);
  });
}

/**
 * Applies one edit_note operation to a note's full text (any line endings, BOM or not) and
 * returns the new full text in the same envelope.
 */
function applyEdit(text, { operation, content, section, find_text, expected_replacements = 1, replace_subsections = true }) {
  const env = unwrap(text);
  const c = lf(content);
  let out;
  switch (operation) {
    case "append": out = appendText(env.text, c); break;
    case "prepend": out = prependText(env.text, c); break;
    case "find_replace": out = findReplace(env.text, lf(find_text), c, expected_replacements); break;
    case "replace_section": out = replaceSection(env.text, section, c, replace_subsections); break;
    case "insert_before_section": out = insertBeforeSection(env.text, section, c); break;
    case "insert_after_section": out = insertAfterSection(env.text, section, c); break;
    default: throw new EditError(`Invalid operation '${operation}'`, "INVALID");
  }
  return rewrap(out, env);
}

/**
 * Merges frontmatter keys into a note's full text (keys absent → added at the end; present →
 * rewritten in place; the rest of the block and the body byte-for-byte). A note without
 * frontmatter gets one, with `base` keys (title, type, permalink) first.
 */
function mergeFrontmatter(text, updates, base = {}) {
  const keys = Object.keys(updates || {});
  if (!keys.length) return text;
  const env = unwrap(text);
  const { block, head, body } = splitNote(env.text);
  let out;
  if (block == null) {
    out = buildNote({ ...base, ...updates }, env.text.replace(/^\n+/, ""));
  } else {
    if (parseYaml(block).error) throw new EditError("the note's frontmatter cannot be read safely; its keys were not changed", "BAD_FRONTMATTER");
    out = replaceBlock(head, block, setKeys(block, updates)) + body;
  }
  return rewrap(out, env);
}

module.exports = {
  EditError, unwrap, rewrap, segments, joinSegments, setKeys, removeKeys, valuesForDump, splitNote, replaceBlock, buildNote,
  applyEdit, mergeFrontmatter, headingsOf, findSection, deepEqual,
};
