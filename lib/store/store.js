"use strict";
/**
 * memglow memory server — the note store: every `*.md` under a root folder, parsed (lib/store/
 * note.js) and indexed in memory by permalink, path, title and slug, plus the link graph.
 *
 * Freshness: `fs.watch` (recursive) marks the store dirty and schedules a quick rescan; a cheap
 * stat-only rescan also runs every `pollMs` (network volumes, editors that replace files, a
 * watcher that silently stopped). A rescan re-reads only files whose mtime or size changed. Every
 * read access first applies a pending rescan, so a change seen by the watcher is visible to the
 * very next request.
 *
 * Robustness: a file that is too large, not UTF-8 or unreadable is skipped with a warning (kept
 * in `warnings`, shown by the diagnostics tool) — never a crash. Bad YAML keeps the note with the
 * frontmatter keys that could be read.
 *
 * Read-only in phase A: nothing here writes to the root.
 */
const fs = require("fs");
const path = require("path");
const { parseNote } = require("./note");
const { fold, slugify } = require("./text");

const SKIP_DIRS = new Set(["node_modules", "@eaDir", "#recycle", "#snapshot", "__pycache__"]);
const DEFAULTS = { pollMs: 3000, maxFileBytes: 4 * 1024 * 1024, maxFiles: 50000, watch: true };
const utf8 = new TextDecoder("utf-8", { fatal: true });

