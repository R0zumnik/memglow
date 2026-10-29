/*!
 * memglow — Settings → Control panel. MIT License.
 *
 * Shows the MCP proxy's lever values (where each one comes from: an environment variable, the
 * page, memglow.config.json, or the built-in default — GET /api/setup's `control.proxy`), the
 * last memory-maintenance scan (`control.maintenance` + GET /api/maintenance's item count), an
 * optional memory server's health (`control.memoryServer`) and a few measurements (GET
 * /api/cost's `clientTokens`, per-AI-tool token totals).
 *
 * 0.4.7.3: the lever checkboxes are now real switches, saved through the SAME PUT /api/setup as
 * every other setting here (a `proxy` body part, validated server-side as a CLOSED list — see
 * lib/setup.js validate()). An env-locked lever's checkbox is disabled ("locked by MEMGLOW_…").
 * Levers are read once at proxy START: saving shows a banner asking for a restart.
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
  "control.memoryServerFsync": "writes: fsync {mode}",
  "control.autoSplitOn": { one: "Auto-split: on — {provider} {model}, {n} note pending", other: "Auto-split: on — {provider} {model}, {n} notes pending" },
  "control.autoSplitOff": "Auto-split: off",
  "control.structureOn": { one: "Structure guardian: on — {n} issue found", other: "Structure guardian: on — {n} issues found" },
  "control.structureOff": "Structure guardian: off",
  "control.workerAutoSplit": "Auto-split",
  "control.workerStructure": "Structure guardian",
  "control.workerAuthError": "{worker}: stopped — auth error: {message}",
  "control.archiveOn": { one: "Auto-archive: on — {n} note archived recently", other: "Auto-archive: on — {n} notes archived recently" },
  "control.archiveOff": "Auto-archive: off",
  "control.duplicatesOn": { one: "Duplicates: on — {n} pair reported", other: "Duplicates: on — {n} pairs reported" },
  "control.duplicatesOff": "Duplicates: off",
  "control.workerArchive": "Auto-archive",
  "control.workerDuplicates": "Duplicates",
  "control.recentArchivesTitle": "Recently archived",
  "control.reportedDuplicatesTitle": "Reported duplicate pairs",
  "control.duplicatePairReason": "{a} / {b}: {reason}",
  "control.measuresEmpty": "No measurements yet.",
  "control.byClientTitle": "By AI tool (7 days)",
  "control.byLeverTitle": "By lever (7 days)",
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
  "control.lever.slugHint": "Writing a note whose title is not a kebab slug, or directly in the notes root, gets a short hint suggesting the slug and a sub-folder.",
  "control.restartNotice": "Restart the MCP proxy to apply a lever change: it reads its settings once, at start.",
  "control.resetToDefault": "Reset to default",
  "control.maintEveryHoursLabel": "Scan every (hours, 0 = only at start)",
  "control.archiveAfterDaysLabel": "Archive after not read for (days)",
  "control.indexTrimMaxCharsLabel": "Index-trim candidate line length (characters)",
  "control.indexWarningTokensLabel": "The index itself is too large above (tokens)",
  "control.sessionsPerDayLabel": "Sessions per day (when activity counters cannot tell)",
  "control.runNow": "Run now",
  "control.ranNow": "Scan complete: {n} item(s) found.",
  "setup.saving": "Saving…", "setup.saved": "Saved.", "setup.notSaved": "Not saved: {error}",
  "aiset.save": "Save",
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

/**
 * One lever row — 0.4.7.3: a real switch, `checked` from the current value, `disabled` and a
 * "locked by MEMGLOW_…" badge for an env-locked lever (the page can never override an environment
 * variable). `vals` (optional): what the form holds right now, for a redraw (e.g. a language
 * change) that must not lose an unsaved toggle — `vals[key]` wins over `l.value` when present.
 */
