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
function aiNum(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

var AI_ROLE = { original: "original note → summary", part: "new note", link: "link updated", subtheme: "sub-theme changed", moved: "note at its new place", "moved-from": "old place (moved)", origin: "sections moved out, a link left", archive: "archive note", summary: "archive summary" };
var AI_KIND = { create: "new", modify: "changed", "delete": "moved away" };

/** What an archive proposal moves, and what it saves (lib/archive.js planArchive). */
function aiArchiveGain(a) {
  if (!a || !a.gain) return "";
  var g = a.gain;
  var live = (g.live || []).map(function (x) { return '<code>' + aiEsc(x.rel) + '</code> ≈ ' + aiNum(x.before) + ' → ≈ ' + aiNum(x.after); }).join(", ");
  return '<ul class="mg-ai__moved">' + (a.moved || []).map(function (m) {
    return '<li>§ ' + aiEsc(m.heading) + ' <span class="mg-ai__meta">from ' + aiEsc(m.note) + ' → ' + aiEsc(m.archive) + ' · ≈ ' + aiNum(m.tokens) + ' tokens</span></li>';
  }).join("") + '</ul>' +
    '<p class="mg-ai__gain">Live memory: <strong>≈ ' + aiNum(g.saved) + '</strong> tokens fewer to read (' + live + '). Archive summary: ≈ ' + aiNum(g.summaryTokens) + ' tokens for ' + aiNum(g.summaryLines) + ' line(s).</p>';
}
function aiKeep(keep) {
  if (!keep || !keep.length) return "";
  return '<p class="mg-ai__sub">Kept live by the AI</p>' + aiList(keep.map(function (k) { return k.label + " § " + k.title + (k.why ? " — " + k.why : ""); }), "mg-ai__warnings");
}

function aiDiff(f) {
  var head = '<summary><span class="mg-ai__kind mg-ai__kind--' + aiEsc(f.kind) + '">' + aiEsc(AI_KIND[f.kind] || "changed") + '</span> ' +
    '<code>' + aiEsc(f.rel) + '</code> <span class="mg-ai__role">' + aiEsc(AI_ROLE[f.role] || "") + '</span> ' +
    '<span class="mg-ai__counts"><span class="mg-ai__plus">+' + aiNum(f.added) + '</span> <span class="mg-ai__minus">−' + aiNum(f.removed) + '</span></span></summary>';
  var body = (f.hunks || []).map(function (h) {
    return '<pre class="mg-ai__hunk">' + (h.lines || []).map(function (l) {
      var cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
      return '<span class="mg-ai__l mg-ai__l--' + cls + '">' + (l.t === " " ? " " : aiEsc(l.t)) + " " + aiEsc(l.s) + '</span>';
    }).join("\n") + '</pre>';
  }).join('<p class="mg-ai__gap">…</p>');
  return '<details class="mg-ai__file"' + (f.role === "original" ? " open" : "") + '>' + head + body + '</details>';
}

function aiGain(g) {
  if (!g) return "";
  return '<p class="mg-ai__gain">Reading this note: <strong>≈ ' + aiNum(g.before) + '</strong> tokens today → <strong>≈ ' + aiNum(g.summary) +
    '</strong> for the summary' + (g.saved ? ' (≈ ' + aiNum(g.saved) + ' fewer each time it is read)' : '') + '. Parts: ' +
    (g.parts || []).map(function (p) { return aiEsc(p.id) + ' ≈ ' + aiNum(p.tokens); }).join(", ") + '.</p>';
}

function aiList(items, cls) {
  if (!items || !items.length) return "";
  return '<ul class="' + cls + '">' + items.map(function (e) { return '<li>' + aiEsc(e) + '</li>'; }).join("") + '</ul>';
}

/** The current job, as HTML. `providerLabel` names the AI. */
function aiRenderJob(j, providerLabel) {
  if (!j || j.state === "discarded") return "";
  var who = aiEsc(providerLabel || "the AI");
  var regroup = j.kind === "regroup";
  var arch = j.kind === "archive";
  var title = '<p class="mg-ai__title">' + (arch ? "Archive" : regroup ? "Regroup" : "Split") + ' <strong>' + aiEsc(j.note && j.note.label) + '</strong></p>';
  if (j.state === "running") {
    return title + '<p class="mg-ai__msg">Asking ' + who + (arch ? ' which sections to archive' : ' for a proposal') + '… <span class="mg-ai__chars" id="mg-ai-chars">' + aiNum(j.chars) + '</span> characters received. It has no tool and writes nothing.</p>' +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="cancel">Cancel</button></div>';
  }
  if (j.state === "invalid") {
    return title + '<p class="mg-ai__msg mg-ai__msg--bad">memglow refused this proposal — nothing was written:</p>' + aiList(j.errors, "mg-ai__errors") + (arch ? aiKeep(j.keep) : "") +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="retry">Ask again</button><button type="button" class="bn-btn" data-ai="cancel">Discard</button></div>';
  }
  if (j.state === "failed" || j.state === "cancelled") {
    return title + '<p class="mg-ai__msg mg-ai__msg--bad">' + aiEsc(j.error || "Failed.") + '</p>' +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="retry">Ask again</button><button type="button" class="bn-btn" data-ai="cancel">Discard</button></div>';
  }
  if (j.state === "proposed") {
    return title + (j.notes ? '<p class="mg-ai__notes">' + who + ': “' + aiEsc(j.notes) + '”</p>' : '') + (arch ? aiArchiveGain(j.archive) + aiKeep(j.keep) : aiGain(j.gain)) +
      aiList(j.warnings, "mg-ai__warnings") +
      '<p class="mg-ai__msg">' + (arch
        ? "memglow checked it: every moved section is in its archive note word for word, the original notes can be rebuilt exactly, each archive note is in the same theme, nothing is overwritten or deleted, every link points to an existing note, protected groups respected. Exact changes:"
        : regroup
          ? "memglow checked it: same group, note texts unchanged (only the sub-theme line), no note replaced or deleted, protected groups respected. Exact changes:"
          : "memglow checked it: nothing lost, same folder and group, no note replaced or deleted, protected groups respected. Exact changes:") + '</p>' +
      (j.files || []).map(aiDiff).join("") +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn mg-ai__apply" data-ai="apply">Apply this plan</button><button type="button" class="bn-btn" data-ai="cancel">Discard</button></div>' +
      '<p class="mg-ai__hint">Apply backs up the notes first (git snapshot if your memory is a git repository, otherwise a copy in memglow\'s data folder); if the backup fails, nothing is written.</p>';
  }
  if (j.state === "applying") return title + '<p class="mg-ai__msg">Backing up and writing…</p>';
  if (j.state === "applied") {
    return title + '<p class="mg-ai__msg mg-ai__msg--ok">Applied. ' + (j.files || []).length + ' file(s) written; backup: ' +
      (j.backup ? aiEsc(j.backup.kind === "git" ? "git commit " + j.backup.ref : "copy in " + j.backup.dir) : "—") + '.</p>' + (arch ? aiArchiveGain(j.archive) : aiGain(j.gain)) +
      '<div class="mg-ai__btns"><button type="button" class="bn-btn" data-ai="undo">Undo</button></div>';
  }
  if (j.state === "undone") {
    var u = j.undo || { restored: [], removed: [], skipped: [] };
    return title + '<p class="mg-ai__msg">Undone: ' + u.restored.length + ' restored, ' + u.removed.length + ' removed.</p>' +
      (u.skipped.length ? '<p class="mg-ai__msg mg-ai__msg--bad">Left as they are (changed since):</p>' + aiList(u.skipped.map(function (s) { return s.rel + " — " + s.why; }), "mg-ai__errors") : "");
  }
  return "";
}

/** Recent applied changes (Undo stays available). */
function aiRenderHistory(h, currentId) {
  var rows = (h || []).filter(function (j) { return j.id !== currentId && j.state === "applied"; });
  if (!rows.length) return "";
  return '<p class="mg-ai__sub">Recent changes</p><ul class="mg-ai__recent">' + rows.map(function (j) {
    return '<li><span>' + aiEsc(j.note && j.note.label) + ' — ' + (j.files || []).length + ' file(s)</span> <button type="button" class="bn-btn" data-ai="undo" data-job="' + aiEsc(j.id) + '">Undo</button></li>';
  }).join("") + '</ul>';
}

function aiRenderProviders(list, current) {
  return (list || []).map(function (p) {
    var state = !p.implemented ? "not supported yet" : p.available ? "ready" : p.detected ? "installed, not ready" : "not set up";
    var extra = "";
    if (p.kind === "http" && p.implemented) {
      extra = ' <span class="mg-ai__meta">' + (p.destination ? (p.local ? "on this machine (" + aiEsc(p.destination) + ")" : "sends to " + aiEsc(p.destination)) : "no URL") +
        (p.model ? " · model " + aiEsc(p.model) : "") + " · key: " + aiEsc(p.key || "not set") + '</span>';
    }
    var why = p.implemented && !p.available && p.reason ? '<br><span class="mg-ai__meta">' + aiEsc(p.reason) + '</span>' : "";
    return '<li' + (p.id === current ? ' class="mg-ai__current"' : '') + '><code>' + aiEsc(p.id) + '</code> ' + aiEsc(p.label) + ' — ' + aiEsc(state) + (p.id === current ? " (default)" : "") + extra + why + '</li>';
  }).join("");
}

/** Where the note goes with this provider, said BEFORE the user asks. */
function aiDestination(p) {
  if (!p) return "";
  if (p.kind === "http") {
    if (p.local) return '<p class="mg-ai__dest mg-ai__dest--local" id="mg-ai-dest">Local model — nothing leaves your machine (' + aiEsc(p.destination) + ').</p>';
    return '<p class="mg-ai__dest" id="mg-ai-dest">Your note will be sent to <strong>' + aiEsc(p.destination || "?") + '</strong>' + (p.model ? ' (model ' + aiEsc(p.model) + ')' : '') + '.</p>';
  }
  return '<p class="mg-ai__dest" id="mg-ai-dest">Your note will be sent through your ' + aiEsc(p.label) + ' (to Anthropic, or wherever your CLI is set up to send it).</p>';
}

/** `providers` = the status list, `current` = the default provider id, `kind` = "split" (default) or "regroup". */
function aiAskForm(noteId, label, providers, current, kind) {
  var regroup = kind === "regroup";
  var ready = (providers || []).filter(function (p) { return p.implemented && p.available; });
  var sel = ready.filter(function (p) { return p.id === current; })[0] || ready[0] || null;
  var picker = ready.length > 1
    ? '<label class="mg-ai__extra">AI<select id="mg-ai-provider">' + ready.map(function (p) {
      return '<option value="' + aiEsc(p.id) + '"' + (p === sel ? " selected" : "") + '>' + aiEsc(p.label) + '</option>';
    }).join("") + '</select></label>'
    : "";
  return (regroup
    ? '<p class="mg-ai__title">Regroup: <strong>' + aiEsc(label || noteId) + '</strong></p>' +
      '<p class="mg-ai__msg">Only the titles, descriptions, sub-themes and folders of these notes are sent to the AI — never their text. It answers with a proposal; memglow only changes sub-theme lines (or moves a file inside the same group), and nothing is written until you approve the exact changes.</p>'
    : '<p class="mg-ai__title">Split <strong>' + aiEsc(label || noteId) + '</strong>?</p>' +
      '<p class="mg-ai__msg">The note is sent to the AI, which answers with a proposal. Nothing is written until you approve the exact changes. Lines that look like secrets are replaced by placeholders first.</p>') +
    picker + aiDestination(sel) +
    '<label class="mg-ai__extra">Extra instructions (optional)<textarea id="mg-ai-extra" maxlength="1000" rows="2"></textarea></label>' +
    '<div class="mg-ai__btns"><button type="button" class="bn-btn mg-ai__apply" data-ai="propose" data-kind="' + (regroup ? "regroup" : "split") + '" data-note="' + aiEsc(noteId) + '"' + (sel ? ' data-provider="' + aiEsc(sel.id) + '"' : '') + '>Propose</button><button type="button" class="bn-btn" data-ai="close">Not now</button></div>';
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { aiArchiveGain: aiArchiveGain, aiEsc: aiEsc, aiRenderJob: aiRenderJob, aiRenderHistory: aiRenderHistory, aiRenderProviders: aiRenderProviders, aiAskForm: aiAskForm, aiDiff: aiDiff, aiDestination: aiDestination };
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
  var st = null, asking = null, lastNote = null, lastExtra = "", lastProvider = "", lastKind = "split";

  function post(action, body) {
    return fetch(api + "/" + action, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Memglow": "1" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (o) {
        if (!r.ok) throw new Error(o.error || ("HTTP " + r.status));
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
    if (!st.available) say(st.reason || "The assistant is not available.", true);
    else say("Ready — provider: " + st.provider.label + ".", false);
    if (asking && !(st.job && (st.job.state === "running" || st.job.state === "applying"))) elJob.innerHTML = aiAskForm(asking.id, asking.label, st.providers, st.provider && st.provider.id, asking.kind);
    else elJob.innerHTML = aiRenderJob(st.job, labelOfProvider(st.job && st.job.provider));
    elHist.innerHTML = aiRenderHistory(st.history, st.job && st.job.id);
    elProv.innerHTML = aiRenderProviders(st.providers, st.provider && st.provider.id);
  }
  function load() {
    return fetch(api, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (s) { st = s; render(); }).catch(function () { say("Could not reach memglow: reload the page.", true); });
  }
  function fail(e) { say(e.message || String(e), true); load(); }

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
    if (dest && p) dest.outerHTML = aiDestination(p);
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
  }
  load();
})();
