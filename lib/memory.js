"use strict";
/**
 * memglow — reads a folder of Markdown notes and turns it into a live graph.
 *
 * - A note is any `*.md` file under MEMORY_DIR (hidden folders are skipped).
 * - Links are `[[wikilinks]]` (not those quoted inside code spans or code blocks).
 * - Optional frontmatter keys: `title`, `description`, `theme`, `subtheme` (or `sous_theme`).
 * - Changes are detected by POLLING (not fs.watch, which is unreliable on network volumes and
 *   many NAS filesystems), and a note counts as "changed" only when its BODY changes: tools that
 *   rewrite frontmatter (basic-memory, sync scripts) do not make every note flash.
 *
 * Zero dependencies, no HTTP here: see server.js.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const MAX_NOTES = 5000;
const MAX_NOTE_BYTES = 512 * 1024; // bigger notes are listed but not parsed
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const SUBTHEME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ACTIVITY_TYPES = new Set(["read", "search", "write"]);
const MAX_IDS = 20;
const RATE_MAX = 30; // activity events per second, all senders
const RECENT_MAX = 10;
// "machine": a short, per-sender label (e.g. "laptop"), never a path or an IP. Closed charset,
// 32 characters at most, starting with a letter or a digit.
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// "channel": how the event reached memglow — a closed list, never free text.
const CHANNELS = new Set(["hook", "mcp-proxy", "file", "api", "demo"]);

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^\s*(name|title|description|theme|subtheme|sous_theme):\s*(.*)$/);
    if (!k) continue;
    const key = k[1] === "sous_theme" ? "subtheme" : k[1];
    if (!(key in fm)) fm[key] = k[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: text.slice(m[0].length) };
}

/** `[[links]]` of a note body, except those quoted as examples in code. */
function linksOf(body) {
  const noCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out = new Set();
  for (const m of noCode.matchAll(/\[\[([^\]|#\n]{1,150})(?:[#|][^\]\n]*)?\]\]/g)) out.add(m[1].trim());
  return [...out];
}

// Lines that look like a secret (a keyword AND a secret-looking value, or a known token format)
// are replaced before a note body is ever sent to a browser.
const SECRET_WORD = /(token|password|passwd|secret|api[ _-]?key|bearer|credential|private[ _-]?key)/i;
const SECRET_VALUE = /([:=]\s*`?[^\s`]{6,}`?)|([A-Za-z0-9_+/=-]{24,})/;
const TOKEN_FORMAT = /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\b\d{8,10}:[A-Za-z0-9_-]{30,})/;
/** True if this line looks like a secret (keyword + value, or a known token format). */
function looksSecret(l) {
  return TOKEN_FORMAT.test(l) || (SECRET_WORD.test(l) && SECRET_VALUE.test(l));
}
function maskSecrets(text) {
  return text
    .split("\n")
    // A masked heading stays a heading (same level), so the note keeps its sections.
    .map((l) => {
      if (!looksSecret(l)) return l;
      const heading = /^#{1,6}[ \t]/.exec(l);
      return (heading ? heading[0] : "") + "[line hidden: looks like a secret]";
    })
    .join("\n");
}

function humanLabel(slug, title) {
  if (title && title !== slug && !SLUG_RE.test(title)) return title;
  const s = slug.replace(/^(user|feedback|reference|project|doc|note)[-_]/, "").replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}

/**
 * How a note gets its group: the theme and sub-theme rules of the viewer, as pure functions of the
 * note's path (relative to MEMORY_DIR), its id and the declared frontmatter values. Shared with the
 * assistant's checks (lib/assistant, lib/zones.js), which must compute the group a file WOULD get.
 */
function themeResolver(config) {
  const themeIds = new Set((config.themes || []).map((t) => t.id));
  const indexNotes = new Set([].concat(config.indexNote || ["MEMORY", "index"]));
  const byFolder = config.themeByFolder || [];

  function themeOf(rel, slug, declared) {
    if (indexNotes.has(slug)) return "index";
    const t = String(declared || "").trim().toLowerCase();
    if (themeIds.has(t)) return t;
    const folder = rel.split("/").slice(0, -1).join("/");
    const hit = byFolder.find(([pre]) => folder === pre || folder.startsWith(pre + "/"));
    if (hit && themeIds.has(hit[1])) return hit[1];
    return config.defaultTheme && themeIds.has(config.defaultTheme) ? config.defaultTheme : "other";
  }
  function subthemeOf(slug, declared, rel) {
    if (indexNotes.has(slug)) return "";
    const t = String(declared || "").trim().toLowerCase();
    if (SUBTHEME_RE.test(t)) return t;
    // No declared subtheme: the note's first sub-folder, if any (e.g. project/<subfolder>/x.md).
    const segs = rel.split("/");
    const guess = segs.length > 2 ? segs[1].toLowerCase() : "";
    return SUBTHEME_RE.test(guess) ? guess : "general";
  }
  /** Theme of a file from its path and full text (frontmatter included). */
  function themeOfText(rel, text) {
    const slug = path.posix.basename(rel, ".md");
    return themeOf(rel, slug, parseFrontmatter(String(text || "")).fm.theme);
  }
  return { themeOf, subthemeOf, themeOfText };
}

/**
 * createMemory({ dir, config, pollMs }) → the memory model.
 * config: { indexNote, themes: [{ id, label, color }], themeByFolder: [[prefix, themeId]], subthemeLabels }
 */
function createMemory({ dir, config, pollMs = 2000 }) {
  const { themeOf, subthemeOf } = themeResolver(config);

  function walk(rel = "", out = []) {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "@eaDir" || e.name === "node_modules") continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r, out);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(r);
      if (out.length >= MAX_NOTES) break;
    }
    return out;
  }

  function readNote(rel, st) {
    const slug = path.basename(rel, ".md");
    let fm = {}, links = [], fingerprint = "";
    if (st.size <= MAX_NOTE_BYTES) {
      try {
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, rel), "utf8"));
        fm = parsed.fm;
        links = linksOf(parsed.body);
        fingerprint = crypto.createHash("sha1").update(parsed.body.replace(/\s+/g, " ").trim()).digest("hex");
      } catch { /* unreadable: keep the node, without links */ }
    }
    return {
      id: slug,
      label: humanLabel(slug, fm.title),
      description: String(fm.description || "").slice(0, 400),
      folder: rel.split("/").slice(0, -1).join("/"),
      theme: themeOf(rel, slug, fm.theme),
      subtheme: subthemeOf(slug, fm.subtheme, rel),
      mtime: st.mtimeMs,
      bytes: st.size,
      links,
      fingerprint,
    };
  }

  let state = new Map(); // slug → { rel, mtimeMs, size, note }
  let lastScan = 0;
  let scanned = false;   // first scan done (what it finds is the starting point, not a write)
  let version = 0;       // bumped whenever a note entry changes (sizes, bodies, list)
  const writeListeners = new Set();

  /**
   * Rescans the folder; returns [{ type: "added"|"changed"|"removed", id }]. A BODY change (or a
   * new note) seen after the first scan is also reported to the onWrite listeners: it is a write,
   * whoever made it (server.js counts it for Memory cost, de-duplicated with reported writes).
   */
  function scan() {
    lastScan = Date.now();
    let touched = false;
    const written = [];
    const seen = new Map();
    const changes = [];
    for (const rel of walk()) {
      let st;
      try { st = fs.statSync(path.join(dir, rel)); } catch { continue; }
      const slug = path.basename(rel, ".md");
      if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
      const before = state.get(slug);
      if (before && before.rel === rel && before.mtimeMs === st.mtimeMs && before.size === st.size) {
        seen.set(slug, before);
        continue;
      }
      const note = readNote(rel, st);
      touched = true;
      // Same body, only the file date/frontmatter moved (a sync, a formatter): not a write.
      if (before && before.note.fingerprint && before.note.fingerprint === note.fingerprint && before.rel === rel) {
        note.mtime = before.note.mtime;
        seen.set(slug, { rel, mtimeMs: st.mtimeMs, size: st.size, note });
        continue;
      }
      seen.set(slug, { rel, mtimeMs: st.mtimeMs, size: st.size, note });
      changes.push({ type: before ? "changed" : "added", id: slug });
      // A file moved with the same body is not a write.
      if (scanned && !(before && before.note.fingerprint && before.note.fingerprint === note.fingerprint)) written.push(slug);
    }
    for (const slug of state.keys()) if (!seen.has(slug)) changes.push({ type: "removed", id: slug });
    state = seen;
    if (touched || changes.length) version++;
    scanned = true;
    const t = Date.now();
    for (const id of written) {
      for (const f of writeListeners) {
        try { f(id, t); } catch (e) { console.error("[memglow] write listener:", e.message); }
      }
    }
    return changes;
  }
  function fresh() { if (Date.now() - lastScan > pollMs) scan(); }

  function edgesOf(note, done) {
    const out = [];
    for (const target of note.links) {
      if (target === note.id || !state.has(target)) continue;
      const key = note.id < target ? note.id + "\n" + target : target + "\n" + note.id;
      if (done && done.has(key)) continue;
      if (done) done.add(key);
      out.push({ source: note.id, target });
    }
    return out;
  }
  function publicNode(n) {
    // `tokens`: size estimate (≈ bytes / 4, see lib/cost.js) — a number, never content.
    return { id: n.id, label: n.label, description: n.description, theme: n.theme, subtheme: n.subtheme, mtime: n.mtime, tokens: Math.ceil((n.bytes || 0) / 4) };
  }

  /** Whole graph: { available, nodes, links, activities, generated }. Never note bodies. */
  function graph() {
    fresh();
    const nodes = [], links = [], done = new Set();
    for (const { note } of state.values()) {
      nodes.push(publicNode(note));
      links.push(...edgesOf(note, done));
    }
    const activities = recent.map((e) => ({ ...e, ids: e.ids.filter((id) => state.has(id)) })).filter((e) => e.ids.length);
    return { available: state.size > 0, nodes, links, activities, generated: Date.now() };
  }

  /** One note: metadata, outgoing/incoming links, and its body if `withBody` (secrets masked). */
  function note(slug, { withBody }) {
    fresh();
    if (!SLUG_RE.test(String(slug || ""))) return null;
    const e = state.get(slug);
    if (!e) return null;
    const n = e.note;
    const outgoing = edgesOf(n).map((a) => a.target);
    const incoming = [];
    for (const { note: o } of state.values()) if (o.id !== n.id && o.links.includes(n.id)) incoming.push(o.id);
    const out = { ...publicNode(n), folder: n.folder, outgoing, incoming };
    if (withBody) {
      if (e.size > MAX_NOTE_BYTES) out.body = "[note too large to display]";
      else {
        try { out.body = maskSecrets(parseFrontmatter(fs.readFileSync(path.join(dir, e.rel), "utf8")).body.trim()); }
        catch { out.body = "[note unreadable]"; }
      }
    }
    return out;
  }

  /** Notes as Memory cost needs them: ids, labels, themes, folders and file sizes. No content. */
  function costNotes() {
    fresh();
    return [...state.values()].map(({ note: n }) => ({ id: n.id, label: n.label, theme: n.theme, subtheme: n.subtheme, folder: n.folder, bytes: n.bytes || 0 }));
  }
  /** Body of a note with secret-looking lines masked, or null (unknown, too large, unreadable). */
  function maskedBody(slug) {
    const e = state.get(slug);
    if (!e || e.size > MAX_NOTE_BYTES) return null;
    try { return maskSecrets(parseFrontmatter(fs.readFileSync(path.join(dir, e.rel), "utf8")).body); }
    catch { return null; }
  }

  // ---- live stream: polling runs only while someone listens ----
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  let timer = null;
  function tick() {
    let changes;
    try { changes = scan(); } catch (e) { console.error("[memglow] scan:", e.message); return; }
    for (const c of changes) {
      const e = state.get(c.id);
      bus.emit("change", { type: c.type, id: c.id, node: e ? publicNode(e.note) : null, links: e ? edgesOf(e.note) : [] });
    }
  }
  function subscribe(onChange, onActivity) {
    bus.on("change", onChange);
    if (onActivity) bus.on("activity", onActivity);
    if (!timer) {
      fresh();
      timer = setInterval(tick, pollMs);
      if (timer.unref) timer.unref();
    }
    return () => {
      bus.off("change", onChange);
      if (onActivity) bus.off("activity", onActivity);
      if (!bus.listenerCount("change") && timer) { clearInterval(timer); timer = null; }
    };
  }

  // ---- activity reported by assistants (POST /api/activity) ----
  let window0 = 0, inWindow = 0, lastRescan = 0;
  const recent = [];
  function toSlug(raw) {
    const s = String(raw == null ? "" : raw).trim().split(/[\\/]/).pop().replace(/\.md$/i, "");
    if (!SLUG_RE.test(s)) return null;
    if (state.has(s)) return s;
    const kebab = s.replace(/_/g, "-");
    if (state.has(kebab)) return kebab;
    const low = kebab.toLowerCase();
    return state.has(low) ? low : null;
  }
  /** → { ok, ids } or { ok: false, reason } ("rate", "shape", "type", "unknown") */
  function activity(body) {
    const now = Date.now();
    if (now - window0 >= 1000) { window0 = now; inWindow = 0; }
    if (++inWindow > RATE_MAX) return { ok: false, reason: "rate" };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "shape" };
    const type = String(body.type || "");
    if (!ACTIVITY_TYPES.has(type)) return { ok: false, reason: "type" };
    const source = /^[a-z0-9-]{1,20}$/.test(String(body.source || "")) ? body.source : "agent";
    // Both optional, additive (an activity without them displays exactly as before): a bad or
    // unknown value is silently dropped, never rejects the whole event.
    const machine = MACHINE_RE.test(String(body.machine || "")) ? body.machine : "";
    const channel = CHANNELS.has(String(body.channel || "")) ? body.channel : "";
    const raw = Array.isArray(body.ids) ? body.ids.slice(0, 50) : Array.isArray(body.slugs) ? body.slugs.slice(0, 50) : [];
    fresh();
    let ids = [...new Set(raw.map(toSlug).filter(Boolean))];
    // A write may target a note the poller has not seen yet: rescan at most once a second.
    if (type === "write" && now - lastRescan > 1000) {
      lastRescan = now;
      if (bus.listenerCount("change")) tick(); else scan();
      ids = [...new Set(raw.map(toSlug).filter(Boolean))];
    }
    ids = ids.slice(0, MAX_IDS);
    if (!ids.length) return { ok: false, reason: "unknown" };
    const evt = { type, ids, source, t: now };
    if (machine) evt.machine = machine;
    if (channel) evt.channel = channel;
    if (body.demo !== true) { recent.push(evt); if (recent.length > RECENT_MAX) recent.shift(); }
    bus.emit("activity", evt);
    return { ok: true, ids };
  }

  /** True if a note with this id exists now (validation of the saved view, lib/view.js). */
  function has(id) {
    fresh();
    return typeof id === "string" && state.has(id);
  }
  /** Path of a note relative to MEMORY_DIR (e.g. "projects/x.md"), or null. */
  function fileOf(id) {
    fresh();
    const e = typeof id === "string" ? state.get(id) : null;
    return e ? e.rel : null;
  }
  /** Ids of every note (the assistant must not reuse one for a new note). */
  function ids() {
    fresh();
    return [...state.keys()];
  }
  /** Listener for writes seen on disk: f(id, t). Returns an unsubscribe function. */
  function onWrite(f) {
    writeListeners.add(f);
    return () => writeListeners.delete(f);
  }

  return {
    graph, note, subscribe, activity, scan, costNotes, maskedBody, has, onWrite, fileOf, ids,
    refresh: fresh, // rescans only if the last scan is older than pollMs (MCP proxy cache)
    version: () => version,
    _maskSecrets: maskSecrets,
  };
}

module.exports = { createMemory, themeResolver, parseFrontmatter, linksOf, maskSecrets, looksSecret, SLUG_RE, SUBTHEME_RE };
