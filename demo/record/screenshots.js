#!/usr/bin/env node
"use strict";
/**
 * Takes the README screenshots (PNG, 1600×900 by default) with the fictional demo memory, on the
 * same virtual clock as record.js, so each picture freezes exactly the instant we want.
 *
 *   docker run --rm --network none -v "$PWD:/work:ro" -v /tmp/shots:/out \
 *     -e NODE_PATH=/home/pptruser/node_modules ghcr.io/puppeteer/puppeteer \
 *     node /work/demo/record/screenshots.js /out
 *
 * Several candidates are written per scene (suffix = virtual ms after the event); pick the best.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..", "..");
const { createServer } = require(path.join(ROOT, "server"));
const { createMemory } = require(path.join(ROOT, "lib", "memory"));
const { loadConfig } = require(path.join(ROOT, "lib", "config"));

const OUT = path.resolve(process.argv[2] || "./shots");
const W = Number(process.env.WIDTH) || 1600;
const H = Number(process.env.HEIGHT) || 900;
const TOKEN = crypto.randomBytes(24).toString("hex");
const DT = 1000 / 60;

// Same virtual clock as record.js (performance.now, Date, timers, rAF move only on __vstep).
const CLOCK = fs.readFileSync(path.join(__dirname, "record.js"), "utf8").match(/const CLOCK = `([\s\S]*?)`;/)[1];

// Presentation only: stage and journal side by side, filling the viewport.
const CSS = `
.mg-wrap { max-width: none; padding: 14px 18px; }
.mg-head { margin: 0 0 12px; }
.mg-head p { display: none; }
.bn-grid { grid-template-columns: 1fr 320px; align-items: stretch; }
.mem-canvas { height: calc(100vh - 76px); min-height: 0; }
.mem-journal { overflow: hidden; height: calc(100vh - 76px); }
.mg-foot { display: none; }
`;

function startServer() {
  const config = loadConfig({ MEMORY_DIR: path.join(ROOT, "demo", "memory"), MEMGLOW_TOKEN: TOKEN }, ROOT);
  const memory = createMemory({ dir: config.memoryDir, config, pollMs: config.pollMs });
  const server = createServer(config, memory);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (type, ids) => {
    const r = await fetch(base + "/api/activity", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ type, ids, source: "demo", demo: true }),
    });
    if (r.status !== 204) throw new Error(`activity ${type} → HTTP ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 300)); // let the SSE event reach the page
  };
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist", "--hide-scrollbars", "--force-color-profile=srgb", `--window-size=${W},${H}`],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.evaluateOnNewDocument(CLOCK);
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
    const cdp = await page.createCDPSession();
    // Software WebGL is slow: calm phases use coarse steps, captured moments 30 Hz steps.
    const step = async (ms, dt = DT) => { for (let i = 0; i < Math.round(ms / dt); i++) await page.evaluate((d) => window.__vstep(d), dt); };
    const wait = (ms) => step(ms, 50);
    const shot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(data, "base64"));
      console.log("shot", name);
    };
    // Candidates at several instants after an event.
    const series = async (name, times) => {
      let t = 0;
      for (const at of times) { await step(at - t, 1000 / 30); t = at; await shot(`${name}-${at}`); }
    };

    for (let i = 0; i < 600; i++) {
      await page.evaluate((d) => window.__vstep(d), DT);
      const ready = await page.evaluate(() => document.getElementById("mem-etat").hidden && document.getElementById("mem-nb-notes").textContent !== "0");
      if (ready) { console.log("graph ready after", i, "steps"); break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    await wait(4000);

    // A few events first: the journal is not empty, and after 6 s of calm the camera frames
    // the whole memory (the initial camera is further away).
    await post("read", ["reference-docker-pitfalls"]);
    await wait(1000);
    await post("search", ["knowledge-reverse-proxy", "reference-git-workflow", "project-storefront"]);
    await wait(9500);
    await shot("overview-a");
    const names = (v) => page.evaluate((val) => {
      const s = document.getElementById("mem-noms");
      s.value = val;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, v);
    await names("tous");
    await step(300);
    await shot("overview-names");
    await names("actifs");
    await wait(1500);

    await post("write", ["project-smart-home"]);
    await series("write", [500, 1100, 1700, 2600]);
    await wait(7500);

    await post("search", ["project-home-lab", "knowledge-mqtt", "project-smart-home", "reference-docker-pitfalls", "reference-backups"]);
    await series("search", [400, 700, 1000, 1500]);
    await wait(7500);

    await page.evaluate(() => { document.getElementById("mem-options").open = true; });
    await step(400);
    await shot("settings");
  } finally {
    await browser.close();
    server.close();
    process.exit(0);
  }
})().catch((e) => { console.error("screenshots:", e); process.exit(1); });
