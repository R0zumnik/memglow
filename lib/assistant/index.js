"use strict";
/**
 * memglow's optional assistant — "the AI proposes, memglow applies".
 *
 *   1. propose(noteId)  the chosen provider (lib/assistant/providers) gets the note in its prompt,
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
const backup = require("./backup");
const { diffLines } = require("./diff");
const { looksSecret, maskSecrets } = require("../memory");
const archive = require("../archive");
const { dayOf } = require("../cost");

const TOKEN_TTL = 2 * 60 * 1000;
const PROPOSAL_TTL = 30 * 60 * 1000;
const STARTS_MAX = 6;            // provider runs per 10 minutes
const STARTS_WINDOW = 10 * 60 * 1000;
const HISTORY = 5;               // applied jobs kept for Undo
const EXTRA_MAX = 1000;          // characters of optional user instructions
const ARCHIVE_KEYS_MAX = 100;    // sections in one archive proposal

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function createAssistant({ config, memory, dataDir, env = process.env, fetchImpl, costItem, archiveReport = () => null, groupName = (t) => t, log = (m) => console.log("[memglow] assistant " + m) }) {
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

  /** Why memglow cannot write anything for the user here, whatever the AI (null = it can). */
  function blockedWrite() {
    if (keyInConfig) return keyInConfig;
    if (!config.showBodies) return "MEMGLOW_SHOW_BODIES is false: the assistant needs to show you the exact changes before anything is written.";
    if (!dataDir) return "No data folder: memglow needs MEMGLOW_DATA_DIR (outside the notes) for backups.";
    return null;
  }
  /** Why the assistant cannot run here (null = it can). */
  function blocked(p = provider) {
    const w = blockedWrite();
    if (w) return w;
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
      id: j.id, kind: j.kind || "split", archive: j.archive || null, keep: j.keep || [],
      state: j.state, note: j.note, provider: j.provider, startedAt: j.startedAt, finishedAt: j.finishedAt || null,
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
      archive: { ready: !blockedWrite(), reason: blockedWrite() || "" },
      history: history.map((j) => ({ id: j.id, kind: j.kind || "split", note: j.note, finishedAt: j.finishedAt, state: j.state, undo: j.undo || null, files: (j.changes || []).map((c) => ({ rel: c.rel, kind: c.kind })) })),
    };
  }
  function setState(j, state, extra = {}) {
    Object.assign(j, extra, { state });
    emit({ type: "job", job: publicJob(j) });
  }
  function busy() { return !!(job && (job.state === "running" || job.state === "applying")); }

  /** Starts a proposal for one note. → { ok, job } | { ok: false, code, error } */
  function propose(noteId, { extra = "", provider: wanted = "" } = {}) {
    // The panel may pick another provider than the configured one: only a known, ready one.
    const prov = wanted ? providers.get(String(wanted)) : provider;
    if (!prov) return { ok: false, code: 400, error: "Unknown provider." };
    const why = blocked(prov);
    if (why) return { ok: false, code: 503, error: why };
    if (busy()) return { ok: false, code: 409, error: "The assistant is already working." };
    const item = typeof noteId === "string" ? costItem(noteId) : null;
    const meta = item ? memory.note(noteId, { withBody: false }) : null;
    const rel = meta ? memory.fileOf(noteId) : null;
    if (!item || !meta || !rel) return { ok: false, code: 404, error: "This note is not one Memory cost suggests splitting." };
    const now = Date.now();
    while (starts.length && now - starts[0] > STARTS_WINDOW) starts.shift();
    if (starts.length >= STARTS_MAX) return { ok: false, code: 429, error: "Too many requests: try again in a few minutes." };
    starts.push(now);
    let req;
    try {
      req = proposal.buildRequest({
        memoryDir: config.memoryDir,
        note: { id: meta.id, rel, label: meta.label, theme: meta.theme, subtheme: meta.subtheme, folder: meta.folder },
        incoming: meta.incoming.map((id) => ({ id, rel: memory.fileOf(id) })).filter((x) => x.rel),
        existingIds: memory.ids(),
        item, extra: String(extra || "").slice(0, EXTRA_MAX), chunkTokens: config.splitChunkTokens, groupName: groupName(meta.theme),
      });
    } catch (e) {
      return { ok: false, code: 500, error: "Cannot read the note." };
    }
    const j = { id: crypto.randomBytes(8).toString("hex"), state: "running", note: { id: meta.id, label: meta.label }, provider: prov.id, startedAt: now, chars: 0, req };
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
        try { v = proposal.validate(obj, req.ctx, { allowMissingLines: ac.allowMissingLines || 0 }); } catch (e) { v = { ok: false, errors: ["validation error: " + e.message.slice(0, 200)], warnings: [] }; }
        if (!v.ok) { log(`${j.id}: proposal refused (${v.errors.length} problem(s)) after ${secs} s`); return setState(j, "invalid", { errors: v.errors.slice(0, 20), warnings: v.warnings }); }
        j.files = v.files;
        log(`${j.id}: proposal ready (${v.files.length} file(s)) after ${secs} s`);
        setState(j, "proposed", { proposedAt: Date.now(), publicFiles: publicFiles(v.files), gain: v.gain, warnings: v.warnings, notes: v.notes });
      });
    return { ok: true, job: publicJob(j) };
  }

  // ---- archive tier (lib/archive.js) ----

  function noteInfo(id) {
    const rel = memory.fileOf(id);
    const n = rel ? memory.note(id, { withBody: false }) : null;
    return n ? { id: n.id, rel, theme: n.theme, label: n.label } : null;
  }
  function startOk() {
    const now = Date.now();
    while (starts.length && now - starts[0] > STARTS_WINDOW) starts.shift();
    if (starts.length >= STARTS_MAX) return false;
    starts.push(now);
    return true;
  }

  /**
   * Proposal to archive dormant sections. `keys` = sections chosen in Memory cost, taken ONLY from
   * the current dormancy report. Without `ai`, memglow builds the move at once (deterministic: it is
   * a verbatim move, no judgement needed). With `ai`, the provider first REVIEWS the list (titles,
   * sizes, last read day, a few lines of each, secrets masked) and answers which ones to archive;
   * memglow then builds the move itself — the AI never writes any file content.
   */
  function proposeArchive(keys, { ai = false, provider: wanted = "" } = {}) {
    const w = blockedWrite();
    if (w) return { ok: false, code: 503, error: w };
    if (busy()) return { ok: false, code: 409, error: "The assistant is already working." };
    if (!Array.isArray(keys) || !keys.length || keys.length > ARCHIVE_KEYS_MAX || keys.some((k) => typeof k !== "string" || !/^[0-9a-f]{16}$/.test(k))) {
      return { ok: false, code: 400, error: "Choose at least one section." };
    }
    let rep = null;
    try { rep = archiveReport(); } catch { rep = null; }
    if (!rep || !rep.available) return { ok: false, code: 409, error: rep && rep.reason ? "Archive: " + rep.reason + "." : "No dormant section to archive." };
    const byKey = new Map(rep.sections.map((x) => [x.key, x]));
    const chosen = [...new Set(keys)].map((k) => byKey.get(k));
    if (chosen.some((x) => !x)) return { ok: false, code: 409, error: "A section is no longer dormant, or changed: refresh Memory cost and choose again." };
    let prov = null;
    if (ai) {
      prov = wanted ? providers.get(String(wanted)) : provider;
      if (!prov) return { ok: false, code: 400, error: "Unknown provider." };
      const why = blocked(prov);
      if (why) return { ok: false, code: 503, error: why };
    }
    if (!startOk()) return { ok: false, code: 429, error: "Too many requests: try again in a few minutes." };
    const now = Date.now();
    const j = { id: crypto.randomBytes(8).toString("hex"), kind: "archive", state: "running", note: { id: "", label: chosen.length + " dormant section" + (chosen.length === 1 ? "" : "s") }, provider: prov ? prov.id : "", startedAt: now, chars: 0 };
    if (job && job.state === "proposed") tokens.delete(job.id);
    job = j;
    log(`${j.id}: archive proposal requested (${chosen.length} section(s), ${prov ? "provider " + prov.id : "no AI"})`);
    if (!prov) { finishArchive(j, chosen, [], ""); return { ok: true, job: publicJob(j) }; }

    const items = chosen.map((section, i) => ({ id: "s" + (i + 1), section }));
    const excerpt = (x) => {
      const body = memory.rawBody(x.note);
      const b = body == null ? null : archive.blocksOf(body).find((y) => archive.keyOf(x.note, y.text) === x.key);
      if (!b) return "";
      return maskSecrets(b.text.split("\n").slice(1).filter((l) => l.trim()).slice(0, 6).join("\n")).slice(0, 600);
    };
    const req = archive.buildSelectionRequest(items, excerpt);
    j.abort = new AbortController();
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
        if (j.state !== "running") return;
        if (!r.ok) { log(`${j.id}: provider failed`); return setState(j, j.abort.signal.aborted ? "cancelled" : "failed", { error: r.error || "failed" }); }
        let obj;
        try { obj = proposal.parseAnswer(r.text); } catch (e) { return setState(j, "invalid", { errors: [e.message] }); }
        const v = archive.validateSelection(obj, new Map(items.map((i) => [i.id, i.section])));
        const keep = v.keep.map((k) => ({ note: k.section.note, label: k.section.label, title: k.section.title, why: k.why }));
        if (!v.ok) { log(`${j.id}: archive review refused (${v.errors.length} problem(s))`); return setState(j, "invalid", { errors: v.errors.slice(0, 20), keep, notes: v.notes || "" }); }
        finishArchive(j, v.chosen, keep, v.notes);
      });
    return { ok: true, job: publicJob(j) };
  }

  /** Builds and checks the exact files (lib/archive.js), then shows them. Nothing is written here. */
  function finishArchive(j, chosen, keep, notes) {
    const mem = config.memoryDir;
    let plan;
    try {
      plan = archive.planArchive({
        memoryDir: mem, picks: chosen.map((x) => ({ note: x.note, key: x.key })), settings: config.archive, themes: config.themes,
        today: dayOf(Date.now()), noteInfo, existingIds: memory.ids(),
      });
    } catch (e) { plan = { ok: false, errors: ["cannot prepare the archive: " + String(e.message).slice(0, 200)] }; }
    if (plan.ok) {
      const errs = archive.checkArchivePlan({ files: plan.files, moved: plan.moved, memoryDir: mem, noteTheme: (id) => (noteInfo(id) || {}).theme, knownIds: memory.ids() });
      if (errs.length) plan = { ok: false, errors: errs };
    }
    j.finishedAt = Date.now();
    if (!plan.ok) { log(`${j.id}: archive plan refused (${plan.errors.length} problem(s))`); return setState(j, "invalid", { errors: plan.errors.slice(0, 20), keep, notes }); }
    j.files = plan.files;
    j.moved = plan.moved;
    log(`${j.id}: archive proposal ready (${plan.moved.length} section(s), ${plan.files.length} file(s))`);
    setState(j, "proposed", {
      proposedAt: Date.now(), publicFiles: publicFiles(plan.files), keep, notes: notes || "", warnings: [],
      archive: {
        moved: plan.moved.map((m) => ({ note: m.note, heading: maskLine(m.heading), archive: m.archive, tokens: m.tokens })),
        gain: plan.gain,
      },
    });
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
    // Nothing changed since the proposal?
    for (const f of j.files) {
      let now = null;
      try { now = fs.readFileSync(path.join(mem, f.rel), "utf8"); } catch { /* missing */ }
      const ok = f.kind === "create" ? now == null : now != null && backup.sha(now) === f.beforeHash;
      if (!ok) { setState(j, "failed", { error: `${f.rel} changed since the proposal: nothing was written. Ask again.` }); return { ok: false, code: 409, error: j.error }; }
      const r = path.relative(path.resolve(mem), path.resolve(mem, f.rel));
      if (!r || r.startsWith("..") || path.isAbsolute(r)) { setState(j, "failed", { error: "A file is outside the notes folder: nothing was written." }); return { ok: false, code: 409, error: j.error }; }
    }
    // An archive plan is checked once more, right before writing (lib/archive.js checkArchivePlan).
    if (j.kind === "archive") {
      const errs = archive.checkArchivePlan({ files: j.files, moved: j.moved || [], memoryDir: mem, noteTheme: (id) => (noteInfo(id) || {}).theme, knownIds: memory.ids() });
      if (errs.length) { setState(j, "failed", { error: "Nothing was written: " + errs[0] }); return { ok: false, code: 409, error: j.error }; }
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
    try {
      for (const f of j.files) {
        const file = path.join(mem, f.rel);
        if (f.kind === "create") fs.mkdirSync(path.dirname(file), { recursive: true }); // e.g. the archive folder
        backup.writeAtomic(file, f.after, { create: f.kind === "create" });
        written.push(f);
      }
    } catch (e) {
      // Roll back what was written; the backup stays.
      for (const f of written.reverse()) {
        try {
          const file = path.join(mem, f.rel);
          if (f.kind === "create") fs.unlinkSync(file); else backup.writeAtomic(file, f.before);
        } catch { /* reported below */ }
      }
      log(`${j.id}: write failed, rolled back`);
      setState(j, "failed", { error: "Writing failed (" + (e.code || "error") + "); the changes were rolled back.", backup: b });
      return { ok: false, code: 500, error: j.error };
    }
    j.changes = j.files.map((f) => ({ rel: f.rel, kind: f.kind, afterHash: backup.sha(f.after).toString() }));
    backup.record(b, { job: j.id, note: j.note.id, provider: j.provider, at: new Date().toISOString(), backup: { kind: b.kind, ref: b.ref || null }, changes: j.changes.map((c) => ({ ...c, beforeHash: (j.files.find((f) => f.rel === c.rel) || {}).beforeHash })) });
    j.files = j.files.map((f) => ({ rel: f.rel, kind: f.kind })); // drop contents from memory
    j.req = null;
    j.moved = null;
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

  return { status, propose, proposeArchive, confirm, apply, undo, cancel, subscribe, _tokens: tokens };
}

module.exports = { createAssistant, TOKEN_TTL, PROPOSAL_TTL };
