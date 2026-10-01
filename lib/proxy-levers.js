"use strict";
/**
 * MCP proxy levers (v0.4) — token-saving and retrieval-speed helpers applied by
 * mcp-proxy/memglow-mcp-proxy.js to the RESPONSES of the memory MCP server it wraps.
 *
 * Golden rules:
 *  - NOTHING is ever written in the notes folder. The notes are only read (lib/memory.js has no
 *    write path); the only file this module may write is memglow's own `proxy-savings.json`, in
 *    memglow's data folder.
 *  - The upstream answer is never altered: levers 1-3 only ADD a text block before (prefix) or after
 *    (suffix) the upstream `content` items, which stay byte-for-byte what the server sent. Only
 *    levers 4 and 5, both OFF by default, replace a response (and only plain-text read responses
 *    without `structuredContent`, or whose structuredContent is a FastMCP text wrapper — see
 *    isTextWrap(): that wrapper is kept equal to the new text, for clients that read it).
 *  - No note body is ever added: titles, ids, themes, token estimates and frontmatter descriptions
 *    (secret-masked) only.
 *  - Any failure inside a lever returns the upstream message unchanged (the proxy relays it as is).
 *
 * Levers (switches: `proxy` key of memglow.config.json, or MEMGLOW_PROXY_* environment variables):
 *   1 sizeWarning    (ON)  prefix "⚠ memglow: this note is ≈N tokens…" on a read of a note over
 *                          largeNoteTokens, or after a write that leaves it over; once per note/session
 *     indexWarning   (OFF) same, for the INDEX note above indexWarningTokens (default 2000): it is
 *                          loaded at every session, so the hint is "trim the index"; once per session
 *   2 searchDetails  (ON)  suffix after search results: title · theme · ≈tokens · description
 *   3 suggestions    (ON)  suffix after a note read: up to 3-5 related notes (links, sub-theme, co-usage)
 *   4 dedupe         (OFF) unchanged note re-read in the same session → short "unchanged" text
 *   5 toc            (OFF) note over the threshold → description + sections with ≈tokens; then one
 *                          section on demand (`memglow_section`), sliced from the upstream answer
 *   6 archiveHint    (OFF) a search that finds nothing in the live memory (no result, or only notes
 *                          of the archive folder) → suffix "memglow: nothing found in the live
 *                          memory — the archive summary lists: …" with the TITLES of the archived
 *                          sections that match the query (lib/archive.js), never their text
 * Escape hatch for 4 and 5: the argument `memglow_fresh: true` (added to the read tools' schemas in
 * `tools/list`, stripped before the call reaches the server), or simply repeating the same read:
 * the read that follows a short answer always returns the full upstream content.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemory, maskSecrets } = require("./memory");
const { createCounters } = require("./counters");
const { estimateTokens, sectionSpans, dayOf } = require("./cost");
const { rankRelated } = require("./related");
const { idsInText } = require("./agent-core");
const archive = require("./archive");

const DEFAULT_THEMES = [
  { id: "people", label: "People" }, { id: "projects", label: "Projects" }, { id: "knowledge", label: "Knowledge" },
  { id: "habits", label: "Habits & rules" }, { id: "archive", label: "Archive" },
];
const DEFAULTS = {
  sizeWarning: true,
  indexWarning: false,
  searchDetails: true,
  suggestions: true,
  dedupe: false,
  toc: false,
  archiveHint: false,
  archiveHintMax: 5,
  suggestionsMax: 3,
  searchDetailsMax: 10,
  readTools: ["read_note", "view_note", "read_content", "fetch", "build_context"],
  multiNoteTools: ["build_context"], // reads that return several notes: never de-duplicated nor cut
  searchTools: ["search_notes", "search"],
  writeTools: ["write_note", "edit_note"],
  savingsFile: true,
  log: true,
};
const ARG_FRESH = "memglow_fresh";
const ARG_SECTION = "memglow_section";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

// ---------------------------------------------------------------------------------------------
// Configuration

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function flag(envValue, fileValue, def) {
  if (envValue != null && envValue !== "") return !/^(0|false|off|no)$/i.test(String(envValue).trim());
  return typeof fileValue === "boolean" ? fileValue : def;
}
function list(envValue, fileValue, def) {
  if (envValue) return String(envValue).split(",").map((s) => s.trim()).filter(Boolean);
  return Array.isArray(fileValue) ? fileValue.filter((s) => typeof s === "string" && s) : def;
}
function int(v, def, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/**
 * Proxy settings: MEMGLOW_CONFIG (a memglow.config.json), else ~/.memglow/memglow.config.json
 * (written by `memglow init`), then environment overrides. Never throws.
 */
