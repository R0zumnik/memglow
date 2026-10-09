"use strict";
/**
 * memglow memory server — the note store: every `*.md` under a root folder, parsed (lib/store/
 * note.js) and indexed in memory by permalink, path, title and slug, plus the link graph.
 *
 * Freshness (0.4.10.4): one NON-recursive `fs.watch` on the root and on each note folder the
 * listing finds (dot-folders, `.trash`, `.git`, `@eaDir`, `node_modules`… are never listed, so
 * never watched — a git snapshot writing hundreds of objects costs nothing). The watched set is
 * re-armed whenever the folder list changes. An event stats only the file it names and applies
 * the change asynchronously (a debounce of a few ms gathers a burst); an event about a folder,
 * or one without a name, schedules an asynchronous rescan. A cheap stat-only rescan also runs
 * every `pollMs` (fallback: network volumes, a watcher that silently stopped). Reads never scan
 * synchronously (except the very first read of a store whose initial load has not finished).
 *
 * Robustness: a file that is too large, not UTF-8 or unreadable is skipped with a warning (kept
 * in `warnings`, shown by the diagnostics tool) — never a crash. Bad YAML keeps the note with the
 * frontmatter keys that could be read.
 *
 * Writes (phase B) go through memory-server/writer.js, never through the store: after each one the
 * writer hands the store the text it just wrote and the file's fresh stat (noteWritten /
 * noteRemoved), so the very next read sees it without re-reading the file — and the watcher event
 * that follows finds the same stat and re-reads nothing.
 */
const fs = require("fs");
const path = require("path");
const { parseNote } = require("./note");
const { fold, slugify } = require("./text");

