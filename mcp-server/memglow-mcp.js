#!/usr/bin/env node
"use strict";
/**
 * memglow MCP server — read-only inspector of a memglow Markdown memory folder, over MCP stdio.
 *
 *   node mcp-server/memglow-mcp.js            same config as the viewer (lib/config.js:
 *                                              MEMORY_DIR / memglow.config.json)
 *   npx -y memglow-mcp                        once published (bin entry below)
 *
 * Starts on its own: no memglow viewer, no network, no notes folder even required (an absent or
 * empty folder is not an error — the tools just say so). Zero runtime dependencies: this is a
 * hand-written JSON-RPC 2.0 server on newline-delimited stdio, the same wire format watched (not
 * produced) by mcp-proxy/memglow-mcp-proxy.js — see that file for the relay side of this protocol.
 *
 * NEVER writes anything, ever: not the notes (read through lib/memory.js, which has no write
 * path), not the activity counters (lib/counters.js is only read here — `add()` is never called),
 * not memglow's data folder. If present, the counters give real 7-day read counts; without them,
 * the tools say so plainly instead of guessing.
 *
 * Four read-only tools, no write tool:
 *   memory_health   folder-wide overview: notes too large, costliest to read, never read, index size
 *   split_plan      a deterministic split suggestion for one note, or an honest "no split needed"
 *   related_notes   notes related to a note (links, sub-theme, co-usage) or to a free-text topic
 *   note_cost       token estimate, 7-day reads and status for one note
 * No tool ever returns a full note body: only ids, titles, token estimates, frontmatter
 * descriptions and section headings — and even those go through lib/memory.js's `maskSecrets`
 * before being sent anywhere.
 */
const path = require("path");
const fs = require("fs");
const { loadConfig, DEFAULT_THEMES } = require("../lib/config");
const { createMemory, maskSecrets } = require("../lib/memory");
const { createCounters } = require("../lib/counters");
const { estimateTokens, sectionsOf, packSections, dayOf, daysBefore, WINDOW_DAYS } = require("../lib/cost");
const { rankRelated } = require("../lib/related");

const SERVER_NAME = "memglow-mcp";
let SERVER_VERSION = "0.0.0";
try { SERVER_VERSION = require("../package.json").version; } catch { /* keep default */ }
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

// ---- configuration: never throws, never blocks startup ----

/**
 * Same config as the viewer (lib/config.js), but a malformed memglow.config.json or an
 * environment left over from the viewer (e.g. a too-short MEMGLOW_TOKEN, irrelevant here) must
 * never stop this server from starting: fall back to plain defaults instead.
 */
function safeConfig(env = process.env, cwd = process.cwd()) {
  try { return loadConfig(env, cwd); }
  catch (e) {
    process.stderr.write(`memglow-mcp: ${e.message} — starting with defaults\n`);
    return {
      memoryDir: path.resolve(cwd, env.MEMORY_DIR || "./memory"),
      dataDir: path.resolve(cwd, env.MEMGLOW_DATA_DIR || path.join(require("os").homedir(), ".memglow")),
      largeNoteTokens: 5000,
      splitChunkTokens: 2000,
      pollMs: 2000,
      indexNote: ["MEMORY", "index"],
      themes: DEFAULT_THEMES,
      themeByFolder: [],
      defaultTheme: null,
      subthemeLabels: {},
    };
  }
}

function createContext(env = process.env, cwd = process.cwd()) {
  const config = safeConfig(env, cwd);
  const memory = createMemory({ dir: config.memoryDir, config, pollMs: config.pollMs || 2000 });
  const counters = createCounters({ dir: config.dataDir });
  let haveCounters = false;
  try { haveCounters = !!(counters.file && fs.existsSync(counters.file)); } catch { haveCounters = false; }
  return { config, memory, counters, haveCounters };
}

// ---- small helpers shared by the tools ----

function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function clampInt(v, def, min, max) {
  const n = Number.isInteger(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}
function safeText(s) { return maskSecrets(String(s == null ? "" : s)); }
function emptyMemory(ctx) { return ctx.memory.costNotes().length === 0; }
function noNotesFound(ctx) {
  return {
    summary: `No notes found under ${ctx.config.memoryDir}.`,
    data: { available: false, notesFolder: ctx.config.memoryDir },
  };
}

/** A note id, a path, or a title-ish string → an existing note id, or null. */
function resolveNote(memory, raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id) return null;
  if (memory.has(id)) return id;
  const base = id.split(/[\\/]/).pop().replace(/\.md$/i, "").trim();
  if (!base) return null;
  for (const candidate of [base, base.replace(/_/g, "-"), base.replace(/_/g, "-").toLowerCase()]) {
    if (memory.has(candidate)) return candidate;
  }
  return null;
}

