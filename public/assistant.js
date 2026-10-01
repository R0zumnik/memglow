/*!
 * memglow — Assistant panel (optional, only served when the assistant is enabled). MIT License.
 *
 * The AI proposes, memglow applies: this panel asks for a proposal for one note, shows memglow's
 * verdict and the exact diff of every file, and applies it only on a click on "Apply this plan"
 * (which first fetches a one-time confirmation token from the server). Undo restores the backup.
 * Every text that comes from a note or from the AI goes through aiEsc() before innerHTML.
 * Pure rendering functions first (exported for the Node tests), then the page wiring.
 */

function aiEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
/* Numbers in the memglow language (window.MemglowI18n.lang(), never the browser locale), with Intl:
   "1 234" in French — same options as public/i18n.js formatNumber, copied so this file stays
   self-contained. English "1,234" without Intl, without the page language, or in the Node tests. */
var AI_FMT = {};
function aiNum(n, lang) {
  n = Math.round(Number(n) || 0);
  if (!lang) { var M = typeof window !== "undefined" && window.MemglowI18n; lang = M && typeof M.lang === "function" ? M.lang() : "en"; }
  if (!Object.prototype.hasOwnProperty.call(AI_FMT, lang)) {
    var f = null;
    try { if (typeof Intl !== "undefined" && Intl.NumberFormat) f = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }); } catch (e) { f = null; }
    AI_FMT[lang] = f;
  }
  return AI_FMT[lang] ? AI_FMT[lang].format(n) : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ---- i18n (public/i18n.js, public/i18n/<code>.json) ----
   Same approach as app.js/cost.js: a small English copy of just the keys this file renders, used
   whenever window.MemglowI18n is not available (Node tests, or before the page's language loads),
   kept in sync with public/i18n/en.json by a test. Every function below takes T last, optional,
   defaulting to the page's current language. */
var EN_AI = {
  "ai.theAi": "the AI", "ai.roleOriginal": "original note → summary", "ai.rolePart": "new note", "ai.roleLink": "link updated",
  "ai.roleSubtheme": "sub-theme changed", "ai.roleMoved": "note at its new place", "ai.roleMovedFrom": "old place (moved)",
  "ai.roleOrigin": "sections moved out, a link left", "ai.roleArchive": "archive note", "ai.roleSummary": "archive summary",
  "ai.badgeNew": "new", "ai.badgeChanged": "changed", "ai.badgeMovedAway": "moved away",
  "ai.gain": "Reading this note: ≈ {before} tokens today → ≈ {after} for the summary{saved}. Parts: {parts}.",
  "ai.gainSaved": " (≈ {n} fewer each time it is read)",
  "ai.archiveMovedFrom": "from {note} → {archive} · ≈ {tokens} tokens",
  "ai.archiveGain": "Live memory: {saved} tokens fewer to read ({live}). Archive summary: ≈ {summaryTokens} tokens for {lines}.",
  "ai.lineCount": { one: "{n} line", other: "{n} lines" },
  "ai.keptLive": "Kept live by the AI",
  "ai.splitTitle": "Split {label}", "ai.regroupTitle": "Regroup {label}", "ai.archiveTitle": "Archive {label}",
  "ai.asking": "Asking {who} for a proposal… {chars} characters received. It has no tool and writes nothing.",
  "ai.askingArchive": "Asking {who} which sections to archive… {chars} characters received. It has no tool and writes nothing.",
  "ai.cancel": "Cancel", "ai.discard": "Discard", "ai.retry": "Ask again",
  "ai.refused": "memglow refused this proposal — nothing was written:", "ai.failedDefault": "Failed.",
  "ai.aiNotes": "{who}: “{notes}”",
  "ai.checked": "memglow checked it: nothing lost, same folder and group, no note replaced or deleted, protected groups respected. Exact changes:",
  "ai.checkedRegroup": "memglow checked it: same group, note texts unchanged (only the sub-theme line), no note replaced or deleted, protected groups respected. Exact changes:",
  "ai.checkedArchive": "memglow checked it: every moved section is in its archive note word for word, the original notes can be rebuilt exactly, each archive note is in the same theme, nothing is overwritten or deleted, every link points to an existing note, protected groups respected. Exact changes:",
  "ai.apply": "Apply this plan",
  "ai.applyHint": "Apply backs up the notes first (git snapshot if your memory is a git repository, otherwise a copy in memglow's data folder); if the backup fails, nothing is written.",
  "ai.applying": "Backing up and writing…",
  "ai.applied": "Applied. {files} written; backup: {backup}.",
  "ai.fileCount": { one: "{n} file", other: "{n} files" },
  "ai.backupGit": "git commit {ref}", "ai.backupCopy": "copy in {dir}",
  "ai.undo": "Undo", "ai.undone": "Undone: {restored} restored, {removed} removed.",
  "ai.leftAsIs": "Left as they are (changed since):", "ai.recentChanges": "Recent changes",
  "ai.notSupported": "not supported yet", "ai.ready": "ready", "ai.installedNotReady": "installed, not ready", "ai.notSetUp": "not set up",
  "ai.onThisMachine": "on this machine ({dest})", "ai.sendsTo": "sends to {dest}", "ai.noUrl": "no URL",
  "ai.modelSuffix": " · model {model}", "ai.keySuffix": " · key: {key}", "ai.keyNotSet": "not set", "ai.defaultTag": " (default)",
  "ai.destLocal": "Local model — nothing leaves your machine ({dest}).",
  "ai.destRemote": "Your note will be sent to {dest}{model}.", "ai.destModelSuffix": " (model {model})",
  "ai.destCli": "Your note will be sent through your {label} (to Anthropic, or wherever your CLI is set up to send it).",
  "ai.providerLabel": "AI", "ai.splitTitleQuestion": "Split {label}?", "ai.regroupTitleQuestion": "Regroup: {label}",
  "ai.askMsg": "The note is sent to the AI, which answers with a proposal. Nothing is written until you approve the exact changes. Lines that look like secrets are replaced by placeholders first.",
  "ai.regroupAskMsg": "Only the titles, descriptions, sub-themes and folders of these notes are sent to the AI — never their text. It answers with a proposal; memglow only changes sub-theme lines (or moves a file inside the same group), and nothing is written until you approve the exact changes.",
  "ai.extraLabel": "Extra instructions (optional)", "ai.propose": "Propose", "ai.notNow": "Not now",
  "ai.unavailable": "The assistant is not available.", "ai.readyProvider": "Ready — provider: {label}.",
  "ai.unreachable": "Could not reach memglow: reload the page.",
  "common.reload": "Reload", "common.retry": "Retry",
  "error.connectionLost": "Connection lost. Check your network and retry.",
  "error.unauthorized": "Unauthorized. Reload the page to sign in again.",
  "error.serverError": "Server error. Please retry."
};
function resolveTextAi(dict, key, params) {
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
function defaultAiT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextAi(EN_AI, key, params);
}

/* Shared error banner: same trio as public/app.js (see its longer comment for the full rule),
   duplicated here — this file is an independent <script>, not a module. */
function mgBannerKind(err) {
  if (err && (err.mgStatus === 401 || err.mgStatus === 403)) return "auth";
  if (err && err.mgStatus) return "server";
  return "network";
}
function mgErrorBanner(els, kind, T, retry) {
  if (!els || !els.root || !els.msg || !els.btn) return;
  var key = kind === "auth" ? "error.unauthorized" : kind === "server" ? "error.serverError" : "error.connectionLost";
  els.msg.textContent = T(key);
  var canRetry = kind !== "auth" && typeof retry === "function";
  els.btn.textContent = T(canRetry ? "common.retry" : "common.reload");
  els.btn.onclick = canRetry ? retry : function () {
    if (typeof window !== "undefined" && window.location) window.location.reload();
  };
  els.root.hidden = false;
}
function mgClearBanner(els) {
  if (els && els.root) els.root.hidden = true;
}

var AI_ROLE_KEYS = {
  original: "ai.roleOriginal", part: "ai.rolePart", link: "ai.roleLink", subtheme: "ai.roleSubtheme",
  moved: "ai.roleMoved", "moved-from": "ai.roleMovedFrom", origin: "ai.roleOrigin", archive: "ai.roleArchive", summary: "ai.roleSummary"
};
var AI_KIND_KEYS = { create: "ai.badgeNew", modify: "ai.badgeChanged", "delete": "ai.badgeMovedAway" };
function aiRoleLabel(role, T) {
  T = T || defaultAiT;
  return Object.prototype.hasOwnProperty.call(AI_ROLE_KEYS, role) ? T(AI_ROLE_KEYS[role]) : "";
}

/** `key`'s translation, split around the literal "{param}" placeholder (left untouched because
    `extra` never sets it) — lets a piece of HTML (a bold label, here) sit exactly where the
    translator put the placeholder, in any language's word order. Returns [before, after]. */
function aiSplitAround(T, key, param, extra) {
  var tmpl = T(key, extra || {});
  var marker = "{" + param + "}";
  var i = tmpl.indexOf(marker);
  return i < 0 ? [tmpl, ""] : [tmpl.slice(0, i), tmpl.slice(i + marker.length)];
}

/** What an archive proposal moves, and what it saves (lib/archive.js planArchive). */
function aiArchiveGain(a, T) {
  T = T || defaultAiT;
  if (!a || !a.gain) return "";
  var g = a.gain;
  var live = (g.live || []).map(function (x) { return x.rel + ' ≈ ' + aiNum(x.before) + ' → ≈ ' + aiNum(x.after); }).join(", ");
  var parts = aiSplitAround(T, "ai.archiveGain", "saved", { live: live, summaryTokens: aiNum(g.summaryTokens), lines: T("ai.lineCount", { n: g.summaryLines || 0 }) });
  return '<ul class="mg-ai__moved">' + (a.moved || []).map(function (m) {
    return '<li>§ ' + aiEsc(m.heading) + ' <span class="mg-ai__meta">' + aiEsc(T("ai.archiveMovedFrom", { note: m.note, archive: m.archive, tokens: aiNum(m.tokens) })) + '</span></li>';
  }).join("") + '</ul>' +
    '<p class="mg-ai__gain">' + aiEsc(parts[0]) + '<strong>≈ ' + aiNum(g.saved) + '</strong>' + aiEsc(parts[1]) + '</p>';
}
function aiKeep(keep, T) {
  T = T || defaultAiT;
  if (!keep || !keep.length) return "";
  return '<p class="mg-ai__sub">' + aiEsc(T("ai.keptLive")) + '</p>' + aiList(keep.map(function (k) { return k.label + " § " + k.title + (k.why ? " — " + k.why : ""); }), "mg-ai__warnings");
}

function aiDiff(f, T) {
  T = T || defaultAiT;
  var head = '<summary><span class="mg-ai__kind mg-ai__kind--' + aiEsc(f.kind) + '">' + aiEsc(T(AI_KIND_KEYS[f.kind] || "ai.badgeChanged")) + '</span> ' +
    '<code>' + aiEsc(f.rel) + '</code> <span class="mg-ai__role">' + aiEsc(aiRoleLabel(f.role, T)) + '</span> ' +
    '<span class="mg-ai__counts"><span class="mg-ai__plus">+' + aiNum(f.added) + '</span> <span class="mg-ai__minus">−' + aiNum(f.removed) + '</span></span></summary>';
  var body = (f.hunks || []).map(function (h) {
    return '<pre class="mg-ai__hunk">' + (h.lines || []).map(function (l) {
      var cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
      return '<span class="mg-ai__l mg-ai__l--' + cls + '">' + (l.t === " " ? " " : aiEsc(l.t)) + " " + aiEsc(l.s) + '</span>';
    }).join("\n") + '</pre>';
  }).join('<p class="mg-ai__gap">…</p>');
  return '<details class="mg-ai__file"' + (f.role === "original" ? " open" : "") + '>' + head + body + '</details>';
}

function aiGain(g, T) {
  T = T || defaultAiT;
  if (!g) return "";
  // Raw (unescaped) pieces here: the whole T("ai.gain", …) result is escaped once, below — g.parts
  // carries a note id, which could contain HTML-special characters.
  var saved = g.saved ? T("ai.gainSaved", { n: aiNum(g.saved) }) : "";
  var parts = (g.parts || []).map(function (p) { return p.id + ' ≈ ' + aiNum(p.tokens); }).join(", ");
  return '<p class="mg-ai__gain">' + aiEsc(T("ai.gain", { before: aiNum(g.before), after: aiNum(g.summary), saved: saved, parts: parts })) + '</p>';
}

function aiList(items, cls) {
  if (!items || !items.length) return "";
  return '<ul class="' + cls + '">' + items.map(function (e) { return '<li>' + aiEsc(e) + '</li>'; }).join("") + '</ul>';
}

/** The current job, as HTML. `providerLabel` names the AI. `T` defaults to the page's language. */
function aiRenderJob(j, providerLabel, T) {
  T = T || defaultAiT;
  if (!j || j.state === "discarded") return "";
  var who = aiEsc(providerLabel || T("ai.theAi"));
  var regroup = j.kind === "regroup";
  var arch = j.kind === "archive";
  var titleParts = aiSplitAround(T, arch ? "ai.archiveTitle" : regroup ? "ai.regroupTitle" : "ai.splitTitle", "label");
  var title = '<p class="mg-ai__title">' + aiEsc(titleParts[0]) + '<strong>' + aiEsc(j.note && j.note.label) + '</strong>' + aiEsc(titleParts[1]) + '</p>';
  if (j.state === "running") {
    return title + '<p class="mg-ai__msg">' + T(arch ? "ai.askingArchive" : "ai.asking", { who: who, chars: '<span class="mg-ai__chars" id="mg-ai-chars">' + aiNum(j.chars) + '</span>' }) + '</p>' +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="cancel">' + aiEsc(T("ai.cancel")) + '</button></div>';
  }
  if (j.state === "invalid") {
    return title + '<p class="mg-ai__msg mg-ai__msg--bad">' + aiEsc(T("ai.refused")) + '</p>' + aiList(j.errors, "mg-ai__errors") + (arch ? aiKeep(j.keep, T) : "") +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="retry">' + aiEsc(T("ai.retry")) + '</button><button type="button" class="bn-btn" data-ai="cancel">' + aiEsc(T("ai.discard")) + '</button></div>';
  }
  if (j.state === "failed" || j.state === "cancelled") {
    return title + '<p class="mg-ai__msg mg-ai__msg--bad">' + aiEsc(j.error || T("ai.failedDefault")) + '</p>' +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="retry">' + aiEsc(T("ai.retry")) + '</button><button type="button" class="bn-btn" data-ai="cancel">' + aiEsc(T("ai.discard")) + '</button></div>';
  }
  if (j.state === "proposed") {
    return title + (j.notes ? '<p class="mg-ai__notes">' + T("ai.aiNotes", { who: who, notes: aiEsc(j.notes) }) + '</p>' : '') + (arch ? aiArchiveGain(j.archive, T) + aiKeep(j.keep, T) : aiGain(j.gain, T)) +
      aiList(j.warnings, "mg-ai__warnings") +
      '<p class="mg-ai__msg">' + aiEsc(T(arch ? "ai.checkedArchive" : regroup ? "ai.checkedRegroup" : "ai.checked")) + '</p>' +
      (j.files || []).map(function (f) { return aiDiff(f, T); }).join("") +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn mg-ai__apply" data-ai="apply">' + aiEsc(T("ai.apply")) + '</button><button type="button" class="bn-btn" data-ai="cancel">' + aiEsc(T("ai.discard")) + '</button></div>' +
      '<p class="mg-ai__hint">' + aiEsc(T("ai.applyHint")) + '</p>';
  }
  if (j.state === "applying") return title + '<p class="mg-ai__msg">' + aiEsc(T("ai.applying")) + '</p>';
  if (j.state === "applied") {
    var backup = j.backup ? (j.backup.kind === "git" ? T("ai.backupGit", { ref: j.backup.ref }) : T("ai.backupCopy", { dir: j.backup.dir })) : "—";
    var filesWord = T("ai.fileCount", { n: (j.files || []).length });
    return title + '<p class="mg-ai__msg mg-ai__msg--ok">' + aiEsc(T("ai.applied", { files: filesWord, backup: backup })) + '</p>' + (arch ? aiArchiveGain(j.archive, T) : aiGain(j.gain, T)) +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="undo">' + aiEsc(T("ai.undo")) + '</button></div>';
  }
  if (j.state === "undone") {
    var u = j.undo || { restored: [], removed: [], skipped: [] };
    return title + '<p class="mg-ai__msg">' + aiEsc(T("ai.undone", { restored: u.restored.length, removed: u.removed.length })) + '</p>' +
      (u.skipped.length ? '<p class="mg-ai__msg mg-ai__msg--bad">' + aiEsc(T("ai.leftAsIs")) + '</p>' + aiList(u.skipped.map(function (s) { return s.rel + " — " + s.why; }), "mg-ai__errors") : "");
  }
  return "";
}

/** Recent applied changes (Undo stays available). */
function aiRenderHistory(h, currentId, T) {
  T = T || defaultAiT;
  var rows = (h || []).filter(function (j) { return j.id !== currentId && j.state === "applied"; });
  if (!rows.length) return "";
  return '<p class="mg-ai__sub">' + aiEsc(T("ai.recentChanges")) + '</p><ul class="mg-ai__recent">' + rows.map(function (j) {
    return '<li><span>' + aiEsc(j.note && j.note.label) + ' — ' + aiEsc(T("ai.fileCount", { n: (j.files || []).length })) + '</span> <button type="button" class="bn-btn" data-ai="undo" data-job="' + aiEsc(j.id) + '">' + aiEsc(T("ai.undo")) + '</button></li>';
  }).join("") + '</ul>';
}

function aiRenderProviders(list, current, T) {
  T = T || defaultAiT;
  return (list || []).map(function (p) {
    var state = !p.implemented ? T("ai.notSupported") : p.available ? T("ai.ready") : p.detected ? T("ai.installedNotReady") : T("ai.notSetUp");
    var extra = "";
    if (p.kind === "http" && p.implemented) {
      extra = ' <span class="mg-ai__meta">' + aiEsc(p.destination ? (p.local ? T("ai.onThisMachine", { dest: p.destination }) : T("ai.sendsTo", { dest: p.destination })) : T("ai.noUrl")) +
        (p.model ? aiEsc(T("ai.modelSuffix", { model: p.model })) : "") + aiEsc(T("ai.keySuffix", { key: p.key || T("ai.keyNotSet") })) + '</span>';
    }
    var why = p.implemented && !p.available && p.reason ? '<br><span class="mg-ai__meta">' + aiEsc(p.reason) + '</span>' : "";
    return '<li' + (p.id === current ? ' class="mg-ai__current"' : '') + '><code>' + aiEsc(p.id) + '</code> ' + aiEsc(p.label) + ' — ' + aiEsc(state) + (p.id === current ? aiEsc(T("ai.defaultTag")) : "") + extra + why + '</li>';
  }).join("");
}

/** Where the note goes with this provider, said BEFORE the user asks. */
function aiDestination(p, T) {
  T = T || defaultAiT;
  if (!p) return "";
  if (p.kind === "http") {
    if (p.local) return '<p class="mg-ai__dest mg-ai__dest--local" id="mg-ai-dest">' + aiEsc(T("ai.destLocal", { dest: p.destination })) + '</p>';
    var model = p.model ? T("ai.destModelSuffix", { model: p.model }) : "";
    var destParts = aiSplitAround(T, "ai.destRemote", "dest", { model: model });
    return '<p class="mg-ai__dest" id="mg-ai-dest">' + aiEsc(destParts[0]) + '<strong>' + aiEsc(p.destination || "?") + '</strong>' + aiEsc(destParts[1]) + '</p>';
  }
  return '<p class="mg-ai__dest" id="mg-ai-dest">' + aiEsc(T("ai.destCli", { label: p.label })) + '</p>';
}

/** `providers` = the status list, `current` = the default provider id, `kind` = "split" (default) or "regroup". */
function aiAskForm(noteId, label, providers, current, kind, T) {
  if (typeof kind === "function") { T = kind; kind = "split"; } // (…, current, T) form
  T = T || defaultAiT;
  var regroup = kind === "regroup";
  var ready = (providers || []).filter(function (p) { return p.implemented && p.available; });
  var sel = ready.filter(function (p) { return p.id === current; })[0] || ready[0] || null;
  var picker = ready.length > 1
    ? '<label class="mg-ai__extra">' + aiEsc(T("ai.providerLabel")) + '<select id="mg-ai-provider">' + ready.map(function (p) {
      return '<option value="' + aiEsc(p.id) + '"' + (p === sel ? " selected" : "") + '>' + aiEsc(p.label) + '</option>';
    }).join("") + '</select></label>'
    : "";
  var titleParts = aiSplitAround(T, regroup ? "ai.regroupTitleQuestion" : "ai.splitTitleQuestion", "label");
  return '<p class="mg-ai__title">' + aiEsc(titleParts[0]) + '<strong>' + aiEsc(label || noteId) + '</strong>' + aiEsc(titleParts[1]) + '</p>' +
    '<p class="mg-ai__msg">' + aiEsc(T(regroup ? "ai.regroupAskMsg" : "ai.askMsg")) + '</p>' +
    picker + aiDestination(sel, T) +
    '<label class="mg-ai__extra">' + aiEsc(T("ai.extraLabel")) + '<textarea id="mg-ai-extra" maxlength="1000" rows="2"></textarea></label>' +
    '<div class="mg-ai__btns"><button type="button" class="bn-btn mg-ai__apply" data-ai="propose" data-kind="' + (regroup ? "regroup" : "split") + '" data-note="' + aiEsc(noteId) + '"' + (sel ? ' data-provider="' + aiEsc(sel.id) + '"' : '') + '>' + aiEsc(T("ai.propose")) + '</button><button type="button" class="bn-btn" data-ai="close">' + aiEsc(T("ai.notNow")) + '</button></div>';
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    aiArchiveGain: aiArchiveGain, aiEsc: aiEsc, aiRenderJob: aiRenderJob, aiRenderHistory: aiRenderHistory, aiRenderProviders: aiRenderProviders,
    aiAskForm: aiAskForm, aiDiff: aiDiff, aiDestination: aiDestination, aiNum: aiNum,
    EN_AI: EN_AI, resolveTextAi: resolveTextAi, defaultAiT: defaultAiT,
    mgBannerKind: mgBannerKind, mgErrorBanner: mgErrorBanner, mgClearBanner: mgClearBanner
  };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var root = document.getElementById("mg-ai");
  if (!root) return;
  var api = root.getAttribute("data-api");
  var elStatus = document.getElementById("mg-ai-status");
  var elJob = document.getElementById("mg-ai-job");
  var elHist = document.getElementById("mg-ai-history");
  var elProv = document.getElementById("mg-ai-providers");
  var T = defaultAiT;
  // Shared with app.js/cost.js/zones.js — same three elements in index.html.
  var banner = { root: document.getElementById("mg-banner"), msg: document.getElementById("mg-banner-msg"), btn: document.getElementById("mg-banner-btn") };
  var st = null, asking = null, lastNote = null, lastExtra = "", lastProvider = "", lastKind = "split";

  function post(action, body) {
    return fetch(api + "/" + action, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Memglow": "1" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (o) {
        if (!r.ok) { var e = new Error(o.error || ("HTTP " + r.status)); e.mgStatus = r.status; throw e; }
        mgClearBanner(banner);
        return o;
      });
    });
  }
  function say(msg, bad) {
    elStatus.textContent = msg;
    elStatus.className = "mg-ai__status" + (bad ? " mg-ai__status--bad" : "");
  }
  function render() {
    if (!st) return;
    if (!st.available) say(st.reason || T("ai.unavailable"), true);
    else say(T("ai.readyProvider", { label: st.provider.label }), false);
    if (asking && !(st.job && (st.job.state === "running" || st.job.state === "applying"))) elJob.innerHTML = aiAskForm(asking.id, asking.label, st.providers, st.provider && st.provider.id, asking.kind, T);
    else elJob.innerHTML = aiRenderJob(st.job, labelOfProvider(st.job && st.job.provider), T);
    elHist.innerHTML = aiRenderHistory(st.history, st.job && st.job.id, T);
    elProv.innerHTML = aiRenderProviders(st.providers, st.provider && st.provider.id, T);
  }
  function load() {
    return fetch(api, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; throw e; }
      mgClearBanner(banner);
      return r.json();
    }).then(function (s) { st = s; render(); }).catch(function (e) {
      say(T("ai.unreachable"), true);
      mgErrorBanner(banner, mgBannerKind(e), T, load);
    });
  }
  function fail(e) {
    say(e.message || String(e), true);
    // A confirmed auth failure also blocks every other request on the page: the panel's own
    // status line already named it (e.message, above), the banner adds the "Reload" everyone else
    // gets too.
    if (mgBannerKind(e) === "auth") mgErrorBanner(banner, "auth", T);
    load();
  }

  function providerOf(id) {
    return ((st && st.providers) || []).filter(function (p) { return p.id === id; })[0] || null;
  }
  function labelOfProvider(id) {
    var p = providerOf(id);
    return p ? p.label : st && st.provider && st.provider.label;
  }
  // Another AI picked in the form: say where the note will go before the click on Propose.
  root.addEventListener("change", function (e) {
    if (!e.target || e.target.id !== "mg-ai-provider") return;
    var p = providerOf(e.target.value);
    var dest = document.getElementById("mg-ai-dest");
    if (dest && p) dest.outerHTML = aiDestination(p, T);
    var btn = root.querySelector('[data-ai="propose"]');
    if (btn && p) btn.setAttribute("data-provider", p.id);
  });

  function labelOf(id) {
    var row = document.querySelector('[data-note="' + String(id).replace(/["\\]/g, "") + '"] .mg-cost__label');
    return row ? row.textContent : id;
  }

  // Archive (Memory cost → Archive block): sections chosen there, with or without the AI's review.
  var lastArchive = null;
  function archive(req) {
    lastArchive = req;
    asking = null;
    var body = { sections: req.sections, ai: !!req.ai };
    if (req.ai && st && st.provider) body.provider = st.provider.id;
    if (root.scrollIntoView) root.scrollIntoView({ behavior: "smooth", block: "start" });
    return post("archive", body).then(function (o) { if (st) { st.job = o.job; render(); } else load(); }).catch(fail);
  }
  document.addEventListener("memglow:archive", function (e) {
    var d = e.detail || {};
    if (!Array.isArray(d.sections) || !d.sections.length) return;
    archive({ sections: d.sections.map(String), ai: d.ai === true });
  });

  document.addEventListener("memglow:assistant", function (e) {
    var d = e.detail;
    // A note to split (its id), or { kind: "regroup", id, label } for an organisation suggestion.
    asking = d && typeof d === "object"
      ? { kind: d.kind === "regroup" ? "regroup" : "split", id: String(d.id || ""), label: String(d.label || d.id || "") }
      : { kind: "split", id: String(d || ""), label: labelOf(d) };
    render();
    if (root.scrollIntoView) root.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  root.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-ai]");
    if (!b || b.disabled) return;
    var what = b.getAttribute("data-ai");
    var job = b.getAttribute("data-job") || (st && st.job && st.job.id);
    if (what === "close") { asking = null; render(); return; }
    b.disabled = true;
    if (what === "retry" && st && st.job && st.job.kind === "archive") {
      if (lastArchive) archive(lastArchive); else load();
      return;
    }
    if (what === "propose" || what === "retry") {
      var note = what === "propose" ? b.getAttribute("data-note") : (st && st.job && st.job.target) || (st && st.job && st.job.note && st.job.note.id) || lastNote;
      var kind = what === "propose" ? (b.getAttribute("data-kind") || "split") : (st && st.job && st.job.kind) || lastKind;
      var ta = document.getElementById("mg-ai-extra");
      var extra = what === "propose" ? (ta ? ta.value : "") : lastExtra;
      var prov = what === "propose" ? (b.getAttribute("data-provider") || "") : (st && st.job && st.job.provider) || lastProvider;
      lastNote = note; lastExtra = extra; lastProvider = prov; lastKind = kind; asking = null;
      var req = kind === "regroup" ? { kind: "regroup", suggestion: note, extra: extra, provider: prov } : { note: note, extra: extra, provider: prov };
      post("propose", req).then(function (o) { st.job = o.job; render(); }).catch(fail);
    } else if (what === "apply") {
      // Two steps, one click: a one-time server token, then apply with it.
      post("confirm", { job: job }).then(function (o) { return post("apply", { job: job, token: o.token }); }).then(load).catch(fail);
    } else if (what === "undo") {
      post("undo", { job: job }).then(load).catch(fail);
    } else if (what === "cancel") {
      post("cancel", { job: job }).then(load).catch(fail);
    }
  });

  if (window.EventSource) {
    var es = new EventSource(api + "/stream");
    es.addEventListener("job", function (e) {
      try { var o = JSON.parse(e.data); if (st) { st.job = o.job; render(); } if (o.job && /applied|undone/.test(o.job.state)) load(); } catch (x) { /* ignore */ }
    });
    es.addEventListener("progress", function (e) {
      try {
        var o = JSON.parse(e.data);
        if (st && st.job && st.job.id === o.id) { st.job.chars = o.chars; var c = document.getElementById("mg-ai-chars"); if (c) c.textContent = aiNum(o.chars); }
      } catch (x) { /* ignore */ }
    });
    es.onopen = function () { mgClearBanner(banner); };
    // Same rule as app.js's own stream: a transient drop reconnects by itself (readyState
    // CONNECTING) and stays quiet; only a non-retryable failure that CLOSEs the connection for
    // good gets a visible banner.
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) mgErrorBanner(banner, "network", T);
    };
  }
  document.addEventListener("memglow:language", render); // T() reads window.MemglowI18n live
  load();
})();
