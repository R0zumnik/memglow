/*!
 * memglow — Protected groups (first-run screen and Settings). MIT License.
 *
 * "What are your big themes?": the big groups found in the notes (folders, `theme:` keys), each with
 * a "Protect" box and its display name. Saved on the memglow server (PUT /api/zones, same guard as
 * the saved view: memglow's header + same origin), validated there. A protected group is never
 * crossed by the assistant: no note moved in or out, no note created in another group, no `theme`
 * changed. Renaming only changes how the group is shown; notes are never touched.
 * Shown by itself at first run (nothing defined yet); later from Settings → "Protected groups".
 * Every text that comes from the server goes through zEsc() before innerHTML.
 */

function zEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---- i18n (public/i18n.js, public/i18n/<code>.json) ----
   Same approach as app.js/cost.js/assistant.js: a small English copy of the keys this file renders,
   used when window.MemglowI18n is not available (Node tests, or before the page language loads),
   kept in sync with public/i18n/en.json by a test. The static texts of the screen (title, intro,
   buttons) live in index.html (data-i18n) and are translated by i18n.js directly. */
var EN_ZONES = {
  "zones.none": "No group is configured.", "zones.protect": "Protect",
  "zones.notesCount": { one: "{n} note", other: "{n} notes" }, "zones.folders": "folders: {list}",
  "zones.labelAria": "Display name of the group {id}",
  "zones.statusConfig": "Defined in memglow.config.json — saving here overrides it.",
  "zones.statusSaved": "Saved on this memglow instance.", "zones.statusNone": "Nothing protected yet: choose and save.",
  "zones.unreachable": "Could not reach memglow: reload the page.", "zones.saving": "Saving…",
  "zones.refused": "memglow refused these values.", "zones.savedReload": "Saved. Reloading to show the new names…",
  "zones.notSaved": "Not saved: {error}"
};
function resolveTextZones(dict, key, params) {
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
function defaultZonesT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextZones(EN_ZONES, key, params);
}

/**
 * The rows of the form. `z` = GET /api/zones. Not defined yet: every group holding notes is ticked.
 * `T` defaults to the page language. `current` (optional): what the form holds right now
 * ({ protected: [ids], labels: { id: typed text } }), kept when the page language changes.
 */
function zonesRender(z, T, current) {
  T = T || defaultZonesT;
  var themes = (z && z.themes) || [];
  if (!themes.length) return '<p class="mg-cost__empty">' + zEsc(T("zones.none")) + '</p>';
  var prot = (z && z.defined) ? (z.protected || []) : themes.filter(function (t) { return t.notes > 0; }).map(function (t) { return t.id; });
  if (current) prot = current.protected || [];
  var typed = (current && current.labels) || {};
  return '<ul class="mg-zones__list">' + themes.map(function (t) {
    var color = /^#[0-9A-Fa-f]{6}$/.test(String(t.color || "")) ? t.color : "#A9C9BF";
    var det = T("zones.notesCount", { n: t.notes }) + (t.folders && t.folders.length ? " · " + T("zones.folders", { list: t.folders.join(", ") }) : "");
    var shown = Object.prototype.hasOwnProperty.call(typed, t.id) ? typed[t.id] : t.label;
    return '<li class="mg-zones__row">' +
      '<label class="mg-zones__check"><input type="checkbox" name="protect" value="' + zEsc(t.id) + '"' + (prot.indexOf(t.id) >= 0 ? " checked" : "") + '> ' + zEsc(T("zones.protect")) + '</label>' +
      '<span class="mg-cost__dot" style="--c:' + color + '"></span>' +
      '<input type="text" class="mg-zones__label" data-theme="' + zEsc(t.id) + '" data-default="' + zEsc(t.defaultLabel) + '" value="' + zEsc(shown) + '" maxlength="40" aria-label="' + zEsc(T("zones.labelAria", { id: t.id })) + '">' +
      '<span class="mg-cost__det">' + zEsc(det) + '</span></li>';
  }).join("") + '</ul>';
}

