/*!
 * memglow — the control panel ("Night Shift"), served at /panel. MIT License.
 *
 * One page that answers, in order: is everything fine? what did memglow do while nobody was
 * using the memory? what does it need from me? what does it save? Then the settings.
 *
 * Data (all read through the viewer, same access rule as the page itself):
 *   GET /api/setup               control.proxy (levers, where each value comes from), tuning,
 *                                control.memoryServer (/healthz), control.memoryMaintenance (the
 *                                memory server's workers: auto-split, structure, archive, weekly)
 *   GET /api/maintenance         the viewer's own tidy-up suggestions (a count here)
 *   GET /api/maintenance/events  7 days of worker events, per-day counts, last/next scan
 *   GET /api/cost                clientTokens (by AI tool, by lever, session start), savingsByDay
 * Writes: PUT /api/setup ({ proxy } for a lever, { tuning } for the schedule), POST
 * /api/maintenance/run, POST /api/setup/secret ({ provider, remove: true }, danger zone).
 *
 * Never shows a secret, a disk path or the memory server's start-up flags: a key is "set" or
 * "not set", nothing more. Every text that comes from the server goes through cEsc() before
 * innerHTML; a chart's tooltip is filled with textContent.
 *
 * The first half of this file is pure (data in, HTML string out) and runs in Node for the tests;
 * the browser part at the end only fetches, measures and wires events.
 */

function cEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---- i18n: an English copy of every key this file renders, kept in sync with
   public/i18n/en.json by a test (same approach as zones.js / setup.js). */
