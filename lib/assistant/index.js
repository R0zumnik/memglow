"use strict";
/**
 * memglow's optional assistant — "the AI proposes, memglow applies".
 *
 *   1. propose(noteId)  (or proposeRegroup(suggestionId), lib/assistant/regroup.js) the chosen provider (lib/assistant/providers) gets the note in its prompt,
 *                       with NO tool, and answers with a JSON proposal (lib/assistant/proposal.js);
 *   2. memglow validates it and computes the exact diff of every file (lib/assistant/diff.js);
 *   3. confirm(jobId)   the "Apply" button asks for a one-time confirmation token (random 256 bits,
 *                       2 minutes, single use, bound to this proposal; only its hash is kept);
 *   4. apply(jobId, t)  checks the token, checks that no file changed since the proposal, backs up
 *                       (lib/assistant/backup.js: git snapshot or copy) — if the backup fails nothing
 *                       is written — then writes atomically;
 *   5. undo(jobId)      restores the backup (only the files still as memglow left them).
 *
 * One job at a time. Starts are rate limited. Logs carry ids, states and durations, never note
 * text nor the AI's answer. No HTTP here (server.js mounts the routes).
 */
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const providers = require("./providers");
const proposal = require("./proposal");
const regroup = require("./regroup");
const zonesLib = require("../zones");
const { themeResolver } = require("../memory");
const backup = require("./backup");
const { diffLines } = require("./diff");
const { looksSecret } = require("../memory");

