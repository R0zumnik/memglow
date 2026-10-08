"use strict";
/**
 * memglow memory server — tool handlers. Each takes the call's arguments and returns an MCP
 * `tools/call` result. Text outputs follow the layout basic-memory clients already parse (search
 * result blocks with `- permalink:` lines, `# Context:` blocks, `## Recent Activity:` …), written
 * from scratch for memglow; JSON outputs keep the same field names.
 *
 * Phase A (stage 0.4.5.1): every write tool answers a clear read-only error.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createSearch } = require("../lib/store/search");
const { parseTimeframe } = require("../lib/store/timeframe");
const { stableId, stableInt, globToRegExp, slugify, words } = require("../lib/store/text");
const { TOOLS, WRITE_TOOLS, UNSUPPORTED_TOOLS } = require("./schemas");

const SERVER_VERSION = "0.4.5.1";
const MAX_QUERY_CHARS = 2000;
const MAX_QUERY_TERMS = 64;
const READ_ONLY_MESSAGE = "memglow memory server: read-only (phase A / shadow mode)";
const UNSUPPORTED_MESSAGE = "not supported by memglow memory server";

// ---- result helpers (FastMCP-compatible shapes: the text, plus structuredContent {result}) ----

function textResult(text) {
  return { content: [{ type: "text", text }], structuredContent: { result: text }, isError: false };
}
function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: { result: obj }, isError: false };
}
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}
class ToolError extends Error {}

// ---- argument helpers ----

const str = (v, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
function int(v, d, { min = -Infinity, max = Infinity, name = "value" } = {}) {
  if (v == null || v === "") return d;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new ToolError(`Invalid ${name}: ${JSON.stringify(v)} is not an integer`);
  if (n < min) throw new ToolError(`${name} must be >= ${min}, got ${n}`);
  if (n > max) throw new ToolError(`${name} must be <= ${max}, got ${n}`);
  return n;
}
const fmtOf = (v, d = "text") => (str(v, d).toLowerCase() === "json" ? "json" : str(v, d).toLowerCase() === "text" ? "text" : d);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const trimBody = (n) => n.body.trim();
const dirOf = (rel) => { const d = path.posix.dirname(rel); return d === "." ? "" : d; };

function createTools({ store, project = store.project, readOnly = true, startedAt = Date.now() }) {
  const engine = createSearch(store);
  const projectId = stableId("memglow-project:" + project);

  // ---- search_notes ----

  function observationPermalink(n, o) {
    return `${n.permalink}/observations/${slugify(o.category, { keepSlashes: false }) || "note"}/${slugify(o.content, { keepSlashes: false }).slice(0, 80)}`;
  }
  function hitTitle(h) {
    if (h.kind === "observation") return `${h.observation.category}: ${h.observation.content.length > 80 ? h.observation.content.slice(0, 79) + "…" : h.observation.content}`;
    if (h.kind === "relation") return `${h.relation.type}: ${h.relation.target}`;
    return h.note.title;
  }
  function hitPermalink(h) {
    if (h.kind === "observation") return observationPermalink(h.note, h.observation);
    if (h.kind === "relation") return `${h.note.permalink}/${h.relation.type}/${slugify(h.relation.target, { keepSlashes: false })}`;
    return h.note.permalink;
  }
  function hitJson(h) {
    const n = h.note;
    const o = {
      title: hitTitle(h),
      type: h.kind,
      score: h.score,
      entity: n.permalink,
      external_id: h.kind === "entity" ? n.external_id : stableId("memglow-" + h.kind + ":" + hitPermalink(h)),
      permalink: hitPermalink(h),
      content: h.kind === "entity" ? trimBody(n).slice(0, 4000) : h.match,
      matched_chunk: h.match || "",
      file_path: n.file_path,
      updated_at: iso(n.mtimeMs),
      metadata: { note_type: n.type },
      entity_id: n.entity_id,
    };
    if (h.kind === "observation") o.category = h.observation.category;
    if (h.kind === "relation") { o.relation_type = h.relation.type; o.to_name = h.relation.target; }
    return o;
  }

  /** Refuses oversized queries (they would only burn CPU): MAX_QUERY_CHARS / MAX_QUERY_TERMS. */
  function checkQuery(q) {
    if (typeof q !== "string") return;
    if (q.length > MAX_QUERY_CHARS) throw new ToolError(`query too long: ${q.length} characters (maximum ${MAX_QUERY_CHARS})`);
    const n = words(q).length;
    if (n > MAX_QUERY_TERMS) throw new ToolError(`query has too many words: ${n} (maximum ${MAX_QUERY_TERMS})`);
  }

  function runSearch(args) {
    checkQuery(args.query);
    const page = int(args.page, 1, { min: 1, name: "page" });
    const pageSize = int(args.page_size, 10, { min: 1, max: 1000, name: "page_size" });
    const type = args.search_type == null || args.search_type === "" ? "text" : str(args.search_type).toLowerCase();
    if (!["text", "title", "permalink", "vector", "semantic", "hybrid"].includes(type)) {
      throw new ToolError(`Invalid search_type '${args.search_type}'. Valid options: hybrid, permalink, semantic, text, title, vector`);
    }
    return engine.search({ ...args, search_type: type, page, page_size: pageSize });
  }

  function hasCriteria(args) {
    const nonEmpty = (v) => v != null && !(Array.isArray(v) && !v.length) && !(typeof v === "string" && !v.trim()) && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
    return ["query", "metadata_filters", "tags", "status", "note_types", "entity_types", "categories", "after_date"].some((k) => nonEmpty(args[k]));
  }

  function search_notes(args) {
    const format = fmtOf(args.output_format);
    if (!hasCriteria(args)) {
      return textResult("# No Search Criteria\n\nGive at least one of: `query`, `metadata_filters`, `tags`, `status`, `note_types`, `entity_types`, `categories`, `after_date`.");
    }
    const r = runSearch(args);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (format === "json") {
      return jsonResult({ results: r.results.map(hitJson), current_page: r.page, page_size: r.page_size, total: r.total, total_is_exact: true, has_more: r.has_more });
    }
    if (!r.results.length) {
      const where = r.page > 1 && r.total ? ` on page ${r.page} (${r.total} results in all)` : "";
      return textResult(`No results found for '${query}' in project '${project}'${where}. Try broader or different words, or call recent_activity(project="${project}") to see what changed lately.`);
    }
    const lines = [query ? `# Search Results: ${query}` : "# Search Results", `*project: ${project}*`, ""];
    for (const h of r.results) {
      const j = hitJson(h);
      lines.push(`### ${j.title}`, `- permalink: ${j.permalink}`, `- external_id: ${j.external_id}`, `- score: ${h.score.toFixed(4)}`);
      if (h.match) lines.push(`- match: ${h.match.replace(/\s+/g, " ").slice(0, 200)}`);
      lines.push("");
    }
    const c = r.results.length;
    lines.push("---", `*${c} result${c === 1 ? "" : "s"} | page ${r.page}, page_size ${r.page_size}${r.has_more ? " | more available" : ""}*`);
    return textResult(lines.join("\n"));
  }

  // ---- read_note / view_note / read_content / fetch ----

  function relatedFor(identifier, page, pageSize) {
    // Capped like a search query (an oversized identifier just gets fewer suggestions).
    const q = words(str(identifier).replace(/^memory:\/\//i, "").slice(0, MAX_QUERY_CHARS)).slice(0, MAX_QUERY_TERMS).join(" ");
    try { return engine.search({ query: q, page, page_size: pageSize }).results; } catch { return []; }
  }

  function notFoundText(identifier, related) {
    const id = str(identifier);
    if (!related.length) {
      return [
        `# Note Not Found in ${project}: "${id}"`, "",
        `No note matches "${id}", and a search for it found nothing either.`, "",
        "## What to try",
        "- Use the exact permalink (it is listed by search_notes and list_directory).",
        `- Search with other words: search_notes(project="${project}", query="...")`,
        `- See what changed lately: recent_activity(timeframe="7d")`,
      ].join("\n");
    }
    const out = [`# Note Not Found in ${project}: "${id}"`, "", `No exact match for "${id}". Closest notes:`, ""];
    related.forEach((h, i) => {
      out.push(`## ${i + 1}. ${h.note.title}`, `- **Type**: entity`, `- **Permalink**: ${h.note.permalink}`, "",
        "Read it with:", "```", `read_note(project="${project}", identifier="${h.note.permalink}")`, "```", "");
    });
    out.push("## More", `For a wider list: search_notes(project="${project}", query="${id.replace(/"/g, '\\"')}")`);
    return out.join("\n");
  }

  function read_note(args) {
    const identifier = str(args.identifier);
    if (!identifier.trim()) throw new ToolError("identifier is required");
    const format = fmtOf(args.output_format);
    const n = store.resolve(identifier);
    if (n) {
      if (format === "json") {
        return jsonResult({
          title: n.title, permalink: n.permalink, file_path: n.file_path,
          content: args.include_frontmatter === true || args.include_frontmatter === "true" ? n.raw : n.raw.slice(n.bodyOffset),
          frontmatter: n.frontmatter,
        });
      }
      return textResult(n.raw);
    }
    const page = int(args.page, 1, { min: 1, name: "page" });
    const pageSize = int(args.page_size, 10, { min: 1, max: 100, name: "page_size" });
    const related = relatedFor(identifier, page, pageSize);
    if (format === "json") {
      const o = { title: null, permalink: null, file_path: null, content: null, frontmatter: null };
      if (related.length) o.related_results = related.map((h) => ({ title: h.note.title, permalink: h.note.permalink, file_path: h.note.file_path }));
      return jsonResult(o);
    }
    return textResult(notFoundText(identifier, related));
  }

  function view_note(args) {
    const identifier = str(args.identifier);
    if (!identifier.trim()) throw new ToolError("identifier is required");
    const n = store.resolve(identifier);
    if (!n) return textResult(notFoundText(identifier, relatedFor(identifier, 1, 10)));
    return textResult(`Note found: "${identifier}"\nShow it to the user as a Markdown document (artifact).\n\nContent:\n---\n${n.raw}\n---`);
  }

  const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".html", ".htm", ".xml", ".js", ".ts", ".py", ".sh", ".css", ".ini", ".toml", ".log", ".conf", ".canvas"]);
  const MIME = { ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };

  function read_content(args) {
    const p = str(args.path).trim();
    if (!p) throw new ToolError("path is required");
    // A note (permalink, title…) first, then a plain file under the root. Either way the real
    // path must stay inside the root (symlinks included), no dot-file/dot-folder, regular files only.
    const n = store.resolve(p);
    const sp = store.safePath(n ? n.rel : p);
    if (!sp) return errorResult(`Path '${p}' is not allowed: only regular files inside the project (no dot-files, no links leaving it)`);
    if (sp.missing) return errorResult(`File not found: '${p}'`);
    const abs = sp.abs, rel = sp.rel;
    let st;
    try { st = fs.statSync(abs); } catch { return errorResult(`File not found: '${p}'`); }
    if (!st.isFile()) return errorResult(`Not a file: '${p}'`);
    if (st.size > 10 * 1024 * 1024) return errorResult(`File too large to read: '${rel}' (${st.size} bytes)`);
    const ext = path.extname(rel).toLowerCase();
    let obj;
    if (TEXT_EXT.has(ext) || !ext) {
      const text = fs.readFileSync(abs, "utf8").replace(/^﻿/, "");
      obj = { type: "text", text, content_type: (MIME[ext] || "text/plain") + "; charset=utf-8", encoding: "utf-8" };
    } else if (/^image\//.test(MIME[ext] || "")) {
      obj = { type: "image", source: { type: "base64", media_type: MIME[ext], data: fs.readFileSync(abs).toString("base64") } };
    } else {
      obj = { type: "document", source: { type: "base64", media_type: MIME[ext] || "application/octet-stream", data: fs.readFileSync(abs).toString("base64") } };
    }
    return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
  }

  function chatgptResult(obj) {
    const item = { type: "text", text: JSON.stringify(obj) };
    return { content: [item], structuredContent: { result: [item] }, isError: false };
  }

  function search(args) {
    const query = str(args.query);
    let r;
    try { checkQuery(query); r = engine.search({ query, page: 1, page_size: 10 }); }
    catch (e) { return chatgptResult({ results: [], error: "Search failed", error_details: String(e.message).slice(0, 500) }); }
    return chatgptResult({ results: r.results.map((h) => ({ id: h.note.permalink, title: h.note.title || "Untitled", url: h.note.permalink })), total_count: r.results.length, query });
  }

  function fetchTool(args) {
    const id = str(args.id);
    const n = store.resolve(id);
    if (!n) return chatgptResult({ id, title: "Document Not Found", text: notFoundText(id, relatedFor(id, 1, 5)), url: id, metadata: { error: "Document not found" } });
    return chatgptResult({ id, title: n.title, text: n.raw, url: id, metadata: { format: "markdown" } });
  }

  // ---- build_context ----

  function entitySummary(n, withContent) {
    return { type: "entity", external_id: n.external_id, entity_id: n.entity_id, permalink: n.permalink, title: n.title, content: withContent ? trimBody(n) : null, file_path: n.file_path, created_at: iso(n.ctimeMs) };
  }
  function observationSummary(n, o) {
    return {
      type: "observation", observation_id: stableInt("obs:" + n.permalink + ":" + o.line), entity_id: n.entity_id,
      title: `${o.category}: ${o.content}`, file_path: n.file_path, permalink: observationPermalink(n, o),
      category: o.category, content: o.content, created_at: iso(n.ctimeMs),
    };
  }
  function relationSummary(e) {
    return {
      type: "relation", relation_id: stableInt("rel:" + e.from.permalink + ":" + e.type + ":" + e.target), entity_id: null,
      title: `${e.type}: ${e.to ? e.to.title : e.target}`, file_path: e.from.file_path, permalink: "",
      relation_type: e.type, from_entity: e.from.title, from_entity_id: e.from.entity_id, from_entity_external_id: e.from.external_id,
      to_entity: e.to ? e.to.title : null, to_name: e.target, to_entity_id: e.to ? e.to.entity_id : null,
      to_entity_external_id: e.to ? e.to.external_id : null, created_at: iso(e.from.mtimeMs),
    };
  }

  /** Notes a memory:// URL designates (exact note, `folder/*` pattern, or a folder). */
  function primariesFor(url) {
    let s = str(url).trim().replace(/^memory:\/\//i, "").replace(/^\/+|\/+$/g, "");
    if (!s) return [];
    const all = store.notes();
    const prefix = project + "/";
    const variants = (n) => { const p = n.permalink.toLowerCase(); return [p, p.startsWith(prefix) ? p.slice(prefix.length) : prefix + p, n.rel.toLowerCase().replace(/\.md$/, "")]; };
    if (s.includes("*")) {
      const re = globToRegExp(s.toLowerCase());
      return all.filter((n) => variants(n).some((v) => re.test(v)));
    }
    const exact = store.resolve(s);
    if (exact) return [exact];
    const low = s.toLowerCase();
    return all.filter((n) => variants(n).some((v) => v.startsWith(low + "/")));
  }

  function build_context(args) {
    const url = str(args.url != null ? args.url : args.uri != null ? args.uri : args.memory_url);
    if (!url.trim()) throw new ToolError("url is required");
    const depth = int(args.depth, 1, { min: 0, max: 10, name: "depth" }); // 0 = the note(s) alone, no related items
    const page = int(args.page, 1, { min: 1, name: "page" });
    const pageSize = int(args.page_size, 10, { min: 1, max: 50, name: "page_size" });
    const maxRelated = int(args.max_related, 10, { min: 0, max: 100, name: "max_related" });
    const format = fmtOf(args.output_format, "json");
    const now = Date.now();
    const tf = args.timeframe == null || args.timeframe === "" ? "7d" : str(args.timeframe);
    let since = parseTimeframe(tf, now);
    if (since == null) since = now - 7 * 86400000;
    const g = store.graph();
    let primaries = primariesFor(url);
    primaries = primaries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || (a.permalink < b.permalink ? -1 : 1));
    const totalPrimaries = primaries.length;
    const pageItems = primaries.slice((page - 1) * pageSize, page * pageSize);
    const shownRels = new Set(pageItems.map((n) => n.rel));

    let totalRelations = 0, totalObservations = 0, relatedCount = 0;
    const results = pageItems.map((n) => {
      const related = [];
      const seenEntity = new Set([n.rel]);
      const seenRel = new Set();
      let frontier = [n];
      for (let hop = 1; hop <= depth && related.length < maxRelated; hop++) {
        const next = [];
        for (const cur of frontier) {
          const edges = (g.outgoing.get(cur.rel) || []).concat(g.incoming.get(cur.rel) || []);
          for (const e of edges) {
            if (related.length >= maxRelated) break;
            const rk = e.from.rel + "\u0000" + e.type + "\u0000" + e.target.toLowerCase();
            if (!seenRel.has(rk)) {
              seenRel.add(rk);
              related.push(relationSummary(e));
              totalRelations++;
            }
            const other = e.from === cur ? e.to : e.from;
            if (!other || seenEntity.has(other.rel) || shownRels.has(other.rel)) continue;
            seenEntity.add(other.rel);
            if (other.mtimeMs < since) continue;
            if (related.length >= maxRelated) break;
            related.push(entitySummary(other, false));
            next.push(other);
          }
        }
        frontier = next;
      }
      relatedCount += related.length;
      const observations = n.observations.map((o) => observationSummary(n, o));
      totalObservations += observations.length;
      return { primary_result: entitySummary(n, true), observations, related_results: related };
    });
    const metadata = {
      uri: str(url).replace(/^memory:\/\//i, "").replace(/^\/+/, ""),
      types: null, depth, timeframe: iso(since), generated_at: iso(now),
      primary_count: results.length, related_count: relatedCount, total_results: results.length + relatedCount,
      total_relations: totalRelations, total_observations: totalObservations,
    };
    if (results.length === 1 && !url.includes("*")) metadata.uri = results[0].primary_result.permalink;
    const graph = { results, metadata, page, page_size: pageSize, has_more: page * pageSize < totalPrimaries };
    if (format === "json") return jsonResult(graph);
    return textResult(contextMarkdown(graph));
  }

  function contextMarkdown(graph) {
    if (!graph.results.length) return `No results found for '${graph.metadata.uri}' in project '${project}'.`;
    const blocks = graph.results.map((r) => {
      const p = r.primary_result;
      const lines = [`## ${p.title}`, `permalink: ${p.permalink}`];
      if (p.content) lines.push("", p.content);
      if (r.observations.length) { lines.push("", "### Observations"); for (const o of r.observations) lines.push(`- [${o.category}] ${o.content}`); }
      const rels = r.related_results.filter((x) => x.type === "relation");
      if (rels.length) { lines.push("", "### Relations"); for (const x of rels) lines.push(`- ${x.relation_type} [[${x.to_entity || x.to_name}]]`); }
      const ents = r.related_results.filter((x) => x.type !== "relation");
      if (ents.length) { lines.push("", "### Related"); for (const x of ents) lines.push(`- [[${x.title}]] (${x.permalink || ""})`); }
      return lines.join("\n");
    });
    const m = graph.metadata;
    const head = graph.results.length === 1 ? `# Context: ${graph.results[0].primary_result.title}` : `# Context: ${m.uri}`;
    return [head, "", blocks.join("\n\n---\n\n"), "", "---", `*${m.primary_count} primary, ${m.related_count} related | depth=${m.depth} | project: ${project}*`].join("\n");
  }

  // ---- recent_activity ----

  function recent_activity(args) {
    const page = int(args.page, 1, { min: 1, name: "page" });
    const pageSize = int(args.page_size, 10, { min: 1, max: 100, name: "page_size" });
    int(args.depth, 1, { min: 0, max: 10, name: "depth" });
    const format = fmtOf(args.output_format);
    const tf = args.timeframe == null || args.timeframe === "" ? "7d" : str(args.timeframe);
    const now = Date.now();
    let since = parseTimeframe(tf, now);
    if (since == null) throw new ToolError(`Invalid timeframe: '${tf}' (examples: 7d, 24h, "2 days ago", "last week", 2026-01-01)`);
    let types = Array.isArray(args.type) ? args.type : str(args.type).split(",");
    types = types.map((t) => str(t).trim().toLowerCase()).filter(Boolean);
    for (const t of types) if (!["entity", "observation", "relation"].includes(t)) throw new ToolError(`Invalid type: ${t}. Valid types are: entity, observation, relation`);
    const typeFilter = types.length > 0;
    if (!types.length) types = ["entity"];
    const notes = store.notes().filter((n) => n.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.permalink < b.permalink ? -1 : 1));
    const items = [];
    for (const n of notes) {
      if (types.includes("entity")) items.push({ kind: "entity", note: n });
      if (types.includes("observation")) for (const o of n.observations) items.push({ kind: "observation", note: n, observation: o });
      if (types.includes("relation")) for (const r of n.relations) items.push({ kind: "relation", note: n, relation: r });
    }
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    const hasMore = start + pageSize < items.length;
    if (format === "json") {
      return jsonResult(pageItems.map((it) => {
        const n = it.note;
        if (it.kind === "entity") return { type: "entity", title: n.title, permalink: n.permalink, file_path: n.file_path, created_at: iso(n.mtimeMs) };
        if (it.kind === "observation") return { type: "observation", title: `${it.observation.category}: ${it.observation.content}`, permalink: observationPermalink(n, it.observation), file_path: n.file_path, created_at: iso(n.mtimeMs), category: it.observation.category, content: it.observation.content };
        return { type: "relation", title: `${it.relation.type}: ${it.relation.target}`, permalink: "", file_path: n.file_path, created_at: iso(n.mtimeMs), relation_type: it.relation.type, from_entity: n.title, to_entity: it.relation.target };
      }));
    }
    const lines = [`## Recent Activity: ${project} (${tf})`];
    if (!pageItems.length) {
      if (page > 1) lines.push("", `Nothing on page ${page} for '${project}' within ${tf}.`, `Try page=${page - 1}, or page=1.`);
      else if (typeFilter && !types.includes("entity")) lines.push("", `No recent activity of that type in '${project}' within ${tf}.`, "Try another type, or omit `type` to see recent notes.");
      else lines.push("", `No recent activity in '${project}' within ${tf}.`, `Widen the window with recent_activity(project="${project}", timeframe="30d"), or look for a topic with search_notes(project="${project}", query="...").`);
      return textResult(lines.join("\n"));
    }
    const ents = pageItems.filter((i) => i.kind === "entity");
    const obs = pageItems.filter((i) => i.kind === "observation");
    const rels = pageItems.filter((i) => i.kind === "relation");
    if (ents.length) {
      lines.push("", `**📄 Recent Notes & Documents (${ents.length}):**`);
      for (const it of ents) { const d = dirOf(it.note.rel); lines.push(`  • ${it.note.title || "Untitled"}${d ? ` (${d})` : ""} [id: ${it.note.external_id}]`); }
    }
    if (obs.length) {
      lines.push("", `**🔍 Recent Observations (${obs.length}):**`);
      const byCat = new Map();
      for (const it of obs) { const c = it.observation.category; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(it); }
      for (const [c, list] of byCat) {
        lines.push(`  **${c}:** ${list.length} items`);
        for (const it of list.slice(0, 3)) { const t = it.observation.content; lines.push(`    - ${t.length > 80 ? t.slice(0, 80).replace(/\s+\S*$/, "") + "…" : t}`); }
      }
    }
    if (rels.length) {
      lines.push("", `**🔗 Recent Connections (${rels.length}):**`);
      for (const it of rels) lines.push(`  • [[${it.note.title}]] → ${it.relation.type} → [[${it.relation.target}]]`);
    }
    lines.push("", hasMore ? `**Activity Summary:** Showing ${pageItems.length} items (page ${page}). Use page=${page + 1} to see more.` : `**Activity Summary:** ${pageItems.length} items found.`);
    return textResult(lines.join("\n"));
  }

  // ---- list_directory ----

  function list_directory(args) {
    const rawDir = args.dir_name == null || args.dir_name === "" ? "/" : str(args.dir_name);
    const depth = int(args.depth, 1, { min: 1, max: 10, name: "depth" });
    const page = int(args.page, 1, { min: 1, name: "page" });
    const pageSize = int(args.page_size, 10, { min: 1, max: 200, name: "page_size" });
    const format = fmtOf(args.output_format);
    const glob = args.file_name_glob ? str(args.file_name_glob) : null;
    const sort = args.sort ? str(args.sort) : null;
    if (sort && !["title_asc", "title_desc", "updated_asc", "updated_desc"].includes(sort)) throw new ToolError(`Invalid sort '${sort}': use title_asc, title_desc, updated_asc or updated_desc`);
    const dir = rawDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (dir.split("/").includes("..")) return errorResult(`Directory '${rawDir}' is not allowed: paths must stay inside the project`);
    const base = dir ? dir + "/" : "";
    const dirs = new Map(), files = [];
    for (const n of store.notes()) {
      if (base && !n.rel.toLowerCase().startsWith(base.toLowerCase())) continue;
      const sub = n.rel.slice(base.length).split("/");
      for (let i = 1; i < sub.length && i <= depth; i++) {
        const p = base + sub.slice(0, i).join("/");
        const cur = dirs.get(p);
        if (!cur || n.mtimeMs > cur.mtimeMs) dirs.set(p, { name: sub[i - 1], path: p, mtimeMs: n.mtimeMs });
      }
      if (sub.length <= depth) files.push(n);
    }
    let fileNodes = files;
    if (glob) { const re = globToRegExp(glob, { slashStar: false }); fileNodes = fileNodes.filter((n) => re.test(path.posix.basename(n.rel))); }
    const byName = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);
    if (sort === "title_asc") fileNodes.sort((a, b) => byName(a.title, b.title) || byName(a.rel, b.rel));
    else if (sort === "title_desc") fileNodes.sort((a, b) => byName(b.title, a.title) || byName(a.rel, b.rel));
    else if (sort === "updated_asc") fileNodes.sort((a, b) => a.mtimeMs - b.mtimeMs || byName(a.rel, b.rel));
    else if (sort === "updated_desc") fileNodes.sort((a, b) => b.mtimeMs - a.mtimeMs || byName(a.rel, b.rel));
    else fileNodes.sort((a, b) => byName(a.rel, b.rel));
    const dirNodes = glob ? [] : [...dirs.values()].sort((a, b) => byName(a.path, b.path));
    const nodes = dirNodes.map((d) => ({ type: "directory", name: d.name, directory_path: "/" + d.path, path: d.path }))
      .concat(fileNodes.map((n) => ({ type: "file", name: path.posix.basename(n.rel), directory_path: "/" + n.rel, path: n.rel, title: n.title, permalink: n.permalink, updated_at: iso(n.mtimeMs), external_id: n.external_id })));
    const total = nodes.length;
    const start = (page - 1) * pageSize;
    const pageNodes = nodes.slice(start, start + pageSize);
    const hasMore = start + pageSize < total;
    const shownDir = rawDir;
    if (format === "json") return jsonResult({ dir_name: shownDir, depth, file_name_glob: glob, sort, page, page_size: pageSize, total, has_more: hasMore, nodes: pageNodes });
    if (!total) return textResult(`No files found in directory '${shownDir}'${glob ? ` matching '${glob}'` : ""}`);
    const out = [glob ? `Files in '${shownDir}' matching '${glob}' (depth ${depth}):` : `Contents of '${shownDir}' (depth ${depth}):`,
      `Page ${page} (page size ${pageSize}, ${total} total items)`, ""];
    const pd = pageNodes.filter((x) => x.type === "directory"), pf = pageNodes.filter((x) => x.type === "file");
    if (!pageNodes.length) out.push("No items on this page.");
    for (const d of pd) out.push(`📁 ${d.name.padEnd(30)} ${d.directory_path}`);
    if (pd.length && pf.length) out.push("");
    for (const f of pf) {
      let l = `📄 ${f.name.padEnd(30)} ${f.path}`;
      if (f.title && f.title !== f.name) l += ` | ${f.title}`;
      if (f.updated_at) l += ` | ${f.updated_at.slice(0, 10)}`;
      l += ` | id: ${f.external_id}`;
      out.push(l);
    }
    out.push("");
    const parts = [];
    if (pd.length) parts.push(`${pd.length} director${pd.length === 1 ? "y" : "ies"}`);
    if (pf.length) parts.push(`${pf.length} file${pf.length === 1 ? "" : "s"}`);
    out.push(parts.length ? `Total: ${pd.length + pf.length} items (${parts.join(", ")})` : "Total: 0 items");
    if (!pageNodes.length) out.push(`Page ${page} is past the end: the last page is ${Math.ceil(total / pageSize)}.`);
    if (hasMore) {
      const a = [`dir_name='${shownDir}'`, `depth=${depth}`, `page=${page + 1}`, `page_size=${pageSize}`];
      if (glob) a.push(`file_name_glob='${glob}'`);
      if (sort) a.push(`sort='${sort}'`);
      out.push("", `More entries on the next page: list_directory(${a.join(", ")})`);
    }
    return textResult(out.join("\n"));
  }

  // ---- projects / workspaces / diagnostics ----

  function list_memory_projects(args) {
    if (fmtOf(args.output_format) === "json") {
      return jsonResult({ projects: [{ name: project, path: store.root, is_default: true, external_id: projectId, source: "local" }], default_project: project });
    }
    return textResult(`Available projects:\n- ${project} (local) [${projectId}]\n\nThis memglow memory server serves this single project; the \`project\` argument of every tool can be omitted.`);
  }

  function list_workspaces(args) {
    if (fmtOf(args.output_format) === "json") return jsonResult({ workspaces: [{ name: "local", type: "local", projects: [project] }], current_workspace: "local" });
    return textResult(`Available workspaces:\n- local (this memglow memory server; project: ${project})`);
  }

  function basic_memory_diagnostics() {
    const s = store.stats();
    const lines = [
      "# memglow memory server — diagnostics", "",
      `- version: ${SERVER_VERSION} (phase A preview)`,
      `- mode: ${readOnly ? "read-only (phase A / shadow mode)" : "read-write"}`,
      `- project: ${project}`,
      `- root: ${store.root}`,
      `- notes indexed: ${s.notes}`,
      `- files skipped: ${s.skipped}`,
      `- index version: ${s.version}`,
      `- last scan: ${s.lastScanAt ? new Date(s.lastScanAt).toISOString() : "never"} (${s.lastScanMs.toFixed(1)} ms; index age ${s.lastScanAt ? ((Date.now() - s.lastScanAt) / 1000).toFixed(1) : "?"} s)`,
      `- first scan: ${s.firstScanMs} ms`,
      `- file watching: ${s.watching ? "on" : "off"}; rescan every ${s.pollMs} ms`,
      `- uptime: ${Math.round((Date.now() - startedAt) / 1000)} s`,
      `- runtime: Node.js ${process.version} on ${os.platform()} ${os.arch()}`,
      "- search: lexical (BM25-style, accent folding, EN+FR stop-words); vector / semantic / hybrid use the same engine",
    ];
    const col = store.collisions();
    if (col.length) {
      lines.push("", "## Permalink collisions (several files declare the same permalink; the first one wins)");
      for (const c of col.slice(0, 50)) lines.push(`- ${c.permalink}: ${c.files.join(", ")} → serves ${c.winner}`);
    }
    if (s.warnings.length) {
      lines.push("", "## Files skipped or partly read");
      for (const w of s.warnings.slice(0, 50)) lines.push(`- ${w.file}: ${w.message}`);
    }
    return textResult(lines.join("\n"));
  }

  const HANDLERS = new Map(Object.entries({
    search_notes, read_note, view_note, read_content, build_context, recent_activity, list_directory,
    list_memory_projects, list_workspaces, basic_memory_diagnostics, search, fetch: fetchTool,
  })); // a Map: "toString", "constructor", "__proto__"… are unknown tools, not Object.prototype members

  /** Runs a tool call: `call(name, args)` → MCP result (never throws). */
  function call(name, args) {
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (WRITE_TOOLS.has(name)) {
      if (readOnly) return errorResult(READ_ONLY_MESSAGE);
      return errorResult("memglow memory server: writes are not implemented yet (phase B)");
    }
    if (UNSUPPORTED_TOOLS.has(name)) return errorResult(`${name}: ${UNSUPPORTED_MESSAGE}`);
    const h = typeof name === "string" ? HANDLERS.get(name) : undefined;
    if (!h) return null;
    try { return h(a); }
    catch (e) {
      if (e instanceof ToolError) return errorResult(`Error calling tool '${name}': ${e.message}`);
      return errorResult(`Error calling tool '${name}': internal error (${e && e.message})`);
    }
  }

  return { call, tools: TOOLS, engine, warm: () => engine.warm() };
}

module.exports = { createTools, SERVER_VERSION, READ_ONLY_MESSAGE, UNSUPPORTED_MESSAGE, MAX_QUERY_CHARS, MAX_QUERY_TERMS };
