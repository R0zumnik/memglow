"use strict";
/**
 * MCP proxy levers — note metadata (0.4.12.4 split of lib/proxy-levers.js, see that file's own
 * top comment for the full picture): createNoteIndex(), read-only and cached, is what every
 * lever below queries instead of talking to lib/memory.js directly.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createMemory } = require("../memory");
const { createCounters } = require("../counters");
const { rankRelated } = require("../related");
const archive = require("../archive");
const { memoryFingerprint } = require("../negative-cache");

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

// ---------------------------------------------------------------------------------------------
// Note metadata (read-only, cached)

/**
 * Note metadata from the notes folder, cached: the folder is rescanned at most once per pollMs
 * (stat only for unchanged files, lib/memory.js), and the derived maps are rebuilt only when the
 * memory version changes. Without a notes folder every lookup returns null.
 */
function createNoteIndex(cfg, opts = {}) {
  let memory = null;
  // 0.4.10.3: `opts.memory` — a ready-made notes source with lib/memory.js's API (the all-in-one
  // memory server passes its own store, memory-server/store-memory.js: no second scan, and
  // textOf/statOf answer from the in-memory text instead of re-reading files).
  if (opts.memory) memory = opts.memory;
  else {
    try { if (cfg.memoryDir && fs.statSync(cfg.memoryDir).isDirectory()) memory = createMemory({ dir: cfg.memoryDir, config: cfg.memory, pollMs: cfg.pollMs }); }
    catch { memory = null; }
  }
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
    // Lever 11 (negativeCache): a cheap, global stand-in for "has anything changed" — see
    // lib/negative-cache.js's memoryFingerprint. Computed here, alongside the rest of this
    // derived cache, so it is recomputed only when the memory's own `version()` changes.
    cache = { byId, byLabel, outgoing, incoming, nodes: g.nodes, fingerprint: memoryFingerprint(g.nodes) };
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
    /** Lever 14 (duplicateHint) — every note's own metadata ({ id, label, description, theme,
     * subtheme, tokens }), unfiltered: the caller excludes index/archive notes itself (theme,
     * isArchive). [] when there is no memory folder at all. */
    allNotes() { const d = data(); return d ? d.nodes : []; },
    /** Lever 11 (negativeCache) — the live memory's current fingerprint, or null when there is
     * no memory folder at all (never 0:0, which would be a real, matching fingerprint for an
     * EMPTY folder). */
    fingerprint() { const d = data(); return d ? d.fingerprint : null; },
    /**
     * Lever (orphanHint, 0.5.3) — true when this note has AT LEAST ONE link, either direction:
     * a `[[wikilink]]` it makes to another note, or one another note makes to IT (both already
     * resolved to real edges by `data()`'s own `edgesOf`, lib/memory.js — a dangling
     * `[[future-note]]` only counts once the note it names actually exists). false for an
     * unknown id, or when there is no memory folder at all.
     */
    linked(id) {
      const d = data();
      if (!d || typeof id !== "string" || !id) return false;
      return (d.outgoing.get(id) || []).length > 0 || (d.incoming.get(id) || []).length > 0;
    },
    resolve,
    /**
     * After a successful write: rescan now so the new size is seen. Writes only (reads and searches
     * use the poll-interval cache); unchanged files cost one stat each.
     */
    afterWrite() {
      if (!memory) return;
      try { memory.scan(); } catch { /* keep the old view */ }
    },
    /** { size, mtimeMs } of this note's file, read off disk right now — or null. */
    fileStat(id) {
      if (!memory || typeof id !== "string" || !id) return null;
      if (memory.statOf) return memory.statOf(id);
      try {
        const rel = memory.fileOf(id);
        if (!rel) return null;
        const st = fs.statSync(path.join(cfg.memoryDir, rel));
        return { size: st.size, mtimeMs: st.mtimeMs };
      } catch { return null; }
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
      if (rel) {
        try { entries = archive.parseSummary(memory.textOf ? memory.textOf(cfg.archive.summaryNote) : fs.readFileSync(path.join(cfg.memoryDir, rel), "utf8")) || []; }
        catch { entries = []; }
      }
      summaryCache = entries;
      summaryVersion = memory.version();
      return entries;
    },
    /**
     * Lever 8 (alreadyLoaded) — ids memglow knows are loaded at the start of every session: every
     * note of theme "index" (same rule as the indexWarning lever), plus any of `extraEntries`
     * (the main config's own `alwaysLoaded`, lib/always-loaded.js) that resolves to an existing
     * note. An entry that is not a note (an instruction file such as CLAUDE.md, outside the notes
     * folder) simply never resolves — harmless, just never matched here.
     */
    alwaysLoadedIds(extraEntries) {
      const d = data();
      const ids = new Set();
      if (!d) return ids;
      for (const n of d.nodes) if (n.theme === "index") ids.add(n.id);
      for (const e of extraEntries || []) { const rid = resolve(e); if (rid) ids.add(rid); }
      return ids;
    },
    /**
     * sha1 of this note's file, read directly off disk (never through the memory server) — or
     * null when it cannot be read right now. Used only to tell whether a note already stubbed by
     * lever 8 has changed since its hash was captured; never sent anywhere but the first 8 hex
     * characters, in the stub text itself.
     */
    fileHash(id) {
      if (!memory || typeof id !== "string" || !id) return null;
      if (memory.textOf) {
        // In-memory text (all-in-one, 0.4.10.3): the same bytes the file holds, no read.
        const t = memory.textOf(id);
        return t == null ? null : crypto.createHash("sha1").update(Buffer.from(t, "utf8")).digest("hex");
      }
      try {
        const rel = memory.fileOf(id);
        if (!rel) return null;
        return crypto.createHash("sha1").update(fs.readFileSync(path.join(cfg.memoryDir, rel))).digest("hex");
      } catch { return null; }
    },
    /**
     * Lever 16 (hubHint) — this note's own raw text (frontmatter + body), read directly, never
     * through the memory server (same pattern as fileHash above) — or null when it cannot be
     * read right now. Used to find a hub's "## Parts" list; never sent anywhere whole, only the
     * (secret-masked, capped) part labels the advisory line itself names.
     */
    noteText(id) {
      if (!memory || typeof id !== "string" || !id) return null;
      if (memory.textOf) return memory.textOf(id) ?? null; // in-memory (all-in-one), no read
      try {
        const rel = memory.fileOf(id);
        if (!rel) return null;
        return fs.readFileSync(path.join(cfg.memoryDir, rel), "utf8");
      } catch { return null; }
    },
    _memory: () => memory,
  };
}



module.exports = { createNoteIndex, SLUG_RE };
