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
const setupPage = require("../public/setup.js");
const controlPage = require("../public/control.js");

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
  for (const [name, dict] of [["app.js EN_APP", appPage.EN_APP], ["cost.js EN_COST", costPage.EN_COST], ["assistant.js EN_AI", aiPage.EN_AI], ["zones.js EN_ZONES", zonesPage.EN_ZONES], ["setup.js EN_SETUP", setupPage.EN_SETUP], ["control.js EN_CONTROL", controlPage.EN_CONTROL]]) {
    for (const k of Object.keys(dict)) {
      assert.ok(Object.prototype.hasOwnProperty.call(en, k), `${name}: "${k}" is not a real en.json key`);
      assert.deepStrictEqual(dict[k], en[k], `${name}: "${k}" has drifted from en.json`);
    }
  }
});

// ---- control panel ("Night Shift", public/control.js): pure renderers ----

const NS_NOW = new Date(2026, 10, 4, 9, 12).getTime();
const nsIso = (h) => new Date(new Date(2026, 10, 4).getTime() + h * 3600000).toISOString();
function nsData({ state = "ok", issueList, weekly, events } = {}) {
  const off = state === "off";
  const err = state === "auth" ? { t: nsIso(2.23), message: "Failed to authenticate. API Error: 401 Invalid bearer token" } : null;
  return {
    setup: {
      control: {
        proxy: { levers: [{ key: "sizeWarning", value: true, source: "default", envLocked: false, day1: true }, { key: "dedupe", value: true, source: "page", envLocked: false, day1: false }, { key: "indexWarning", value: true, source: "env", envLocked: true, env: "MEMGLOW_PROXY_INDEX_WARNING", day1: true }], caps: [{ key: "largeNoteTokens", value: 5000, source: "default" }] },
        maintenance: { generatedAt: NS_NOW },
        memoryServer: { configured: true, ok: true, readOnly: false, tokenRequired: true, version: "0.6.3", notes: 12 },
        memoryMaintenance: state === "nomem" ? { configured: false } : state === "down" ? { configured: true, ok: false, error: "unreachable" } : {
          configured: true, ok: true,
          autoSplit: { enabled: !off, provider: off ? "" : "anthropic", model: off ? "" : "claude-haiku-4-5", keySet: !off, pendingCount: 2, lastError: err },
          structure: { enabled: !off, issues: (issueList || []).length, issueList: issueList || [], lastError: null },
          archive: { enabled: !off, provider: off ? "" : "anthropic", model: off ? "" : "claude-haiku-4-5", keySet: !off, keepDays: 90, lastScanAt: nsIso(0.6), nextScanAt: nsIso(24.6), lastError: null, recent: [] },
          duplicates: { enabled: !off, foundCount: 0, checkedCount: 0, reported: [], recent: [] },
          weekly: weekly || { notesSplit: 1, structureFixes: 3, structureFixesByKind: { R2: 3 }, sectionsArchived: 2, duplicatesFound: 0, aiCalls: 12, cachedVerdicts: 4, errors: state === "auth" ? 1 : 0 },
        },
        proxySeen: { t: NS_NOW - 5000, durationMs: 42 },
      },
      tuning: { maintenanceEveryHours: 24, archiveAfterDays: 105, indexTrimMaxChars: 90, indexWarningTokens: 2000, sessionsPerDay: 5, locked: {} },
      assistant: { enabled: false, provider: "claude-code", providers: [{ id: "claude-code", label: "Claude Code", key: "not needed", keySource: "" }] },
    },
    maintenance: { items: [{ id: "a" }] },
    cost: {
      clientTokens: { days: 7, byClient: { "claude-code": { tokens: 100, calls: 2 } }, byLever: { dedupe: { tokens: 50, calls: 1 } }, sessionStart: { memoryCoreAvg: 1800, toolsListAvg: 3100, total: 4900, memoryCoreServed: 6, toolsListServed: 6 } },
      savingsByDay: [{ day: "2026-11-03", saved: 20, relayed: 60, calls: 1 }, { day: "2026-11-04", saved: 30, relayed: 40, calls: 1 }],
    },
    events: events === null ? null : events || {
      configured: true, ok: true, since: nsIso(-168), now: nsIso(9.2), days: [{ day: "2026-11-04", notesSplit: 1, structureFixes: 3, sectionsArchived: 2, aiCalls: 12, cachedVerdicts: 4, errors: 0 }],
      autoSplit: [{ t: nsIso(0.7), kind: "split", note: "trip<script>", detail: "3 parts" }].concat(state === "auth" ? [{ t: nsIso(2.23), kind: "auth-error", note: "x", detail: "401" }] : []),
      structure: [{ t: nsIso(1.3), kind: "fix", note: "bike", detail: "R2 — Up line added" }, { t: nsIso(1.4), kind: "ai-call", note: "bike", detail: "R5" }],
      archive: [{ t: nsIso(2.6), kind: "archived", note: "old", detail: "2 section(s) → archive" }],
      schedule: { autoSplit: { lastScanAt: nsIso(0.6), nextScanAt: nsIso(24.6) }, structure: { lastScanAt: nsIso(0.6), nextScanAt: nsIso(24.6), ai: { enabled: true, provider: "anthropic", model: "claude-haiku-4-5" }, fixable: 1, needsReview: 1 }, archive: { lastScanAt: nsIso(0.6), nextScanAt: nsIso(24.6) } },
    },
  };
}

