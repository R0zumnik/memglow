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

/* ---- i18n (public/i18n.js, public/i18n/<code>.json) ----
   Same approach as app.js (see its EN_APP for why this small English copy lives here too, self-
   contained, kept in sync with public/i18n/en.json by a test). costSplitPrompt builds a prompt for
   the AI and stays English on purpose: it never takes a T, and costPartName's own fallback stays
   English unless a T is explicitly given (only the UI renderers below pass one). */
var EN_COST = {
  "cost.tokensToday": "Tokens read today", "cost.tokensRead7": "Tokens read · 7 days",
  "cost.tokensWritten7": "Tokens written · 7 days", "cost.wholeMemory": "Whole memory",
  "cost.indexNote": "Index note", "cost.eachRead": "each time it is read", "cost.noIndexNote": "no index note",
  "cost.notesCount": { one: "{n} note", other: "{n} notes" },
  "cost.readsCount": { one: "{n} read", other: "{n} reads" },
  "cost.noReadYet": "No read counted in the last 7 days yet.", "cost.ofTokensRead7": "of tokens read (7 days)",
  "cost.percentAria": "{n} percent", "cost.copyPrompt": "Copy prompt for your AI",
  "cost.introduction": "(introduction)",
  "cost.splitInto": { one: "Split into {n} note:", other: "Split into {n} notes:" },
  "cost.singleSection": "A single section: no split to suggest from headings.",
  "cost.sectionsCount": "Sections ({n})", "cost.noLargeNotes": "No note above {tokens} tokens.",
  "cost.dataSince": "Data since {date} — less than 30 days of counting so far.",
  "cost.noDataYet": "No data yet.", "cost.allRead30": "Every note was read at least once in 30 days.",
  "cost.moreCount": "+ {n} more.", "cost.notAvailable": "Memory cost is not available.",
  "cost.mostExpensive": "Most expensive to read · 7 days", "cost.tooLarge": "Too large (&gt; {tokens} tokens)",
  "cost.neverRead30": "Never read in 30 days", "cost.loadFailed": "Could not load Memory cost.",
  "cost.copied": "Copied ✓", "cost.selectManually": "Select and copy the text below",
  "cost.promptToCopy": "Prompt to copy", "cost.doWith": "Do it with {name}", "cost.organisation": "Organisation",
  "cost.alwaysLoaded": "Always loaded · every session", "cost.archive": "Archive · sections unused for {n} days",
  "cost.findTime": "Time to find a note · 7 days",
  "cost.engineSpeed": "Memory engine speed · 7 days",
  "find.none": "No search counted in the last 7 days yet.",
  "find.medianTime": "Median time to the note",
  "find.medianSteps": "Median steps",
  "find.missed": "Searches with no read after",
  "find.counted": { one: "{n} search counted", other: "{n} searches counted" },
  "find.slowest": "Slowest or missed searches",
  "find.gone": "(note no longer exists)",
  "find.missedRow": "Search with no read within 2 min",
  "find.missedShort": "No read",
  "find.steps": { one: "{n} step", other: "{n} steps" },
  "find.hint": "From the activity memglow receives: each search, then the first read by the same assistant within 2 minutes (each extra search is one more step). A search answered from its results alone also counts as “no read after”.",
  "speed.none": "No timed call yet: response times are measured by the memglow MCP proxy.",
  "speed.alert": "Search is getting slower: median {recent} over the last 24 hours, against {base} over the 6 days before.",
  "speed.tool": "Tool",
  "speed.calls": "Calls",
  "speed.p50": "Median",
  "speed.p95": "95th percentile",
  "speed.search": "Search",
  "speed.read": "Read",
  "speed.write": "Write",
  "speed.hint": "Time the memory server takes to answer each call, measured by the memglow MCP proxy (request to response). Alert when the search median of the last 24 hours is at least twice that of the 6 days before, and at least 250 ms slower.",
  "cost.byAiTool": "By AI tool · {days} days:",
  "cost.byAiToolCalls": { "one": "{n} call", "other": "{n} calls" },
  "cost.byAiToolUnknown": "Unknown tool",
  "org.none": "No scattered notes found: every subject sits in one sub-theme.", "org.why": "Why",
  "org.scattered": "{n} notes about “{topic}” are spread across {k} sub-themes of {group} — group them under “{target}”?",
  "org.alone": "“{label}” is alone in the sub-theme “{from}” — move it to “{target}”?",
  "org.reasonShared": "{n} notes of the group “{group}” share the word “{topic}”",
  "org.reasonLinks": { one: " and {n} link between them", other: " and {n} links between them" },
  "org.reasonSubthemes": "they sit in {n} sub-themes: {list}",
  "org.reasonTargetHolds": "“{target}” already holds {n} of them",
  "org.reasonAlone": "“{label}” is the only note of the sub-theme “{from}”",
  "org.reasonTied": { one: "it is tied to {n} note of “{target}” ({how})", other: "it is tied to {n} notes of “{target}” ({how})" },
  "org.sharedWords": "shared words: {list}", "org.byLinks": "links", "always.notAvailable": "Not available.",
  "always.index": "Index · {label}", "always.notFound": "not found",
  "always.perDay": "{perSession} tokens per session × {sessions} sessions per day ≈ {perDay} tokens per day",
  "always.sessionsFromIndex": "Sessions per day estimated from the reads of the index note (last 7 days).",
  "always.sessionsFromSetting": "Sessions per day: the sessionsPerDay setting (no read of the index counted yet).",
  "always.noIndex": "No index note.",
  "always.addFiles": "Add your instruction files (CLAUDE.md, AGENTS.md…) to {setting} in memglow.config.json to count them too — only their size is read.",
  "always.tipIndex": "Trim the index: ≈ {tokens} tokens are loaded at every session (tip threshold {threshold}). Keep one short line per note and move details into the notes.",
  "always.tipFile": "Trim {name}: ≈ {tokens} tokens at every session. Move rarely needed instructions into notes the assistant reads on demand.",
  "always.small": "Small enough: nothing to trim.",
  "always.trimButton": "Trim the index ({lines} line(s), ≈{tokens} tokens/session)",
  "arch.notEnough": "Not enough data yet{since} — a section is suggested only after {days} days of counted activity{from}.",
  "arch.since": " since {date}", "arch.from": " (from {date})",
  "arch.none": "No dormant section: every note was read, found or edited in the last {days} days.",
  "arch.hint": "Their notes were not read nor found by a search for {days} days, and the sections were not edited ({basis}). memglow only sees whole-note reads, so a note read once keeps all its sections live.",
  "arch.basisSection": "checked per section", "arch.basisNote": "checked per note",
  "arch.hiddenTitles": "{count}, {tokens} tokens. Section titles are hidden (MEMGLOW_SHOW_BODIES is off).",
  "arch.dormantCount": { one: "{n} dormant section", other: "{n} dormant sections" },
  "arch.lastRead": "last read {date}", "arch.notReadSince": "not read since counting began",
  "arch.more": { one: "+ {n} more section (the biggest are listed).", other: "+ {n} more sections (the biggest are listed)." },
  "arch.prepare": "Prepare without AI", "arch.yourAi": "your AI", "arch.noneSelected": "No section selected.",
  "arch.gain": "{sections} · live memory {saved} tokens smaller (each section leaves a one-line link) · archive summary + {line} tokens",
  "arch.sectionCount": { one: "{n} section", other: "{n} sections" },
  "arch.copyFailed": "Copy failed: select the sections again",
  "cost.structure": "Structure · hub and spoke",
  "struct.none": "Nothing to tidy: this memory already follows hub and spoke.",
  "struct.hubs": { one: "{n} hub", other: "{n} hubs" },
  "struct.indexRedundant": { one: "{n} index line already covered by its hub", other: "{n} index lines already covered by their hub" },
  "struct.siblingLines": { one: "{n} note links to several of its hub's other notes", other: "{n} notes link to several of their hub's other notes" },
  "struct.pureSiblingLines": "{n} removable outright, no AI needed",
  "struct.missingUplinks": { one: "{n} note missing its link back to the hub", other: "{n} notes missing their link back to the hub" },
  "struct.missingHubLines": { one: "{n} hub missing a line for one of its notes", other: "{n} hubs missing a line for one of their notes" },
  "struct.doIt": "Tidy into hub and spoke",
  "common.reload": "Reload", "common.retry": "Retry",
  "error.connectionLost": "Connection lost. Check your network and retry.",
  "error.unauthorized": "Unauthorized. Reload the page to sign in again.",
  "error.serverError": "Server error. Please retry."
};
function resolveTextCost(dict, key, params) {
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
function defaultCostT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextCost(EN_COST, key, params);
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

/* ---- Numbers and dates ----
   The panel shows them in the memglow language (window.MemglowI18n.lang(), the Settings choice —
   never the browser locale), with Intl: "1 234" and "30 sept." in French. Same options as
   public/i18n.js formatNumber/formatDay, copied so this file stays self-contained (Node tests).
   The prompts for the AI below (costSplitPrompt, costArchivePrompt) are English on purpose, so
   they pass "en" explicitly: "≈ 1,234 tokens", "Sep 30". Without Intl or with an unknown language:
   the same English forms. */
var COST_FMT = {};
function costLang() {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  return M && typeof M.lang === "function" ? M.lang() : "en";
}
function costIntl(kind, lang, opts, key) {
  var k = kind + "|" + lang + "|" + key;
  if (!Object.prototype.hasOwnProperty.call(COST_FMT, k)) {
    var f = null;
    try { if (typeof Intl !== "undefined" && Intl[kind]) f = new Intl[kind](lang, opts); } catch (e) { f = null; }
    COST_FMT[k] = f || (lang !== "en" ? costIntl(kind, "en", opts, key) : null);
  }
  return COST_FMT[k];
}
/** 1234 → "1,234" (en), "1 234" (fr)… `lang` defaults to the page language. */
function costNumber(n, lang) {
  n = Math.round(Number(n) || 0);
  var f = costIntl("NumberFormat", lang || costLang(), { maximumFractionDigits: 0 }, "n");
  return f ? f.format(n) : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** 59 → "59%" (en), "59 %" (fr, de), "59 %" (es)… */
function costPercent(p, lang) {
  var f = costIntl("NumberFormat", lang || costLang(), { style: "percent", maximumFractionDigits: 0 }, "pct");
  return f ? f.format((Number(p) || 0) / 100) : Math.round(Number(p) || 0) + "%";
}
/** "≈ 1,234" — every token figure is an estimate. */
function costTokens(n, lang) {
  return n == null || !isFinite(n) ? "≈ —" : "≈ " + costNumber(n, lang);
}
/** "2026-09-30" → "Sep 30" (en), "30 sept." (fr), "9月30日" (ja)… — a calendar day, read in UTC so
    no time zone can shift it. `lang` defaults to the page language. */
function costDay(day, lang) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  var f = costIntl("DateTimeFormat", lang || costLang(), { month: "short", day: "numeric", timeZone: "UTC" }, "day");
  if (f) return f.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[Number(m[2]) - 1] + " " + Number(m[3]);
}
function costColor(colors, theme) {
  var c = colors && colors[theme];
  return /^#[0-9A-Fa-f]{6}$/.test(String(c || "")) ? c : "#A9C9BF";
}
/** English only: used by the prompt for the AI (costSplitPrompt). */
function costPlural(n, word) {
  return costNumber(n, "en") + " " + word + (n === 1 ? "" : "s");
}

/** Text of a part in a split suggestion: its section titles. */
function costPartName(part, T) {
  var intro = T ? T("cost.introduction") : "(introduction)";
  var t = (part.titles || []).map(function (x) { return x || intro; });
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
 * English end to end, numbers and dates included (costNumber/costDay with "en"), whatever the page
 * language — same for costArchivePrompt.
 */
function costSplitPrompt(n, c, names) {
  var large = c.largeNoteTokens || 5000, chunk = c.chunkTokens || 2000;
  var group = costGroupName(n.theme, names);
  var groups = Object.keys(names || {}).filter(function (k) { return k !== "index" && k !== "other"; })
    .map(function (k) { return costGroupName(k, names); });
  var partial = c.read && c.read.complete7 === false && c.since ? " (counted since " + costDay(c.since, "en") + ")" : "";
  var lines = [];
  lines.push("Please split one note of my AI memory into several smaller notes. Show me the plan BEFORE writing anything.");
  lines.push("");
  lines.push("Note: \"" + n.label + "\" (id: " + n.id + ", folder: " + (n.folder || "(root)") + ", group: " + group +
    (n.subtheme ? ", subtheme: " + n.subtheme : "") + ")");
  lines.push("Size: ≈ " + costNumber(n.tokens, "en") + " tokens (estimate: bytes ÷ 4). Read " + costPlural(n.reads7 || 0, "time") +
    " in the last 7 days" + partial + ", ≈ " + costNumber(n.readTokens7 || 0, "en") + " tokens read in total.");
  // Honest about why this note is here: above the threshold, or under it but costly to read.
  if (n.tokens > large) {
    lines.push("It is above the ≈ " + costNumber(large, "en") + "-token threshold for large notes.");
  } else {
    lines.push("It is under the ≈ " + costNumber(large, "en") + "-token threshold for large notes, but it is one of the notes that cost the most to read over the last 7 days.");
  }
  lines.push("Aim for new notes of ≈ " + costNumber(chunk, "en") + " tokens or less.");
  lines.push("");
  if (n.split && n.split.length > 1) {
    lines.push("Suggested split into " + n.split.length + " notes (consecutive ## sections, in order):");
    n.split.forEach(function (p, i) {
      lines.push((i + 1) + ". " + costPartName(p) + " — ≈ " + costNumber(p.tokens, "en") + " tokens");
    });
  } else {
    lines.push("Suggested split: group consecutive ## sections into notes of ≈ " + costNumber(chunk, "en") + " tokens or less.");
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- Keep every new note in the same group (" + group + ") and the same folder as the original note.");
  lines.push("- Do not create, rename or remove top-level groups" + (groups.length ? " (" + groups.join(", ") + ")" : "") + ".");
  if (c.protectedGroups && c.protectedGroups.length) lines.push("- Protected groups — never move notes across these groups: " + c.protectedGroups.join(", ") + ".");
  lines.push("- Keep the `theme` and `subtheme` (or `sous_theme`) frontmatter keys on every new note, with the original values.");
  lines.push("- Keep every [[link]] valid: update the links that pointed to the moved content.");
  lines.push("- Hub and spoke, to read as few tokens as possible: the original note becomes a short summary that lists each new note with one line saying what it holds.");
  lines.push("- Each new note links back to that summary only. No list of sibling notes; link another note only when the text really refers to it.");
  lines.push("- Do not add the new notes to the memory index: only the summary stays there.");
  lines.push("- Use only your memory tool (the one you normally use to read and write these notes). Do not edit the files any other way.");
  lines.push("- First show me the plan (new note names and titles, which sections go where, which links change), then wait for my OK before writing.");
  return lines.join("\n");
}

function costFigures(c, T) {
  var items = [
    [T("cost.tokensToday"), costTokens(c.read.today), ""],
    [T("cost.tokensRead7"), costTokens(c.read.days7), ""],
    [T("cost.tokensWritten7"), costTokens(c.written.days7), ""],
    [T("cost.wholeMemory"), costTokens(c.totals.tokens), T("cost.notesCount", { n: c.totals.notes })],
    [T("cost.indexNote"), c.index ? costTokens(c.index.tokens) : "≈ —", c.index ? T("cost.eachRead") : T("cost.noIndexNote")],
  ];
  return items.map(function (d) {
    return '<div class="mg-cost__fig"><p class="mg-cost__fig-name">' + costEsc(d[0]) + '</p>' +
      '<p class="mg-cost__fig-val">' + costEsc(d[1]) + '</p>' +
      (d[2] ? '<p class="mg-cost__fig-det">' + costEsc(d[2]) + '</p>' : '') + '</div>';
  }).join("");
}

/** "3 notes = 59 % of tokens read (7 days)", with a two-part bar. */
function costShare(share, T) {
  if (!share) return '<p class="mg-cost__empty">' + costEsc(T("cost.noReadYet")) + '</p>';
  var p = Math.max(0, Math.min(100, share.percent));
  return '<div class="mg-cost__share"><p class="mg-cost__share-text"><strong>' + costEsc(T("cost.notesCount", { n: share.notes })) + '</strong> = <strong>' + costEsc(costPercent(p)) +
    '</strong> ' + costEsc(T("cost.ofTokensRead7")) + '</p><div class="mg-cost__share-bar" role="img" aria-label="' + costEsc(T("cost.percentAria", { n: p })) + '"><span style="width:' + p + '%"></span></div></div>';
}

function costName(n, colors) {
  return '<span class="mg-cost__name"><span class="mg-cost__dot" style="--c:' + costColor(colors, n.theme) + '"></span>' +
    '<span class="mg-cost__label">' + costEsc(n.label) + '</span></span>';
}

// Set by the page when the optional assistant is enabled on this instance (config "assistant"), with
// the name of its default provider.
var costAssistant = false;
var costAssistantLabel = "Claude";
function costCopyButton(n, T) {
  return '<button type="button" class="bn-btn mg-cost__copy" data-copy="' + costEsc(n.id) + '">' + costEsc(T("cost.copyPrompt")) + '</button>' +
    (costAssistant ? '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-assist="' + costEsc(n.id) + '">' + costEsc(T("cost.doWith", { name: costAssistantLabel })) + '</button>' : "");
}

/**
 * `key`'s translation with some {placeholders} replaced by ready-made HTML (a <strong> figure, a
 * <code> name): the translated text itself is escaped first, then only the `html` pieces are put
 * in — so a translation can move a bold figure wherever its word order needs it.
 */
function costFill(T, key, html, params) {
  return costEsc(T(key, params)).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(html, k) ? html[k] : m;
  });
}

/** One organisation suggestion as text: from its `facts` (translated), else the server's English. */
function costOrgMessage(s, T) {
  var f = s.facts;
  if (!f) return s.message || "";
  return f.kind === "alone"
    ? T("org.alone", { label: f.label, from: f.from, target: f.target })
    : T("org.scattered", { n: f.notes, topic: f.topic, k: f.subthemes.length, group: f.group, target: f.target });
}
function costOrgReasons(s, T) {
  var f = s.facts;
  if (!f) return s.reasons || [];
  if (f.kind === "alone") {
    return [
      T("org.reasonAlone", { label: f.label, from: f.from }),
      T("org.reasonTied", { n: f.tied, target: f.target, how: f.words && f.words.length ? T("org.sharedWords", { list: f.words.join(", ") }) : T("org.byLinks") }),
    ];
  }
  return [
    T("org.reasonShared", { n: f.notes, group: f.group, topic: f.topic }) + (f.links ? T("org.reasonLinks", { n: f.links }) : ""),
    T("org.reasonSubthemes", { n: f.subthemes.length, list: f.subthemes.join(", ") }),
    T("org.reasonTargetHolds", { target: f.target, n: f.targetCount }),
  ];
}

/**
 * "Organisation": notes about one subject scattered across sub-themes of a group (lib/organise.js).
 * Each suggestion: its sentence, the notes (clickable), why, and the two buttons.
 */
function costOrganisation(list, colors, T) {
  T = T || defaultCostT;
  if (!list || !list.length) return '<p class="mg-cost__empty">' + costEsc(T("org.none")) + '</p>';
  return '<ul class="mg-cost__list mg-cost__org">' + list.map(function (s) {
    var subName = (s.facts && s.facts.subthemeNames) || {};
    var sub = function (x) { return Object.prototype.hasOwnProperty.call(subName, x) ? subName[x] : x; };
    var notes = (s.notes || []).map(function (n) {
      var moving = (s.move || []).indexOf(n.id) >= 0;
      return '<li><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' +
        costName({ label: n.label, theme: s.theme }, colors) + '<span class="mg-cost__det">' + costEsc(sub(n.subtheme || "general")) + (moving ? " → " + costEsc(sub(s.target)) : "") + '</span></div></li>';
    }).join("");
    return '<li class="mg-cost__item mg-cost__org-item"><p class="mg-cost__org-msg">' + costEsc(costOrgMessage(s, T)) + '</p>' +
      '<ul class="mg-cost__list mg-cost__list--compact">' + notes + '</ul>' +
      '<details class="mg-cost__sections"><summary>' + costEsc(T("org.why")) + '</summary><ul>' + costOrgReasons(s, T).map(function (r) { return '<li>' + costEsc(r) + '</li>'; }).join("") + '</ul></details>' +
      '<button type="button" class="bn-btn mg-cost__copy" data-copy-org="' + costEsc(s.id) + '">' + costEsc(T("cost.copyPrompt")) + '</button>' +
      (costAssistant ? '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-assist-org="' + costEsc(s.id) + '">' + costEsc(T("cost.doWith", { name: costAssistantLabel })) + '</button>' : "") +
      '</li>';
  }).join("") + '</ul>';
}

/** A trimming tip: from its figures (translated), else the server's English text. */
function costTip(t, T) {
  if (t && t.kind === "index" && typeof t.tokens === "number") return T("always.tipIndex", { tokens: costNumber(t.tokens), threshold: costNumber(t.threshold) });
  if (t && t.kind === "file" && typeof t.tokens === "number" && t.name) return T("always.tipFile", { name: t.name, tokens: costNumber(t.tokens) });
  return (t && t.text) || "";
}

/** "Always loaded": index + instruction files read at every session, × sessions per day. */
function costAlwaysLoaded(a, T) {
  T = T || defaultCostT;
  if (!a) return '<p class="mg-cost__empty">' + costEsc(T("always.notAvailable")) + '</p>';
  var rows = (a.index || []).map(function (n) {
    return '<li><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button"><span class="mg-cost__name"><span class="mg-cost__label">' + costEsc(T("always.index", { label: n.label })) + '</span></span><span class="mg-cost__det">' + costTokens(n.tokens) + '</span></div></li>';
  }).concat((a.files || []).map(function (f) {
    return '<li><div class="mg-cost__row mg-cost__row--simple"><span class="mg-cost__name"><span class="mg-cost__label">' + costEsc(f.name) + '</span></span><span class="mg-cost__det">' + (f.found ? costTokens(f.tokens) : costEsc(T("always.notFound"))) + '</span></div></li>';
  }));
  var html = '<p class="mg-cost__share-text">' + costFill(T, "always.perDay", {
    perSession: '<strong>' + costTokens(a.perSession) + '</strong>', sessions: '<strong>' + costNumber(a.sessionsPerDay) + '</strong>', perDay: '<strong>' + costNumber(a.perDay) + '</strong>',
  }) + '</p>' +
    '<p class="mg-cost__empty">' + costEsc(T(a.sessionsSource === "index reads" ? "always.sessionsFromIndex" : "always.sessionsFromSetting")) + '</p>';
  html += rows.length ? '<ul class="mg-cost__list mg-cost__list--compact">' + rows.join("") + '</ul>' : '<p class="mg-cost__empty">' + costEsc(T("always.noIndex")) + '</p>';
  if (!(a.files || []).length) html += '<p class="mg-cost__empty">' + costFill(T, "always.addFiles", { setting: '<code>alwaysLoaded</code>' }) + '</p>';
  if (a.tips && a.tips.length) html += '<ul class="mg-cost__tips">' + a.tips.map(function (t) { return '<li>' + costEsc(costTip(t, T)) + '</li>'; }).join("") + '</ul>';
  else html += '<p class="mg-cost__empty">' + costEsc(T("always.small")) + '</p>';
  if (costAssistant && a.indexTrim && a.indexTrim.lines > 0) {
    html += '<div class="mg-arch__btns"><button type="button" class="bn-btn mg-cost__copy" data-index-trim="1">'
      + costEsc(T("always.trimButton", { lines: costNumber(a.indexTrim.lines), tokens: costNumber(a.indexTrim.tokensSaved) })) + '</button></div>';
  }
  return html;
}

function costTop(top, colors, c, T) {
  if (!top || !top.length) return '<p class="mg-cost__empty">' + costEsc(T("cost.noReadYet")) + '</p>';
  var max = top[0].readTokens7 || 1;
  return '<ol class="mg-cost__list">' + top.map(function (n) {
    var w = Math.max(2, Math.round((n.readTokens7 / max) * 100));
    return '<li class="mg-cost__item"><div class="mg-cost__row" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' + costName(n, colors) +
      '<strong class="mg-cost__num">' + costTokens(n.readTokens7) + '</strong>' +
      '<span class="mg-cost__bar"><span style="width:' + w + '%;background:' + costColor(colors, n.theme) + '"></span></span>' +
      '<span class="mg-cost__det">' + costEsc(T("cost.readsCount", { n: n.reads7 })) + ' × ' + costTokens(n.tokens) + '</span></div>' +
      (n.tokens > c.chunkTokens ? costCopyButton(n, T) : '') + '</li>';
  }).join("") + '</ol>';
}

function costSplit(n, T) {
  if (!n.sections || !n.sections.length) return "";
  var intro = T("cost.introduction");
  var list = n.sections.map(function (s) {
    return '<li>' + costEsc(s.title || intro) + ' — ' + costTokens(s.tokens) + '</li>';
  }).join("");
  var plan = n.split
    ? '<p class="mg-cost__plan">' + costEsc(T("cost.splitInto", { n: n.split.length })) + ' ' + n.split.map(function (p) {
        return '<span class="mg-cost__part">' + costEsc(costPartName(p, T)) + ' <em>' + costTokens(p.tokens) + '</em></span>';
      }).join(" · ") + '</p>'
    : '<p class="mg-cost__plan">' + costEsc(T("cost.singleSection")) + '</p>';
  return '<details class="mg-cost__sections"><summary>' + costEsc(T("cost.sectionsCount", { n: n.sections.length })) + '</summary><ol>' + list + '</ol>' + plan + '</details>';
}

function costLarge(list, colors, c, T) {
  if (!list.length) return '<p class="mg-cost__empty">' + costEsc(T("cost.noLargeNotes", { tokens: costTokens(c.largeNoteTokens) })) + '</p>';
  return '<ul class="mg-cost__list">' + list.map(function (n) {
    return '<li class="mg-cost__item"><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' +
      costName(n, colors) + '<strong class="mg-cost__num">' + costTokens(n.tokens) + '</strong></div>' +
      costSplit(n, T) + costCopyButton(n, T) + '</li>';
  }).join("") + '</ul>';
}

function costNeverRead(nr, colors, T) {
  if (!nr.available) {
    return '<p class="mg-cost__empty">' + costEsc(nr.since ? T("cost.dataSince", { date: costDay(nr.since) }) : T("cost.noDataYet")) + '</p>';
  }
  if (!nr.notes.length) return '<p class="mg-cost__empty">' + costEsc(T("cost.allRead30")) + '</p>';
  var more = nr.total - nr.notes.length;
  return '<ul class="mg-cost__list mg-cost__list--compact">' + nr.notes.map(function (n) {
    return '<li><div class="mg-cost__row mg-cost__row--simple" data-note="' + costEsc(n.id) + '" tabindex="0" role="button">' + costName(n, colors) +
      '<span class="mg-cost__det">' + costTokens(n.tokens) + '</span></div></li>';
  }).join("") + '</ul>' + (more > 0 ? '<p class="mg-cost__empty">' + costEsc(T("cost.moreCount", { n: more })) + '</p>' : '');
}

// ---- Time to find a note (lib/find-time.js) and memory engine speed (lib/engine-speed.js) ----

/** 120 → "120 ms", 1400 → "1.4 s", 80000 → "1 min 20 s" — Intl unit names in the page language
    (no translation key needed); "—" when unknown. */
function costDuration(ms, lang) {
  if (ms == null || !isFinite(ms)) return "—";
  lang = lang || costLang();
  ms = Math.max(0, Number(ms));
  function unit(v, u, digits) {
    var f = costIntl("NumberFormat", lang, { style: "unit", unit: u, unitDisplay: "short", maximumFractionDigits: digits }, "u" + u + digits);
    if (f) { try { return f.format(v); } catch (e) { /* old engine: plain form below */ } }
    var short = { millisecond: "ms", second: "s", minute: "min" }[u];
    return (digits ? Math.round(v * 10) / 10 : Math.round(v)) + " " + short;
  }
  if (ms < 1000) return unit(Math.round(ms), "millisecond", 0);
  if (ms < 60000) return unit(ms / 1000, "second", ms < 10000 ? 1 : 0);
  var s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
  return unit(m, "minute", 0) + (r ? " " + unit(r, "second", 0) : "");
}
/** 1.5 → "1.5" in the page language (medians of steps can be halves). */
function costDecimal(n, lang) {
  var f = costIntl("NumberFormat", lang || costLang(), { maximumFractionDigits: 1 }, "d1");
  return f ? f.format(Number(n) || 0) : String(Math.round((Number(n) || 0) * 10) / 10);
}

/** "Time to find a note · 7 days": three figures, then the 5 slowest or missed searches. */
function costFindTime(f, T) {
  T = T || defaultCostT;
  if (!f || !f.searches) return '<p class="mg-cost__empty">' + costEsc(T("find.none")) + '</p>';
  var figs = [
    [T("find.medianTime"), costDuration(f.medianDelayMs)],
    [T("find.medianSteps"), f.medianSteps == null ? "—" : costDecimal(f.medianSteps)],
    [T("find.missed"), f.missedShare == null ? "—" : costPercent(f.missedShare * 100)],
  ];
  var html = '<div class="mg-cost__figs mg-cost__figs--three">' + figs.map(function (d) {
    return '<div class="mg-cost__fig"><p class="mg-cost__fig-name">' + costEsc(d[0]) + '</p><p class="mg-cost__fig-val">' + costEsc(d[1]) + '</p></div>';
  }).join("") + '</div>';
  html += '<p class="mg-cost__fig-det">' + costEsc(T("find.counted", { n: f.searches })) + '</p>';
  if (f.top && f.top.length) {
    html += '<p class="mg-cost__minor">' + costEsc(T("find.slowest")) + '</p><ul class="mg-cost__list mg-cost__list--compact">' + f.top.map(function (x) {
      var title = x.found ? (x.label || T("find.gone")) : T("find.missedRow") + (x.context && x.context.length ? " (" + x.context.join(", ") + ")" : "");
      var val = x.found ? costDuration(x.delayMs) + " · " + T("find.steps", { n: x.steps }) : T("find.missedShort");
      var attr = x.found && x.id ? ' data-note="' + costEsc(x.id) + '" tabindex="0" role="button"' : "";
      return '<li><div class="mg-cost__row mg-cost__row--simple"' + attr + '><span class="mg-cost__name"><span class="mg-cost__label">' + costEsc(title) + '</span></span>' +
        '<span class="mg-cost__det">' + costEsc(val) + '</span></div></li>';
    }).join("") + '</ul>';
  }
  html += '<p class="mg-cost__hint">' + costEsc(T("find.hint")) + '</p>';
  return html;
}

/** "Memory engine speed · 7 days": calls, median and p95 per tool type, and the slow-search alert. */
function costEngineSpeed(e, T) {
  T = T || defaultCostT;
  if (!e || !e.total) return '<p class="mg-cost__empty">' + costEsc(T("speed.none")) + '</p>';
  var html = "";
  if (e.alert) html += '<p class="mg-cost__alert" role="status">' + costEsc(T("speed.alert", { recent: costDuration(e.alert.recentMs), base: costDuration(e.alert.baselineMs) })) + '</p>';
  html += '<table class="mg-cost__table"><thead><tr><th scope="col">' + costEsc(T("speed.tool")) + '</th><th scope="col">' + costEsc(T("speed.calls")) +
    '</th><th scope="col">' + costEsc(T("speed.p50")) + '</th><th scope="col">' + costEsc(T("speed.p95")) + '</th></tr></thead><tbody>';
  ["search", "read", "write"].forEach(function (k) {
    var r = e.types && e.types[k];
    if (!r || !r.calls) return;
    html += '<tr><th scope="row">' + costEsc(T("speed." + k)) + '</th><td>' + costEsc(costNumber(r.calls)) + '</td><td>' + costEsc(costDuration(r.p50)) + '</td><td>' + costEsc(costDuration(r.p95)) + '</td></tr>';
  });
  html += '</tbody></table><p class="mg-cost__hint">' + costEsc(T("speed.hint")) + '</p>';
  return html;
}

// Product names: never translated (same reasoning, and the same list, as app.js's SOURCE_LABELS —
// kept duplicated here so cost.js stays self-contained; the ids are lib/clients.js's CLIENTS,
// lib/proxy-levers.js's clientBucket() picks one of these ids, its own raw unlisted name, or
// "unknown" when the MCP client sent neither a name nor a title at all).
var COST_CLIENT_LABELS = {
  "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor", windsurf: "Windsurf",
  copilot: "GitHub Copilot", cline: "Cline", chatgpt: "ChatGPT", "other-mcp": "Other MCP client"
};
function costClientLabel(id, T) {
  if (id === "unknown") return T("cost.byAiToolUnknown");
  return COST_CLIENT_LABELS[id] || id; // an unlisted MCP client: shown exactly as it introduced itself
}

/**
 * Tiny "By AI tool" line: baseline tokens the MCP proxy relayed per client (lib/proxy-levers.js
 * createSavings/addClient, <dataDir>/proxy-savings.json, via /api/cost's `clientTokens`), busiest
 * first. Counts only, never note content. No data at all (most installs, single client, or the
 * proxy's savingsFile off) → nothing rendered, not even an empty-state message: this is one line
 * of extra context on top of Memory engine speed, not its own block.
 */
function costClientTokens(ct, T) {
  T = T || defaultCostT;
  if (!ct || !ct.byClient) return "";
  var names = Object.keys(ct.byClient);
  if (!names.length) return "";
  names.sort(function (a, b) { return ct.byClient[b].tokens - ct.byClient[a].tokens; });
  var items = names.map(function (name) {
    var v = ct.byClient[name];
    return costClientLabel(name, T) + " " + costTokens(v.tokens) + " (" + T("cost.byAiToolCalls", { n: v.calls }) + ")";
  });
  return '<p class="mg-cost__hint mg-cost__byclient">' + costEsc(T("cost.byAiTool", { days: ct.days })) + " " + costEsc(items.join(" · ")) + "</p>";
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
function costArchivePrompt(a, list, names, today, protectedGroups) {
  var day = today || costToday();
  var lines = [];
  lines.push("Please archive some dormant sections of my AI memory: move them, word for word, out of the notes that are read every day, into archive notes. Show me the plan BEFORE writing anything.");
  lines.push("");
  lines.push("memglow counted that the notes below were not read, nor found by a search, for " + a.afterDays + " days (since " + a.cutoff + "), and that these sections were not edited in that time:");
  list.forEach(function (s, i) {
    lines.push((i + 1) + ". Section \"" + s.title + "\" of note \"" + s.label + "\" (id: " + s.note + ", group: " + costGroupName(s.theme, names) + ") — ≈ " + costNumber(s.tokens, "en") + " tokens");
  });
  lines.push("");
  lines.push("Rules:");
  lines.push("- Move each section (its heading and everything under it, sub-sections included) WORD FOR WORD to the archive note of the SAME group: " + a.folder + "/<group id>-archive.md (for example " + a.folder + "/" + (list[0] ? list[0].theme : "projects") + "-archive.md). Create it if needed, with the frontmatter keys `theme: <group id>`, `subtheme: archive` and `memglow_archive: true`. Never rewrite, shorten or summarise archived text.");
  lines.push("- In the archive note, put this line right before each moved section: <!-- memglow:archived from=\"<note id>\" date=\"" + day + "\" -->");
  lines.push("- In the original note, replace the section by ONE line: Archived: <section title> → [[<group id>-archive#<section title>]] (" + day + "). Change nothing else in that note, frontmatter included.");
  lines.push("- Add one line per archived section to the archive summary " + a.folder + "/" + a.summaryNote + ".md (create it with the frontmatter key `memglow_archive_summary: true` if needed): - " + day + " · <section title> · from [[<note id>]] → [[<group id>-archive#<section title>]] · ≈ <tokens> tokens");
  lines.push("- Keep every note in its group: do not change any `theme` or `subtheme` (or `sous_theme`), and do not create, rename or remove groups.");
  if (protectedGroups && protectedGroups.length) lines.push("- Protected groups — never move notes across these groups: " + protectedGroups.join(", ") + ".");
  lines.push("- Never overwrite or delete a note. If an archive note already has a section with the same title, stop and ask me.");
  lines.push("- Use only your memory tool (the one you normally use to read and write these notes). First show me the plan, then wait for my OK before writing.");
  return lines.join("\n");
}

/** Archive block: dormant sections with checkboxes, the estimated gain, and the actions. */
function costArchive(a, colors, T) {
  T = T || defaultCostT;
  if (!a) return "";
  if (!a.available) {
    return '<p class="mg-cost__empty">' + costEsc(T("arch.notEnough", {
      since: a.since ? T("arch.since", { date: costDay(a.since) }) : "", days: costNumber(a.afterDays),
      from: a.readyOn ? T("arch.from", { date: costDay(a.readyOn) }) : "",
    })) + '</p>';
  }
  if (!a.sections.length) return '<p class="mg-cost__empty">' + costEsc(T("arch.none", { days: costNumber(a.afterDays) })) + '</p>';
  var more = a.total - a.sections.length;
  var hint = '<p class="mg-arch__hint">' + costEsc(T("arch.hint", { days: costNumber(a.afterDays), basis: T(a.basis === "section" ? "arch.basisSection" : "arch.basisNote") })) + '</p>';
  if (!a.withTitles) {
    return '<p class="mg-cost__empty">' + costEsc(T("arch.hiddenTitles", { count: T("arch.dormantCount", { n: a.total }), tokens: costTokens(a.totalTokens) })) + '</p>' + hint;
  }
  var list = '<ul class="mg-cost__list mg-arch__list">' + a.sections.map(function (s) {
    return '<li class="mg-arch__item"><label class="mg-arch__row"><input type="checkbox" data-archive-key="' + costEsc(s.key) + '" checked>' +
      costName(s, colors) + '<span class="mg-arch__title">§ ' + costEsc(s.title) + '</span>' +
      '<strong class="mg-cost__num">' + costTokens(s.tokens) + '</strong>' +
      '<span class="mg-cost__det">' + costEsc(s.lastRead ? T("arch.lastRead", { date: costDay(s.lastRead) }) : T("arch.notReadSince")) + '</span></label></li>';
  }).join("") + '</ul>' + (more > 0 ? '<p class="mg-cost__empty">' + costEsc(T("arch.more", { n: more })) + '</p>' : '');
  var btns = '<div class="mg-arch__btns"><button type="button" class="bn-btn mg-cost__copy" data-archive-copy="1">' + costEsc(T("cost.copyPrompt")) + '</button>' +
    (costAssistant ? '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-archive-ai="1">' + costEsc(T("cost.doWith", { name: costProvider || T("arch.yourAi") })) + '</button>' +
      '<button type="button" class="bn-btn mg-cost__copy" data-archive-plain="1">' + costEsc(T("arch.prepare")) + '</button>' : '') + '</div>';
  return hint + list + '<p class="mg-arch__gain" id="mg-arch-gain">' + costArchiveGain(a.sections, T) + '</p>' + btns;
}

/** "3 sections · live memory ≈ 1,200 tokens smaller · archive summary + ≈ 75 tokens" for the chosen ones. */
function costArchiveGain(chosen, T) {
  T = T || defaultCostT;
  if (!chosen.length) return costEsc(T("arch.noneSelected"));
  var saved = 0, line = 0;
  chosen.forEach(function (s) { saved += Math.max(0, s.tokens - (s.stubTokens || 0)); line += s.lineTokens || 0; });
  return costFill(T, "arch.gain", {
    sections: '<strong>' + costEsc(T("arch.sectionCount", { n: chosen.length })) + '</strong>', saved: '<strong>' + costTokens(saved) + '</strong>',
  }, { line: costTokens(line) });
}

// ---- Structure tier (lib/hub-spoke.js): hub-and-spoke drift ----

/**
 * Structure block: how far this memory has drifted from hub and spoke (lib/hub-spoke.js counts,
 * never a note's text — see docs/hub-and-spoke.md), and the button that starts the "Tidy into hub
 * and spoke" job. `s` = /api/cost's `structure` ({ counts: {...} } or null).
 */
function costStructure(s, T) {
  T = T || defaultCostT;
  if (!s || !s.counts) return '<p class="mg-cost__empty">' + costEsc(T("cost.notAvailable")) + '</p>';
  var c = s.counts;
  var drift = c.indexRedundant + c.siblingLines + c.missingUplinks + c.missingHubLines;
  if (!drift) return '<p class="mg-cost__empty">' + costEsc(T("struct.none")) + '</p>';
  var rows = [];
  rows.push(T("struct.hubs", { n: c.hubs }));
  if (c.indexRedundant) rows.push(T("struct.indexRedundant", { n: c.indexRedundant }));
  if (c.siblingLines) rows.push(T("struct.siblingLines", { n: c.siblingLines }) + (c.pureSiblingLines ? " (" + T("struct.pureSiblingLines", { n: c.pureSiblingLines }) + ")" : ""));
  if (c.missingUplinks) rows.push(T("struct.missingUplinks", { n: c.missingUplinks }));
  if (c.missingHubLines) rows.push(T("struct.missingHubLines", { n: c.missingHubLines }));
  var list = '<ul class="mg-cost__list mg-cost__list--compact">' + rows.map(function (r) { return '<li>' + costEsc(r) + '</li>'; }).join("") + '</ul>';
  var btns = costAssistant
    ? '<div class="mg-arch__btns"><button type="button" class="bn-btn mg-cost__copy" data-tidy="1">' + costEsc(T("struct.doIt")) + '</button>' +
      '<button type="button" class="bn-btn mg-cost__copy mg-cost__ai" data-tidy-ai="1">' + costEsc(T("cost.doWith", { name: costProvider || T("arch.yourAi") })) + '</button></div>'
    : "";
  return list + btns;
}

/** The whole panel body, or a short message when there is nothing to show. `T` defaults to the
    page's current language (or this file's English copy outside a browser — see defaultCostT). */
function costRender(c, colors, T) {
  T = T || defaultCostT;
  if (!c || !c.read) return '<p class="mg-cost__empty">' + costEsc(T("cost.notAvailable")) + '</p>';
  var html = '<div class="mg-cost__figs">' + costFigures(c, T) + '</div>';
  html += costShare(c.share, T);
  html += '<div class="mg-cost__grid">';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.mostExpensive")) + '</figcaption>' + costTop(c.top, colors, c, T) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>' + T("cost.tooLarge", { tokens: costEsc(costTokens(c.largeNoteTokens)) }) + '</figcaption>' + costLarge(c.tooLarge, colors, c, T) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.neverRead30")) + '</figcaption>' + costNeverRead(c.neverRead, colors, T) + '</figure>';
  html += '</div>';
  html += '<div class="mg-cost__grid mg-cost__grid--two">';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.organisation")) + '</figcaption>' + costOrganisation(c.organisation, colors, T) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.alwaysLoaded")) + '</figcaption>' + costAlwaysLoaded(c.alwaysLoaded, T) + '</figure>';
  html += '</div>';
  html += '<div class="mg-cost__grid mg-cost__grid--two">';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.findTime")) + '</figcaption>' + costFindTime(c.findTime, T) + '</figure>';
  html += '<figure class="mg-cost__block"><figcaption>' + costEsc(T("cost.engineSpeed")) + '</figcaption>' + costEngineSpeed(c.engineSpeed, T) + costClientTokens(c.clientTokens, T) + '</figure>';
  html += '</div>';
  if (c.archive) html += '<figure class="mg-cost__block mg-arch" id="mg-arch"><figcaption>' + costEsc(T("cost.archive", { n: costNumber(c.archive.afterDays) })) + '</figcaption>' + costArchive(c.archive, colors, T) + '</figure>';
  if (c.structure) html += '<figure class="mg-cost__block mg-struct" id="mg-struct"><figcaption>' + costEsc(T("cost.structure")) + '</figcaption>' + costStructure(c.structure, T) + '</figure>';
  return html;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { setAssistant: function (v, label) { costAssistant = !!v; costAssistantLabel = label || "Claude"; costProvider = label || ""; }, costOrganisation: costOrganisation, costAlwaysLoaded: costAlwaysLoaded, costArchive: costArchive, costArchivePrompt: costArchivePrompt, costArchiveGain: costArchiveGain, costStructure: costStructure, costEsc: costEsc, costNumber: costNumber, costTokens: costTokens, costDay: costDay, costPercent: costPercent, costSplitPrompt: costSplitPrompt, costRender: costRender, costPartName: costPartName, costGroupName: costGroupName, costDuration: costDuration, costFindTime: costFindTime, costEngineSpeed: costEngineSpeed, costClientTokens: costClientTokens, costClientLabel: costClientLabel, EN_COST: EN_COST, resolveTextCost: resolveTextCost, defaultCostT: defaultCostT, mgBannerKind: mgBannerKind, mgErrorBanner: mgErrorBanner, mgClearBanner: mgClearBanner };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var root = document.getElementById("mg-cost");
  var body = document.getElementById("mg-cost-body");
  if (!root || !body) return;
  var url = root.getAttribute("data-cost");
  var T = defaultCostT;
  // Shared with app.js/zones.js/assistant.js — same three elements in index.html.
  var banner = { root: document.getElementById("mg-banner"), msg: document.getElementById("mg-banner-msg"), btn: document.getElementById("mg-banner-btn") };
  var colors = {}, names = { index: "Index" }; // "Index" here: the AI prompt (costSplitPrompt) stays English
  try {
    var cfg = JSON.parse(document.getElementById("memglow-config").textContent || "{}");
    (cfg.themes || []).forEach(function (t) { colors[t.id] = t.color; names[t.id] = t.label; });
    costAssistant = cfg.assistant === true;
    if (typeof cfg.assistantLabel === "string" && cfg.assistantLabel) costAssistantLabel = cfg.assistantLabel;
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
    if (g) g.innerHTML = costArchiveGain(archChosen(), T);
  }

  function load() {
    if (loading) { again = true; return; } // asked during a load: load again right after
    again = false;
    loading = true;
    fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; throw e; }
      mgClearBanner(banner);
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
      body.innerHTML = costRender(c, colors, T);
      archSync();
      Array.prototype.forEach.call(body.querySelectorAll(".mg-cost__item"), function (li) {
        var row = li.querySelector("[data-note]"), d = li.querySelector("details");
        if (row && d && open[row.getAttribute("data-note")]) d.open = true;
      });
      if (focused) {
        var again2 = body.querySelector('[data-copy="' + focused.replace(/["\\]/g, "") + '"]');
        if (again2 && again2.focus) again2.focus();
      }
    }).catch(function (e) {
      if (!last) body.innerHTML = '<p class="mg-cost__empty">' + costEsc(T("cost.loadFailed")) + '</p>';
      // A later refresh failing (the panel already has figures) used to stay fully quiet, leaving
      // possibly stale numbers looking current forever: the banner now says so, with a Retry that
      // simply loads again.
      mgErrorBanner(banner, mgBannerKind(e), T, load);
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
    copyInto(btn, costSplitPrompt(n, last, names));
  }
  function copyInto(btn, text) {
    copyText(text).then(function () {
      btn.textContent = T("cost.copied");
      btn.classList.add("mg-cost__copy--done");
      setTimeout(function () { btn.textContent = T("cost.copyPrompt"); btn.classList.remove("mg-cost__copy--done"); }, 2000);
    }).catch(function () {
      // Last resort: show the text, selected, for a manual copy.
      var ta = btn.parentNode.querySelector("textarea.mg-cost__manual");
      if (!ta) {
        ta = document.createElement("textarea");
        ta.className = "mg-cost__manual";
        ta.setAttribute("readonly", "");
        ta.setAttribute("aria-label", T("cost.promptToCopy"));
        btn.parentNode.appendChild(ta);
      }
      ta.value = text;
      ta.focus();
      ta.select();
      btn.textContent = T("cost.selectManually");
    });
  }
  function openNote(id) {
    try { document.dispatchEvent(new CustomEvent("memglow:ouvrir", { detail: id })); } catch (e) { return; }
    var stage = document.querySelector(".mem-stage");
    if (stage && stage.scrollIntoView) stage.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function orgOf(id) {
    var list = (last && last.organisation) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function copied(btn, label) {
    btn.textContent = T("cost.copied");
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
    var org = t.closest && t.closest("[data-copy-org]");
    if (org) {
      var s = orgOf(org.getAttribute("data-copy-org"));
      if (s && s.prompt) copyInto(org, s.prompt);
      return;
    }
    var aiOrg = t.closest && t.closest("[data-assist-org]");
    if (aiOrg) {
      var so = orgOf(aiOrg.getAttribute("data-assist-org"));
      try { document.dispatchEvent(new CustomEvent("memglow:assistant", { detail: { kind: "regroup", id: aiOrg.getAttribute("data-assist-org"), label: so ? so.message : "" } })); } catch (e3) { /* old browser */ }
      return;
    }
    var arch = t.closest && t.closest("[data-archive-copy],[data-archive-ai],[data-archive-plain]");
    if (arch) {
      var chosen = archChosen();
      if (!chosen.length) return;
      if (arch.hasAttribute("data-archive-copy")) {
        var text = costArchivePrompt(last.archive, chosen, names, undefined, last.protectedGroups);
        copyText(text).then(function () { copied(arch, T("cost.copyPrompt")); }).catch(function () { arch.textContent = T("arch.copyFailed"); });
        return;
      }
      var keys = chosen.map(function (s) { return s.key; });
      try { document.dispatchEvent(new CustomEvent("memglow:archive", { detail: { sections: keys, ai: arch.hasAttribute("data-archive-ai") } })); } catch (e3) { /* old browser */ }
      return;
    }
    var tidy = t.closest && t.closest("[data-tidy],[data-tidy-ai]");
    if (tidy) {
      try { document.dispatchEvent(new CustomEvent("memglow:tidy", { detail: { ai: tidy.hasAttribute("data-tidy-ai") } })); } catch (e4) { /* old browser */ }
      return;
    }
    var itrim = t.closest && t.closest("[data-index-trim]");
    if (itrim) {
      try { document.dispatchEvent(new CustomEvent("memglow:indexTrim")); } catch (e6) { /* old browser */ }
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
  document.addEventListener("memglow:language", load); // redraw the panel in the new language now
  setInterval(function () { if (!document.hidden) load(); }, 60000);
  load();
})();
