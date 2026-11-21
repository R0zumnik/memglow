"use strict";
/**
 * memglow memory server — the `tools/list` contract. Tool names, argument names, types, defaults
 * and enums follow basic-memory's published tool contract so that existing clients, hooks and the
 * memglow MCP proxy keep working unchanged; every description here is memglow's own.
 */

const nullable = (type, description, extra = {}) => ({ anyOf: [{ type }, { type: "null" }], default: null, description, ...extra });
const strList = (description) => ({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], default: null, description });
// 0.6.4: the enum says it all ("text" readable / "json" structured) — no per-tool description.
const fmt = (def = "text", description) =>
  ({ type: "string", enum: def === "json" ? ["json", "text"] : ["text", "json"], default: def, ...(description ? { description } : {}) });

// Accepted for compatibility, ignored: the memglow memory server serves exactly one project.
const PROJECT = {
  project: nullable("string", "Ignored."),
  project_id: nullable("string", "Ignored."),
};
const WORKSPACE = { workspace: nullable("string", "Ignored.") };

const wrapSchema = (anyOf) => ({ type: "object", properties: { result: { anyOf } }, required: ["result"], "x-fastmcp-wrap-result": true });
const OUT_TEXT_OR_OBJECT = { type: "object", properties: { result: {} }, required: ["result"], "x-fastmcp-wrap-result": true };
const OUT_LIST = { type: "object", properties: { result: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["result"], "x-fastmcp-wrap-result": true };

const RO = (title) => ({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const RW = (title, destructive) => ({ readOnlyHint: false, destructiveHint: destructive, openWorldHint: false });

/**
 * 0.6.4 lean listing: an optional parameter is simply left out, never sent as null, so the
 * `anyOf: [X, {type: "null"}], default: null` wrapper only cost tokens at every session start.
 * It becomes plain X (one remaining member inlined); non-null defaults and enums are untouched.
 * The server itself still accepts an explicit null for any of them.
 */
function lean(prop) {
  if (!prop || !Array.isArray(prop.anyOf)) return prop;
  const rest = prop.anyOf.filter((m) => !(m && m.type === "null"));
  if (rest.length === prop.anyOf.length) return prop;
  const { anyOf, default: def, ...others } = prop;
  const out = rest.length === 1 ? { ...rest[0], ...others } : { anyOf: rest, ...others };
  if (def !== null && def !== undefined) out.default = def;
  return out;
}

function tool(name, title, description, properties, required, annotations, outputSchema = OUT_TEXT_OR_OBJECT) {
  const lp = {};
  for (const [k, v] of Object.entries(properties)) lp[k] = lean(v);
  properties = lp;
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
    "Delete a note (or, with is_directory=true, every note of a directory). Files move to the project .trash/<timestamp>/ (never indexed). Errors when the server is read-only.",
    {
      identifier: { type: "string", description: "Title, permalink or (is_directory) directory path." },
      is_directory: { type: "boolean", default: false, description: "Delete a directory." },
      ...PROJECT,
      output_format: fmt(),
    }, ["identifier"], RW("Delete Note", true),
    OUT_TEXT_OR_OBJECT),

  tool("read_content", "Read Content",
    "Read a file of the knowledge base exactly as stored (Markdown with its frontmatter, or another text file), by path, permalink or memory:// URL. Returns type, text, content type and encoding.",
    {
      path: { type: "string", description: "File path (folder/note.md), permalink (folder/note) or memory:// URL." },
      ...PROJECT,
    }, ["path"], RO("Read Content"), { type: "object", additionalProperties: true }),

  tool("build_context", "Build Context",
    "A note and what it links to, from a memory:// URL (folder/* for a pattern): observations, relations and related notes, `depth` hops, related notes limited to `timeframe`. JSON by default, output_format=\"text\" for compact Markdown.",
    {
      url: { type: "string", minLength: 1, maxLength: 2028, description: "memory:// URL or permalink (folder/* allowed)." },
      ...PROJECT,
      depth: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }], default: 1, description: "Link hops (1-3)." },
      timeframe: { anyOf: [{ type: "string" }, { type: "null" }], default: "7d", description: "Window for related notes: 7d, 24h, 2 weeks, yesterday, 2026-01-01…" },
      page: { type: "integer", default: 1, description: "Page (from 1)." },
      page_size: { type: "integer", default: 10, description: "Per page (max 50)." },
      max_related: { type: "integer", default: 10, description: "Max related items (100)." },
      output_format: fmt("json"),
    }, ["url"], RO("Build Context")),

  tool("recent_activity", "Recent Activity",
    "Notes updated within `timeframe`, newest first (or their observations / relations, via `type`). Paginated.",
    {
      type: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], default: "", description: "entity (default), observation, relation, or a list." },
      depth: { type: "integer", default: 1, description: "Ignored." },
      timeframe: { type: "string", default: "7d", description: "7d, 24h, \"last week\", yesterday, 2026-01-01…" },
      page: { type: "integer", default: 1, description: "Page (from 1)." },
      page_size: { type: "integer", default: 10, description: "Per page (max 100)." },
      ...PROJECT,
      output_format: fmt("text"),
    }, null, RO("Recent Activity"),
    wrapSchema([{ type: "string" }, { type: "array", items: { type: "object", additionalProperties: true } }])),

  tool("search_notes", "Search Notes",
    "Search the notes. Accents folded, the title counts most; \"phrases\", AND, OR, NOT / -word, prefix* and tag:name work. search_type: text (default), title, permalink (exact, prefix or * pattern); vector/semantic/hybrid use the lexical engine unless an optional embeddings provider is configured (README \"Semantic search\"). Filters: note_types, entity_types, categories, tags, status, metadata_filters, after_date. Paginated.",
    {
      query: nullable("string", "Search text; optional with filters."),
      ...PROJECT,
      search_all_projects: { type: "boolean", default: false, description: "Ignored." },
      page: { type: "integer", default: 1, description: "Page (from 1)." },
      page_size: { type: "integer", default: 10, description: "Results per page." },
      search_type: nullable("string", "text, title, permalink, vector, semantic or hybrid."),
      output_format: fmt("text"),
      note_types: strList("Frontmatter `type` in this list."),
      entity_types: strList("entity (default), observation, relation."),
      categories: strList("Observation categories (implies entity_types observation)."),
      after_date: nullable("string", "Updated since: 2d, \"1 week\", 2026-01-01…"),
      metadata_filters: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Frontmatter filters, e.g. {\"status\": \"active\"}; values may be lists (any of) or {\"$in\"|\"$gt\"|\"$gte\"|\"$lt\"|\"$lte\"|\"$contains\": …}." },
      tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }], default: null, description: "Notes carrying all these tags (list or \"a,b\")." },
      status: nullable("string", "Frontmatter `status`."),
      min_similarity: nullable("number", "Ignored."),
    }, null, RO("Search Notes")),

  tool("read_note", "Read Note",
    "Read one note in full, as stored, by permalink, memory:// URL, title, file name or path. No exact match: lists the closest notes. output_format=\"json\" gives title, permalink, file_path, content, frontmatter.",
    {
      identifier: { type: "string", description: "Permalink, memory:// URL, title, file name or path." },
      ...PROJECT,
      page: { type: "integer", default: 1, description: "Suggestions page (no exact match)." },
      page_size: { type: "integer", default: 10, description: "Suggestions per page (no exact match)." },
      output_format: fmt("text"),
      include_frontmatter: { type: "boolean", default: false, description: "json: keep frontmatter in `content`." },
    }, ["identifier"], RO("Read Note")),

  tool("view_note", "View Note",
    "Read one note and ask the client to show it to the user as a Markdown document (artifact). Same lookup as read_note.",
    {
      identifier: { type: "string", description: "Permalink, memory:// URL, title, file name or path." },
      ...PROJECT,
    }, ["identifier"], RO("View Note"), wrapSchema([{ type: "string" }])),

  tool("write_note", "Write Note",
    "Create <directory>/<title>.md with frontmatter (title, type, permalink, metadata, tags). Content may hold observations (`- [category] text #tag`) and relations (`- relation_type [[Other Note]]`). Existing note: error unless overwrite=true (body replaced, other frontmatter and permalink kept). For small changes use edit_note.",
    {
      title: { type: "string", description: "Note title." },
      content: { type: "string", description: "Markdown body." },
      directory: { type: "string", description: "Folder under the root (\"/\" = root)." },
      ...{ project: PROJECT.project },
      ...WORKSPACE,
      project_id: PROJECT.project_id,
      tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "null" }], default: null, description: "Tags (a list or \"a,b\")." },
      note_type: { type: "string", default: "note", description: "Frontmatter `type`." },
      metadata: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Extra frontmatter fields." },
      overwrite: { anyOf: [{ type: "boolean" }, { type: "null" }], default: null, description: "Replace an existing note." },
      output_format: fmt(),
    }, ["title", "content", "directory"], { ...RW("Write Note", true), idempotentHint: false }),

  tool("list_directory", "List Directory",
    "List folders and notes under a directory (folders first), to `depth`, optionally filtered by a file-name glob and sorted.",
    {
      dir_name: { type: "string", default: "/", description: "Directory (\"/\" = root)." },
      depth: { type: "integer", default: 1, description: "Depth (1-10)." },
      file_name_glob: nullable("string", "File-name glob, e.g. *.md, *meeting*."),
      sort: { anyOf: [{ type: "string", enum: ["title_asc", "title_desc", "updated_asc", "updated_desc"] }, { type: "null" }], default: null, description: "File order (folders stay first)." },
      page: { type: "integer", default: 1, description: "Page (from 1)." },
      page_size: { type: "integer", default: 10, description: "Entries per page (max 200)." },
      output_format: fmt(),
      ...PROJECT,
    }, null, RO("List Directory")),

  tool("edit_note", "Edit Note",
    "Edit a note: append, prepend, find_replace (exactly expected_replacements, default 1), replace_section (by heading; replace_subsections=false keeps sub-headings), insert_before_section / insert_after_section. append/prepend create a missing note. metadata merges frontmatter keys; the rest of the file is kept byte for byte.",
    {
      identifier: { type: "string", description: "Title, permalink or memory:// URL." },
      operation: { type: "string", enum: ["append", "prepend", "find_replace", "replace_section", "insert_before_section", "insert_after_section"], description: "The edit to make." },
      content: { type: "string", description: "Text to add, or the replacement." },
      project: PROJECT.project,
      ...WORKSPACE,
      project_id: PROJECT.project_id,
      section: nullable("string", "Heading for section operations, e.g. \"## Notes\"."),
      find_text: nullable("string", "Text to find (find_replace)."),
      expected_replacements: nullable("integer", "Expected number of replacements (find_replace)."),
      replace_subsections: nullable("boolean", "replace_section: replace sub-headings too."),
      metadata: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }], default: null, description: "Frontmatter fields to merge." },
      output_format: fmt(),
    }, ["identifier", "operation", "content"], RW("Edit Note", true)),

  tool("move_note", "Move Note",
    "Move or rename a note (destination_path with .md, or destination_folder to keep the name), or a directory (is_directory=true). Never overwrites; the permalink is kept.",
    {
      identifier: { type: "string", description: "Title, permalink, memory:// URL or directory path." },
      destination_path: { type: "string", default: "", description: "New path relative to the project root." },
      destination_folder: nullable("string", "Target folder (keeps the file name)."),
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

  tool("memory_core", "Memory Core",
    "Per-project core loading, once at session start: a compact global index plus the project hub(s) matching `cwd` / `project` in full (config coreMap, then project_paths:/repo: frontmatter, then name match; none: the 3 most-read hubs).",
    {
      cwd: { type: "string", default: "", description: "Absolute working folder." },
      project: strList("Repo name / git remote hint(s)."),
      budget_tokens: { type: "integer", default: 1500, minimum: 100, maximum: 20000, description: "Token budget (bytes/4); cuts whole lines." },
      output_format: fmt(),
    }, null, RO("Memory Core")),

  tool("memory_index_level", "Memory Index Level",
    "Deterministic view of the memory index: level 0 = group titles with their hubs (compact), 1 = same as a `## group` + `- hub` block, 2 = the index as stored. `group` restricts to one group (by title).",
    {
      level: { type: "integer", default: 0, minimum: 0, maximum: 2, description: "0 = groups + hubs (compact), 1 = groups + hubs (block), 2 = the full index as stored." },
      group: nullable("string", "Restrict the answer to this one group (by title)."),
      output_format: fmt(),
    }, null, RO("Memory Index Level")),

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
