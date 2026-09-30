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

const PUBLIC = path.join(__dirname, "public");
const STATIC = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/cost.js": ["cost.js", "text/javascript; charset=utf-8"],
  "/vendor/memglow-graph.js": ["vendor/memglow-graph.js", "text/javascript; charset=utf-8"],
};
const STREAM_MAX = 20;
const ACTIVITY_MAX_BYTES = 4096;
const COST_SECTIONS_MAX = 40; // notes whose sections are listed in one /api/cost answer

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

function createServer(config, memory, { counters, views } = {}) {
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
  if (memory.onWrite) {
    memory.onWrite((id, t) => { if (dedup.changed(id, t)) counters.add({ type: "write", ids: [id], t }); });
  }
  // The saved view of this instance (settings, layout, camera): one per instance, lib/view.js.
  views = views || view.createViewStore({
    dir: dataDir,
    rules: view.createRules({ themeIds: config.themes.map((t) => t.id), noteExists: (id) => memory.has(id) }),
  });
  const template = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const fingerprints = {};
  for (const [url, [file]] of Object.entries(STATIC)) {
    fingerprints[url] = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC, file))).digest("hex").slice(0, 10);
  }
  let streams = 0;

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
    const cfg = {
      themes: config.themes,
      subthemeLabels: config.subthemeLabels,
      showBodies: config.showBodies,
    };
    // Theme colours: legend dots, and the group tag of the activity journal (tinted by --c).
    const dots = config.themes.map((t) => `.mem-dot--${t.id}{background:${t.color};box-shadow:0 0 6px ${t.color}}.mem-grp--${t.id}{--c:${t.color}}`).join("");
    const legend = config.themes.concat([{ id: "index", label: "Index" }])
      .map((t) => `<li><button type="button" class="mem-filtre" data-theme="${esc(t.id)}" aria-pressed="true"><span class="mem-dot mem-dot--${esc(t.id)}"></span>${esc(t.label)}</button></li>`)
      .join("");
    return template
      .replace(/{{title}}/g, esc(config.title))
      .replace("{{dots}}", dots)
      .replace("{{legend}}", legend)
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
    const key = [counters.version(), memory.version(), dayOf(Date.now()), config.showBodies].join(":");
    if (costCache && key === costKey) return costCache;
    costCache = computeCostNow(notes);
    costKey = key;
    return costCache;
  }
  function computeCostNow(notes) {
    const opts = { since: counters.since(), largeNoteTokens: config.largeNoteTokens, chunkTokens: config.splitChunkTokens };
    const first = computeCost(counters.days(), notes, Date.now(), opts);
    if (!config.showBodies) return first;
    const bodies = {};
    for (const n of first.tooLarge.concat(first.top).slice(0, COST_SECTIONS_MAX)) {
      if (n.id in bodies) continue;
      const b = memory.maskedBody(n.id);
      if (b != null) bodies[n.id] = b;
    }
    return computeCost(counters.days(), notes, Date.now(), { ...opts, bodies });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

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
    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      headers(res, { "Content-Type": type, "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache" });
      return fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    }
    if (p === "/api/graph") return json(res, 200, memory.graph());
    if (p === "/api/cost") return json(res, 200, cost());
    if (p === "/api/view") return json(res, 200, view.publicView(views.read()));
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
  });
}

if (require.main === module) main();

module.exports = { createServer, main, withInstalledDefaults };
