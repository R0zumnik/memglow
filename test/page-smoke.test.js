"use strict";
// Smoke test of the page scripts (public/app.js, public/cost.js) in Node, with a fake DOM and a
// fake 3D library: catches reference errors and wiring mistakes that the pure tests cannot see.
// It does not render anything (no WebGL here).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const COST = fs.readFileSync(path.join(__dirname, "..", "public", "cost.js"), "utf8");

function fakeElement(id) {
  const listeners = {};
  return {
    id, value: "", checked: false, disabled: false, hidden: false, textContent: "", innerHTML: "", className: "",
    children: [], clientWidth: 800, clientHeight: 600, style: { setProperty() {}, removeProperty() {} },
    attrs: { "data-graphe": "/api/graph", "data-flux": "/api/stream", "data-note": "/api/note/", "data-cost": "/api/cost" },
    getAttribute(k) { return this.attrs[k] || null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, e) { (listeners[t] || []).forEach((f) => f(e || {})); },
    classList: { add() {}, remove() {} },
    appendChild(c) { this.children.push(c); }, insertBefore(c) { this.children.unshift(c); }, removeChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, remove() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    getContext: () => ({
      measureText: () => ({ width: 100 }), fillText() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      createRadialGradient: () => ({ addColorStop() {} }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    }),
    get firstChild() { return this.children[0] || null; }, get lastChild() { return null; },
    isConnected: true, tabIndex: 0,
  };
}

function fakeThree() {
  class Color {
    constructor() { this.r = this.g = this.b = 0.5; }
    set() { return this; } setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
    multiplyScalar() { return this; } lerp() { return this; } clone() { return new Color(); } copy() { return this; } equals() { return true; }
  }
  class Obj { constructor(g, m) { this.geometry = g; this.material = m || {}; this.scale = { setScalar() {}, set() {}, x: 1 }; this.position = { set() {}, y: 0 }; this.userData = {}; this.children = []; this.visible = true; this.parent = {}; }
    add(c) { this.children.push(c); } remove() {} }
  class Material { constructor(o) { Object.assign(this, o || {}); this.color = new Color(); this.opacity = (o && o.opacity) || 1; } dispose() {} }
  class Geometry { setAttribute() {} setDrawRange() {} dispose() {} }
  return {
    Color, Vector2: class {}, Vector3: class {}, SphereGeometry: Geometry, BufferGeometry: Geometry,
    BufferAttribute: class { constructor(a) { this.array = a; } }, MeshBasicMaterial: Material, SpriteMaterial: Material, LineBasicMaterial: Material,
    Mesh: Obj, Group: Obj, Sprite: class extends Obj { constructor(m) { super(null, m); } }, Line: Obj, CanvasTexture: class { dispose() {} }, LinearFilter: 1,
  };
}

function fakeGraph(state) {
  const scene = { add() {}, remove() {}, background: null };
  const chain = new Proxy({}, {
    get(t, k) {
      if (k === "scene") return () => scene;
      if (k === "camera") return () => ({ position: { x: 0, y: 0, z: 400, set() {} }, fov: 50, aspect: 1.3, lookAt() {} });
      if (k === "controls") return () => ({ autoRotate: false, target: { x: 0, y: 0, z: 0, set() {} }, addEventListener() {} });
      if (k === "postProcessingComposer") return () => ({ renderTarget1: null, renderTarget2: null, addPass() {} });
      if (k === "d3Force") return (name, f) => {
        if (f) { state.forces[name] = f; return chain; }
        const force = { strength() { return force; }, distance() { return force; } };
        return force;
      };
      if (k === "graphData") return (d) => {
        if (d) { state.data = d; d.nodes.forEach((n) => { if (state.objet) state.objet(n); n.x = Math.random() * 100; n.y = 0; n.z = 0; n.vx = n.vy = n.vz = 0; }); return chain; }
        return state.data;
      };
      if (k === "nodeThreeObject") return (f) => { state.objet = f; if (state.data) state.data.nodes.forEach(f); return chain; };
      if (k === "onBackgroundClick") return (f) => { state.backgroundClick = f; return chain; };
      if (k === "nodeVisibility" || k === "linkVisibility") return (f) => (f ? chain : () => true);
      return () => chain;
    },
  });
  return chain;
}

const GRAPH = {
  available: true,
  nodes: [
    { id: "MEMORY", label: "Memory", theme: "index", subtheme: "", mtime: Date.now(), tokens: 800 },
    { id: "a", label: "A <b>", theme: "people", subtheme: "general", mtime: Date.now(), tokens: 120 },
    { id: "b", label: "B", theme: "projects", subtheme: "web", mtime: Date.now() - 9e8, tokens: 6200 },
  ],
  links: [{ source: "MEMORY", target: "a" }, { source: "a", target: "b" }],
  activities: [{ type: "read", ids: ["a"], source: "test", t: Date.now() }],
};
const COST_DATA = {
  largeNoteTokens: 5000, chunkTokens: 2000, since: "2026-09-30", totals: { notes: 2, tokens: 6320 }, index: { id: "MEMORY", label: "Memory", tokens: 800 },
  read: { today: 6200, days7: 6200 }, written: { today: 0, days7: 0 },
  top: [{ id: "b", label: "B", theme: "projects", subtheme: "web", folder: "p", tokens: 6200, reads7: 1, readTokens7: 6200 }],
  share: { notes: 1, tokens: 6200, total: 6200, percent: 100 },
  tooLarge: [{ id: "b", label: "B", theme: "projects", subtheme: "web", folder: "p", tokens: 6200, reads7: 1, readTokens7: 6200 }],
  neverRead: { available: false, since: "2026-09-30", notes: [], total: 0 }, sectionsIncluded: false,
};

test("page scripts run: graph loads, settings apply, animation ticks, Memory cost renders", async () => {
  const els = {};
  const docListeners = {};
  const state = { forces: {} };
  const frames = [];
  const storage = { "memglow.taille": "jetons", "memglow.fond": "nuit", "memglow.masquesThemes": '{"famille":true,"people":true}' };
  const document = {
    getElementById: (id) => (id === "memglow-config"
      ? { textContent: JSON.stringify({ themes: [{ id: "people", label: "People", color: "#2EE89B" }, { id: "projects", label: "Projects", color: "#8FA8FF" }], showBodies: true }) }
      : els[id] || (els[id] = fakeElement(id))),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => fakeElement("x"),
    hidden: false,
    body: fakeElement("body"),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    dispatchEvent(e) { (docListeners[e.type] || []).forEach((f) => f(e)); },
  };
  const fetched = [];
  const window = {
    MemglowGraph: { ForceGraph3D: () => () => fakeGraph(state), UnrealBloomPass: class { constructor() { this.strength = 0; } }, THREE: fakeThree() },
    matchMedia: () => ({ matches: false }), devicePixelRatio: 1, addEventListener() {}, isSecureContext: true,
  };
  const ctx = {
    window, document, console, Math, JSON, Date, Promise, Array, Object, String, Number, isFinite, parseFloat, Uint8ClampedArray, Float32Array,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; } },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (f) => frames.push(f),
    setTimeout: (f) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    navigator: {},
    fetch: (url) => {
      fetched.push(url);
      const body = url === "/api/graph" ? GRAPH : url === "/api/cost" ? COST_DATA : null;
      return Promise.resolve({ ok: !!body, status: body ? 200 : 404, json: () => Promise.resolve(body) });
    },
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(APP, ctx, { filename: "app.js" });
  vm.runInContext(COST, ctx, { filename: "cost.js" });
  await new Promise((ok) => setImmediate(ok));
  await new Promise((ok) => setImmediate(ok));

  assert.ok(fetched.includes("/api/graph") && fetched.includes("/api/cost"));
  assert.strictEqual(els["mem-etat"].textContent, "", "no error message shown");
  assert.strictEqual(els["mem-nb-notes"].textContent, "3");
  assert.ok(state.forces.collision && state.forces.themes, "custom forces installed");
  assert.strictEqual(els["mem-taille"].value, "jetons", "saved 'Size by' restored");
  assert.strictEqual(els["mem-fond"].value, "nuit", "saved background restored");
  assert.strictEqual(storage["memglow.masquesThemes"], '{"famille":true,"people":true}', "not rewritten on load");

  // A few animation frames, a collision step, the settings, a double-click on the background.
  assert.ok(frames.length > 0, "animation loop started");
  for (let i = 0; i < 3; i++) frames.shift()(Date.now() + i * 16);
  state.forces.collision.initialize(state.data.nodes);
  state.forces.collision();
  els["mem-facteur"].value = "2"; els["mem-facteur"].fire("input");
  els["mem-vitesse"].value = "0.5"; els["mem-vitesse"].fire("input");
  els["mem-dist-noms"].value = "5"; els["mem-dist-noms"].fire("input");
  els["mem-taille"].value = "liens"; els["mem-taille"].fire("change");
  els["mem-fond"].value = "profond"; els["mem-fond"].fire("change");
  assert.deepStrictEqual([storage["memglow.facteurTaille"], storage["memglow.vitesse"], storage["memglow.distNoms"], storage["memglow.taille"], storage["memglow.fond"]], ["2", "0.5", "5", "liens", "profond"]);
  state.backgroundClick(); state.backgroundClick();
  window.__memglowDemo.activite({ type: "write", ids: ["b"], source: "test", t: Date.now() });
  frames.shift()(Date.now() + 100);

  // Memory cost panel filled, and a click on a row opens the note.
  const body = els["mg-cost-body"];
  assert.match(body.innerHTML, /Most expensive to read/);
  assert.match(body.innerHTML, /data-copy="b"/);
  let opened = null;
  document.addEventListener("memglow:ouvrir", (e) => { opened = e.detail; });
  body.fire("click", { target: { closest: (sel) => (sel === "[data-note]" ? { getAttribute: () => "b" } : null) } });
  assert.strictEqual(opened, "b");
});

