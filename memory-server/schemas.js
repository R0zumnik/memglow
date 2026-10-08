"use strict";
/**
 * memglow memory server — the `tools/list` contract. Tool names, argument names, types, defaults
 * and enums follow basic-memory's published tool contract so that existing clients, hooks and the
 * memglow MCP proxy keep working unchanged; every description here is memglow's own.
 */

const nullable = (type, description, extra = {}) => ({ anyOf: [{ type }, { type: "null" }], default: null, description, ...extra });
const strList = (description) => ({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], default: null, description });
const fmt = (def = "text", description = 'Response format: "text" (readable) or "json" (structured).') =>
  ({ type: "string", enum: def === "json" ? ["json", "text"] : ["text", "json"], default: def, description });

// Accepted for compatibility, ignored: the memglow memory server serves exactly one project.
const PROJECT = {
  project: nullable("string", "Project name. Accepted for compatibility and ignored: this server serves a single project."),
  project_id: nullable("string", "Project id. Accepted for compatibility and ignored."),
};
const WORKSPACE = { workspace: nullable("string", "Workspace. Accepted for compatibility and ignored.") };

const wrapSchema = (anyOf) => ({ type: "object", properties: { result: { anyOf } }, required: ["result"], "x-fastmcp-wrap-result": true });
const OUT_TEXT_OR_OBJECT = wrapSchema([{ type: "object", additionalProperties: true }, { type: "string" }]);
const OUT_LIST = { type: "object", properties: { result: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["result"], "x-fastmcp-wrap-result": true };

const RO = (title) => ({ title, readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const RW = (title, destructive) => ({ title, readOnlyHint: false, destructiveHint: destructive, openWorldHint: false });

function tool(name, title, description, properties, required, annotations, outputSchema = OUT_TEXT_OR_OBJECT) {
  const inputSchema = { type: "object", additionalProperties: false, properties };
  if (required && required.length) inputSchema.required = required;
  const t = { name, title, description, inputSchema, annotations };
  if (outputSchema) t.outputSchema = outputSchema;
  return t;
}

const TOOLS = [
  tool("basic_memory_diagnostics", "Memory Server Diagnostics",
    "Diagnostics of the memglow memory server: version, notes folder, number of notes indexed, index age, files skipped (with why), whether file watching is active. Read-only, never shows note contents or secrets.",
    {}, null, RO("Memory Server Diagnostics"), null),

  tool("delete_note", "Delete Note",
    "Delete a note by title, permalink or memory:// URL (or every note of a directory with is_directory=true). Nothing is destroyed: files move to the project's .trash/<timestamp>/ folder, which is never indexed. Answers true / false for one note. Write tools answer an error when the server runs read-only.",
    {
      identifier: { type: "string", description: "Title or permalink of the note to delete, or a directory path when is_directory is true." },
      is_directory: { type: "boolean", default: false, description: "Delete a whole directory instead of one note." },
      ...PROJECT,
      output_format: fmt(),
    }, ["identifier"], RW("Delete Note", true),
    wrapSchema([{ type: "boolean" }, { type: "string" }, { type: "object", additionalProperties: true }])),

  tool("read_content", "Read Content",
    "Read a file of the knowledge base exactly as stored (Markdown with its frontmatter, or another text file), by path, permalink or memory:// URL. Returns type, text, content type and encoding.",
    {
      path: { type: "string", description: "File path (folder/note.md), permalink (folder/note) or memory:// URL." },
      ...PROJECT,
    }, ["path"], RO("Read Content"), { type: "object", additionalProperties: true }),

  tool("build_context", "Build Context",
    "Gather a note and what it is connected to, from a memory:// URL: the note itself (or every note matching a folder/* pattern), its observations, its relations and the related notes, following links up to `depth` hops. Related notes are limited to those updated within `timeframe` (e.g. 7d, 2 weeks, yesterday). JSON by default, or compact Markdown with output_format=\"text\".",
    {
      url: { type: "string", minLength: 1, maxLength: 2028, description: "memory:// URL or permalink, e.g. memory://folder/note or memory://folder/* ." },
      ...PROJECT,
      depth: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }], default: 1, description: "How many link hops to follow (1-3 is plenty)." },
      timeframe: { anyOf: [{ type: "string" }, { type: "null" }], default: "7d", description: "Only related notes updated within this window: 7d, 24h, 2 weeks, \"3 days ago\", yesterday, 2026-01-01…" },
      page: { type: "integer", default: 1, description: "Page of primary results (from 1)." },
      page_size: { type: "integer", default: 10, description: "Primary results per page (max 50)." },
      max_related: { type: "integer", default: 10, description: "Maximum related items in total (max 100)." },
      output_format: fmt("json", 'Response format: "json" (structured, default) or "text" (compact Markdown).'),
    }, ["url"], RO("Build Context")),

  tool("recent_activity", "Recent Activity",
    "What changed recently in the knowledge base: notes updated within `timeframe` (newest first), or their observations / relations with `type`. Paginated.",
    {
      type: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: "", description: "What to list: \"entity\" (notes, the default), \"observation\", \"relation\", or a list of them." },
      depth: { type: "integer", default: 1, description: "Accepted for compatibility (related items are not expanded here)." },
      timeframe: { type: "string", default: "7d", description: "Time window: 7d, 24h, \"2 days ago\", \"last week\", yesterday, 2026-01-01…" },
      page: { type: "integer", default: 1, description: "Page number (from 1)." },
      page_size: { type: "integer", default: 10, description: "Items per page (max 100)." },
      ...PROJECT,
      output_format: fmt("text", 'Response format: "text" (readable summary) or "json" (a flat list of items).'),
    }, null, RO("Recent Activity"),
    wrapSchema([{ type: "string" }, { type: "array", items: { type: "object", additionalProperties: true } }])),

  tool("search_notes", "Search Notes",
    "Search the knowledge base. Words are matched with accents folded and English/French stop-words ignored, the title counting most; \"quoted phrases\", AND, OR, NOT / -word, prefix* and tag:name are understood. search_type: text (default), title, permalink (exact, prefix, or a * pattern); vector/semantic/hybrid run the same lexical engine (no embeddings in this server). Filters: note_types, entity_types (entity, observation, relation), categories, tags, status, metadata_filters, after_date. Results are paginated and ordered by score, then permalink.",
    {
      query: nullable("string", "What to look for. Optional when filters are given."),
      ...PROJECT,
      search_all_projects: { type: "boolean", default: false, description: "Accepted for compatibility and ignored (single project)." },
      page: { type: "integer", default: 1, description: "Page number (from 1)." },
      page_size: { type: "integer", default: 10, description: "Results per page." },
      search_type: nullable("string", "text (default), title, permalink, or vector / semantic / hybrid (same lexical engine)."),
      output_format: fmt("text", 'Response format: "text" (readable result blocks) or "json" (structured).'),
      note_types: strList("Only notes whose frontmatter `type` is one of these, e.g. [\"note\", \"project\"]."),
      entity_types: strList("What to return: \"entity\" (notes, the default), \"observation\", \"relation\"."),
      categories: strList("Only observations of these categories (implies entity_types [\"observation\"] when that is not given)."),
      after_date: nullable("string", "Only notes updated since: 2d, \"1 week\", 2026-01-01…"),
      metadata_filters: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Frontmatter filters, e.g. {\"status\": \"active\"}; values may be lists (any of) or {\"$in\"|\"$gt\"|\"$gte\"|\"$lt\"|\"$lte\"|\"$contains\": …}." },
      tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }], default: null, description: "Only notes carrying all these frontmatter tags (a list, or \"a,b\")." },
      status: nullable("string", "Only notes whose frontmatter `status` is this."),
      min_similarity: nullable("number", "Accepted for compatibility and ignored (no vector search)."),
    }, null, RO("Search Notes")),

  tool("read_note", "Read Note",
    "Read one note in full, as stored (frontmatter included), by permalink, memory:// URL, title, file name or path. When nothing matches exactly, lists the closest notes instead. output_format=\"json\" gives title, permalink, file_path, content and frontmatter.",
    {
      identifier: { type: "string", description: "Permalink, memory:// URL, title, file name or path of the note." },
      ...PROJECT,
      page: { type: "integer", default: 1, description: "Page of suggestions when the identifier matches no note." },
      page_size: { type: "integer", default: 10, description: "Number of suggestions when the identifier matches no note." },
      output_format: fmt("text", 'Response format: "text" (the note as stored) or "json" (structured).'),
      include_frontmatter: { type: "boolean", default: false, description: "With output_format=\"json\": keep the frontmatter block in `content`." },
    }, ["identifier"], RO("Read Note")),

  tool("view_note", "View Note",
    "Read one note and ask the client to show it to the user as a Markdown document (artifact). Same lookup as read_note.",
    {
      identifier: { type: "string", description: "Permalink, memory:// URL, title, file name or path of the note." },
      ...PROJECT,
    }, ["identifier"], RO("View Note"), wrapSchema([{ type: "string" }])),

  tool("write_note", "Write Note",
    "Create a Markdown note: file <directory>/<title>.md, frontmatter title / type (note_type) / permalink, then the metadata keys and tags. The content may hold observations (`- [category] text #tag`) and relations (`- relation_type [[Other Note]]`). An existing note is not replaced unless overwrite=true (then its body is replaced and its other frontmatter keys and permalink are kept). For incremental changes use edit_note.",
    {
      title: { type: "string", description: "Note title." },
      content: { type: "string", description: "Markdown body (observations and relations allowed)." },
      directory: { type: "string", description: "Folder, relative to the project root (\"\" or \"/\" for the root)." },
      ...{ project: PROJECT.project },
      ...WORKSPACE,
      project_id: PROJECT.project_id,
      tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }], default: null, description: "Tags (a list or \"a,b\")." },
      note_type: { type: "string", default: "note", description: "Frontmatter `type`." },
      metadata: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Extra frontmatter fields." },
      overwrite: { anyOf: [{ type: "boolean" }, { type: "null" }], default: null, description: "Replace an existing note with the same title." },
      output_format: fmt(),
    }, ["title", "content", "directory"], { ...RW("Write Note", true), idempotentHint: false }),

  tool("list_directory", "List Directory",
    "List folders and notes of the knowledge base under a directory, to a given depth, optionally filtered by a file-name glob and sorted. Folders first.",
    {
      dir_name: { type: "string", default: "/", description: "Directory to list (\"/\" = root), e.g. /memory/project." },
      depth: { type: "integer", default: 1, description: "How deep to go (1-10; 1 = direct children)." },
      file_name_glob: nullable("string", "Only files whose name matches, e.g. *.md, *meeting*, project_*."),
      sort: { anyOf: [{ type: "string", enum: ["title_asc", "title_desc", "updated_asc", "updated_desc"] }, { type: "null" }], default: null, description: "File order (folders stay first)." },
      page: { type: "integer", default: 1, description: "Page number (from 1)." },
      page_size: { type: "integer", default: 10, description: "Entries per page (max 200)." },
      output_format: fmt(),
      ...PROJECT,
    }, null, RO("List Directory")),

  tool("edit_note", "Edit Note",
    "Edit a note: append, prepend (after the frontmatter), find_replace (exactly expected_replacements occurrences, default 1), replace_section (by heading; replace_subsections=false keeps its sub-headings), insert_before_section / insert_after_section. append/prepend create the note when it does not exist. metadata merges frontmatter keys (title, type, permalink excepted) with any operation; the rest of the file is kept byte-for-byte.",
    {
      identifier: { type: "string", description: "Exact title, permalink or memory:// URL of the note." },
      operation: { type: "string", enum: ["append", "prepend", "find_replace", "replace_section", "insert_before_section", "insert_after_section"], description: "The edit to make." },
      content: { type: "string", description: "Text to add, or the replacement." },
      project: PROJECT.project,
      ...WORKSPACE,
      project_id: PROJECT.project_id,
      section: nullable("string", "Heading the section operations apply to, e.g. \"## Notes\"."),
      find_text: nullable("string", "Text to find (find_replace)."),
      expected_replacements: nullable("integer", "Expected number of replacements (find_replace)."),
      replace_subsections: nullable("boolean", "replace_section: include sub-headings in the replaced section."),
      metadata: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Frontmatter fields to merge." },
      output_format: fmt(),
    }, ["identifier", "operation", "content"], RW("Edit Note", true)),

  tool("move_note", "Move Note",
    "Move or rename a note (destination_path with its .md, or destination_folder to keep the file name), or a whole directory (is_directory=true). Never replaces an existing file; the note keeps its permalink.",
    {
      identifier: { type: "string", description: "Exact title, permalink or memory:// URL (or a directory path)." },
      destination_path: { type: "string", default: "", description: "New path relative to the project root." },
      destination_folder: nullable("string", "Move into this folder, keeping the file name."),
      is_directory: { type: "boolean", default: false, description: "Move a whole directory." },
      ...PROJECT,
      output_format: fmt(),
    }, ["identifier"], RW("Move Note", false)),

  tool("list_workspaces", "List Workspaces",
    "List workspaces. The memglow memory server has a single local workspace.",
    { output_format: fmt() }, null, RO("List Workspaces")),

  tool("list_memory_projects", "List Memory Projects",
    "List the projects this server serves (the memglow memory server serves exactly one).",
    { output_format: fmt() }, null, RO("List Memory Projects")),

  tool("create_memory_project", "Create Memory Project",
    "Not supported by the memglow memory server (single project).",
    {
      project_name: { type: "string", description: "Name of the new project." },
      project_path: { type: "string", description: "Folder of the new project." },
      set_default: { type: "boolean", default: false, description: "Make it the default project." },
      ...WORKSPACE,
      output_format: fmt(),
    }, ["project_name", "project_path"], RW("Create Memory Project", false)),

  tool("delete_project", "Delete Project",
    "Not supported by the memglow memory server (single project).",
    {
      project_name: { type: "string", description: "Name of the project." },
      delete_notes: { type: "boolean", default: false, description: "Also delete the files." },
      ...WORKSPACE,
    }, ["project_name"], RW("Delete Project", true), wrapSchema([{ type: "string" }])),

  tool("search", "Search Knowledge Base",
    "Search adapter in the shape ChatGPT-style clients expect: one text item holding JSON {results: [{id, title, url}], total_count, query}. Same engine as search_notes.",
    { query: { type: "string", description: "What to look for (same syntax as search_notes)." } }, ["query"], RO("Search Knowledge Base"),
    OUT_LIST),

  tool("fetch", "Fetch Document",
    "Fetch adapter in the shape ChatGPT-style clients expect: one text item holding JSON {id, title, text, url, metadata} for a note found by permalink, title or memory:// URL.",
    { id: { type: "string", description: "Permalink, title or memory:// URL of the note." } }, ["id"], RO("Fetch Document"),
    OUT_LIST),

  tool("schema_validate", "Validate Schema",
    "Not supported by the memglow memory server.",
    {
      note_type: nullable("string", "Note type to validate."),
      identifier: nullable("string", "One note to validate."),
      ...PROJECT,
      output_format: fmt(),
    }, null, RO("Validate Schema")),

  tool("schema_infer", "Infer Schema",
    "Not supported by the memglow memory server.",
    {
      note_type: { type: "string", description: "Note type to analyse." },
      threshold: { type: "number", default: 0.25, description: "Minimum field frequency (0-1)." },
      ...PROJECT,
      output_format: fmt(),
    }, ["note_type"], RO("Infer Schema")),

  tool("schema_diff", "Schema Diff",
    "Not supported by the memglow memory server.",
    {
      note_type: { type: "string", description: "Note type to check." },
      ...PROJECT,
      output_format: fmt(),
    }, ["note_type"], RO("Schema Diff")),
];

const WRITE_TOOLS = new Set(["write_note", "edit_note", "move_note", "delete_note"]);
const UNSUPPORTED_TOOLS = new Set(["schema_validate", "schema_infer", "schema_diff", "create_memory_project", "delete_project"]);

module.exports = { TOOLS, WRITE_TOOLS, UNSUPPORTED_TOOLS };