test("control.js: controlModel — the verdict (ok / needs / setup / unreachable) from lastError, enabled and weekly", () => {
  const ok = controlPage.controlModel(nsData(), NS_NOW);
  assert.strictEqual(ok.kind, "ok");
  assert.strictEqual(ok.tidied, 6, "1 split + 3 fixes + 2 sections");
  assert.strictEqual(ok.provState, "ok");
  assert.deepStrictEqual(ok.prov.usedBy, ["split", "structure", "archive"]);
  const auth = controlPage.controlModel(nsData({ state: "auth" }), NS_NOW);
  assert.strictEqual(auth.kind, "needs");
  assert.strictEqual(auth.provState, "auth");
  assert.strictEqual(auth.paused.length, 1);
  assert.match(auth.auth.message, /401/);
  assert.strictEqual(auth.waiting, 1, "the refused key counts as one thing waiting");
  assert.strictEqual(controlPage.controlModel(nsData({ state: "off" }), NS_NOW).kind, "setup");
  assert.strictEqual(controlPage.controlModel(nsData({ state: "off" }), NS_NOW).provState, "none");
  assert.strictEqual(controlPage.controlModel(nsData({ state: "nomem" }), NS_NOW).kind, "setup");
  assert.strictEqual(controlPage.controlModel(nsData({ state: "down" }), NS_NOW).kind, "unreachable");
  // Never throws on nothing at all (the very first paint, an older server).
  assert.strictEqual(controlPage.controlModel({}, NS_NOW).kind, "setup");
  assert.strictEqual(controlPage.controlModel(nsData({ events: null }), NS_NOW).hasEvents, false);
});

test("control.js: first screen — one sentence, the tally, the verdict, three summary cards", () => {
  const T = controlPage.defaultControlT;
  const ok = controlPage.controlRender(nsData(), T, {}, NS_NOW, "en");
  assert.match(ok, /memglow tidied 6 things in your memory this week\./);
  assert.match(ok, /All good/);
  assert.match(ok, /1 note split/);
  assert.match(ok, /3 structure fixes/);
  assert.match(ok, /2 sections archived/);
  assert.match(ok, /3 of 3 running/);
  assert.match(ok, /Tokens saved, last 7 days/);
  assert.match(ok, /Anthropic API/);
  assert.doesNotMatch(ok, /role="alert"/, "no banner when nothing is wrong");
  const quiet = controlPage.controlRender(nsData({ weekly: { notesSplit: 0, structureFixes: 0, structureFixesByKind: {}, sectionsArchived: 0, duplicatesFound: 0, aiCalls: 0, cachedVerdicts: 0, errors: 0 } }), T, {}, NS_NOW, "en");
  assert.match(quiet, /Your memory is in order/);
  const off = controlPage.controlRender(nsData({ state: "off" }), T, {}, NS_NOW, "en");
  assert.match(off, /Not set up yet/);
  assert.match(off, /Your memory is not at risk/, "no provider: calm, nothing red");
  assert.doesNotMatch(off, /statusline--crit|role="alert"/);
  const down = controlPage.controlRender(nsData({ state: "down" }), T, {}, NS_NOW, "en");
  assert.match(down, /cannot reach the memory server/);
  assert.match(down, /unreachable/);
});