function controlLeverRow(l, T, vals) {
  T = T || defaultControlT;
  var checked = vals && Object.prototype.hasOwnProperty.call(vals, l.key) ? !!vals[l.key] : !!l.value;
  var help = T("control.lever." + l.key);
  // Minor 2 (0.4.7.6): a "reset to default" control, shown only when there IS something to reset
  // (not already the default) and not env-locked (an environment variable can never be reset
  // from the page anyway — there is nothing saved here to remove).
  var reset = !l.envLocked && l.source !== "default"
    ? '<button type="button" class="bn-btn bn-btn--quiet mg-control__reset" data-reset-lever="' + cEsc(l.key) + '">' + cEsc(T("control.resetToDefault")) + '</button>' : "";
  return '<li class="mg-control__lever" data-lever="' + cEsc(l.key) + '">' +
    '<label class="mg-control__leverhead">' +
    '<input type="checkbox" data-lever="' + cEsc(l.key) + '"' + (checked ? " checked" : "") + (l.envLocked ? " disabled" : "") + '>' +
    '<code>' + cEsc(l.key) + '</code>' +
    (l.envLocked ? '<span class="mg-control__lock">' + cEsc(T("control.locked", { name: l.env || "" })) + '</span>' : '<span class="mg-control__source">' + cEsc(controlSourceText(l, T)) + '</span>') +
    reset +
    '</label><p class="mg-control__help">' + cEsc(help === "control.lever." + l.key ? "" : help) + '</p></li>';
}

/** The "Token savings" section: day-one levers first, the rest under a collapsible "Advanced". */
function controlRenderLevers(proxy, T, vals) {
  T = T || defaultControlT;
  var levers = (proxy && proxy.levers) || [];
  var caps = (proxy && proxy.caps) || [];
  var day1 = levers.filter(function (l) { return l.day1; });
  var rest = levers.filter(function (l) { return !l.day1; });
  var out = '<ul class="mg-control__levers">' + day1.map(function (l) { return controlLeverRow(l, T, vals); }).join("") + '</ul>';
  if (rest.length) {
    out += '<details class="mg-control__advanced"><summary>' + cEsc(T("control.advanced")) + '</summary>' +
      '<ul class="mg-control__levers">' + rest.map(function (l) { return controlLeverRow(l, T, vals); }).join("") + '</ul></details>';
  }
  // Caps are read-only even here (edited from Settings → AI settings' "tuning", not this page).
  if (caps.length) {
    out += '<ul class="mg-control__caps">' + caps.map(function (c) {
      return '<li><code>' + cEsc(c.key) + '</code> = ' + cEsc(c.value) + ' (' + cEsc(controlSourceText(c, T)) + ')</li>';
    }).join("") + '</ul>';
  }
  out += '<div class="mg-setup__btns mg-control__btns"><button type="submit" class="bn-btn mg-zones__save">' + cEsc(T("aiset.save")) + '</button></div>' +
    '<p class="mg-control__status" id="mg-control-proxy-status" role="status"></p>';
  return out;
}

/** What the lever checkboxes hold right now → { key: boolean } (disabled/locked ones excluded —
 * same convention as public/setup.js's setupCollectTuning: an env-locked switch is never sent). */
/**
 * What the lever checkboxes hold right now → { key: boolean }. Minor 2 (0.4.7.6): when
 * `effectiveByKey` ({ key: current effective boolean }, e.g. built from GET /api/setup's
 * `control.proxy.levers`) is given, only keys whose checkbox DIFFERS from that effective value
 * are included — saving must never pin all 16 levers as `source: "page"` just because the form
 * always renders all of them; only an actual change is sent (and stored — see
 * lib/setup.js createSetupStore.write()'s per-key merge, 0.4.7.6 M1). Without `effectiveByKey`
 * (older callers, direct tests), every checkbox is included, as before.
 */