function viewContext({ storage, fetch, config }) {
  const els = {};
  const docListeners = {};
  const state = { forces: {} };
  const timers = [];
  const document = {
    getElementById: (id) => (id === "memglow-config" ? { textContent: JSON.stringify(config || {}) } : els[id] || (els[id] = fakeElement(id))),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: () => fakeElement("x"),
    hidden: false,
    body: fakeElement("body"),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    dispatchEvent(e) { (docListeners[e.type] || []).forEach((f) => f(e)); },
  };
  els["mem-graphe"] = fakeElement("mem-graphe");
  els["mem-graphe"].attrs["data-vue"] = "/api/view";
  const window = {
    MemglowGraph: { ForceGraph3D: () => () => fakeGraph(state), UnrealBloomPass: class { constructor() { this.strength = 0; } }, THREE: fakeThree() },
    matchMedia: () => ({ matches: false }), devicePixelRatio: 1, addEventListener() {}, isSecureContext: true, fetch: true,
  };
  const ctx = {
    window, document, console, Math, JSON, Date, Promise, Array, Object, String, Number, isFinite, parseFloat, Uint8ClampedArray, Float32Array,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; } },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    navigator: {},
    fetch,
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(APP, ctx, { filename: "app.js" });
  return { els, timers, state };
}
const ticks = async (n) => { for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok)); };
const THEMES_CFG = { themes: [{ id: "people", label: "People", color: "#2EE89B" }, { id: "projects", label: "Projects", color: "#8FA8FF" }], showBodies: true };

