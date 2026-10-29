"use strict";
/**
 * MCP proxy levers — configuration (0.4.12.4 split of lib/proxy-levers.js, see that file's own
 * top comment for the full picture): the lever defaults and switches (DEFAULTS, proxyConfig,
 * anyLever) plus the small env/file-value helpers they are built from. See
 * lib/levers/control-panel.js for the read-only Settings → Control view of the same values.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const archive = require("../archive");
const defaultsLib = require("../defaults");

const DEFAULT_THEMES = [
  { id: "people", label: "People" }, { id: "projects", label: "Projects" }, { id: "knowledge", label: "Knowledge" },
  { id: "habits", label: "Habits & rules" }, { id: "archive", label: "Archive" },
];
// basic-memory 0.23's own ChatGPT-compatibility tools (src/basic_memory/mcp/tools/chatgpt_tools.py):
// `search` and `fetch` are always listed, but answer "Unsupported MCP client" to any caller whose
// clientInfo is not recognised as OpenAI's MCP client (client_info_is_openai_mcp(), client_info.py).
// "openai-mcp" is the exact label that client sends, not a product name like "ChatGPT".
const OPENAI_MCP_CLIENT_NAME = "openai-mcp";
const DEFAULT_UNSUPPORTED_TOOLS = {
  "basic-memory": { search: [OPENAI_MCP_CLIENT_NAME], fetch: [OPENAI_MCP_CLIENT_NAME] },
};
const DEFAULTS = {
  sizeWarning: true,
  indexWarning: false,
  // searchDetails and suggestions used to be ON by default. Measured with the free replay harness
  // (bench/replay.js) and against a real 2-day usage log (91 calls): both only ADD explanatory
  // text (never cut anything), the harness cannot credit the extra reads/searches they may avoid,
  // and on the real log `defaults` still cost MORE delivered tokens than `off` (+14%) even after
  // this stage's shortening (per-note description shown once per session, no teaser line at all
  // for a note already read in full this session — see handleSearch/handleRead below). sizeWarning
  // stays on: it is short (one line, once per note/session) and plausibly prevents a wasted call
  // (the model blindly reading, or growing, an oversized note) — exactly the "keep" case; the other
  // two are neither short nor shown to prevent a call, so stage 0.4.2.2 turns them OFF by default.
  // Both remain available (MEMGLOW_PROXY_SEARCH_DETAILS=1 / "proxy": {"suggestions": true}, …), now
  // cheaper than before for whoever opts in.
  searchDetails: false,
  suggestions: false,
  dedupe: false,
  toc: false,
  archiveHint: false,
  hideUnsupportedTools: false,
  alreadyLoaded: false,
  // Stage 0.4.3.1 ("never stub the injection hook"): a session whose `clientInfo.name`/`title`
  // (sent at `initialize`) contains one of these substrings, case-insensitively, never gets a
  // lever-8 stub nor any other alreadyLoaded rewrite — always the full text — regardless of rule
  // 2 below. This is what protects a SessionStart-style hook that reads the index to INJECT it:
  // if that read goes through this same proxy and gets stubbed, the session starts without the
  // index at all. MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT=a,b,c (comma-separated) / "proxy": {
  // "alreadyLoadedExemptClients": ["a", "b"] } — an empty array turns the exemption off entirely.
  alreadyLoadedExemptClients: ["hook", "inject", "session-start", "sessionstart", "memglow-init"],
  // Stage 0.4.3.1, rule 2 (generic safety, independent of clientInfo): lever 8 may stub a read
  // only once this session has made at least one OTHER tool call, or a tools/list, before it. An
  // injector characteristically reads the index as its very FIRST call right after `initialize`;
  // an assistant mid-conversation has almost always listed tools or made another call by the
  // time it re-reads the index. Checked against bench/replay.js (see CHANGELOG 0.4.3.1): 0
  // violations, identical calls/tokens to without it on every shipped replay file — none of them
  // model a read as literally the session's first message, so the rule never fires there and
  // never costs anything measured. Kept ON by default for the extra safety margin it gives
  // unnamed/unknown injector clients that rule 1's name list would miss.
  alreadyLoadedRequireActivity: true,
  // Stage 0.4.2.2b: measured with bench/replay.js (see bench/README.md and mcp-proxy/README.md).
  // replay-demo.jsonl has no consecutive-search bursts: 14 calls / 5288 tokens either way, no
  // change. replay-heavy.jsonl (after adding a few multi-search bursts) drops from 67 to 60
  // calls AND from 17581 to 16864 tokens with multiQuery on (alone: -717 tokens vs off) — fewer
  // calls, fewer tokens, 0 violations on both files — so it ships on by default.
  // MEMGLOW_PROXY_MULTI_QUERY=0 / "proxy": { "multiQuery": false } to turn it off.
  multiQuery: true,
  // Lever 10, re-decided at stage 0.4.2.5 ("count the turns"): bench/replay.js
  // (bench/replay-aliases.jsonl), --with aliases,learnAliases,-multiQuery vs off (see CHANGELOG
  // 0.4.2.4 and 0.4.2.5). 0 violations, hit rate 0/5 → 3/3 on the searches it targets, 2 retry
  // searches dropped as unnecessary (-2 calls), but RAW tokens were worse (758 → 783, +3.3%) —
  // which is why this lever shipped OFF at 0.4.2.4: the harness only scored tool-result tokens,
  // so a lever that trades a call for a few extra tokens always looked like a loss. 0.4.2.5 adds
  // an "effective tokens" column (= raw tokens + calls * a per-call turn overhead, conservatively
  // 5,000 — see bench/replay.js's DEFAULT_TURN_TOKENS for how that number was derived from real
  // bench/results/*.jsonl runs) and the merge rule "0 violations AND effective tokens <= off AND
  // (raw tokens <= off OR calls < off)": on replay-aliases.jsonl this lever's 2 fewer calls make
  // its effective tokens 70,783 vs off's 80,758 — a clear win — and it is a no-op (identical
  // calls and tokens to off) on both replay-demo.jsonl and replay-heavy.jsonl, which have no
  // miss-then-read-then-similar-search scenario to teach or use. The rule holds on all three
  // files, so this lever now ships ON by default; both remain under the `proxy` key, like every
  // other lever switch here: MEMGLOW_PROXY_ALIASES=0 / "proxy": { "aliases": false } turns
  // injection off; MEMGLOW_PROXY_LEARN_ALIASES=0 / "proxy": { "learnAliases": false } stops
  // recording aliases (0.4.2.3) — independent switches, see the module's top comment.
  aliases: true,
  learnAliases: true,
  // Levers 11-12, stage 0.4.2.6 ("negative cache + the index already answers") — both OFF by
  // default, decided by the SAME merge rule as lever 10 (bench/replay.js, 0 violations AND
  // effective tokens <= off AND (raw tokens <= off OR calls < off)), run `--each` on
  // bench/replay-demo.jsonl, bench/replay-heavy.jsonl, bench/replay-aliases.jsonl and the new,
  // dedicated bench/replay-negative-cache.jsonl (see CHANGELOG 0.4.2.6 for the full table):
  //   negativeCache alone: no-op on demo and aliases; on its OWN dedicated fixture, 1 fewer
  //     call (the dropped retry) at +23 raw tokens — a clear EFFECTIVE win (-4,977), same shape
  //     as lever 10 at 0.4.2.5. But on replay-heavy.jsonl a naturally recurring search ("storefront")
  //     coincidentally matches an earlier futile one (same words, memory unchanged) and gets the
  //     hint for real — +52 raw AND effective tokens, with NO call saved there (that fixture was
  //     never built with a `dropIfHinted` retry to model the model actually skipping it). The
  //     rule needs ALL tested files to pass, so one real, unmodelled cost on replay-heavy.jsonl is
  //     enough to keep this OFF for now — exactly the "measure honestly: it only saves if the
  //     model then stops searching" caution this lever was built with. Flip it on with
  //     MEMGLOW_PROXY_NEGATIVE_CACHE=1 / "proxy": { "negativeCache": true }.
  //   indexHint alone: a pure, unconditional ADD everywhere it fires (demo +96, heavy +391, its
  //     own fixture +78; a no-op only on replay-aliases.jsonl, which never reads the index) —
  //     same bucket as searchDetails/suggestions/archiveHint: never saves a call, so the rule
  //     fails outright. MEMGLOW_PROXY_INDEX_HINT=1 / "proxy": { "indexHint": true } to opt in.
  negativeCache: false,
  indexHint: false,
  // Lever 13, stage 0.4.3 ("cross-session delta reads") — measured with the SAME merge rule as
  // levers 9-12 (bench/replay.js, 0 violations AND effective tokens <= off AND (raw tokens <=
  // off OR calls < off)), `--each` on all five replay files (bench/replay-demo.jsonl,
  // replay-heavy.jsonl, replay-aliases.jsonl, replay-negative-cache.jsonl and the new, dedicated
  // bench/replay-delta-read.jsonl — see CHANGELOG 0.4.3 for the full table): the rule holds, with
  // margin, on EVERY one of them — mechanism 2 (within-session diff) saves a small -11 raw/
  // effective tokens on replay-demo.jsonl and replay-heavy.jsonl (each already has an edit-then-
  // reread in one session), 0 elsewhere, and -5992 on its own dedicated fixture; mechanism 1
  // (cross-session header) never even fires outside that dedicated fixture, so it never costs
  // anything there either. Still shipped OFF by default, though: unlike levers 9/10 (multiQuery,
  // aliases), this one has not been checked yet against a REAL usage log the way those two were
  // before their own flip to ON (see their comments above) — a clean 0/5 on hand-built replay
  // files is not the same evidence. It also persists a new per-client ledger file
  // (delta-read.json) the moment it is on, which deserves a cycle of real use before it writes
  // by default. MEMGLOW_PROXY_DELTA_READ=1 / "proxy": { "deltaRead": true } to opt in now.
  deltaRead: false,
  // Lever 14, stage 0.4.4.1 ("duplicate-write hint") — measured with the SAME merge rule as
  // levers 9-13 (bench/replay.js, 0 violations AND effective tokens <= off AND (raw tokens <=
  // off OR fewer calls)), `--each` on all five existing replay files plus the new, dedicated
  // bench/replay-duplicate.jsonl (see CHANGELOG 0.4.4.1 for the full table): none of the five
  // existing fixtures carries a `write_note` with a `title` that already names or resembles an
  // existing note, so this lever is a true no-op there (identical calls/tokens to off, 0
  // violations) — exactly the "fixtures may have no write_note-with-title events" case this
  // stage's own instructions call out as acceptable. But on its OWN dedicated fixture (two
  // write_notes built specifically to make it fire: one an exact title match, one a near-
  // duplicate), it is a pure, unconditional ADD (+35 raw and effective tokens, 0 violations, 0
  // calls saved) — advisory only, by design, it never saves a call, so raw tokens go up with
  // nothing to offset them — the same bucket as searchDetails/suggestions/archiveHint/indexHint,
  // and the same reasoning: the merge rule fails outright wherever it actually does something,
  // so it ships OFF by default. MEMGLOW_PROXY_DUPLICATE_HINT=1 / "proxy": { "duplicateHint": true }
  // to opt in.
  duplicateHint: false,
  // Lever 15, 0.4.10.9 ("slug hint"): after a `write_note` whose title is not a kebab slug, or
  // that lands directly in the notes root (no sub-folder), one advisory line suggesting the slug
  // and a sub-folder. Never blocks, never changes the arguments. A house style (title = kebab
  // slug, file = slug.md, inside memory/<folder>/), not a general rule: OFF by default.
  // MEMGLOW_PROXY_SLUG_HINT=1 / "proxy": { "slugHint": true } to opt in.
  slugHint: false,
  // Lever 16, 0.4.11.1 ("hub-append hint") — see the module's top comment. OFF by default, like
  // every other opt-in advisory lever here. MEMGLOW_PROXY_HUB_HINT=1 / "proxy": { "hubHint": true }.
  hubHint: false,
  hubHintTokens: 400,
  // Lever 17, 0.5.1.2 ("journal → current state view", lib/levers/state-view.js) — a note made of
  // appended dated sections ("## Mise à jour 12/10"…) gets its frontmatter/intro, its undated
  // sections and its 2 most recent dated sections in full, with the older ones named (never
  // hidden silently) on one line. OFF by default, like every other opt-in shortening lever here;
  // `stateViewTokens` is its OWN, smaller size gate (default 1500, well under `largeNoteTokens`'s
  // 5000) — a journal note is worth shrinking long before it is "too large" outright.
  // MEMGLOW_PROXY_STATE_VIEW=1 / "proxy": { "stateView": true } to opt in;
  // MEMGLOW_PROXY_STATE_VIEW_TOKENS / "proxy": { "stateViewTokens": N } to change the threshold.
  stateView: false,
  stateViewTokens: 1500,
  // Lever, 0.5.3 ("orphan-note hint") — see lib/levers/orphan-hint.js's own top comment. A
  // brand-new note (never an edit, never an overwrite of a note that already existed) that
  // memglow's own graph finds no link to OR from, either direction, gets one advisory line
  // pointing at the convention (an "Up: [[hub]]" line, or listing it in its hub/index). Never
  // blocks, never changes the write's own arguments. OFF by default, like every other opt-in
  // advisory lever here (duplicateHint/slugHint/hubHint): a pure, unconditional add on the one
  // note it fires for — no call it could ever save.
  // MEMGLOW_PROXY_ORPHAN_HINT=1 / "proxy": { "orphanHint": true } to opt in.
  orphanHint: false,
  // Lever 18, 0.5.6 ("session memory budget", lib/levers/session-budget.js) — an OPTIONAL
  // per-session read budget: once a session's own read_note/build_context/search_notes/search
  // answers have delivered ≈sessionBudgetTokens tokens, every FURTHER answer this session gets a
  // one-line notice (never blocked), and a full single-note read still over ≈2000 tokens is
  // additionally shortened to its own intro + "## Parts" (or first section) with a hint to read
  // the rest. 0 (default) = off. MEMGLOW_PROXY_SESSION_BUDGET=N / "proxy": {
  // "sessionBudgetTokens": N } to opt in.
  sessionBudgetTokens: 0,
  deltaReadMax: 5000,
  negativeCacheMax: 1000,
  archiveHintMax: 5,
  suggestionsMax: 3,
  searchDetailsMax: 10,
  readTools: ["read_note", "view_note", "read_content", "fetch", "build_context"],
  multiNoteTools: ["build_context"], // reads that return several notes: never de-duplicated nor cut
  searchTools: ["search_notes", "search"],
  writeTools: ["write_note", "edit_note"],
  savingsFile: true,
  log: true,
};

// ---------------------------------------------------------------------------------------------
// Configuration

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function flag(envValue, fileValue, def) {
  if (envValue != null && envValue !== "") return !/^(0|false|off|no)$/i.test(String(envValue).trim());
  return typeof fileValue === "boolean" ? fileValue : def;
}
function list(envValue, fileValue, def) {
  if (envValue) return String(envValue).split(",").map((s) => s.trim()).filter(Boolean);
  return Array.isArray(fileValue) ? fileValue.filter((s) => typeof s === "string" && s) : def;
}
function int(v, def, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/**
 * `proxy.unsupportedTools` validated, or the default table when absent/malformed: a full
 * replacement (like every other table/list in this config), never a merge — so a config that
 * wants to add a server keeps basic-memory's entry only by repeating it.
 * Shape: { "<server name, matched case-insensitively, substring either way>": { "<tool name>":
 * ["<allowed clientInfo name or title>", …] } }. A tool absent from the table is never hidden.
 */
function unsupportedToolsOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_UNSUPPORTED_TOOLS;
  const out = {};
  for (const [server, table] of Object.entries(raw)) {
    const s = String(server || "").trim().toLowerCase();
    if (!s || !table || typeof table !== "object" || Array.isArray(table)) continue;
    const entry = {};
    for (const [tool, allow] of Object.entries(table)) {
      const t = String(tool || "").trim();
      const list = Array.isArray(allow) ? allow.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
      if (t && list.length) entry[t] = list;
    }
    if (Object.keys(entry).length) out[s] = entry;
  }
  return Object.keys(out).length ? out : DEFAULT_UNSUPPORTED_TOOLS;
}

/**
 * Proxy settings: an explicit MEMGLOW_CONFIG alone, else ONLY ~/.memglow/memglow.config.json
 * (lib/defaults.js's resolveConfigFiles, `allowCwd: false`) — never a `./memglow.config.json` in
 * the current directory. 0.4.7.6 (trust boundary, MAJOR, reviewer-confirmed): the proxy routinely
 * runs with its cwd inside, or alongside, a notes folder that is itself an untrusted, cloned
 * repository; a `./memglow.config.json` committed THERE must never be able to set
 * dataDir/memoryDir, replace the tool-mapping tables (readTools/searchTools/writeTools/
 * unsupportedTools) or inject text into `initialize`'s `instructions` through the memory rules'
 * own config-driven settings. Only a file the PERSON running memglow controls (MEMGLOW_CONFIG, or
 * their own home folder) is ever read — exactly as before 0.4.7.1. Then environment overrides.
 * Also reads <dataDir>/setup.json's saved "tuning" (the page Settings → AI settings writes to)
 * for the one lever threshold it can set today — largeNoteTokens (lever 1, sizeWarning) — with
 * priority env > page (setup.json) > file > built-in default, exactly like the main viewer
 * already resolves it (lib/setup.js effective()): so lever 1's threshold can no longer silently
 * diverge from what Settings shows. Never throws.
 */
