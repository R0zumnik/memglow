#!/usr/bin/env node
"use strict";
/**
 * memglow — a live 3D view of an AI assistant's Markdown memory.
 *
 *   MEMORY_DIR=./my-notes npx memglow        # then open http://127.0.0.1:4747
 *
 * Zero runtime dependencies (Node >= 18). See README.md for configuration and security.
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { loadConfig } = require("./lib/config");
const { createMemory } = require("./lib/memory");
const { createCounters, createWriteDedup } = require("./lib/counters");
const { computeCost, dayOf } = require("./lib/cost");
const view = require("./lib/view");
const { createAssistant } = require("./lib/assistant");
const zonesLib = require("./lib/zones");
const setupLib = require("./lib/setup");
const organise = require("./lib/organise");
const { measureFiles, alwaysLoadedCost } = require("./lib/always-loaded");
const archive = require("./lib/archive");
const { createFindTime } = require("./lib/find-time");
const { createEngineSpeed, cleanDuration } = require("./lib/engine-speed");

const PUBLIC = path.join(__dirname, "public");
// Interface languages shipped (public/i18n/<code>.json); must match lib/view.js SETTINGS.language
// and public/i18n.js SUPPORTED_LANGS (checked by a test).
const I18N_LANGS = ["en", "fr", "de", "es", "pt-BR", "ja", "ko", "zh-CN"];
const STATIC = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/cost.js": ["cost.js", "text/javascript; charset=utf-8"],
  "/zones.js": ["zones.js", "text/javascript; charset=utf-8"],
  "/setup.js": ["setup.js", "text/javascript; charset=utf-8"],
  "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
  "/vendor/memglow-graph.js": ["vendor/memglow-graph.js", "text/javascript; charset=utf-8"],
  ...Object.fromEntries(I18N_LANGS.map((code) => [`/i18n/${code}.json`, [`i18n/${code}.json`, "application/json; charset=utf-8"]])),
};
const STREAM_MAX = 20;
const ACTIVITY_MAX_BYTES = 4096;
const COST_SECTIONS_MAX = 40; // notes whose sections are listed in one /api/cost answer
const ASSIST_BODY_MAX = 8192;
const ASSIST_STREAM_MAX = 5;
const ASSIST_POSTS_PER_MIN = 30;
const SETUP_TESTS_PER_MIN = 10;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** True if `child` is `parent` or inside it (resolved paths). */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function createServer(config, memory, { counters, views, zones, assistantEnv, findTime, engineSpeed, setupStore, usage, fetchImpl, memglowHome } = {}) {
  // memglow's own files (counters, saved view) live in its data folder, NEVER in the notes folder:
  // if the data folder is inside the notes folder, nothing is written (kept in memory only).
  let dataDir = config.dataDir || null;
  if (dataDir && config.memoryDir && isInside(dataDir, config.memoryDir)) {
    console.warn(`memglow: MEMGLOW_DATA_DIR (${dataDir}) is inside the memory folder; memglow never writes there — counters and the saved view are kept in memory only`);
    dataDir = null;
  }
  // Memory cost counters.
  counters = counters || createCounters({ dir: dataDir });
  // A write seen on disk (body changed, new note) counts as a write, unless a reported write on the
  // same note within ±15 s was already counted (and the other way round). See createWriteDedup.
  const dedup = createWriteDedup(15000);
  // Time to find a note (search → first read by the same actor, lib/find-time.js) and the memory
  // engine's response times measured by the MCP proxy (lib/engine-speed.js): ids, times, numbers.
  findTime = findTime || createFindTime({ dir: dataDir });
  engineSpeed = engineSpeed || createEngineSpeed({ dir: dataDir });
  // Archive tier: the first day each section's exact text was seen (section-level "modified").
  const sectionLog = archive.createSectionLog({ dir: dataDir });
  let sectionsObserved = false;
  if (memory.onWrite) {
    memory.onWrite((id, t) => {
      if (dedup.changed(id, t)) counters.add({ type: "write", ids: [id], t });
      if (sectionsObserved && memory.rawBody) sectionLog.observe(id, memory.rawBody(id));
    });
  }
  // The saved view of this instance (settings, layout, camera): one per instance, lib/view.js.
  views = views || view.createViewStore({
    dir: dataDir,
    rules: view.createRules({ themeIds: config.themes.map((t) => t.id), noteExists: (id) => memory.has(id) }),
  });
  // Protected groups and display labels of the groups (lib/zones.js): config file, or the choice
  // saved from the page (first-run screen, Settings) in the data folder.
  zones = zones || zonesLib.createZoneStore({ dir: dataDir, config });
  const themesNow = () => zones.themes();
  const groupName = (id) => { const t = themesNow().find((x) => x.id === id); return t ? t.label : id; };
  const subthemeName = (s) => (config.subthemeLabels && typeof config.subthemeLabels[s] === "string" ? String(config.subthemeLabels[s]).slice(0, 40) : s);
  // First-run set-up and Settings → AI settings (lib/setup.js): what the page saved in the data
  // folder, applied over the configuration (environment > page > memglow.config.json).
  const runEnv = assistantEnv || process.env;
  memglowHome = memglowHome || runEnv.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const baseConfig = setupLib.baseOf(config);
  setupStore = setupStore || setupLib.createSetupStore({ dir: dataDir });
  usage = usage || setupLib.createUsage({ dir: dataDir });
  setupLib.apply(config, baseConfig, setupStore.read(), runEnv);
  let testWindow = 0, testsInWindow = 0;
  function testRateOk() {
    const now = Date.now();
    if (now - testWindow >= 60000) { testWindow = now; testsInWindow = 0; }
    return ++testsInWindow <= SETUP_TESTS_PER_MIN;
  }

  // Optional assistant (lib/assistant): only when enabled. Disabled = its routes, script and buttons
  // do not exist (404 like any unknown route). Created the first time it is enabled (at start, or
  // from the page); it reads config.assistant live, so later settings apply without a restart and
  // its Undo history is kept.
  let assistantInstance = null;
  const assistantNow = () => {
    if (!config.assistant || !config.assistant.enabled) return null;
    if (!assistantInstance) assistantInstance = buildAssistant();
    return assistantInstance;
  };
  const buildAssistant = () => createAssistant({
      config, memory, dataDir, env: runEnv, groupName, usage, fetchImpl,
      protectedIds: () => zones.protectedIds(),
      // Only the regroupings Memory cost currently suggests (by id).
      suggestion(id) { return (cost().organisation || []).find((x) => x.id === id) || null; },
      // Only the notes Memory cost offers to split (the ones with a "Do it with Claude" button).
      costItem(id) {
        const c = cost();
        return (c.tooLarge || []).find((n) => n.id === id) || (c.top || []).find((n) => n.id === id && n.tokens > c.chunkTokens) || null;
      },
      // Only sections of the current dormancy report can be archived.
      archiveReport: () => cost().archive,
    });
  assistantNow();
  const statics = { ...STATIC, "/assistant.js": ["assistant.js", "text/javascript; charset=utf-8"] };
  const template = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const assistantPanelHtml = fs.readFileSync(path.join(PUBLIC, "assistant.html"), "utf8");
  const fingerprints = {};
  for (const [url, [file]] of Object.entries(statics)) {
    fingerprints[url] = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC, file))).digest("hex").slice(0, 10);
  }
  let streams = 0, assistStreams = 0;
  let postWindow = 0, postsInWindow = 0;
  function assistRateOk() {
    const now = Date.now();
    if (now - postWindow >= 60000) { postWindow = now; postsInWindow = 0; }
    return ++postsInWindow <= ASSIST_POSTS_PER_MIN;
  }

  const headers = (res, extra = {}) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  };
  const notFound = (res) => { headers(res, { "Content-Type": "text/plain; charset=utf-8" }); res.statusCode = 404; res.end("404"); };
  const json = (res, code, obj) => { headers(res, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.statusCode = code; res.end(JSON.stringify(obj)); };

  function viewerAllowed(req) {
    if (!config.password) return true;
    const m = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(req.headers.authorization || "");
    if (!m) return false;
    const [user, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    return user === "memglow" && sameSecret(rest.join(":"), config.password);
  }
  /**
   * DNS-rebinding guard. Without a password, a malicious web page could point its own domain at
   * 127.0.0.1 and read the viewer from the victim's browser: the browser would treat it as the page's
   * own origin. So, when no password is set, only requests addressed to localhost, 127.0.0.1, ::1 or a
   * name listed in MEMGLOW_ALLOWED_HOSTS are served. With a password this is not needed: the attacker's
   * origin never has the credentials. POST /api/activity (bearer token) is checked before this.
   */
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  function hostAllowed(req) {
    if (config.password) return true;
    const raw = String(req.headers.host || "").trim().toLowerCase();
    const name = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.replace(/:\d+$/, "");
    return LOCAL_HOSTS.has(name) || (config.allowedHosts || []).includes(name);
  }
  function tokenOk(req) {
    if (!config.token) return false; // not configured: the route does not exist
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{1,256})$/.exec(req.headers.authorization || "");
    return !!m && sameSecret(m[1], config.token);
  }

  /**
   * CSRF guard for PUT /api/view: memglow's custom header (a cross-site page cannot send it without
   * a CORS preflight, which memglow never answers), an Origin of the same host (Host, or the
   * X-Forwarded-Host set by a reverse proxy), and Sec-Fetch-Site "same-origin" when the browser
   * sends it. Anything else is refused.
   */
  function sameOriginWrite(req) {
    if (req.headers["x-memglow"] !== "1") return false;
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin") return false;
    let o;
    try { o = new URL(String(req.headers.origin || "")); } catch { return false; }
    if (o.protocol !== "http:" && o.protocol !== "https:") return false;
    const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()]
      .filter(Boolean).map((h) => String(h).toLowerCase());
    return hosts.includes(o.host.toLowerCase());
  }

  function page() {
    const assistant = assistantNow();
    const assistantPanel = assistant ? assistantPanelHtml : "";
    const themes = themesNow();
    const cfg = {
      themes,
      subthemeLabels: config.subthemeLabels,
      showBodies: config.showBodies,
      assistant: !!assistant,
      // Label of the default AI ("Do it with <provider>"): a name, never a setting or a key.
      assistantLabel: assistant ? assistant.label : "",
      assistantProvider: assistant ? (assistant.label || "your AI") : "",
      // First-run set-up (public/setup.js): shown by itself until finished or skipped.
      setupPending: setupStore.read().wizardDone !== true,
    };
    // Theme colours: legend dots, and the group tag of the activity journal (tinted by --c).
    const dots = themes.map((t) => `.mem-dot--${t.id}{background:${t.color};box-shadow:0 0 6px ${t.color}}.mem-grp--${t.id}{--c:${t.color}}`).join("");
    // The index entry's label is translated client-side (data-i18n="theme.index"); every other
    // label is the instance owner's own theme name (config.themes, or its display name from
    // Protected groups), never translated.
    const legend = themes.concat([{ id: "index", label: "Index", i18n: "theme.index" }])
      .map((t) => `<li><button type="button" class="mem-filtre" data-theme="${esc(t.id)}" aria-pressed="true"><span class="mem-dot mem-dot--${esc(t.id)}"></span><span${t.i18n ? ` data-i18n="${esc(t.i18n)}"` : ""}>${esc(t.label)}</span></button></li>`)
      .join("");
    return template
      .replace(/{{title}}/g, esc(config.title))
      .replace("{{dots}}", dots)
      .replace("{{legend}}", legend)
      .replace("{{assistant}}", () => assistantPanel)
      .replace("{{assistantScript}}", assistant ? '<script src="/assistant.js?v=' + fingerprints["/assistant.js"] + '"></script>' : "")
      // Raw JSON in a non-executed <script type="application/json">: "<" escaped so no label can
      // close the tag; never HTML-escaped (textContent would keep the entities).
      .replace("{{config}}", JSON.stringify(cfg).replace(/</g, "\\u003c"))
      .replace(/{{v:([a-z/.-]+)}}/g, (_, u) => fingerprints["/" + u] || "0");
  }

  /**
   * Memory cost (lib/cost.js): token estimates, counters, notes to split. Section titles are note
   * content, so they are only included when note bodies may be shown (MEMGLOW_SHOW_BODIES), read
   * from the notes with secret-looking lines masked.
   */
  // Cached until the counters, the notes or the day change (an activity or a file change makes the
  // next request recompute; a page refreshes ≈ 1.5 s after either).
  let costCache = null, costKey = "";
  function cost() {
    const notes = memory.costNotes(); // rescans when due: the key below sees the result
    const z = zones.read();
    const key = [counters.version(), memory.version(), dayOf(Date.now()), config.showBodies, JSON.stringify(z), config.largeNoteTokens, config.splitChunkTokens].join(":");
    if (costCache && key === costKey) return costCache;
    costCache = computeCostNow(notes);
    costKey = key;
    return costCache;
  }
  function computeCostNow(notes) {
    const opts = { since: counters.since(), largeNoteTokens: config.largeNoteTokens, chunkTokens: config.splitChunkTokens };
    const first = withOrganisation(computeCost(counters.days(), notes, Date.now(), opts));
    first.archive = archiveNow(notes);
    if (!config.showBodies) return first;
    const bodies = {};
    for (const n of first.tooLarge.concat(first.top).slice(0, COST_SECTIONS_MAX)) {
      if (n.id in bodies) continue;
      const b = memory.maskedBody(n.id);
      if (b != null) bodies[n.id] = b;
    }
    const out = withOrganisation(computeCost(counters.days(), notes, Date.now(), { ...opts, bodies }));
    out.archive = first.archive;
    return out;
  }
  /**
   * Organisation suggestions (lib/organise.js, read-only): notes of one subject scattered across
   * sub-themes of a group. Titles, ids and sub-themes only — the same metadata the graph shows.
   */
  function withOrganisation(c) {
    const g = memory.graph();
    const protectedNames = zones.protectedIds().map(groupName);
    c.protectedGroups = protectedNames; // named in the copy prompts ("never move notes across…")
    c.organisation = organise.suggest({ notes: g.nodes, links: g.links, themeName: groupName, subthemeName })
      .map((x) => ({ ...x, prompt: organise.regroupPrompt(x, { themeName: groupName, subthemeName, protectedNames }) }));
    return c;
  }
  /**
   * Always-loaded cost (lib/always-loaded.js): index note(s) + instruction files listed in
   * `alwaysLoaded` (size only, never their content), × sessions per day. Not cached: a few stats.
   */
  function alwaysLoaded() {
    return alwaysLoadedCost({
      index: (memory.costNotes() || []).filter((n) => n.theme === "index").map((n) => ({ id: n.id, label: n.label, tokens: Math.ceil((n.bytes || 0) / 4) })),
      files: measureFiles(config.alwaysLoaded || [], { cwd: config.cwd || process.cwd() }),
      days: counters.days(), now: Date.now(), sessionsPerDay: config.sessionsPerDay || 5, indexWarningTokens: config.indexWarningTokens || 2000,
    });
  }
  /**
   * Archive tier (lib/archive.js): dormant sections, read only. Section titles only when note bodies
   * may be shown. Keys are hashes (no content); they are what an archive proposal refers to.
   */
  function archiveNow(notes) {
    if (!memory.rawBody) return null;
    if (!sectionsObserved) {
      sectionsObserved = true;
      for (const n of notes) sectionLog.observe(n.id, memory.rawBody(n.id));
    }
    // Recomputed only when notes, the day, or a note's last read/search/write day change.
    const key = [memory.version(), dayOf(Date.now()), counters.lastVersion ? counters.lastVersion() : counters.version(), config.showBodies].join(":");
    if (archiveCache && key === archiveKey) return archiveCache;
    archiveKey = key;
    sectionLog.keep(new Set(notes.map((n) => n.id)));
    return (archiveCache = archive.detectDormant({
      notes, last: counters.last ? counters.last() : {}, started: counters.started ? counters.started() : counters.since(),
      now: Date.now(), settings: config.archive, sectionLog, readBody: (id) => memory.rawBody(id), withTitles: config.showBodies,
    }));
  }
  let archiveCache = null, archiveKey = "";
  // Titles only (never note content): the label of a note id, or null if it is gone.
  function findTimeNow() {
    const labels = new Map((memory.costNotes() || []).map((n) => [n.id, n.label]));
    return findTime.summary(Date.now(), (id) => labels.get(id) || null);
  }

  /**
   * Reads a small JSON body (capped at `max` bytes, also when the declared length lies) and calls
   * `done(body)`; answers 413 / 400 itself. Never logs the body.
   */
  function readJson(req, res, max, done) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) { req.resume(); return json(res, 413, { error: "too large" }); }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) { req.resume(); return json(res, 415, { error: "json only" }); }
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      if (res.writableEnded) return;
      size += c.length;
      if (size > max) { json(res, 413, { error: "too large" }); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "bad json" }); }
      chunks.length = 0;
      done(body);
    });
  }
  const setupNow = (req) => setupLib.publicSetup({ config, saved: setupStore.read(), env: runEnv, dataDir, memglowHome, req, usage });
  /** Hosts a key may be sent to, per provider, with the settings in effect now. */
  const destinations = () => Object.fromEntries(setupLib.PROVIDER_IDS.map((id) => {
    const row = setupLib.publicSetup({ config, saved: {}, env: runEnv, dataDir, memglowHome, req: null }).assistant.providers.find((x) => x.id === id);
    return [id, { destination: row.destination, key: row.key }];
  }));

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const assistant = assistantNow();

    // Assistant hooks report activity here. Bearer token; without a valid one the answer is the
    // plain 404 of an unknown route (never 401/403, which would advertise the route).
    if (p === "/api/activity" && req.method === "POST") {
      if (!tokenOk(req)) return notFound(res);
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > ACTIVITY_MAX_BYTES) { json(res, 413, { error: "too large" }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "bad json" }); }
        const r = memory.activity(body);
        // Counted for Memory cost, except demo activity (animated, never counted). A write already
        // counted from the file change (same note, ±15 s) is not counted twice.
        if (r.ok && body.demo !== true) {
          const t = Date.now();
          const ids = body.type === "write" ? dedup.reported(r.ids, t) : r.ids;
          if (ids.length) counters.add({ type: body.type, ids, t });
        }
        // Time to find a note: accepted searches and reads, plus a search that found no known note
        // (a "missed" search is exactly what this measures). Engine speed: the proxy's durationMs,
        // validated and bounded (lib/engine-speed.js cleanDuration) — a bad value is just dropped.
        if (r.who && body.demo !== true && (r.ok || r.reason === "unknown")) {
          if (r.ok || r.who.type === "search") findTime.add({ ...r.who, ids: r.ok ? r.ids : [] });
          const ms = cleanDuration(body.durationMs);
          if (ms != null) engineSpeed.add({ type: r.who.type, ms, t: r.who.t });
        }
        headers(res);
        res.statusCode = r.ok ? 204 : r.reason === "rate" ? 429 : 202;
        res.end();
      });
      return;
    }

    if (!hostAllowed(req)) {
      req.resume();
      headers(res, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.statusCode = 403;
      return res.end("memglow: this host name is not allowed. Open http://127.0.0.1:" + config.port +
        ", set MEMGLOW_PASSWORD to expose memglow, or list the name in MEMGLOW_ALLOWED_HOSTS.");
    }

    const unauthorized = () => {
      headers(res, { "WWW-Authenticate": 'Basic realm="memglow", charset="UTF-8"', "Content-Type": "text/plain" });
      res.statusCode = 401;
      return res.end("401");
    };

    // Saving the view (settings, layout, camera): same access rule as the page (password when
    // MEMGLOW_PASSWORD is set), same-origin browser request with memglow's own header (CSRF),
    // rate limited, body capped, then strictly validated (lib/view.js).
    if (p === "/api/view" && req.method === "PUT") {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!views.rateOk()) { req.resume(); headers(res, { "Retry-After": "5" }); return json(res, 429, { error: "too many requests" }); }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > view.BODY_MAX) { req.resume(); return json(res, 413, { error: "too large" }); }
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        if (res.writableEnded) return;
        size += c.length;
        if (size > view.BODY_MAX) { json(res, 413, { error: "too large" }); req.resume(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "bad json" }); }
        let v;
        try { v = views.write(body); } catch (e) { console.error("[memglow] view not saved:", e.message); return json(res, 500, { error: "not saved" }); }
        if (!v) return json(res, 400, { error: "bad view" });
        headers(res, { "Cache-Control": "no-store" });
        res.statusCode = 204;
        res.end();
      });
      return;
    }

    // Protected groups and group labels (first-run screen, Settings): same guard as the saved view —
    // page access rule, same-origin request with memglow's header (CSRF), rate limited, body capped,
    // strictly validated (lib/zones.js). A refused body is a 400: nothing is written.
    if (p === "/api/zones" && req.method === "PUT") {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!zones.rateOk()) { req.resume(); headers(res, { "Retry-After": "5" }); return json(res, 429, { error: "too many requests" }); }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > zonesLib.BODY_MAX) { req.resume(); return json(res, 413, { error: "too large" }); }
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        if (res.writableEnded) return;
        size += c.length;
        if (size > zonesLib.BODY_MAX) { json(res, 413, { error: "too large" }); req.resume(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "bad json" }); }
        const z = zones.write(body);
        if (!z) return json(res, 400, { error: "bad zones" });
        return json(res, 200, { defined: true, source: "saved", protected: z.protected, labels: z.labels });
      });
      return;
    }

    // First-run set-up and AI settings (lib/setup.js): same guard as the saved view — page access
    // rule, same-origin request with memglow's header (CSRF), rate limited, JSON only, body capped,
    // strictly validated. No secret ever travels here (refused as "secret-field").
    if (p === "/api/setup" && req.method === "PUT") {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!setupStore.rateOk()) { req.resume(); headers(res, { "Retry-After": "5" }); return json(res, 429, { error: "too many requests" }); }
      return readJson(req, res, setupLib.BODY_MAX, (body) => {
        const v = setupLib.validate(body);
        if (!v.ok) return json(res, 400, { error: v.error, field: v.field || "" });
        // Sending a key somewhere else is as sensitive as typing one: changing the address of a
        // provider that has a key needs the same conditions (this machine, or password + HTTPS).
        if (v.value.assistant) {
          const before = destinations();
          const trial = setupLib.effective(baseConfig, { ...setupStore.read(), ...v.value }, runEnv);
          const after = setupLib.publicSetup({ config: { ...config, assistant: trial.assistant }, saved: {}, env: runEnv, dataDir, memglowHome, req: null }).assistant.providers;
          const moved = after.some((row) => row.key === "set" && before[row.id] && before[row.id].destination && row.destination !== before[row.id].destination);
          if (moved && !setupLib.secretEntry(req, config).allowed) return json(res, 403, { error: "destination-change-needs-local", field: "baseUrl" });
          if (assistantInstance && assistantInstance.status().busy) return json(res, 409, { error: "assistant-busy" });
        }
        try { setupStore.write(v.value); } catch (e) { console.error("[memglow] set-up not saved:", e.code || "error"); return json(res, 500, { error: "not saved" }); }
        setupLib.apply(config, baseConfig, setupStore.read(), runEnv);
        costCache = null;
        return json(res, 200, setupNow(req));
      });
    }
    // A secret (API key, Claude Code subscription token): its own route, its own rules. Saving one
    // needs this machine, or a password and HTTPS (setupLib.secretEntry). Removing one only needs the
    // page's access. The value is written to a mode-600 file and never sent back, never logged.
    if (p === "/api/setup/secret" && req.method === "POST") {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!setupStore.rateOk()) { req.resume(); headers(res, { "Retry-After": "5" }); return json(res, 429, { error: "too many requests" }); }
      return readJson(req, res, setupLib.SECRET_BODY_MAX, (body) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad-body" });
        const keys = Object.keys(body);
        const id = typeof body.provider === "string" ? body.provider : "";
        if (!setupLib.secretFile(id)) return json(res, 400, { error: "no-secret-for-provider" });
        if (!dataDir) return json(res, 409, { error: "no-data-dir" });
        if (body.remove === true && keys.every((k) => k === "provider" || k === "remove")) {
          setupLib.removeSecret(dataDir, id);
        } else if (typeof body.secret === "string" && keys.every((k) => k === "provider" || k === "secret")) {
          const entry = setupLib.secretEntry(req, config);
          if (!entry.allowed) return json(res, 403, { error: "secret-entry-refused", reason: entry.reason });
          if (!setupLib.validSecret(body.secret)) return json(res, 400, { error: "bad-secret" });
          try { setupLib.writeSecret(dataDir, id, body.secret); } catch (e) { console.error("[memglow] secret not saved:", e.code || "error"); return json(res, 500, { error: "not saved" }); }
        } else return json(res, 400, { error: "bad-body" });
        const row = setupNow(req).assistant.providers.find((x) => x.id === id);
        return json(res, 200, { provider: id, key: row.key, keySource: row.keySource, keyName: row.keyName });
      });
    }
    // Test connection: one minimal request to the provider with the settings in effect (no note
    // content), rate limited. The answer says OK or the error, redacted of every secret.
    if (p === "/api/setup/test" && req.method === "POST") {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!testRateOk()) { req.resume(); headers(res, { "Retry-After": "30" }); return json(res, 429, { error: "too many requests" }); }
      return readJson(req, res, 1024, (body) => {
        const id = body && typeof body.provider === "string" && setupLib.PROVIDER_IDS.includes(body.provider) ? body.provider : "";
        if (!id) return json(res, 400, { error: "unknown-provider" });
        setupLib.testConnection({ id, assistantConfig: config.assistant, env: runEnv, dataDir, workDir: dataDir ? path.join(dataDir, "assistant-work") : null, fetchImpl })
          .then((r) => json(res, 200, { provider: id, ...r }))
          .catch(() => json(res, 200, { provider: id, ok: false, ms: 0, error: "test failed" }));
      });
    }

    // Assistant actions (only when enabled): same access rule as the page, same-origin browser request
    // with memglow's header (CSRF), rate limited, small JSON body. Every one of them can start a
    // process, spend tokens or write notes.
    const am = assistant && req.method === "POST" && /^\/api\/assistant\/(propose|archive|confirm|apply|undo|cancel)$/.exec(p);
    if (am) {
      if (!viewerAllowed(req)) { req.resume(); return unauthorized(); }
      if (!sameOriginWrite(req)) { req.resume(); return json(res, 403, { error: "forbidden" }); }
      if (!assistRateOk()) { req.resume(); headers(res, { "Retry-After": "30" }); return json(res, 429, { error: "too many requests" }); }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > ASSIST_BODY_MAX) { req.resume(); return json(res, 413, { error: "too large" }); }
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        if (res.writableEnded) return;
        size += c.length;
        if (size > ASSIST_BODY_MAX) { json(res, 413, { error: "too large" }); req.resume(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.writableEnded) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad json" }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "bad request" });
        const id = typeof body.job === "string" && /^[0-9a-f]{16}$/.test(body.job) ? body.job : "";
        let r;
        switch (am[1]) {
          case "propose":
            if (body.kind === "regroup") {
              const sid = typeof body.suggestion === "string" && /^rg-[0-9a-f]{12}$/.test(body.suggestion) ? body.suggestion : "";
              r = assistant.proposeRegroup(sid, { extra: typeof body.extra === "string" ? body.extra : "", provider: typeof body.provider === "string" ? body.provider.slice(0, 40) : "" });
              break;
            }
            r = assistant.propose(String(body.note || ""), { extra: typeof body.extra === "string" ? body.extra : "", provider: typeof body.provider === "string" ? body.provider.slice(0, 40) : "" }); break;
          case "archive": r = assistant.proposeArchive(Array.isArray(body.sections) ? body.sections.slice(0, 101) : null, { ai: body.ai === true, provider: typeof body.provider === "string" ? body.provider.slice(0, 40) : "" }); break;
          case "confirm": r = assistant.confirm(id); break;
          case "apply": r = assistant.apply(id, body.token); break;
          case "undo": r = assistant.undo(id); break;
          default: r = assistant.cancel(id);
        }
        if (!r.ok) return json(res, r.code || 400, { error: r.error });
        const out = { ...r }; delete out.ok;
        return json(res, 200, out);
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
    if (!viewerAllowed(req)) return unauthorized();

    if (p === "/") {
      headers(res, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(page());
    }
    if (statics[p] && (p !== "/assistant.js" || assistant)) {
      const [file, type] = statics[p];
      headers(res, { "Content-Type": type, "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache" });
      return fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    }
    if (assistant && p === "/api/assistant") return json(res, 200, assistant.status());
    if (assistant && p === "/api/assistant/stream") {
      if (assistStreams >= ASSIST_STREAM_MAX) { json(res, 429, { error: "too many streams" }); return; }
      assistStreams++;
      headers(res, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write("retry: 5000\n\n");
      const off = assistant.subscribe((evt) => res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`));
      const beat = setInterval(() => res.write(": beat\n\n"), 25000);
      req.on("close", () => { off(); clearInterval(beat); assistStreams--; });
      return;
    }
    if (p === "/api/graph") return json(res, 200, memory.graph());
    if (p === "/api/cost") return json(res, 200, { ...cost(), alwaysLoaded: alwaysLoaded(), findTime: findTimeNow(), engineSpeed: engineSpeed.summary() });
    if (p === "/api/zones") {
      const z = zones.read();
      return json(res, 200, { ...z, themes: zonesLib.overview(config, memory.costNotes(), z.labels) });
    }
    if (p === "/api/view") return json(res, 200, view.publicView(views.read()));
    if (p === "/api/setup") return json(res, 200, setupNow(req));
    if (p.startsWith("/api/note/")) {
      const n = memory.note(decodeURIComponent(p.slice("/api/note/".length)), { withBody: config.showBodies });
      return n ? json(res, 200, n) : json(res, 404, { error: "not found" });
    }
    if (p === "/api/stream") {
      if (streams >= STREAM_MAX) { json(res, 429, { error: "too many streams" }); return; }
      streams++;
      headers(res, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write("retry: 10000\n\n");
      const off = memory.subscribe(
        (evt) => res.write(`event: change\ndata: ${JSON.stringify(evt)}\n\n`),
        (evt) => res.write(`event: activity\ndata: ${JSON.stringify(evt)}\n\n`)
      );
      const beat = setInterval(() => res.write(": beat\n\n"), 25000);
      req.on("close", () => { off(); clearInterval(beat); streams--; });
      return;
    }
    return notFound(res);
  });
}

/**
 * Environment for the CLI: when nothing is configured here (no MEMGLOW_CONFIG, no
 * ./memglow.config.json, no MEMORY_DIR), fall back to what `memglow init` wrote in ~/.memglow
 * (config file and token). An explicit setting always wins.
 */
function withInstalledDefaults(env = process.env, cwd = process.cwd()) {
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const out = { ...env };
  const installed = path.join(home, "memglow.config.json");
  if (!out.MEMGLOW_CONFIG && !out.MEMORY_DIR && !fs.existsSync(path.join(cwd, "memglow.config.json")) && fs.existsSync(installed)) {
    out.MEMGLOW_CONFIG = installed;
  }
  if (!out.MEMGLOW_TOKEN) {
    try {
      const t = fs.readFileSync(path.join(home, "token"), "utf8").trim();
      if (t.length >= 32) out.MEMGLOW_TOKEN = t;
    } catch { /* no token: live activity stays off */ }
  }
  return out;
}

function main(env = process.env) {
  const config = loadConfig(withInstalledDefaults(env));
  if (!fs.existsSync(config.memoryDir)) {
    console.error(`memglow: memory folder not found: ${config.memoryDir}\nRun \`memglow init\`, or set MEMORY_DIR to a folder of Markdown notes (try MEMORY_DIR=./demo/memory).`);
    process.exit(1);
  }
  const memory = createMemory({ dir: config.memoryDir, config, pollMs: config.pollMs });
  return createServer(config, memory).listen(config.port, config.host, () => {
    console.log(`memglow: ${config.memoryDir}`);
    console.log(`memglow: open http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
    if (!config.token) console.log("memglow: MEMGLOW_TOKEN not set — /api/activity is disabled (live assistant activity off)");
    if (config.assistant.enabled) console.log(`memglow: assistant ON (provider ${config.assistant.provider}) — it only proposes; memglow writes what you approve, after a backup`);
  });
}

if (require.main === module) main();

module.exports = { createServer, main, withInstalledDefaults };
