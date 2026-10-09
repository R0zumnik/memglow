/*!
 * memglow — Settings → Control panel. MIT License.
 *
 * 0.4.7.2: READ ONLY. Shows the MCP proxy's lever values (where each one comes from: an
 * environment variable, the page, memglow.config.json, or the built-in default — GET
 * /api/setup's `control.proxy`), the last memory-maintenance scan (`control.maintenance` +
 * GET /api/maintenance's item count), an optional memory server's health (`control.memoryServer`)
 * and a few measurements (GET /api/cost's `clientTokens`, per-AI-tool token totals). 0.4.7.3 adds
 * switches for the day-one and advanced levers; this step only ever reads.
 *
 * Never shows a secret, a disk path, a tool-mapping table or any of the memory server's own
 * start-up flags (--token, --read-write, …) — see the task's own exclusion list. Every text from
 * the server goes through cEsc() before innerHTML.
 */

function cEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---- i18n: same approach as zones.js/setup.js — an English copy of the keys this file renders,
   kept in sync with public/i18n/en.json by a test. */
var EN_CONTROL = {
  "settings.control": "Control",
  "control.title": "Control panel",
  "control.intro": "A read-only view of the MCP proxy's token-saving levers, memory maintenance, the memory server and recent measurements.",
  "control.close": "Close",
  "control.sectionSavings": "Token savings",
  "control.sectionMaintenance": "Memory maintenance",
  "control.sectionMemoryServer": "Memory server",
  "control.sectionMeasures": "Measures",
  "control.advanced": "Advanced",
  "control.on": "On",
  "control.off": "Off",
  "control.sourceEnv": "set by {name}",
  "control.sourcePage": "saved here",
  "control.sourceFile": "memglow.config.json",
  "control.sourceDefault": "default",
  "control.locked": "Locked by {name}",
  "control.maintenanceGeneratedAt": "Last scan: {date}",
  "control.maintenanceNever": "No scan has run yet.",
  "control.maintenanceItems": { one: "{n} opportunity found", other: "{n} opportunities found" },
  "control.memoryServerOff": "Not configured (MEMGLOW_MEMORY_URL is not set).",
  "control.memoryServerError": "Could not reach it: {error}",
  "control.memoryServerOk": "{mode} · {notes} notes · v{version}",
  "control.memoryServerReadOnly": "read-only",
  "control.memoryServerReadWrite": "read-write",
  "control.memoryServerTokenYes": "token required",
  "control.memoryServerTokenNo": "no token required",
  "control.measuresEmpty": "No measurements yet.",
  "control.byClientTitle": "By AI tool (7 days)",
  "control.proxySeen": "MCP proxy last seen {ago} ({ms} ms)",
  "control.proxyNeverSeen": "The MCP proxy has not reported in yet.",
  "control.lever.sizeWarning": "Warn when a note being read (or just written) is over the large-note threshold.",
  "control.lever.indexWarning": "Warn when the memory index itself is over its own threshold.",
  "control.lever.searchDetails": "Add title, theme, size and description after a search result.",
  "control.lever.suggestions": "Suggest a few related notes after a note is read.",
  "control.lever.dedupe": "An unchanged note, re-read in the same session, gets a short “unchanged” stub instead of its full text.",
  "control.lever.toc": "A large note gets a table of contents first; a section is fetched only on demand.",
  "control.lever.archiveHint": "A search that finds nothing live lists the matching titles of the archive summary.",
  "control.lever.hideUnsupportedTools": "Hide tools a client cannot use (e.g. ChatGPT-only tools) from its own tools list.",
  "control.lever.alreadyLoaded": "A read of a note already loaded at every session start (the index, or an always-loaded file) gets a short stub instead of its text.",
  "control.lever.multiQuery": "Several search phrasings are sent upstream as one round trip instead of one model turn each.",
  "control.lever.aliases": "A past search's words, learned from what was actually read afterwards, surface a likely note at the top of a similar later search.",
  "control.lever.learnAliases": "Record which note a search's words actually led to, for the aliases lever above to use later.",
  "control.lever.negativeCache": "A search that found nothing useful last time gets a short reminder, while the memory has not changed since.",
  "control.lever.indexHint": "A search whose only hit is the index gets a short excerpt of the index's own matching lines.",
  "control.lever.deltaRead": "A note re-read after it changed gets only the diff, or a short header noting what changed since a past session.",
  "control.lever.duplicateHint": "Writing a new note whose title already matches or resembles an existing one gets a short duplicate warning.",
  "common.loading": "Loading…",
  "common.daysAgo": { one: "{n} day ago", other: "{n} days ago" },
  "common.hoursAgo": { one: "{n} hour ago", other: "{n} hours ago" },
  "common.minutesAgo": { one: "{n} minute ago", other: "{n} minutes ago" },
  "common.secondsAgo": { one: "{n} second ago", other: "{n} seconds ago" },
  "common.retry": "Retry", "common.reload": "Reload",
  "error.connectionLost": "Connection lost. Check your network and retry.",
  "error.unauthorized": "Unauthorized. Reload the page to sign in again.",
  "error.serverError": "Server error. Please retry.",
};
function resolveTextControl(dict, key, params) {
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
function defaultControlT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextControl(EN_CONTROL, key, params);
}