function proxyConfig(env = process.env, cwd = process.cwd()) {
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const { config: cfg } = defaultsLib.resolveConfigFiles({ env, cwd, home, allowCwd: false });
  const p = cfg.proxy && typeof cfg.proxy === "object" ? cfg.proxy : {};
  const base = defaultsLib.resolveBase(env, cwd); // minor 4 (0.4.7.6): one shared rule
  const dir = env.MEMGLOW_MEMORY_DIR || env.MEMORY_DIR || cfg.memoryDir || "";
  const themes = Array.isArray(cfg.themes) && cfg.themes.length ? cfg.themes.filter((t) => t && typeof t.id === "string") : DEFAULT_THEMES;
  const dataDirForTuning = path.resolve(base, env.MEMGLOW_DATA_DIR || cfg.dataDir || home);
  const savedTuning = defaultsLib.readSavedTuning(dataDirForTuning);
  // 0.4.7.2: the lever booleans ALSO consult the page's saved <dataDir>/setup.json "proxy"
  // section — env > page > file > default, same rule as largeNoteTokens since 0.4.7.1 — even
  // though nothing can write that section until 0.4.7.3 (savedProxy is {} until then, so `pb()`
  // is a pure no-op today): the control panel's "source" column (lib/proxy-levers.js
  // proxyControl()) must never show "page" for a value this function would not actually use.
  const savedProxy = defaultsLib.readSavedProxy(dataDirForTuning);
  const pb = (envVal, key, def) => defaultsLib.resolveBool(envVal, savedProxy[key], p[key], def);
  return {
    sizeWarning: pb(env.MEMGLOW_PROXY_SIZE_WARNING, "sizeWarning", DEFAULTS.sizeWarning),
    indexWarning: pb(env.MEMGLOW_PROXY_INDEX_WARNING, "indexWarning", DEFAULTS.indexWarning),
    indexWarningTokens: defaultsLib.resolveInt(undefined, savedTuning.indexWarningTokens, cfg.indexWarningTokens, defaultsLib.INDEX_WARNING_TOKENS, 100, 1000000),
    searchDetails: pb(env.MEMGLOW_PROXY_SEARCH_DETAILS, "searchDetails", DEFAULTS.searchDetails),
    suggestions: pb(env.MEMGLOW_PROXY_SUGGESTIONS, "suggestions", DEFAULTS.suggestions),
    dedupe: pb(env.MEMGLOW_PROXY_DEDUPE, "dedupe", DEFAULTS.dedupe),
    toc: pb(env.MEMGLOW_PROXY_TOC, "toc", DEFAULTS.toc),
    archiveHint: pb(env.MEMGLOW_PROXY_ARCHIVE_HINT, "archiveHint", DEFAULTS.archiveHint),
    archiveHintMax: int(p.archiveHintMax, DEFAULTS.archiveHintMax, 1, 20),
    hideUnsupportedTools: pb(env.MEMGLOW_PROXY_HIDE_UNSUPPORTED, "hideUnsupportedTools", DEFAULTS.hideUnsupportedTools),
    unsupportedTools: unsupportedToolsOf(p.unsupportedTools),
    multiQuery: pb(env.MEMGLOW_PROXY_MULTI_QUERY, "multiQuery", DEFAULTS.multiQuery),
    // Lever 10 (aliases, lib/learned-aliases.js): `aliases` gates injection, `learnAliases`
    // gates recording — independent switches, see DEFAULTS.aliases above.
    aliases: pb(env.MEMGLOW_PROXY_ALIASES, "aliases", DEFAULTS.aliases),
    learnAliases: pb(env.MEMGLOW_PROXY_LEARN_ALIASES, "learnAliases", DEFAULTS.learnAliases),
    aliasesMax: int(p.aliasesMax, 2000, 50, 20000),
    // Lever 11 (negativeCache, lib/negative-cache.js): a single switch gates both recording and
    // using the hint — see that module's top comment for why.
    negativeCache: pb(env.MEMGLOW_PROXY_NEGATIVE_CACHE, "negativeCache", DEFAULTS.negativeCache),
    negativeCacheMax: int(p.negativeCacheMax, DEFAULTS.negativeCacheMax, 50, 20000),
    // Lever 12 (indexHint): no separate max/window — it reuses ALIAS_LEARN_WINDOW_MS and
    // searchDetailsMax-style small caps baked into lib/proxy-levers.js itself.
    indexHint: pb(env.MEMGLOW_PROXY_INDEX_HINT, "indexHint", DEFAULTS.indexHint),
    // Lever 13 (deltaRead, lib/delta-read.js): a single switch gates both mechanisms (the
    // cross-session header and the within-session diff) — see DEFAULTS.deltaRead above.
    deltaRead: pb(env.MEMGLOW_PROXY_DELTA_READ, "deltaRead", DEFAULTS.deltaRead),
    deltaReadMax: int(p.deltaReadMax, DEFAULTS.deltaReadMax, 50, 50000),
    // Lever 14 (duplicateHint) — see DEFAULTS.duplicateHint above.
    duplicateHint: pb(env.MEMGLOW_PROXY_DUPLICATE_HINT, "duplicateHint", DEFAULTS.duplicateHint),
    // Lever 15 (slugHint) — see DEFAULTS.slugHint above.
    slugHint: pb(env.MEMGLOW_PROXY_SLUG_HINT, "slugHint", DEFAULTS.slugHint),
    // Lever 16 (hubHint) — see DEFAULTS.hubHint above.
    hubHint: pb(env.MEMGLOW_PROXY_HUB_HINT, "hubHint", DEFAULTS.hubHint),
    hubHintTokens: defaultsLib.resolveInt(env.MEMGLOW_PROXY_HUB_HINT_TOKENS, undefined, p.hubHintTokens, DEFAULTS.hubHintTokens, 20, 50000),
    // Lever 17 (stateView) — see DEFAULTS.stateView/stateViewTokens above.
    stateView: pb(env.MEMGLOW_PROXY_STATE_VIEW, "stateView", DEFAULTS.stateView),
    stateViewTokens: defaultsLib.resolveInt(env.MEMGLOW_PROXY_STATE_VIEW_TOKENS, undefined, p.stateViewTokens, DEFAULTS.stateViewTokens, 200, 1000000),
    // orphanHint, 0.5.3 — see DEFAULTS.orphanHint above.
    orphanHint: pb(env.MEMGLOW_PROXY_ORPHAN_HINT, "orphanHint", DEFAULTS.orphanHint),
    // Lever 18 (sessionBudgetTokens), 0.5.6 — see DEFAULTS.sessionBudgetTokens above. No env >
    // page > file > def "boolean" shape (pb()): this is a plain int, 0 = off, same resolveInt
    // priority as every other int-valued lever threshold here.
    sessionBudgetTokens: defaultsLib.resolveInt(env.MEMGLOW_PROXY_SESSION_BUDGET, undefined, p.sessionBudgetTokens, DEFAULTS.sessionBudgetTokens, 0, 10000000),
    // Lever 8: OFF unless the user turns it on (memglow cannot know the host re-injects the index
    // at session start). "Known always loaded" = the index note(s) + this list, same shape and
    // same caps as the main config's own `alwaysLoaded` (lib/config.js) — paths that are not notes
    // (CLAUDE.md, AGENTS.md…) are harmless here: resolve() simply never matches them.
    alreadyLoaded: pb(env.MEMGLOW_PROXY_ALREADY_LOADED, "alreadyLoaded", DEFAULTS.alreadyLoaded),
    // Rule 1 (exempt clients) and rule 2 (require prior activity) — see DEFAULTS above.
    // MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT="" (empty string) is a deliberate empty list, same as
    // config `"alreadyLoadedExemptClients": []` — list() already treats both that way.
    alreadyLoadedExemptClients: env.MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT != null
      ? list(env.MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT, undefined, [])
      : list(undefined, p.alreadyLoadedExemptClients, DEFAULTS.alreadyLoadedExemptClients),
    alreadyLoadedRequireActivity: flag(env.MEMGLOW_PROXY_ALREADY_LOADED_REQUIRE_ACTIVITY, p.alreadyLoadedRequireActivity, DEFAULTS.alreadyLoadedRequireActivity),
    alwaysLoaded: (Array.isArray(cfg.alwaysLoaded) ? cfg.alwaysLoaded : [])
      .filter((s) => typeof s === "string" && s.trim() && s.length <= 500 && !/[\u0000-\u001F]/.test(s))
      .map((s) => s.trim()).slice(0, 20),
    archive: archive.settings(cfg.archive, env, cfg.archiveAfterDays),
    suggestionsMax: int(p.suggestionsMax, DEFAULTS.suggestionsMax, 1, 5),
    searchDetailsMax: int(p.searchDetailsMax, DEFAULTS.searchDetailsMax, 1, 50),
    readTools: list(env.MEMGLOW_PROXY_READ_TOOLS, p.readTools, DEFAULTS.readTools),
    multiNoteTools: list(env.MEMGLOW_PROXY_MULTI_NOTE_TOOLS, p.multiNoteTools, DEFAULTS.multiNoteTools),
    searchTools: list(env.MEMGLOW_PROXY_SEARCH_TOOLS, p.searchTools, DEFAULTS.searchTools),
    writeTools: list(env.MEMGLOW_PROXY_WRITE_TOOLS, p.writeTools, DEFAULTS.writeTools),
    savingsFile: flag(env.MEMGLOW_PROXY_SAVINGS_FILE, p.savingsFile, DEFAULTS.savingsFile),
    log: flag(env.MEMGLOW_PROXY_LOG, p.log, DEFAULTS.log),
    largeNoteTokens: defaultsLib.resolveInt(env.MEMGLOW_LARGE_NOTE_TOKENS, savedTuning.largeNoteTokens, cfg.largeNoteTokens, defaultsLib.LARGE_NOTE_TOKENS, 200, 1000000),
    // 0.5.4: set only by memory-server/memglow-memory-server.js's own all-in-one wiring, when ITS
    // auto-split worker (lib/auto-split.js) is enabled — 0 (default, every other caller including
    // the standalone MCP proxy in front of an unrelated memory server) means sizeWarning's hint
    // stays "split it with split_plan", never "memglow will do it".
    autoSplitIdleMinutes: int(env.MEMGLOW_PROXY_AUTOSPLIT_IDLE_MINUTES, 0, 0, 1440),
    memoryDir: dir ? path.resolve(base, dir) : null,
    dataDir: dataDirForTuning,
    pollMs: Math.max(500, Number(env.MEMGLOW_POLL_MS || cfg.pollMs || 2000)),
    memory: {
      indexNote: cfg.indexNote || ["MEMORY", "index"],
      themes: themes.map((t) => ({ id: String(t.id), label: String(t.label || t.id).slice(0, 40), color: t.color })),
      themeByFolder: Array.isArray(cfg.themeByFolder) ? cfg.themeByFolder.filter((x) => Array.isArray(x) && x.length === 2) : [],
      defaultTheme: cfg.defaultTheme || null,
    },
  };
}

/** True when at least one lever is on (else the proxy stays a pure byte relay). */
function anyLever(c) { return !!(c && (c.sizeWarning || c.indexWarning || c.searchDetails || c.suggestions || c.dedupe || c.toc || c.archiveHint || c.hideUnsupportedTools || c.alreadyLoaded || c.multiQuery || c.aliases || c.learnAliases || c.negativeCache || c.indexHint || c.deltaRead || c.duplicateHint || c.slugHint || c.hubHint || c.stateView || c.orphanHint || c.sessionBudgetTokens > 0)); }


module.exports = {
  DEFAULT_THEMES, OPENAI_MCP_CLIENT_NAME, DEFAULT_UNSUPPORTED_TOOLS, DEFAULTS,
  readJson, flag, list, int, unsupportedToolsOf, proxyConfig, anyLever,
};