const TOKEN_TTL = 2 * 60 * 1000;
const PROPOSAL_TTL = 30 * 60 * 1000;
const STARTS_MAX = 6;            // provider runs per 10 minutes
const STARTS_WINDOW = 10 * 60 * 1000;
const HISTORY = 5;               // applied jobs kept for Undo
const EXTRA_MAX = 1000;          // characters of optional user instructions

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function createAssistant({ config, memory, dataDir, env = process.env, fetchImpl, costItem, suggestion = () => null, protectedIds = () => [], groupName = (t) => t, log = (m) => console.log("[memglow] assistant " + m) }) {
  const resolver = themeResolver(config);
  // Protected groups, read at each request (the user may change them in Settings at any time).
  const zoneOpts = () => ({ resolver, protect: protectedIds() || [], name: groupName });
  const protectedLine = () => zonesLib.promptLine(protectedIds() || [], groupName);
  const ac = config.assistant || {};
  const provider = providers.get(ac.provider) || providers.get("claude-code");
  const workDir = dataDir ? path.join(dataDir, "assistant-work") : null;
  const ctxOf = (p = provider) => ({ config: providers.configFor(ac, p.id), env, dataDir, workDir, fetch: fetchImpl });
  // An API key written in memglow.config.json: refused (only its field name is ever shown).
  const keyInConfig = Array.isArray(ac.keyInConfig) && ac.keyInConfig.length
    ? "Refused: memglow.config.json contains " + ac.keyInConfig.join(", ") + ". Remove it — memglow reads an API key only from the environment variable MEMGLOW_ASSISTANT_API_KEY (or the one named in assistant.apiKeyEnv) or from the file assistant-api-key in its data folder (chmod 600)."
    : "";
  if (keyInConfig) log("disabled: an API key field is present in the config file (" + ac.keyInConfig.join(", ") + ")");
  let job = null;           // current job
  const history = [];       // applied jobs (newest first), for Undo
  const tokens = new Map(); // jobId → { hash, exp }
  const starts = [];
  const listeners = new Set();

  function emit(evt) { for (const f of listeners) { try { f(evt); } catch { /* a closed stream */ } } }
  function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }

  /** Why the assistant cannot run here (null = it can). */
  function blocked(p = provider) {
    if (keyInConfig) return keyInConfig;
    if (!config.showBodies) return "MEMGLOW_SHOW_BODIES is false: the assistant needs to show you the exact changes before anything is written.";
    if (!dataDir) return "No data folder: memglow needs MEMGLOW_DATA_DIR (outside the notes) for backups.";
    const d = p.detect(ctxOf(p));
    if (!p.implemented || !d.available) return d.reason || "This provider is not available.";
    return null;
  }

  function maskLine(s) { return looksSecret(s) ? "[line hidden: looks like a secret]" : s; }
  function publicFiles(files) {
    return files.map((f) => {
      const d = diffLines(f.before, f.after);
      return { rel: f.rel, kind: f.kind, role: f.role, added: d.added, removed: d.removed, hunks: d.hunks.map((h) => ({ lines: h.lines.map((l) => ({ t: l.t, s: maskLine(l.s) })) })) };
    });
  }
  function publicJob(j) {
    if (!j) return null;
    return {
      id: j.id, kind: j.kind || "split", target: j.target || "", state: j.state, note: j.note, provider: j.provider, startedAt: j.startedAt, finishedAt: j.finishedAt || null,
      chars: j.chars || 0, error: j.error || "", errors: j.errors || [], warnings: j.warnings || [], notes: j.notes || "",
      files: j.publicFiles || [], gain: j.gain || null, expiresAt: j.state === "proposed" ? j.proposedAt + PROPOSAL_TTL : null,
      backup: j.backup ? { kind: j.backup.kind, ref: j.backup.ref ? j.backup.ref.slice(0, 12) : "", dir: j.backup.kind === "copy" ? j.backup.dir : "" } : null,
      undo: j.undo || null,
    };
  }
  function status() {
    const why = blocked();
    return {
      enabled: true,
      available: !why,
      reason: why || "",
      provider: { id: provider.id, label: provider.label },
      providers: providers.list((id) => ctxOf(providers.get(id))),
      busy: !!(job && (job.state === "running" || job.state === "applying")),
      job: publicJob(job),
      history: history.map((j) => ({ id: j.id, kind: j.kind || "split", note: j.note, finishedAt: j.finishedAt, state: j.state, undo: j.undo || null, files: (j.changes || []).map((c) => ({ rel: c.rel, kind: c.kind })) })),
    };
  }
  function setState(j, state, extra = {}) {
    Object.assign(j, extra, { state });
    emit({ type: "job", job: publicJob(j) });
  }
  function busy() { return !!(job && (job.state === "running" || job.state === "applying")); }

  /** The provider asked for (the panel may pick another one than the configured one: only a known, ready one). */
  function pick(wanted) {
    const prov = wanted ? providers.get(String(wanted)) : provider;
    if (!prov) return { error: { ok: false, code: 400, error: "Unknown provider." } };
    const why = blocked(prov);
    if (why) return { error: { ok: false, code: 503, error: why } };
    if (busy()) return { error: { ok: false, code: 409, error: "The assistant is already working." } };
    return { prov };
  }
  function rateOk(now) {
    while (starts.length && now - starts[0] > STARTS_WINDOW) starts.shift();
    if (starts.length >= STARTS_MAX) return false;
    starts.push(now);
    return true;
  }

  /** Starts a proposal for one note. → { ok, job } | { ok: false, code, error } */
  function propose(noteId, { extra = "", provider: wanted = "" } = {}) {
    const { prov, error } = pick(wanted);
    if (error) return error;
    const item = typeof noteId === "string" ? costItem(noteId) : null;
    const meta = item ? memory.note(noteId, { withBody: false }) : null;
    const rel = meta ? memory.fileOf(noteId) : null;
    if (!item || !meta || !rel) return { ok: false, code: 404, error: "This note is not one Memory cost suggests splitting." };
    const now = Date.now();
    if (!rateOk(now)) return { ok: false, code: 429, error: "Too many requests: try again in a few minutes." };
    let req;
    try {
      req = proposal.buildRequest({
        memoryDir: config.memoryDir,
        note: { id: meta.id, rel, label: meta.label, theme: meta.theme, subtheme: meta.subtheme, folder: meta.folder },
        incoming: meta.incoming.map((id) => ({ id, rel: memory.fileOf(id) })).filter((x) => x.rel),
        existingIds: memory.ids(),
        item, extra: String(extra || "").slice(0, EXTRA_MAX), chunkTokens: config.splitChunkTokens, groupName: groupName(meta.theme),
        protectedLine: protectedLine(),
      });
    } catch (e) {
      return { ok: false, code: 500, error: "Cannot read the note." };
    }
    return start(prov, req, { kind: "split", target: meta.id, note: { id: meta.id, label: meta.label } }, now);
  }

  /**
   * Starts a regroup proposal for one organisation suggestion (lib/organise.js), by its id. Only the
   * notes memglow listed in that suggestion can be moved; only metadata is sent (no note body).
   */
  function proposeRegroup(suggestionId, { extra = "", provider: wanted = "" } = {}) {
    const { prov, error } = pick(wanted);
    if (error) return error;
    const s = typeof suggestionId === "string" ? suggestion(suggestionId) : null;
    if (!s) return { ok: false, code: 404, error: "This is not one of the current organisation suggestions." };
    const notes = [];
    for (const n of s.notes) {
      const meta = memory.note(n.id, { withBody: false });
      const rel = meta ? memory.fileOf(n.id) : null;
      if (!meta || !rel || meta.theme !== s.theme) return { ok: false, code: 409, error: "The notes changed since: reload Memory cost." };
      notes.push({ id: meta.id, rel, label: meta.label, description: meta.description, subtheme: meta.subtheme });
    }
    const now = Date.now();
    if (!rateOk(now)) return { ok: false, code: 429, error: "Too many requests: try again in a few minutes." };
    const all = memory.ids().map((id) => ({ id, rel: memory.fileOf(id) })).filter((x) => x.rel);
    // Folders of this group: the folders of its notes (the AI may only pick one of them).
    const folders = new Set();
    const subs = new Set();
    for (const n of memory.costNotes()) {
      if (n.theme !== s.theme) continue;
      folders.add(n.folder || "");
      if (n.subtheme) subs.add(n.subtheme);
    }
    let req;
    try {
      req = regroup.buildRequest({
        memoryDir: config.memoryDir, suggestion: s, notes, allNotes: all, folders: [...folders].sort(),
        groupName: groupName(s.theme), protectedLine: protectedLine(), extra: String(extra || "").slice(0, EXTRA_MAX),
        existingSubthemes: [...subs].sort(),
      });
    } catch (e) {
      return { ok: false, code: 500, error: "Cannot read the notes." };
    }
    return start(prov, req, { kind: "regroup", target: s.id, note: { id: s.id, label: s.notes.length + " notes about " + s.topic } }, now);
  }

  function start(prov, req, { kind, target, note }, now) {
    const j = { id: crypto.randomBytes(8).toString("hex"), kind, target, state: "running", note, provider: prov.id, startedAt: now, chars: 0, req };
    if (job && job.state === "proposed") tokens.delete(job.id);
    job = j;
    j.abort = new AbortController();
    log(`${j.id}: proposal requested (provider ${prov.id})`);
    emit({ type: "job", job: publicJob(j) });
    let lastEmit = 0;
    const timeoutMs = Math.max(1, Math.min(60, Number(ac.timeoutMinutes) || 10)) * 60 * 1000;
    Promise.resolve()
      .then(() => prov.run(ctxOf(prov), {
        system: req.system, prompt: req.prompt, signal: j.abort.signal, timeoutMs,
        onText(t) {
          j.chars += t.length;
          const n = Date.now();
          if (n - lastEmit > 300) { lastEmit = n; emit({ type: "progress", id: j.id, chars: j.chars }); }
        },
      }))
      .catch((e) => ({ ok: false, error: "provider error: " + String(e && e.message || e).slice(0, 200) }))
      .then((r) => {
        j.finishedAt = Date.now();
        const secs = ((j.finishedAt - j.startedAt) / 1000).toFixed(1);
        if (j.state !== "running") return; // cancelled meanwhile
        if (!r.ok) { log(`${j.id}: provider failed after ${secs} s`); return setState(j, j.abort.signal.aborted ? "cancelled" : "failed", { error: r.error || "failed" }); }
        let obj;
        try { obj = proposal.parseAnswer(r.text); } catch (e) { log(`${j.id}: answer rejected (not JSON) after ${secs} s`); return setState(j, "invalid", { errors: [e.message] }); }
        let v;
        try {
          v = req.kind === "regroup"
            ? regroup.validate(obj, req.ctx, { resolver, zone: zoneOpts() })
            : proposal.validate(obj, req.ctx, { allowMissingLines: ac.allowMissingLines || 0, zone: zoneOpts() });
        } catch (e) { v = { ok: false, errors: ["validation error: " + e.message.slice(0, 200)], warnings: [] }; }
        if (!v.ok) { log(`${j.id}: proposal refused (${v.errors.length} problem(s)) after ${secs} s`); return setState(j, "invalid", { errors: v.errors.slice(0, 20), warnings: v.warnings }); }
        j.files = v.files;
        log(`${j.id}: proposal ready (${v.files.length} file(s)) after ${secs} s`);
        setState(j, "proposed", { proposedAt: Date.now(), publicFiles: publicFiles(v.files), gain: v.gain, warnings: v.warnings, notes: v.notes });
      });
    return { ok: true, job: publicJob(j) };
  }

  function find(id) {
    if (job && job.id === id) return job;
    return history.find((j) => j.id === id) || null;
  }

  /** One-time confirmation token for applying the current proposal. */
  function confirm(id) {
    const j = find(id);
    if (!j || j.state !== "proposed") return { ok: false, code: 409, error: "There is no proposal to apply." };
    if (Date.now() - j.proposedAt > PROPOSAL_TTL) return { ok: false, code: 409, error: "This proposal expired: ask again." };
    const token = crypto.randomBytes(32).toString("hex");
    tokens.set(j.id, { hash: sha(token), exp: Date.now() + TOKEN_TTL });
    return { ok: true, token, expiresIn: TOKEN_TTL / 1000 };
  }

  function apply(id, token) {
    const j = find(id);
    const t = j ? tokens.get(j.id) : null;
    if (j) tokens.delete(j.id); // single use: consumed by any attempt, right or wrong
    if (!j || !t || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || !crypto.timingSafeEqual(sha(token), t.hash) || Date.now() > t.exp) {
      return { ok: false, code: 403, error: "Confirmation missing, wrong or expired: click Apply again." };
    }
    if (j.state !== "proposed") return { ok: false, code: 409, error: "There is no proposal to apply." };
    if (busy()) return { ok: false, code: 409, error: "The assistant is already working." };
    setState(j, "applying");
    const mem = config.memoryDir;
    // Protected groups may have changed since the proposal: check again.
    const zerr = zonesLib.checkFiles(j.files, zoneOpts());
    if (zerr.length) { setState(j, "failed", { error: "Refused by the protected groups, nothing was written: " + zerr[0] }); return { ok: false, code: 409, error: j.error }; }
    // Nothing changed since the proposal?
    for (const f of j.files) {
      let now = null;
      try { now = fs.readFileSync(path.join(mem, f.rel), "utf8"); } catch { /* missing */ }
      const ok = f.kind === "create" ? now == null : now != null && backup.sha(now) === f.beforeHash;
      if (!ok) { setState(j, "failed", { error: `${f.rel} changed since the proposal: nothing was written. Ask again.` }); return { ok: false, code: 409, error: j.error }; }
    }
    let b;
    try {
      b = backup.create({ memoryDir: mem, dataDir, jobId: j.id, files: j.files, mode: ac.backup || "auto" });
    } catch (e) {
      log(`${j.id}: backup failed, nothing written`);
      setState(j, "failed", { error: "Backup failed, nothing was written: " + e.message });
      return { ok: false, code: 500, error: j.error };
    }
    const written = [];
    // New files first, then changes, then old places of moved notes (removed only once their new
    // copy exists): a failure part-way never loses a note.
    const order = j.files.filter((f) => f.kind === "create").concat(j.files.filter((f) => f.kind === "modify"), j.files.filter((f) => f.kind === "delete"));
    try {
      for (const f of order) {
        const file = path.join(mem, f.rel);
        if (f.kind === "delete") fs.unlinkSync(file);
        else {
          if (f.kind === "create") fs.mkdirSync(path.dirname(file), { recursive: true });
          backup.writeAtomic(file, f.after, { create: f.kind === "create" });
        }
        written.push(f);
      }
    } catch (e) {
      // Roll back what was written; the backup stays.
      for (const f of written.reverse()) {
        try {
          const file = path.join(mem, f.rel);
          if (f.kind === "create") fs.unlinkSync(file);
          else if (f.kind === "delete") backup.writeAtomic(file, f.before, { create: true });
          else backup.writeAtomic(file, f.before);
        } catch { /* reported below */ }
      }
      log(`${j.id}: write failed, rolled back`);
      setState(j, "failed", { error: "Writing failed (" + (e.code || "error") + "); the changes were rolled back.", backup: b });
      return { ok: false, code: 500, error: j.error };
    }
    j.changes = j.files.map((f) => ({ rel: f.rel, kind: f.kind, afterHash: backup.sha(f.after).toString(), ...(f.movedTo ? { movedTo: f.movedTo } : {}) }));
    backup.record(b, { job: j.id, note: j.note.id, provider: j.provider, at: new Date().toISOString(), backup: { kind: b.kind, ref: b.ref || null }, changes: j.changes.map((c) => ({ ...c, beforeHash: (j.files.find((f) => f.rel === c.rel) || {}).beforeHash })) });
    j.files = j.files.map((f) => ({ rel: f.rel, kind: f.kind })); // drop contents from memory
    j.req = null;
    j.finishedAt = Date.now();
    history.unshift(j);
    if (history.length > HISTORY) history.pop();
    log(`${j.id}: applied (${j.changes.length} file(s), backup ${b.kind})`);
    setState(j, "applied", { backup: b });
    try { memory.scan(); } catch { /* the poller will see it */ }
    return { ok: true, job: publicJob(j) };
  }

  function undo(id) {
    const j = find(id);
    if (!j || j.state !== "applied" || !j.backup) return { ok: false, code: 409, error: "Nothing to undo." };
    if (busy()) return { ok: false, code: 409, error: "The assistant is already working." };
    const r = backup.undo({ memoryDir: config.memoryDir, backup: j.backup, changes: j.changes });
    log(`${j.id}: undo (${r.restored.length} restored, ${r.removed.length} removed, ${r.skipped.length} skipped)`);
    setState(j, "undone", { undo: r });
    try { memory.scan(); } catch { /* the poller will see it */ }
    return { ok: true, job: publicJob(j), undo: r };
  }

  function cancel(id) {
    const j = find(id);
    if (!j) return { ok: false, code: 409, error: "Nothing to cancel." };
    if (j.state === "running") {
      j.abort.abort();
      log(`${j.id}: cancelled`);
      setState(j, "cancelled", { error: "Cancelled." , finishedAt: Date.now() });
      return { ok: true };
    }
    if (j.state === "proposed" || j.state === "invalid" || j.state === "failed") {
      tokens.delete(j.id);
      setState(j, "discarded");
      return { ok: true };
    }
    return { ok: false, code: 409, error: "Nothing to cancel." };
  }

  return { label: provider.label, status, propose, proposeRegroup, confirm, apply, undo, cancel, subscribe, _tokens: tokens };
}

module.exports = { createAssistant, TOKEN_TTL, PROPOSAL_TTL };
