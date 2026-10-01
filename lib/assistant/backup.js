"use strict";
/**
 * Backup before the assistant writes, and Undo.
 *
 * Before anything is written, the notes that will be MODIFIED are saved:
 *   - "git": MEMORY_DIR is inside a git work tree and those notes are tracked → a snapshot commit of
 *     exactly those paths (`git commit -- <paths>`, other staged work untouched; hooks and signing
 *     off; author "memglow"). If they are already committed and clean, HEAD is the snapshot.
 *   - "copy": otherwise (or assistant.backup = "copy") → a copy in <dataDir>/backups/<stamp>-<job>/.
 * Every git call is `git` with an argument array, never a shell. The snapshot is then READ BACK and
 * compared with the files; any failure throws, and the caller writes nothing.
 *
 * Every backup also gets <dataDir>/backups/<stamp>-<job>/job.json: what was created and modified,
 * with content hashes, so a manual restore stays possible after a restart.
 *
 * Undo restores the modified notes from the backup and removes the created ones — but only the
 * files that are still exactly as the assistant left them (same hash); a file changed since is
 * skipped and reported, never overwritten.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const KEEP = 30;
const sha = (s) => crypto.createHash("sha256").update(s == null ? "\0missing" : s).digest("hex");

function git(cwd, args, opts = {}) {
  return execFileSync("git", ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: opts.encoding === null ? null : "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, windowsHide: true, shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readOrNull(f) {
  try { return fs.readFileSync(f, "utf8"); } catch { return null; }
}

/** True if MEMORY_DIR is inside a git work tree (and git is installed). */
function inGitRepo(memoryDir) {
  try { return git(memoryDir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}

function stamp(t = Date.now()) {
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function recordDir(dataDir, jobId) {
  if (!dataDir) throw new Error("no data folder for backups (MEMGLOW_DATA_DIR)");
  const root = path.join(dataDir, "backups");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, stamp() + "-" + jobId);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function prune(dataDir) {
  try {
    const root = path.join(dataDir, "backups");
    const all = fs.readdirSync(root).filter((n) => /^\d{8}T\d{6}Z-[a-f0-9]+$/.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

/**
 * Saves the notes about to be modified. `files` = [{ rel, kind, beforeHash }]. → backup
 * { kind: "git" | "copy", ref?, dir }. Throws on any failure (then nothing may be written).
 */
function create({ memoryDir, dataDir, jobId, files, mode = "auto" }) {
  const modified = files.filter((f) => f.kind === "modify");
  for (const f of modified) {
    const now = readOrNull(path.join(memoryDir, f.rel));
    if (now == null || sha(now) !== f.beforeHash) throw new Error(`${f.rel} changed since the proposal`);
  }
  const dir = recordDir(dataDir, jobId);
  let backup = null;
  if (mode !== "copy" && inGitRepo(memoryDir)) {
    try {
      const rels = modified.map((f) => f.rel);
      for (const r of rels) git(memoryDir, ["ls-files", "--error-unmatch", "--", r]);
      if (rels.length) {
        git(memoryDir, ["add", "--", ...rels]);
        let dirty = false;
        try { git(memoryDir, ["diff", "--cached", "--quiet", "--", ...rels]); } catch { dirty = true; }
        if (dirty) git(memoryDir, ["-c", "user.name=memglow", "-c", "user.email=memglow@localhost", "commit", "--no-verify", "-q", "-m", `memglow: snapshot before assistant job ${jobId}`, "--", ...rels]);
      }
      const ref = git(memoryDir, ["rev-parse", "HEAD"]).trim();
      if (!/^[0-9a-f]{40,64}$/.test(ref)) throw new Error("no commit");
      for (const f of modified) {
        const saved = git(memoryDir, ["show", `${ref}:./${f.rel}`]);
        if (sha(saved) !== f.beforeHash) throw new Error(`snapshot of ${f.rel} does not match`);
      }
      backup = { kind: "git", ref, dir };
    } catch (e) {
      if (mode === "git") { fs.rmSync(dir, { recursive: true, force: true }); throw new Error("git snapshot failed: " + e.message.split("\n")[0].slice(0, 200)); }
      backup = null; // auto: fall back to a copy
    }
  }
  if (!backup) {
    try {
      for (const f of modified) {
        const src = path.join(memoryDir, f.rel);
        const dst = path.join(dir, "files", f.rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        if (sha(fs.readFileSync(dst, "utf8")) !== f.beforeHash) throw new Error(`copy of ${f.rel} does not match`);
      }
      backup = { kind: "copy", dir };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error("backup failed: " + e.message.slice(0, 200));
    }
  }
  prune(dataDir);
  return backup;
}

/** Writes job.json next to the backup (what was created/modified, with hashes). */
function record(backup, job) {
  try { fs.writeFileSync(path.join(backup.dir, "job.json"), JSON.stringify(job, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
}

function savedContent(memoryDir, backup, rel) {
  if (backup.kind === "git") return git(memoryDir, ["show", `${backup.ref}:./${rel}`]);
  return fs.readFileSync(path.join(backup.dir, "files", rel), "utf8");
}

/** Atomic write: temporary file in the same folder, then rename (or link, for a new file). */
function writeAtomic(file, content, { create = false } = {}) {
  const tmp = path.join(path.dirname(file), `.memglow-${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, content, { flag: "wx" });
  try {
    if (create) fs.linkSync(tmp, file); // fails if the file appeared meanwhile: never overwrite
    else fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed */ }
  }
}

/**
 * Undo. `changes` = [{ rel, kind, afterHash }]. → { restored: [rel], removed: [rel], skipped: [{ rel, why }] }
 */
function undo({ memoryDir, backup, changes }) {
  const out = { restored: [], removed: [], skipped: [] };
  for (const c of changes) {
    const file = path.join(memoryDir, c.rel);
    const now = readOrNull(file);
    if (now == null || sha(now) !== c.afterHash) { out.skipped.push({ rel: c.rel, why: now == null ? "missing" : "changed since" }); continue; }
    try {
      if (c.kind === "create") { fs.unlinkSync(file); out.removed.push(c.rel); }
      else { writeAtomic(file, savedContent(memoryDir, backup, c.rel)); out.restored.push(c.rel); }
    } catch (e) {
      out.skipped.push({ rel: c.rel, why: "error: " + String(e.code || e.message).slice(0, 80) });
    }
  }
  return out;
}

module.exports = { create, record, undo, writeAtomic, inGitRepo, sha };