const SKIP_DIRS = new Set(["node_modules", "@eaDir", "#recycle", "#snapshot", "__pycache__"]);
const DEFAULTS = { pollMs: 3000, maxFileBytes: 4 * 1024 * 1024, maxFiles: 50000, watch: true, maxWatches: 4000, watchDebounceMs: 25 };
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
  let dirty = true, debounce = null, timer = null, watching = false;
  /** dir rel ("" = root) → FSWatcher (0.4.10.4) */
  const watchers = new Map();
  let dirList = [];
  const counters = { fullScans: 0, eventApplies: 0, events: 0 };
  let generation = 0, asyncRunning = false;
  // 0.4.10.2: false until a first full listing has been applied (startAsync loads it in chunks;
  // any read before that does the plain synchronous scan instead — never an empty answer).
  let loaded = false, loadPromise = null, stopped = false;

  function warn(rel, msg) {
    warnings = warnings.filter((w) => w.file !== rel);
    warnings.push({ file: rel, message: msg, at: new Date().toISOString() });
    if (warnings.length > 200) warnings = warnings.slice(-200);
    log(`memglow memory server: ${rel}: ${msg}`);
  }

  const skipEntry = (name) => name.startsWith(".") || SKIP_DIRS.has(name);
  const warnedLinks = new Set();
  const symlinks = new Set(); // rels listed through a symlink (lib/memory.js does not list those)
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

  function walk(rel, out, dirs) {
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    if (dirs) dirs.push(rel);
    for (const e of sortEntries(entries)) {
      if (out.length >= cfg.maxFiles) return;
      if (skipEntry(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r, out, dirs);
      else if (e.isFile() && /\.md$/i.test(e.name)) { out.push(r); symlinks.delete(r); }
      else if (e.isSymbolicLink() && /\.md$/i.test(e.name) && symlinkInside(r)) { out.push(r); symlinks.add(r); }
    }
  }

  async function walkAsync(rel, out, dirs, onDir) {
    if (onDir) onDir(rel); // watch a folder BEFORE listing it: nothing changed in it is missed
    let entries;
    try { entries = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    if (dirs) dirs.push(rel);
    const subdirs = [];
    for (const e of sortEntries(entries)) {
      if (out.length >= cfg.maxFiles) return;
      if (skipEntry(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) subdirs.push(r);
      else if (e.isFile() && /\.md$/i.test(e.name)) { out.push(r); symlinks.delete(r); }
      else if (e.isSymbolicLink() && /\.md$/i.test(e.name) && symlinkInside(r)) { out.push(r); symlinks.add(r); }
    }
    for (const d of subdirs) await walkAsync(d, out, dirs, onDir);
  }

  const statKeyOf = (st) => st.mtimeMs + ":" + st.size + ":" + st.ctimeMs + ":" + st.ino;

  /**
   * Applies a listing (files + their stats, null = vanished) to the store: re-reads only what
   * changed. Synchronous. Returns true when anything changed.
   */
  /** One listed file (st = its stat, null = vanished) → the store. True when anything changed. */
  function applyEntry(rel, st) {
    if (!st) return notes.delete(rel);
    if (!st.isFile()) return false;
    const statKey = statKeyOf(st);
    const cur = notes.get(rel);
    if (cur && cur.statKey === statKey) return false;
    const sk = skipped.get(rel);
    if (sk && sk.statKey === statKey) return false;
    if (st.size > cfg.maxFileBytes) {
      skipped.set(rel, { statKey, size: st.size, mtimeMs: st.mtimeMs });
      warn(rel, `too large (${st.size} bytes > ${cfg.maxFileBytes})`);
      return notes.delete(rel);
    }
    let text, bom = false;
    try { const buf = fs.readFileSync(path.join(root, rel)); bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf; text = utf8.decode(buf); }
    catch (e) {
      if (e && e.code === "ENOENT") return notes.delete(rel);
      skipped.set(rel, { statKey, size: st.size, mtimeMs: st.mtimeMs });
      warn(rel, !e || e.code === "ERR_ENCODING_INVALID_ENCODED_DATA" || e instanceof TypeError ? "not valid UTF-8" : `unreadable (${e.code || e.message})`);
      return notes.delete(rel);
    }
    try {
      const n = parseNote({ rel, text, mtimeMs: st.mtimeMs, ctimeMs: st.birthtimeMs || st.ctimeMs, size: st.size, project });
      if (n.frontmatterError) warn(rel, "frontmatter partly unreadable: " + n.frontmatterError);
      else warnings = warnings.filter((w) => w.file !== rel);
      n.statKey = statKey;
      if (bom) n.bom = true;
      skipped.delete(rel);
      notes.set(rel, n);
      return true;
    } catch (e) {
      skipped.set(rel, { statKey, size: st.size, mtimeMs: st.mtimeMs });
      warn(rel, "could not be parsed: " + (e && e.message));
      return notes.delete(rel);
    }
  }

  /** The part of a full listing's application that drops what is no longer listed. */
  function applyRemovals(files, skip = null) {
    let changed = false;
    const seen = new Set(files);
    for (const rel of [...notes.keys()]) if (!seen.has(rel) && !(skip && skip.has(rel))) { notes.delete(rel); changed = true; }
    for (const rel of [...skipped.keys()]) if (!seen.has(rel) && !(skip && skip.has(rel))) skipped.delete(rel);
    warnings = warnings.filter((w) => seen.has(w.file) || /^symlink/.test(w.message));
    return changed;
  }

  function apply(files, stats, t0, skip = null) {
    let changed = applyRemovals(files, skip);
    files.forEach((rel, i) => { if (skip && skip.has(rel)) return; if (applyEntry(rel, stats[i])) changed = true; });
    return applied(changed, t0);
  }

  // 0.4.10.7: the files the writer changed directly (noteWritten / noteRemoved), with the
  // generation of each change — so a listing taken before them can still be applied (merged),
  // leaving those files alone, instead of being dropped (forward progress under a write burst).
  const directLog = []; // [{ gen, rel }], bounded
  function touchedSince(gen) {
    if (directLog.length && directLog[0].gen > gen + 1 && directLog.length >= 10000) return null; // log overflowed
    const out = new Set();
    for (let i = directLog.length - 1; i >= 0 && directLog[i].gen > gen; i--) out.add(directLog[i].rel);
    return out;
  }

  function applied(changed, t0) {
    loaded = true;
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
    const files = [], dirs = [];
    walk("", files, dirs);
    const stats = files.map((rel) => { try { return fs.statSync(path.join(root, rel)); } catch { return null; } });
    counters.fullScans++;
    const changed = apply(files, stats, t0);
    syncWatches(dirs);
    return changed;
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
      const files = [], dirs = [];
      await walkAsync("", files, dirs);
      const stats = await Promise.all(files.map((rel) => fs.promises.stat(path.join(root, rel)).catch(() => null)));
      let skip = null;
      if (gen !== generation) {
        // Writes landed meanwhile: merge, leaving the files they changed as they are now.
        skip = touchedSince(gen);
        if (!skip) return false;
      }
      lastScanGen = generation + 1;
      counters.fullScans++;
      const changed = apply(files, stats, t0, skip);
      syncWatches(dirs);
      return changed;
    } finally {
      asyncRunning = false;
    }
  }

  // ---- watching (0.4.10.4): non-recursive, one watcher per note folder ----

  /** Watches exactly `dirs` (rels, "" = root): new ones armed, vanished ones closed. */
  function syncWatches(dirs) {
    dirList = dirs.slice();
    if (!cfg.watch || stopped) return;
    const want = new Set(dirs);
    for (const [d, w] of watchers) if (!want.has(d)) { try { w.close(); } catch { /* ignore */ } watchers.delete(d); }
    for (const d of dirs) armWatch(d);
    watching = watchers.size > 0;
  }

  /** Watches one folder (re-armed when its inode changed). */
  function armWatch(d) {
    if (!cfg.watch || stopped) return;
    {
      // A folder deleted and recreated under the same name is a new inode: its old watcher is
      // dead (0.4.10.6b) — replaced, not kept.
      let ino = null;
      try { ino = fs.statSync(d ? path.join(root, d) : root).ino; } catch { /* gone meanwhile */ }
      const cur = watchers.get(d);
      if (cur && cur.ino === ino) return;
      if (cur) { try { cur.close(); } catch { /* ignore */ } watchers.delete(d); }
      if (watchers.size >= cfg.maxWatches) return;
      try {
        const w = fs.watch(d ? path.join(root, d) : root, { persistent: false }, (event, name) => onWatchEvent(d, name));
        w.ino = ino;
        w.on("error", () => { try { w.close(); } catch { /* ignore */ } if (watchers.get(d) === w) watchers.delete(d); scheduleRescan(); });
        watchers.set(d, w);
        watching = true;
      } catch { /* this folder unwatched: the poll still covers it */ }
    }
  }

  const pendingFiles = new Set();
  // Names that are not notes: only a folder (new, or a watched one gone) is worth a rescan — a
  // log or database file written all the time in a note folder must never cause rescans.
  const pendingOther = new Set();
  let rescanWanted = false, applying = false, lastScanGen = -1;
  function onWatchEvent(dirRel, name) {
    counters.events++;
    if (name == null) { scheduleRescan(); return; }
    const base = String(name);
    if (skipEntry(base) || base.includes("/") || base.includes(path.sep)) return; // dot-files (writer temps), skipped folders
    const rel = dirRel ? dirRel + "/" + base : base;
    if (/\.md$/i.test(base)) pendingFiles.add(rel);
    else pendingOther.add(rel); // a folder created / removed / renamed? (checked by applyEvents)
    if (pendingFiles.size + pendingOther.size > 1000) { pendingFiles.clear(); pendingOther.clear(); scheduleRescan(); }
    scheduleApply();
  }
  function scheduleRescan() { rescanWanted = true; scheduleApply(); }
  function scheduleApply() {
    if (debounce || stopped) return;
    debounce = setTimeout(() => { debounce = null; applyEvents().catch(() => { /* the poll catches up */ }); }, cfg.watchDebounceMs);
    if (debounce.unref) debounce.unref();
  }
  /** Applies what the watchers reported: a stat of each named file, or a rescan. Asynchronous. */
  async function applyEvents() {
    if (applying || !loaded) { scheduleApply(); return; } // during the startup load: once it is done
    applying = true;
    try {
      if (rescanWanted) {
        rescanWanted = false;
        pendingFiles.clear();
        if (asyncRunning) { rescanWanted = true; scheduleApply(); return; }
        const gen = generation;
        const done = await scanAsync();
        // Dropped because a write moved the store on meanwhile (0.4.10.6b): wanted all the same.
        if (!done && generation !== gen && lastScanGen !== generation) { rescanWanted = true; scheduleApply(); }
        return;
      }
      if (pendingOther.size) {
        const others = [...pendingOther];
        pendingOther.clear();
        const known = new Set(dirList);
        const dirty = await Promise.all(others.map((rel) => fs.promises.lstat(path.join(root, rel)).then(
          (st) => st.isDirectory() && (!known.has(rel) || !watchers.has(rel) || watchers.get(rel).ino !== st.ino),
          (e) => known.has(rel) || !e || e.code !== "ENOENT")));
        if (dirty.some(Boolean)) { rescanWanted = true; scheduleApply(); }
      }
      const rels = [...pendingFiles];
      pendingFiles.clear();
      if (!rels.length) return;
      const t0 = process.hrtime.bigint();
      const gen = generation;
      const stats = await Promise.all(rels.map(async (rel) => {
        try {
          const lst = await fs.promises.lstat(path.join(root, rel));
          if (lst.isSymbolicLink()) { if (!symlinkInside(rel)) return null; symlinks.add(rel); return await fs.promises.stat(path.join(root, rel)); }
          symlinks.delete(rel);
          return lst;
        } catch { return null; }
      }));
      if (gen !== generation) { for (const r of rels) pendingFiles.add(r); scheduleApply(); return; } // a scan or a write moved on: redo
      let changed = false;
      rels.forEach((rel, i) => { if (applyEntry(rel, stats[i] && stats[i].isFile() ? stats[i] : null)) changed = true; if (!stats[i]) skipped.delete(rel); });
      counters.eventApplies++;
      if (changed) {
        version++;
        generation++;
        lastScanMs = Number(process.hrtime.bigint() - t0) / 1e6;
        if (typeof opts.onChange === "function") { try { opts.onChange(version); } catch { /* ignore */ } }
      }
    } finally { applying = false; }
  }

  function markDirty() { scheduleRescan(); }

  function start() {
    const t0 = Date.now();
    scan();
    firstScanMs = Date.now() - t0;
    startWatching();
    return api;
  }

  /**
   * 0.4.10.2: start without blocking — the first listing is read and parsed in setImmediate
   * chunks of a few files. Resolves (never rejects) once the store holds the whole folder. A read
   * arriving earlier gets the plain synchronous scan (fresh()), which this load then gives way to.
   */
  function startAsync({ chunk = 16 } = {}) {
    if (loadPromise) return loadPromise;
    const t0ms = Date.now();
    loadPromise = (async () => {
      try {
        const gen = generation;
        const t0 = process.hrtime.bigint();
        const files = [], dirs = [];
        // 0.4.10.7: each folder is watched as soon as it is reached (before it is listed); events
        // are queued until the load is applied, then applied.
        await walkAsync("", files, dirs, (d) => armWatch(d));
        dirList = dirs;
        if (cfg.watch && !stopped) syncWatches(dirs);
        const stats = await Promise.all(files.map((rel) => fs.promises.stat(path.join(root, rel)).catch(() => null)));
        if (gen !== generation || loaded) return;
        let changed = applyRemovals(files);
        for (let i = 0; i < files.length; i += chunk) {
          for (let j = i; j < Math.min(files.length, i + chunk); j++) if (applyEntry(files[j], stats[j])) changed = true;
          await new Promise((ok) => setImmediate(ok));
          if (gen !== generation || loaded) return; // a synchronous scan took over: it is complete
        }
        applied(changed, t0);
      } catch { if (!loaded) { try { scan(); } catch { /* serve what we have */ } } }
      finally {
        firstScanMs = Date.now() - t0ms;
        startWatching();
      }
    })();
    return loadPromise;
  }

  function startWatching() {
    if (stopped) return api;
    if (cfg.watch && !watchers.size) syncWatches(dirList.length ? dirList : [""]);
    if (cfg.pollMs > 0 && !timer) {
      timer = setInterval(() => { scanAsync().catch(() => { /* next period retries */ }); }, cfg.pollMs);
      if (timer.unref) timer.unref();
    }
    return api;
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
    watchers.clear();
    timer = debounce = null;
    watching = false;
  }

  /**
   * Before a read: the plain synchronous scan only before the very first load has finished
   * (0.4.10.4: watcher events are applied asynchronously, never on the request path).
   */
  function fresh() {
    if (!loaded) { try { scan(); } catch { /* serve what we have */ } }
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
    // Link graph (0.4.10.3): built lazily by graph() — only build_context needs it; resolution
    // (resolve, resolveLink) needs the maps above only.
    const resolveLink = (target) => {
      const k = keyOf(target).replace(/\.md$/, "");
      const cands = byTitle.get(k) || byPermalink.get(k) || bySlug.get(k) || byPath.get(k) || bySlug.get(slugify(target, { keepSlashes: false }))
        || byTitle.get(fold(target).trim()) || null;
      return cands ? cands[0] : null;
    };
    derived = { list, byPermalink, byPath, byTitle, bySlug, outgoing: null, incoming: null, resolveLink, version, collisions: [...collisions.values()] };
    derivedVersion = version;
    return derived;
  }

  /** data() plus the link graph (outgoing / incoming edges), built on first use per version. */
  function graph() {
    const d = data();
    if (d.outgoing) return d;
    const outgoing = new Map(), incoming = new Map();
    for (const n of d.list) {
      const outs = [];
      for (const r of n.relations) {
        const to = d.resolveLink(r.target);
        const edge = { from: n, type: r.type, target: r.target, to, context: r.context };
        outs.push(edge);
        if (to) { const a = incoming.get(to.rel); if (a) a.push(edge); else incoming.set(to.rel, [edge]); }
      }
      outgoing.set(n.rel, outs);
    }
    d.outgoing = outgoing;
    d.incoming = incoming;
    return d;
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
   * For writes: the note an identifier designates (same precedence as resolve) and, when it was
   * only found by title or file name, every note that matches it that way — so a destructive
   * operation can refuse an ambiguous identifier instead of picking one. { note, ambiguous: [notes] }.
   */
  function resolveForWrite(identifier) {
    const note = resolve(identifier);
    if (!note) return { note: null, ambiguous: [] };
    const d = data();
    let s = String(identifier).trim().replace(/^memory:\/\//i, "").replace(/^\/+|\/+$/g, "");
    try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep as is */ }
    const k = keyOf(s), k2 = k.replace(/\.md$/, "");
    const exact = (k !== k2 && d.byPath.get(k)) || d.byPermalink.get(k2) || d.byPath.get(k) || d.byPath.get(k2);
    if (exact && exact.length) return { note, ambiguous: [] };
    const set = new Set();
    for (const list of [d.byTitle.get(k), d.byTitle.get(fold(s).trim()), d.bySlug.get(k2), d.bySlug.get(slugify(k2, { keepSlashes: false }))]) {
      for (const n of list || []) set.add(n);
    }
    return { note, ambiguous: set.size > 1 ? [...set] : [] };
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

  /** The writer just wrote `text` to `rel` (stat = the file's stat after the rename). */
  function noteWritten(rel, text, st) {
    const n = parseNote({ rel, text, mtimeMs: st.mtimeMs, ctimeMs: st.birthtimeMs || st.ctimeMs, size: st.size, project });
    // 0.4.10.7: `st.stale` (writer.writeAtomic) — the file at this path is no longer the one the
    // server wrote (an outside save landed right after the rename): no valid stat for our text,
    // so the next look at this file (queued now) re-reads it.
    n.statKey = st.stale ? "stale" : statKeyOf(st);
    if (n.frontmatterError) warn(rel, "frontmatter partly unreadable: " + n.frontmatterError);
    else warnings = warnings.filter((w) => w.file !== rel);
    skipped.delete(rel);
    notes.set(rel, n);
    afterDirectChange(rel);
    if (st.stale) { pendingFiles.add(rel); scheduleApply(); }
    return n;
  }
  /**
   * 0.4.10.7: before answering about a note (read_note, edit_note, lever 8's "unchanged" check):
   * apply the watcher events still waiting for their debounce, synchronously (a stat each — the
   * set is small), and check `rel` itself with one stat; a change found is applied at once.
   * Without it, a read right after an outside save could answer the old version for ~25 ms or more.
   * Returns true when anything changed.
   */
  function refreshNote(rel) {
    if (!loaded) { fresh(); return true; }
    let changed = false;
    const rels = [...pendingFiles];
    if (rel && !rels.includes(rel)) rels.push(rel);
    for (const r of rels) {
      let st = null;
      try {
        const lst = fs.lstatSync(path.join(root, r));
        if (lst.isSymbolicLink()) { if (symlinkInside(r)) { symlinks.add(r); st = fs.statSync(path.join(root, r)); } }
        else { symlinks.delete(r); st = lst; }
      } catch { st = null; }
      if (!st && !notes.has(r) && !skipped.has(r)) continue; // nothing there, nothing known
      if (st && !st.isFile()) st = null;
      pendingFiles.delete(r);
      if (applyEntry(r, st)) changed = true;
      if (!st) skipped.delete(r);
    }
    if (changed) {
      version++;
      generation++;
      if (typeof opts.onChange === "function") { try { opts.onChange(version); } catch { /* ignore */ } }
    }
    return changed;
  }

  /** The writer just moved `rel` away (move or trash). */
  function noteRemoved(rel) {
    skipped.delete(rel);
    warnings = warnings.filter((w) => w.file !== rel);
    if (notes.delete(rel)) afterDirectChange(rel); else directLog.push({ gen: generation, rel });
  }
  function afterDirectChange(rel) {
    version++;
    generation++;
    if (rel != null) { directLog.push({ gen: generation, rel }); if (directLog.length > 10000) directLog.splice(0, directLog.length - 10000); } // an asynchronous rescan listed before this change must not be applied
    if (typeof opts.onChange === "function") { try { opts.onChange(version); } catch { /* ignore */ } }
  }

  const api = {
    root, project, realRoot: () => realRoot,
    start, startAsync, stop, scan, scanAsync, fresh, noteWritten, noteRemoved, refreshNote,
    loaded: () => loaded,
    isSymlink: (rel) => symlinks.has(rel),
    /** Files listed but not indexed (too large, not UTF-8, unparsable): [{ rel, statKey, size, mtimeMs }]. */
    skippedFiles: () => { fresh(); return [...skipped.entries()].map(([rel, s]) => ({ rel, ...s })); },
    resolve, resolveForWrite, safePath,
    notes: () => data().list,
    graph,
    version: () => { fresh(); return version; },
    collisions: () => data().collisions,
    stats: () => ({
      notes: notes.size, skipped: skipped.size, warnings: warnings.slice(), version,
      lastScanAt, lastScanMs, firstScanMs, watching, watchedFolders: watchers.size, pollMs: cfg.pollMs, loaded, ...counters,
    }),
  };
  return api;
}

module.exports = { createStore, SKIP_DIRS };