function controlCollectProxy(inputs, effectiveByKey) {
  var out = {};
  Array.prototype.forEach.call(inputs || [], function (el) {
    var k = el.getAttribute("data-lever");
    if (!k || el.disabled) return;
    var v = !!el.checked;
    if (effectiveByKey && Object.prototype.hasOwnProperty.call(effectiveByKey, k) && effectiveByKey[k] === v) return;
    out[k] = v;
  });
  return out;
}

// 0.4.7.4: the "tuning" fields this section edits, [key, i18n label key, min, max].
var MAINT_TUNING_FIELDS = [
  // Capped at 168 h (one week) — CRITICAL, 0.4.7.6: above 2^31-1 ms, Node clamps the delay to
  // 1 ms (a runaway timer); see lib/setup.js TUNING and lib/maintenance.js's own defensive clamp.
  ["maintenanceEveryHours", "control.maintEveryHoursLabel", 0, 168],
  ["archiveAfterDays", "control.archiveAfterDaysLabel", 7, 3650],
  ["indexTrimMaxChars", "control.indexTrimMaxCharsLabel", 30, 1000],
  ["indexWarningTokens", "control.indexWarningTokensLabel", 100, 1000000],
  ["sessionsPerDay", "control.sessionsPerDayLabel", 1, 1000],
];

/**
 * The "Memory maintenance" section: last scan time + how many opportunities GET /api/maintenance
 * lists, the five tuning fields (0.4.7.4, saved through PUT /api/setup's existing `tuning` body
 * part — the same route AI settings' own tuning fields already use), and a "Run now" button
 * (POST /api/maintenance/run). `vals` (optional): the tuning form's current, possibly-unsaved
 * state, kept across a redraw.
 */
function controlRenderMaintenance(maintenance, maintResult, tuning, now, T, vals) {
  T = T || defaultControlT;
  tuning = tuning || {};
  var locked = tuning.locked || {};
  var generatedAt = maintenance && maintenance.generatedAt;
  var head = generatedAt ? T("control.maintenanceGeneratedAt", { date: new Date(generatedAt).toLocaleString() }) : T("control.maintenanceNever");
  var n = maintResult && Array.isArray(maintResult.items) ? maintResult.items.length : 0;
  var out = '<p class="mg-control__line">' + cEsc(head) + (generatedAt ? " · " + cEsc(T("control.maintenanceItems", { n: n })) : "") + '</p>';
  out += '<form id="mg-control-maint-form"><ul class="mg-control__tuning">' + MAINT_TUNING_FIELDS.map(function (f) {
    var key = f[0], label = f[1], min = f[2], max = f[3];
    var v = vals && Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : tuning[key];
    var lock = locked[key];
    return '<li><label class="mg-setup__field"><span>' + cEsc(T(label)) + '</span>' +
      '<input class="mg-setup__input" type="number" data-maint="' + cEsc(key) + '" min="' + min + '" max="' + max + '" step="1" inputmode="numeric" value="' + cEsc(v == null ? "" : v) + '"' + (lock ? " disabled" : "") + '></label>' +
      (lock ? '<span class="mg-control__lock">' + cEsc(T("control.locked", { name: lock })) + '</span>' : "") + '</li>';
  }).join("") + '</ul>' +
    '<div class="mg-setup__btns mg-control__btns"><button type="submit" class="bn-btn mg-zones__save">' + cEsc(T("aiset.save")) + '</button>' +
    '<button type="button" class="bn-btn" id="mg-control-run-now">' + cEsc(T("control.runNow")) + '</button></div>' +
    '<p class="mg-control__status" id="mg-control-maint-status" role="status"></p></form>';
  return out;
}

/** What the maintenance-tuning inputs hold right now → { key: number } (disabled/locked excluded). */
function controlCollectMaintTuning(inputs) {
  var out = {};
  Array.prototype.forEach.call(inputs || [], function (el) {
    var k = el.getAttribute("data-maint");
    if (!k || el.disabled) return;
    var raw = String(el.value == null ? "" : el.value).trim();
    if (raw !== "") out[k] = Number(raw);
  });
  return out;
}