test("control.js: a refused key changes the whole page — banner with the time, verdict, paused worker, provider card, never a secret", () => {
  const T = controlPage.defaultControlT;
  const html = controlPage.controlRender(nsData({ state: "auth" }), T, {}, NS_NOW, "en");
  assert.match(html, /class="alert" role="alert"/);
  assert.match(html, /Maintenance stopped 02:13\./);
  assert.match(html, /Nothing in your memory was changed\./);
  assert.match(html, /memglow stopped at 02:13\. Its AI key was refused\./);
  assert.match(html, /Needs you/);
  assert.match(html, /1 of 3 paused/);
  assert.match(html, /Paused/);
  assert.match(html, /Stopped 02:13\./);
  assert.match(html, /Failed to authenticate\. API Error: 401 Invalid bearer token/);
  assert.match(html, /Key refused 02:13/);
  assert.match(html, /AI key refused, 1 worker paused/);
  assert.match(html, /statusline--crit/);
  assert.ok(!/sk-ant|apiKey/i.test(html), "never a key");
});

test("control.js: \"Needs your eye\" — structure issueList (R1–R7, D1), what needs a decision first, escaped, calm when empty", () => {
  const T = controlPage.defaultControlT;
  const m = controlPage.controlModel(nsData({ issueList: [
    { rule: "R3", note: "hub<script>", detail: 'missing "## Parts" line for part "spoke"', fixable: true },
    { rule: "R5", note: "orphan", detail: "not in the index", fixable: false },
    { rule: "D1", note: "meal-plan", detail: 'possible duplicate of "weekly-meals"', fixable: false },
    { rule: "R9", note: "x", detail: "y", fixable: false },
  ] }), NS_NOW);
  assert.strictEqual(m.review, 3);
  assert.strictEqual(m.waiting, 3);
  const html = controlPage.controlRenderIssues(m, T, "en");
  assert.ok(html.indexOf("Orphan note") < html.indexOf("A hub&#39;s list of parts is out of date"), "needs-review before auto-fixable");
  assert.match(html, /Possible duplicate/);
  assert.match(html, /Structure issue/, "an unknown rule still gets a title");
  assert.match(html, /hub&lt;script&gt;/);
  assert.match(html, /missing &quot;## Parts&quot; line for part &quot;spoke&quot;/);
  assert.match(html, /memglow fixes this on its next pass/);
  assert.match(html, /Yours to decide/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /1 tidy-up suggestion is waiting/);
  // More than six: the rest folds under "Show n more".
  const many = controlPage.controlModel(nsData({ issueList: Array.from({ length: 9 }, (_, i) => ({ rule: "R5", note: "n" + i, detail: "", fixable: false })) }), NS_NOW);
  assert.match(controlPage.controlRenderIssues(many, T, "en"), /<details class="more"[^>]*><summary>Show 4 more<\/summary>/);
  // Nothing at all: one calm line, no list.
  const none = controlPage.controlModel(Object.assign(nsData(), { maintenance: { items: [] } }), NS_NOW);
  const empty = controlPage.controlRenderIssues(none, T, "en");
  assert.match(empty, /Nothing needs you/);
  assert.doesNotMatch(empty, /<ul/);
  // A stale issueList of a structure worker that is off is never shown.
  const d = nsData({ issueList: [{ rule: "R5", note: "x", detail: "y", fixable: false }] });
  d.setup.control.memoryMaintenance.structure.enabled = false;
  assert.strictEqual(controlPage.controlModel(d, NS_NOW).issues.length, 0);
});

test("control.js: weekly ledger, worker cards and lanes — figures, per-day bars, status, last events, an error as a crossed ring", () => {
  const T = controlPage.defaultControlT;
  const m = controlPage.controlModel(nsData({ state: "auth" }), NS_NOW);
  const ledger = controlPage.controlRenderLedger(m, T, "en");
  for (const s of ["Notes split", "Structure fixes", "by rule: R2 3", "Sections archived", "Possible duplicates", "AI calls", "Verdicts reused", "Errors"]) assert.ok(ledger.includes(s), s);
  assert.match(ledger, /ledger__n--crit">1</);
  assert.match(ledger, /<svg class="mini"/);
  const workers = controlPage.controlRenderWorkers(m, T, "en");
  assert.strictEqual((workers.match(/<article/g) || []).length, 3, "one card per worker");
  assert.match(workers, /data-worker="split"[\s\S]*Paused[\s\S]*data-worker="structure"/);
  assert.match(workers, /Anthropic API, claude-haiku-4-5/);
  assert.match(workers, /2 notes waiting to go quiet/);
  assert.match(workers, /After the key is fixed/);
  assert.match(workers, /Note split: trip&lt;script&gt;, 3 parts/);
  assert.match(workers, /Sections unread for 90 days/);
  assert.ok(!/<input|<select|<button/.test(workers), "status only: the workers are configured on the memory server");
  const svg = controlPage.controlLanesSvg({ from: NS_NOW - 7 * 86400000, to: NS_NOW, w: 900, workers: m.workers, T, lang: "en", aria: "x" });
  assert.match(svg, /^<svg /);
  assert.strictEqual((svg.match(/class="dot"/g) || []).length, 4, "3 actions + 1 error are focusable marks; a pass that changed nothing is a faint tick");
  assert.match(svg, /stroke="var\(--crit\)"/);
  assert.match(svg, /data-tip-t="Auto-split, 00:42"/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(controlPage.controlLanesSvg({ from: NS_NOW - 86400000, to: NS_NOW, w: 320, workers: m.workers, compact: true, T, lang: "en" }), /fill="var\(--c-night\)"/);
  assert.strictEqual(controlPage.controlEventClass("split-failed"), "err");
  assert.strictEqual(controlPage.controlEventClass("left"), "minor");
  // A memory server too old to send its timeline: a sentence, not an empty chart.
  assert.match(controlPage.controlRenderMaintenance(controlPage.controlModel(nsData({ events: null }), NS_NOW), T, "en"), /does not send its timeline yet/);
});

test("control.js: savings — total, per-day bars, per-lever ranking, and the measured session-start cost", () => {
  const T = controlPage.defaultControlT;
  const m = controlPage.controlModel(nsData(), NS_NOW);
  assert.strictEqual(m.saved7, 50);
  const html = controlPage.controlRenderSavings(m, T, "en");
  assert.match(html, /class="big num">≈ 50</);
  assert.match(html, /data-chart="bars"/);
  assert.match(html, /Unchanged re-reads/, "a lever is named in words, not by its key");
  assert.match(html, /claude-code/);
  assert.match(html, /≈ 4,900 tokens per session start/);
  assert.match(html, /memory_core[\s\S]*≈ 1,800[\s\S]*tools\/list[\s\S]*≈ 3,100/);
  assert.match(html, /average of 6 answers/);
  const bars = controlPage.controlBarsSvg(m.byDay, 600, T, "en");
  assert.strictEqual((bars.match(/class="dot"/g) || []).length, 2);
  assert.match(bars, /≈ 30 tokens saved/);
  const empty = controlPage.controlRenderSavings(controlPage.controlModel({}, NS_NOW), T, "en");
  assert.match(empty, /Nothing measured yet/);
  assert.match(empty, /Not measured yet/);
});

test("control.js: settings — Default / Changed here / Locked by env badges, schedule fields, danger zone with an inline confirmation", () => {
  const T = controlPage.defaultControlT;
  const m = controlPage.controlModel(nsData(), NS_NOW);
  const html = controlPage.controlRenderSettings(m, T, "en", {});
  assert.match(html, /<span class="src">Default<\/span>/);
  assert.match(html, /<span class="src src--changed">Changed here<\/span>/);
  assert.match(html, /<span class="src src--lock">Locked by MEMGLOW_PROXY_INDEX_WARNING<\/span>/);
  assert.match(html, /data-lever="indexWarning" checked disabled/);
  assert.match(html, /Advanced lever \(1\)/);
  assert.match(html, /≈ 50 saved in 7 days/);
  for (const k of ["maintenanceEveryHours", "archiveAfterDays", "indexTrimMaxChars", "indexWarningTokens", "sessionsPerDay"]) assert.ok(html.includes('data-maint="' + k + '"'), k);
  assert.match(html, /id="mg-control-run-now"/);
  assert.match(html, /id="mg-control-restart" role="status" hidden/);
  assert.match(controlPage.controlRenderSettings(m, T, "en", { restart: true }), /id="mg-control-restart" role="status">Restart the MCP proxy/);
  const dz = controlPage.controlRenderDanger(m, T);
  assert.match(dz, /Danger zone/);
  assert.match(dz, /1 lever was changed from this page/);
  assert.match(dz, /data-dz="levers">Reset levers</);
  assert.match(dz, /class="confirm" data-confirm="levers" hidden/);
  assert.match(dz, /data-dz="key" disabled/, "no key saved from the browser: nothing to forget");
  const withKey = nsData();
  withKey.setup.assistant.providers.push({ id: "anthropic", label: "Anthropic API", key: "set", keySource: "page" });
  assert.match(controlPage.controlRenderDanger(controlPage.controlModel(withKey, NS_NOW), T), /data-dz-ok="key-anthropic" data-provider="anthropic"/);
  assert.ok(!/confirm\(/.test(fs.readFileSync(path.join(PUBLIC, "control.js"), "utf8")), "never a browser confirm() dialog");
});

test("control.js: the panel page — own stylesheet with light and dark tokens, no network font, every static text behind a key", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "panel.html"), "utf8");
  const css = fs.readFileSync(path.join(PUBLIC, "panel.css"), "utf8");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, "")), "panel.html: no outside URL");
  assert.ok(!/https?:\/\//.test(css), "panel.css: no outside URL, fonts are self-hosted");
  assert.match(css, /@font-face[\s\S]*\/vendor\/fonts\/bricolage-grotesque-latin\.woff2/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const f of ["bricolage-grotesque-latin.woff2", "bricolage-grotesque-latin-ext.woff2"]) assert.ok(fs.statSync(path.join(PUBLIC, "vendor", "fonts", f)).size > 10000, f);
  assert.match(fs.readFileSync(path.join(PUBLIC, "..", "THIRD_PARTY_LICENSES"), "utf8"), /Bricolage Grotesque[\s\S]*SIL Open Font License/);
  const en = loadLang("en");
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) assert.ok(Object.prototype.hasOwnProperty.call(en, m[1]), "panel.html: " + m[1]);
  for (const m of html.matchAll(/data-i18n-attr="[a-z-]+:([^"]+)"/g)) assert.ok(Object.prototype.hasOwnProperty.call(en, m[1]), "panel.html: " + m[1]);
  // Every visible text node of the static shell sits in an element that carries data-i18n
  // (the brand name, the language autonyms and the template placeholders are not translated).
  const autonyms = LANGS.map((c) => loadLang(c)._meta.autonym);
  for (const m of html.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/<([a-z0-9]+)([^>]*)>([^<>]*[A-Za-z][^<>]*)</g)) {
    const text = m[3].trim();
    if (!text || /^\{\{title\}\}/.test(text) || autonyms.includes(text) || m[1] === "title") continue;
    assert.ok(/data-i18n=/.test(m[2]), `panel.html: "${text}" has no data-i18n`);
  }
  assert.match(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8"), /<a class="bn-btn" id="mem-control" href="\/panel" data-i18n="settings.control">/);
});