function toRelatedEntry(n, reasons) {
  return { id: n.id, label: n.label, tokens: n.tokens, description: safeText(n.description), reasons };
}

// ---- the four tools ----
// Each returns either { summary, data } (a successful, structured result) or { error } (reported
// to the caller as a normal MCP tool error, isError: true, never a protocol-level failure).

function toolMemoryHealth(ctx) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const { computeCost } = require("../lib/cost");
  const notes = ctx.memory.costNotes();
  const opts = { since: ctx.counters.since(), largeNoteTokens: ctx.config.largeNoteTokens, chunkTokens: ctx.config.splitChunkTokens };
  const cost = computeCost(ctx.counters.days(), notes, Date.now(), opts);

  const tooLarge = cost.tooLarge.map((n) => ({ id: n.id, label: n.label, tokens: n.tokens, folder: n.folder }));
  const mostExpensive7d = ctx.haveCounters && cost.read.days7 > 0
    ? cost.top.slice(0, 5).map((n) => ({ id: n.id, label: n.label, tokens: n.tokens, reads7: n.reads7, readTokens7: n.readTokens7 }))
    : null;
  const neverRead30d = ctx.haveCounters && cost.neverRead.available
    ? { since: cost.neverRead.since, total: cost.neverRead.total, notes: cost.neverRead.notes.slice(0, 10).map((n) => ({ id: n.id, label: n.label, tokens: n.tokens })) }
    : null;
  const index = cost.index ? { id: cost.index.id, label: cost.index.label, tokens: cost.index.tokens } : null;

  const data = {
    available: true,
    totals: cost.totals,
    index,
    largeNoteTokens: cost.largeNoteTokens,
    tooLarge,
    mostExpensive7d,
    neverRead30d,
    countersAvailable: ctx.haveCounters,
  };

  const lines = [`${cost.totals.notes} note(s), ≈${cost.totals.tokens} tokens total.`];
  if (index) lines.push(`Index "${index.label}": ≈${index.tokens} tokens.`);
  lines.push(tooLarge.length
    ? `${tooLarge.length} note(s) over ${cost.largeNoteTokens} tokens: ${tooLarge.slice(0, 5).map((n) => n.label).join(", ")}${tooLarge.length > 5 ? "…" : ""}.`
    : `No note is over the ${cost.largeNoteTokens}-token threshold.`);
  if (mostExpensive7d) lines.push(`Costliest to read over 7 days: ${mostExpensive7d.map((n) => `${n.label} (≈${n.readTokens7} tokens, ${n.reads7}×)`).join(", ")}.`);
  else lines.push(ctx.haveCounters ? "No reads recorded in the last 7 days." : "No activity counters yet (nothing read through the hooks or the MCP proxy): reading-cost figures are unavailable.");
  if (neverRead30d) lines.push(`${neverRead30d.total} note(s) never read in the last 30 days${neverRead30d.total > 10 ? " (top 10 shown)" : ""}.`);
  return { summary: lines.join(" "), data };
}

function buildCopyPrompt(rec, parts, chunk) {
  const list = parts.map((p) => `Part ${p.part} (≈${p.tokens} tokens): ${p.titles.length ? p.titles.join(", ") : "(untitled intro)"}`).join("\n");
  return [
    `Split the note "${rec.label}" (id: ${rec.id}) into ${parts.length} smaller notes of about ${chunk} tokens each, along its existing sections:`,
    list,
    `Keep each part's original heading and content, preserve its [[wikilinks]] and its frontmatter `
      + `(theme/subtheme), and link the parts to each other and back to "${rec.label}" if you keep it `
      + `as an index. Use your own memory/file tool to create and edit the notes — memglow never `
      + `modifies notes itself.`,
  ].join("\n");
}

function toolSplitPlan(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const id = resolveNote(ctx.memory, args.note);
  if (!id) return { error: `Note not found: ${JSON.stringify(args.note)}` };
  const rec = ctx.memory.note(id, { withBody: false });
  const large = ctx.config.largeNoteTokens;
  if (rec.tokens <= large) {
    return {
      summary: `"${rec.label}" is ≈${rec.tokens} tokens, under the ${large}-token threshold: no split needed.`,
      data: { id: rec.id, label: rec.label, tokens: rec.tokens, threshold: large, split: null },
    };
  }
  const body = ctx.memory.maskedBody(id); // already secret-masked
  if (body == null) {
    return {
      summary: `"${rec.label}" is ≈${rec.tokens} tokens (over ${large}) but its body could not be read to propose sections.`,
      data: { id: rec.id, label: rec.label, tokens: rec.tokens, threshold: large, split: null },
    };
  }
  const parts = packSections(sectionsOf(body), ctx.config.splitChunkTokens).map((p, i) => ({ part: i + 1, tokens: p.tokens, titles: p.titles.filter(Boolean) }));
  return {
    summary: `"${rec.label}" is ≈${rec.tokens} tokens (over ${large}): split into ${parts.length} part(s) of ≈${ctx.config.splitChunkTokens} tokens each.`,
    data: {
      id: rec.id, label: rec.label, tokens: rec.tokens, threshold: large, chunkTokens: ctx.config.splitChunkTokens,
      split: parts, copyPrompt: buildCopyPrompt(rec, parts, ctx.config.splitChunkTokens),
    },
  };
}

