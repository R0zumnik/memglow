/*!
 * memglow — Memory cost panel. MIT License.
 *
 * How many tokens an assistant spends reading this memory (estimate: ≈ bytes ÷ 4), which notes
 * cost the most, which are too large, which are never read, and how to split a large note.
 * Data: GET /api/cost (lib/cost.js). Hand-made HTML, no library. Every note title and section
 * title goes through costEsc() before it reaches innerHTML.
 *
 * Pure rendering functions first (exported for the Node tests), then the page wiring.
 */

function costEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function costNumber(n) {
  n = Math.round(Number(n) || 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** "≈ 1,234" — every token figure is an estimate. */
function costTokens(n) {
  return n == null || !isFinite(n) ? "≈ —" : "≈ " + costNumber(n);
}
/** "Sep 30" for "2026-09-30" (English, independent of the browser locale). */
function costDay(day) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[Number(m[2]) - 1] + " " + Number(m[3]);
}
function costColor(colors, theme) {
  var c = colors && colors[theme];
  return /^#[0-9A-Fa-f]{6}$/.test(String(c || "")) ? c : "#A9C9BF";
}
function costPlural(n, word) {
  return costNumber(n) + " " + word + (n === 1 ? "" : "s");
}

/** Text of a part in a split suggestion: its section titles. */
function costPartName(part) {
  var t = (part.titles || []).map(function (x) { return x || "(introduction)"; });
  return t.join(", ");
}

/** Full name of a group (top-level theme): its label from the configuration, never a bare id. */
function costGroupName(theme, names) {
  if (names && Object.prototype.hasOwnProperty.call(names, theme) && names[theme]) return String(names[theme]);
  if (theme === "index") return "Index";
  return "Other";
}

/**
 * Ready-to-paste English prompt asking an AI assistant to split one note, with the rules that
 * keep the memory consistent. `n` is an item of /api/cost (tooLarge or top), `c` the whole answer,
 * `names` the group labels ({ themeId: label }). Built at click time, never put in the page.
 */
function costSplitPrompt(n, c, names) {
  var large = c.largeNoteTokens || 5000, chunk = c.chunkTokens || 2000;
  var group = costGroupName(n.theme, names);
  var groups = Object.keys(names || {}).filter(function (k) { return k !== "index" && k !== "other"; })
    .map(function (k) { return costGroupName(k, names); });
  var partial = c.read && c.read.complete7 === false && c.since ? " (counted since " + costDay(c.since) + ")" : "";
  var lines = [];
  lines.push("Please split one note of my AI memory into several smaller notes. Show me the plan BEFORE writing anything.");
  lines.push("");
  lines.push("Note: \"" + n.label + "\" (id: " + n.id + ", folder: " + (n.folder || "(root)") + ", group: " + group +
    (n.subtheme ? ", subtheme: " + n.subtheme : "") + ")");
  lines.push("Size: ≈ " + costNumber(n.tokens) + " tokens (estimate: bytes ÷ 4). Read " + costPlural(n.reads7 || 0, "time") +
    " in the last 7 days" + partial + ", ≈ " + costNumber(n.readTokens7 || 0) + " tokens read in total.");
  // Honest about why this note is here: above the threshold, or under it but costly to read.
  if (n.tokens > large) {
    lines.push("It is above the ≈ " + costNumber(large) + "-token threshold for large notes.");
  } else {
    lines.push("It is under the ≈ " + costNumber(large) + "-token threshold for large notes, but it is one of the notes that cost the most to read over the last 7 days.");
  }
  lines.push("Aim for new notes of ≈ " + costNumber(chunk) + " tokens or less.");
  lines.push("");
  if (n.split && n.split.length > 1) {
    lines.push("Suggested split into " + n.split.length + " notes (consecutive ## sections, in order):");
    n.split.forEach(function (p, i) {
      lines.push((i + 1) + ". " + costPartName(p) + " — ≈ " + costNumber(p.tokens) + " tokens");
    });
  } else {
    lines.push("Suggested split: group consecutive ## sections into notes of ≈ " + costNumber(chunk) + " tokens or less.");
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- Keep every new note in the same group (" + group + ") and the same folder as the original note.");
  lines.push("- Do not create, rename or remove top-level groups" + (groups.length ? " (" + groups.join(", ") + ")" : "") + ".");
  lines.push("- Keep the `theme` and `subtheme` (or `sous_theme`) frontmatter keys on every new note, with the original values.");
  lines.push("- Keep every [[link]] valid: update the links that pointed to the moved content, and link the new notes to each other where it helps.");
  lines.push("- The original note becomes a short summary that links to the new notes, or is removed once nothing links to it any more.");
  lines.push("- Use only your memory tool (the one you normally use to read and write these notes). Do not edit the files any other way.");
  lines.push("- First show me the plan (new note names and titles, which sections go where, which links change), then wait for my OK before writing.");
  return lines.join("\n");
}

function costFigures(c) {
  var items = [
    ["Tokens read today", costTokens(c.read.today), ""],
    ["Tokens read · 7 days", costTokens(c.read.days7), ""],
    ["Tokens written · 7 days", costTokens(c.written.days7), ""],
    ["Whole memory", costTokens(c.totals.tokens), costPlural(c.totals.notes, "note")],
    ["Index note", c.index ? costTokens(c.index.tokens) : "≈ —", c.index ? "each time it is read" : "no index note"],
  ];
  return items.map(function (d) {
    return '<div class="mg-cost__fig"><p class="mg-cost__fig-name">' + costEsc(d[0]) + '</p>' +
      '<p class="mg-cost__fig-val">' + costEsc(d[1]) + '</p>' +
      (d[2] ? '<p class="mg-cost__fig-det">' + costEsc(d[2]) + '</p>' : '') + '</div>';
  }).join("");
}

/** "3 notes = 59 % of tokens read (7 days)", with a two-part bar. */
function costShare(share) {
  if (!share) return '<p class="mg-cost__empty">No read counted in the last 7 days yet.</p>';
  var p = Math.max(0, Math.min(100, share.percent));
  return '<div class="mg-cost__share"><p class="mg-cost__share-text"><strong>' + costPlural(share.notes, "note") + '</strong> = <strong>' + p +
    ' %</strong> of tokens read (7 days)</p><div class="mg-cost__share-bar" role="img" aria-label="' + p + ' percent"><span style="width:' + p + '%"></span></div></div>';
}

function costName(n, colors) {
  return '<span class="mg-cost__name"><span class="mg-cost__dot" style="--c:' + costColor(colors, n.theme) + '"></span>' +
    '<span class="mg-cost__label">' + costEsc(n.label) + '</span></span>';
}

function costCopyButton(n) {
  return '<button type="button" class="bn-btn mg-cost__copy" data-copy="' + costEsc(n.id) + '">Copy prompt for your AI</button>';
}

function costTop(top, colors, c) {
  if (!top || !top.length) return '<p class="mg-cost__empty">No read counted in the last 7 days yet.</p>';
  var max = top[0].readTokens7 || 1;
  return '<ol class="mg-cost__list">' + top.map(function (n) {
    var w = Math.max(2, Math.round((n.readTokens7 / max) * 100));
    return '<li class="mg-cost__item"><div class="mg-cost__row" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' + costName(n, colors) +
      '<strong class="mg-cost__num">' + costTokens(n.readTokens7) + '</strong>' +
      '<span class="mg-cost__bar"><span style="width:' + w + '%;background:' + costColor(colors, n.theme) + '"></span></span>' +
      '<span class="mg-cost__det">' + costPlural(n.reads7, "read") + ' × ' + costTokens(n.tokens) + '</span></div>' +
      (n.tokens > c.chunkTokens ? costCopyButton(n) : '') + '</li>';
  }).join("") + '</ol>';
}

function costSplit(n) {
  if (!n.sections || !n.sections.length) return "";
  var list = n.sections.map(function (s) {
    return '<li>' + costEsc(s.title || "(introduction)") + ' — ' + costTokens(s.tokens) + '</li>';
  }).join("");
  var plan = n.split
    ? '<p class="mg-cost__plan">Split into ' + n.split.length + ' notes: ' + n.split.map(function (p) {
        return '<span class="mg-cost__part">' + costEsc(costPartName(p)) + ' <em>' + costTokens(p.tokens) + '</em></span>';
      }).join(" · ") + '</p>'
    : '<p class="mg-cost__plan">A single section: no split to suggest from headings.</p>';
  return '<details class="mg-cost__sections"><summary>Sections (' + n.sections.length + ')</summary><ol>' + list + '</ol>' + plan + '</details>';
}

function costLarge(list, colors, c) {
  if (!list.length) return '<p class="mg-cost__empty">No note above ' + costTokens(c.largeNoteTokens) + ' tokens.</p>';
  return '<ul class="mg-cost__list">' + list.map(function (n) {
    return '<li class="mg-cost__item"><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' +
      costName(n, colors) + '<strong class="mg-cost__num">' + costTokens(n.tokens) + '</strong></div>' +
      costSplit(n) + costCopyButton(n) + '</li>';
  }).join("") + '</ul>';
}

function costNeverRead(nr, colors) {
  if (!nr.available) {
    return '<p class="mg-cost__empty">' + (nr.since
      ? 'Data since ' + costEsc(costDay(nr.since)) + ' — less than 30 days of counting so far.'
      : 'No data yet.') + '</p>';
  }
  if (!nr.notes.length) return '<p class="mg-cost__empty">Every note was read at least once in 30 days.</p>';
  var more = nr.total - nr.notes.length;
  return '<ul class="mg-cost__list mg-cost__list--compact">' + nr.notes.map(function (n) {
    return '<li><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' + costName(n, colors) +
      '<span class="mg-cost__det">' + costTokens(n.tokens) + '</span></div></li>';
  }).join("") + '</ul>' + (more > 0 ? '<p class="mg-cost__empty">+ ' + costNumber(more) + ' more.</p>' : '');
}

/** The whole panel body, or a short message when there is nothing to show. */
function costRender(c, colors) {
  if (!c || !c.read) return '<p class="mg-cost__empty">Memory cost is not available.</p>';
  var html = '<div class="mg-cost__figs">' + costFigures(c) + '</div>';
  html += costShare(c.share);
  html += '<div class="mg-cost__grid">';
  html += '<figure class="mg-cost__block"><figcaption>Most expensive to read · 7 days</figcaption>' + costTop(c.top, colors, c) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>Too large (&gt; ' + costEsc(costTokens(c.largeNoteTokens)) + ' tokens)</figcaption>' + costLarge(c.tooLarge, colors, c) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>Never read in 30 days</figcaption>' + costNeverRead(c.neverRead, colors) + '</figure>';
  html += '</div>';
  return html;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { costEsc: costEsc, costNumber: costNumber, costTokens: costTokens, costDay: costDay, costSplitPrompt: costSplitPrompt, costRender: costRender, costPartName: costPartName, costGroupName: costGroupName };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var root = document.getElementById("mg-cost");
  var body = document.getElementById("mg-cost-body");
  if (!root || !body) return;
  var url = root.getAttribute("data-cost");
  var colors = {}, names = { index: "Index" };
  try {
    var cfg = JSON.parse(document.getElementById("memglow-config").textContent || "{}");
    (cfg.themes || []).forEach(function (t) { colors[t.id] = t.color; names[t.id] = t.label; });
  } catch (e) { /* default colours */ }
  var last = null, pending = null, loading = false, again = false;

  function load() {
    if (loading) { again = true; return; } // asked during a load: load again right after
    again = false;
    loading = true;
    fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (c) {
      last = c;
      // Keep open "Sections" boxes open across refreshes.
      var open = {};
      Array.prototype.forEach.call(body.querySelectorAll("details[open]"), function (d) {
        var row = d.parentNode && d.parentNode.querySelector("[data-note]");
        if (row) open[row.getAttribute("data-note")] = true;
      });
      // The panel is redrawn after activity: keyboard focus comes back to the same copy button.
      var active = document.activeElement;
      var focused = active && body.contains && body.contains(active) && active.getAttribute ? active.getAttribute("data-copy") : null;
      body.innerHTML = costRender(c, colors);
      Array.prototype.forEach.call(body.querySelectorAll(".mg-cost__item"), function (li) {
        var row = li.querySelector("[data-note]"), d = li.querySelector("details");
        if (row && d && open[row.getAttribute("data-note")]) d.open = true;
      });
      if (focused) {
        var again2 = body.querySelector('[data-copy="' + focused.replace(/["\\]/g, "") + '"]');
        if (again2 && again2.focus) again2.focus();
      }
    }).catch(function () {
      if (!last) body.innerHTML = '<p class="mg-cost__empty">Could not load Memory cost.</p>';
    }).then(function () { loading = false; if (again) soon(); });
  }
  // Refresh ≈ 1.5 s after an activity or a note change, grouped: the timer is NOT restarted by each
  // event, so a burst makes one request, and a continuous flow still refreshes every 1.5 s at most.
  function soon() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; load(); }, 1500);
  }

  function itemOf(id) {
    if (!last) return null;
    var all = (last.tooLarge || []).concat(last.top || []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, ko) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.className = "mg-cost__offscreen";
      document.body.appendChild(ta);
      ta.select();
      var done = false;
      try { done = document.execCommand("copy"); } catch (e) { done = false; }
      document.body.removeChild(ta);
      if (done) ok(); else ko(new Error("copy"));
    });
  }
  function copyPrompt(btn) {
    var n = itemOf(btn.getAttribute("data-copy"));
    if (!n) return;
    var text = costSplitPrompt(n, last, names);
    copyText(text).then(function () {
      btn.textContent = "Copied ✓";
      btn.classList.add("mg-cost__copy--done");
      setTimeout(function () { btn.textContent = "Copy prompt for your AI"; btn.classList.remove("mg-cost__copy--done"); }, 2000);
    }).catch(function () {
      // Last resort: show the text, selected, for a manual copy.
      var ta = btn.parentNode.querySelector("textarea.mg-cost__manual");
      if (!ta) {
        ta = document.createElement("textarea");
        ta.className = "mg-cost__manual";
        ta.setAttribute("readonly", "");
        ta.setAttribute("aria-label", "Prompt to copy");
        btn.parentNode.appendChild(ta);
      }
      ta.value = text;
      ta.focus();
      ta.select();
      btn.textContent = "Select and copy the text below";
    });
  }
  function openNote(id) {
    try { document.dispatchEvent(new CustomEvent("memglow:ouvrir", { detail: id })); } catch (e) { return; }
    var stage = document.querySelector(".mem-stage");
    if (stage && stage.scrollIntoView) stage.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  body.addEventListener("click", function (e) {
    var t = e.target;
    var btn = t.closest && t.closest("[data-copy]");
    if (btn) { copyPrompt(btn); return; }
    var row = t.closest && t.closest("[data-note]");
    if (row) openNote(row.getAttribute("data-note"));
  });
  body.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var row = e.target.closest && e.target.closest("[data-note]");
    if (!row || e.target !== row) return;
    e.preventDefault();
    openNote(row.getAttribute("data-note"));
  });
  // An activity, or a note changed on disk (counted as a write by the server).
  document.addEventListener("memglow:activite", soon);
  document.addEventListener("memglow:changement", soon);
  document.addEventListener("memglow:pret", load);
  setInterval(function () { if (!document.hidden) load(); }, 60000);
  load();
})();