test("i18n: defaultT helpers resolve English outside a browser (Node require, no window)", () => {
  assert.strictEqual(appPage.defaultT("theme.index"), "Index");
  assert.strictEqual(appPage.defaultT("stats.notesWord", { n: 1 }), "note");
  assert.strictEqual(costPage.defaultCostT("cost.copyPrompt"), "Copy prompt for your AI");
  assert.strictEqual(aiPage.defaultAiT("ai.undo"), "Undo");
  assert.strictEqual(zonesPage.defaultZonesT("zones.protect"), "Protect");
  assert.strictEqual(zonesPage.defaultZonesT("zones.notesCount", { n: 1 }), "1 note");
});

test("i18n: v0.4 texts go through keys — journal channel, organisation facts, always-loaded tips, archive block, zones rows", () => {
  const T = (k, p) => "[" + k + (p && typeof p.n === "number" ? ":" + p.n : "") + "]";
  // Journal: the "file" and "demo" channels are words (translated); hook / MCP proxy / API are names.
  assert.strictEqual(appPage.formatJournalLine({ type: "changed", theme: "x", label: "Y", channel: "file" }, { x: "X" }, T).text, "[journal.actionChanged] · X · Y · [journal.channelFile]");
  assert.strictEqual(appPage.formatJournalLine({ type: "read", theme: "x", label: "Y", channel: "mcp-proxy" }, { x: "X" }, T).text, "[journal.actionRead] · X · Y · MCP proxy");
  // Memory cost: organisation sentences from the server's facts, tips from their figures, block titles.
  const c = { read: { today: 0, days7: 0 }, written: { days7: 0 }, totals: { tokens: 1, notes: 1 }, index: null, share: null, top: [], largeNoteTokens: 200, chunkTokens: 100, tooLarge: [], neverRead: { available: false },
    organisation: [{ id: "rg-0123456789ab", theme: "w", target: "ops", move: ["a"], message: "EN", reasons: ["EN"], notes: [{ id: "a", label: "A", subtheme: "web" }],
      facts: { kind: "scattered", notes: 3, topic: "docker", group: "Work", subthemes: ["Web", "Ops"], target: "Ops", targetCount: 2, links: 1, subthemeNames: { web: "Web", ops: "Ops" } } }],
    alwaysLoaded: { index: [], files: [], perSession: 15, sessionsPerDay: 2, perDay: 30, sessionsSource: "setting", tips: [{ kind: "index", tokens: 3000, threshold: 2000, text: "EN" }] },
    archive: { available: false, afterDays: 105 } };
  const html = costPage.costRender(c, {}, T);
  for (const k of ["cost.organisation", "org.scattered", "org.why", "org.reasonShared", "org.reasonLinks:1", "org.reasonSubthemes", "org.reasonTargetHolds", "cost.alwaysLoaded", "always.perDay", "always.tipIndex", "cost.archive", "arch.notEnough"]) {
    assert.ok(html.includes("[" + k), k);
  }
  assert.ok(!html.includes(">EN<"), "facts win over the server's English text");
  assert.ok(html.includes("Web → Ops"), "sub-theme display names");
  // Zones rows.
  const z = zonesPage.zonesRender({ defined: false, themes: [{ id: "w", label: "W", defaultLabel: "W", notes: 2, folders: ["f"] }] }, T);
  assert.ok(z.includes("[zones.protect]") && z.includes("[zones.notesCount:2]") && z.includes("[zones.folders]") && z.includes("[zones.labelAria]"));
  // Assistant: regroup and archive jobs.
  assert.ok(aiPage.aiRenderJob({ id: "j", kind: "archive", state: "running", note: { label: "L" }, chars: 3 }, "X", T).includes("[ai.askingArchive]"));
  assert.ok(aiPage.aiAskForm("rg-1", "L", [], "", "regroup", T).includes("[ai.regroupAskMsg]"));
  // Control panel: every section goes through keys.
  const ctrl = controlPage.controlRender(nsData({ state: "auth", issueList: [{ rule: "R1", note: "MEMORY", detail: "x", fixable: false }] }), T, {}, NS_NOW, "en");
  for (const k of [
    "panel.bannerAuth", "panel.heroStopped", "panel.verdictNeeds", "panel.tallySplit:1", "panel.vitalSaved", "panel.workersPaused:1",
    "panel.maintTitle", "panel.ledgerSplit", "panel.lanesTitle", "panel.issuesTitle", "panel.rule.R1", "panel.issueReview",
    "control.workerAutoSplit", "panel.statusPaused", "panel.kvLast", "panel.savingsTitle", "panel.byLeverTitle", "panel.byClientTitle",
    "panel.sessionTotal", "panel.providerTitle", "panel.provAuthTitle", "panel.assistantOpen", "panel.settingsTitle", "panel.leversTitle",
    "control.locked", "panel.badgeChanged", "control.resetToDefault", "control.maintEveryHoursLabel", "control.archiveAfterDaysLabel",
    "control.indexTrimMaxCharsLabel", "control.indexWarningTokensLabel", "control.sessionsPerDayLabel", "aiset.save", "control.runNow",
    "control.memoryServerOk", "control.proxySeen", "panel.dangerTitle", "panel.dangerResetBtn", "panel.foot",
  ]) {
    assert.ok(ctrl.includes("[" + k), k);
  }
  assert.ok(ctrl.includes("sizeWarning") && ctrl.includes("dedupe") && ctrl.includes("largeNoteTokens"), "lever/threshold keys shown verbatim, never translated");
});

