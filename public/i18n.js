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
 *
 * Numbers and dates follow the memglow language too (formatNumber / formatDay / formatTime /
 * formatDateTime: Intl with that language, never the browser's own locale): "3 000" and "30 sept."
 * in French, "3.000" in German, "9月30日" in Japanese. A number passed to t() as a parameter is
 * formatted the same way. Fixed English formats stay only where a comment says why: prompts sent
 * to the AI (public/cost.js), and the lines memglow writes in the archive summary (lib/archive.js).
 */
var SUPPORTED_LANGS = ["en", "fr", "de", "es", "pt-BR", "ja", "ko", "zh-CN"];
var FALLBACK_LANG = "en";

/**
 * One translation entry: a string, or { one, other } for a simple plural (languages with no
 * plural distinction may give a single string instead — see the "zh-CN"/"ja"/"ko" files).
 * params.n (when present, a number) picks "one" vs "other"; every {name} in the chosen string is
 * replaced from params. An unknown key returns the key itself (visible, easy to spot).
 */
function resolveText(dict, key, params, lang) {
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
    if (!Object.prototype.hasOwnProperty.call(params, name)) return m;
    var v = params[name];
    // With a language (the page's t()), a number reads in that language: "{n} notes" → "1 234 notes".
    return lang && typeof v === "number" && isFinite(v) ? formatNumber(v, lang, 3) : String(v);
  });
}

/* ---- Localized numbers and dates (Intl) ----
   One formatter per (kind, language, options), cached. When Intl or the language is unavailable
   (very old browser, unknown tag), the English form is used: "1,234", "Sep 30", "14:05:09". */
var FORMATTERS = {};
function intlFormatter(kind, lang, opts, key) {
  var k = kind + "|" + lang + "|" + key;
  if (!Object.prototype.hasOwnProperty.call(FORMATTERS, k)) {
    var f = null;
    try { if (typeof Intl !== "undefined" && Intl[kind]) f = new Intl[kind](lang, opts); } catch (e) { f = null; }
    if (!f && lang !== FALLBACK_LANG) f = intlFormatter(kind, FALLBACK_LANG, opts, key);
    FORMATTERS[k] = f;
  }
  return FORMATTERS[k];
}
var EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad2(n) { return (n < 10 ? "0" : "") + n; }
/** 1234 → "1,234" (en), "1 234" (fr), "1.234" (de)… Rounded to an integer unless `decimals`. */
function formatNumber(n, lang, decimals) {
  n = Number(n);
  if (!isFinite(n)) return "—";
  var d = typeof decimals === "number" ? decimals : 0;
  var f = intlFormatter("NumberFormat", lang || FALLBACK_LANG, { maximumFractionDigits: d, minimumFractionDigits: 0 }, "n" + d);
  if (f) return f.format(n);
  var parts = (d ? n.toFixed(d).replace(/\.?0+$/, "") : String(Math.round(n))).split(".");
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (parts[1] ? "." + parts[1] : "");
}
/** "2026-09-30" (a calendar day, no time zone) → "Sep 30" (en), "30 sept." (fr), "9月30日" (ja)… */
function formatDay(day, lang) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  var date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  var f = intlFormatter("DateTimeFormat", lang || FALLBACK_LANG, { month: "short", day: "numeric", timeZone: "UTC" }, "day");
  return f ? f.format(date) : EN_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]);
}
/** A time of day (ms), local time: "02:05:09 PM" (en), "14:05:09" (fr, de…). */
function formatTime(ms, lang) {
  var date = new Date(ms);
  if (!isFinite(date.getTime())) return "";
  var f = intlFormatter("DateTimeFormat", lang || FALLBACK_LANG, { hour: "2-digit", minute: "2-digit", second: "2-digit" }, "time");
  return f ? f.format(date) : pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
}
/** A moment (ms), local time: day, short month and time — "Sep 30, 02:05:09 PM" (en), "30 sept., 14:05:09" (fr). */
function formatDateTime(ms, lang) {
  var date = new Date(ms);
  if (!isFinite(date.getTime())) return "";
  var f = intlFormatter("DateTimeFormat", lang || FALLBACK_LANG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }, "datetime");
  return f ? f.format(date) : EN_MONTHS[date.getMonth()] + " " + date.getDate() + ", " + pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
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
  module.exports = {
    SUPPORTED_LANGS: SUPPORTED_LANGS, FALLBACK_LANG: FALLBACK_LANG, resolveText: resolveText, pickLanguage: pickLanguage,
    formatNumber: formatNumber, formatDay: formatDay, formatTime: formatTime, formatDateTime: formatDateTime,
  };
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
    return resolveText(state.dict, key, params, state.lang);
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
    /** Numbers and dates in the page language (formatNumber… above). app.js, cost.js and
        assistant.js keep their own small copy for the Node tests, and use the same Intl options. */
    num: function (n, decimals) { return formatNumber(n, state.lang, decimals); },
    day: function (d) { return formatDay(d, state.lang); },
    time: function (ms) { return formatTime(ms, state.lang); },
    dateTime: function (ms) { return formatDateTime(ms, state.lang); },
    /** Settings panel → Language: saves the choice locally (view.js syncs it like every other
        setting) and switches the page live. */
    setLanguage: function (lang) {
      writeLocal(LOCAL_KEY, SUPPORTED_LANGS.indexOf(lang) >= 0 ? lang : FALLBACK_LANG);
      ready = load(lang);
      return ready;
    },
  };
})();
