#!/usr/bin/env node
"use strict";
/**
 * Builds demo/apercu.html: a single self-contained HTML file (no server needed) showing the demo
 * memory with simulated assistant activity. Handy for a GitHub Pages demo or a quick look.
 *
 *   node demo/build-preview.js [memoryDir=./demo/memory]
 */
const fs = require("fs");
const path = require("path");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const { createCounters } = require("../lib/counters");

const ROOT = path.join(__dirname, "..");
const dir = path.resolve(process.argv[2] || path.join(__dirname, "memory"));
const config = loadConfig({ MEMORY_DIR: dir }, ROOT);
const memory = createMemory({ dir, config });
// Counters kept in memory only: the preview never reads nor writes ~/.memglow.
const server = createServer(config, memory, { counters: createCounters({}) });

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let html = await (await fetch(base + "/")).text();
    const graph = await (await fetch(base + "/api/graph")).json();
    graph.activities = [];
    const cost = await (await fetch(base + "/api/cost")).json();
    const notes = {};
    for (const n of graph.nodes) notes[n.id] = await (await fetch(base + "/api/note/" + encodeURIComponent(n.id))).json();
    const read = (f) => fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    const safe = (js) => js.replace(/<\/script/gi, "<\\/script");

    // Offline shims: fetch() answers from the embedded data, EventSource does nothing, and a
    // small loop replays read / search / write activity through the page's own demo hook.
    const shim = `
window.__MEMGLOW_DATA__ = ${JSON.stringify({ graph, notes, cost }).replace(/</g, "\\u003c")};
(function () {
  var D = window.__MEMGLOW_DATA__;
  var json = function (o) { return Promise.resolve({ ok: !!o, status: o ? 200 : 404, json: function () { return Promise.resolve(o); } }); };
  window.fetch = function (u) {
    u = String(u);
    if (u.indexOf("/api/graph") === 0) return json(D.graph);
    if (u.indexOf("/api/cost") === 0) return json(D.cost);
    if (u.indexOf("/api/note/") === 0) return json(D.notes[decodeURIComponent(u.slice(10))] || null);
    return json(null);
  };
  window.EventSource = function () { this.addEventListener = function () {}; this.close = function () {}; };
})();`;
    const sim = `
(function () {
  var ids = window.__MEMGLOW_DATA__.graph.nodes.map(function (n) { return n.id; }).filter(function (i) { return i !== "MEMORY"; });
  function pick(k) { return ids.slice().sort(function () { return Math.random() - 0.5; }).slice(0, k); }
  var steps = [["search", 5], ["read", 1], ["write", 1], ["search", 4], ["read", 1], ["read", 1], ["write", 1]];
  var i = 0;
  function next() {
    var d = window.__memglowDemo;
    if (d) { var s = steps[i++ % steps.length]; d.activite({ type: s[0], ids: pick(s[1]), source: "demo", t: Date.now() }); }
    setTimeout(next, 2500 + Math.random() * 2000);
  }
  setTimeout(next, 3000);
})();`;
    html = html
      .replace(/<link rel="stylesheet" href="\/app\.css[^"]*">/, () => `<style>${read("app.css")}</style>`)
      .replace(/<script src="\/vendor\/memglow-graph\.js[^"]*"><\/script>/, () => `<script>${shim}</script><script>${safe(read("vendor/memglow-graph.js"))}</script>`)
      .replace(/<script src="\/app\.js[^"]*"><\/script>/, () => `<script>${safe(read("app.js"))}</script><script>${sim}</script>`)
      .replace(/<script src="\/cost\.js[^"]*"><\/script>/, () => `<script>${safe(read("cost.js"))}</script>`);
    const out = path.join(__dirname, "apercu.html");
    fs.writeFileSync(out, html);
    console.log(`preview written: ${out} (${(html.length / 1024).toFixed(0)} KB, ${graph.nodes.length} notes, ${graph.links.length} links)`);
  } finally { server.close(); }
});