/** What the form sends: { protected: [ids], labels: { id: label } } (labels that differ from the default). */
function zonesCollect(boxes, inputs) {
  var out = { protected: [], labels: {} };
  Array.prototype.forEach.call(boxes || [], function (b) { if (b.checked) out.protected.push(b.value); });
  Array.prototype.forEach.call(inputs || [], function (i) {
    var v = String(i.value || "").replace(/\s+/g, " ").trim();
    var id = i.getAttribute("data-theme"), def = i.getAttribute("data-default");
    if (v && v !== def) out.labels[id] = v.slice(0, 40);
  });
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { zEsc: zEsc, zonesRender: zonesRender, zonesCollect: zonesCollect, EN_ZONES: EN_ZONES, resolveTextZones: resolveTextZones, defaultZonesT: defaultZonesT };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var root = document.getElementById("mg-zones");
  if (!root) return;
  var api = root.getAttribute("data-api");
  var form = document.getElementById("mg-zones-form");
  var body = document.getElementById("mg-zones-body");
  var status = document.getElementById("mg-zones-status");
  var later = document.getElementById("mg-zones-later");
  var open = document.getElementById("mem-zones");
  var LATER_KEY = "memglow.zonesLater";
  var T = defaultZonesT;
  var last = null, lastStatus = null; // last GET /api/zones; last status line [key, params, bad]

  function say(key, params, bad) {
    lastStatus = [key, params, bad];
    status.textContent = T(key, params);
    status.className = "mg-zones__status" + (bad ? " mg-zones__status--bad" : "");
  }
  function load(show) {
    return fetch(api, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (z) {
      last = z;
      body.innerHTML = zonesRender(z, T);
      var postponed = false;
      try { postponed = window.sessionStorage.getItem(LATER_KEY) === "1"; } catch (e) { postponed = false; }
      if (show || (!z.defined && !postponed)) {
        root.hidden = false;
        say(z.defined ? (z.source === "config" ? "zones.statusConfig" : "zones.statusSaved") : "zones.statusNone", null, false);
      }
    }).catch(function () { if (show) { root.hidden = false; say("zones.unreachable", null, true); } });
  }
  /** What the form holds right now, as typed (for a redraw in another language). */
  function formState() {
    var out = { protected: [], labels: {} };
    Array.prototype.forEach.call(form.querySelectorAll('input[name="protect"]'), function (b) { if (b.checked) out.protected.push(b.value); });
    Array.prototype.forEach.call(form.querySelectorAll(".mg-zones__label"), function (i) { out.labels[i.getAttribute("data-theme")] = String(i.value || ""); });
    return out;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = zonesCollect(form.querySelectorAll('input[name="protect"]'), form.querySelectorAll(".mg-zones__label"));
    say("zones.saving", null, false);
    fetch(api, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Memglow": "1" },
      body: JSON.stringify(data),
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 400 ? T("zones.refused") : "HTTP " + r.status);
      say("zones.savedReload", null, false);
      setTimeout(function () { window.location.reload(); }, 600);
    }).catch(function (err) { say("zones.notSaved", { error: (err && err.message) || String(err) }, true); });
  });
  later.addEventListener("click", function () {
    try { window.sessionStorage.setItem(LATER_KEY, "1"); } catch (e) { /* private mode */ }
    root.hidden = true;
  });
  if (open) open.addEventListener("click", function () {
    load(true).then(function () { if (root.scrollIntoView) root.scrollIntoView({ behavior: "smooth", block: "start" }); });
  });
  // The page language changed (public/i18n.js): redraw the rows, keeping what the form holds.
  document.addEventListener("memglow:language", function () {
    if (last) body.innerHTML = zonesRender(last, T, formState());
    if (lastStatus) say(lastStatus[0], lastStatus[1], lastStatus[2]);
  });
  load(false);
})();
