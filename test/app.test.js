"use strict";
// Pure pieces of public/app.js (no DOM, no WebGL): signal speed, link level, minimum on-screen
// size, bubble size, backgrounds, name fading, spacing vs gravity, saved hidden themes.
const test = require("node:test");
const assert = require("node:assert");
const M = require("../public/app.js");

const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test("signal speed: 1.8 s per link by default, bounded, ambient flow 2.4× slower", () => {
  assert.strictEqual(M.dureeComete(1), 1800);
  assert.strictEqual(M.dureeComete(), 1800);
  assert.strictEqual(M.dureeComete(2), 900);
  assert.strictEqual(M.dureeComete(0.5), 3600);
  assert.strictEqual(M.dureeComete(10), 900, "max ×2");
  assert.strictEqual(M.dureeComete(0.01), 6000, "min ×0.3");
  assert.strictEqual(M.dureeComete("x"), 1800);
  assert.strictEqual(M.dureeComete(1, true), 4320);
});

test("links: dark while a comet flies, then a fading trace", () => {
  assert.strictEqual(M.niveauLien({ propre: 1, actA: 1.2, actB: 1, enVol: true }), 0);
  assert.ok(close(M.niveauLien({ actA: 1 }), 0.3));
  assert.ok(close(M.niveauLien({ actA: 1, relais: true }), 0.45));
  assert.ok(close(M.niveauLien({ propre: 0.9, actA: 1 }), 0.9), "clicked note: clearly lit");
  assert.strictEqual(M.niveauLien({ propre: 3 }), 1);

  const env = M.creerEnveloppe();
  const link = {}, arrival = M.dureeComete(1);
  env.activer(link, 0.35, 250, arrival);
  const level = (t, act) => M.niveauLien({ propre: link.__env ? env.niveau(link, t) : 0, actA: act || 0, enVol: t < arrival });
  let maxInFlight = 0;
  for (let t = 0; t < arrival; t += 20) maxInFlight = Math.max(maxInFlight, level(t, 1.2));
  assert.strictEqual(maxInFlight, 0, "resting level for the whole flight");
  assert.ok(level(arrival + 150) > 0.34 && level(arrival + 150) <= 0.35 + 1e-9, "trace rises at arrival");
  assert.ok(level(arrival + 1000) > level(arrival + 2000) && level(arrival + 2000) > 0, "then fades");
  assert.ok(close(level(arrival + 2900), 0) && env.finie(link, arrival + 2900));
});