var EN_CONTROL = {
  "settings.control": "Control",
  "control.title": "Control panel",
  "control.advanced": "Advanced",
  "control.sourceEnv": "set by {name}",
  "control.sourcePage": "saved here",
  "control.sourceFile": "memglow.config.json",
  "control.sourceDefault": "default",
  "control.locked": "Locked by {name}",
  "control.memoryServerOff": "Not configured (MEMGLOW_MEMORY_URL is not set).",
  "control.memoryServerError": "Could not reach it: {error}",
  "control.memoryServerOk": "{mode} · {notes} notes · v{version}",
  "control.memoryServerReadOnly": "read-only",
  "control.memoryServerReadWrite": "read-write",
  "control.memoryServerTokenYes": "token required",
  "control.memoryServerTokenNo": "no token required",
  "control.memoryServerFsync": "writes: fsync {mode}",
  "control.workerAutoSplit": "Auto-split",
  "control.workerStructure": "Structure guardian",
  "control.workerArchive": "Auto-archive",
  "control.proxySeen": "MCP proxy last seen {ago} ({ms} ms)",
  "control.proxyNeverSeen": "The MCP proxy has not reported in yet.",
  "control.lever.sizeWarning": "Warn when a note being read (or just written) is over the large-note threshold.",
  "control.lever.indexWarning": "Warn when the memory index itself is over its own threshold.",
  "control.lever.dedupe": "An unchanged note, re-read in the same session, gets a short “unchanged” stub instead of its full text.",
  "control.lever.toc": "A large note gets a table of contents first; a section is fetched only on demand.",
  "control.lever.archiveHint": "A search that finds nothing live lists the matching titles of the archive summary.",
  "control.lever.hideUnsupportedTools": "Hide tools a client cannot use (e.g. ChatGPT-only tools) from its own tools list.",
  "control.lever.multiQuery": "Several search phrasings are sent upstream as one round trip instead of one model turn each.",
  "control.lever.aliases": "A past search's words, learned from what was actually read afterwards, surface a likely note at the top of a similar later search.",
  "control.lever.learnAliases": "Record which note a search's words actually led to, for the aliases lever above to use later.",
  "control.lever.negativeCache": "A search that found nothing useful last time gets a short reminder, while the memory has not changed since.",
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

  "panel.skip": "Skip to content",
  "panel.backToGraph": "Memory graph",
  "panel.language": "Language",
  "panel.theme": "Theme",
  "panel.themeSystem": "System theme",
  "panel.themeLight": "Light",
  "panel.themeDark": "Dark",
  "panel.navAria": "Sections",
  "panel.navOverview": "Overview",
  "panel.navMaintenance": "Maintenance",
  "panel.navSavings": "Savings",
  "panel.navProvider": "AI provider",
  "panel.navSettings": "Settings",
  "panel.navBadge": { one: "{n} thing waiting", other: "{n} things waiting" },
  "panel.serverOnline": "Memory server online",
  "panel.serverOffline": "Memory server out of reach",
  "panel.serverNone": "No memory server connected",
  "panel.serverMore": "{mode}, v{version}, {notes} notes",

  "panel.heroTidied": { one: "memglow tidied {n} thing in your memory this week.", other: "memglow tidied {n} things in your memory this week." },
  "panel.heroQuiet": "Your memory is in order. Nothing needed tidying this week.",
  "panel.heroStopped": "memglow stopped at {time}. Its AI key was refused.",
  "panel.heroSetup": "Maintenance is not set up yet.",
  "panel.heroUnreachable": "memglow cannot reach the memory server.",
  "panel.whenWeek": "Last 7 days. Last pass {when}.",
  "panel.whenWeekNoScan": "Last 7 days. No pass has run yet.",
  "panel.whenStopped": "Stopped {when}. Nothing in your memory was changed.",
  "panel.whenSetup": "Nothing runs on its own for now.",
  "panel.tallySplit": { one: "{n} note split", other: "{n} notes split" },
  "panel.tallyFixes": { one: "{n} structure fix", other: "{n} structure fixes" },
  "panel.tallyArchived": { one: "{n} section archived", other: "{n} sections archived" },
  "panel.verdictOk": "All good",
  "panel.verdictNeeds": "Needs you",
  "panel.verdictSetup": "Not set up yet",
  "panel.verdictOkText": "Nothing was deleted. Next pass {when}.",
  "panel.verdictOkTextNoNext": "Nothing was deleted.",
  "panel.verdictOkLink": { one: "{n} thing to look at when you like", other: "{n} things to look at when you like" },
  "panel.verdictNeedsText": { one: "{n} worker is paused. Nothing in your memory was changed.", other: "{n} workers are paused. Nothing in your memory was changed." },
  "panel.verdictNeedsLink": "Check the AI provider",
  "panel.verdictSetupText": "Your memory is safe as it is. Turn the workers on in the memory server and memglow tidies it at night.",
  "panel.verdictSetupLink": "See what is missing",
  "panel.verdictUnreachableText": "The workers may still be running; this page cannot see them. Answer received: {error}.",
  "panel.stripAria": "Last 24 hours of maintenance, night hours shaded",
  "panel.legendNight": "Night, 22:00 to 07:00",
  "panel.legendError": "Stopped on an error",
  "panel.stripEmpty": "No maintenance in the last 24 hours.",

  "panel.vitalSaved": "Tokens saved, last 7 days",
  "panel.vitalSaved30": "≈ {n} over 30 days",
  "panel.vitalSavedNone": "No saving measured yet",
  "panel.vitalWorkers": "Maintenance workers",
  "panel.workersRunning": "{n} of {total} running",
  "panel.workersPaused": "{n} of {total} paused",
  "panel.workersOff": "None running",
  "panel.vitalProvider": "AI provider",
  "panel.provNone": "Not chosen",
  "panel.provSubOk": "{model}, key set",
  "panel.provSubNoKeyNeeded": "{model}, no key needed",
  "panel.provSubNoKey": "{model}, key not set",
  "panel.provSubAuth": "Key refused at {time}",
  "panel.provSubNone": "Maintenance that needs an AI is waiting",
  "panel.prov.anthropic": "Anthropic API",
  "panel.prov.openai-compatible": "OpenAI-compatible API",
  "panel.prov.claude-code": "Claude Code subscription",

  "panel.bannerAuth": "Maintenance stopped {when}.",
  "panel.bannerAuthToday": "Maintenance stopped at {time}.",
  "panel.atTime": "at {time}",
  "panel.bannerAuthRest": "{message} Nothing in your memory was changed. Fix the key and the workers resume on their next pass.",
  "panel.bannerAuthBtn": "See AI provider",

  "panel.maintTitle": "Maintenance",
  "panel.maintIntro": "Three workers keep your memory small and well linked. They wait until no assistant has touched a note for a while, so they never work in the middle of a conversation.",
  "panel.ledgerTitle": "This week",
  "panel.ledgerSplit": "Notes split",
  "panel.ledgerSplitSub": "long notes cut into linked parts",
  "panel.ledgerFixes": "Structure fixes",
  "panel.ledgerFixesSub": "links and lists put back in place",
  "panel.ledgerFixesByRule": "by rule: {list}",
  "panel.ledgerArchived": "Sections archived",
  "panel.ledgerArchivedSub": "long unread, still searchable",
  "panel.ledgerDuplicates": "Possible duplicates",
  "panel.ledgerDuplicatesSub": "reported, never merged",
  "panel.ledgerAi": "AI calls",
  "panel.ledgerAiSub": "headings and short excerpts only",
  "panel.ledgerCached": "Verdicts reused",
  "panel.ledgerCachedSub": "AI calls that were not needed",
  "panel.ledgerErrors": "Errors",
  "panel.ledgerErrorsNone": "none this week",
  "panel.ledgerErrorsSome": "see the workers below",
  "panel.ledgerBarsAria": "Per day, oldest first: {list}",
  "panel.lanesTitle": "Who worked when",
  "panel.lanesHint": "7 days, a dot per action",
  "panel.lanesAria": "Seven-day timeline of each maintenance worker, night hours shaded",
  "panel.lanesEmpty": "No worker has logged anything in the last 7 days.",
  "panel.lanesUnavailable": "This memory server does not send its timeline yet. Update it to see the lanes.",
  "panel.ev.split": "Note split",
  "panel.ev.fix": "Structure fix",
  "panel.ev.archived": "Sections archived",
  "panel.ev.error": "Stopped on an error",
  "panel.ev.other": "Checked",
  "panel.issuesTitle": "Needs your eye",
  "panel.issuesHint": "memglow reports these and never fixes them alone",
  "panel.issuesEmpty": "Nothing needs you. Anything memglow is not allowed to fix alone will be listed here.",
  "panel.issuesMore": { one: "Show {n} more", other: "Show {n} more" },
  "panel.issueFixable": "memglow fixes this on its next pass",
  "panel.issueReview": "Yours to decide",
  "panel.issueAuthTitle": { one: "AI key refused, {n} worker paused", other: "AI key refused, {n} workers paused" },
  "panel.issueSuggestions": { one: "{n} tidy-up suggestion is waiting on the memory page", other: "{n} tidy-up suggestions are waiting on the memory page" },
  "panel.issueSuggestionsLink": "Open the memory page",
  "panel.rule.R1": "The index lists a part directly",
  "panel.rule.R2": "A part has lost the link up to its hub",
  "panel.rule.R3": "A hub's list of parts is out of date",
  "panel.rule.R4": "A part lists its sibling notes",
  "panel.rule.R5": "Orphan note, nothing leads to it",
  "panel.rule.R6": "A note sits in the wrong section of the index",
  "panel.rule.R7": "Theme not in your list",
  "panel.rule.D1": "Possible duplicate",
  "panel.rule.other": "Structure issue",
  "panel.workerSplitDesc": "Cuts a note that has grown too long into smaller linked notes, once it has been quiet for a while.",
  "panel.workerStructureDesc": "Keeps every note reachable from the index and every part linked to its hub. It only adds lines.",
  "panel.workerArchiveDesc": "Moves sections nobody has read for a long time into the archive. They stay searchable.",
  "panel.statusRunning": "Running",
  "panel.statusPaused": "Paused",
  "panel.statusOff": "Off",
  "panel.workerStopped": "Stopped {when}.",
  "panel.workerStoppedRest": "{message} Nothing was changed.",
  "panel.kvAi": "AI",
  "panel.kvAiNone": "None, rules only",
  "panel.kvLast": "Last pass",
  "panel.kvNext": "Next pass",
  "panel.kvQueue": "Queue",
  "panel.never": "Never",
  "panel.nextAfterFix": "After the key is fixed",
  "panel.nextUnknown": "Not scheduled",
  "panel.queueSplit": { one: "{n} note waiting to go quiet", other: "{n} notes waiting to go quiet" },
  "panel.queueStructure": { one: "{n} issue found, {review} to review", other: "{n} issues found, {review} to review" },
  "panel.queueArchive": "Sections unread for {n} days",
  "panel.noEvents": "No activity in the last 7 days.",

  "panel.savingsTitle": "Token savings",
  "panel.savingsIntro": "What your assistants did not have to read again, as measured by the MCP proxy. Estimates: 4 bytes ≈ 1 token.",
  "panel.savedWeek": "Saved in the last 7 days",
  "panel.savedUnit": "tokens your assistants did not have to read",
  "panel.saved30": "Last 30 days",
  "panel.savedSessions": "Session starts' worth",
  "panel.savedCalls": "Calls relayed, 7 days",
  "panel.perDayTitle": "Saved per day",
  "panel.perDayHint": "30 days, the last 7 in full colour",
  "panel.perDayAria": "Tokens saved per day over the last 30 days",
  "panel.perDayTip": "≈ {n} tokens saved",
  "panel.today": "Today",
  "panel.byLeverTitle": "By lever, 7 days",
  "panel.byClientTitle": "Relayed by AI tool, 7 days",
  "panel.rankCalls": { one: "{n} call", other: "{n} calls" },
  "panel.savingsEmpty": "Nothing measured yet. Savings appear once an assistant reads your memory through the MCP proxy.",
  "panel.sessionTitle": "What a session costs before the first question",
  "panel.sessionIntro": "Measured on real sessions over 7 days: the memory summary an assistant loads, plus the list of tools it is given.",
  "panel.sessionTotal": "≈ {n} tokens per session start",
  "panel.sessionCore": "Memory summary (memory_core)",
  "panel.sessionTools": "List of tools (tools/list)",
  "panel.sessionServed": { one: "average of {n} answer", other: "average of {n} answers" },
  "panel.sessionEmpty": "Not measured yet. The figure appears after the first session that goes through the MCP proxy.",

  "panel.providerTitle": "AI provider",
  "panel.providerIntro": "The AI that the maintenance workers ask for a split plan or a judgement. It only sees headings, sizes and short masked excerpts, never a whole note.",
  "panel.provOkTitle": "Connected. Key set.",
  "panel.provOkTitleNoKey": "Connected through your Claude subscription.",
  "panel.provOkText": "The key itself is never shown here.",
  "panel.provAuthTitle": "Key refused {when}",
  "panel.provAuthText": "The provider answered: {message} The key may have been revoked or mistyped. Replace it where the memory server reads it, then restart the memory server. The workers resume on their next pass.",
  "panel.provNoKeyTitle": "No key yet",
  "panel.provNoKeyText": "A provider is chosen but its key is not set. The workers that need an AI wait; the others keep running.",
  "panel.provNoneTitle": "No provider yet",
  "panel.provNoneText": "Your memory is not at risk. Choose a provider and memglow can split long notes and judge the hard cases at night.",
  "panel.provHow": "The provider is set on the memory server, not from this page: MEMGLOW_AI_PROVIDER, MEMGLOW_AI_MODEL and its key (a variable or a file). Restart the memory server to apply a change.",
  "panel.kvProvider": "Provider",
  "panel.kvModel": "Model",
  "panel.kvKey": "Key",
  "panel.keySet": "set",
  "panel.keyNotSet": "not set",
  "panel.keyNotNeeded": "not needed",
  "panel.kvUsedBy": "Used by",
  "panel.assistantTitle": "On-demand assistant",
  "panel.assistantOn": "On, with {provider}.",
  "panel.assistantOff": "Off. Turn it on to tidy a note yourself from the memory page.",
  "panel.assistantOpen": "Open AI settings",

  "panel.settingsTitle": "Settings",
  "panel.settingsIntro": "Every lever starts on a safe default. A value set by an environment variable is locked here and shows its name.",
  "panel.leversTitle": "Token-saving levers",
  "panel.leversAdvanced": { one: "Advanced lever ({n})", other: "Advanced levers ({n})" },
  "panel.badgeDefault": "Default",
  "panel.badgeChanged": "Changed here",
  "panel.badgeFile": "From memglow.config.json",
  "panel.leverSaved": "≈ {n} saved in 7 days",
  "panel.capsTitle": "Thresholds",
  "panel.lever.sizeWarning": "Warn about large notes",
  "panel.lever.indexWarning": "Warn when the index grows too big",
  "panel.lever.dedupe": "Unchanged re-reads",
  "panel.lever.toc": "Table of contents first",
  "panel.lever.archiveHint": "Point to the archive",
  "panel.lever.hideUnsupportedTools": "Hide tools a client cannot use",
  "panel.lever.multiQuery": "Several searches in one round trip",
  "panel.lever.aliases": "Learned shortcuts in search",
  "panel.lever.learnAliases": "Learn shortcuts",
  "panel.lever.negativeCache": "Remember empty searches",
  "panel.lever.duplicateHint": "Duplicate warning on write",
  "panel.lever.slugHint": "Naming hint",
  "panel.lever.hubHint": "Suggest a hub for a growing note",
  "panel.lever.stateView": "Current state of a journal note",
  "panel.lever.orphanHint": "Orphan warning on write",
  "panel.leverHelp.hubHint": "A note that keeps growing gets a short hint to turn it into a hub with parts.",
  "panel.leverHelp.stateView": "A long dated journal note is answered with its current state first; the full history stays one call away.",
  "panel.leverHelp.orphanHint": "Writing a brand-new note that nothing links to gets a short hint to list it in the index or a hub.",
  "panel.scheduleTitle": "Schedule",
  "panel.serverTitle": "Memory server and proxy",
  "panel.dangerTitle": "Danger zone",
  "panel.dangerResetTitle": "Put every lever back to its default",
  "panel.dangerResetText": { one: "{n} lever was changed from this page. Your notes are not touched.", other: "{n} levers were changed from this page. Your notes are not touched." },
  "panel.dangerResetNone": "No lever was changed from this page.",
  "panel.dangerResetBtn": "Reset levers",
  "panel.dangerResetConfirm": { one: "Reset {n} lever? Values set by an environment variable or by memglow.config.json stay as they are.", other: "Reset {n} levers? Values set by an environment variable or by memglow.config.json stay as they are." },
  "panel.dangerKeyTitle": "Forget the AI key saved from the browser",
  "panel.dangerKeyText": "Removes the key of {provider} from memglow's data folder. The on-demand assistant stops until you paste a new one.",
  "panel.dangerKeyNone": "No key was saved from the browser.",
  "panel.dangerKeyBtn": "Forget key",
  "panel.dangerKeyConfirm": "Forget the key of {provider}? It cannot be read back; you will have to paste it again.",
  "panel.cancel": "Cancel",
  "panel.done": "Done",
  "panel.foot": "memglow keeps this page on your machine: no web font, no tracker, no outside request.",
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

/* ---- numbers and times in the page language (Intl), English in Node and without Intl ---- */
function controlLang() {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  return M && M.lang ? M.lang() : "en";
}
function cNum(n, lang) {
  n = Math.round(Number(n) || 0);
  try { return new Intl.NumberFormat(lang || controlLang()).format(n); } catch (e) { return String(n); }
}
/** 1234567 → "1.2M", 41200 → "41K" (compact, in the page language). */
function cCompact(n, lang) {
  n = Number(n) || 0;
  try { return new Intl.NumberFormat(lang || controlLang(), { notation: "compact", maximumFractionDigits: n >= 1e6 ? 2 : n >= 1e4 ? 0 : 1 }).format(n); }
  catch (e) { return String(Math.round(n)); }
}
function cHM(ms, lang) {
  try { return new Intl.DateTimeFormat(lang || controlLang(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)); }
  catch (e) { var d = new Date(ms); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
}
function cDay(ms, lang) {
  try { return new Intl.DateTimeFormat(lang || controlLang(), { weekday: "short", day: "numeric" }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toDateString().slice(0, 10); }
}
function cSameDay(a, b) {
  var x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
/** "02:14" when `ms` is today, "Tue 17, 02:14" otherwise. */
function cWhen(ms, now, lang) {
  return cSameDay(ms, now) ? cHM(ms, lang) : cDay(ms, lang) + ", " + cHM(ms, lang);
}
/** For a sentence: "at 02:14" today (in the page language), "Tue 17, 02:14" another day. */
function cAt(ms, now, T, lang) {
  return cSameDay(ms, now) ? T("panel.atTime", { time: cHM(ms, lang) }) : cWhen(ms, now, lang);
}
function cTimeOf(iso) {
  if (typeof iso === "number") return iso;
  var t = iso ? Date.parse(iso) : NaN;
  return isFinite(t) ? t : null;
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

/* ============================== the model ============================== */

var WORKERS = [
  { id: "split", name: "control.workerAutoSplit", desc: "panel.workerSplitDesc", icon: '<path d="M6 4v6a4 4 0 0 0 4 4h8M14 10l4 4-4 4M6 20v-2"/>' },
  { id: "structure", name: "control.workerStructure", desc: "panel.workerStructureDesc", icon: '<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="5" r="1.8"/><circle cx="19" cy="5" r="1.8"/><circle cx="12" cy="20" r="1.8"/><path d="M7 7l3 3M17 7l-3 3M12 14.5V18"/>' },
  { id: "archive", name: "control.workerArchive", desc: "panel.workerArchiveDesc", icon: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10h14V9M10 13h4"/>' },
];
var ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.01"/>',
  warn: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.01"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
};
function cIcon(name, size, sw) {
  return '<svg class="ic" width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2.2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || name) + '</svg>';
}

/** "act" (something was tidied), "err" (stopped on an error) or "minor" (looked, changed nothing). */
function controlEventClass(kind) {
  if (kind === "split" || kind === "fix" || kind === "archived") return "act";
  if (/fail|error/.test(String(kind))) return "err";
  return "minor";
}
function cEvents(arr) {
  var out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (e) {
    var t = e ? cTimeOf(e.t) : null;
    if (t == null) return;
    out.push({ t: t, kind: String(e.kind || ""), cls: controlEventClass(e.kind), note: e.note || "", detail: e.detail || "" });
  });
  return out.sort(function (a, b) { return a.t - b.t; });
}

/**
 * Everything the page shows, worked out once from the four answers. Pure.
 * `kind`: "ok" | "needs" (a worker gave up on a bad credential) | "setup" (no memory server, or
 * no worker turned on) | "unreachable" (a memory server is configured but did not answer).
 */
function controlModel(d, now) {
  d = d || {};
  now = now || Date.now();
  var setup = d.setup || {};
  var c = setup.control || {};
  var mm = c.memoryMaintenance || { configured: false };
  var ms = c.memoryServer || { configured: false };
  var up = !!(mm.configured && mm.ok);
  var ev = d.events && d.events.ok ? d.events : null;
  var sc = (ev && ev.schedule) || {};
  var as = (up && mm.autoSplit) || {}, st = (up && mm.structure) || {}, ar = (up && mm.archive) || {};
  var scS = sc.structure || {}, stAi = scS.ai && scS.ai.enabled ? scS.ai : null;
  var errOf = function (x) { var t = x && x.lastError ? cTimeOf(x.lastError.t) : null; return x && x.lastError ? { t: t, message: String(x.lastError.message || "") } : null; };
  var workers = [
    { id: "split", on: !!as.enabled, err: errOf(as), provider: as.provider || "", model: as.model || "", keySet: !!as.keySet,
      last: cTimeOf((sc.autoSplit || {}).lastScanAt), next: cTimeOf((sc.autoSplit || {}).nextScanAt), pending: as.pendingCount || 0, events: cEvents(ev && ev.autoSplit) },
    { id: "structure", on: !!st.enabled, err: errOf(st), provider: stAi ? stAi.provider || "" : "", model: stAi ? stAi.model || "" : "", keySet: null,
      last: cTimeOf(scS.lastScanAt), next: cTimeOf(scS.nextScanAt), issues: st.issues || 0, needsReview: scS.needsReview || 0, events: cEvents(ev && ev.structure) },
    { id: "archive", on: !!ar.enabled, err: errOf(ar), provider: ar.provider || "", model: ar.model || "", keySet: !!ar.keySet,
      last: cTimeOf(ar.lastScanAt) || cTimeOf((sc.archive || {}).lastScanAt), next: cTimeOf(ar.nextScanAt) || cTimeOf((sc.archive || {}).nextScanAt), keepDays: ar.keepDays || 0, events: cEvents(ev && ev.archive) },
  ];
  workers.forEach(function (w, i) { w.name = WORKERS[i].name; w.desc = WORKERS[i].desc; w.icon = WORKERS[i].icon; });
  var paused = workers.filter(function (w) { return w.on && w.err; });
  var running = workers.filter(function (w) { return w.on && !w.err; });
  var anyOn = workers.some(function (w) { return w.on; });
  var auth = null;
  paused.forEach(function (w) { if (!auth || (w.err.t != null && (auth.t == null || w.err.t < auth.t))) auth = { t: w.err.t, message: w.err.message }; });
  // The one provider the workers share (same MEMGLOW_AI_* on the memory server).
  var prov = null;
  workers.forEach(function (w) { if (!prov && w.on && w.provider) prov = { id: w.provider, model: w.model, keySet: w.keySet, usedBy: [] }; });
  if (prov) {
    workers.forEach(function (w) { if (w.on && w.provider === prov.id) { prov.usedBy.push(w.id); if (w.keySet === true) prov.keySet = true; } });
  }
  var provState = auth ? "auth" : !prov ? "none" : prov.id === "claude-code" ? "ok" : prov.keySet ? "ok" : "nokey";
  var kind = !mm.configured ? "setup" : !mm.ok ? "unreachable" : !anyOn ? "setup" : paused.length ? "needs" : "ok";
  var wk = (up && mm.weekly) || null;
  var tidied = wk ? (wk.notesSplit || 0) + (wk.structureFixes || 0) + (wk.sectionsArchived || 0) : 0;
  // "Needs your eye": the structure audit's own list, what needs a decision first; a D1 pair
  // the list does not already carry is added from `duplicates.reported`.
  var issues = [];
  if (st.enabled) {
    (st.issueList || []).forEach(function (it) { issues.push({ rule: it.rule || "", note: it.note || "", detail: it.detail || "", fixable: !!it.fixable }); });
    var hasD1 = issues.some(function (i) { return i.rule === "D1"; });
    if (!hasD1 && up && mm.duplicates && mm.duplicates.enabled) {
      (mm.duplicates.reported || []).forEach(function (r) {
        issues.push({ rule: "D1", note: r.a || "", detail: (r.b || "") + (r.score != null ? " (" + r.score + ")" : ""), fixable: false });
      });
    }
  }
  issues.sort(function (a, b) { return (a.fixable ? 1 : 0) - (b.fixable ? 1 : 0); });
  var review = issues.filter(function (i) { return !i.fixable; }).length;
  var lastPass = null, nextPass = null;
  workers.forEach(function (w) {
    if (!w.on) return;
    if (w.last != null && (lastPass == null || w.last > lastPass)) lastPass = w.last;
    if (w.next != null && w.next > now && (nextPass == null || w.next < nextPass)) nextPass = w.next;
  });
  var cost = d.cost || {};
  var ct = cost.clientTokens || null;
  var byDay = Array.isArray(cost.savingsByDay) ? cost.savingsByDay : [];
  var sum = function (arr) { return arr.reduce(function (a, p) { return a + (Number(p.saved) || 0); }, 0); };
  var saved7 = byDay.length ? sum(byDay.slice(-7)) : 0;
  if (!byDay.length && ct && ct.byLever) Object.keys(ct.byLever).forEach(function (k) { saved7 += Number(ct.byLever[k].tokens) || 0; });
  return {
    now: now, kind: kind, mm: mm, ms: ms, up: up, hasEvents: !!ev, eventsError: d.events && d.events.configured && !d.events.ok ? d.events.error || "" : "",
    workers: workers, paused: paused, running: running, anyOn: anyOn, auth: auth, prov: prov, provState: provState,
    weekly: wk, days: (ev && ev.days) || [], tidied: tidied, issues: issues, review: review, lastPass: lastPass, nextPass: nextPass,
    suggestions: d.maintenance && Array.isArray(d.maintenance.items) ? d.maintenance.items.length : 0,
    waiting: review + (auth ? 1 : 0),
    clientTokens: ct, byDay: byDay, saved7: saved7, saved30: sum(byDay),
    setup: setup, proxy: c.proxy || { levers: [], caps: [] }, proxySeen: c.proxySeen || null, assistant: setup.assistant || null,
  };
}

/* ============================== charts (SVG strings) ============================== */

var H_MS = 3600000, D_MS = 86400000;

function cTipAttrs(title, body) {
  return ' tabindex="0" data-tip-t="' + cEsc(title) + '" data-tip-b="' + cEsc(body) + '"';
}
function cEventText(e, T) {
  var k = e.cls === "err" ? "panel.ev.error" : e.kind === "split" ? "panel.ev.split" : e.kind === "fix" ? "panel.ev.fix" : e.kind === "archived" ? "panel.ev.archived" : "panel.ev.other";
  var rest = [e.note, e.detail].filter(Boolean).join(", ");
  return T(k) + (rest ? ": " + rest : "");
}

/**
 * Lanes: one row per worker over [from, to], night hours (22:00 → 07:00) shaded, a filled dot per
 * action, a crossed ring per error, a faint tick for a pass that changed nothing. `compact`
 * (the 24-hour strip of the first screen): thin rows, no row label, an hour axis. Colours come
 * from CSS variables (--w-<id>, --c-night, --c-line, --c-ink, --c-bg, --crit), so the same SVG
 * follows the theme without a redraw. Pure.
 */
function controlLanesSvg(o) {
  var T = o.T || defaultControlT, lang = o.lang;
  var w = Math.max(260, Math.round(o.w || 600)), compact = !!o.compact;
  var rows = o.workers || [];
  var narrow = !compact && w < 560;
  var gutter = compact || narrow ? 0 : 148;
  var laneH = compact ? 26 : narrow ? 42 : 40, axis = 24, top = 4;
  var h = top + rows.length * laneH + axis;
  var x = function (t) { return gutter + (t - o.from) / (o.to - o.from) * (w - gutter); };
  var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + cEsc(o.aria || "") + '">';
  // night bands
  var d0 = new Date(o.from); d0.setHours(0, 0, 0, 0);
  for (var t = d0.getTime() - D_MS; t < o.to; t += D_MS) {
    var a = Math.max(gutter, x(t + 22 * H_MS)), b = Math.min(w, x(t + 31 * H_MS));
    if (b > a) s += '<rect x="' + a.toFixed(1) + '" y="' + top + '" width="' + (b - a).toFixed(1) + '" height="' + (rows.length * laneH) + '" fill="var(--c-night)" rx="5"/>';
  }
  rows.forEach(function (r, i) {
    var y0 = top + i * laneH, cy = narrow ? y0 + laneH - 13 : y0 + laneH / 2;
    if (!compact) {
      s += narrow
        ? '<text x="2" y="' + (y0 + 13) + '" font-size="11.5" fill="var(--c-ink)">' + cEsc(T(r.name)) + '</text>'
        : '<circle cx="7" cy="' + cy + '" r="4.5" fill="var(--w-' + r.id + ')"/><text x="19" y="' + (cy + 4) + '" font-size="12.5" fill="var(--c-ink-strong)">' + cEsc(T(r.name)) + '</text>';
    }
    s += '<line x1="' + gutter + '" x2="' + w + '" y1="' + cy + '" y2="' + cy + '" stroke="var(--c-line)" stroke-width="1"' + (compact ? "" : ' stroke-dasharray="1 5" stroke-linecap="round"') + '/>';
    (r.events || []).forEach(function (e) {
      if (e.t < o.from || e.t > o.to) return;
      var cx = x(e.t).toFixed(1);
      var title = T(r.name) + ", " + cWhen(e.t, o.to, lang), body = cEventText(e, T);
      if (e.cls === "minor") {
        s += '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="var(--w-' + r.id + ')" fill-opacity=".45"><title>' + cEsc(title + ". " + body) + '</title></circle>';
      } else if (e.cls === "err") {
        s += '<g class="dot"' + cTipAttrs(title, body) + '><circle cx="' + cx + '" cy="' + cy + '" r="12" fill="transparent"/><circle cx="' + cx + '" cy="' + cy + '" r="6.5" fill="var(--c-bg)" stroke="var(--crit)" stroke-width="2.4"/>' +
          '<path d="M' + (cx - 2.6) + ' ' + (cy - 2.6) + 'l5.2 5.2M' + (+cx + 2.6) + ' ' + (cy - 2.6) + 'l-5.2 5.2" stroke="var(--crit)" stroke-width="1.8" stroke-linecap="round"/></g>';
      } else {
        s += '<g class="dot"' + cTipAttrs(title, body) + '><circle cx="' + cx + '" cy="' + cy + '" r="12" fill="transparent"/><circle cx="' + cx + '" cy="' + cy + '" r="' + (compact ? 6 : 5) + '" fill="var(--w-' + r.id + ')" stroke="var(--c-bg)" stroke-width="2"/></g>';
      }
    });
  });
  // axis
  var base = top + rows.length * laneH;
  if (compact) {
    var step = (w < 520 ? 6 : 3) * H_MS;
    var first = new Date(o.from); first.setMinutes(0, 0, 0);
    for (var tt = first.getTime(); tt < o.to; tt += H_MS) {
      if (new Date(tt).getHours() % (step / H_MS) !== 0) continue;
      var xx = x(tt);
      if (xx < gutter + 18 || xx > w - 18) continue;
      s += '<text x="' + xx.toFixed(1) + '" y="' + (base + 16) + '" font-size="11" text-anchor="middle" fill="var(--c-ink)">' + cEsc(cHM(tt, lang)) + '</text>';
    }
  } else {
    for (var td = d0.getTime(); td < o.to; td += D_MS) {
      var xm = x(td + 12 * H_MS);
      if (xm < gutter + 16 || xm > w - 12) continue;
      s += '<text x="' + xm.toFixed(1) + '" y="' + (base + 16) + '" font-size="11.5" text-anchor="middle" fill="var(--c-ink)">' + cEsc(cDay(td + 12 * H_MS, lang)) + '</text>';
    }
  }
  return s + '</svg>';
}

/** A 7-point line with a soft fill and a dot on the last value. */
function controlSparkSvg(vals, w) {
  w = Math.max(140, Math.round(w || 240));
  var h = 44, n = vals.length, mx = Math.max.apply(null, vals.concat([1]));
  if (n < 2) return "";
  var pts = vals.map(function (v, i) { return [3 + i / (n - 1) * (w - 6), h - 5 - (v / mx) * (h - 12)]; });
  var line = "M" + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("L");
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true"><path d="' + line + 'L' + (w - 3) + ' ' + h + 'L3 ' + h + 'Z" fill="var(--glow)" fill-opacity=".13"/>' +
    '<path d="' + line + '" fill="none" stroke="var(--glow)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + pts[n - 1][0].toFixed(1) + '" cy="' + pts[n - 1][1].toFixed(1) + '" r="4" fill="var(--glow)" stroke="var(--surface)" stroke-width="2"/></svg>';
}

/** Seven small bars, one per day; an empty day keeps a hairline so the week stays readable. */
function controlMiniBars(vals, color, label) {
  var w = 88, h = 24, mx = Math.max.apply(null, vals.concat([1])), n = vals.length || 1, bw = w / n - 3;
  var s = '<svg class="mini" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + cEsc(label || "") + '">';
  vals.forEach(function (v, i) {
    var bh = v ? Math.max(4, v / mx * h) : 2;
    s += '<rect x="' + (i * (bw + 3)).toFixed(1) + '" y="' + (h - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="' + (v ? 2 : 1) + '" fill="' + (v ? color : "var(--line-2)") + '"/>';
  });
  return s + '</svg>';
}

function cNiceMax(v) {
  if (v <= 0) return 100;
  var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Tokens saved per day: one bar per day, the last 7 at full strength. `byDay` oldest first. */
function controlBarsSvg(byDay, w, T, lang) {
  T = T || defaultControlT;
  w = Math.max(280, Math.round(w || 640));
  var h = 210, padL = 44, padB = 24, padT = 10, n = byDay.length || 1;
  var mx = cNiceMax(Math.max.apply(null, byDay.map(function (p) { return p.saved || 0; }).concat([0])));
  var bw = (w - padL) / n, gap = Math.max(2, bw * 0.28);
  var y = function (v) { return h - padB - v / mx * (h - padB - padT); };
  var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + cEsc(T("panel.perDayAria")) + '">';
  [0, mx / 2, mx].forEach(function (v) {
    s += '<line x1="' + padL + '" x2="' + w + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)"/>' +
      '<text x="' + (padL - 8) + '" y="' + (y(v) + 4).toFixed(1) + '" font-size="11" text-anchor="end" fill="var(--ink-3)">' + cEsc(v ? cCompact(v, lang) : "0") + '</text>';
  });
  byDay.forEach(function (p, i) {
    var v = p.saved || 0, x0 = padL + i * bw + gap / 2, bwi = bw - gap, r = Math.min(4, bwi / 2), recent = i >= n - 7, last = i === n - 1;
    var t = Date.parse(p.day + "T12:00:00");
    var yy = v ? Math.min(y(v), h - padB - 3) : h - padB - 1.5;
    var path = v
      ? '<path d="M' + x0.toFixed(1) + ' ' + (h - padB) + 'V' + (yy + r).toFixed(1) + 'q0 -' + r + ' ' + r + ' -' + r + 'H' + (x0 + bwi - r).toFixed(1) + 'q' + r + ' 0 ' + r + ' ' + r + 'V' + (h - padB) + 'Z" fill="var(--glow)" fill-opacity="' + (recent ? 1 : 0.38) + '"/>'
      : '<rect x="' + x0.toFixed(1) + '" y="' + yy + '" width="' + bwi.toFixed(1) + '" height="1.5" fill="var(--line-2)"/>';
    s += '<g class="dot"' + cTipAttrs(last ? T("panel.today") : cDay(t, lang), T("panel.perDayTip", { n: cNum(v, lang) })) + '><rect x="' + (padL + i * bw).toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + (h - padB) + '" fill="transparent"/>' + path + '</g>';
    if ((n - 1 - i) % 7 === 0) s += '<text x="' + (x0 + bwi / 2).toFixed(1) + '" y="' + (h - 6) + '" font-size="11" text-anchor="' + (last ? "end" : "middle") + '" fill="var(--ink-3)"' + (last ? ' dx="' + (bwi / 2).toFixed(1) + '"' : "") + '>' + cEsc(last ? T("panel.today") : cDay(t, lang)) + '</text>';
  });
  return s + '</svg>';
}

/* ============================== sections ============================== */

function cProvLabel(id, T) {
  var k = "panel.prov." + id, v = T(k);
  return v === k ? id : v;
}
function cChip(cls, html) { return '<span class="chip' + (cls ? " chip--" + cls : "") + '">' + html + '</span>'; }
function cDot(id) { return '<i class="gl" style="background:var(--w-' + id + ')" aria-hidden="true"></i>'; }

/** The red strip under the top bar: only when a worker gave up on a bad credential. */
function controlRenderBanner(m, T, lang) {
  T = T || defaultControlT;
  if (!m.auth) return "";
  var today = m.auth.t != null && cSameDay(m.auth.t, m.now);
  var head = today ? T("panel.bannerAuthToday", { time: cHM(m.auth.t, lang) }) : T("panel.bannerAuth", { when: m.auth.t != null ? cWhen(m.auth.t, m.now, lang) : "" });
  return '<div class="alert" role="alert">' + cIcon("warn", 20, 2) +
    '<p><b>' + cEsc(head) + '</b> ' + cEsc(T("panel.bannerAuthRest", { message: cSentence(m.auth.message) })) + '</p>' +
    '<a class="btn btn--danger-solid alert__act" href="#provider">' + cEsc(T("panel.bannerAuthBtn")) + '</a></div>';
}
/** A provider's raw message, trimmed and closed by a full stop (it is quoted inside a sentence). */
function cSentence(msg) {
  var s = String(msg || "").trim().slice(0, 220);
  if (!s) return "";
  return /[.!?…]$/.test(s) ? s : s + ".";
}

/** First screen: the one deep card. One sentence, the tally, the verdict, the last 24 hours. */
function controlRenderHero(m, T, lang) {
  T = T || defaultControlT;
  var title, when, verdict;
  var link = function (href, text) { return '<a href="' + href + '">' + cEsc(text) + '</a>'; };
  if (m.kind === "needs") {
    title = T("panel.heroStopped", { time: m.auth && m.auth.t != null ? cHM(m.auth.t, lang) : "?" });
    when = T("panel.whenStopped", { when: m.auth && m.auth.t != null ? cAt(m.auth.t, m.now, T, lang) : "" });
    verdict = '<div class="verdict__state verdict__state--crit">' + cIcon("alert") + cEsc(T("panel.verdictNeeds")) + '</div><p>' + cEsc(T("panel.verdictNeedsText", { n: m.paused.length })) + '</p>' + link("#provider", T("panel.verdictNeedsLink"));
  } else if (m.kind === "setup") {
    title = T("panel.heroSetup");
    when = T("panel.whenSetup");
    verdict = '<div class="verdict__state">' + cEsc(T("panel.verdictSetup")) + '</div><p>' + cEsc(T("panel.verdictSetupText")) + '</p>' + link("#provider", T("panel.verdictSetupLink"));
  } else if (m.kind === "unreachable") {
    title = T("panel.heroUnreachable");
    when = T("panel.whenSetup");
    verdict = '<div class="verdict__state verdict__state--crit">' + cIcon("alert") + cEsc(T("panel.verdictNeeds")) + '</div><p>' + cEsc(T("panel.verdictUnreachableText", { error: m.mm.error || "?" })) + '</p>' + link("#settings", T("panel.serverTitle"));
  } else {
    title = m.tidied > 0 ? T("panel.heroTidied", { n: m.tidied }) : T("panel.heroQuiet");
    when = m.lastPass != null ? T("panel.whenWeek", { when: cWhen(m.lastPass, m.now, lang) }) : T("panel.whenWeekNoScan");
    verdict = '<div class="verdict__state verdict__state--ok">' + cIcon("check", 18, 2.6) + cEsc(T("panel.verdictOk")) + '</div><p>' +
      cEsc(m.nextPass != null ? T("panel.verdictOkText", { when: cWhen(m.nextPass, m.now, lang) }) : T("panel.verdictOkTextNoNext")) + '</p>' +
      (m.review ? link("#issues", T("panel.verdictOkLink", { n: m.review })) : "");
  }
  var wk = m.weekly || {};
  var tally = m.kind === "ok" || m.kind === "needs"
    ? '<div class="hero__tally">' +
      '<span>' + cDot("split") + cEsc(T("panel.tallySplit", { n: wk.notesSplit || 0 })) + '</span>' +
      '<span>' + cDot("structure") + cEsc(T("panel.tallyFixes", { n: wk.structureFixes || 0 })) + '</span>' +
      '<span>' + cDot("archive") + cEsc(T("panel.tallyArchived", { n: wk.sectionsArchived || 0 })) + '</span></div>'
    : "";
  var strip = "";
  if (m.up && m.anyOn) {
    strip = '<div class="strip"><div class="chartbox" data-chart="strip"></div><div class="strip__legend">' +
      m.workers.filter(function (w) { return w.on; }).map(function (w) { return '<span>' + cDot(w.id) + cEsc(T(w.name)) + '</span>'; }).join("") +
      '<span><i class="sw" aria-hidden="true"></i>' + cEsc(T("panel.legendNight")) + '</span>' +
      (m.paused.length ? '<span><i class="ring" aria-hidden="true"></i>' + cEsc(T("panel.legendError")) + '</span>' : "") + '</div></div>';
  }
  return '<div class="hero hero--' + m.kind + '"><div class="hero__grid"><div>' +
    '<p class="hero__when">' + cIcon("moon", 15, 2) + '<span>' + cEsc(when) + '</span></p>' +
    '<h1 id="heroTitle">' + cEsc(title) + '</h1>' + tally + '</div>' +
    '<div class="verdict">' + verdict + '</div></div>' + strip + '</div>';
}

/** The three summary cards under the first screen; each one leads to its section. */
function controlRenderVitals(m, T, lang) {
  T = T || defaultControlT;
  var on = m.workers.filter(function (w) { return w.on; });
  var wv = !on.length ? T("panel.workersOff") : m.paused.length ? T("panel.workersPaused", { n: m.paused.length, total: on.length }) : T("panel.workersRunning", { n: on.length, total: on.length });
  var chips = m.workers.map(function (w) {
    return cChip(!w.on ? "off" : w.err ? "crit" : "ok", cDot(w.id) + cEsc(T(w.name)));
  }).join("");
  var pv, ps;
  if (m.provState === "auth") { pv = m.prov ? cProvLabel(m.prov.id, T) : T("panel.verdictNeeds"); ps = T("panel.provSubAuth", { time: m.auth.t != null ? cHM(m.auth.t, lang) : "?" }); }
  else if (m.provState === "none") { pv = T("panel.provNone"); ps = T("panel.provSubNone"); }
  else { pv = cProvLabel(m.prov.id, T); ps = T(m.prov.id === "claude-code" ? "panel.provSubNoKeyNeeded" : m.provState === "nokey" ? "panel.provSubNoKey" : "panel.provSubOk", { model: m.prov.model || "?" }); }
  var hasSavings = m.saved7 > 0 || m.saved30 > 0;
  return '<div class="vitals">' +
    '<a class="card vital" href="#savings"><span class="vital__k">' + cEsc(T("panel.vitalSaved")) + '</span>' +
    '<span class="vital__v num">' + (hasSavings ? "≈ " + cEsc(cNum(m.saved7, lang)) : "0") + '</span>' +
    '<div class="chartbox" data-chart="spark"></div>' +
    '<span class="vital__s">' + cEsc(hasSavings ? T("panel.vitalSaved30", { n: cNum(m.saved30, lang) }) : T("panel.vitalSavedNone")) + '</span></a>' +
    '<a class="card vital" href="#maintenance"><span class="vital__k">' + cEsc(T("panel.vitalWorkers")) + '</span>' +
    '<span class="vital__v">' + cEsc(wv) + '</span><div class="chips">' + chips + '</div></a>' +
    '<a class="card vital" href="#provider"><span class="vital__k">' + cEsc(T("panel.vitalProvider")) + '</span>' +
    '<span class="vital__v' + (m.provState === "auth" ? " vital__v--crit" : "") + '">' + cEsc(pv) + '</span><span class="vital__s">' + cEsc(ps) + '</span></a></div>';
}

/** The week as a ledger: one line per figure of the weekly report, with its seven daily bars. */
function controlRenderLedger(m, T, lang) {
  T = T || defaultControlT;
  var wk = m.weekly || { notesSplit: 0, structureFixes: 0, structureFixesByKind: {}, sectionsArchived: 0, duplicatesFound: 0, aiCalls: 0, cachedVerdicts: 0, errors: 0 };
  var days = m.days || [];
  var series = function (k) { return days.map(function (d) { return d[k] || 0; }); };
  var rules = Object.keys(wk.structureFixesByKind || {}).sort();
  var rows = [
    { w: "split", n: wk.notesSplit, l: "panel.ledgerSplit", sub: T("panel.ledgerSplitSub"), d: series("notesSplit") },
    { w: "structure", n: wk.structureFixes, l: "panel.ledgerFixes", sub: rules.length ? T("panel.ledgerFixesByRule", { list: rules.map(function (r) { return r + " " + wk.structureFixesByKind[r]; }).join(", ") }) : T("panel.ledgerFixesSub"), d: series("structureFixes") },
    { w: "archive", n: wk.sectionsArchived, l: "panel.ledgerArchived", sub: T("panel.ledgerArchivedSub"), d: series("sectionsArchived") },
    { n: wk.duplicatesFound, l: "panel.ledgerDuplicates", sub: T("panel.ledgerDuplicatesSub"), d: null },
    { n: wk.aiCalls, l: "panel.ledgerAi", sub: T("panel.ledgerAiSub"), d: series("aiCalls"), c: "var(--ink-3)" },
    { n: wk.cachedVerdicts, l: "panel.ledgerCached", sub: T("panel.ledgerCachedSub"), d: series("cachedVerdicts"), c: "var(--ink-3)" },
    { n: wk.errors, l: "panel.ledgerErrors", sub: T(wk.errors ? "panel.ledgerErrorsSome" : "panel.ledgerErrorsNone"), d: series("errors"), c: "var(--crit)", crit: wk.errors > 0 },
  ];
  return '<ul class="ledger">' + rows.map(function (r) {
    var bars = r.d && r.d.length ? controlMiniBars(r.d, r.c || "var(--w-" + r.w + ")", T("panel.ledgerBarsAria", { list: r.d.join(", ") })) : '<span class="mini" aria-hidden="true"></span>';
    return '<li><span class="ledger__l">' + (r.w ? cDot(r.w) : '<i class="gl gl--none" aria-hidden="true"></i>') + '<span>' + cEsc(T(r.l)) + '<span class="ledger__sub">' + cEsc(r.sub) + '</span></span></span>' +
      '<span class="ledger__n num' + (r.crit ? " ledger__n--crit" : "") + '">' + cEsc(cNum(r.n || 0, lang)) + '</span>' + bars + '</li>';
  }).join("") + '</ul>';
}

var ISSUES_SHOWN = 6;
/** "Needs your eye": a refused key first, then what the structure audit will not fix alone. */
function controlRenderIssues(m, T, lang) {
  T = T || defaultControlT;
  var items = [];
  if (m.auth) {
    items.push('<li class="issue issue--crit"><span class="issue__bar" aria-hidden="true"></span><div><h4>' + cEsc(T("panel.issueAuthTitle", { n: m.paused.length })) + '</h4><p>' +
      cEsc(cSentence(m.auth.message)) + '</p></div><div class="issue__acts"><a class="btn btn--danger-solid" href="#provider">' + cEsc(T("panel.bannerAuthBtn")) + '</a></div></li>');
  }
  m.issues.forEach(function (it) {
    var k = "panel.rule." + it.rule, title = T(k);
    if (title === k) title = T("panel.rule.other");
    items.push('<li class="issue issue--' + (it.fixable ? "auto" : "warn") + '"><span class="issue__bar" aria-hidden="true"></span><div><h4>' + cEsc(title) + '</h4><p><b>' + cEsc(it.note) + '</b>' + (it.detail ? " " + cEsc(it.detail) : "") + '</p></div>' +
      '<div class="issue__acts"><span class="tag">' + cEsc(it.rule || "?") + '</span>' + cChip(it.fixable ? "" : "warn", cEsc(T(it.fixable ? "panel.issueFixable" : "panel.issueReview"))) + '</div></li>');
  });
  if (m.suggestions) {
    items.push('<li class="issue issue--auto"><span class="issue__bar" aria-hidden="true"></span><div><h4>' + cEsc(T("panel.issueSuggestions", { n: m.suggestions })) + '</h4></div>' +
      '<div class="issue__acts"><a class="btn" href="/">' + cEsc(T("panel.issueSuggestionsLink")) + '</a></div></li>');
  }
  if (!items.length) return '<p class="empty">' + cIcon("check", 18, 2.4) + '<span>' + cEsc(T("panel.issuesEmpty")) + '</span></p>';
  var head = items.slice(0, ISSUES_SHOWN), rest = items.slice(ISSUES_SHOWN);
  return '<ul class="issues">' + head.join("") + '</ul>' +
    (rest.length ? '<details class="more" data-keep="issues-more"><summary>' + cEsc(T("panel.issuesMore", { n: rest.length })) + '</summary><ul class="issues">' + rest.join("") + '</ul></details>' : "");
}

/** One card per worker: state, the error in plain words, its AI, last and next pass, queue, last events. */
function controlRenderWorkers(m, T, lang) {
  T = T || defaultControlT;
  return '<div class="workers">' + m.workers.map(function (w) {
    var state = !w.on ? cChip("off", cEsc(T("panel.statusOff"))) : w.err ? cChip("crit", cEsc(T("panel.statusPaused"))) : cChip("ok", cEsc(T("panel.statusRunning")));
    var err = w.on && w.err
      ? '<p class="werr"><b>' + cEsc(T("panel.workerStopped", { when: w.err.t != null ? cAt(w.err.t, m.now, T, lang) : "" })) + '</b> ' + cEsc(T("panel.workerStoppedRest", { message: cSentence(w.err.message) })) + ' <a href="#provider">' + cEsc(T("panel.bannerAuthBtn")) + '</a></p>' : "";
    var kv = "";
    if (w.on) {
      var ai = w.provider ? cProvLabel(w.provider, T) + (w.model ? ", " + w.model : "") : T("panel.kvAiNone");
      var queue = w.id === "split" ? T("panel.queueSplit", { n: w.pending || 0 }) : w.id === "structure" ? T("panel.queueStructure", { n: w.issues || 0, review: w.needsReview || 0 }) : T("panel.queueArchive", { n: w.keepDays || "?" });
      kv = '<dl class="kv"><dt>' + cEsc(T("panel.kvAi")) + '</dt><dd>' + cEsc(ai) + '</dd>' +
        '<dt>' + cEsc(T("panel.kvLast")) + '</dt><dd>' + cEsc(w.last != null ? cWhen(w.last, m.now, lang) + ", " + controlAgo(m.now - w.last, T) : T("panel.never")) + '</dd>' +
        '<dt>' + cEsc(T("panel.kvNext")) + '</dt><dd>' + cEsc(w.err ? T("panel.nextAfterFix") : w.next != null ? cWhen(w.next, m.now, lang) : T("panel.nextUnknown")) + '</dd>' +
        '<dt>' + cEsc(T("panel.kvQueue")) + '</dt><dd>' + cEsc(queue) + '</dd></dl>';
    }
    var shown = w.events.filter(function (e) { return e.cls !== "minor"; }).slice(-3).reverse();
    var evs = w.on ? '<ul class="events">' + (shown.length ? shown.map(function (e) {
      return '<li' + (e.cls === "err" ? ' class="events__err"' : "") + '><time>' + cEsc(cWhen(e.t, m.now, lang)) + '</time><span>' + cEsc(cEventText(e, T)) + '</span></li>';
    }).join("") : '<li class="events__none">' + cEsc(T("panel.noEvents")) + '</li>') + '</ul>' : "";
    return '<article class="card worker' + (w.on ? "" : " worker--off") + '" data-worker="' + w.id + '"><div class="worker__head"><span class="worker__icon" style="--wc:var(--w-' + w.id + ')">' + cIcon(w.icon, 18, 2) + '</span><h4>' + cEsc(T(w.name)) + '</h4>' + state + '</div>' +
      '<p class="worker__desc">' + cEsc(T(w.desc)) + '</p>' + err + kv + evs + '</article>';
  }).join("") + '</div>';
}

function controlRenderMaintenance(m, T, lang) {
  T = T || defaultControlT;
  var lanes = !m.up ? "" : !m.hasEvents
    ? '<p class="empty empty--soft">' + cEsc(T("panel.lanesUnavailable")) + '</p>'
    : m.workers.some(function (w) { return w.events.length; })
      ? '<div class="chartbox" data-chart="lanes"></div>'
      : '<p class="empty empty--soft">' + cEsc(T("panel.lanesEmpty")) + '</p>';
  var top = m.up && m.anyOn
    ? '<div class="card"><div class="card__head"><h3>' + cEsc(T("panel.lanesTitle")) + '</h3><span class="hint">' + cEsc(T("panel.lanesHint")) + '</span></div>' + lanes + '</div>' +
      '<div class="card card--gap"><div class="card__head"><h3>' + cEsc(T("panel.ledgerTitle")) + '</h3></div>' + controlRenderLedger(m, T, lang) + '</div>'
    : "";
  return '<section class="block" id="maintenance" aria-labelledby="mTitle"><div class="block__head"><h2 id="mTitle">' + cEsc(T("panel.maintTitle")) + '</h2><p>' + cEsc(T("panel.maintIntro")) + '</p></div>' + top +
    '<div class="card__head card__head--loose" id="issues"><h3>' + cEsc(T("panel.issuesTitle")) + '</h3><span class="hint">' + cEsc(T("panel.issuesHint")) + '</span></div>' + controlRenderIssues(m, T, lang) +
    controlRenderWorkers(m, T, lang) + '</section>';
}

function cRank(rows, T, lang, neutral) {
  var mx = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
  return '<ul class="rank' + (neutral ? " rank--neutral" : "") + '">' + rows.map(function (r) {
    return '<li><span class="rank__l">' + cEsc(r.label) + (r.calls != null ? '<span class="rank__sub">' + cEsc(T("panel.rankCalls", { n: r.calls })) + '</span>' : "") + '</span>' +
      '<span class="rank__track"><span class="rank__bar" style="width:' + Math.max(1.5, r.v / mx * 100).toFixed(1) + '%"></span></span><span class="rank__v num">' + cEsc(cCompact(r.v, lang)) + '</span></li>';
  }).join("") + '</ul>';
}
function cLeverName(key, T) {
  var k = "panel.lever." + key, v = T(k);
  return v === k ? key : v;
}

/** Savings: the total, the days, the levers that earn it, and what a session start costs. */
function controlRenderSavings(m, T, lang) {
  T = T || defaultControlT;
  var ct = m.clientTokens || {}, byLever = ct.byLever || {}, byClient = ct.byClient || {}, ss = ct.sessionStart || null;
  var levers = Object.keys(byLever).map(function (k) { return { label: cLeverName(k, T), v: Number(byLever[k].tokens) || 0, calls: Number(byLever[k].calls) || 0 }; }).sort(function (a, b) { return b.v - a.v; });
  var clients = Object.keys(byClient).map(function (k) { return { label: k, v: Number(byClient[k].tokens) || 0, calls: Number(byClient[k].calls) || 0 }; }).sort(function (a, b) { return b.v - a.v; });
  var calls7 = clients.reduce(function (a, r) { return a + r.calls; }, 0);
  var has = m.saved7 > 0 || m.saved30 > 0 || levers.length || clients.length;
  var out = '<section class="block" id="savings" aria-labelledby="sTitle"><div class="block__head"><h2 id="sTitle">' + cEsc(T("panel.savingsTitle")) + '</h2><p>' + cEsc(T("panel.savingsIntro")) + '</p></div>';
  if (!has) out += '<p class="empty">' + cEsc(T("panel.savingsEmpty")) + '</p>';
  else {
    var sessions = ss && ss.total > 0 ? Math.round(m.saved7 / ss.total) : 0;
    out += '<div class="savehero"><div class="card"><p class="muted">' + cEsc(T("panel.savedWeek")) + '</p><p class="big num">≈ ' + cEsc(cNum(m.saved7, lang)) + '</p><p class="faint small">' + cEsc(T("panel.savedUnit")) + '</p>' +
      '<dl class="equiv"><div><dt>' + cEsc(T("panel.saved30")) + '</dt><dd class="num">≈ ' + cEsc(cNum(m.saved30, lang)) + '</dd></div>' +
      (sessions ? '<div><dt>' + cEsc(T("panel.savedSessions")) + '</dt><dd class="num">' + cEsc(cNum(sessions, lang)) + ' ×</dd></div>' : "") +
      (calls7 ? '<div><dt>' + cEsc(T("panel.savedCalls")) + '</dt><dd class="num">' + cEsc(cNum(calls7, lang)) + '</dd></div>' : "") + '</dl></div>' +
      '<div class="card"><div class="card__head"><h3>' + cEsc(T("panel.perDayTitle")) + '</h3><span class="hint">' + cEsc(T("panel.perDayHint")) + '</span></div><div class="chartbox" data-chart="bars"></div></div></div>';
    if (levers.length || clients.length) {
      out += '<div class="split2 split2--even">' +
        (levers.length ? '<div class="card"><div class="card__head"><h3>' + cEsc(T("panel.byLeverTitle")) + '</h3></div>' + cRank(levers, T, lang, false) + '</div>' : "") +
        (clients.length ? '<div class="card"><div class="card__head"><h3>' + cEsc(T("panel.byClientTitle")) + '</h3></div>' + cRank(clients, T, lang, true) + '</div>' : "") + '</div>';
    }
  }
  // The measured session-start cost: memory_core + tools/list, averaged over what was served.
  out += '<div class="card session"><div class="session__text"><h3>' + cEsc(T("panel.sessionTitle")) + '</h3><p class="muted small">' + cEsc(T("panel.sessionIntro")) + '</p></div>';
  if (ss && ss.total > 0) {
    var pc = Math.round(ss.memoryCoreAvg / ss.total * 100);
    out += '<div class="session__fig"><p class="session__total num">' + cEsc(T("panel.sessionTotal", { n: cNum(ss.total, lang) })) + '</p>' +
      '<div class="stack" aria-hidden="true"><span class="stack__a" style="width:' + pc + '%"></span><span class="stack__b" style="width:' + (100 - pc) + '%"></span></div>' +
      '<ul class="stack__legend"><li><i class="sq sq--a" aria-hidden="true"></i><span>' + cEsc(T("panel.sessionCore")) + '</span><b class="num">≈ ' + cEsc(cNum(ss.memoryCoreAvg, lang)) + '</b><span class="faint">' + cEsc(T("panel.sessionServed", { n: ss.memoryCoreServed || 0 })) + '</span></li>' +
      '<li><i class="sq sq--b" aria-hidden="true"></i><span>' + cEsc(T("panel.sessionTools")) + '</span><b class="num">≈ ' + cEsc(cNum(ss.toolsListAvg, lang)) + '</b><span class="faint">' + cEsc(T("panel.sessionServed", { n: ss.toolsListServed || 0 })) + '</span></li></ul></div>';
  } else out += '<p class="empty empty--soft session__fig">' + cEsc(T("panel.sessionEmpty")) + '</p>';
  return out + '</div></section>';
}

/** The AI the workers use: key set / key refused / no key / no provider. Never the key itself. */
function controlRenderProvider(m, T, lang) {
  T = T || defaultControlT;
  var st = m.provState, line;
  if (st === "auth") {
    line = '<div class="statusline statusline--crit" role="alert">' + cIcon("alert", 20, 2.4) + '<div class="statusline__t"><b>' + cEsc(T("panel.provAuthTitle", { when: m.auth.t != null ? cAt(m.auth.t, m.now, T, lang) : "" })) + '</b><span>' + cEsc(T("panel.provAuthText", { message: cSentence(m.auth.message) })) + '</span></div></div>';
  } else if (st === "none") {
    line = '<div class="statusline"><div class="statusline__t"><b>' + cEsc(T("panel.provNoneTitle")) + '</b><span>' + cEsc(T("panel.provNoneText")) + '</span></div></div>';
  } else if (st === "nokey") {
    line = '<div class="statusline statusline--warn">' + cIcon("warn", 20, 2) + '<div class="statusline__t"><b>' + cEsc(T("panel.provNoKeyTitle")) + '</b><span>' + cEsc(T("panel.provNoKeyText")) + '</span></div></div>';
  } else {
    line = '<div class="statusline statusline--ok"><span class="pulse" aria-hidden="true"></span><div class="statusline__t"><b>' + cEsc(T(m.prov.id === "claude-code" ? "panel.provOkTitleNoKey" : "panel.provOkTitle")) + '</b><span>' + cEsc(T("panel.provOkText")) + '</span></div></div>';
  }
  var kv = "";
  if (m.prov) {
    var key = m.prov.id === "claude-code" ? T("panel.keyNotNeeded") : st === "auth" ? T("panel.provSubAuth", { time: m.auth.t != null ? cHM(m.auth.t, lang) : "?" }) : m.prov.keySet ? T("panel.keySet") : T("panel.keyNotSet");
    kv = '<dl class="kv kv--wide"><dt>' + cEsc(T("panel.kvProvider")) + '</dt><dd>' + cEsc(cProvLabel(m.prov.id, T)) + '</dd><dt>' + cEsc(T("panel.kvModel")) + '</dt><dd>' + cEsc(m.prov.model || "?") + '</dd>' +
      '<dt>' + cEsc(T("panel.kvKey")) + '</dt><dd' + (st === "auth" ? ' class="crit"' : "") + '>' + cEsc(key) + '</dd>' +
      '<dt>' + cEsc(T("panel.kvUsedBy")) + '</dt><dd>' + m.workers.filter(function (w) { return m.prov.usedBy.indexOf(w.id) >= 0; }).map(function (w) { return cChip(w.err ? "crit" : "", cDot(w.id) + cEsc(T(w.name))); }).join(" ") + '</dd></dl>';
  }
  var a = m.assistant, def = a && a.providers ? a.providers.filter(function (p) { return p.id === a.provider; })[0] : null;
  var assistant = a ? '<div class="card assistant"><div><h3>' + cEsc(T("panel.assistantTitle")) + '</h3><p class="muted small">' +
    cEsc(a.enabled ? T("panel.assistantOn", { provider: def ? def.label : a.provider }) : T("panel.assistantOff")) + '</p></div>' +
    '<a class="btn" href="/#ai-settings">' + cEsc(T("panel.assistantOpen")) + '</a></div>' : "";
  return '<section class="block" id="provider" aria-labelledby="pTitle"><div class="block__head"><h2 id="pTitle">' + cEsc(T("panel.providerTitle")) + '</h2><p>' + cEsc(T("panel.providerIntro")) + '</p></div>' +
    '<div class="card provider provider--' + st + '">' + line + kv + '<p class="how">' + cEsc(T("panel.provHow")) + '</p></div>' + assistant + '</section>';
}

/**
 * One lever row: a real switch, saved at once (PUT /api/setup, `proxy`), with where its value
 * comes from: Default, Changed here (with "Reset to default"), From memglow.config.json, or
 * Locked by MEMGLOW_… (disabled: the page can never override an environment variable).
 * `vals` (optional): what the switches hold right now, kept across a redraw.
 */
function controlLeverRow(l, T, vals, saved, lang) {
  T = T || defaultControlT;
  var checked = vals && Object.prototype.hasOwnProperty.call(vals, l.key) ? !!vals[l.key] : !!l.value;
  var help = T("control.lever." + l.key);
  if (help === "control.lever." + l.key) { help = T("panel.leverHelp." + l.key); if (help === "panel.leverHelp." + l.key) help = ""; }
  var badge = l.envLocked ? '<span class="src src--lock">' + cEsc(T("control.locked", { name: l.env || "" })) + '</span>'
    : l.source === "page" ? '<span class="src src--changed">' + cEsc(T("panel.badgeChanged")) + '</span>'
    : l.source === "file" ? '<span class="src">' + cEsc(T("panel.badgeFile")) + '</span>'
    : '<span class="src">' + cEsc(T("panel.badgeDefault")) + '</span>';
  var reset = !l.envLocked && l.source !== "default"
    ? '<button type="button" class="btn btn--quiet btn--tiny" data-reset-lever="' + cEsc(l.key) + '">' + cEsc(T("control.resetToDefault")) + '</button>' : "";
  var gain = saved && saved[l.key] && saved[l.key].tokens > 0 ? '<span class="lever__save num">' + cEsc(T("panel.leverSaved", { n: cCompact(saved[l.key].tokens, lang) })) + '</span>' : "";
  var id = "lv-" + cEsc(l.key);
  return '<li class="lever" data-lever="' + cEsc(l.key) + '"><div class="lever__t"><label for="' + id + '">' + cEsc(cLeverName(l.key, T)) + '</label>' + badge + reset + gain + '</div>' +
    '<span class="switch"><input type="checkbox" id="' + id + '" data-lever="' + cEsc(l.key) + '"' + (checked ? " checked" : "") + (l.envLocked ? " disabled" : "") + '><span aria-hidden="true"></span></span>' +
    '<p>' + cEsc(help) + ' <code>' + cEsc(l.key) + '</code></p></li>';
}

/** The levers: the day-one ones first, the rest folded under "Advanced levers (n)". */
function controlRenderLevers(proxy, T, vals, saved, lang) {
  T = T || defaultControlT;
  var levers = (proxy && proxy.levers) || [], caps = (proxy && proxy.caps) || [];
  var day1 = levers.filter(function (l) { return l.day1; }), rest = levers.filter(function (l) { return !l.day1; });
  var row = function (l) { return controlLeverRow(l, T, vals, saved, lang); };
  var out = '<ul class="levers">' + day1.map(row).join("") + '</ul>';
  if (rest.length) out += '<details class="adv" data-keep="levers-adv"><summary>' + cEsc(T("panel.leversAdvanced", { n: rest.length })) + '</summary><ul class="levers">' + rest.map(row).join("") + '</ul></details>';
  if (caps.length) {
    out += '<details class="adv" data-keep="levers-caps"><summary>' + cEsc(T("panel.capsTitle")) + '</summary><ul class="caps">' + caps.map(function (c) {
      return '<li><code>' + cEsc(c.key) + '</code><b class="num">' + cEsc(c.value) + '</b><span class="src' + (c.envLocked ? " src--lock" : "") + '">' + cEsc(controlSourceText(c, T)) + '</span></li>';
    }).join("") + '</ul></details>';
  }
  return out;
}

/**
 * What the lever switches hold right now → { key: boolean } (disabled/locked ones excluded).
 * With `effectiveByKey` ({ key: current effective boolean }), only the keys whose switch DIFFERS
 * from that value are included: saving must never pin every lever as "changed here" just because
 * the page renders all of them. Without it, every enabled switch is included.
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

// The "tuning" fields of the schedule card, [key, i18n label key, min, max].
var MAINT_TUNING_FIELDS = [
  // Capped at 168 h (one week): above 2^31-1 ms Node clamps a timer to 1 ms (lib/setup.js TUNING).
  ["maintenanceEveryHours", "control.maintEveryHoursLabel", 0, 168],
  ["archiveAfterDays", "control.archiveAfterDaysLabel", 7, 3650],
  ["indexTrimMaxChars", "control.indexTrimMaxCharsLabel", 30, 1000],
  ["indexWarningTokens", "control.indexWarningTokensLabel", 100, 1000000],
  ["sessionsPerDay", "control.sessionsPerDayLabel", 1, 1000],
];

/** The schedule card: five numbers (PUT /api/setup, `tuning`) and "Run now" (POST /api/maintenance/run). */
function controlRenderSchedule(tuning, T, vals) {
  T = T || defaultControlT;
  tuning = tuning || {};
  var locked = tuning.locked || {};
  return '<form id="mg-control-maint-form" class="fields">' + MAINT_TUNING_FIELDS.map(function (f) {
    var key = f[0], v = vals && Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : tuning[key], lock = locked[key];
    return '<label class="field"><span>' + cEsc(T(f[1])) + (lock ? ' <span class="src src--lock">' + cEsc(T("control.locked", { name: lock })) + '</span>' : "") + '</span>' +
      '<input type="number" data-maint="' + cEsc(key) + '" min="' + f[2] + '" max="' + f[3] + '" step="1" inputmode="numeric" value="' + cEsc(v == null ? "" : v) + '"' + (lock ? " disabled" : "") + '></label>';
  }).join("") +
    '<div class="btns"><button type="submit" class="btn btn--primary">' + cEsc(T("aiset.save")) + '</button><button type="button" class="btn" id="mg-control-run-now">' + cEsc(T("control.runNow")) + '</button></div>' +
    '<p class="status" id="mg-control-maint-status" role="status"></p></form>';
}

/** What the schedule inputs hold right now → { key: number } (disabled/locked excluded). */
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

/** The memory server's own /healthz in one line, never a secret; the fsync mode as a badge. */
function controlRenderMemoryServer(ms, T) {
  T = T || defaultControlT;
  if (!ms || !ms.configured) return '<p class="line">' + cEsc(T("control.memoryServerOff")) + '</p>';
  if (!ms.ok) return '<p class="line line--bad">' + cEsc(T("control.memoryServerError", { error: ms.error || "?" })) + '</p>';
  var mode = T(ms.readOnly === false ? "control.memoryServerReadWrite" : "control.memoryServerReadOnly");
  var tok = T(ms.tokenRequired ? "control.memoryServerTokenYes" : "control.memoryServerTokenNo");
  var fsb = ms.fsyncMode === "sync" || ms.fsyncMode === "deferred" || ms.fsyncMode === "none"
    ? ' <span class="src" data-fsync-mode="' + cEsc(ms.fsyncMode) + '">' + cEsc(T("control.memoryServerFsync", { mode: ms.fsyncMode })) + '</span>' : "";
  return '<p class="line">' + cEsc(T("control.memoryServerOk", { mode: mode, notes: ms.notes != null ? ms.notes : "?", version: ms.version || "?" })) + ' · ' + cEsc(tok) + fsb + "</p>";
}

/** Danger zone: two real, irreversible-enough actions, each confirmed in its own row. */
function controlRenderDanger(m, T) {
  T = T || defaultControlT;
  var changed = ((m.proxy && m.proxy.levers) || []).filter(function (l) { return !l.envLocked && l.source === "page"; });
  var keys = ((m.assistant && m.assistant.providers) || []).filter(function (p) { return p.key === "set" && p.keySource === "page"; });
  var row = function (id, title, text, btn, confirm, extra, disabled) {
    return '<div class="drow"><div><b>' + cEsc(title) + '</b><p>' + cEsc(text) + '</p></div>' +
      '<button type="button" class="btn btn--danger" data-dz="' + id + '"' + (disabled ? " disabled" : "") + '>' + cEsc(btn) + '</button>' +
      '<div class="confirm" data-confirm="' + id + '" hidden><span>' + cEsc(confirm) + '</span><button type="button" class="btn" data-dz-cancel="' + id + '">' + cEsc(T("panel.cancel")) + '</button>' +
      '<button type="button" class="btn btn--danger-solid" data-dz-ok="' + id + '"' + (extra || "") + '>' + cEsc(btn) + '</button></div>' +
      '<p class="status" role="status" data-dz-status="' + id + '"></p></div>';
  };
  var out = '<div class="danger"><h3>' + cEsc(T("panel.dangerTitle")) + '</h3>' +
    row("levers", T("panel.dangerResetTitle"), changed.length ? T("panel.dangerResetText", { n: changed.length }) : T("panel.dangerResetNone"), T("panel.dangerResetBtn"), T("panel.dangerResetConfirm", { n: changed.length }), "", !changed.length);
  if (keys.length) keys.forEach(function (p) {
    out += row("key-" + p.id, T("panel.dangerKeyTitle"), T("panel.dangerKeyText", { provider: p.label }), T("panel.dangerKeyBtn"), T("panel.dangerKeyConfirm", { provider: p.label }), ' data-provider="' + cEsc(p.id) + '"', false);
  });
  else out += row("key", T("panel.dangerKeyTitle"), T("panel.dangerKeyNone"), T("panel.dangerKeyBtn"), "", "", true);
  return out + '</div>';
}

function controlRenderSettings(m, T, lang, vals) {
  T = T || defaultControlT;
  vals = vals || {};
  var saved = (m.clientTokens && m.clientTokens.byLever) || {};
  var seen = m.proxySeen ? T("control.proxySeen", { ago: controlAgo(m.now - m.proxySeen.t, T), ms: m.proxySeen.durationMs != null ? m.proxySeen.durationMs : "?" }) : T("control.proxyNeverSeen");
  return '<section class="block" id="settings" aria-labelledby="setTitle"><div class="block__head"><h2 id="setTitle">' + cEsc(T("panel.settingsTitle")) + '</h2><p>' + cEsc(T("panel.settingsIntro")) + '</p></div>' +
    '<div class="setgrid"><div class="card"><p class="restart" id="mg-control-restart" role="status"' + (vals.restart ? "" : " hidden") + '>' + cEsc(T("control.restartNotice")) + '</p>' +
    '<div class="card__head"><h3>' + cEsc(T("panel.leversTitle")) + '</h3><p class="status" id="mg-control-proxy-status" role="status"></p></div>' +
    '<form id="mg-control-proxy-form">' + controlRenderLevers(m.proxy, T, vals.proxy, saved, lang) + '</form></div>' +
    '<div class="setcol"><div class="card"><div class="card__head"><h3>' + cEsc(T("panel.scheduleTitle")) + '</h3></div>' + controlRenderSchedule(m.setup.tuning, T, vals.maint) + '</div>' +
    '<div class="card"><div class="card__head"><h3>' + cEsc(T("panel.serverTitle")) + '</h3></div>' + controlRenderMemoryServer(m.ms, T) + '<p class="line">' + cEsc(seen) + '</p></div>' +
    controlRenderDanger(m, T) + '</div></div></section>';
}

/** The whole page body from { setup, maintenance, cost, events }. `vals` (optional): { proxy,
 * maint, restart } — what the forms hold right now, kept across a redraw. */
function controlRender(data, T, vals, now, lang) {
  T = T || defaultControlT;
  var m = controlModel(data, now);
  return controlRenderBanner(m, T, lang) +
    '<section id="overview" aria-labelledby="heroTitle">' + controlRenderHero(m, T, lang) + controlRenderVitals(m, T, lang) + '</section>' +
    controlRenderMaintenance(m, T, lang) + controlRenderSavings(m, T, lang) + controlRenderProvider(m, T, lang) + controlRenderSettings(m, T, lang, vals) +
    '<p class="foot">' + cEsc(T("panel.foot")) + '</p>';
}

/** The pill in the top bar: is a memory server connected, and how. Never a secret. */
function controlServerPill(ms, T, lang) {
  T = T || defaultControlT;
  if (!ms || !ms.configured) return '<span class="pulse pulse--off" aria-hidden="true"></span><span>' + cEsc(T("panel.serverNone")) + '</span>';
  if (!ms.ok) return '<span class="pulse pulse--bad" aria-hidden="true"></span><span>' + cEsc(T("panel.serverOffline")) + '</span>';
  var mode = T(ms.readOnly === false ? "control.memoryServerReadWrite" : "control.memoryServerReadOnly");
  return '<span class="pulse" aria-hidden="true"></span><span>' + cEsc(T("panel.serverOnline")) + '</span><span class="server__more">' +
    cEsc(T("panel.serverMore", { mode: mode, version: ms.version || "?", notes: ms.notes != null ? cNum(ms.notes, lang) : "?" })) + '</span>';
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cEsc: cEsc, EN_CONTROL: EN_CONTROL, resolveTextControl: resolveTextControl, defaultControlT: defaultControlT,
    controlAgo: controlAgo, controlSourceText: controlSourceText, controlEventClass: controlEventClass, controlModel: controlModel,
    controlLanesSvg: controlLanesSvg, controlSparkSvg: controlSparkSvg, controlMiniBars: controlMiniBars, controlBarsSvg: controlBarsSvg,
    controlRenderBanner: controlRenderBanner, controlRenderHero: controlRenderHero, controlRenderVitals: controlRenderVitals,
    controlRenderLedger: controlRenderLedger, controlRenderIssues: controlRenderIssues, controlRenderWorkers: controlRenderWorkers,
    controlRenderMaintenance: controlRenderMaintenance, controlRenderSavings: controlRenderSavings, controlRenderProvider: controlRenderProvider,
    controlLeverRow: controlLeverRow, controlRenderLevers: controlRenderLevers, controlCollectProxy: controlCollectProxy,
    controlRenderSchedule: controlRenderSchedule, controlCollectMaintTuning: controlCollectMaintTuning,
    controlRenderMemoryServer: controlRenderMemoryServer, controlRenderDanger: controlRenderDanger, controlRenderSettings: controlRenderSettings,
    controlRender: controlRender, controlServerPill: controlServerPill,
  };
}

/* ============================== the page ============================== */
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var body = document.getElementById("ns-body");
  if (!body) return;
  var T = defaultControlT;
  var top = { server: document.getElementById("ns-server"), badge: document.getElementById("ns-badge"), lang: document.getElementById("ns-lang"), theme: document.getElementById("ns-theme") };
  var errBox = document.getElementById("ns-error"), errMsg = document.getElementById("ns-error-msg"), errBtn = document.getElementById("ns-error-btn");
  var tip = document.getElementById("ns-tip");
  var last = null;      // { setup, maintenance, cost, events }
  var model = null;
  var typed = {};       // { proxy, maint, restart }
  var REFRESH_MS = 60000;

  function get(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; throw e; }
      return r.json();
    });
  }
  function send(method, url, payload) {
    return fetch(url, {
      method: method, credentials: "same-origin",
      headers: payload === undefined ? { "X-Memglow": "1" } : { "Content-Type": "application/json", "X-Memglow": "1" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }
  function showError(err, retry) {
    var auth = err && (err.mgStatus === 401 || err.mgStatus === 403);
    errMsg.textContent = T(auth ? "error.unauthorized" : err && err.mgStatus ? "error.serverError" : "error.connectionLost");
    errBtn.textContent = T(auth || !retry ? "common.reload" : "common.retry");
    errBtn.onclick = auth || !retry ? function () { window.location.reload(); } : retry;
    errBox.hidden = false;
  }
  function sayAt(el, text, bad) {
    if (typeof el === "string") el = document.getElementById(el);
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("status--bad", !!bad);
  }
  function failText(err) {
    return T("setup.notSaved", { error: (err && err.body && err.body.error) || (err && err.mgStatus ? "HTTP " + err.mgStatus : T("error.connectionLost")) });
  }

  /* ---- drawing ---- */
  function drawCharts() {
    if (!model) return;
    var lang = controlLang();
    var each = function (name, fn) {
      Array.prototype.forEach.call(body.querySelectorAll('[data-chart="' + name + '"]'), function (el) {
        var w = el.clientWidth;
        if (w > 0) el.innerHTML = fn(w);
      });
    };
    var rows = model.workers.filter(function (w) { return w.on; });
    each("strip", function (w) {
      var has = rows.some(function (r) { return r.events.some(function (e) { return e.t >= model.now - 24 * 3600000; }); });
      return controlLanesSvg({ from: model.now - 24 * 3600000, to: model.now, w: w, workers: rows, compact: true, T: T, lang: lang, aria: T("panel.stripAria") }) +
        (has ? "" : '<p class="strip__empty">' + cEsc(T("panel.stripEmpty")) + '</p>');
    });
    each("lanes", function (w) { return controlLanesSvg({ from: model.now - 7 * 86400000, to: model.now, w: w, workers: rows, T: T, lang: lang, aria: T("panel.lanesAria") }); });
    each("spark", function (w) { var v = model.byDay.slice(-7).map(function (p) { return p.saved || 0; }); return v.some(Boolean) ? controlSparkSvg(v, w) : ""; });
    each("bars", function (w) { return controlBarsSvg(model.byDay, w, T, lang); });
  }
  function render() {
    var open = {};
    Array.prototype.forEach.call(body.querySelectorAll("details[data-keep]"), function (d) { open[d.getAttribute("data-keep")] = d.open; });
    model = controlModel(last);
    body.innerHTML = controlRender(last, T, typed, model.now, controlLang());
    Array.prototype.forEach.call(body.querySelectorAll("details[data-keep]"), function (d) { if (open[d.getAttribute("data-keep")]) d.open = true; });
    top.server.innerHTML = controlServerPill(model.ms, T, controlLang());
    top.badge.hidden = !model.waiting;
    top.badge.textContent = String(model.waiting);
    top.badge.className = "badge" + (model.auth ? " badge--crit" : "");
    top.badge.setAttribute("aria-label", T("panel.navBadge", { n: model.waiting }));
    document.documentElement.setAttribute("data-state", model.kind);
    drawCharts();
    hideTip();
  }
  function load(quiet) {
    return Promise.all([get("/api/setup"), get("/api/maintenance"), get("/api/cost"), get("/api/maintenance/events").catch(function () { return null; })]).then(function (r) {
      last = { setup: r[0], maintenance: r[1], cost: r[2], events: r[3] };
      errBox.hidden = true;
      render();
    }).catch(function (e) { if (!quiet || !last) showError(e, function () { load(false); }); });
  }
  /** A redraw would throw away a field being typed in or an open confirmation: wait for the next tick. */
  function busy() {
    var a = document.activeElement;
    if (a && body.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox") return true;
    return !!body.querySelector(".confirm:not([hidden])");
  }

  /* ---- tooltip (charts): text only, follows the pointer or sits on the focused mark ---- */
  function showTip(x, y, el) {
    tip.textContent = "";
    var b = document.createElement("b"); b.textContent = el.getAttribute("data-tip-t") || "";
    var s = document.createElement("span"); s.textContent = el.getAttribute("data-tip-b") || "";
    tip.appendChild(b); tip.appendChild(s);
    tip.hidden = false;
    var r = tip.getBoundingClientRect(), px = x + 14, py = y + 14;
    if (px + r.width > window.innerWidth - 8) px = Math.max(8, x - r.width - 14);
    if (py + r.height > window.innerHeight - 8) py = Math.max(8, y - r.height - 14);
    tip.style.left = px + "px"; tip.style.top = py + "px";
  }
  function hideTip() { tip.hidden = true; }
  var tipTarget = function (e) { return e.target && e.target.closest ? e.target.closest("[data-tip-t]") : null; };
  body.addEventListener("pointermove", function (e) { var n = tipTarget(e); if (n) showTip(e.clientX, e.clientY, n); else hideTip(); });
  body.addEventListener("pointerleave", hideTip);
  body.addEventListener("focusin", function (e) { var n = tipTarget(e); if (n) { var r = n.getBoundingClientRect(); showTip(r.right, r.top, n); } });
  body.addEventListener("focusout", hideTip);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTip(); });

  /* ---- levers: a switch saves at once ---- */
  function saveProxy(diff) {
    sayAt("mg-control-proxy-status", T("setup.saving"), false);
    return send("PUT", "/api/setup", { proxy: diff }).then(function (j) {
      last.setup = j; typed.proxy = null; typed.restart = true;
      render();
      sayAt("mg-control-proxy-status", T("setup.saved"), false);
    }).catch(function (err) { typed.proxy = null; render(); sayAt("mg-control-proxy-status", failText(err), true); });
  }
  body.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute("data-lever")) { var d = {}; d[t.getAttribute("data-lever")] = !!t.checked; saveProxy(d); }
    else if (t.getAttribute("data-maint")) typed.maint = controlCollectMaintTuning(body.querySelectorAll("input[data-maint]"));
  });
  body.addEventListener("submit", function (e) {
    e.preventDefault();
    var maint = e.target && e.target.closest ? e.target.closest("#mg-control-maint-form") : null;
    if (!maint) return;
    typed.maint = controlCollectMaintTuning(maint.querySelectorAll("input[data-maint]"));
    sayAt("mg-control-maint-status", T("setup.saving"), false);
    send("PUT", "/api/setup", { tuning: typed.maint }).then(function (j) {
      last.setup = j; typed.maint = null;
      render();
      sayAt("mg-control-maint-status", T("setup.saved"), false);
    }).catch(function (err) { sayAt("mg-control-maint-status", failText(err), true); });
  });
  body.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button, a[href^='#']") : null;
    if (!b) return;
    if (b.tagName === "A") {
      // In-page links: the sticky bar would hide the target's heading without scroll-margin (CSS).
      return;
    }
    var key = b.getAttribute("data-reset-lever");
    if (key) { var d = {}; d[key] = null; saveProxy(d); return; }
    if (b.id === "mg-control-run-now") {
      typed.maint = controlCollectMaintTuning(body.querySelectorAll("input[data-maint]"));
      sayAt("mg-control-maint-status", T("setup.saving"), false);
      send("POST", "/api/maintenance/run").then(function (j) {
        last.maintenance = j;
        render();
        sayAt("mg-control-maint-status", T("control.ranNow", { n: (j.items || []).length }), false);
      }).catch(function (err) { sayAt("mg-control-maint-status", failText(err), true); });
      return;
    }
    // Danger zone: the confirmation opens inside the row, never a browser dialog.
    var dz = b.getAttribute("data-dz"), cancel = b.getAttribute("data-dz-cancel"), ok = b.getAttribute("data-dz-ok");
    var q = function (sel) { return body.querySelector(sel); };
    if (dz) { var c = q('[data-confirm="' + dz + '"]'); c.hidden = false; b.hidden = true; q('[data-dz-cancel="' + dz + '"]').focus(); return; }
    if (cancel) { q('[data-confirm="' + cancel + '"]').hidden = true; var o = q('[data-dz="' + cancel + '"]'); o.hidden = false; o.focus(); return; }
    if (ok) {
      var st = q('[data-dz-status="' + ok + '"]');
      sayAt(st, T("setup.saving"), false);
      var done = function () { render(); sayAt(q('[data-dz-status="' + ok + '"]') || q('[data-dz-status="key"]'), T("panel.done"), false); };
      var fail = function (err) { q('[data-confirm="' + ok + '"]').hidden = true; q('[data-dz="' + ok + '"]').hidden = false; sayAt(st, failText(err), true); };
      if (ok === "levers") {
        var reset = {};
        ((model.proxy && model.proxy.levers) || []).forEach(function (l) { if (!l.envLocked && l.source === "page") reset[l.key] = null; });
        send("PUT", "/api/setup", { proxy: reset }).then(function (j) { last.setup = j; typed.proxy = null; typed.restart = true; done(); }).catch(fail);
      } else {
        var pid = b.getAttribute("data-provider");
        send("POST", "/api/setup/secret", { provider: pid, remove: true }).then(function () { return get("/api/setup"); }).then(function (j) { last.setup = j; done(); }).catch(fail);
      }
    }
  });

  /* ---- top bar: language, theme, current section ---- */
  if (top.lang) {
    top.lang.addEventListener("change", function () { if (window.MemglowI18n) window.MemglowI18n.setLanguage(top.lang.value); });
  }
  function applyTheme(v) {
    if (v === "light" || v === "dark") document.documentElement.setAttribute("data-theme", v);
    else document.documentElement.removeAttribute("data-theme");
  }
  if (top.theme) {
    try { top.theme.value = localStorage.getItem("memglow.panel.theme") || ""; } catch (e) { /* blocked storage */ }
    top.theme.addEventListener("change", function () {
      applyTheme(top.theme.value);
      try { localStorage.setItem("memglow.panel.theme", top.theme.value); } catch (e) { /* lost on reload only */ }
    });
  }
  document.addEventListener("memglow:language", function () {
    if (top.lang && window.MemglowI18n) top.lang.value = window.MemglowI18n.lang();
    document.title = (document.documentElement.getAttribute("data-title") || "memglow") + " · " + T("control.title");
    if (last) { typed.maint = controlCollectMaintTuning(body.querySelectorAll("input[data-maint]")); render(); }
  });
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a"));
  function spy() {
    var y = window.scrollY + 150, cur = 0;
    links.forEach(function (a, i) { var s = document.getElementById(a.getAttribute("href").slice(1)); if (s && s.getBoundingClientRect().top + window.scrollY <= y) cur = i; });
    links.forEach(function (a, i) { if (i === cur) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  }
  window.addEventListener("scroll", function () { hideTip(); spy(); }, { passive: true });
  var rt = null;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(drawCharts, 120); });

  var start = function () {
    load(false).then(function () {
      spy();
      // The viewer answers at once with what it knows; the memory server's own status is fetched
      // behind it. One early second look, then a quiet refresh every minute.
      setTimeout(function () { if (!busy()) load(true); }, 1500);
      setInterval(function () { if (!document.hidden && !busy()) load(true); }, REFRESH_MS);
    });
  };
  if (window.MemglowI18n && window.MemglowI18n.ready) window.MemglowI18n.ready(start); else start();
})();