function toolRelatedNotes(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const limit = clampInt(args.limit, 10, 1, 50);
  const nodes = ctx.memory.graph().nodes; // { id, label, description, theme, subtheme, mtime, tokens }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (nonEmpty(args.note)) {
    const id = resolveNote(ctx.memory, args.note);
    if (!id) return { error: `Note not found: ${JSON.stringify(args.note)}` };
    const rec = ctx.memory.note(id, { withBody: false }); // gives outgoing/incoming links
    const related = rankRelated({
      id, theme: rec.theme, subtheme: rec.subtheme, outgoing: rec.outgoing, incoming: rec.incoming,
      nodes, days: ctx.haveCounters ? ctx.counters.days() : null, limit,
    }).map((r) => toRelatedEntry(byId.get(r.id), r.reasons));
    return {
      summary: `${related.length} note(s) related to "${rec.label}"${ctx.haveCounters ? "" : " (co-usage unavailable: no activity counters)"}.`,
      data: { id: rec.id, label: rec.label, related },
    };
  }

  const topic = String(args.topic).trim();
  const words = topic.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const n of nodes) {
    if (n.theme === "index") continue;
    const hay = [n.label, n.description, n.id, n.subtheme].filter(Boolean).join(" ").toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > 0) scored.push({ n, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.n.id < b.n.id ? -1 : 1));
  const related = scored.slice(0, limit).map(({ n }) => toRelatedEntry(n, ["topic match"]));
  return { summary: `${related.length} note(s) matching "${topic}".`, data: { topic, related } };
}

function toolNoteCost(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const id = resolveNote(ctx.memory, args.note);
  if (!id) return { error: `Note not found: ${JSON.stringify(args.note)}` };
  const rec = ctx.memory.note(id, { withBody: false });
  const large = ctx.config.largeNoteTokens;
  let reads7 = null;
  if (ctx.haveCounters) {
    const now = Date.now();
    const today = dayOf(now);
    const from7 = daysBefore(now, WINDOW_DAYS - 1);
    reads7 = 0;
    for (const [day, o] of Object.entries(ctx.counters.days())) {
      if (day < from7 || day > today || !o || !o.notes || !o.notes[id]) continue;
      reads7 += o.notes[id].read || 0;
    }
  }
  const status = rec.tokens > large ? "too_large" : "ok";
  const data = { id: rec.id, label: rec.label, tokens: rec.tokens, threshold: large, status, reads7 };
  const summary = `"${rec.label}": ≈${rec.tokens} tokens (threshold ${large}) — ${status === "too_large" ? "too large" : "ok"}.`
    + (reads7 == null ? " Reads over 7 days: unavailable (no activity counters)." : ` Reads over 7 days: ${reads7}.`);
  return { summary, data };
}

// ---- tool registry (name, LLM-facing description, strict input schema) ----

const TOOLS = [
  {
    name: "memory_health",
    description: "Overview of the memory folder's health: notes that are too large, the notes that cost the most tokens to read over the last 7 days and the notes never read in the last 30 days (both only when enough activity history exists), and the size of the index note. Read-only, takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "split_plan",
    description: "Propose how to split one note into smaller parts along its existing \"##\"-\"######\" sections, grouped to about the configured chunk size (same rule as memglow's Memory cost panel). Says honestly that no split is needed when the note is under the large-note threshold. Returns the plan and a ready-to-use English instruction for the assistant's OWN memory tool — memglow itself never edits notes.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", minLength: 1, maxLength: 200, description: "Note id (file name without .md) or title." } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "related_notes",
    description: "Find notes related to a given note — its outgoing and incoming [[wikilinks]], notes in the same sub-theme, and (when activity history is available) notes read on the same days — or to a free-text topic, matched against note titles, descriptions, ids and sub-themes. Returns ids, titles, token estimates and frontmatter descriptions only — never note bodies. Provide either \"note\" or \"topic\".",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", minLength: 1, maxLength: 200, description: "Note id or title to find related notes for." },
        topic: { type: "string", minLength: 1, maxLength: 200, description: "Free-text topic to search for, used instead of \"note\" when no specific note id is known." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of related notes to return (default 10)." },
      },
      additionalProperties: false,
      anyOf: [{ required: ["note"] }, { required: ["topic"] }],
    },
  },
  {
    name: "note_cost",
    description: "Estimated token size of one note (≈ bytes / 4), the large-note threshold and whether the note is over it, and how many times it was read over the last 7 days when activity history is available.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", minLength: 1, maxLength: 200, description: "Note id (file name without .md) or title." } },
      required: ["note"],
      additionalProperties: false,
    },
  },
];

