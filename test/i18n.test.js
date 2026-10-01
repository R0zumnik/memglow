"use strict";
// i18n: public/i18n/<code>.json (all 8 languages, exactly en's keys), public/i18n.js (interpolation,
// plural selection, browser-language detection), the "language" setting end to end (lib/view.js,
// public/app.js VIEW_SETTINGS, server.js static files), the small per-page English fallbacks
// (app.js/cost.js/assistant.js) kept in sync with public/i18n/en.json, and a scan for English text
// left hardcoded in the page files instead of going through a translation key.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const i18n = require("../public/i18n.js");
const view = require("../lib/view");
const appPage = require("../public/app.js");
const costPage = require("../public/cost.js");
const aiPage = require("../public/assistant.js");
const zonesPage = require("../public/zones.js");

const PUBLIC = path.join(__dirname, "..", "public");
const LANGS = ["en", "fr", "de", "es", "pt-BR", "ja", "ko", "zh-CN"];

function loadLang(code) {
  return JSON.parse(fs.readFileSync(path.join(PUBLIC, "i18n", `${code}.json`), "utf8"));
}
function keysOf(dict) {
  return Object.keys(dict).filter((k) => k !== "_meta").sort();
}

// ---- every language file: same keys as en.json ----

test("i18n: every language ships exactly en.json's keys, no more, no less", () => {
  const en = loadLang("en");
  const ref = keysOf(en);
  assert.ok(ref.length > 100, "sanity: a real dictionary, not a stub");
  for (const code of LANGS) {
    const dict = loadLang(code);
    assert.deepStrictEqual(keysOf(dict), ref, `${code}.json keys must match en.json exactly`);
    assert.ok(dict._meta && dict._meta.name && dict._meta.autonym, `${code}.json needs _meta.name/autonym`);
    // Every value is a non-empty string, or a plural object with at least "other" (CLDR plural-less
    // languages — ja/ko/zh-CN — may give a single string for a key that is plural in other files).
    for (const k of ref) {
      const v = dict[k];
      if (v && typeof v === "object") {
        assert.ok(typeof v.other === "string" && v.other.length, `${code}.json["${k}"].other`);
      } else {
        assert.ok(typeof v === "string" && v.length, `${code}.json["${k}"] must be a non-empty string`);
      }
    }
  }
});

test("i18n: a translation keeps every {placeholder} the English reference uses", () => {
  // Not a translation-quality check (out of scope), just that no {param} was dropped or mistyped —
  // which would silently leave the literal "{xyz}" in the UI forever in that language.
  const en = loadLang("en");
  const placeholdersOf = (v) => {
    const s = typeof v === "object" ? (v.other || v.one || "") : String(v || "");
    return (s.match(/\{(\w+)\}/g) || []).sort();
  };
  for (const code of LANGS) {
    if (code === "en") continue;
    const dict = loadLang(code);
    for (const k of keysOf(en)) {
      const want = placeholdersOf(en[k]);
      if (!want.length) continue;
      const got = placeholdersOf(dict[k]);
      assert.deepStrictEqual(got, want, `${code}.json["${k}"] placeholders`);
    }
  }
});

// ---- public/i18n.js: pure engine ----

test("i18n: resolveText interpolates {name} and picks one/other by params.n", () => {
  const dict = {
    "a.b": "hello {name}",
    "a.plural": { one: "{n} note", other: "{n} notes" },
    "a.single": "{n} link", // a language with no plural distinction may give one string
  };
  assert.strictEqual(i18n.resolveText(dict, "a.b", { name: "world" }), "hello world");
  assert.strictEqual(i18n.resolveText(dict, "a.b"), "hello {name}", "missing param: placeholder left as-is");
  assert.strictEqual(i18n.resolveText(dict, "a.plural", { n: 1 }), "1 note");
  assert.strictEqual(i18n.resolveText(dict, "a.plural", { n: 0 }), "0 notes");
  assert.strictEqual(i18n.resolveText(dict, "a.plural", { n: 5 }), "5 notes");
  assert.strictEqual(i18n.resolveText(dict, "a.single", { n: 1 }), "1 link", "plural-less language: single string used for n=1 too");
  assert.strictEqual(i18n.resolveText(dict, "a.single", { n: 3 }), "3 link");
  assert.strictEqual(i18n.resolveText(dict, "missing.key"), "missing.key", "unknown key: the key itself, visible");
  assert.strictEqual(i18n.resolveText(null, "x"), "x");
});