test("control.js: controlCollectProxy diffs against the effective value (minor 2, 0.4.7.6) — only a REAL change is ever sent", () => {
  var el = function (key, checked, disabled) {
    return { getAttribute: function (n) { return n === "data-lever" ? key : null; }, checked: checked, disabled: !!disabled };
  };
  var inputs = [el("sizeWarning", true), el("dedupe", true), el("toc", false), el("alreadyLoaded", true, true)];
  var effective = { sizeWarning: true, dedupe: false, toc: false, alreadyLoaded: false };
  // sizeWarning: unchanged (true==true) -> excluded. dedupe: true vs effective false -> included.
  // toc: false==false -> excluded. alreadyLoaded: disabled (env-locked) -> excluded regardless.
  assert.deepStrictEqual(controlPage.controlCollectProxy(inputs, effective), { dedupe: true });
  // Without `effectiveByKey` (back-compat): every non-disabled checkbox is included, as before.
  assert.deepStrictEqual(controlPage.controlCollectProxy(inputs), { sizeWarning: true, dedupe: true, toc: false });
  // Nothing changed at all -> an empty diff, not "every lever re-pinned as page".
  assert.deepStrictEqual(controlPage.controlCollectProxy([el("sizeWarning", true), el("dedupe", false)], { sizeWarning: true, dedupe: false }), {});
});