const HANDLERS = { memory_health: toolMemoryHealth, split_plan: toolSplitPlan, related_notes: toolRelatedNotes, note_cost: toolNoteCost };

// ---- a tiny, hand-written JSON Schema validator (just what the schemas above need) ----

function validate(schema, value) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return "expected an object";
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in props)) return `unexpected property "${k}"`;
    }
    for (const req of schema.required || []) if (!(req in value)) return `missing required property "${req}"`;
    for (const [k, sub] of Object.entries(props)) {
      if (!(k in value) || value[k] === undefined) continue;
      const err = validate(sub, value[k]);
      if (err) return `property "${k}": ${err}`;
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return "expected a string";
    if (schema.minLength != null && value.length < schema.minLength) return `too short (min ${schema.minLength})`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `too long (max ${schema.maxLength})`;
    return null;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return "expected an integer";
    if (schema.minimum != null && value < schema.minimum) return `must be >= ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `must be <= ${schema.maximum}`;
    return null;
  }
  return null;
}

/** Checks the hand-rolled validator cannot express (the "note OR topic" rule of related_notes). */
function semanticCheck(name, args) {
  if (name === "related_notes" && !nonEmpty(args.note) && !nonEmpty(args.topic)) return 'either "note" or "topic" is required';
  return null;
}

function formatText(summary, data) {
  return `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

// ---- JSON-RPC 2.0 over newline-delimited stdio (hand-written, no SDK) ----

function createRpc(write) {
  const send = (obj) => write(JSON.stringify(obj) + "\n");
  const result = (id, res) => send({ jsonrpc: "2.0", id, result: res });
  const errorResult = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (id, message) => result(id, { content: [{ type: "text", text: message }], isError: true });

  function handleInitialize(id, params) {
    const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    const protocolVersion = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
    result(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Read-only inspector of a memglow Markdown memory folder: which notes are too large, how to split them, which notes are related, and their estimated reading cost. Never modifies notes.",
    });
  }

  function handleToolsCall(ctx, id, params) {
    if (!params || typeof params !== "object" || typeof params.name !== "string") return errorResult(id, -32602, "Invalid params: \"name\" is required");
    const name = params.name;
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return toolError(id, `Unknown tool: ${JSON.stringify(name)}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    const problem = validate(def.inputSchema, args) || semanticCheck(name, args);
    if (problem) return toolError(id, `Invalid arguments for ${name}: ${problem}`);
    let out;
    try { out = HANDLERS[name](ctx, args); }
    catch (e) { return toolError(id, `${name} failed: ${e.message}`); }
    if (out && out.error) return toolError(id, out.error);
    return result(id, { content: [{ type: "text", text: formatText(out.summary, out.data) }], isError: false });
  }

  return function handleMessage(ctx, msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const { id, method, params } = msg;
    if (typeof method !== "string") return; // not a request/notification we understand: ignore
    if (id === undefined) return; // notification (e.g. notifications/initialized, notifications/cancelled): no response, ever
    try {
      if (method === "initialize") return handleInitialize(id, params);
      if (method === "ping") return result(id, {});
      if (method === "tools/list") return result(id, { tools: TOOLS });
      if (method === "tools/call") return handleToolsCall(ctx, id, params);
      return errorResult(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      return errorResult(id, -32603, `Internal error: ${e.message}`);
    }
  };
}

// ---- stdio transport: newline-delimited JSON, same shape as mcp-proxy's lineTap ----

function main(env = process.env, cwd = process.cwd()) {
  const ctx = createContext(env, cwd);
  const handleMessage = createRpc((s) => process.stdout.write(s));
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // not JSON: ignore, keep reading
      if (Array.isArray(msg)) msg.forEach((m) => handleMessage(ctx, m));
      else handleMessage(ctx, msg);
    }
    if (buf.length > 10 * 1024 * 1024) buf = ""; // pathological line: stop buffering it
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

if (require.main === module) main();

module.exports = { main, createContext, createRpc, validate, semanticCheck, TOOLS, HANDLERS, resolveNote };
