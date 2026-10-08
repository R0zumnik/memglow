"use strict";
/**
 * memglow memory server — the only code that changes files under the root (phase B).
 *
 *  - ONE queue: every write operation runs alone, in arrival order (no lost update between two
 *    edits of the same note). Reads never wait for it: they run on the in-memory store, and a
 *    file is replaced atomically, so a reader sees the old or the new version, never half.
 *  - Confinement: every path is relative to the root, without ".", ".." or dot-segments; the
 *    deepest existing folder on the way (symlinks resolved) must be inside the root's real path.
 *  - Atomic write: a temporary dot-file in the same folder, written, fsync'd, renamed over the
 *    target, then the folder fsync'd (`fsync: false` skips both fsyncs: still atomic, but a power
 *    cut may lose the last writes — for very slow disks). A failure at any step removes the temporary file and leaves
 *    the previous version intact. A new note is linked into place (never replaces a file that
 *    appeared in the meantime).
 *  - Mode and owner: an existing file keeps its mode (or `fileMode` when given); when running as
 *    root, a file or folder created gets the owner of the folder it is created in (so a container
 *    running as root keeps files owned by the share's user, e.g. 1045:100 on a Synology).
 *  - Nothing is ever deleted: delete_note moves files to `<root>/.trash/<timestamp>/…`, which the
 *    store and the search never see (dot-folder).
 *  - Optional `onWrite` command, run (shell) after writes, debounced, never blocking a write: a
 *    snapshot hook (e.g. a git commit of the notes).
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { SKIP_DIRS } = require("../lib/store/store");

const TEMP_RE = /^\.mg-[0-9a-f]{8}\.tmp$/;
const OLD_TEMP_RE = /^\..+\.memglow-tmp-\d+-[0-9a-f]{10}$/;

/**
 * A startup warning when the server's user is not the owner of the notes folder (and not root):
 * every file it rewrites would then become owned by the server's user.
 */
function ownershipWarning(rootStat, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  if (uid == null || uid === 0 || !rootStat || rootStat.uid === uid) return null;
  return `memglow memory server: warning: running as uid ${uid} but the notes folder belongs to uid ${rootStat.uid}:${rootStat.gid} — files it rewrites will belong to uid ${uid}. Run it as the folder's owner (e.g. 1045:100 on the NAS) or as root (it then gives new files the folder's owner).`;
}