test("control.js: a non-default, non-locked lever gets a \"reset to default\" control; a default or env-locked one does not (minor 2, 0.4.7.6)", () => {
  var row = controlPage.controlLeverRow({ key: "dedupe", value: true, source: "page", envLocked: false, day1: false }, defaultT());
  assert.match(row, /data-reset-lever="dedupe"/);
  var def = controlPage.controlLeverRow({ key: "sizeWarning", value: true, source: "default", envLocked: false, day1: true }, defaultT());
  assert.ok(!def.includes("data-reset-lever"), "nothing to reset: already the default");
  var locked = controlPage.controlLeverRow({ key: "multiQuery", value: false, source: "env", envLocked: true, env: "MEMGLOW_PROXY_MULTI_QUERY", day1: true }, defaultT());
  assert.ok(!locked.includes("data-reset-lever"), "env-locked: nothing saved here to reset");
  function defaultT() { return function (k, p) { return "[" + k + (p && typeof p.n === "number" ? ":" + p.n : "") + "]"; }; }
});

// ---- numbers and dates in the page language (Intl) ----

test("i18n: numbers and dates follow the language (Intl), English as the fallback", () => {
  const D = Date.UTC(2026, 8, 30, 12, 5, 9);
  const want = {
    en: { n: "1,234,567", day: "Sep 30" }, fr: { n: "1 234 567", day: "30 sept." }, de: { n: "1.234.567", day: "30. Sept." },
    es: { n: "1.234.567", day: "30 sept" }, "pt-BR": { n: "1.234.567", day: "30 de set." }, ja: { n: "1,234,567", day: "9月30日" },
    ko: { n: "1,234,567", day: "9월 30일" }, "zh-CN": { n: "1,234,567", day: "9月30日" },
  };
  for (const code of LANGS) {
    // Exact forms where ICU is stable; a newer ICU may move a dot or a space, never the grouping.
    const n = i18n.formatNumber(1234567, code);
    assert.strictEqual(n.replace(/\s/g, " "), want[code].n.replace(/\s/g, " "), code + " number");
    assert.strictEqual(i18n.formatDay("2026-09-30", code), want[code].day, code + " day");
    assert.match(i18n.formatTime(D, code), /\d{2}.05.09/, code + " time");
    assert.ok(i18n.formatDateTime(D, code).includes(i18n.formatTime(D, code).replace(/^(오전|오후) /, "")), code + " date and time");
    // Every page script uses the same options as i18n.js (their own copies, for the Node tests).
    assert.strictEqual(costPage.costNumber(1234567, code), n, code + " cost.js");
    assert.strictEqual(costPage.costDay("2026-09-30", code), want[code].day, code + " cost.js day");
    assert.strictEqual(aiPage.aiNum(1234567, code), n, code + " assistant.js");
    assert.strictEqual(appPage.appNum(1234567, code), n, code + " app.js");
    assert.strictEqual(appPage.appTime(D, code), i18n.formatTime(D, code), code + " app.js time");
    assert.strictEqual(appPage.appDateTime(D, code), i18n.formatDateTime(D, code), code + " app.js date and time");
  }
  // t() formats numeric parameters in its language; strings are left as they are.
  assert.strictEqual(i18n.resolveText({ k: "{n} notes · {s}" }, "k", { n: 3000, s: "3000" }, "de"), "3.000 notes · 3000");
  assert.strictEqual(i18n.resolveText({ k: "{n} notes" }, "k", { n: 3000 }), "3000 notes", "no language: unchanged");
  // Unknown or broken language tag, bad input: English, never a throw.
  assert.strictEqual(i18n.formatNumber(3000, "not a tag!"), "3,000");
  assert.strictEqual(costPage.costNumber(3000, "not a tag!"), "3,000");
  assert.strictEqual(i18n.formatDay("30/09/2026", "fr"), "");
  assert.strictEqual(i18n.formatNumber(NaN, "fr"), "—");
  assert.strictEqual(costPage.costPercent(59, "en"), "59%");
  assert.strictEqual(costPage.costPercent(59, "fr").replace(/\s/g, " "), "59 %");
});

