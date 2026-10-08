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
 * Seven read-only tools, no write tool:
 *   memory_health   folder-wide overview: notes too large, costliest to read, never read, index size,
 *                   hub-and-spoke drift (lib/hub-spoke.js: redundant index lines, sibling-listing
 *                   lines, missing uplinks/hub lines — counts only, never a note's text)
 *   split_plan      a deterministic split suggestion for one note, or an honest "no split needed"
 *   related_notes   notes related to a note (links, sub-theme, co-usage) or to a free-text topic
 *   note_cost       token estimate, 7-day reads and status for one note
 *   organisation_suggestions  notes of one subject scattered across sub-themes of a group
 *                   (lib/organise.js), with a ready-to-use regroup instruction
 *   archive_lookup  sections moved to the archive (lib/archive.js) whose topic matches a query,
 *                   from the archive summary note: references only, never the archived text
 *   index_trim_plan which index lines (lib/index-trim.js) could be shortened deterministically and
 *                   how many tokens that would save per session — the plan only, nothing written
 * No tool ever returns a full note body: only ids, titles, token estimates, frontmatter
 * descriptions and section headings — and even those go through lib/memory.js's `maskSecrets`
 * before being sent anywhere.
 */
const path = require("path");
const fs = require("fs");
const { loadConfig, DEFAULT_THEMES } = require("../lib/config");
const { createMemory, maskSecrets } = require("../lib/memory");
const { createCounters } = require("../lib/counters");
const memoryRules = require("../lib/memory-rules");
const { estimateTokens, sectionsOf, packSections, dayOf, daysBefore, WINDOW_DAYS } = require("../lib/cost");
const { rankRelated } = require("../lib/related");
const organise = require("../lib/organise");
const hubSpoke = require("../lib/hub-spoke");
const { readZones } = require("../lib/zones");
const { measureFiles, alwaysLoadedCost } = require("../lib/always-loaded");
const archive = require("../lib/archive");
const indexTrim = require("../lib/index-trim");

const SERVER_NAME = "memglow-mcp";
let SERVER_VERSION = "0.0.0";
try { SERVER_VERSION = require("../package.json").version; } catch { /* keep default */ }
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const RULES_PROMPT_NAME = "memory-hygiene";
const RULES_PROMPT_DESCRIPTION = "memglow's built-in memory-hygiene rules — same text added to this server's `initialize` instructions.";

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
      protectedThemes: null,
      alwaysLoaded: [],
      sessionsPerDay: 5,
      indexWarningTokens: 2000,
      indexTrimMaxChars: indexTrim.DEFAULT_MAX_CHARS,
      archive: archive.settings({}, env),
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

// ---- the tools ----
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

  // Always-loaded cost: index + configured instruction files (size only, never their content).
  const al = alwaysLoadedCost({
    index: cost.index ? notes.filter((n) => n.theme === "index").map((n) => ({ id: n.id, label: n.label, tokens: estimateTokens(n.bytes || 0) })) : [],
    files: measureFiles(ctx.config.alwaysLoaded || [], { cwd: ctx.config.cwd || process.cwd() }),
    days: ctx.haveCounters ? ctx.counters.days() : null, now: Date.now(),
    sessionsPerDay: ctx.config.sessionsPerDay || 5, indexWarningTokens: ctx.config.indexWarningTokens || 2000,
  });
  const alwaysLoaded = { perSession: al.perSession, sessionsPerDay: al.sessionsPerDay, sessionsSource: al.sessionsSource, perDay: al.perDay, files: al.files, tips: al.tips.map((t) => t.text) };

  // Hub-and-spoke structure (lib/hub-spoke.js): counts only, never a note's text — see
  // docs/hub-and-spoke.md and lib/memory-rules.js for the rule itself.
  let structure = null;
  if (ctx.memory.rawBody) {
    try {
      const idx = notes.find((n) => n.theme === "index");
      const r = hubSpoke.detect({
        // Full raw text (frontmatter included): declaredHubOf() needs the `part_of`/`parent` key
        // and the header-line markers, both checked before any structural guess (lib/hub-spoke.js).
        notes: notes.map((n) => { let text = ""; try { text = fs.readFileSync(path.join(ctx.config.memoryDir, n.rel), "utf8"); } catch { /* unreadable: no markers, no links */ } return { id: n.id, label: n.label, text, folder: n.folder || "" }; }),
        indexId: idx ? idx.id : null,
      });
      structure = r.counts;
    } catch { structure = null; }
  }

  const data = {
    available: true,
    totals: cost.totals,
    index,
    alwaysLoaded,
    largeNoteTokens: cost.largeNoteTokens,
    tooLarge,
    mostExpensive7d,
    neverRead30d,
    countersAvailable: ctx.haveCounters,
    structure,
  };

  const lines = [`${cost.totals.notes} note(s), ≈${cost.totals.tokens} tokens total.`];
  if (index) lines.push(`Index "${index.label}": ≈${index.tokens} tokens.`);
  lines.push(tooLarge.length
    ? `${tooLarge.length} note(s) over ${cost.largeNoteTokens} tokens: ${tooLarge.slice(0, 5).map((n) => n.label).join(", ")}${tooLarge.length > 5 ? "…" : ""}.`
    : `No note is over the ${cost.largeNoteTokens}-token threshold.`);
  if (mostExpensive7d) lines.push(`Costliest to read over 7 days: ${mostExpensive7d.map((n) => `${n.label} (≈${n.readTokens7} tokens, ${n.reads7}×)`).join(", ")}.`);
  else lines.push(ctx.haveCounters ? "No reads recorded in the last 7 days." : "No activity counters yet (nothing read through the hooks or the MCP proxy): reading-cost figures are unavailable.");
  lines.push(`Loaded at every session: ≈${al.perSession} tokens × ${al.sessionsPerDay} sessions/day ≈ ${al.perDay} tokens/day.`);
  if (neverRead30d) lines.push(`${neverRead30d.total} note(s) never read in the last 30 days${neverRead30d.total > 10 ? " (top 10 shown)" : ""}.`);
  if (structure) {
    lines.push((structure.indexRedundant + structure.siblingLines + structure.missingUplinks + structure.missingHubLines) > 0
      ? `Hub and spoke: ${structure.hubs} hub(s), ${structure.indexRedundant} redundant index line(s), ${structure.siblingLines} sibling list(s) (${structure.pureSiblingLines} removable outright), ${structure.missingUplinks} missing uplink(s), ${structure.missingHubLines} missing hub line(s).`
      : `Hub and spoke: ${structure.hubs} hub(s), nothing to tidy.`);
  }
  return { summary: lines.join(" "), data };
}

