"use strict";
/**
 * memglow memory server — the write tools (phase B, stage 0.4.5.2): write_note, edit_note,
 * move_note, delete_note. Same arguments and the same answer layout as basic-memory's tools
 * (`# Created note` / `# Edited note (op)` blocks with `project:`, `file_path:`, `permalink:`,
 * `checksum:` lines; `true`/`false` for a single delete), so clients, hooks and the memglow proxy
 * keep working. The explanatory texts are memglow's own.
 *
 * Every handler returns a Promise of an MCP result; the work runs in the writer's single queue.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { splitFrontmatter, parseYaml } = require("../lib/store/frontmatter");
const { generatePermalink, sanitizeForFilename, sanitizeForDirectory } = require("../lib/store/permalink");
const E = require("../lib/store/note-edit");
const { WriteError } = require("./writer");

const EDIT_OPERATIONS = ["append", "prepend", "find_replace", "replace_section", "insert_before_section", "insert_after_section"];
const SECTION_OPS = new Set(["replace_section", "insert_before_section", "insert_after_section"]);
const RESERVED = new Set(["title", "type", "permalink"]);

function textResult(text) { return { content: [{ type: "text", text }], structuredContent: { result: text }, isError: false }; }
function jsonResult(obj) { return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: { result: obj }, isError: false }; }
function boolResult(b) { return { content: [{ type: "text", text: b ? "true" : "false" }], structuredContent: { result: b }, isError: false }; }

class ArgError extends Error {}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const firstDefined = (args, names) => { for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n]; return undefined; };
const fmtOf = (v) => (str(v).toLowerCase() === "json" ? "json" : "text");
const checksumOf = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Tags: a list, "a, b", or a JSON list in a string; "#" prefixes dropped. */
function parseTags(tags) {
  if (tags == null) return [];
  let list = tags;
  if (typeof tags === "string") {
    const t = tags.trim();
    if (t.startsWith("[") && t.endsWith("]")) { try { const j = JSON.parse(t); if (Array.isArray(j)) list = j; } catch { /* plain text */ } }
    if (typeof list === "string") list = t.split(",");
  }
  if (!Array.isArray(list)) list = [list];
  const out = [];
  for (const x of list.flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))) {
    const s = str(x).trim().replace(/^#+/, "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** metadata: an object, or a JSON object in a string. */
function coerceDict(v, name = "metadata") {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new ArgError(`${name} must be an object (or a JSON object string)`); }
  }
  if (typeof v !== "object" || Array.isArray(v)) throw new ArgError(`${name} must be an object`);
  return v;
}

/** Content may open with its own frontmatter (blank lines before the fence allowed). */
function contentFrontmatter(content) {
  const lead = /^(?:[ \t]*\r?\n)*/.exec(content)[0];
  const rest = content.slice(lead.length);
  if (!/^---[ \t]*\r?\n/.test(rest)) return null;
  const s = splitFrontmatter(rest.replace(/^﻿/, ""));
  if (s.block == null) return null;
  return { block: s.block.replace(/\r\n/g, "\n"), body: s.body };
}