test("i18n: the page language drives Memory cost and Assistant figures; prompts for the AI stay English", () => {
  const before = global.window;
  global.window = { MemglowI18n: { lang: () => "fr", dict: {}, t: (k) => k } };
  try {
    const c = { read: { today: 0, days7: 0 }, written: { days7: 0 }, totals: { tokens: 12345, notes: 1 }, index: null, share: null, top: [], largeNoteTokens: 5000, chunkTokens: 2000, tooLarge: [], neverRead: { available: false, since: "2026-09-01" },
      archive: { available: false, since: "2026-09-01", afterDays: 105, readyOn: "2026-12-15" } };
    const html = costPage.costRender(c, {});
    assert.ok(html.includes("≈ 12 345"), "French grouping in the panel");
    assert.ok(html.includes("1 sept.") && html.includes("15 déc."), "French days in the panel");
    assert.ok(!html.includes("12,345") && !html.includes("Sep 1"));
    assert.ok(aiPage.aiArchiveGain({ gain: { saved: 2800, live: [], summaryTokens: 1200, summaryLines: 1 } }).includes("2 800"), "assistant figures in French");
    const n = { id: "big", label: "Big", theme: "knowledge", tokens: 7500, reads7: 3, readTokens7: 22500, split: null };
    const prompt = costPage.costSplitPrompt(n, { largeNoteTokens: 5000, chunkTokens: 2000, read: { complete7: false }, since: "2026-09-01" }, {});
    assert.match(prompt, /≈ 7,500 tokens/);
    assert.match(prompt, /≈ 22,500 tokens read/);
    assert.match(prompt, /counted since Sep 1/);
    assert.ok(!/ /.test(prompt), "no French number in the AI prompt");
    const arch = costPage.costArchivePrompt({ afterDays: 105, cutoff: "2026-06-17", folder: "archive", summaryNote: "archive-summary" },
      [{ title: "Old", label: "Old", note: "old", theme: "projects", tokens: 4321 }], {}, "2026-10-01");
    assert.match(arch, /≈ 4,321 tokens/);
  } finally {
    if (before === undefined) delete global.window; else global.window = before;
  }
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
    // v0.4: protected groups, organisation, always loaded, archive tier, journal channel
    "Do it with ' +", "No scattered notes found", ">Why<", "Always loaded · every session", "tokens per session",
    "Small enough: nothing to trim", "Prepare without AI", "Not enough data yet", "No dormant section",
    "No section selected", "Copy failed: select", "Kept live by the AI", "which sections to archive",
    "sub-theme changed", "archive summary\"", "Regroup: <strong>", "> Protect<", "Display name of the group",
    "Nothing protected yet", "Saved. Reloading", "No group is configured",
    // first-run set-up and AI settings
    "Test connection", "Your AI tools", "Remove key", "Local model: nothing leaves", "Max output tokens", "Always ask before sending",
  ];
  const files = {
    "public/app.js": stripBlock(read("public/app.js"), "var EN_APP = {", "};"),
    "public/cost.js": stripBlock(read("public/cost.js"), "var EN_COST = {", "};"),
    "public/assistant.js": stripBlock(read("public/assistant.js"), "var EN_AI = {", "};"),
    "public/zones.js": stripBlock(read("public/zones.js"), "var EN_ZONES = {", "};"),
    "public/setup.js": stripBlock(read("public/setup.js"), "var EN_SETUP = {", "};"),
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
    "Set up memglow", "AI settings", "First-run setup", "Skip set-up",
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
