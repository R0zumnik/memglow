"use strict";
// Real-bundle check: the page scripts (public/*.js) use window.MemglowGraph.THREE.X; page-smoke.test.js
// replaces three.js by a hand-written fake, which cannot notice a class the vendored bundle lacks
// (that is how a sibling project shipped a blank 3D page). Here the REAL bundle is loaded in a vm
// context with a minimal window/document stub (no WebGL) and every THREE.X the pages use must exist.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUB = path.join(__dirname, "..", "public");
const BUNDLE = path.join(PUB, "vendor", "memglow-graph.js");

// THREE.X names used by the page scripts (comments stripped, so prose such as
// "THREE.AdditiveBlending (not exported)" does not count). `scan` is exported for the scratch proof.
function usedThree(files) {
  const used = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/\bTHREE\.([A-Za-z_$][\w$]*)/g)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(path.basename(f));
    }
  }
  return used;
}

function loadBundle() {
  const el = () => ({ getContext: () => null, style: {}, addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
  const document = new Proxy({ createElement: el, createElementNS: el, createTextNode: () => ({}), addEventListener() {}, removeEventListener() {}, documentElement: { style: {} }, head: el(), body: el() },
    { get: (t, k) => (k in t ? t[k] : undefined) });
  const win = {};
  const ctx = { window: win, self: win, document, navigator: { userAgent: "node", platform: "node" }, requestAnimationFrame() {}, cancelAnimationFrame() {},
    console, setTimeout, clearTimeout, setInterval, clearInterval, performance, URL, TextDecoder, TextEncoder };
  win.window = win; win.document = document; win.navigator = ctx.navigator; win.setTimeout = setTimeout;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), ctx, { filename: "memglow-graph.js" });
  return win.MemglowGraph;
}

const FILES = fs.readdirSync(PUB).filter((f) => f.endsWith(".js")).map((f) => path.join(PUB, f));
const EXTRA = process.env.MEMGLOW_EXTRA_PAGE ? [process.env.MEMGLOW_EXTRA_PAGE] : []; // scratch proof only

test("real bundle: exports ForceGraph3D and THREE", () => {
  const MG = loadBundle();
  assert.ok(MG, "window.MemglowGraph is defined");
  assert.strictEqual(typeof MG.ForceGraph3D, "function");
  assert.ok(MG.THREE && typeof MG.THREE === "object");
});

test("real bundle: every THREE.X used by public/*.js is exported", () => {
  const T = loadBundle().THREE;
  const used = usedThree(FILES.concat(EXTRA));
  assert.ok(used.size >= 10, "the scan finds the classes the page uses (" + used.size + ")");
  const missing = [...used].filter(([k]) => T[k] === undefined).map(([k, f]) => k + " (used in " + [...new Set(f)].join(",") + ")");
  assert.deepStrictEqual(missing, [], "missing from the vendored bundle: " + missing.join("; "));
});

test("real bundle: classes the page constructs can be instantiated without WebGL", () => {
  const T = loadBundle().THREE;
  const geo = new T.BufferGeometry();
  const cases = {
    Color: () => new T.Color("#FFE7B8"), Vector2: () => new T.Vector2(1, 2), Group: () => new T.Group(),
    SphereGeometry: () => new T.SphereGeometry(1, 12, 8), BufferGeometry: () => geo,
    BufferAttribute: () => new T.BufferAttribute(new Float32Array(9), 3),
    MeshBasicMaterial: () => new T.MeshBasicMaterial({ color: new T.Color("#fff"), transparent: true }),
    LineBasicMaterial: () => new T.LineBasicMaterial({ vertexColors: true }),
    SpriteMaterial: () => new T.SpriteMaterial({ transparent: true }),
    Mesh: () => new T.Mesh(new T.SphereGeometry(1, 4, 4), new T.MeshBasicMaterial()),
    Line: () => new T.Line(geo, new T.LineBasicMaterial()), Sprite: () => new T.Sprite(new T.SpriteMaterial()),
  };
  for (const [name, make] of Object.entries(cases)) {
    assert.strictEqual(typeof T[name], "function", name + " is a constructor");
    assert.ok(make(), "new THREE." + name);
  }
  assert.strictEqual(typeof T.LinearFilter, "number");
  // CanvasTexture needs a canvas: construct it with a stub element.
  assert.ok(new T.CanvasTexture({ width: 4, height: 4 }));
});