/** Elapsed time in words, coarsest unit that fits (days > hours > minutes > seconds). Pure. */
function controlAgo(ms, T) {
  T = T || defaultControlT;
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return T("common.secondsAgo", { n: s });
  var m = Math.round(s / 60);
  if (m < 60) return T("common.minutesAgo", { n: m });
  var h = Math.round(m / 60);
  if (h < 24) return T("common.hoursAgo", { n: h });
  return T("common.daysAgo", { n: Math.round(h / 24) });
}

/** One lever's source, in words: "default" | "memglow.config.json" | "saved here" | "set by X". */
function controlSourceText(l, T) {
  T = T || defaultControlT;
  if (l.source === "env") return T("control.sourceEnv", { name: l.env || "MEMGLOW_PROXY_…" });
  if (l.source === "page") return T("control.sourcePage");
  if (l.source === "file") return T("control.sourceFile");
  return T("control.sourceDefault");
}

/** One lever row (read-only in 0.4.7.2: a value badge, not yet a switch). */
function controlLeverRow(l, T) {
  T = T || defaultControlT;
  var help = T("control.lever." + l.key);
  return '<li class="mg-control__lever" data-lever="' + cEsc(l.key) + '">' +
    '<span class="mg-control__leverhead"><code>' + cEsc(l.key) + '</code>' +
    '<span class="mg-control__badge' + (l.value ? " mg-control__badge--on" : "") + '">' + cEsc(T(l.value ? "control.on" : "control.off")) + '</span>' +
    (l.envLocked ? '<span class="mg-control__lock">' + cEsc(T("control.locked", { name: l.env || "" })) + '</span>' : '<span class="mg-control__source">' + cEsc(controlSourceText(l, T)) + '</span>') +
    '</span><p class="mg-control__help">' + cEsc(help === "control.lever." + l.key ? "" : help) + '</p></li>';
}

/** The "Token savings" section: day-one levers first, the rest under a collapsible "Advanced". */
function controlRenderLevers(proxy, T) {
  T = T || defaultControlT;
  var levers = (proxy && proxy.levers) || [];
  var day1 = levers.filter(function (l) { return l.day1; });
  var rest = levers.filter(function (l) { return !l.day1; });
  var out = '<ul class="mg-control__levers">' + day1.map(function (l) { return controlLeverRow(l, T); }).join("") + '</ul>';
  if (rest.length) {
    out += '<details class="mg-control__advanced"><summary>' + cEsc(T("control.advanced")) + '</summary>' +
      '<ul class="mg-control__levers">' + rest.map(function (l) { return controlLeverRow(l, T); }).join("") + '</ul></details>';
  }
  return out;
}

/** The "Memory maintenance" section: last scan time + how many opportunities GET /api/maintenance lists. */
function controlRenderMaintenance(maintenance, maintResult, now, T) {
  T = T || defaultControlT;
  var generatedAt = maintenance && maintenance.generatedAt;
  var head = generatedAt ? T("control.maintenanceGeneratedAt", { date: new Date(generatedAt).toLocaleString() }) : T("control.maintenanceNever");
  var n = maintResult && Array.isArray(maintResult.items) ? maintResult.items.length : 0;
  return '<p class="mg-control__line">' + cEsc(head) + (generatedAt ? " · " + cEsc(T("control.maintenanceItems", { n: n })) : "") + '</p>';
}

/** The "Memory server" section: an optional MEMGLOW_MEMORY_URL's own /healthz, never a secret. */
function controlRenderMemoryServer(ms, T) {
  T = T || defaultControlT;
  if (!ms || !ms.configured) return '<p class="mg-control__line">' + cEsc(T("control.memoryServerOff")) + '</p>';
  if (!ms.ok) return '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.memoryServerError", { error: ms.error || "?" })) + '</p>';
  var mode = T(ms.readOnly === false ? "control.memoryServerReadWrite" : "control.memoryServerReadOnly");
  var tok = T(ms.tokenRequired ? "control.memoryServerTokenYes" : "control.memoryServerTokenNo");
  return '<p class="mg-control__line">' + cEsc(T("control.memoryServerOk", { mode: mode, notes: ms.notes != null ? ms.notes : "?", version: ms.version || "?" })) + ' · ' + cEsc(tok) + '</p>';
}

