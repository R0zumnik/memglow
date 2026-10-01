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

/** The rows of the form. `z` = GET /api/zones. Not defined yet: every group holding notes is ticked. */
function zonesRender(z) {
  var themes = (z && z.themes) || [];
  if (!themes.length) return '<p class="mg-cost__empty">No group is configured.</p>';
  var prot = (z && z.defined) ? (z.protected || []) : themes.filter(function (t) { return t.notes > 0; }).map(function (t) { return t.id; });
  return '<ul class="mg-zones__list">' + themes.map(function (t) {
    var color = /^#[0-9A-Fa-f]{6}$/.test(String(t.color || "")) ? t.color : "#A9C9BF";
    var det = t.notes + " note" + (t.notes === 1 ? "" : "s") + (t.folders && t.folders.length ? " · folders: " + t.folders.join(", ") : "");
    return '<li class="mg-zones__row">' +
      '<label class="mg-zones__check"><input type="checkbox" name="protect" value="' + zEsc(t.id) + '"' + (prot.indexOf(t.id) >= 0 ? " checked" : "") + '> Protect</label>' +
      '<span class="mg-cost__dot" style="--c:' + color + '"></span>' +
      '<input type="text" class="mg-zones__label" data-theme="' + zEsc(t.id) + '" data-default="' + zEsc(t.defaultLabel) + '" value="' + zEsc(t.label) + '" maxlength="40" aria-label="Display name of the group ' + zEsc(t.id) + '">' +
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
  module.exports = { zEsc: zEsc, zonesRender: zonesRender, zonesCollect: zonesCollect };
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

  function say(msg, bad) {
    status.textContent = msg;
    status.className = "mg-zones__status" + (bad ? " mg-zones__status--bad" : "");
  }
  function load(show) {
    return fetch(api, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (z) {
      body.innerHTML = zonesRender(z);
      var postponed = false;
      try { postponed = window.sessionStorage.getItem(LATER_KEY) === "1"; } catch (e) { postponed = false; }
      if (show || (!z.defined && !postponed)) {
        root.hidden = false;
        say(z.defined ? (z.source === "config" ? "Defined in memglow.config.json — saving here overrides it." : "Saved on this memglow instance.") : "Nothing protected yet: choose and save.", false);
      }
    }).catch(function () { if (show) { root.hidden = false; say("Could not reach memglow: reload the page.", true); } });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = zonesCollect(form.querySelectorAll('input[name="protect"]'), form.querySelectorAll(".mg-zones__label"));
    say("Saving…", false);
    fetch(api, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Memglow": "1" },
      body: JSON.stringify(data),
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 400 ? "memglow refused these values." : "HTTP " + r.status);
      say("Saved. Reloading to show the new names…", false);
      setTimeout(function () { window.location.reload(); }, 600);
    }).catch(function (err) { say("Not saved: " + (err.message || err), true); });
  });
  later.addEventListener("click", function () {
    try { window.sessionStorage.setItem(LATER_KEY, "1"); } catch (e) { /* private mode */ }
    root.hidden = true;
  });
  if (open) open.addEventListener("click", function () {
    load(true).then(function () { if (root.scrollIntoView) root.scrollIntoView({ behavior: "smooth", block: "start" }); });
  });
  load(false);
})();