function createWriteTools({ store, writer, project, overwriteDefault = false, kebabFilenames = false, updatePermalinksOnMove = false }) {
  const footer = `\n\n[Session: Using project '${project}']`;
  const pl = (rel) => `${project}/${generatePermalink(rel)}`;

  function semanticSummary(n, { unresolvedNote = false } = {}) {
    const out = [];
    if (n.observations.length) {
      const cats = new Map();
      for (const o of n.observations) cats.set(o.category, (cats.get(o.category) || 0) + 1);
      out.push("\n## Observations");
      for (const c of [...cats.keys()].sort()) out.push(`- ${c}: ${cats.get(c)}`);
    }
    if (n.relations.length) {
      const g = store.graph();
      const unresolved = n.relations.filter((r) => !g.resolveLink(r.target)).length;
      out.push("\n## Relations", `- Resolved: ${n.relations.length - unresolved}`);
      if (unresolved) {
        out.push(`- Unresolved: ${unresolved}`);
        if (unresolvedNote) out.push("\nNote: an unresolved relation points to a note that does not exist yet.", "It resolves by itself once a note with that title or permalink is written.");
      }
    }
    return out;
  }

  /**
   * The note an edit / move / delete acts on. An identifier that only matches by title or file
   * name and fits several notes is refused (a destructive operation never guesses).
   */
  function noteFor(identifier) {
    const r = store.resolveForWrite(identifier);
    if (r.ambiguous.length) {
      throw new ArgError(`'${identifier}' matches several notes (${r.ambiguous.slice(0, 5).map((n) => n.permalink).join(", ")}); use the permalink of the one you mean`);
    }
    return r.note;
  }

  /** A permalink not already declared by another file (basic-memory adds -1, -2… likewise). */
  function uniquePermalink(permalink, rel) {
    const g = store.graph();
    const taken = (p) => (g.byPermalink.get(p.toLowerCase()) || []).some((n) => n.rel !== rel && n.permalink.toLowerCase() === p.toLowerCase());
    if (!taken(permalink)) return permalink;
    for (let i = 1; i < 10000; i++) if (!taken(`${permalink}-${i}`)) return `${permalink}-${i}`;
    return permalink;
  }

  /** Runs one write in the queue, retrying when a file changed on disk under us. */
  async function queued(fn) {
    return writer.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch (e) {
          if (e instanceof WriteError && e.code === "CHANGED_ON_DISK" && attempt < 3) { store.scan(); continue; }
          writer.fail();
          throw e;
        }
      }
    });
  }

  /**
   * Creates a new note (shared by write_note and edit_note's append/prepend on a missing note).
   * Returns { kind: "created"|"exists"|"invalid-dir", ... }.
   */
  function planNew({ title, directory, content, noteType, metadata, tags }) {
    if (directory === "/") directory = "";
    try { writer.cleanRel(directory, { allowEmpty: true }); }
    catch { return { kind: "invalid-dir" }; }
    const dir = sanitizeForDirectory(directory);
    let stem = sanitizeForFilename(title);
    if (kebabFilenames) stem = generatePermalink(stem).replace(/\//g, "-");
    if (!stem) throw new ArgError(`title '${title}' gives an empty file name`);
    const rel = writer.canonicalRel(dir ? `${dir}/${stem}.md` : `${stem}.md`);

    const em = {};
    if (metadata) Object.assign(em, metadata);
    if (tags.length) em.tags = tags;
    let body = content;
    let type = noteType || "note";
    let declared = null;
    let merged = em;
    const cf = contentFrontmatter(content);
    if (cf) {
      let values;
      try { values = E.valuesForDump(cf.block); } catch (e) { throw new ArgError(e.message); }
      if (typeof values.type === "string" && values.type.trim()) type = values.type.trim();
      if (typeof values.permalink === "string" && values.permalink.trim()) declared = values.permalink.trim().replace(/^\/+|\/+$/g, "");
      merged = { ...values, ...em };
      body = cf.body.replace(/\r\n/g, "\n").trim();
    }
    for (const k of RESERVED) delete merged[k];
    return { kind: "plan", rel, title, type, declared, merged, body };
  }

  async function executePlan(plan, { overwrite }) {
    const t = await writer.target(plan.rel);
    if (t.stat) {
      if (!overwrite) return { action: "conflict", rel: t.rel, existing: store.resolve(t.rel) };
      // Replace: the body is new; the frontmatter keeps every key it had (bytes unchanged),
      // title/type and the given keys set, the permalink kept. The previous version is copied to
      // the trash first (an overwrite is the one write that can drop a whole body).
      const old = await writer.readText(t.abs);
      await writer.backupToTrash(t.abs, t.rel);
      const env = E.unwrap(old);
      const parts = E.splitNote(env.text);
      let text;
      const existing = store.resolve(t.rel);
      const permalink = existing ? existing.permalink : uniquePermalink(plan.declared || pl(t.rel), t.rel);
      if (parts.block == null) {
        text = E.buildNote({ title: plan.title, type: plan.type, permalink, ...plan.merged }, plan.body);
      } else {
        if (parseYaml(parts.block).error) throw new WriteError("the existing note's frontmatter cannot be read safely; fix it (or delete the note) before overwriting", "BAD_FRONTMATTER");
        const hasPermalink = E.segments(parts.block).segs.some((s) => s.key === "permalink");
        const block = E.setKeys(parts.block, { title: plan.title, type: plan.type, ...(hasPermalink ? {} : { permalink }), ...plan.merged });
        let head = E.replaceBlock(parts.head, parts.block, block);
        if (!head.endsWith("\n")) head += "\n";
        text = plan.body ? head + "\n" + plan.body : head;
      }
      text = E.rewrap(text, env);
      const st = await writer.writeAtomic(t.abs, text, t.stat);
      const n = store.noteWritten(t.rel, text, st);
      writer.wrote([t.rel]);
      return { action: "updated", rel: t.rel, text, note: n };
    }
    const permalink = uniquePermalink(plan.declared || pl(t.rel), t.rel);
    const text = E.buildNote({ title: plan.title, type: plan.type, permalink, ...plan.merged }, plan.body);
    let st;
    try { st = await writer.writeAtomic(t.abs, text, null); }
    catch (e) {
      if (e instanceof WriteError && e.code === "EXISTS") { if (!overwrite) return { action: "conflict", rel: t.rel, existing: null }; e.code = "CHANGED_ON_DISK"; }
      throw e;
    }
    const n = store.noteWritten(t.rel, text, st);
    writer.wrote([t.rel]);
    return { action: "created", rel: t.rel, text, note: n };
  }

  // ---- write_note ----

  function overwriteError(title, permalink) {
    return [
      "# Error: Note already exists", "",
      `A note titled **"${title}"** already exists (permalink: \`${permalink}\`), and write_note does not replace a note unless asked to.`, "",
      "What to do instead:",
      `- add to it: \`edit_note("${permalink}", operation="append", content="...")\` (or "prepend")`,
      `- rewrite one section: \`edit_note("${permalink}", operation="replace_section", section="...", content="...")\``,
      `- replace it entirely: \`write_note("${title}", ..., overwrite=True)\``,
      `- look at it first: \`read_note("${permalink}")\``, "",
      `Project: ${project}`,
    ].join("\n");
  }

  async function write_note(args) {
    const title = str(args.title);
    if (!title.trim()) throw new ArgError("title is required");
    const content = args.content;
    if (typeof content !== "string") throw new ArgError("content is required (a string)");
    const directory = firstDefined(args, ["directory", "folder", "dir", "path"]);
    if (directory === undefined) throw new ArgError("directory is required (\"\" or \"/\" for the root)");
    const format = fmtOf(args.output_format);
    const tags = parseTags(args.tags);
    const metadata = coerceDict(args.metadata);
    const overwrite = args.overwrite == null ? overwriteDefault : args.overwrite === true || args.overwrite === "true";
    const noteType = args.note_type == null || args.note_type === "" ? "note" : str(args.note_type);

    const plan = planNew({ title, directory: str(directory), content, noteType, metadata, tags });
    if (plan.kind === "invalid-dir") {
      if (format === "json") return jsonResult({ title, permalink: null, file_path: null, checksum: null, action: "created", error: "SECURITY_VALIDATION_ERROR" });
      return textResult(`# Error\n\nDirectory path '${directory}' is not allowed - paths must stay within project boundaries`);
    }
    const r = await queued(() => executePlan(plan, { overwrite }));
    if (r.action === "conflict") {
      const permalink = r.existing ? r.existing.permalink : (plan.declared || pl(r.rel));
      if (format === "json") return jsonResult({ title, permalink, file_path: null, checksum: null, action: "conflict", error: "NOTE_ALREADY_EXISTS" });
      return textResult(overwriteError(title, permalink));
    }
    const checksum = checksumOf(r.text);
    const action = r.action === "created" ? "Created" : "Updated";
    if (format === "json") return jsonResult({ title: r.note.title, permalink: r.note.permalink, file_path: r.rel, checksum, action: r.action });
    const lines = [`# ${action} note`, `project: ${project}`, `file_path: ${r.rel}`, `permalink: ${r.note.permalink}`, `checksum: ${checksum.slice(0, 8)}`];
    lines.push(...semanticSummary(r.note, { unresolvedNote: true }));
    if (tags.length) lines.push(`\n## Tags\n- ${tags.join(", ")}`);
    return textResult(lines.join("\n") + footer);
  }

  // ---- edit_note ----

  function editFailed(kind, { identifier, find_text, expected, actual, message, section }) {
    const id = identifier;
    switch (kind) {
      case "NOT_FOUND":
        return [
          "# Edit Failed - Note Not Found", "",
          `No note matches '${id}'. find_replace and the section operations need an existing note (append and prepend create it).`, "",
          "## What to try",
          `1. Find the exact identifier: \`search_notes("${id.split("/").pop()}")\`, then use its permalink.`,
          `2. Check it with \`read_note("${id}")\`.`,
          "3. To start a new note, use append/prepend here, or write_note.",
        ].join("\n");
      case "TEXT_NOT_FOUND":
        return [
          "# Edit Failed - Text Not Found", "",
          `'${find_text}' does not occur in the note '${id}' (the match is exact and case-sensitive).`, "",
          "## What to try",
          `1. Read the note first: \`read_note("${id}")\`.`,
          "2. Use a shorter or exact excerpt as find_text.",
          "3. Or use append / replace_section instead.",
        ].join("\n");
      case "WRONG_COUNT":
        return [
          "# Edit Failed - Wrong Replacement Count", "",
          `Expected ${expected} occurrences of '${find_text}' but found ${actual}.`, "",
          "## What to do",
          `- Set expected_replacements=${actual} to replace them all, or make find_text more specific.`,
          `- \`read_note("${id}")\` shows where it occurs.`,
        ].join("\n");
      case "SECTION_AMBIGUOUS":
        return ["# Edit Failed - Duplicate Section Headers", "", `The note '${id}' has several sections with this heading: ${message}`, "", "Use a more specific heading (with its # level), or find_replace."].join("\n");
      case "SECTION_NOT_FOUND":
        return ["# Edit Failed - Section Not Found", "", `${message} ('${id}').`, "", `Headings are matched exactly, with their level ("## Notes"); \`read_note("${id}")\` shows them. To add a new section, use append.`].join("\n");
      default:
        return ["# Edit Failed", "", `Error editing note '${id}': ${message}`, "", `\`read_note("${id}")\` shows the note as it is now.`].join("\n");
    }
  }

  async function edit_note(args) {
    const identifier = str(args.identifier);
    if (!identifier.trim()) throw new ArgError("identifier is required");
    const operation = str(args.operation);
    const content = firstDefined(args, ["content", "new_content", "replacement", "replace_with"]);
    if (typeof content !== "string") throw new ArgError("content is required (a string)");
    const section = firstDefined(args, ["section", "section_heading", "heading"]);
    const findText = firstDefined(args, ["find_text", "find", "old_text", "old_content", "search"]);
    let expected = args.expected_replacements == null || args.expected_replacements === "" ? 1 : Number(args.expected_replacements);
    if (!Number.isInteger(expected) || expected < 0) throw new ArgError(`expected_replacements must be a non-negative integer, got ${JSON.stringify(args.expected_replacements)}`);
    const replaceSubsections = args.replace_subsections == null ? true : !(args.replace_subsections === false || args.replace_subsections === "false");
    const metadata = coerceDict(args.metadata);
    const format = fmtOf(args.output_format);
    if (!EDIT_OPERATIONS.includes(operation)) throw new ArgError(`Invalid operation '${operation}'. Must be one of: ${EDIT_OPERATIONS.join(", ")}`);
    if (operation === "find_replace" && !findText) throw new ArgError("find_text parameter is required for find_replace operation");
    if (SECTION_OPS.has(operation) && !section) throw new ArgError("section parameter is required for section-based operations");
    if (metadata) {
      const nulls = Object.keys(metadata).filter((k) => metadata[k] === null).sort();
      if (nulls.length) throw new ArgError("metadata values cannot be null (key deletion is not supported): " + nulls.join(", "));
    }
    const md = {};
    if (metadata) for (const [k, v] of Object.entries(metadata)) if (!RESERVED.has(k)) md[k] = v;

    const failJson = (error) => jsonResult({ title: null, permalink: null, file_path: null, checksum: null, operation, fileCreated: false, error });

    const r = await queued(async () => {
      const n = noteFor(identifier);
      if (!n) {
        if (operation !== "append" && operation !== "prepend") return { kind: "not-found" };
        let id = identifier.trim();
        const isUrl = /^memory:\/\//i.test(id);
        id = id.replace(/^memory:\/\//i, "");
        if (isUrl && id.startsWith(project + "/")) id = id.slice(project.length + 1);
        const cut = id.lastIndexOf("/");
        const title = (cut >= 0 ? id.slice(cut + 1) : id).replace(/\.md$/i, "");
        const directory = cut >= 0 ? id.slice(0, cut) : "";
        const plan = planNew({ title, directory, content, noteType: "note", metadata: md, tags: [] });
        if (plan.kind === "invalid-dir") return { kind: "invalid-dir", title, directory };
        const res = await executePlan(plan, { overwrite: false });
        if (res.action === "conflict") return { kind: "error", code: "EXISTS", message: `a file already exists at '${res.rel}' but is not indexed as a note` };
        return { kind: "created", res };
      }
      const t = await writer.target(n.rel);
      if (!t.stat) return { kind: "not-found" };
      const before = await writer.readText(t.abs);
      let text;
      try {
        text = E.applyEdit(before, { operation, content, section, find_text: findText, expected_replacements: expected, replace_subsections: replaceSubsections });
        if (Object.keys(md).length) text = E.mergeFrontmatter(text, md, { title: n.title, type: n.type, permalink: n.permalink });
      } catch (e) {
        if (e instanceof E.EditError) return { kind: "edit-error", e, text: before };
        throw e;
      }
      let st = t.stat;
      if (text !== before) st = await writer.writeAtomic(t.abs, text, t.stat);
      const note = store.noteWritten(n.rel, text, st);
      if (text !== before) writer.wrote([n.rel]);
      return { kind: "edited", note, text, rel: n.rel };
    });

    if (r.kind === "not-found") {
      if (format === "json") return failJson("Entity not found: " + identifier);
      return textResult(editFailed("NOT_FOUND", { identifier }));
    }
    if (r.kind === "invalid-dir") {
      if (format === "json") return jsonResult({ title: r.title, permalink: null, file_path: null, checksum: null, operation, fileCreated: false, error: "SECURITY_VALIDATION_ERROR" });
      return textResult(`# Error\n\nDirectory path '${r.directory}' is not allowed - paths must stay within project boundaries`);
    }
    if (r.kind === "error") {
      if (format === "json") return failJson(r.message);
      return textResult(editFailed("OTHER", { identifier, message: r.message }));
    }
    if (r.kind === "edit-error") {
      const e = r.e;
      if (format === "json") return failJson(e.message);
      if (e.code === "WRONG_COUNT") {
        const m = /found (\d+)/.exec(e.message);
        return textResult(editFailed("WRONG_COUNT", { identifier, find_text: findText, expected, actual: m ? m[1] : "?" }));
      }
      if (e.code === "TEXT_NOT_FOUND") return textResult(editFailed("TEXT_NOT_FOUND", { identifier, find_text: findText }));
      return textResult(editFailed(e.code, { identifier, message: e.message, section }));
    }
    const lines = (n) => content.split("\n").length;
    if (r.kind === "created") {
      const { res } = r;
      const checksum = checksumOf(res.text);
      if (format === "json") return jsonResult({ title: res.note.title, permalink: res.note.permalink, file_path: res.rel, checksum, operation, fileCreated: true });
      const out = [`# Created note (${operation})`, `project: ${project}`, `file_path: ${res.rel}`, `permalink: ${res.note.permalink}`, `checksum: ${checksum.slice(0, 8)}`, "fileCreated: true", `operation: Created note with ${lines()} lines`];
      out.push(...semanticSummary(res.note));
      return textResult(out.join("\n") + footer);
    }
    const checksum = checksumOf(r.text);
    if (format === "json") return jsonResult({ title: r.note.title, permalink: r.note.permalink, file_path: r.rel, checksum, operation, fileCreated: false });
    const out = [`# Edited note (${operation})`, `project: ${project}`, `file_path: ${r.rel}`, `permalink: ${r.note.permalink}`, `checksum: ${checksum.slice(0, 8)}`];
    const what = {
      append: `operation: Added ${lines()} lines to end of note`,
      prepend: `operation: Added ${lines()} lines to beginning of note`,
      find_replace: "operation: Find and replace operation completed",
      replace_section: `operation: Replaced content under section '${section}'`,
      insert_before_section: `operation: Inserted content before section '${section}'`,
      insert_after_section: `operation: Inserted content after section '${section}'`,
    }[operation];
    out.push(what);
    out.push(...semanticSummary(r.note));
    return textResult(out.join("\n") + footer);
  }

  // ---- move_note ----

  /** A directory argument → its project-relative form (memory:// and the project prefix removed). */
  function dirArg(identifier) {
    let d = str(identifier).trim().replace(/^memory:\/\//i, "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (d.startsWith(project + "/")) d = d.slice(project.length + 1);
    return d;
  }

  async function move_note(args) {
    const identifier = str(args.identifier);
    if (!identifier.trim()) throw new ArgError("identifier is required");
    let destPath = str(firstDefined(args, ["destination_path", "destination", "to", "new_path"]) || "");
    const destFolder = firstDefined(args, ["destination_folder", "dest_folder", "to_folder"]);
    const isDir = args.is_directory === true || args.is_dir === true || args.is_directory === "true";
    const format = fmtOf(args.output_format);
    const fail = (error, text, extra = {}) => (format === "json" ? jsonResult({ moved: false, title: null, permalink: null, file_path: null, source: identifier, destination: destPath || destFolder || null, error, ...extra }) : textResult(text));
    if (destFolder && destPath) return fail("INVALID_PARAMETERS", "# Move Failed - Invalid Parameters\n\nGive destination_path or destination_folder, not both.");
    if (!destFolder && !destPath) return fail("MISSING_DESTINATION", "# Move Failed - Missing Destination\n\nGive destination_path (the new path, with its .md) or destination_folder (keeps the file name).");
    if (destFolder && isDir) return fail("INVALID_PARAMETERS", "# Move Failed - Invalid Parameters\n\ndestination_folder only applies to single notes; for a directory, give destination_path.");
    const securityText = (what) => `# Move Failed - Security Validation Error\n\nThe destination '${what}' is not allowed - paths must stay within project boundaries (relative paths, no "..", no hidden folders).`;

    if (isDir) {
      let src, dst;
      try { src = writer.cleanRel(dirArg(identifier)); dst = writer.canonicalRel(destPath); }
      catch { return fail("SECURITY_VALIDATION_ERROR", securityText(destPath)); }
      const r = await queued(async () => {
        const srcAbs = path.join(store.root, src), dstAbs = path.join(store.root, dst);
        const { existing, real } = await writer.checkAncestors(srcAbs);
        let st = null;
        try { st = existing === srcAbs ? fs.lstatSync(srcAbs) : null; } catch { st = null; }
        if (!st || !st.isDirectory() || !real) return { kind: "none" };
        if (dst === src || dst.startsWith(src + "/")) return { kind: "error", message: "the destination is the directory itself or inside it" };
        const moved = store.notes().filter((n) => n.rel.startsWith(src + "/")).map((n) => n.rel);
        try { await writer.moveNoClobber(srcAbs, dstAbs, { directory: true }); }
        catch (e) { if (e instanceof WriteError && e.code === "EXISTS") return { kind: "exists" }; throw e; }
        const newRels = moved.map((rel) => dst + rel.slice(src.length));
        for (const rel of moved) store.noteRemoved(rel);
        store.scan();
        if (updatePermalinksOnMove) for (const rel of newRels) await repermalink(rel);
        writer.wrote(moved.concat(newRels));
        return { kind: "moved", moved: newRels };
      });
      if (r.kind === "none") return fail("DIRECTORY_NOT_FOUND", `# Directory Move Failed - No Files Found\n\nNo directory '${identifier}' in this project.\nTotal files: 0.\n\n<!-- Project: ${project} -->`, { is_directory: true });
      if (r.kind === "exists") return fail("DESTINATION_EXISTS", `# Move Failed - Destination Already Exists\n\nSomething already exists at '${destPath}'; nothing was moved. Choose another destination, or move what is there first.`, { is_directory: true });
      if (r.kind === "error") return fail("INVALID_DESTINATION", `# Directory Move Failed\n\n${r.message}.`, { is_directory: true });
      if (format === "json") return jsonResult({ moved: true, is_directory: true, source: identifier, destination: destPath, total_files: r.moved.length, successful_moves: r.moved.length, failed_moves: 0, moved_files: r.moved });
      const out = ["# Directory Moved Successfully", "", `**Source:** \`${identifier}\``, `**Destination:** \`${destPath}\``, "", "## Summary", `- Total files: ${r.moved.length}`, `- Successfully moved: ${r.moved.length}`, "- Failed: 0"];
      if (r.moved.length) { out.push("", "## Moved Files"); for (const f of r.moved.slice(0, 10)) out.push(`- \`${f}\``); if (r.moved.length > 10) out.push(`- ... and ${r.moved.length - 10} more`); }
      out.push("", `<!-- Project: ${project} -->`);
      return textResult(out.join("\n"));
    }

    const r = await queued(async () => {
      const n = noteFor(identifier);
      if (!n) return { kind: "not-found" };
      let dest = destPath;
      if (destFolder != null) {
        const folder = str(destFolder).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        dest = folder ? `${folder}/${path.posix.basename(n.rel)}` : path.posix.basename(n.rel);
      }
      let rel;
      try { rel = writer.canonicalRel(dest); } catch { return { kind: "security", dest }; }
      if (rel === n.rel) return { kind: "same", n, dest };
      const ext = path.posix.extname(rel).slice(1), srcExt = path.posix.extname(n.rel).slice(1);
      if (!ext) return { kind: "no-ext", dest, srcExt };
      if (srcExt && ext.toLowerCase() !== srcExt.toLowerCase()) return { kind: "ext-mismatch", n, dest, ext, srcExt };
      const src = await writer.target(n.rel);
      if (!src.stat) return { kind: "not-found" };
      const dstAbs = path.join(store.root, rel);
      await writer.checkAncestors(dstAbs);
      try { await writer.moveNoClobber(src.isLink ? src.linkAbs : src.abs, dstAbs); }
      catch (e) { if (e instanceof WriteError && e.code === "EXISTS") return { kind: "exists", dest }; throw e; }
      store.noteRemoved(n.rel);
      let note;
      if (updatePermalinksOnMove) note = await repermalink(rel);
      if (!note) {
        const text = await writer.readText(dstAbs);
        note = store.noteWritten(rel, text, await fs.promises.stat(dstAbs));
      }
      writer.wrote([n.rel, rel]);
      return { kind: "moved", note, rel };
    });

    switch (r.kind) {
      case "not-found":
        return fail("NOTE_NOT_FOUND", ["# Move Failed - Note Not Found", "", `No note matches '${identifier}' (moves need an exact title, permalink or path).`, "", "## What to try", `- \`search_notes("${identifier.split("/").pop()}")\` to find its exact permalink.`, "- `list_directory(\"/\")` to browse the notes."].join("\n"));
      case "security": return fail("SECURITY_VALIDATION_ERROR", securityText(r.dest));
      case "same": return fail("DESTINATION_SAME_AS_SOURCE", `# Move Failed - Destination Same As Source\n\nThe note '${identifier}' is already at '${r.n.rel}'. Choose another destination to move or rename it.`);
      case "no-ext": return fail("FILE_EXTENSION_REQUIRED", `# Move Failed - File Extension Required\n\nThe destination '${r.dest}' needs a file extension, e.g. \`move_note("${identifier}", "${r.dest}.${r.srcExt || "md"}")\`.`);
      case "ext-mismatch": return fail("FILE_EXTENSION_MISMATCH", `# Move Failed - File Extension Mismatch\n\nThe destination ends in '.${r.ext}' but the note is a '.${r.srcExt}' file; keep '.${r.srcExt}'.`);
      case "exists": return fail("DESTINATION_EXISTS", `# Move Failed - Destination Already Exists\n\nA file already exists at '${r.dest}'; nothing was moved and nothing was overwritten. Choose another name, or look at it first with \`read_note("${r.dest}")\`.`);
      default: break;
    }
    if (format === "json") return jsonResult({ moved: true, title: r.note.title, permalink: r.note.permalink, file_path: r.rel, source: identifier, destination: destPath || r.rel });
    return textResult(["✅ Note moved successfully", "", `📁 **${identifier}** → **${r.rel}**`, `🔗 Permalink: ${r.note.permalink}`, "📊 Index updated", "", `<!-- Project: ${project} -->`].join("\n"));
  }

  /** --update-permalinks-on-move: the permalink follows the new path (rewritten in place). */
  async function repermalink(rel) {
    const t = await writer.target(rel);
    if (!t.stat) return null;
    const text = await writer.readText(t.abs);
    const want = uniquePermalink(pl(rel), rel);
    const env = E.unwrap(text);
    const parts = E.splitNote(env.text);
    if (parts.block == null || parseYaml(parts.block).error) return store.noteWritten(rel, text, t.stat);
    let block;
    // The move itself is done: a permalink that cannot be rewritten safely just stays as it was.
    try { block = E.setKeys(parts.block, { permalink: want }); } catch (e) { if (e instanceof E.EditError) return store.noteWritten(rel, text, t.stat); throw e; }
    const out = E.rewrap(E.replaceBlock(parts.head, parts.block, block) + parts.body, env);
    const st = out === text ? t.stat : await writer.writeAtomic(t.abs, out, t.stat);
    return store.noteWritten(rel, out, st);
  }

  // ---- delete_note ----

  async function delete_note(args) {
    const identifier = str(args.identifier);
    if (!identifier.trim()) throw new ArgError("identifier is required");
    const isDir = args.is_directory === true || args.is_dir === true || args.is_directory === "true";
    const format = fmtOf(args.output_format);
    if (isDir) {
      let dir;
      try { dir = writer.cleanRel(dirArg(identifier)); }
      catch {
        if (format === "json") return jsonResult({ deleted: false, is_directory: true, identifier, total_files: 0, successful_deletes: 0, failed_deletes: 0, error: "SECURITY_VALIDATION_ERROR" });
        return textResult(`# Directory Delete Failed\n\nThe directory '${identifier}' is not allowed - paths must stay within project boundaries.`);
      }
      const r = await queued(async () => {
        const list = store.notes().filter((n) => n.rel.startsWith(dir + "/"));
        if (!list.length) return { files: [], errors: [], trash: null };
        const trash = await writer.trashFolder();
        const files = [], errors = [];
        for (const n of list) {
          try {
            const t = await writer.target(n.rel);
            if (!t.stat) continue;
            await writer.toTrash(t.isLink ? t.linkAbs : t.abs, n.rel, trash);
            store.noteRemoved(n.rel);
            files.push(n.rel);
          } catch (e) { errors.push({ path: n.rel, error: e.message }); }
        }
        if (files.length) writer.wrote(files);
        return { files, errors, trash, total: list.length };
      });
      if (format === "json") {
        const o = { deleted: r.files.length > 0 && !r.errors.length, is_directory: true, identifier, total_files: r.total || 0, successful_deletes: r.files.length, failed_deletes: r.errors.length, deleted_files: r.files, errors: r.errors, trash: r.trash };
        if (!r.total) o.error = "Directory not found or empty: no files matched";
        return jsonResult(o);
      }
      if (!r.total) return textResult(`# Directory Delete Failed - No Files Found\n\nNo notes found in directory \`${identifier}\`.\nTotal files: 0.\n\n<!-- Project: ${project} -->`);
      const out = ["# Directory Deleted Successfully", "", `**Directory:** \`${identifier}\``, "", "## Summary", `- Total files: ${r.total}`, `- Successfully deleted: ${r.files.length}`, `- Failed: ${r.errors.length}`];
      if (r.files.length) { out.push("", "## Deleted Files"); for (const f of r.files.slice(0, 10)) out.push(`- \`${f}\``); if (r.files.length > 10) out.push(`- ... and ${r.files.length - 10} more`); }
      if (r.errors.length) { out.push("", "## Errors"); for (const e of r.errors.slice(0, 5)) out.push(`- \`${e.path}\`: ${e.error}`); }
      out.push("", `Moved to the trash folder \`${r.trash}/\` (not indexed; restore by moving the files back).`, "", `<!-- Project: ${project} -->`);
      return textResult(out.join("\n"));
    }
    const r = await queued(async () => {
      const n = noteFor(identifier);
      if (!n) return null;
      const t = await writer.target(n.rel);
      if (!t.stat) return null;
      const trash = await writer.trashFolder();
      const where = await writer.toTrash(t.isLink ? t.linkAbs : t.abs, n.rel, trash);
      store.noteRemoved(n.rel);
      writer.wrote([n.rel]);
      return { n, where };
    });
    if (!r) return format === "json" ? jsonResult({ deleted: false, title: null, permalink: null, file_path: null }) : boolResult(false);
    if (format === "json") return jsonResult({ deleted: true, title: r.n.title, permalink: r.n.permalink, file_path: r.n.rel, trash_path: r.where });
    return boolResult(true);
  }

  return { write_note, edit_note, move_note, delete_note };
}

module.exports = { createWriteTools, ArgError, parseTags, coerceDict, EDIT_OPERATIONS };