function buildCopyPrompt(rec, parts, chunk) {
  const list = parts.map((p) => `Part ${p.part} (≈${p.tokens} tokens): ${p.titles.length ? p.titles.join(", ") : "(untitled intro)"}`).join("\n");
  return [
    `Split the note "${rec.label}" (id: ${rec.id}) into ${parts.length} smaller notes of about ${chunk} tokens each, along its existing sections:`,
    list,
    `Keep each part's original heading and content, preserve its [[wikilinks]] and its frontmatter (theme/subtheme).`,
    `Hub and spoke, to read as few tokens as possible: turn "${rec.label}" into a short summary that lists each `
      + `new note with one line saying what it holds. Each new note links back to that summary only — no list of `
      + `sibling notes; link another note only when the text really refers to it. Do not add the new notes to the `
      + `memory index: only the summary stays there.`,
    `Use your own memory/file tool to create and edit the notes — memglow never modifies notes itself.`,
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
  // `sections`: the same per-heading breakdown note_cost returns (lib/cost.js's sectionsOf),
  // before `split` packs CONSECUTIVE sections into ≈chunkTokens-sized parts. Both are built from
  // the same list, so their totals always agree (checked in test/mcp-server.test.js) — `split`
  // never drops or re-estimates a section, it only groups the numbers `sections` already has.
  const sections = sectionsOf(body);
  const parts = packSections(sections, ctx.config.splitChunkTokens).map((p, i) => ({ part: i + 1, tokens: p.tokens, titles: p.titles.filter(Boolean) }));
  return {
    summary: `"${rec.label}" is ≈${rec.tokens} tokens (over ${large}): split into ${parts.length} part(s) of ≈${ctx.config.splitChunkTokens} tokens each.`,
    data: {
      id: rec.id, label: rec.label, tokens: rec.tokens, threshold: large, chunkTokens: ctx.config.splitChunkTokens,
      sections, split: parts, copyPrompt: buildCopyPrompt(rec, parts, ctx.config.splitChunkTokens),
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
  // Section-level breakdown (lib/cost.js's sectionsOf, same cut as the Memory cost panel's split
  // preview and split_plan's `sections`), for ANY note, not just an over-threshold one: where the
  // tokens of THIS note concentrate. `bodyTokens` is defined as the sum of `sections`' own
  // tokens — by construction, not a second, independently-rounded estimate — so it always equals
  // that sum exactly (checked in test/mcp-server.test.js); it is usually a few tokens below
  // `tokens` above, which also counts the frontmatter that `sections` (a BODY-only cut) excludes.
  // No body to read (missing/unreadable file) → no `sections` key at all, not an empty one.
  const body = ctx.memory.maskedBody(id);
  if (body != null) {
    data.sections = sectionsOf(body);
    data.bodyTokens = data.sections.reduce((s, x) => s + x.tokens, 0);
  }
  const summary = `"${rec.label}": ≈${rec.tokens} tokens (threshold ${large}) — ${status === "too_large" ? "too large" : "ok"}.`
    + (reads7 == null ? " Reads over 7 days: unavailable (no activity counters)." : ` Reads over 7 days: ${reads7}.`)
    + (data.sections ? ` ${data.sections.length} section(s), ≈${data.bodyTokens} tokens of body.` : "");
  return { summary, data };
}

function toolOrganisation(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const g = ctx.memory.graph();
  const themes = ctx.config.themes || [];
  const zones = readZones(ctx.config.dataDir, ctx.config);
  const themeName = (id) => { const t = themes.find((x) => x.id === id); return zones.labels[id] || (t ? t.label : id); };
  const labels = ctx.config.subthemeLabels || {};
  const subthemeName = (x) => (typeof labels[x] === "string" ? String(labels[x]).slice(0, 40) : x);
  const max = clampInt(args.limit, organise.MAX_SUGGESTIONS, 1, organise.MAX_SUGGESTIONS);
  const protectedNames = zones.protected.map(themeName);
  const list = organise.suggest({ notes: g.nodes, links: g.links, themeName, subthemeName, max }).map((x) => ({
    id: x.id, kind: x.kind, message: x.message, theme: x.theme, topic: x.topic, target: x.target, subthemes: x.subthemes,
    notes: x.notes, move: x.move, score: x.score, reasons: x.reasons,
    copyPrompt: organise.regroupPrompt(x, { themeName, subthemeName, protectedNames }),
  }));
  return {
    summary: list.length
      ? `${list.length} organisation suggestion(s): ${list.map((x) => x.message).join(" ")}`
      : "No scattered notes found: every subject sits in one sub-theme of its group.",
    data: { protectedGroups: protectedNames, suggestions: list },
  };
}

/** The archive summary note (lib/archive.js), parsed: null when there is none made by memglow. */
function readArchiveSummary(ctx) {
  const st = ctx.config.archive || archive.settings({});
  const rel = ctx.memory.fileOf(st.summaryNote);
  if (!rel) return { id: st.summaryNote, entries: null };
  let text;
  try { text = fs.readFileSync(path.join(ctx.config.memoryDir, rel), "utf8"); } catch { return { id: st.summaryNote, entries: null }; }
  return { id: st.summaryNote, rel, entries: archive.parseSummary(text), tokens: estimateTokens(text) };
}

function toolArchiveLookup(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const limit = clampInt(args.limit, 10, 1, 50);
  const query = String(args.query).trim();
  const s = readArchiveSummary(ctx);
  if (!s.entries) {
    return {
      summary: `No archive summary yet ("${s.id}"): nothing has been archived by memglow, so everything is in the live memory.`,
      data: { available: false, summaryNote: s.id, query, matches: [] },
    };
  }
  const matches = archive.matchEntries(s.entries, query, limit).map((e) => ({
    section: safeText(e.title), from: e.from, archiveNote: e.archive, link: `[[${e.archive}${e.anchor ? "#" + e.anchor : ""}]]`, date: e.date, tokens: e.tokens,
  }));
  const summary = matches.length
    ? `${matches.length} archived section(s) match "${query}": ${matches.slice(0, 5).map((m) => `"${m.section}" (from ${m.from}, now in ${m.archiveNote}, ≈${m.tokens} tokens)`).join(", ")}. Read one with your memory tool only if the live memory had no answer.`
    : `No archived section matches "${query}" (${s.entries.length} archived section(s) listed in ${s.id}).`;
  return { summary, data: { available: true, summaryNote: s.id, summaryTokens: s.tokens, total: s.entries.length, query, matches } };
}

/** The notes an index_trim_plan call needs (lib/index-trim.js candidateTargets): never the whole
 * memory, and never a note already in the archive folder (memglow's own, never a trim target). */
function readIndexTrimNotes(ctx, indexText, indexRel) {
  const folder = (ctx.config.archive || archive.settings({})).folder;
  const notes = [];
  for (const id of indexTrim.candidateTargets(indexText)) {
    const rel = ctx.memory.fileOf(id);
    if (!rel || rel === indexRel || rel.startsWith(folder + "/")) continue;
    let text;
    try { text = fs.readFileSync(path.join(ctx.config.memoryDir, rel), "utf8"); } catch { continue; }
    notes.push({ id, rel, text });
  }
  return notes;
}

function toolIndexTrimPlan(ctx, args) {
  if (emptyMemory(ctx)) return noNotesFound(ctx);
  const notes = ctx.memory.costNotes();
  const idx = notes.find((n) => n.theme === "index");
  if (!idx) return { summary: "No index note found.", data: { available: false, lines: [], skipped: [] } };
  let indexText;
  try { indexText = fs.readFileSync(path.join(ctx.config.memoryDir, idx.rel), "utf8"); }
  catch { return { summary: `The index note "${idx.label}" could not be read.`, data: { available: false, lines: [], skipped: [] } }; }
  const maxChars = clampInt(args.maxChars, ctx.config.indexTrimMaxChars || indexTrim.DEFAULT_MAX_CHARS, 30, 1000);
  const plan = indexTrim.planIndexTrim({ indexText, notes: readIndexTrimNotes(ctx, indexText, idx.rel), maxChars });
  const lines = plan.lines.map((l) => ({ id: l.id, before: safeText(l.before), after: safeText(l.after), keptInNote: l.keptInNote, tokensSaved: l.tokensSaved }));
  const data = {
    available: true, index: { id: idx.id, label: idx.label }, maxChars,
    tokensBefore: plan.tokensBefore, tokensAfter: plan.tokensAfter, tokensSaved: plan.tokensBefore - plan.tokensAfter,
    movedDescriptions: plan.movedDescriptions.length, lines, skipped: plan.skipped,
  };
  const summary = lines.length
    ? `${lines.length} index line(s) could be shortened, ≈${data.tokensSaved} token(s) saved per session (loaded at every session)${plan.movedDescriptions.length ? `; ${plan.movedDescriptions.length} note(s) would also get a \`description:\` line` : ""}.`
    : `Nothing to trim right now: every index line is already ≤${maxChars} characters, or its dropped detail is not yet in the linked note.`;
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
    description: "Propose how to split one note into smaller parts along its existing \"##\"-\"######\" sections, grouped to about the configured chunk size (same rule as memglow's Memory cost panel). Returns both the raw per-section token breakdown (\"sections\") and the packed parts (\"split\") built from it, so the two always add up to the same total. Says honestly that no split is needed when the note is under the large-note threshold. Returns the plan and a ready-to-use English instruction for the assistant's OWN memory tool — memglow itself never edits notes.",
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
    description: "Estimated token size of one note (≈ bytes / 4), the large-note threshold and whether the note is over it, how many times it was read over the last 7 days when activity history is available, and a per-section token breakdown (\"sections\", same \"##\"-\"######\" cut as split_plan) when the note's body can be read.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", minLength: 1, maxLength: 200, description: "Note id (file name without .md) or title." } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "organisation_suggestions",
    description: "Find notes about one subject that are scattered across several sub-themes of the same big group (strongly tied by [[links]] and shared title/description words), or alone in their sub-theme, and suggest regrouping them under one sub-theme. Read-only: returns the suggestions, the reasons, and a ready-to-use English instruction for the assistant's OWN memory tool (change the subtheme key only, never across groups) — memglow itself never edits notes. Never returns note bodies.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: organise.MAX_SUGGESTIONS, description: "Maximum number of suggestions (default " + organise.MAX_SUGGESTIONS + ")." } },
      additionalProperties: false,
    },
  },
];

TOOLS.push({
  name: "archive_lookup",
  description: "Use ONLY when a search of the live memory found nothing useful. Looks up the archive summary (one line per section memglow moved out of the live memory because nobody had used it for months) and returns the archived sections whose topic or original note matches the query: section title, original note, archive note, a [[link]] to it, date and ≈tokens. Never returns the archived text: read the section with your own memory tool if it answers the question.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200, description: "What you were looking for (topic words, or a note name)." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of matches (default 10)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
});

TOOLS.push({
  name: "index_trim_plan",
  description: "Which lines of the memory index (loaded at every session) could be shortened deterministically — no AI, no rewriting — and how many tokens that would save per session. A line qualifies only when its dropped detail is already in the linked note's description or body, or can be moved there (a new `description:` line); everything else is listed in \"skipped\" with why. Read-only: returns the plan, writes nothing. The assistant's own \"Trim the index\" proposal (not available through this tool) is what actually applies it, after the usual diff and confirmation.",
  inputSchema: {
    type: "object",
    properties: { maxChars: { type: "integer", minimum: 30, maximum: 1000, description: "A hook longer than this many characters is a candidate (default the server's indexTrimMaxChars setting, usually 90)." } },
    additionalProperties: false,
  },
});

const HANDLERS = { memory_health: toolMemoryHealth, split_plan: toolSplitPlan, related_notes: toolRelatedNotes, note_cost: toolNoteCost, organisation_suggestions: toolOrganisation, archive_lookup: toolArchiveLookup, index_trim_plan: toolIndexTrimPlan };

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

  /** "" when memglow's built-in memory rules are off (MEMGLOW_RULES=0, or disabled in Settings). */
  function rulesTextFor(ctx) { try { return memoryRules.rulesTextFor(ctx.config, process.env); } catch { return ""; } }

  function handleInitialize(ctx, id, params) {
    const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    const protocolVersion = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
    const base = "Read-only inspector of a memglow Markdown memory folder: which notes are too large, how to split them, which notes are related, which notes are scattered across sub-themes, their estimated reading cost, and (archive_lookup) which archived sections match a topic when the live memory had no answer. Never modifies notes.";
    const rules = rulesTextFor(ctx);
    result(id, {
      protocolVersion,
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: rules ? `${base}\n\n--- ${memoryRules.HEADER} ---\n${rules}` : base,
    });
  }

  /** `prompts/list`: the `memory-hygiene` prompt, only while memglow's built-in rules are on. */
  function handlePromptsList(ctx, id) {
    const rules = rulesTextFor(ctx);
    result(id, { prompts: rules ? [{ name: RULES_PROMPT_NAME, description: RULES_PROMPT_DESCRIPTION, arguments: [] }] : [] });
  }

  /** `prompts/get`: same text as the `initialize` instructions, as a single user message. */
  function handlePromptsGet(ctx, id, params) {
    const name = params && typeof params.name === "string" ? params.name : "";
    const rules = rulesTextFor(ctx);
    if (name !== RULES_PROMPT_NAME || !rules) return errorResult(id, -32602, `Unknown prompt: ${JSON.stringify(name)}`);
    result(id, { description: RULES_PROMPT_DESCRIPTION, messages: [{ role: "user", content: { type: "text", text: rules } }] });
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
      if (method === "initialize") return handleInitialize(ctx, id, params);
      if (method === "ping") return result(id, {});
      if (method === "tools/list") return result(id, { tools: TOOLS });
      if (method === "tools/call") return handleToolsCall(ctx, id, params);
      if (method === "prompts/list") return handlePromptsList(ctx, id);
      if (method === "prompts/get") return handlePromptsGet(ctx, id, params);
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

module.exports = { main, createContext, createRpc, validate, semanticCheck, TOOLS, HANDLERS, resolveNote, RULES_PROMPT_NAME };