/** The "Memory server" section: an optional MEMGLOW_MEMORY_URL's own /healthz, never a secret. */
function controlRenderMemoryServer(ms, T) {
  T = T || defaultControlT;
  if (!ms || !ms.configured) return '<p class="mg-control__line">' + cEsc(T("control.memoryServerOff")) + '</p>';
  if (!ms.ok) return '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.memoryServerError", { error: ms.error || "?" })) + '</p>';
  var mode = T(ms.readOnly === false ? "control.memoryServerReadWrite" : "control.memoryServerReadOnly");
  var tok = T(ms.tokenRequired ? "control.memoryServerTokenYes" : "control.memoryServerTokenNo");
  // 0.4.10.1: the server's fsync mode, a read-only badge (set on the server's command line or
  // environment only — never from this page).
  var fsb = ms.fsyncMode === "sync" || ms.fsyncMode === "deferred" || ms.fsyncMode === "none"
    ? ' <span class="mg-control__badge" data-fsync-mode="' + cEsc(ms.fsyncMode) + '">' + cEsc(T("control.memoryServerFsync", { mode: ms.fsyncMode })) + '</span>' : "";
  return '<p class="mg-control__line">' + cEsc(T("control.memoryServerOk", { mode: mode, notes: ms.notes != null ? ms.notes : "?", version: ms.version || "?" })) + ' · ' + cEsc(tok) + fsb + "</p>";
}

/**
 * 0.5.4: the memory server's own built-in auto-split / structure-guardian workers (GET
 * /api/maintenance, through lib/setup.js's memoryMaintenanceStatus — same MEMGLOW_MEMORY_URL,
 * same optional token). `mm` = null/`{configured:false}` (not reachable, or the same
 * MEMGLOW_MEMORY_URL as `ms` above is simply not set) → nothing rendered, same as the "Memory
 * server" card itself staying silent. Never a secret: only "keySet" (true/false), never a key.
 */
