#!/usr/bin/env node
"use strict";
/**
 * Simulates an assistant working on the demo memory: reads, searches and writes are sent to a
 * running memglow server so you can watch the brain light up (nothing is modified on disk).
 *
 *   MEMGLOW_TOKEN=$(openssl rand -hex 32) MEMORY_DIR=./demo/memory node server.js   # terminal 1
 *   MEMGLOW_TOKEN=<same token> node demo/simulate.js [seconds=60] [--counted]       # terminal 2
 *
 * By default the activity is flagged `demo: true`: animated, but neither kept in the history nor
 * counted in Memory cost. With --counted it is sent like real activity, so Memory cost fills up
 * (the counts go to memglow's data folder, ~/.memglow by default — use MEMGLOW_DATA_DIR on the
 * server to keep them apart).
 */
const fs = require("fs");
const path = require("path");

const BASE = (process.env.MEMGLOW_URL || "http://127.0.0.1:4747").replace(/\/+$/, "");
const TOKEN = process.env.MEMGLOW_TOKEN || "";
if (!TOKEN) { console.error("Set MEMGLOW_TOKEN (the same value the server uses)."); process.exit(1); }
const DIR = path.resolve(process.env.MEMORY_DIR || path.join(__dirname, "memory"));
const args = process.argv.slice(2);
const counted = args.includes("--counted");
const seconds = Number(args.find((a) => !a.startsWith("--"))) || 60;

const slugs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md") && e.name !== "MEMORY.md") slugs.push(e.name.slice(0, -3));
  }
})(DIR);

const pick = (n) => slugs.slice().sort(() => Math.random() - 0.5).slice(0, n);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function send(type, ids) {
  const r = await fetch(BASE + "/api/activity", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    // demo: true → animated, but not kept in the history nor counted in Memory cost
    body: JSON.stringify(counted ? { type, ids, source: "demo", channel: "demo" } : { type, ids, source: "demo", channel: "demo", demo: true }),
  });
  console.log(new Date().toISOString().slice(11, 19), type.padEnd(6), ids.slice(0, 3).join(", "), r.status);
}

(async () => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await send("search", pick(4 + Math.floor(Math.random() * 4))); await pause(4000);
    await send("read", pick(1)); await pause(3000);
    if (Math.random() < 0.5) { await send("write", pick(1)); await pause(3500); }
    await pause(3000);
  }
})().catch((e) => { console.error("simulate:", e.message); process.exit(1); });