test("i18n: pickLanguage — exact match, then same-prefix, then fallback", () => {
  const sup = i18n.SUPPORTED_LANGS;
  assert.strictEqual(i18n.pickLanguage(sup, ["pt-BR"], "en"), "pt-BR");
  assert.strictEqual(i18n.pickLanguage(sup, ["PT-br"], "en"), "pt-BR", "case-insensitive");
  assert.strictEqual(i18n.pickLanguage(sup, ["fr-CA", "en-US"], "en"), "fr", "same-prefix match");
  assert.strictEqual(i18n.pickLanguage(sup, ["zh-Hant-TW"], "en"), "zh-CN", "only Chinese file shipped");
  assert.strictEqual(i18n.pickLanguage(sup, ["it-IT", "ru-RU"], "en"), "en", "nothing matches: fallback");
  assert.strictEqual(i18n.pickLanguage(sup, [], "en"), "en");
  assert.strictEqual(i18n.pickLanguage(sup, ["en-GB", "fr"], "en"), "en", "first browser language wins when supported");
  assert.deepStrictEqual(i18n.SUPPORTED_LANGS, LANGS, "the shipped language list");
});

// ---- the "language" setting end to end ----

test("i18n: lib/view.js accepts only the shipped language codes", () => {
  const rules = view.createRules({ themeIds: [], noteExists: () => false });
  for (const code of LANGS) {
    assert.deepStrictEqual(view.validateSettings({ language: code }, rules), { language: code }, code);
  }
  for (const bad of ["en-US", "fr_FR", "klingon", "", 1, null, ["fr"], "EN"]) {
    assert.deepStrictEqual(view.validateSettings({ language: bad }, rules), {}, `rejected: ${JSON.stringify(bad)}`);
  }
});

test("i18n: public/app.js VIEW_SETTINGS.langue round-trips through the same codes as lib/view.js", () => {
  const def = appPage.VIEW_SETTINGS.langue;
  assert.ok(def, "VIEW_SETTINGS must declare the language setting");
  assert.strictEqual(def[0], "language");
  assert.strictEqual(def[1], "choice");
  assert.deepStrictEqual(Object.keys(def[2]).sort(), LANGS.slice().sort());
  assert.deepStrictEqual(Object.values(def[2]).sort(), view.SETTINGS.language.values.slice().sort());
  const typed = appPage.settingsFromLocal((k) => (k === "langue" ? "de" : null));
  assert.deepStrictEqual(typed, { language: "de" });
  assert.deepStrictEqual(appPage.settingsToLocal({ language: "ja" }), { langue: "ja" });
});

