#!/usr/bin/env node
"use strict";
/**
 * Simulates an assistant working on the demo memory: reads, searches and writes are sent to a
 * running memglow server so you can watch the brain light up (nothing is modified on disk).
 *
 *   MEMGLOW_TOKEN=$(openssl rand -hex 32) MEMORY_DIR=./demo/memory node server.js   # terminal 1
 *   MEMGLOW_TOKEN=<same token> node demo/simulate.js [seconds=60]                   # terminal 2
 */
const fs = require("fs");
const path = require("path");

const BASE = (process.env.MEMGLOW_URL || "http://127.0.0.1:4747").replace(/\/+$/, "");
const TOKEN = process.env.MEMGLOW_TOKEN || "";
if (!TOKEN) { console.error("Set MEMGLOW_TOKEN (the same value the server uses)."); process.exit(1); }
const DIR = path.resolve(process.env.MEMORY_DIR || path.join(__dirname, "memory"));
const seconds = Number(process.argv[2]) || 60;

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
    // demo: true → animated, but not kept in the "recent activity" history
    body: JSON.stringify({ type, ids, source: "demo", demo: true }),
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