class WriteError extends Error {
  constructor(message, code) { super(message); this.code = code || "WRITE_FAILED"; }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // keeps a BOM: it is written back
const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

function createWriter({ store, fsync = true, fileMode = null, maxFileBytes = 4 * 1024 * 1024, onWrite = "", onWriteDelayMs = 10000, log = () => {}, hooks = {}, chownToParent = isRoot() }) {
  const root = store.root;
  const realRoot = () => store.realRoot();
  let tail = Promise.resolve();
  let depth = 0;
  const counters = { writes: 0, failed: 0, lastWriteAt: 0 };

  /** Runs `fn` alone (after every write queued before it). Returns its promise. */
  function run(fn) {
    depth++;
    const p = tail.then(() => fn());
    tail = p.then(() => { depth--; }, () => { depth--; });
    return p;
  }

  // ---- paths ----

  const inside = (real) => real === realRoot() || real.startsWith(realRoot() + path.sep);

  /**
   * A project-relative path → its cleaned form ("a/b/c.md"), or a WriteError when it would leave
   * the root or go through a dot/system folder. `allowEmpty`: "" (the root itself) accepted.
   */
  function cleanRel(input, { allowEmpty = false } = {}) {
    const s = String(input == null ? "" : input);
    if (s.includes("\0")) throw new WriteError(`Path '${s}' is not allowed`, "PATH_NOT_ALLOWED");
    const parts = s.replace(/^memory:\/\//i, "").replace(/\\/g, "/").split("/").filter((x) => x !== "");
    for (const seg of parts) {
      if (seg === "." || seg === ".." || seg.startsWith(".") || SKIP_DIRS.has(seg) || /[\r\n]/.test(seg)) {
        throw new WriteError(`Path '${s}' is not allowed - paths must stay within project boundaries`, "PATH_NOT_ALLOWED");
      }
    }
    const rel = parts.join("/");
    if (!rel && !allowEmpty) throw new WriteError(`Path '${s}' is not allowed`, "PATH_NOT_ALLOWED");
    const abs = path.resolve(root, rel);
    if (rel && !abs.startsWith(path.resolve(root) + path.sep)) throw new WriteError(`Path '${s}' is not allowed - paths must stay within project boundaries`, "PATH_NOT_ALLOWED");
    return rel;
  }

  /**
   * A cleaned path whose segments reuse existing entries that differ only by Unicode
   * normalisation or by case (a folder created in NFD by a Mac over SMB, "Alice.md" next to an
   * existing "alice.md" — the same name to a case-insensitive SMB client) instead of creating a
   * twin; a new segment is written in NFC.
   */
  function canonicalRel(input) {
    const parts = cleanRel(input).split("/");
    let dirAbs = root;
    const out = [];
    for (const seg of parts) {
      let name = seg;
      let entries = null;
      try { entries = fs.readdirSync(dirAbs); } catch { entries = null; }
      if (!entries || !entries.includes(seg)) {
        const want = seg.normalize("NFC");
        const lower = want.toLowerCase();
        const hit = entries ? (entries.find((e) => e.normalize("NFC") === want) || entries.find((e) => e.normalize("NFC").toLowerCase() === lower)) : null;
        name = hit || want;
      }
      out.push(name);
      dirAbs = path.join(dirAbs, name);
    }
    return out.join("/");
  }

  /** The deepest existing ancestor of `abs` (itself included) must resolve inside the root. */
  async function checkAncestors(abs) {
    let cur = abs;
    for (;;) {
      let real = null;
      try { real = await fsp.realpath(cur); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
      if (real != null) {
        if (!inside(real)) throw new WriteError("Path is not allowed: it resolves outside the project", "PATH_NOT_ALLOWED");
        return { existing: cur, real };
      }
      const up = path.dirname(cur);
      if (up === cur) throw new WriteError("Path is not allowed", "PATH_NOT_ALLOWED");
      cur = up;
    }
  }

  /**
   * A target file: { rel, abs, stat|null, linkAbs, isLink }. Content is written through an
   * existing symlink to its real file (which must be a regular file inside the root); a move or a
   * delete acts on the link itself (`linkAbs`).
   */
  async function target(rel) {
    const clean = cleanRel(rel);
    const abs = path.join(root, clean);
    const { existing, real } = await checkAncestors(abs);
    if (existing === abs) {
      const st = await fsp.stat(real);
      if (!st.isFile()) throw new WriteError(`'${clean}' exists and is not a file`, "NOT_A_FILE");
      const isLink = (await fsp.lstat(abs)).isSymbolicLink();
      return { rel: clean, abs: real, stat: st, linkAbs: abs, isLink };
    }
    return { rel: clean, abs, stat: null, linkAbs: abs, isLink: false };
  }

  /** Creates the missing folders of `absDir` one by one (owner = parent's when running as root). */
  async function mkdirs(absDir) {
    await checkAncestors(absDir);
    const missing = [];
    let cur = absDir;
    while (!fs.existsSync(cur)) { missing.unshift(cur); const up = path.dirname(cur); if (up === cur) break; cur = up; }
    for (const d of missing) {
      try { await fsp.mkdir(d); } catch (e) { if (e.code !== "EEXIST") throw e; }
      await ownLikeParent(d);
      await groupWriteLikeParent(d);
    }
    const { real } = await checkAncestors(absDir);
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new WriteError(`'${path.relative(root, absDir)}' is not a folder`, "NOT_A_FOLDER");
  }

  async function fsyncDir(dir) {
    if (!fsync) return;
    let fh = null;
    try { fh = await fsp.open(dir, "r"); await fh.sync(); } catch { /* not supported everywhere: best effort */ }
    finally { if (fh) await fh.close().catch(() => {}); }
  }

  async function readText(abs) {
    const buf = await fsp.readFile(abs);
    try { return utf8.decode(buf); } catch { throw new WriteError("the note is not valid UTF-8; it was not changed", "NOT_UTF8"); }
  }

  const sameFile = (a, b) => !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

  /**
   * Writes `text` to `abs` atomically. `prev` = the stat the caller based its change on (null for
   * a new file). Throws WriteError CHANGED_ON_DISK when the file changed under us (an editor):
   * the caller re-reads and retries. Returns the new stat.
   */
  async function writeAtomic(abs, text, prev) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxFileBytes) throw new WriteError(`the note would be too large (${bytes} bytes > ${maxFileBytes})`, "TOO_LARGE");
    const dir = path.dirname(abs), base = path.basename(abs);
    await mkdirs(dir);
    // A short temp name (any name the target can have, the temp can have too).
    const tmp = path.join(dir, `.mg-${crypto.randomBytes(4).toString("hex")}.tmp`);
    let fh = null, linked = false;
    try {
      fh = await fsp.open(tmp, "wx", 0o666);
      await fh.writeFile(text, "utf8");
      if (hooks.afterTmpWrite) await hooks.afterTmpWrite(tmp, abs);
      if (fileMode != null) await fh.chmod(fileMode);
      else if (prev) await fh.chmod(prev.mode & 0o7777);
      if (chownToParent) {
        try {
          const owner = prev || await fsp.stat(dir);
          await fh.chown(owner.uid, owner.gid);
        } catch (e) { log(`memglow memory server: chown ${abs}: ${e.message}`); }
      }
      if (!prev) await groupWriteLikeParent(abs, fh);
      if (fsync) await fh.sync();
      await fh.close(); fh = null;
      if (hooks.beforeRename) await hooks.beforeRename(tmp, abs);
      if (prev) {
        let now = null;
        try { now = await fsp.stat(abs); } catch { /* gone */ }
        if (!sameFile(now, prev)) throw new WriteError("the note changed on disk while it was being edited", "CHANGED_ON_DISK");
        await fsp.rename(tmp, abs);
      } else {
        // A new note never replaces a file: link (fails if the name exists), then drop the temp.
        try { await fsp.link(tmp, abs); linked = true; }
        catch (e) {
          if (e.code === "EEXIST") throw new WriteError("a file already exists at this path", "EXISTS");
          // No hard links here (some network filesystems): check, then rename.
          if (fs.existsSync(abs)) throw new WriteError("a file already exists at this path", "EXISTS");
          await fsp.rename(tmp, abs);
        }
        if (linked) await fsp.unlink(tmp).catch(() => {});
      }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    await fsyncDir(dir);
    return fsp.stat(abs);
  }

  /** Moves a file or folder; never replaces an existing target. */
  async function moveNoClobber(srcAbs, dstAbs, { directory = false } = {}) {
    await mkdirs(path.dirname(dstAbs));
    if (directory) {
      if (fs.existsSync(dstAbs)) throw new WriteError("a file or folder already exists at the destination", "EXISTS");
      await fsp.rename(srcAbs, dstAbs);
    } else {
      try { await fsp.link(srcAbs, dstAbs); await fsp.unlink(srcAbs); }
      catch (e) {
        if (e.code === "EEXIST") throw new WriteError("a file already exists at the destination", "EXISTS");
        if (fs.existsSync(dstAbs)) throw new WriteError("a file already exists at the destination", "EXISTS");
        await fsp.rename(srcAbs, dstAbs);
      }
    }
    await fsyncDir(path.dirname(dstAbs));
    if (path.dirname(srcAbs) !== path.dirname(dstAbs)) await fsyncDir(path.dirname(srcAbs));
  }

  /**
   * Running as root: a file or folder just created is group-writable when its parent folder is
   * (a share whose users write through the group keeps working). `fh` = an open handle, or null.
   */
  async function groupWriteLikeParent(p, fh = null) {
    if (!chownToParent || fileMode != null) return;
    try {
      const ps = await fsp.stat(path.dirname(p));
      if (!(ps.mode & 0o020)) return;
      const st = fh ? await fh.stat() : await fsp.stat(p);
      if (st.mode & 0o020) return;
      if (fh) await fh.chmod((st.mode & 0o7777) | 0o020); else await fsp.chmod(p, (st.mode & 0o7777) | 0o020);
    } catch (e) { log(`memglow memory server: chmod ${p}: ${e.message}`); }
  }

  /** Running as root: give a file or folder just created the owner of its parent folder. */
  async function ownLikeParent(p) {
    if (!chownToParent) return;
    try { const ps = await fsp.stat(path.dirname(p)); await fsp.chown(p, ps.uid, ps.gid); } catch (e) { log(`memglow memory server: chown ${p}: ${e.message}`); }
  }

  /** A fresh trash folder for one delete: "<root>/.trash/<timestamp>[-n]" (rel form returned). */
  async function trashFolder() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trashRoot = path.join(root, ".trash");
    try { await fsp.mkdir(trashRoot); await ownLikeParent(trashRoot); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const lst = await fsp.lstat(trashRoot);
    if (!lst.isDirectory()) throw new WriteError("the trash folder (.trash) is not a plain folder", "TRASH_UNAVAILABLE");
    for (let i = 0; i < 1000; i++) {
      const name = i ? `${stamp}-${i}` : stamp;
      try { await fsp.mkdir(path.join(trashRoot, name)); await ownLikeParent(path.join(trashRoot, name)); return ".trash/" + name; }
      catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    throw new WriteError("could not create a trash folder", "TRASH_UNAVAILABLE");
  }

  /** Copies a file's current version into a fresh trash folder (before an overwrite). */
  async function backupToTrash(abs, rel) {
    const trash = await trashFolder();
    const dst = path.join(root, trash, rel);
    await mkdirs(path.dirname(dst));
    await fsp.copyFile(abs, dst, fs.constants.COPYFILE_EXCL);
    if (chownToParent) {
      try { const st = await fsp.stat(abs); await fsp.chown(dst, st.uid, st.gid); } catch (e) { log(`memglow memory server: chown ${dst}: ${e.message}`); }
    }
    return trash + "/" + rel;
  }

  /** Moves a note file (abs, its rel) into `trashRel` keeping its relative path. */
  async function toTrash(abs, rel, trashRel) {
    const dst = path.join(root, trashRel, rel);
    await moveNoClobber(abs, dst);
    return trashRel + "/" + rel;
  }

  /**
   * Removes temp files a crash left behind (".mg-<8 hex>.tmp", and the older
   * ".<name>.memglow-tmp-<pid>-<hex>"), inside the root only, older than `minAgeMs`. Returns the
   * project-relative paths removed.
   */
  function cleanupTemps(minAgeMs = 60000) {
    const removed = [];
    const now = Date.now();
    const walk = (rel, depth) => {
      if (depth > 64) return;
      let entries;
      try { entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) { if (!e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(r, depth + 1); continue; }
        if (!e.isFile() || !(TEMP_RE.test(e.name) || OLD_TEMP_RE.test(e.name))) continue;
        try {
          const abs = path.join(root, r);
          if (now - fs.statSync(abs).mtimeMs < minAgeMs) continue;
          fs.unlinkSync(abs);
          removed.push(r);
        } catch { /* gone or not ours to remove */ }
      }
    };
    walk("", 0);
    if (removed.length) log(`memglow memory server: removed ${removed.length} temp file(s) left by an interrupted write`);
    return removed;
  }

  // ---- the on-write hook ----

  let hookTimer = null, hookFirstAt = 0, hookRunning = false, hookAgain = false;
  const hookChanged = new Set();
  function scheduleHook(rels) {
    if (!onWrite) return;
    for (const r of rels) hookChanged.add(r);
    if (hookRunning) { hookAgain = true; return; }
    const now = Date.now();
    if (!hookTimer) hookFirstAt = now;
    if (hookTimer) clearTimeout(hookTimer);
    // Trailing debounce, but never later than 6 × the delay after the first pending write.
    const wait = Math.max(0, Math.min(onWriteDelayMs, hookFirstAt + 6 * onWriteDelayMs - now));
    hookTimer = setTimeout(fireHook, wait);
    if (hookTimer.unref) hookTimer.unref();
  }
  function fireHook() {
    hookTimer = null;
    if (!onWrite || hookRunning) return;
    const files = [...hookChanged];
    hookChanged.clear();
    hookRunning = true;
    let child;
    try {
      child = spawn(onWrite, { shell: true, cwd: root, stdio: "ignore", env: { ...process.env, MEMGLOW_MEMORY_ROOT: root, MEMGLOW_CHANGED_FILES: files.join("\n") } });
    } catch (e) { hookRunning = false; log(`memglow memory server: on-write hook failed to start: ${e.message}`); return; }
    const killer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, 5 * 60000);
    if (killer.unref) killer.unref();
    const done = (code, err) => {
      clearTimeout(killer);
      hookRunning = false;
      if (err) log(`memglow memory server: on-write hook error: ${err.message}`);
      else if (code) log(`memglow memory server: on-write hook exited with code ${code}`);
      counters.hookRuns = (counters.hookRuns || 0) + 1;
      if (hookAgain || hookChanged.size) { hookAgain = false; scheduleHook([]); }
    };
    child.once("error", (e) => done(null, e));
    child.once("exit", (code) => done(code, null));
  }
  /** Runs a pending hook now (server shutdown). */
  function flushHook() {
    if (hookTimer) { clearTimeout(hookTimer); hookTimer = null; fireHook(); }
  }

  function wrote(rels) {
    counters.writes++;
    counters.lastWriteAt = Date.now();
    scheduleHook(rels);
  }

  return {
    run, cleanRel, canonicalRel, cleanupTemps, backupToTrash, target, checkAncestors, mkdirs, readText, writeAtomic, moveNoClobber, trashFolder, toTrash, wrote,
    flushHook, fail: () => { counters.failed++; },
    /** Resolves when every write queued so far is done (shutdown). */
    idle: () => tail,
    stats: () => ({ ...counters, queued: depth, onWrite: !!onWrite }),
  };
}

module.exports = { createWriter, WriteError, ownershipWarning, TEMP_RE };