test("i18n: server.js serves every language file and the loader, with the page's security headers", async () => {
  const os = require("os");
  const { createServer } = require("../server");
  const { createMemory } = require("../lib/memory");
  const { loadConfig } = require("../lib/config");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-i18n-"));
  fs.writeFileSync(path.join(dir, "a.md"), "# A\n");
  const config = loadConfig({ MEMORY_DIR: dir });
  const memory = createMemory({ dir: config.memoryDir, config });
  const server = createServer(config, memory);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const code of LANGS) {
      const r = await fetch(`${base}/i18n/${code}.json`);
      assert.strictEqual(r.status, 200, code);
      assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff", code);
      assert.match(r.headers.get("content-type") || "", /application\/json/, code);
      const body = await r.json();
      assert.deepStrictEqual(keysOf(body), keysOf(loadLang("en")), code);
    }
    const loader = await fetch(`${base}/i18n.js`);
    assert.strictEqual(loader.status, 200);
    assert.strictEqual(loader.headers.get("x-content-type-options"), "nosniff");
    const missing = await fetch(`${base}/i18n/klingon.json`);
    assert.strictEqual(missing.status, 404);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- per-page English fallbacks kept in sync with public/i18n/en.json ----

test("i18n: app.js/cost.js/assistant.js/zones.js English fallbacks match public/i18n/en.json exactly", () => {
  const en = loadLang("en");
  for (const [name, dict] of [["app.js EN_APP", appPage.EN_APP], ["cost.js EN_COST", costPage.EN_COST], ["assistant.js EN_AI", aiPage.EN_AI], ["zones.js EN_ZONES", zonesPage.EN_ZONES]]) {
    for (const k of Object.keys(dict)) {
      assert.ok(Object.prototype.hasOwnProperty.call(en, k), `${name}: "${k}" is not a real en.json key`);
      assert.deepStrictEqual(dict[k], en[k], `${name}: "${k}" has drifted from en.json`);
    }
  }
});

test("i18n: defaultT helpers resolve English outside a browser (Node require, no window)", () => {
  assert.strictEqual(appPage.defaultT("theme.index"), "Index");
  assert.strictEqual(appPage.defaultT("stats.notesWord", { n: 1 }), "note");
  assert.strictEqual(costPage.defaultCostT("cost.copyPrompt"), "Copy prompt for your AI");
  assert.strictEqual(aiPage.defaultAiT("ai.undo"), "Undo");
  assert.strictEqual(zonesPage.defaultZonesT("zones.protect"), "Protect");
  assert.strictEqual(zonesPage.defaultZonesT("zones.notesCount", { n: 1 }), "1 note");
});

// ---- no English left hardcoded where a translation key should be ----

test("i18n: no hardcoded English UI text remains outside the English fallback blocks", () => {
  // A representative sample of strings that lived directly in the page source before i18n: if any
  // of these show up again outside the designated EN_* fallback block or data-i18n attribute value,
  // something was translated by adding a key but not actually wired to it.
  const STRINGS = [
    "Loading the graph…", "No notes yet.", "The graph library could not load.",
    "Could not load the memory. Reload the page.", "No matching note.",
    "Release all bubbles", "Group by theme", "Find a note",
    "Written \" + ", "+ \" outgoing link", // old string-concatenation patterns, must be gone
    "Most expensive to read · 7 days", "Copy prompt for your AI", "Do it with Claude",
    "Never read in 30 days", "Memory cost is not available.",
    "memglow refused this proposal", "The assistant is not available.", "Ready — provider: \" +",
  ];
  const files = {
    "public/app.js": stripBlock(read("public/app.js"), "var EN_APP = {", "};"),
    "public/cost.js": stripBlock(read("public/cost.js"), "var EN_COST = {", "};"),
    "public/assistant.js": stripBlock(read("public/assistant.js"), "var EN_AI = {", "};"),
    "public/zones.js": stripBlock(read("public/zones.js"), "var EN_ZONES = {", "};"),
  };
  for (const [file, text] of Object.entries(files)) {
    for (const s of STRINGS) {
      assert.ok(!text.includes(s), `${file} still has hardcoded "${s}" outside its English fallback`);
    }
  }
  // Static HTML: every former hardcoded phrase should now be the data-i18n *default* content (fine,
  // it's what shows before JS runs) but must be paired with a data-i18n attribute right next to it.
  // Every occurrence is checked: the element (tag) the phrase sits in must carry data-i18n or
  // data-i18n-attr — a long translated paragraph that mentions "Settings" counts, a bare one not.
  const index = read("public/index.html");
  for (const phrase of [
    "Loading the graph…", "Settings", "Find a note", "Release all bubbles", "Live activity",
    "What are your big themes?", "Protected groups", "Not now", "Light",
  ]) {
    let i = index.indexOf(phrase);
    assert.ok(i >= 0, `index.html should still show "${phrase}" as the pre-JS default`);
    for (; i >= 0; i = index.indexOf(phrase, i + phrase.length)) {
      const tag = index.slice(index.lastIndexOf("<", i), index.indexOf(">", index.lastIndexOf("<", i)) + 1);
      assert.ok(/data-i18n(-attr)?=/.test(tag), `"${phrase}" in index.html is not marked data-i18n (in ${tag.slice(0, 80)})`);
    }
  }
});

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}
function stripBlock(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  if (i < 0) return text;
  const j = text.indexOf(endMarker, i);
  if (j < 0) return text;
  return text.slice(0, i) + text.slice(j + endMarker.length);
}
