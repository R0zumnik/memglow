"use strict";
/**
 * memglow memory server, all-in-one mode (0.4.10.3) — the levers' note index fed from the
 * memory server's OWN store (the notes it has already read and parsed) instead of a second scan
 * of the same folder by lib/memory.js. An object with the subset of lib/memory.js's createMemory()
 * API that lib/proxy-levers.js createNoteIndex() uses — refresh, version, graph, scan, fileOf,
 * maskedBody, rawBody — plus textOf / statOf, so lever 8's hashes, the archive summary and the
 * size after a write come from the in-memory text, never from a new read of the file.
 *
 * Same semantics as lib/memory.js, so the levers answer exactly as in "proxy → memory server":
 * the notes under `memoryDir` (inside the store's root) whose file name ends in ".md" (not a
 * symlink), in the same depth-first, name-sorted order; id = the file name without ".md" when it
 * is a slug (SLUG_RE), the first in that order winning; label, description, theme, subtheme from
 * lib/memory.js's own frontmatter reader and theme rules; `[[links]]` outside code; a note larger
 * than 512 KB listed without frontmatter or links; `mtime` = the time of the last BODY change
 * (a frontmatter-only change keeps the previous one). The one documented difference: the store
 * also skips `#recycle`, `#snapshot` and `__pycache__` folders, which lib/memory.js lists.
 *
 * Incremental: per-note metadata is cached on the (immutable) store note object, so a write
 * re-derives one note, and the graph (nodes + links) is rebuilt only when the store's version
 * changes — no file is read for it.
 */
const path = require("path");
const crypto = require("crypto");
const memoryLib = require("../lib/memory");

const MAX_NOTE_BYTES = 512 * 1024; // same as lib/memory.js

