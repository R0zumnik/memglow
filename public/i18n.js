/*!
 * memglow — tiny i18n loader. MIT License. No dependency, no build step.
 *
 * Pure, testable pieces first (exported for the Node tests): resolveText (interpolation + simple
 * one/other plural) and pickLanguage (browser-language detection with a safe fallback). Then the
 * page: reads the saved language (memglow's own view, cached in localStorage like every other
 * setting — see VIEW_SETTINGS in app.js), falls back to navigator.languages, fetches the matching
 * public/i18n/<code>.json, applies it to every element marked data-i18n / data-i18n-attr, and
 * exposes window.MemglowI18n for app.js, cost.js and assistant.js.
 *
 * Translation text only ever reaches the page through textContent or a plain attribute value
 * (data-i18n / data-i18n-attr below) — never through innerHTML.
 */
var SUPPORTED_LANGS = ["en", "fr", "de", "es", "pt-BR", "ja", "ko", "zh-CN"];
var FALLBACK_LANG = "en";

/**
 * One translation entry: a string, or { one, other } for a simple plural (languages with no
 * plural distinction may give a single string instead — see the "zh-CN"/"ja"/"ko" files).
 * params.n (when present, a number) picks "one" vs "other"; every {name} in the chosen string is
 * replaced from params. An unknown key returns the key itself (visible, easy to spot).
 */
function resolveText(dict, key, params) {
  var entry = dict ? dict[key] : undefined;
  if (entry === undefined || entry === null) return key;
  var str = entry;
  if (typeof entry === "object") {
    var n = params && typeof params.n === "number" ? params.n : null;
    var hasOne = Object.prototype.hasOwnProperty.call(entry, "one");
    var hasOther = Object.prototype.hasOwnProperty.call(entry, "other");
    str = n === 1 && hasOne ? entry.one : hasOther ? entry.other : hasOne ? entry.one : key;
  }
  if (typeof str !== "string") return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, function (m, name) {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
  });
}

/**
 * Picks a supported language from a list of browser tags (navigator.languages), else `fallback`.
 * Exact match first ("pt-BR" === "pt-BR"), then a same-prefix match ("fr-CA" → "fr", "zh-Hant-TW"
 * → "zh-CN": the only Chinese file memglow ships), case-insensitive.
 */
function pickLanguage(supported, navLangs, fallback) {
  supported = supported || [];
  navLangs = navLangs || [];
  for (var i = 0; i < navLangs.length; i++) {
    var tag = String(navLangs[i] || "").toLowerCase();
    if (!tag) continue;
    for (var j = 0; j < supported.length; j++) {
      if (String(supported[j]).toLowerCase() === tag) return supported[j];
    }
    var prefix = tag.split("-")[0];
    for (var k = 0; k < supported.length; k++) {
      if (String(supported[k]).toLowerCase().split("-")[0] === prefix) return supported[k];
    }
  }
  return fallback;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SUPPORTED_LANGS: SUPPORTED_LANGS, FALLBACK_LANG: FALLBACK_LANG, resolveText: resolveText, pickLanguage: pickLanguage };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var LOCAL_KEY = "memglow.langue"; // local-cache name of the "language" setting (VIEW_SETTINGS)

  function readLocal(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function writeLocal(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* offline / blocked storage: lost on reload only */ }
  }
  function notify() {
    try { document.dispatchEvent(new CustomEvent("memglow:language", { detail: { lang: state.lang } })); } catch (e) { /* old browser */ }
  }
  function applyDom() {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
    var attrNodes = document.querySelectorAll("[data-i18n-attr]");
    for (var j = 0; j < attrNodes.length; j++) {
      var pairs = attrNodes[j].getAttribute("data-i18n-attr").split(",");
      for (var k = 0; k < pairs.length; k++) {
        var p = pairs[k].split(":");
        if (p.length === 2) attrNodes[j].setAttribute(p[0].trim(), t(p[1].trim()));
      }
    }
    try { if (document.documentElement) document.documentElement.lang = state.lang; } catch (e) {}
  }

  var state = { lang: FALLBACK_LANG, dict: {} };
  function t(key, params) {
    return resolveText(state.dict, key, params);
  }

  function load(lang) {
    if (SUPPORTED_LANGS.indexOf(lang) < 0) lang = FALLBACK_LANG;
    if (!window.fetch) {
      state.lang = lang;
      return Promise.resolve();
    }
    return fetch("/i18n/" + lang + ".json", { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function (d) {
      state.lang = lang;
      state.dict = d && typeof d === "object" ? d : {};
      applyDom();
      notify();
    }).catch(function () {
      // Fetch failed (offline, unknown file): keep whatever was loaded before. The page itself
      // still works — app.js/cost.js/assistant.js fall back to their own small English copy for
      // any key this loader has not resolved yet.
    });
  }

  function detect() {
    var saved = readLocal(LOCAL_KEY);
    if (saved && SUPPORTED_LANGS.indexOf(saved) >= 0) return saved;
    var navLangs = (navigator && navigator.languages) || (navigator && navigator.language ? [navigator.language] : []);
    return pickLanguage(SUPPORTED_LANGS, navLangs, FALLBACK_LANG);
  }

  var ready = load(detect());

  window.MemglowI18n = {
    t: t,
    lang: function () { return state.lang; },
    get dict() { return state.dict; },
    supported: SUPPORTED_LANGS.slice(),
    ready: function (fn) { return fn ? ready.then(fn) : ready; },
    /** Settings panel → Language: saves the choice locally (view.js syncs it like every other
        setting) and switches the page live. */
    setLanguage: function (lang) {
      writeLocal(LOCAL_KEY, SUPPORTED_LANGS.indexOf(lang) >= 0 ? lang : FALLBACK_LANG);
      ready = load(lang);
      return ready;
    },
  };
})();