function createStore(opts = {}) {
  const root = path.resolve(opts.root || ".");
  const project = opts.project || "main";
  const cfg = { ...DEFAULTS, ...opts };
  const log = typeof opts.log === "function" ? opts.log : () => {};
  /** rel → note */
  const notes = new Map();
  /** rel → { mtimeMs, size } of files skipped (too large, not UTF-8…), so they are not retried every scan */
  const skipped = new Map();
  let warnings = [];
  let version = 0;
  let derived = null, derivedVersion = -1;
  let lastScanAt = 0, lastScanMs = 0, firstScanMs = 0;
  let dirty = true, debounce = null, timer = null, watcher = null, watching = false;
  let generation = 0, asyncRunning = false;

  function warn(rel, msg) {
    warnings = warnings.filter((w) => w.file !== rel);
    warnings.push({ file: rel, message: msg, at: new Date().toISOString() });
    if (warnings.length > 200) warnings = warnings.slice(-200);
    log(`memglow memory server: ${rel}: ${msg}`);
  }

  const skipEntry = (name) => name.startsWith(".") || SKIP_DIRS.has(name);
  const warnedLinks = new Set();
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* a missing root: nothing to index anyway */ }
  /** A symlinked .md is indexed only when its target is a regular file inside the root. */
  function symlinkInside(r) {
    try {
      const real = fs.realpathSync(path.join(root, r));
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        if (!warnedLinks.has(r)) { warnedLinks.add(r); warn(r, "symlink pointing outside the root: ignored"); }
        return false;
      }
      return fs.statSync(real).isFile();
    } catch { return false; }
  }
  const sortEntries = (entries) => entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  function walk(rel, out) {
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of sortEntries(entries)) {
      if (out.length >= cfg.maxFiles) return;
      if (skipEntry(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r, out);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
      else if (e.isSymbolicLink() && /\.md$/i.test(e.name) && symlinkInside(r)) out.push(r);
    }
  }

  async function walkAsync(rel, out) {
    let entries;
    try { entries = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    const subdirs = [];
    for (const e of sortEntries(entries)) {
      if (out.length >= cfg.maxFiles) return;
      if (skipEntry(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) subdirs.push(r);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
      else if (e.isSymbolicLink() && /\.md$/i.test(e.name) && symlinkInside(r)) out.push(r);
    }
    for (const d of subdirs) await walkAsync(d, out);
  }

  const statKeyOf = (st) => st.mtimeMs + ":" + st.size + ":" + st.ctimeMs + ":" + st.ino;

  /**
   * Applies a listing (files + their stats, null = vanished) to the store: re-reads only what
   * changed. Synchronous. Returns true when anything changed.
   */
  function apply(files, stats, t0) {
    let changed = false;
    const seen = new Set(files);
    for (const rel of [...notes.keys()]) if (!seen.has(rel)) { notes.delete(rel); changed = true; }
    for (const rel of [...skipped.keys()]) if (!seen.has(rel)) skipped.delete(rel);
    warnings = warnings.filter((w) => seen.has(w.file) || /^symlink/.test(w.message));
    files.forEach((rel, i) => {
      const st = stats[i];
      if (!st) { if (notes.delete(rel)) changed = true; return; }
      if (!st.isFile()) return;
      const statKey = statKeyOf(st);
      const cur = notes.get(rel);
      if (cur && cur.statKey === statKey) return;
      const sk = skipped.get(rel);
      if (sk && sk.statKey === statKey) return;
      if (st.size > cfg.maxFileBytes) {
        skipped.set(rel, { statKey });
        warn(rel, `too large (${st.size} bytes > ${cfg.maxFileBytes})`);
        if (notes.delete(rel)) changed = true;
        return;
      }
      let text;
      try { text = utf8.decode(fs.readFileSync(path.join(root, rel))); }
      catch (e) {
        if (e && e.code === "ENOENT") { if (notes.delete(rel)) changed = true; return; }
        skipped.set(rel, { statKey });
        warn(rel, !e || e.code === "ERR_ENCODING_INVALID_ENCODED_DATA" || e instanceof TypeError ? "not valid UTF-8" : `unreadable (${e.code || e.message})`);
        if (notes.delete(rel)) changed = true;
        return;
      }
      try {
        const n = parseNote({ rel, text, mtimeMs: st.mtimeMs, ctimeMs: st.birthtimeMs || st.ctimeMs, size: st.size, project });
        if (n.frontmatterError) warn(rel, "frontmatter partly unreadable: " + n.frontmatterError);
        else warnings = warnings.filter((w) => w.file !== rel);
        n.statKey = statKey;
        skipped.delete(rel);
        notes.set(rel, n);
        changed = true;
      } catch (e) {
        skipped.set(rel, { statKey });
        warn(rel, "could not be parsed: " + (e && e.message));
        if (notes.delete(rel)) changed = true;
      }
    });
    if (changed) version++;
    generation++;
    dirty = false;
    lastScanAt = Date.now();
    lastScanMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (changed && typeof opts.onChange === "function") { try { opts.onChange(version); } catch { /* a listener never breaks a scan */ } }
    return changed;
  }

  /** Synchronous rescan (startup, and a request arriving while a watch event is pending). */
  function scan() {
    const t0 = process.hrtime.bigint();
    const files = [];
    walk("", files);
    const stats = files.map((rel) => { try { return fs.statSync(path.join(root, rel)); } catch { return null; } });
    return apply(files, stats, t0);
  }

  /**
   * Periodic rescan without blocking the event loop on the stats (slow volumes): listing and
   * stats are asynchronous, only reading the changed files is synchronous. Its result is dropped
   * if a synchronous scan ran in the meantime (it would be older).
   */
  async function scanAsync() {
    if (asyncRunning) return false;
    asyncRunning = true;
    try {
      const gen = generation;
      const t0 = process.hrtime.bigint();
      const files = [];
      await walkAsync("", files);
      const stats = await Promise.all(files.map((rel) => fs.promises.stat(path.join(root, rel)).catch(() => null)));
      if (gen !== generation) return false;
      return apply(files, stats, t0);
    } finally {
      asyncRunning = false;
    }
  }

  function markDirty() {
    dirty = true;
    if (debounce) return;
    debounce = setTimeout(() => { debounce = null; try { scan(); } catch { /* next tick retries */ } }, 40);
    if (debounce.unref) debounce.unref();
  }

  function start() {
    const t0 = Date.now();
    scan();
    firstScanMs = Date.now() - t0;
    if (cfg.watch) {
      try {
        watcher = fs.watch(root, { recursive: true, persistent: false }, () => markDirty());
        watcher.on("error", () => { watching = false; try { watcher.close(); } catch { /* ignore */ } });
        watching = true;
      } catch { watching = false; /* the poll below still keeps the store fresh */ }
    }
    if (cfg.pollMs > 0) {
      timer = setInterval(() => { scanAsync().catch(() => { /* next period retries */ }); }, cfg.pollMs);
      if (timer.unref) timer.unref();
    }
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    timer = debounce = watcher = null;
    watching = false;
  }

  /** Applies a pending rescan (watch event) before a read. */
  function fresh() {
    if (dirty) { try { scan(); } catch { /* serve what we have */ } }
  }

  // ---- derived indexes (rebuilt only when `version` changes) ----

  const keyOf = (s) => String(s || "").trim().toLowerCase();

  function data() {
    fresh();
    if (derived && derivedVersion === version) return derived;
    const list = [...notes.values()].sort((a, b) => (a.permalink < b.permalink ? -1 : a.permalink > b.permalink ? 1 : a.rel < b.rel ? -1 : 1));
    const byPermalink = new Map(), byPath = new Map(), byTitle = new Map(), bySlug = new Map();
    const push = (m, k, n) => { if (!k) return; const a = m.get(k); if (a) { if (!a.includes(n)) a.push(n); } else m.set(k, [n]); };
    const prefix = project + "/";
    // Permalinks, in precedence tiers (first match wins in resolve()): (1) a DECLARED frontmatter
    // permalink, exactly; (2) the same with/without the project prefix; (3) derived ones (a note
    // without a declared permalink, and every note's path-derived form). So a declared permalink
    // can never lose to another note's path-derived one. Two notes declaring the same permalink:
    // the first in (permalink, path) order wins, deterministically, and the clash is reported.
    const collisions = new Map();
    const variantsOf = (pl) => [pl, pl.startsWith(prefix) ? pl.slice(prefix.length) : prefix + pl];
    for (const n of list) {
      if (!n.permalinkDeclared) continue;
      const pl = keyOf(n.permalink);
      const cur = byPermalink.get(pl);
      if (cur && cur.length) {
        const c = collisions.get(pl) || { permalink: n.permalink, winner: cur[0].rel, files: [cur[0].rel] };
        c.files.push(n.rel);
        collisions.set(pl, c);
      }
      push(byPermalink, pl, n);
    }
    for (const n of list) if (n.permalinkDeclared) push(byPermalink, variantsOf(keyOf(n.permalink))[1], n);
    for (const n of list) {
      if (!n.permalinkDeclared) for (const k of variantsOf(keyOf(n.permalink))) push(byPermalink, k, n);
      for (const k of variantsOf(keyOf(slugify(n.rel)))) push(byPermalink, k, n);
    }
    for (const n of list) {
      const rel = keyOf(n.rel);
      push(byPath, rel, n);
      push(byPath, rel.replace(/\.md$/, ""), n);
      push(byTitle, keyOf(n.title), n);
      push(byTitle, fold(n.title).trim(), n);
      push(bySlug, keyOf(n.base), n);
      push(bySlug, n.slug, n);
    }
    // Link graph: every relation resolved to a note when possible.
    const outgoing = new Map(), incoming = new Map();
    const resolveLink = (target) => {
      const k = keyOf(target).replace(/\.md$/, "");
      const cands = byTitle.get(k) || byPermalink.get(k) || bySlug.get(k) || byPath.get(k) || bySlug.get(slugify(target, { keepSlashes: false }))
        || byTitle.get(fold(target).trim()) || null;
      return cands ? cands[0] : null;
    };
    for (const n of list) {
      const outs = [];
      for (const r of n.relations) {
        const to = resolveLink(r.target);
        const edge = { from: n, type: r.type, target: r.target, to, context: r.context };
        outs.push(edge);
        if (to) { const a = incoming.get(to.rel); if (a) a.push(edge); else incoming.set(to.rel, [edge]); }
      }
      outgoing.set(n.rel, outs);
    }
    derived = { list, byPermalink, byPath, byTitle, bySlug, outgoing, incoming, resolveLink, version, collisions: [...collisions.values()] };
    derivedVersion = version;
    return derived;
  }

  /**
   * An identifier (permalink with or without the project prefix, memory:// URL, path with or
   * without `.md`, title, file name/slug) → the note, or null. Exact matches only, in that order;
   * ties broken by permalink order (deterministic).
   */
  function resolve(identifier) {
    if (typeof identifier !== "string") return null;
    const d = data();
    let s = identifier.trim().replace(/^memory:\/\//i, "").replace(/^\/+|\/+$/g, "");
    if (!s) return null;
    try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep as is */ }
    const k = keyOf(s);
    const k2 = k.replace(/\.md$/, "");
    const first = (a) => (a && a.length ? a[0] : null);
    // An explicit file name ("folder/note.md") is a path before anything else.
    if (k !== k2 && first(d.byPath.get(k))) return first(d.byPath.get(k));
    return first(d.byPermalink.get(k2))
      || first(d.byPath.get(k)) || first(d.byPath.get(k2))
      || first(d.byTitle.get(k)) || first(d.byTitle.get(fold(s).trim()))
      || first(d.bySlug.get(k2)) || first(d.bySlug.get(slugify(k2, { keepSlashes: false })))
      || first(d.byPermalink.get(slugify(k2)))
      || null;
  }

  /**
   * A file path relative to the root, or null when refused: it would leave the root (`..`, or a
   * symlink — of the file or of any folder on the way — resolving outside the root's real path),
   * it goes through a dot-file or dot-folder (`.git/config`…), or it is not a regular file.
   */
  function safePath(rel) {
    const clean = String(rel || "").replace(/^memory:\/\//i, "").replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = path.resolve(root, clean);
    if (abs === root || !abs.startsWith(root + path.sep)) return null;
    const relOut = path.relative(root, abs).split(path.sep).join("/");
    if (relOut.split("/").some((seg) => seg.startsWith(".") || SKIP_DIRS.has(seg))) return null;
    let real;
    try { real = fs.realpathSync(abs); } catch { return { abs, rel: relOut, missing: true }; }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
    return { abs: real, rel: relOut };
  }

  const api = {
    root, project,
    start, stop, scan, scanAsync, fresh,
    resolve, safePath,
    notes: () => data().list,
    graph: () => data(),
    version: () => { fresh(); return version; },
    collisions: () => data().collisions,
    stats: () => ({
      notes: notes.size, skipped: skipped.size, warnings: warnings.slice(), version,
      lastScanAt, lastScanMs, firstScanMs, watching, pollMs: cfg.pollMs,
    }),
  };
  return api;
}

module.exports = { createStore };
