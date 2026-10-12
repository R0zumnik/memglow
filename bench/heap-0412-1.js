#!/usr/bin/env node
"use strict";
/**
 * memglow memory server — ad hoc heap measurement for 0.4.12.1 (one copy of note text in
 * memory). Loads a synthetic 300-note corpus into the store and reports process.memoryUsage()
 * before and after. Run with --expose-gc for a cleaner number (a GC right before each reading).
 *
 *   node --expose-gc bench/heap-0412-1.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeKb } = require("./responsiveness");
const { createStore } = require("../lib/store/store");

function heap() {
  if (typeof global.gc === "function") { global.gc(); global.gc(); }
  return process.memoryUsage().heapUsed;
}

const N = Number(process.argv[2]) || 300;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-heap-"));
makeKb(dir, N);

const before = heap();
const store = createStore({ root: dir, watch: false, pollMs: 0 });
store.start();
const notes = store.notes();
const after = heap();

console.log(JSON.stringify({
  notes: notes.length,
  heapBeforeLoad: before,
  heapAfterLoad: after,
  deltaBytes: after - before,
  deltaPerNoteBytes: Math.round((after - before) / notes.length),
}, null, 2));

fs.rmSync(dir, { recursive: true, force: true });