/** The "Measures" section: per-AI-tool tokens relayed (GET /api/cost's clientTokens) + the proxy-seen badge. */
function controlRenderMeasures(clientTokens, proxySeen, now, T) {
  T = T || defaultControlT;
  var out = "";
  out += '<p class="mg-control__line">' + (proxySeen ? cEsc(T("control.proxySeen", { ago: controlAgo((now || Date.now()) - proxySeen.t, T), ms: proxySeen.durationMs != null ? proxySeen.durationMs : "?" })) : cEsc(T("control.proxyNeverSeen"))) + '</p>';
  var by = (clientTokens && clientTokens.byClient) || {};
  var ids = Object.keys(by);
  if (!ids.length) { out += '<p class="mg-control__line">' + cEsc(T("control.measuresEmpty")) + '</p>'; return out; }
  out += '<p class="mg-control__subhead">' + cEsc(T("control.byClientTitle")) + '</p><ul class="mg-control__clients">' +
    ids.map(function (id) { return '<li>' + cEsc(id) + ': ' + (by[id].tokens || 0) + ' tokens, ' + (by[id].calls || 0) + ' calls</li>'; }).join("") +
    '</ul>';
  return out;
}

/** Full panel body from { setup, maintenance, cost } (GET /api/setup, /api/maintenance, /api/cost). */
function controlRender(data, T) {
  T = T || defaultControlT;
  var setup = data.setup || {};
  var c = setup.control || { proxy: { levers: [], caps: [] }, maintenance: {}, memoryServer: { configured: false }, proxySeen: null };
  var out = "";
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionSavings")) + '</h3>' + controlRenderLevers(c.proxy, T) + '</section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMaintenance")) + '</h3>' + controlRenderMaintenance(c.maintenance, data.maintenance, Date.now(), T) + '</section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMemoryServer")) + '</h3>' + controlRenderMemoryServer(c.memoryServer, T) + '</section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMeasures")) + '</h3>' + controlRenderMeasures(data.cost && data.cost.clientTokens, c.proxySeen, Date.now(), T) + '</section>';
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cEsc: cEsc, EN_CONTROL: EN_CONTROL, resolveTextControl: resolveTextControl, defaultControlT: defaultControlT,
    controlAgo: controlAgo, controlSourceText: controlSourceText, controlLeverRow: controlLeverRow,
    controlRenderLevers: controlRenderLevers, controlRenderMaintenance: controlRenderMaintenance,
    controlRenderMemoryServer: controlRenderMemoryServer, controlRenderMeasures: controlRenderMeasures,
    controlRender: controlRender,
  };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var tile = document.getElementById("mg-control");
  if (!tile) return;
  var body = document.getElementById("mg-control-body");
  var status = document.getElementById("mg-control-status");
  var close = document.getElementById("mg-control-close");
  var open = document.getElementById("mem-control");
  var T = defaultControlT;
  var banner = { root: document.getElementById("mg-banner"), msg: document.getElementById("mg-banner-msg"), btn: document.getElementById("mg-banner-btn") };
  var last = null; // { setup, maintenance, cost }

  function get(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; throw e; }
      return r.json();
    });
  }
  function say(text, bad) {
    status.textContent = text || "";
    status.className = "mg-control__status" + (bad ? " mg-control__status--bad" : "");
  }
  function load() {
    say(T("common.loading"), false);
    return Promise.all([get("/api/setup"), get("/api/maintenance"), get("/api/cost")]).then(function (r) {
      last = { setup: r[0], maintenance: r[1], cost: r[2] };
      if (typeof mgClearBanner === "function") mgClearBanner(banner);
      body.innerHTML = controlRender(last, T);
      say("", false);
    }).catch(function (e) {
      say(T("error.connectionLost"), true);
      if (typeof mgBannerKind === "function" && typeof mgErrorBanner === "function" && mgBannerKind(e) === "auth") mgErrorBanner(banner, "auth", T);
    });
  }
  function openPanel() {
    tile.hidden = false;
    load().then(function () { if (tile.scrollIntoView) tile.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }
  var closeOptions = function () { var o = document.getElementById("mem-options"); if (o && o.open) o.open = false; };
  if (open) open.addEventListener("click", function () { closeOptions(); openPanel(); });
  if (close) close.addEventListener("click", function () { tile.hidden = true; });
  document.addEventListener("memglow:language", function () {
    if (!tile.hidden && last) body.innerHTML = controlRender(last, T);
  });
})();