function controlRenderMaintenanceWorkers(mm, T) {
  T = T || defaultControlT;
  if (!mm || !mm.configured || !mm.ok) return "";
  const as = mm.autoSplit || { enabled: false };
  const st = mm.structure || { enabled: false };
  // 0.5.6: auto-archive (PRUNE STALE → ARCHIVE) and duplicates — same shape/fallback pattern as
  // autoSplit/structure above; `mm` may still lack either on an older memory server (lib/setup.js
  // memoryMaintenanceStatus() already defaults both to a harmless, fully-off shape in that case).
  const ar = mm.archive || { enabled: false };
  const du = mm.duplicates || { enabled: false };
  const asLine = as.enabled
    ? T("control.autoSplitOn", { n: as.pendingCount || 0, provider: as.provider || "?", model: as.model || "?" })
    : T("control.autoSplitOff");
  const stLine = st.enabled ? T("control.structureOn", { n: st.issues || 0 }) : T("control.structureOff");
  const arLine = ar.enabled ? T("control.archiveOn", { n: (ar.recent || []).length }) : T("control.archiveOff");
  const duLine = du.enabled ? T("control.duplicatesOn", { n: (du.reported || []).length }) : T("control.duplicatesOff");
  var out = '<p class="mg-control__line">' + cEsc(asLine) + '</p><p class="mg-control__line">' + cEsc(stLine) + '</p>' +
    '<p class="mg-control__line">' + cEsc(arLine) + '</p><p class="mg-control__line">' + cEsc(duLine) + '</p>';
  // 0.5.4: a worker that already gave up on a bad credential for the rest of its process
  // lifetime (see lib/ai-provider.js's isAuthError()) — shown so Florent notices instead of the
  // worker silently doing nothing until the server restarts with a fixed key.
  if (as.lastError) out += '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.workerAuthError", { worker: T("control.workerAutoSplit"), message: as.lastError.message || "?" })) + '</p>';
  if (st.lastError) out += '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.workerAuthError", { worker: T("control.workerStructure"), message: st.lastError.message || "?" })) + '</p>';
  if (ar.lastError) out += '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.workerAuthError", { worker: T("control.workerArchive"), message: ar.lastError.message || "?" })) + '</p>';
  if (du.lastError) out += '<p class="mg-control__line mg-control__line--bad">' + cEsc(T("control.workerAuthError", { worker: T("control.workerDuplicates"), message: du.lastError.message || "?" })) + '</p>';
  // 0.5.6: last scan time (the same generic line the "Memory maintenance" section's own header
  // already uses — no worker name baked into the key, so this stays a plain re-use, not a new
  // text string per worker) and the two detail lists the task asks for: recent archives, and the
  // reported duplicate pairs with their AI reason.
  if (ar.enabled && ar.lastScanAt) out += '<p class="mg-control__line">' + cEsc(T("control.maintenanceGeneratedAt", { date: new Date(ar.lastScanAt).toLocaleString() })) + '</p>';
  if (du.enabled && du.lastScanAt) out += '<p class="mg-control__line">' + cEsc(T("control.maintenanceGeneratedAt", { date: new Date(du.lastScanAt).toLocaleString() })) + '</p>';
  if (ar.enabled && (ar.recent || []).length) {
    out += '<p class="mg-control__subhead">' + cEsc(T("control.recentArchivesTitle")) + '</p><ul class="mg-control__clients">' +
      ar.recent.map(function (e) { return "<li>" + cEsc(e.note || "?") + (e.detail ? " — " + cEsc(e.detail) : "") + "</li>"; }).join("") +
      '</ul>';
  }
  if (du.enabled && (du.reported || []).length) {
    out += '<p class="mg-control__subhead">' + cEsc(T("control.reportedDuplicatesTitle")) + '</p><ul class="mg-control__clients">' +
      du.reported.map(function (r) { return "<li>" + cEsc(T("control.duplicatePairReason", { a: r.a || "?", b: r.b || "?", reason: r.reason || "?" })) + "</li>"; }).join("") +
      '</ul>';
  }
  return out;
}

/** The "Measures" section: per-AI-tool tokens relayed (GET /api/cost's clientTokens) + the proxy-seen badge. */
function controlRenderMeasures(clientTokens, proxySeen, now, T) {
  T = T || defaultControlT;
  var out = "";
  out += '<p class="mg-control__line">' + (proxySeen ? cEsc(T("control.proxySeen", { ago: controlAgo((now || Date.now()) - proxySeen.t, T), ms: proxySeen.durationMs != null ? proxySeen.durationMs : "?" })) : cEsc(T("control.proxyNeverSeen"))) + '</p>';
  var by = (clientTokens && clientTokens.byClient) || {};
  var ids = Object.keys(by);
  var byLever = (clientTokens && clientTokens.byLever) || {};
  var leverIds = Object.keys(byLever);
  if (!ids.length && !leverIds.length) { out += '<p class="mg-control__line">' + cEsc(T("control.measuresEmpty")) + '</p>'; return out; }
  if (ids.length) {
    out += '<p class="mg-control__subhead">' + cEsc(T("control.byClientTitle")) + '</p><ul class="mg-control__clients">' +
      ids.map(function (id) { return '<li>' + cEsc(id) + ': ' + (by[id].tokens || 0) + ' tokens, ' + (by[id].calls || 0) + ' calls</li>'; }).join("") +
      '</ul>';
  }
  if (leverIds.length) {
    out += '<p class="mg-control__subhead">' + cEsc(T("control.byLeverTitle")) + '</p><ul class="mg-control__clients">' +
      leverIds.map(function (k) { return '<li><code>' + cEsc(k) + '</code>: ' + (byLever[k].tokens || 0) + ' tokens, ' + (byLever[k].calls || 0) + ' calls</li>'; }).join("") +
      '</ul>';
  }
  return out;
}