test("page scripts: the saved view is read first, applied, and saved back with memglow's header", async () => {
  const storage = { "memglow.fond": "profond" };
  const SAVED = {
    settings: { background: "night", names: "all", spread: 9 },
    positions: { a: [10, 20, 30], "~people/general": [1, 2, 3] }, pinned: ["a"],
    camera: { position: [0, 0, 300], target: [0, 0, 0] }, updated: 1,
  };
  const calls = [];
  const fetch = (url, o) => {
    calls.push({ url, o: o || {} });
    const body = url === "/api/graph" ? GRAPH : url === "/api/view" && !(o && o.method) ? SAVED : null;
    return Promise.resolve({ ok: !!body, status: body ? 200 : 204, json: () => Promise.resolve(body) });
  };
  const { els, timers } = viewContext({ storage, fetch, config: THEMES_CFG });
  await ticks(6);

  assert.strictEqual(calls[0].url, "/api/view", "the view is read before the graph");
  assert.ok(calls.some((c) => c.url === "/api/graph"));
  assert.strictEqual(els["mem-fond"].value, "nuit", "server settings win over the local cache");
  assert.strictEqual(storage["memglow.fond"], "nuit", "and fill the local cache");
  assert.strictEqual(els["mem-noms"].value, "tous");
  assert.ok(JSON.parse(storage["memglow.view"]).positions.a, "layout cached locally");

  // A setting changes: one PUT, 500 ms later, with memglow's header and typed English keys.
  els["mem-fond"].value = "uni"; els["mem-fond"].fire("change");
  timers.filter((x) => x.ms === 500).pop().f();
  const putCall = calls.find((c) => c.o.method === "PUT");
  assert.ok(putCall, "PUT sent");
  assert.strictEqual(putCall.o.headers["X-Memglow"], "1");
  const sent = JSON.parse(putCall.o.body);
  assert.strictEqual(sent.settings.background, "plain");
  assert.strictEqual(sent.settings.names, "all");

  // "Rearrange": reset sent, local layout cache cleared, settings untouched.
  els["mem-reorganiser"].fire("click");
  const reset = calls.filter((c) => c.o.method === "PUT").map((c) => JSON.parse(c.o.body)).find((b) => b.reset === true);
  assert.ok(reset && !reset.settings, "reset sent, settings kept");
  assert.strictEqual(storage["memglow.view"], undefined);
});

test("page scripts: no answer from the server in 2.5 s, the local cache is used", async () => {
  const storage = { "memglow.fond": "nuit" };
  const fetch = (url) => (url === "/api/view" ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => Promise.resolve(GRAPH) }));
  const { els, timers } = viewContext({ storage, fetch, config: THEMES_CFG });
  await ticks(2);
  assert.strictEqual(els["mem-fond"], undefined, "waiting for the view");
  timers.find((x) => x.ms === 2500).f();
  await ticks(4);
  assert.strictEqual(els["mem-fond"].value, "nuit", "local settings used");
  assert.strictEqual(els["mem-nb-notes"].textContent, "3", "graph loaded");
});
