"use strict";
/**
 * memglow memory server — one Markdown note → a plain object the store indexes: frontmatter
 * (title, type, permalink, tags, any other key), body, sections by heading, `[[links]]`,
 * observations (`- [category] text #tag (context)`) and relations (`- rel_type [[Target]]`; any
 * other `[[link]]` is a `links_to` relation). Pure: no fs (the store reads the file).
 */
const path = require("path");
const { splitFrontmatter, parseYaml } = require("./frontmatter");
const { slugify, stableId, stableInt } = require("./text");

/** Lines of the body with fenced code blocks blanked (so headings/links inside code are ignored). */
function codeMask(lines) {
  const out = [];
  let fence = null;
  for (const l of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      out.push("");
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; out.push(""); continue; }
    out.push(l);
  }
  return out;
}

const stripInlineCode = (l) => l.replace(/`[^`\n]*`/g, (s) => " ".repeat(s.length));

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asList);
  if (typeof v === "string") return v.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
  return [String(v)];
}

const LINK_RE = /\[\[([^\][|#\n]{1,200})(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const OBS_RE = /^\s*[-*+]\s+\[([^\][\n]{1,60})\]\s+(.+?)\s*$/;
const REL_RE = /^\s*[-*+]\s+([A-Za-zÀ-ɏ_][\wÀ-ɏ -]{0,48}?)\s+\[\[([^\][|#\n]{1,200})(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]\s*(?:\((.{0,200})\))?\s*$/;

/**
 * parseNote({ rel, text, mtimeMs, ctimeMs, size, project }) → note.
 * `rel` is the path relative to the root, "/"-separated (e.g. "memory/project/x.md").
 */
function parseNote({ rel, text, mtimeMs = 0, ctimeMs = 0, size = 0, project = "main" }) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const { block, body, bodyOffset } = splitFrontmatter(t);
  const { data: fm, error: fmError } = parseYaml(block);
  const base = path.posix.basename(rel).replace(/\.md$/i, "");
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim()
    : (fm.title != null && typeof fm.title !== "object" ? String(fm.title) : base);
  const relNoExt = rel.replace(/\.md$/i, "");
  const generated = (project ? project + "/" : "") + slugify(relNoExt);
  const declared = typeof fm.permalink === "string" && fm.permalink.trim() ? fm.permalink.trim().replace(/^\/+|\/+$/g, "") : "";
  const permalink = declared || generated;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type.trim()
    : (fm.metadata && typeof fm.metadata.type === "string" ? fm.metadata.type : "note");
  const tags = asList(fm.tags);
  const description = typeof fm.description === "string" ? fm.description : "";

  const lines = body.split(/\r?\n/);
  const masked = codeMask(lines).map(stripInlineCode);

  // Sections: every ATX heading outside code; a section runs to the next heading of the same or a
  // higher level. `start`/`end` are line indexes in the body.
  const headings = [];
  masked.forEach((l, i) => {
    const m = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  const sections = headings.map((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < headings.length; j++) if (headings[j].level <= h.level) { end = headings[j].line; break; }
    return { heading: h.text, level: h.level, start: h.line, end };
  });

  const links = [];
  const relations = [];
  const observations = [];
  const seenRel = new Set();
  const addRel = (type, target, context) => {
    const k = type + "\u0000" + target.toLowerCase();
    if (seenRel.has(k)) return;
    seenRel.add(k);
    relations.push({ type, target, context: context || null });
  };
  masked.forEach((l, i) => {
    if (!l.includes("[")) return;
    const rm = REL_RE.exec(l);
    if (rm && !/[*:`]/.test(rm[1])) {
      const target = rm[2].trim();
      links.push(target);
      addRel(rm[1].trim().replace(/\s+/g, "_"), target, rm[3]);
      return;
    }
    const om = OBS_RE.exec(l);
    if (om && !/^[ xX]$/.test(om[1]) && !om[1].startsWith("[") && !/^\]?\(/.test(l.slice(l.indexOf(om[1]) + om[1].length + 1))) {
      let content = om[2];
      const tagsHere = [];
      content = content.replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_, sp, tg) => { tagsHere.push(tg); return sp; }).trim();
      let context = null;
      const cm = /\s\(([^()]*)\)\s*$/.exec(content);
      if (cm) { context = cm[1]; content = content.slice(0, cm.index).trim(); }
      observations.push({ category: om[1].trim(), content, tags: tagsHere, context, line: i });
    }
    for (const m of l.matchAll(LINK_RE)) {
      const target = m[1].trim();
      if (!target) continue;
      links.push(target);
      addRel("links_to", target, null);
    }
  });

  return {
    rel,
    file_path: rel,
    dir: path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel),
    base,
    slug: slugify(base, { keepSlashes: false }),
    title,
    permalink,
    permalinkDeclared: !!declared,
    generatedPermalink: generated,
    type,
    tags,
    status: typeof fm.status === "string" ? fm.status : (fm.status != null ? String(fm.status) : null),
    description,
    frontmatter: fm,
    frontmatterError: fmError,
    hasFrontmatter: block != null,
    raw: t,
    body,
    bodyOffset,
    lines,
    sections,
    links: [...new Set(links)],
    relations,
    observations,
    mtimeMs,
    ctimeMs: ctimeMs || mtimeMs,
    size,
    // Unique per FILE (two files declaring the same permalink still get distinct ids), stable
    // across restarts.
    external_id: stableId("memglow-note:" + permalink + "\u0000" + rel),
    entity_id: stableInt("memglow-note:" + permalink + "\u0000" + rel),
  };
}

module.exports = { parseNote, codeMask, asList };
