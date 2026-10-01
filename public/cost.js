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

// Set by the page when the optional assistant is enabled on this instance (config "assistant").
var costAssistant = false;
function costCopyButton(n) {
  return '<button type="button" class="bn-btn mg-cost__copy" data-copy="' + costEsc(n.id) + '">Copy prompt for your AI</button>' +
    (costAssistant ? '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-assist="' + costEsc(n.id) + '">Do it with Claude</button>' : "");
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

// ---- Archive tier (lib/archive.js): dormant sections ----

// Label of the default AI, for "Do it with <provider>" (set by the page).
var costProvider = "";

/** Today as "YYYY-MM-DD" (local). */
function costToday() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Ready-to-paste English prompt asking an AI assistant to archive the chosen dormant sections with
 * its own memory tool, in memglow's archive format (so the archive summary stays readable by
 * memglow and its `archive_lookup` tool). `list` = chosen sections of /api/cost → archive.
 */
function costArchivePrompt(a, list, names, today) {
  var day = today || costToday();
  var lines = [];
  lines.push("Please archive some dormant sections of my AI memory: move them, word for word, out of the notes that are read every day, into archive notes. Show me the plan BEFORE writing anything.");
  lines.push("");
  lines.push("memglow counted that the notes below were not read, nor found by a search, for " + a.afterDays + " days (since " + a.cutoff + "), and that these sections were not edited in that time:");
  list.forEach(function (s, i) {
    lines.push((i + 1) + ". Section \"" + s.title + "\" of note \"" + s.label + "\" (id: " + s.note + ", group: " + costGroupName(s.theme, names) + ") — ≈ " + costNumber(s.tokens) + " tokens");
  });
  lines.push("");
  lines.push("Rules:");
  lines.push("- Move each section (its heading and everything under it, sub-sections included) WORD FOR WORD to the archive note of the SAME group: " + a.folder + "/<group id>-archive.md (for example " + a.folder + "/" + (list[0] ? list[0].theme : "projects") + "-archive.md). Create it if needed, with the frontmatter keys `theme: <group id>`, `subtheme: archive` and `memglow_archive: true`. Never rewrite, shorten or summarise archived text.");
  lines.push("- In the archive note, put this line right before each moved section: <!-- memglow:archived from=\"<note id>\" date=\"" + day + "\" -->");
  lines.push("- In the original note, replace the section by ONE line: Archived: <section title> → [[<group id>-archive#<section title>]] (" + day + "). Change nothing else in that note, frontmatter included.");
  lines.push("- Add one line per archived section to the archive summary " + a.folder + "/" + a.summaryNote + ".md (create it with the frontmatter key `memglow_archive_summary: true` if needed): - " + day + " · <section title> · from [[<note id>]] → [[<group id>-archive#<section title>]] · ≈ <tokens> tokens");
  lines.push("- Keep every note in its group: do not change any `theme` or `subtheme` (or `sous_theme`), and do not create, rename or remove groups.");
  lines.push("- Never overwrite or delete a note. If an archive note already has a section with the same title, stop and ask me.");
  lines.push("- Use only your memory tool (the one you normally use to read and write these notes). First show me the plan, then wait for my OK before writing.");
  return lines.join("\n");
}

/** Archive block: dormant sections with checkboxes, the estimated gain, and the actions. */
function costArchive(a, colors) {
  if (!a) return "";
  if (!a.available) {
    return '<p class="mg-cost__empty">Not enough data yet' + (a.since ? ' since ' + costEsc(costDay(a.since)) : '') + ' — a section is suggested only after ' +
      costNumber(a.afterDays) + ' days of counted activity' + (a.readyOn ? ' (from ' + costEsc(costDay(a.readyOn)) + ')' : '') + '.</p>';
  }
  if (!a.sections.length) return '<p class="mg-cost__empty">No dormant section: every note was read, found or edited in the last ' + costNumber(a.afterDays) + ' days.</p>';
  var more = a.total - a.sections.length;
  var hint = '<p class="mg-arch__hint">Their notes were not read nor found by a search for ' + costNumber(a.afterDays) + ' days, and the sections were not edited (' +
    (a.basis === "section" ? "checked per section" : "checked per note") + '). memglow only sees whole-note reads, so a note read once keeps all its sections live.</p>';
  if (!a.withTitles) {
    return '<p class="mg-cost__empty">' + costPlural(a.total, "dormant section") + ', ' + costTokens(a.totalTokens) + ' tokens. Section titles are hidden (MEMGLOW_SHOW_BODIES is off).</p>' + hint;
  }
  var list = '<ul class="mg-cost__list mg-arch__list">' + a.sections.map(function (s) {
    return '<li class="mg-arch__item"><label class="mg-arch__row"><input type="checkbox" data-archive-key="' + costEsc(s.key) + '" checked>' +
      costName(s, colors) + '<span class="mg-arch__title">§ ' + costEsc(s.title) + '</span>' +
      '<strong class="mg-cost__num">' + costTokens(s.tokens) + '</strong>' +
      '<span class="mg-cost__det">' + (s.lastRead ? 'last read ' + costEsc(costDay(s.lastRead)) : 'not read since counting began') + '</span></label></li>';
  }).join("") + '</ul>' + (more > 0 ? '<p class="mg-cost__empty">+ ' + costPlural(more, "more section") + ' (the biggest are listed).</p>' : '');
  var btns = '<div class="mg-arch__btns"><button type="button" class="bn-btn mg-cost__copy" data-archive-copy="1">Copy prompt for your AI</button>' +
    (costAssistant ? '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-archive-ai="1">Do it with ' + costEsc(costProvider || "your AI") + '</button>' +
      '<button type="button" class="bn-btn mg-cost__copy" data-archive-plain="1">Prepare without AI</button>' : '') + '</div>';
  return hint + list + '<p class="mg-arch__gain" id="mg-arch-gain">' + costArchiveGain(a.sections) + '</p>' + btns;
}