function proxyConfig(env = process.env) {
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const file = env.MEMGLOW_CONFIG || path.join(home, "memglow.config.json");
  const cfg = readJson(file) || {};
  const p = cfg.proxy && typeof cfg.proxy === "object" ? cfg.proxy : {};
  const base = env.MEMGLOW_CONFIG ? path.dirname(path.resolve(env.MEMGLOW_CONFIG)) : process.cwd();
  const dir = env.MEMGLOW_MEMORY_DIR || env.MEMORY_DIR || cfg.memoryDir || "";
  const themes = Array.isArray(cfg.themes) && cfg.themes.length ? cfg.themes.filter((t) => t && typeof t.id === "string") : DEFAULT_THEMES;
  return {
    sizeWarning: flag(env.MEMGLOW_PROXY_SIZE_WARNING, p.sizeWarning, DEFAULTS.sizeWarning),
    indexWarning: flag(env.MEMGLOW_PROXY_INDEX_WARNING, p.indexWarning, DEFAULTS.indexWarning),
    indexWarningTokens: int(cfg.indexWarningTokens, 2000, 100, 1000000),
    searchDetails: flag(env.MEMGLOW_PROXY_SEARCH_DETAILS, p.searchDetails, DEFAULTS.searchDetails),
    suggestions: flag(env.MEMGLOW_PROXY_SUGGESTIONS, p.suggestions, DEFAULTS.suggestions),
    dedupe: flag(env.MEMGLOW_PROXY_DEDUPE, p.dedupe, DEFAULTS.dedupe),
    toc: flag(env.MEMGLOW_PROXY_TOC, p.toc, DEFAULTS.toc),
    archiveHint: flag(env.MEMGLOW_PROXY_ARCHIVE_HINT, p.archiveHint, DEFAULTS.archiveHint),
    archiveHintMax: int(p.archiveHintMax, DEFAULTS.archiveHintMax, 1, 20),
    archive: archive.settings(cfg.archive, env, cfg.archiveAfterDays),
    suggestionsMax: int(p.suggestionsMax, DEFAULTS.suggestionsMax, 1, 5),
    searchDetailsMax: int(p.searchDetailsMax, DEFAULTS.searchDetailsMax, 1, 50),
    readTools: list(env.MEMGLOW_PROXY_READ_TOOLS, p.readTools, DEFAULTS.readTools),
    multiNoteTools: list(env.MEMGLOW_PROXY_MULTI_NOTE_TOOLS, p.multiNoteTools, DEFAULTS.multiNoteTools),
    searchTools: list(env.MEMGLOW_PROXY_SEARCH_TOOLS, p.searchTools, DEFAULTS.searchTools),
    writeTools: list(env.MEMGLOW_PROXY_WRITE_TOOLS, p.writeTools, DEFAULTS.writeTools),
    savingsFile: flag(env.MEMGLOW_PROXY_SAVINGS_FILE, p.savingsFile, DEFAULTS.savingsFile),
    log: flag(env.MEMGLOW_PROXY_LOG, p.log, DEFAULTS.log),
    largeNoteTokens: int(env.MEMGLOW_LARGE_NOTE_TOKENS || cfg.largeNoteTokens, 5000, 200, 1000000),
    memoryDir: dir ? path.resolve(base, dir) : null,
    dataDir: path.resolve(base, env.MEMGLOW_DATA_DIR || cfg.dataDir || home),
    pollMs: Math.max(500, Number(env.MEMGLOW_POLL_MS || cfg.pollMs || 2000)),
    memory: {
      indexNote: cfg.indexNote || ["MEMORY", "index"],
      themes: themes.map((t) => ({ id: String(t.id), label: String(t.label || t.id).slice(0, 40), color: t.color })),
      themeByFolder: Array.isArray(cfg.themeByFolder) ? cfg.themeByFolder.filter((x) => Array.isArray(x) && x.length === 2) : [],
      defaultTheme: cfg.defaultTheme || null,
    },
  };
}

