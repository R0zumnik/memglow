#!/usr/bin/env node
"use strict";
/**
 * Records the demo video frame by frame (deterministic, independent of how fast the machine
 * renders): the page runs on a virtual clock that this script advances one frame at a time, so a
 * slow software-WebGL renderer (SwiftShader, no GPU) still gives a smooth 30 fps result.
 *
 * Runs inside the official Puppeteer image, with no network at all:
 *
 *   docker run --rm --network none -v "$PWD:/work:ro" -v /tmp/frames:/out \
 *     -e NODE_PATH=/home/pptruser/node_modules ghcr.io/puppeteer/puppeteer \
 *     node /work/demo/record/record.js /out
 *
 * then assemble the JPEG frames with ffmpeg (commands at the bottom of this file). Nothing is
 * written to the memory folder: activity is posted to the local server with `demo: true`.
 *
 * Environment: FPS (30), SUBSTEPS (2 — the page is stepped at FPS*SUBSTEPS Hz, one screenshot
 * per FPS frame, so animation speeds match a normal 60 Hz display), WIDTH (1280), HEIGHT (720),
 * ONLY (seconds to record, for tests).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "..");
const { createServer } = require(path.join(ROOT, "server"));
const { createMemory } = require(path.join(ROOT, "lib", "memory"));
const { loadConfig } = require(path.join(ROOT, "lib", "config"));

const OUT = path.resolve(process.argv[2] || "./frames");
const FPS = Number(process.env.FPS) || 30;
const SUBSTEPS = Number(process.env.SUBSTEPS) || 2;
const W = Number(process.env.WIDTH) || 1280;
const H = Number(process.env.HEIGHT) || 720;
const ONLY = Number(process.env.ONLY) || 0;
const TOKEN = crypto.randomBytes(24).toString("hex");

// Scenario, in seconds from the start of the recording.
const SCENARIO = [
  // 1. overview: the brain slowly turning (nothing sent)
  // 2. a search across several notes: the camera frames the results
  [6.0, "search", ["project-home-lab", "knowledge-mqtt", "project-smart-home", "reference-docker-pitfalls", "reference-backups"]],
  // 3. a targeted read (cyan), then a targeted write (red-orange, big name)
  [12.5, "read", ["reference-docker-pitfalls"]],
  [18.0, "write", ["project-smart-home"]],
  // 4. comets along the links, then back to calm and zoom out
  [23.5, "read", ["knowledge-reverse-proxy", "reference-git-workflow", "project-storefront"]],
  [25.0, "search", ["person-maya", "client-northwind", "project-booking-app", "feedback-async-first"]],
];
const DURATION = ONLY || 38;

// Virtual clock injected before any page script: performance.now, Date, timers and
// requestAnimationFrame only move when window.__vstep(ms) is called.
const CLOCK = `(() => {
  const RealDate = Date;
  let vt = performance.now();
  const origin = RealDate.now() - vt;
  performance.now = () => vt;
  function FakeDate(...a) {
    if (!(this instanceof FakeDate)) return new RealDate(origin + vt).toString();
    return a.length ? new RealDate(...a) : new RealDate(origin + vt);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => origin + vt;
  FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  const timers = new Map(); let nextId = 1; let rafs = [];
  window.setTimeout = (fn, ms, ...args) => { const id = nextId++; timers.set(id, { fn, at: vt + Math.max(0, +ms || 0), args, every: 0 }); return id; };
  window.setInterval = (fn, ms, ...args) => { const id = nextId++; const e = Math.max(1, +ms || 0); timers.set(id, { fn, at: vt + e, args, every: e }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = nextId++; rafs.push({ id, fn }); return id; };
  window.cancelAnimationFrame = (id) => { rafs = rafs.filter((r) => r.id !== id); };
  window.__vstep = (dt) => {
    const target = vt + dt;
    for (let guard = 0; guard < 2000; guard++) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= target && (!best || t.at < best[1].at)) best = [id, t];
      if (!best) break;
      const [id, t] = best;
      vt = Math.max(vt, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      try { typeof t.fn === "function" ? t.fn(...t.args) : (0, eval)(String(t.fn)); } catch (e) { console.error(e && e.stack || e); }
    }
    vt = target;
    const cbs = rafs; rafs = [];
    for (const r of cbs) { try { r.fn(vt); } catch (e) { console.error(e && e.stack || e); } }
  };
})();`;

// Presentation only (the product is untouched): stage and journal side by side, filling 720p.
const CSS = `
.mg-wrap { max-width: none; padding: 12px 16px; }
.mg-head { margin: 0 0 10px; }
.mg-head p { display: none; }
.bn-grid { grid-template-columns: 1fr 290px; align-items: stretch; }
.mem-canvas { height: calc(100vh - 70px); min-height: 0; }
.mem-journal { overflow: hidden; height: calc(100vh - 70px); }
.mg-foot { display: none; }
`;

function startServer() {
  const config = loadConfig({ MEMORY_DIR: path.join(ROOT, "demo", "memory"), MEMGLOW_TOKEN: TOKEN }, ROOT);
  const memory = createMemory({ dir: config.memoryDir, config, pollMs: config.pollMs });
  const server = createServer(config, memory);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function post(base, type, ids) {
  const r = await fetch(base + "/api/activity", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ type, ids, source: "demo", demo: true }),
  });
  if (r.status !== 204) throw new Error(`activity ${type} → HTTP ${r.status}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist", "--hide-scrollbars", "--force-color-profile=srgb", `--window-size=${W},${H}`],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") console.log("[page]", m.text()); });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.evaluateOnNewDocument(CLOCK);
    // The stylesheet must be in place before the page scripts measure the canvas.
    await page.evaluateOnNewDocument((css) => {
      const add = () => {
        if (!document.documentElement) return false;
        const s = document.createElement("style");
        s.textContent = css;
        document.documentElement.appendChild(s);
        return true;
      };
      if (!add()) new MutationObserver((m, o) => { if (add()) o.disconnect(); }).observe(document, { childList: true });
    }, CSS);
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    const gl = await page.evaluate(() => {
      const c = document.createElement("canvas").getContext("webgl2");
      const d = c && c.getExtension("WEBGL_debug_renderer_info");
      return c ? (d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl2") : null;
    });
    console.log("WebGL:", gl);
    if (!gl) throw new Error("no WebGL");

    const dt = 1000 / FPS / SUBSTEPS;
    // Load the graph, then let the layout settle for a few (virtual) seconds before recording.
    for (let i = 0; i < 600; i++) {
      await page.evaluate((d) => window.__vstep(d), dt);
      const ready = await page.evaluate(() => document.getElementById("mem-etat").hidden && document.getElementById("mem-nb-notes").textContent !== "0");
      if (ready) { console.log("graph ready after", i, "steps"); break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    for (let i = 0; i < Math.round(4000 / dt); i++) await page.evaluate((d) => window.__vstep(d), dt);

    const cdp = await page.createCDPSession();
    const total = Math.round(DURATION * FPS);
    const todo = SCENARIO.slice();
    const t0 = Date.now();
    for (let f = 0; f < total; f++) {
      const sec = f / FPS;
      while (todo.length && todo[0][0] <= sec) {
        const [, type, ids] = todo.shift();
        await post(base, type, ids);
        await new Promise((r) => setTimeout(r, 250)); // let the SSE event reach the page
        console.log(`t=${sec.toFixed(2)}s ${type} ${ids.join(",")}`);
      }
      for (let s = 0; s < SUBSTEPS; s++) await page.evaluate((d) => window.__vstep(d), dt);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: false });
      fs.writeFileSync(path.join(OUT, `f${String(f).padStart(5, "0")}.jpg`), Buffer.from(data, "base64"));
      if (f % 60 === 0) console.log(`frame ${f}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    console.log("done:", total, "frames in", ((Date.now() - t0) / 1000).toFixed(0), "s");
  } finally {
    await browser.close();
    server.close();
    process.exit(0);
  }
})().catch((e) => { console.error("record:", e); process.exit(1); });

/* Assembly (any ffmpeg):
 *   ffmpeg -framerate 30 -i frames/f%05d.jpg -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart docs/demo.mp4
 *   ffmpeg -i docs/demo.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" docs/demo.gif
 */