/** "3 sections · live memory ≈ 1,200 tokens smaller · archive summary + ≈ 75 tokens" for the chosen ones. */
function costArchiveGain(chosen) {
  if (!chosen.length) return "No section selected.";
  var saved = 0, line = 0;
  chosen.forEach(function (s) { saved += Math.max(0, s.tokens - (s.stubTokens || 0)); line += s.lineTokens || 0; });
  return '<strong>' + costPlural(chosen.length, "section") + '</strong> · live memory <strong>' + costTokens(saved) + '</strong> tokens smaller (each section leaves a one-line link) · archive summary + ' + costTokens(line) + ' tokens';
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
  if (c.archive) html += '<figure class="mg-cost__block mg-arch" id="mg-arch"><figcaption>Archive · sections unused for ' + costNumber(c.archive.afterDays) + ' days</figcaption>' + costArchive(c.archive, colors) + '</figure>';
  return html;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { setAssistant: function (v, label) { costAssistant = !!v; costProvider = label || ""; }, costArchive: costArchive, costArchivePrompt: costArchivePrompt, costArchiveGain: costArchiveGain, costEsc: costEsc, costNumber: costNumber, costTokens: costTokens, costDay: costDay, costSplitPrompt: costSplitPrompt, costRender: costRender, costPartName: costPartName, costGroupName: costGroupName };
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
    costAssistant = cfg.assistant === true;
    costProvider = typeof cfg.assistantProvider === "string" ? cfg.assistantProvider : "";
  } catch (e) { /* default colours */ }
  var last = null, pending = null, loading = false, again = false;
  var archOff = {}; // archive sections the user unticked (kept across refreshes)

  function archChosen() {
    if (!last || !last.archive || !last.archive.sections) return [];
    return last.archive.sections.filter(function (s) { return !archOff[s.key]; });
  }
  function archSync() {
    Array.prototype.forEach.call(body.querySelectorAll("[data-archive-key]"), function (cb) { cb.checked = !archOff[cb.getAttribute("data-archive-key")]; });
    var g = document.getElementById("mg-arch-gain");
    if (g) g.innerHTML = costArchiveGain(archChosen());
  }

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
      archSync();
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

  function copied(btn, label) {
    btn.textContent = "Copied ✓";
    btn.classList.add("mg-cost__copy--done");
    setTimeout(function () { btn.textContent = label; btn.classList.remove("mg-cost__copy--done"); }, 2000);
  }
  body.addEventListener("change", function (e) {
    var cb = e.target;
    if (!cb || !cb.getAttribute || !cb.hasAttribute("data-archive-key")) return;
    if (cb.checked) delete archOff[cb.getAttribute("data-archive-key")];
    else archOff[cb.getAttribute("data-archive-key")] = true;
    archSync();
  });

  body.addEventListener("click", function (e) {
    var t = e.target;
    var arch = t.closest && t.closest("[data-archive-copy],[data-archive-ai],[data-archive-plain]");
    if (arch) {
      var chosen = archChosen();
      if (!chosen.length) return;
      if (arch.hasAttribute("data-archive-copy")) {
        var text = costArchivePrompt(last.archive, chosen, names);
        copyText(text).then(function () { copied(arch, "Copy prompt for your AI"); }).catch(function () { arch.textContent = "Copy failed: select the sections again"; });
        return;
      }
      var keys = chosen.map(function (s) { return s.key; });
      try { document.dispatchEvent(new CustomEvent("memglow:archive", { detail: { sections: keys, ai: arch.hasAttribute("data-archive-ai") } })); } catch (e3) { /* old browser */ }
      return;
    }
    var btn = t.closest && t.closest("[data-copy]");
    if (btn) { copyPrompt(btn); return; }
    var ai = t.closest && t.closest("[data-assist]");
    if (ai) {
      try { document.dispatchEvent(new CustomEvent("memglow:assistant", { detail: ai.getAttribute("data-assist") })); } catch (e2) { /* old browser */ }
      return;
    }
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