/** Full panel body from { setup, maintenance, cost } (GET /api/setup, /api/maintenance, /api/cost).
 * `vals` (optional): { proxy, maint } — each form's current, possibly-unsaved state, kept across
 * a redraw (a language change, or right after the OTHER form saved). */
function controlRender(data, T, vals) {
  T = T || defaultControlT;
  vals = vals || {};
  var setup = data.setup || {};
  var c = setup.control || { proxy: { levers: [], caps: [] }, maintenance: {}, memoryServer: { configured: false }, memoryMaintenance: { configured: false }, proxySeen: null };
  var out = "";
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionSavings")) + '</h3>' +
    '<form id="mg-control-proxy-form">' + controlRenderLevers(c.proxy, T, vals.proxy) + '</form></section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMaintenance")) + '</h3>' + controlRenderMaintenance(c.maintenance, data.maintenance, setup.tuning, Date.now(), T, vals.maint) + '</section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMemoryServer")) + '</h3>' + controlRenderMemoryServer(c.memoryServer, T) + controlRenderMaintenanceWorkers(c.memoryMaintenance, T) + '</section>';
  out += '<section class="mg-control__section"><h3>' + cEsc(T("control.sectionMeasures")) + '</h3>' + controlRenderMeasures(data.cost && data.cost.clientTokens, c.proxySeen, Date.now(), T) + '</section>';
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cEsc: cEsc, EN_CONTROL: EN_CONTROL, resolveTextControl: resolveTextControl, defaultControlT: defaultControlT,
    controlAgo: controlAgo, controlSourceText: controlSourceText, controlLeverRow: controlLeverRow,
    controlRenderLevers: controlRenderLevers, controlCollectProxy: controlCollectProxy,
    controlRenderMaintenance: controlRenderMaintenance, controlCollectMaintTuning: controlCollectMaintTuning,
    controlRenderMemoryServer: controlRenderMemoryServer, controlRenderMaintenanceWorkers: controlRenderMaintenanceWorkers, controlRenderMeasures: controlRenderMeasures,
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
  var last = null;         // { setup, maintenance, cost }
  var typed = {};          // { proxy, maint } — each form's current, possibly-unsaved state
  var restartShown = false; // the restart notice, once a save actually changed a lever

  function get(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; throw e; }
      return r.json();
    });
  }
  function put(body2) {
    return fetch("/api/setup", {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Memglow": "1" },
      body: JSON.stringify(body2),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }
  function say(text, bad) {
    status.textContent = text || "";
    status.className = "mg-control__status" + (bad ? " mg-control__status--bad" : "");
  }
  function sayAt(id, text, bad) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "mg-control__status" + (bad ? " mg-control__status--bad" : "");
  }
  function failAt(id, err) {
    sayAt(id, T("setup.notSaved", { error: (err && err.body && err.body.error) || (err && err.mgStatus ? "HTTP " + err.mgStatus : T("error.connectionLost")) }), true);
    if (typeof mgBannerKind === "function" && typeof mgErrorBanner === "function" && mgBannerKind(err) === "auth") mgErrorBanner(banner, "auth", T);
  }
  /** { key: effective boolean } from the last GET /api/setup's control.proxy.levers — minor 2. */
  function effectiveProxyByKey() {
    var out = {};
    var levers = (last && last.setup && last.setup.control && last.setup.control.proxy && last.setup.control.proxy.levers) || [];
    levers.forEach(function (l) { out[l.key] = !!l.value; });
    return out;
  }
  function proxyForm() { return document.getElementById("mg-control-proxy-form"); }
  function maintForm() { return document.getElementById("mg-control-maint-form"); }
  function keepProxyTyped() { var f = proxyForm(); if (f) typed.proxy = controlCollectProxy(f.querySelectorAll("input[data-lever]")); }
  function keepMaintTyped() { var f = maintForm(); if (f) typed.maint = controlCollectMaintTuning(f.querySelectorAll("input[data-maint]")); }
  function render() {
    body.innerHTML = controlRender(last, T, typed);
    if (restartShown) sayAt("mg-control-proxy-status", T("control.restartNotice"), false);
  }
  function load() {
    say(T("common.loading"), false);
    return Promise.all([get("/api/setup"), get("/api/maintenance"), get("/api/cost")]).then(function (r) {
      last = { setup: r[0], maintenance: r[1], cost: r[2] };
      typed = {};
      if (typeof mgClearBanner === "function") mgClearBanner(banner);
      render();
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
  // Both forms are delegated (redrawn on every load()/render()).
  body.addEventListener("submit", function (e) {
    var proxy = e.target && e.target.closest ? e.target.closest("#mg-control-proxy-form") : null;
    var maint = proxy ? null : (e.target && e.target.closest ? e.target.closest("#mg-control-maint-form") : null);
    if (!proxy && !maint) return;
    e.preventDefault();
    if (proxy) {
      // Minor 2 (0.4.7.6): only the levers actually toggled away from their effective value are
      // sent — saving must never pin every lever as "saved here" just because the form renders
      // all 16 of them.
      var diff = controlCollectProxy(proxy.querySelectorAll("input[data-lever]"), effectiveProxyByKey());
      if (!Object.keys(diff).length) { sayAt("mg-control-proxy-status", T("setup.saved"), false); return; }
      sayAt("mg-control-proxy-status", T("setup.saving"), false);
      put({ proxy: diff }).then(function (j) {
        last.setup = j;
        typed.proxy = null;
        restartShown = true;
        render();
      }).catch(function (err) { failAt("mg-control-proxy-status", err); });
    } else {
      typed.maint = controlCollectMaintTuning(maint.querySelectorAll("input[data-maint]"));
      sayAt("mg-control-maint-status", T("setup.saving"), false);
      put({ tuning: typed.maint }).then(function (j) {
        last.setup = j;
        typed.maint = null;
        sayAt("mg-control-maint-status", T("setup.saved"), false);
        render();
      }).catch(function (err) { failAt("mg-control-maint-status", err); });
    }
  });
  body.addEventListener("click", function (e) {
    var resetBtn = e.target && e.target.closest ? e.target.closest("button[data-reset-lever]") : null;
    if (resetBtn) {
      var key = resetBtn.getAttribute("data-reset-lever");
      sayAt("mg-control-proxy-status", T("setup.saving"), false);
      var body2 = {}; body2[key] = null;
      put({ proxy: body2 }).then(function (j) {
        last.setup = j;
        typed.proxy = null;
        restartShown = true;
        render();
      }).catch(function (err) { failAt("mg-control-proxy-status", err); });
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest("#mg-control-run-now") : null;
    if (!btn) return;
    keepMaintTyped();
    sayAt("mg-control-maint-status", T("setup.saving"), false);
    fetch("/api/maintenance/run", { method: "POST", credentials: "same-origin", headers: { "X-Memglow": "1" } }).then(function (r) {
      if (!r.ok) { var e2 = new Error(String(r.status)); e2.mgStatus = r.status; throw e2; }
      return r.json();
    }).then(function (j) {
      last.maintenance = j;
      sayAt("mg-control-maint-status", T("control.ranNow", { n: (j.items || []).length }), false);
      render();
    }).catch(function (err) { failAt("mg-control-maint-status", err); });
  });
  // A toggle/edit, before saving: keep it (redraw-safe) without losing the rest of that form.
  body.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute("data-lever")) keepProxyTyped();
    else if (t.getAttribute("data-maint")) keepMaintTyped();
  });
  document.addEventListener("memglow:language", function () {
    if (!tile.hidden && last) { keepProxyTyped(); keepMaintTyped(); render(); }
  });
})();