/** lib/memory.js walk order: depth-first, entries sorted by name in each folder. */
function walkOrder(a, b) {
  const x = a.split("/"), y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

function createStoreMemory({ store, memoryDir, config }) {
  const root = path.resolve(store.root);
  const dir = path.resolve(memoryDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) return null; // not inside the store's root
  const prefix = dir === root ? "" : path.relative(root, dir).split(path.sep).join("/") + "/";
  const { themeOf, subthemeOf } = memoryLib.themeResolver(config || {});
  const META = new WeakMap(); // store note → its lib/memory.js-shaped metadata
  let built = null, builtVersion = -1;
  let prevById = new Map(); // id → { rel, fingerprint, mtime } of the last graph (mtime rule)

  /** A note's text exactly as lib/memory.js reads it (a BOM the store's reader dropped put back). */
  const fullText = (n) => (n.bom && n.raw.charCodeAt(0) !== 0xfeff ? "\ufeff" + n.raw : n.raw);

  function metaOf(n, rel) {
    let m = META.get(n);
    if (m) return m;
    const slug = path.posix.basename(rel, ".md");
    let fm = {}, links = [];
    if (n.size <= MAX_NOTE_BYTES) {
      const parsed = memoryLib.parseFrontmatter(fullText(n));
      fm = parsed.fm;
      links = memoryLib.linksOf(parsed.body);
    }
    m = {
      id: slug,
      label: memoryLib.humanLabel(slug, fm.title),
      description: String(fm.description || "").slice(0, 400),
      folder: rel.split("/").slice(0, -1).join("/"),
      theme: themeOf(rel, slug, fm.theme),
      subtheme: subthemeOf(slug, fm.subtheme, rel),
      bytes: n.size,
      links,
      fingerprint: null, // computed only when needed (fingerprintOf): comparing two versions of a note
    };
    META.set(n, m);
    return m;
  }

  // Files the store lists but does not index (not UTF-8, too large, unparsable): lib/memory.js
  // still lists them (lossy decoding), so they are read here once per file version.
  const skippedCache = new Map(); // rel → pseudo note
  function skippedNotes() {
    const out = [];
    const list = store.skippedFiles ? store.skippedFiles() : [];
    const keep = new Set();
    for (const s of list) {
      if (prefix && !s.rel.startsWith(prefix)) continue;
      keep.add(s.rel);
      let n = skippedCache.get(s.rel);
      if (!n || n.statKey !== s.statKey) {
        let raw = "";
        if (s.size <= MAX_NOTE_BYTES) { try { raw = require("fs").readFileSync(path.join(root, s.rel), "utf8"); } catch { raw = ""; } }
        n = { rel: s.rel, raw, bom: false, size: s.size, mtimeMs: s.mtimeMs, statKey: s.statKey };
        skippedCache.set(s.rel, n);
      }
      out.push(n);
    }
    for (const rel of [...skippedCache.keys()]) if (!keep.has(rel)) skippedCache.delete(rel);
    return out;
  }

  /** lib/memory.js's body fingerprint (whitespace-normalised body sha1, "" for a large note). */
  function fingerprintOf(n, rel) {
    const m = metaOf(n, rel);
    if (m.fingerprint == null) {
      m.fingerprint = n.size <= MAX_NOTE_BYTES
        ? crypto.createHash("sha1").update(memoryLib.parseFrontmatter(fullText(n)).body.replace(/\s+/g, " ").trim()).digest("hex") : "";
    }
    return m.fingerprint;
  }

  function data() {
    const v = store.version();
    if (built && builtVersion === v) return built;
    const picked = [];
    for (const n of store.notes().concat(skippedNotes())) {
      if (prefix && !n.rel.startsWith(prefix)) continue;
      if (!n.rel.endsWith(".md") || (store.isSymlink && store.isSymlink(n.rel))) continue;
      const rel = n.rel.slice(prefix.length);
      const slug = path.posix.basename(rel, ".md");
      if (!memoryLib.SLUG_RE.test(slug)) continue;
      picked.push({ n, rel, slug });
    }
    picked.sort((a, b) => walkOrder(a.rel, b.rel));
    const state = new Map(); // id → { rel, note (public shape), n }
    const nextPrev = new Map();
    for (const { n, rel, slug } of picked) {
      if (state.has(slug)) continue;
      const m = metaOf(n, rel);
      const before = prevById.get(slug);
      // A body unchanged since the last graph (same file): keep the date of the last body change.
      // The same note object as last time: nothing changed. Else compare the bodies' fingerprints
      // (computed now, for these two versions only).
      let mtime = n.mtimeMs;
      if (before && before.rel === rel) {
        if (before.n === n) mtime = before.mtime;
        else { const fp = fingerprintOf(before.n, rel); if (fp && fp === fingerprintOf(n, rel)) mtime = before.mtime; }
      }
      state.set(slug, { rel, n, m, mtime });
      nextPrev.set(slug, { rel, n, mtime });
    }
    prevById = nextPrev;
    const nodes = [], links = [], done = new Set();
    for (const e of state.values()) {
      nodes.push({ id: e.m.id, label: e.m.label, description: e.m.description, theme: e.m.theme, subtheme: e.m.subtheme, mtime: e.mtime, tokens: Math.ceil((e.m.bytes || 0) / 4) });
      for (const target of e.m.links) {
        if (target === e.m.id || !state.has(target)) continue;
        const key = e.m.id < target ? e.m.id + "\n" + target : target + "\n" + e.m.id;
        if (done.has(key)) continue;
        done.add(key);
        links.push({ source: e.m.id, target });
      }
    }
    built = { state, graph: { available: state.size > 0, nodes, links, activities: [], generated: Date.now() } };
    builtVersion = v;
    return built;
  }

  const entry = (id) => (typeof id === "string" ? data().state.get(id) || null : null);
  /** The note's bytes as on disk (a BOM the reader dropped is put back), as a string. */
  const textOf = (id) => { const e = entry(id); return e ? fullText(e.n) : null; };
  const bodyOf = (id) => { const e = entry(id); if (!e || e.n.size > MAX_NOTE_BYTES) return null; return memoryLib.parseFrontmatter(fullText(e.n)).body; };

  return {
    fromStore: true,
    refresh() { store.fresh(); },
    version: () => store.version(),
    graph: () => data().graph,
    scan() { store.fresh(); return []; }, // the writer already updated the store: nothing to read
    fileOf: (id) => { const e = entry(id); return e ? e.rel : null; },
    has: (id) => !!entry(id),
    ids: () => [...data().state.keys()],
    rawBody: bodyOf,
    maskedBody: (id) => { const b = bodyOf(id); return b == null ? null : memoryLib.maskSecrets(b); },
    textOf,
    statOf: (id) => { const e = entry(id); return e ? { size: e.n.size, mtimeMs: e.n.mtimeMs } : null; },
  };
}

module.exports = { createStoreMemory, walkOrder };