/** True when at least one lever is on (else the proxy stays a pure byte relay). */
function anyLever(c) { return !!(c && (c.sizeWarning || c.indexWarning || c.searchDetails || c.suggestions || c.dedupe || c.toc || c.archiveHint)); }

// ---------------------------------------------------------------------------------------------
// Note metadata (read-only, cached)

/**
 * Note metadata from the notes folder, cached: the folder is rescanned at most once per pollMs
 * (stat only for unchanged files, lib/memory.js), and the derived maps are rebuilt only when the
 * memory version changes. Without a notes folder every lookup returns null.
 */
function createNoteIndex(cfg) {
  let memory = null;
  try { if (cfg.memoryDir && fs.statSync(cfg.memoryDir).isDirectory()) memory = createMemory({ dir: cfg.memoryDir, config: cfg.memory, pollMs: cfg.pollMs }); }
  catch { memory = null; }
  let cache = null, cacheVersion = -1;
  let summaryCache = null, summaryVersion = -1;

  function data() {
    if (!memory) return null;
    memory.refresh();
    if (cache && cacheVersion === memory.version()) return cache;
    const g = memory.graph();
    const byId = new Map(), byLabel = new Map(), outgoing = new Map(), incoming = new Map();
    for (const n of g.nodes) {
      byId.set(n.id, n);
      const l = String(n.label || "").toLowerCase();
      if (l && !byLabel.has(l)) byLabel.set(l, n.id);
    }
    for (const e of g.links) {
      (outgoing.get(e.source) || outgoing.set(e.source, []).get(e.source)).push(e.target);
      (incoming.get(e.target) || incoming.set(e.target, []).get(e.target)).push(e.source);
    }
    cache = { byId, byLabel, outgoing, incoming, nodes: g.nodes };
    cacheVersion = memory.version();
    return cache;
  }

  /** A note reference (id, permalink, path, memory:// URL, title) → an existing note id, or null. */
  function resolve(raw) {
    const d = data();
    if (!d || typeof raw !== "string") return null;
    const s = raw.trim().replace(/^memory:\/\//i, "");
    if (!s) return null;
    const base = s.split(/[\\/]/).pop().replace(/\.md$/i, "").trim();
    const kebab = (x) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    for (const c of [s, base, base.replace(/_/g, "-"), base.toLowerCase(), base.replace(/_/g, "-").toLowerCase(), kebab(base)]) {
      if (c && SLUG_RE.test(c) && d.byId.has(c)) return c;
    }
    return d.byLabel.get(s.toLowerCase()) || d.byLabel.get(base.toLowerCase()) || null;
  }

  // Activity counters (co-usage) — read only, reloaded when the file changes (checked every 30 s).
  let counters = null, countersMtime = -1, countersChecked = 0;
  function days() {
    if (!cfg.dataDir) return null;
    const now = Date.now();
    if (now - countersChecked > 30000) {
      countersChecked = now;
      let mtime = -1;
      try { mtime = fs.statSync(path.join(cfg.dataDir, "activity-counts.json")).mtimeMs; } catch { mtime = -1; }
      if (mtime !== countersMtime) { countersMtime = mtime; counters = mtime >= 0 ? createCounters({ dir: cfg.dataDir }) : null; }
    }
    return counters ? counters.days() : null;
  }

  return {
    available: () => !!memory,
    note(id) { const d = data(); return d && id ? d.byId.get(id) || null : null; },
    resolve,
    /**
     * After a successful write: rescan now so the new size is seen. Writes only (reads and searches
     * use the poll-interval cache); unchanged files cost one stat each.
     */
    afterWrite() {
      if (!memory) return;
      try { memory.scan(); } catch { /* keep the old view */ }
    },
    related(id, limit, exclude) {
      const d = data();
      const n = d && d.byId.get(id);
      if (!n) return [];
      return rankRelated({
        id, theme: n.theme, subtheme: n.subtheme, outgoing: d.outgoing.get(id) || [], incoming: d.incoming.get(id) || [],
        nodes: d.nodes.filter((x) => x.theme !== "index"), days: days(), limit, exclude,
      }).map((r) => d.byId.get(r.id));
    },
    /** True for a note of the archive folder (archive notes and the archive summary). */
    isArchive(id) {
      const rel = memory && id ? memory.fileOf(id) : null;
      return !!rel && !!cfg.archive && archive.inArchiveFolder(rel, cfg.archive.folder);
    },
    /** Entries of the archive summary note (lib/archive.js), [] when there is none. Cached per version. */
    archiveEntries() {
      if (!memory || !cfg.archive) return [];
      memory.refresh();
      if (summaryCache && summaryVersion === memory.version()) return summaryCache;
      let entries = [];
      const rel = memory.fileOf(cfg.archive.summaryNote);
      if (rel) { try { entries = archive.parseSummary(fs.readFileSync(path.join(cfg.memoryDir, rel), "utf8")) || []; } catch { entries = []; } }
      summaryCache = entries;
      summaryVersion = memory.version();
      return entries;
    },
    _memory: () => memory,
  };
}

// ---------------------------------------------------------------------------------------------
// Savings (levers 4 and 5): stderr journal line + memglow's own data file

function createSavings(cfg, write = (s) => process.stderr.write(s)) {
  const pending = {};
  let timer = null;
  const file = cfg.savingsFile && cfg.dataDir ? path.join(cfg.dataDir, "proxy-savings.json") : null;
  function save() {
    timer = null;
    if (!file) return;
    try {
      const cur = readJson(file) || {};
      const out = { version: 1, days: cur.days && typeof cur.days === "object" ? cur.days : {} };
      for (const [day, v] of Object.entries(pending)) {
        const o = out.days[day] && typeof out.days[day] === "object" ? out.days[day] : {};
        for (const k of ["dedupe", "toc", "dedupeCalls", "tocCalls"]) o[k] = (Number(o[k]) || 0) + (v[k] || 0);
        out.days[day] = o;
        delete pending[day];
      }
      const keep = Object.keys(out.days).sort().slice(-90);
      out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* savings are informative only */ }
  }
  let total = { dedupe: 0, toc: 0 };
  return {
    add(kind, tokens, id) {
      if (!(tokens > 0)) return;
      total[kind] += tokens;
      if (cfg.log) { try { write(`memglow-mcp-proxy: ${kind} saved ≈${tokens} tokens${id ? ` on ${id}` : ""} (session total ≈${total.dedupe + total.toc})\n`); } catch { /* ignore */ } }
      const day = dayOf(Date.now());
      const o = pending[day] || (pending[day] = {});
      o[kind] = (o[kind] || 0) + tokens;
      o[kind + "Calls"] = (o[kind + "Calls"] || 0) + 1;
      if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    total: () => ({ ...total }),
    file,
  };
}

// ---------------------------------------------------------------------------------------------
// The levers

const textOf = (content) => content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");

/**
 * FastMCP servers (basic-memory among them, `wrap_result`) send every text answer twice: in
 * `content`, and as structuredContent { result: <the same text> }. Some clients — Claude Code
 * included, checked with v2.1 — give the MODEL the structuredContent when there is one, so a lever
 * that changed only `content` would be invisible to it. Such a wrapper is recognised strictly (an
 * object with the single key `result`, a string equal to the text of an all-text `content`) and
 * kept in step with any change (oneFromServer); any other structuredContent is left alone, and
 * levers 4/5 still never replace such an answer.
 */
function isTextWrap(result) {
  const sc = result && result.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return false;
  const keys = Object.keys(sc);
  if (keys.length !== 1 || keys[0] !== "result" || typeof sc.result !== "string") return false;
  const c = result.content;
  return Array.isArray(c) && c.length > 0 && c.every((x) => x && x.type === "text" && typeof x.text === "string") && textOf(c) === sc.result;
}
const block = (text) => ({ type: "text", text });
const oneLine = (s, max) => { const t = maskSecrets(String(s || "")).replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
const PERMALINK_RE = /permalink["']?\s*[:=]\s*["']?([A-Za-z0-9_./-]{1,200})/gi;

function noteRefsInArgs(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  for (const k of ["identifier", "url", "uri", "id", "permalink", "path", "file_path", "filePath", "note", "name"]) {
    if (typeof args[k] === "string" && args[k]) out.push(args[k]);
  }
  if (typeof args.title === "string" && args.title) {
    if (typeof args.directory === "string") out.push(args.directory.replace(/^\/+|\/+$/g, "") + "/" + args.title);
    out.push(args.title);
  }
  return out;
}
function permalinksIn(text) {
  const out = [];
  for (const m of String(text).slice(0, 200000).matchAll(PERMALINK_RE)) out.push(m[1]);
  return out;
}

/**
 * createLevers({ config, index, savings }) → { clientMessage(msg, sessionKey), serverMessage(msg, sessionKey) }
 * Both return { msg, changed }. `msg` may be a JSON-RPC object or a batch (array).
 */
function createLevers({ config, index, savings }) {
  const cfg = config;
  const readTools = new Set(cfg.readTools), multi = new Set(cfg.multiNoteTools);
  const searchTools = new Set(cfg.searchTools), writeTools = new Set(cfg.writeTools);
  const replacing = cfg.dedupe || cfg.toc;
  const sessions = new Map();
  const T = cfg.largeNoteTokens;
  const themeLabel = (id) => { const t = cfg.memory.themes.find((x) => x.id === id); return t ? t.label : id; };

  function session(key) {
    const k = String(key || "default");
    let s = sessions.get(k);
    if (!s) {
      s = { pending: new Map(), warned: new Set(), delivered: new Map(), shortened: new Set(), read: new Set() };
      sessions.set(k, s);
      if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
    } else { sessions.delete(k); sessions.set(k, s); } // LRU
    return s;
  }

  function sizeWarning(note, tokens, now) {
    const theme = note && note.theme && !["other", "index"].includes(note.theme) ? ` within the same theme "${themeLabel(note.theme)}"` : "";
    return `⚠ memglow: this note is ${now ? "now " : ""}≈${tokens} tokens (threshold ${T}). Consider offering the user to split it into smaller notes${theme}; memglow's \`split_plan\` tool can propose sections.`;
  }

  // ---- client → server ----
  function oneFromClient(m, s) {
    if (!m || typeof m !== "object") return m;
    if (m.method === "initialize") { s.warned.clear(); s.delivered.clear(); s.shortened.clear(); s.read.clear(); }
    if (m.id == null) return m;
    if (m.method === "tools/list") { if (replacing) s.pending.set(String(m.id), { list: true }); return m; }
    if (m.method !== "tools/call" || !m.params || typeof m.params.name !== "string") return m;
    const tool = m.params.name;
    const args = m.params.arguments && typeof m.params.arguments === "object" && !Array.isArray(m.params.arguments) ? m.params.arguments : {};
    const kind = readTools.has(tool) ? "read" : searchTools.has(tool) ? "search" : writeTools.has(tool) ? "write" : null;
    if (!kind) return m;
    const call = { tool, kind, args, fresh: args[ARG_FRESH] === true, section: args[ARG_SECTION] };
    s.pending.set(String(m.id), call);
    if (s.pending.size > 1000) s.pending.delete(s.pending.keys().next().value);
    if (kind === "read" && (ARG_FRESH in args || ARG_SECTION in args)) {
      const clean = { ...args };
      delete clean[ARG_FRESH]; delete clean[ARG_SECTION];
      return { ...m, params: { ...m.params, arguments: clean } };
    }
    return m;
  }

  // ---- server → client ----
  function augmentList(result) {
    if (!result || !Array.isArray(result.tools)) return null;
    let changed = false;
    const tools = result.tools.map((t) => {
      if (!t || !readTools.has(t.name) || multi.has(t.name) || !t.inputSchema || typeof t.inputSchema !== "object") return t;
      const props = { ...(t.inputSchema.properties || {}) };
      props[ARG_FRESH] = { type: "boolean", description: "memglow proxy: return the full note even if it was already read in this session or is large. Not sent to the memory server." };
      if (cfg.toc) props[ARG_SECTION] = { type: "string", description: "memglow proxy: return only this section of a large note (its heading, or its number in the table of contents). Not sent to the memory server." };
      changed = true;
      return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
    });
    return changed ? { ...result, tools } : null;
  }

  function handleRead(call, result, s) {
    const content = result.content;
    const text = textOf(content);
    const refs = noteRefsInArgs(call.args);
    let id = null;
    for (const r of refs) { id = index.resolve(r); if (id) break; }
    if (!id) for (const r of permalinksIn(text)) { id = index.resolve(r); if (id) break; }
    const note = id ? index.note(id) : null;
    const respTokens = estimateTokens(text);
    const tokens = note ? note.tokens : respTokens;
    const key = id || call.tool + ":" + JSON.stringify(refs);
    const canReplace = !multi.has(call.tool) && (!("structuredContent" in result) || isTextWrap(result)) && content.length > 0
      && content.every((c) => c && c.type === "text" && typeof c.text === "string");
    const label = note ? note.label : (refs[0] || "this note");
    if (id) s.read.add(id);

    // 5b — one section on demand (sliced from the upstream answer, verbatim)
    if (cfg.toc && canReplace && call.section != null && call.section !== "" && !call.fresh) {
      const spans = sectionSpans(text);
      const want = String(call.section).trim().replace(/^#+\s*/, "").toLowerCase();
      const num = /^\d+$/.test(want) ? Number(want) : 0;
      const i = num >= 1 && num <= spans.length ? num - 1 : spans.findIndex((x) => x.title.toLowerCase() === want);
      if (i >= 0) {
        const sp = spans[i];
        s.shortened.add(key);
        savings.add("toc", respTokens - sp.tokens, id);
        return { ...result, content: [block(`memglow: section ${i + 1}/${spans.length} of "${label}" (≈${sp.tokens} of ≈${respTokens} tokens). Add "${ARG_FRESH}": true for the whole note.`), block(text.slice(sp.start, sp.end))] };
      }
      // unknown section: fall through to the table of contents (it says so)
    }

    // A plain read right after a short answer (stub, outline or section) gets the full content.
    const askedSection = cfg.toc && call.section != null && call.section !== "";
    const forced = call.fresh || (!askedSection && s.shortened.has(key));
    s.shortened.delete(key);
    const hash = crypto.createHash("sha1").update(JSON.stringify(content)).digest("hex");

    // 4 — unchanged note already delivered in full in this session
    if (cfg.dedupe && canReplace && !forced) {
      const prev = s.delivered.get(key);
      const stub = prev && prev === hash
        ? `memglow: "${label}" is unchanged since you read it earlier in this session (≈${respTokens} tokens saved), so its content is not repeated. `
          + `If you need it again (for example if the earlier copy is no longer in your context), call ${call.tool} again with the same arguments plus "${ARG_FRESH}": true, or simply repeat the same call: the next read of this note returns the full content.`
        : null;
      // Only when it actually saves something: a tiny note is cheaper than the notice.
      if (stub && respTokens > estimateTokens(stub)) {
        s.shortened.add(key);
        savings.add("dedupe", respTokens - estimateTokens(stub), id);
        return { ...result, content: [block(stub)] };
      }
    }

    // 5 — table of contents first for a large note
    if (cfg.toc && canReplace && !forced && tokens > T) {
      const spans = sectionSpans(text);
      if (spans.length >= 2) {
        const lines = [];
        if (cfg.sizeWarning && id && !s.warned.has(id)) { s.warned.add(id); lines.push(sizeWarning(note, tokens, false)); }
        const missing = call.section != null && call.section !== "" ? ` Section ${JSON.stringify(String(call.section))} was not found.` : "";
        lines.push(`memglow: "${label}" is ≈${respTokens} tokens (threshold ${T}), so only its outline is shown.${missing}`);
        if (note && note.description) lines.push(`Description: ${oneLine(note.description, 300)}`);
        lines.push("Sections:");
        spans.forEach((sp, k) => lines.push(`${k + 1}. ${sp.title ? "#".repeat(sp.level) + " " + oneLine(sp.title, 120) : "(intro)"} (≈${sp.tokens} tokens)`));
        lines.push(`To read one section, call ${call.tool} again with the same arguments plus "${ARG_SECTION}": "<heading or number>". For the whole note, add "${ARG_FRESH}": true, or simply repeat the same call.`);
        const toc = lines.join("\n");
        s.shortened.add(key);
        savings.add("toc", respTokens - estimateTokens(toc), id);
        return { ...result, content: [block(toc)] };
      }
    }

    // full delivery (upstream content untouched) + levers 1 and 3
    if (!multi.has(call.tool)) s.delivered.set(key, hash);
    const before = [], after = [];
    const isIndex = !!(note && note.theme === "index");
    if (isIndex && cfg.indexWarning && tokens > (cfg.indexWarningTokens || 2000)) {
      // The index is loaded at every session: its own threshold and hint (lever indexWarning).
      if (!s.warned.has(id)) {
        s.warned.add(id);
        before.push(block(`⚠ memglow: the index note "${oneLine(note.label, 80)}" is ≈${tokens} tokens (index threshold ${cfg.indexWarningTokens || 2000}) and it is loaded at every session. Consider offering the user to trim it: one short line per note, details moved into the notes themselves.`));
      }
    } else if (cfg.sizeWarning && tokens > T && !s.warned.has(id || key)) { s.warned.add(id || key); before.push(block(sizeWarning(note, tokens, false))); }
    if (cfg.suggestions && id) {
      const exclude = new Set(s.read);
      const rel = index.related(id, cfg.suggestionsMax, exclude);
      if (rel.length) after.push(block(`memglow: related notes: ${rel.map((n) => `${oneLine(n.label, 80)} \`${n.id}\` (≈${n.tokens} tokens)`).join(", ")}`));
    }
    if (!before.length && !after.length) return null;
    return { ...result, content: [...before, ...content, ...after] };
  }

  /** The search text the assistant sent (basic-memory `query`, or a usual name). */
  function queryOf(args) {
    for (const k of ["query", "q", "search_text", "text", "pattern", "keywords"]) if (typeof args[k] === "string" && args[k].trim()) return args[k].trim();
    return "";
  }
  /** An answer that says "nothing": empty, [], "results": [], "No results", "nothing found"… */
  function emptyAnswer(text) {
    const t = String(text).trim();
    return !t || /^\[\s*\]$/.test(t) || /"results"\s*:\s*\[\s*\]/.test(t) || /\b(no (results?|matches|notes?|documents?) (were )?found|no results|no matches|nothing found|0 results)\b/i.test(t);
  }

  // 6 — nothing in the live memory: the archive summary's matching titles (never archived text).
  function archiveHint(call, result, text, ids) {
    const live = ids.filter((id) => !index.isArchive(id));
    if (live.length || !(ids.length || emptyAnswer(text))) return null;
    const entries = index.archiveEntries();
    if (!entries.length) return null;
    const q = queryOf(call.args);
    const hits = archive.matchEntries(entries, q, cfg.archiveHintMax);
    const sumId = cfg.archive.summaryNote;
    const msg = hits.length
      ? `memglow: nothing found in the live memory — the archive summary lists: ${hits.map((e) => `"${oneLine(e.title, 80)}" (from \`${e.from}\`, archived ${e.date} in \`${e.archive}\`, ≈${e.tokens} tokens)`).join("; ")}. Read one of these archived sections only if it may answer the question.`
      : `memglow: nothing found in the live memory — the archive summary (\`${sumId}\`, ${entries.length} archived section${entries.length === 1 ? "" : "s"}) lists no title matching this search.`;
    return { ...result, content: [...result.content, block(msg)] };
  }

  function handleSearch(call, result) {
    if (!cfg.searchDetails && !cfg.archiveHint) return null;
    const text = textOf(result.content) + (result.structuredContent ? "\n" + JSON.stringify(result.structuredContent) : "");
    const ids = [];
    for (const r of [...permalinksIn(text), ...idsInText(text)]) {
      const id = index.resolve(r);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= cfg.searchDetailsMax) break;
    }
    if (cfg.archiveHint) {
      const r = archiveHint(call, result, text, ids);
      if (r) return r;
    }
    if (!cfg.searchDetails || !ids.length) return null;
    const rows = ids.map((id) => {
      const n = index.note(id);
      const theme = themeLabel(n.theme) + (n.subtheme && n.subtheme !== "general" ? "/" + n.subtheme : "");
      const desc = n.description ? " · " + oneLine(n.description, 160) : "";
      return `- ${oneLine(n.label, 80)} \`${n.id}\` · ${theme} · ≈${n.tokens} tokens${n.tokens > T ? " (large)" : ""}${desc}`;
    });
    return { ...result, content: [...result.content, block("memglow: notes in these results (title `id` · theme · size · description):\n" + rows.join("\n"))] };
  }

  function handleWrite(call, result, s) {
    if (!cfg.sizeWarning) return null;
    index.afterWrite();
    let id = null;
    for (const r of [...noteRefsInArgs(call.args), ...permalinksIn(textOf(result.content))]) { id = index.resolve(r); if (id) break; }
    const note = id ? index.note(id) : null;
    if (!note || note.tokens <= T || s.warned.has(id)) return null;
    s.warned.add(id);
    return { ...result, content: [block(sizeWarning(note, note.tokens, true)), ...result.content] };
  }

  function oneFromServer(m, s) {
    // Only responses (no "method"): a server-to-client request may reuse an id of ours.
    if (!m || typeof m !== "object" || m.id == null || "method" in m) return m;
    const key = String(m.id);
    const call = s.pending.get(key);
    if (!call) return m;
    s.pending.delete(key);
    if (m.error || !m.result || typeof m.result !== "object" || m.result.isError) return m;
    if (call.list) { const r = augmentList(m.result); return r ? { ...m, result: r } : m; }
    if (!Array.isArray(m.result.content)) return m;
    const wrap = isTextWrap(m.result);
    let r = null;
    if (call.kind === "read") r = handleRead(call, m.result, s);
    else if (call.kind === "search") r = handleSearch(call, m.result);
    else if (call.kind === "write") r = handleWrite(call, m.result, s);
    // Keep a FastMCP text wrapper in step with the change: it is what some clients show the model.
    if (r && wrap) r = { ...r, structuredContent: { result: r.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n\n") } };
    return r ? { ...m, result: r } : m;
  }

  function apply(msg, sessionKey, fn) {
    const s = session(sessionKey);
    try {
      if (Array.isArray(msg)) {
        const out = msg.map((m) => fn(m, s));
        return out.some((m, i) => m !== msg[i]) ? { msg: out, changed: true } : { msg, changed: false };
      }
      const out = fn(msg, s);
      return { msg: out, changed: out !== msg };
    } catch (e) {
      return { msg, changed: false }; // a lever bug must never break the relay
    }
  }

  return {
    clientMessage: (msg, sessionKey) => apply(msg, sessionKey, oneFromClient),
    serverMessage: (msg, sessionKey) => apply(msg, sessionKey, oneFromServer),
    /** True if a response to this request id is awaited by a lever (HTTP mode buffers only those). */
    wants: (ids, sessionKey) => { const s = session(sessionKey); return ids.some((id) => id != null && s.pending.has(String(id))); },
  };
}

module.exports = { proxyConfig, anyLever, createNoteIndex, createSavings, createLevers, DEFAULTS, ARG_FRESH, ARG_SECTION };