test("comets keep the requested duration", () => {
  let clock = 0;
  const seen = [];
  const c = M.creerCometes({ maintenant: () => clock, fabrique: () => ({ montrer() {}, tete(x) { seen.push(x); }, trainee() {}, liberer() {} }) });
  const d = M.dureeComete(1);
  c.lancer({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, [1, 1, 1], { duree: d, longueur: 0.38 });
  clock = d / 2; c.tic();
  assert.ok(seen.at(-1) > 30 && seen.at(-1) < 70);
  clock = d; c.tic();
  assert.ok(close(seen.at(-1), 100));
  clock = d + 460; c.tic();
  assert.deepStrictEqual([c.etat().actives, c.etat().libres], [0, 1]);
});

test("minimum on-screen size: unchanged close up, ≥ minPx from afar", () => {
  const tan = Math.tan(50 * Math.PI / 360);
  assert.deepStrictEqual(M.plancherRayon(3, 100, tan, 900, 2.4), { rayon: 3, lointain: 0 });
  const far = M.plancherRayon(3, 5000, tan, 900, 2.4);
  assert.ok(close(far.rayon * 450 / (5000 * tan), 2.4, 1e-9));
  assert.ok(far.lointain > 0 && far.lointain <= 1);
  assert.strictEqual(M.plancherRayon(3, 0, tan, 900, 2).rayon, 3);
});

test("bubble size: factor, size by links or tokens, index is the sun", () => {
  const maxNote = (f) => Math.max(M.rayonNote({ mode: "liens", degre: 60, facteur: f }), M.rayonNote({ mode: "jetons", jetons: 1e9, facteur: f }));
  for (const f of [0.5, 1, 3]) assert.ok(M.rayonNote({ estIndex: true, facteur: f }) >= 1.5 * maxNote(f), "index ≥ 1.5 × the largest note at ×" + f);
  assert.ok(close(M.rayonNote({ mode: "liens", degre: 4 }), 1.6 + 2 * 0.9));
  assert.ok(close(M.rayonNote({ mode: "liens", degre: 4, facteur: 2 }), 2 * 3.4));
  assert.ok(close(M.rayonNote({ mode: "jetons", jetons: 10000, facteur: 2 }), 2 * 7));
  assert.strictEqual(M.rayonNote({ mode: "jetons", jetons: 0 }), 1.2, "lower bound");
  assert.ok(M.rayonNote({ mode: "jetons", jetons: 5000 }) > M.rayonNote({ mode: "jetons", jetons: 500 }), "a costlier note is bigger");
  assert.deepStrictEqual([M.facteurTaille(9), M.facteurTaille(0.1), M.facteurTaille("x"), M.facteurTaille(0)], [3, 0.5, 1, 1]);
  assert.ok(close(M.rayonRelais(3), 3.4 * 2) && close(M.rayonRelais(1), 3.4));
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

test("backgrounds: dark presets stay very dark (below the glow threshold), deep by default", () => {
  const tints = [];
  Object.entries(M.FONDS).filter(([id]) => id !== "clair").forEach(([, f]) => ["uni", "centre", "milieu", "bord"].forEach((k) => f[k] && tints.push(lum(f[k]))));
  assert.ok(Math.max(...tints) < 0.03);
  assert.deepStrictEqual([M.fondValide("nuit"), M.fondValide("clair"), M.fondValide("__inconnu__")], ["nuit", "clair", "profond"]);
  assert.strictEqual(M.FONDS.uni.uni, "#04120F");
});

test("background Light: a bright, flagged exception — glow raised above it and cut to a trace", () => {
  const c = M.FONDS.clair;
  assert.strictEqual(c.clair, true);
  ["uni", "centre", "milieu", "bord"].forEach((k) => assert.ok(lum(c[k]) > 0.7, k + " is a light tint"));
  assert.strictEqual(c.etoiles, 0, "no star dust against a bright sky");
  assert.ok(c.seuilLueur > Math.max(lum(c.uni), lum(c.centre), lum(c.milieu), lum(c.bord)), "bloom threshold stays above the background's own luminance");
  assert.ok(c.coefLueur < 0.5, "glow cut to a trace");
  // Every other preset is untouched.
  ["profond", "uni", "nuit"].forEach((id) => assert.ok(!M.FONDS[id].clair));
});

test("teinteLisible: darkens a colour for Light, same hue, leaves everything else alone", () => {
  assert.strictEqual(M.teinteLisible("#2EE89B", false), "#2EE89B", "unchanged outside clair mode");
  assert.strictEqual(M.teinteLisible("not-a-color", true), "not-a-color", "unparsable hex left alone");
  const already = "#123456";
  assert.strictEqual(M.teinteLisible(already, true, 0.9), already, "already dark enough: unchanged");
  const d = M.teinteLisible("#2EE89B", true, 0.24);
  assert.ok(lum(d) <= 0.24 + 0.01, "darkened at or under the target luminance (within hex rounding)");
  assert.ok(lum(d) < lum("#2EE89B"), "actually darker");
  // Same hue: uniform RGB scaling keeps the ratio between channels (within rounding).
  const r = parseInt(d.slice(1, 3), 16), g = parseInt(d.slice(3, 5), 16), b = parseInt(d.slice(5, 7), 16);
  assert.ok(Math.abs(r / g - 0x2e / 0xe8) < 0.02, "hue preserved (r/g ratio)");
  // The default threshold (0.24) keeps a healthy contrast against Light's brightest tint.
  const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const bg = lum(M.FONDS.clair.centre);
  [M.teinteLisible("#2EE89B", true), M.teinteLisible("#8FA8FF", true), M.teinteLisible("#A9C9BF", true)]
    .forEach((hex) => assert.ok(contrast(lum(hex), bg) >= 3, hex + " reads against the Light background"));
});

test("CIBLE_COULEUR_CLAIR and COULEUR_CLAIR_INDEX: same hue family as the dark presets, dark enough to read", () => {
  const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const bg = lum(M.FONDS.clair.centre);
  assert.deepStrictEqual(Object.keys(M.CIBLE_COULEUR_CLAIR).sort(), Object.keys(M.CIBLE_COULEUR).sort());
  Object.values(M.CIBLE_COULEUR_CLAIR).forEach((hex) => assert.ok(contrast(lum(hex), bg) >= 3, hex));
  assert.ok(contrast(lum(M.COULEUR_CLAIR_INDEX), bg) >= 3);
});

test("name distance: full up to the threshold, gone at 1.35×", () => {
  assert.strictEqual(M.opaciteNom(1e9, Infinity), 1);
  assert.strictEqual(M.opaciteNom(100, 100), 1);
  assert.strictEqual(M.opaciteNom(135, 100), 0);
  assert.ok(M.opaciteNom(110, 100) > M.opaciteNom(125, 100));
});

// Small simulation: every bubble is pulled hard towards the centre (maximum gravity) and the
// collision force keeps them apart. Minimum spacing must win over gravity.
function simulate(margin, spread, pull) {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const nodes = [];
  for (let i = 0; i < 40; i++) nodes.push({ x: rnd() * 200 - 100, y: rnd() * 200 - 100, z: rnd() * 200 - 100, vx: 0, vy: 0, vz: 0, r: 3 });
  const force = M.creerCollision((n) => n.r, () => M.margeEffective(margin, spread));
  force.initialize(nodes);
  for (let step = 0; step < 400; step++) {
    for (const n of nodes) { n.vx -= n.x * pull; n.vy -= n.y * pull; n.vz -= n.z * pull; }
    force();
    for (const n of nodes) { n.vx *= 0.6; n.vy *= 0.6; n.vz *= 0.6; n.x += n.vx; n.y += n.vy; n.z += n.vz; }
  }
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - a.r - b.r);
  }
  return min;
}

test("spacing: relative to the spread, and it wins over gravity", () => {
  assert.strictEqual(M.margeEffective(8, 7), 42);
  assert.strictEqual(M.margeEffective(0, 7), 0);
  assert.strictEqual(M.margeEffective(-3, 7), 0);
  const gaps = [0, 4, 10, 20].map((m) => simulate(m, 7, 0.05));
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1], "more spacing, bigger gaps: " + gaps.join(", "));
  assert.ok(gaps[2] > 0.6 * M.margeEffective(10, 7), "most of the requested margin is kept under strong gravity: " + gaps[2]);
});

test("hidden themes: only themes of this configuration are kept", () => {
  assert.deepStrictEqual(M.masquesValides({ people: true, famille: true, index: true, other: true, x: false }, ["people", "projects"]), { people: true, index: true, other: true });
  assert.deepStrictEqual(M.masquesValides(null, ["a"]), {});
});
