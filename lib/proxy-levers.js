"use strict";
/**
 * MCP proxy levers (v0.4) — token-saving and retrieval-speed helpers applied by
 * mcp-proxy/memglow-mcp-proxy.js to the RESPONSES of the memory MCP server it wraps.
 *
 * Golden rules:
 *  - NOTHING is ever written in the notes folder. The notes are only read (lib/memory.js has no
 *    write path); the only file this module may write is memglow's own `proxy-savings.json`, in
 *    memglow's data folder.
 *  - The upstream answer is never altered: levers 1-3 only ADD a text block before (prefix) or after
 *    (suffix) the upstream `content` items, which stay byte-for-byte what the server sent. Only
 *    levers 4 and 5, both OFF by default, replace a response (and only plain-text read responses
 *    without `structuredContent`, or whose structuredContent is a FastMCP text wrapper — see
 *    isTextWrap(): that wrapper is kept equal to the new text, for clients that read it).
 *  - No note body is ever added: titles, ids, themes, token estimates and frontmatter descriptions
 *    (secret-masked) only.
 *  - Any failure inside a lever returns the upstream message unchanged (the proxy relays it as is).
 *
 * Levers (switches: `proxy` key of memglow.config.json, or MEMGLOW_PROXY_* environment variables):
 *   1 sizeWarning    (ON)  prefix "⚠ memglow: this note is ≈N tokens…" on a read of a note over
 *                          largeNoteTokens, or after a write that leaves it over; once per note/session
 *     indexWarning   (OFF) same, for the INDEX note above indexWarningTokens (default 2000): it is
 *                          loaded at every session, so the hint is "trim the index"; once per session
 *   2 searchDetails  (OFF, was ON through 0.4.2.1b) suffix after search results: title · theme ·
 *                          ≈tokens · description. A note already read in full THIS session gets no
 *                          line at all (its content, not a guess at it, is already in context); a
 *                          note merely DESCRIBED once this session (an earlier search mentioned it)
 *                          gets the compact line on a later search, no description. Turned off by
 *                          default at stage 0.4.2.2: measured (bench/replay.js + a real 2-day log)
 *                          to cost more delivered tokens than it saves even after this shortening.
 *   3 suggestions    (OFF, was ON through 0.4.2.1b) suffix after a note read: up to 3-5 related
 *                          notes (links, sub-theme, co-usage); once per note PER SESSION — re-reading
 *                          the same note later in the same session does not repeat its suggestions.
 *                          Turned off by default at stage 0.4.2.2, same measurement as searchDetails.
 *   4 dedupe         (OFF) unchanged note re-read in the same session → short "unchanged" text
 *   5 toc            (OFF) note over the threshold → description + sections with ≈tokens; then one
 *                          section on demand (`memglow_section`), sliced from the upstream answer
 *   6 archiveHint    (OFF) a search that finds nothing in the live memory (no result, or only notes
 *                          of the archive folder) → suffix "memglow: nothing found in the live
 *                          memory — the archive summary lists: …" with the TITLES of the archived
 *                          sections that match the query (lib/archive.js), never their text
 *   7 hideUnsupportedTools (OFF) hides from `tools/list`, PER SESSION, the tools a config table
 *                          marks as unsupported for the client that just said hello in `initialize`
 *                          (clientInfo.name/title — one session per stdio process, one per HTTP
 *                          `Mcp-Session-Id`). Default table: basic-memory's own `search` and
 *                          `fetch` (its ChatGPT-compatibility adapters, `chatgpt_tools.py`) are
 *                          hidden from any client that is not OpenAI's MCP client — reproducing
 *                          basic-memory 0.23's own `client_info_is_openai_mcp()` rule so the
 *                          lever's idea of "supported" never drifts from the server's: the
 *                          client's reported name OR title, trimmed and lower-cased, must equal
 *                          "openai-mcp" or start with "openai-mcp/". A client that never sends a
 *                          name or title (unknown) is never filtered — caution, not a guess. A
 *                          client that calls a hidden tool anyway still gets a real answer: this
 *                          lever only edits `tools/list`, never a `tools/call`. Overridable via
 *                          `proxy.unsupportedTools` (replaces the whole table).
 *   8 alreadyLoaded  (OFF) a single-note read (never a multiNoteTools call) of a note memglow
 *                          knows is already loaded into the assistant's context at the start of
 *                          EVERY session — the index note(s) (`memory.indexNote`), plus any
 *                          `alwaysLoaded` entry (lib/always-loaded.js) that resolves to a note —
 *                          gets a short "already in your context" stub instead of its text, with
 *                          the 8 first hex characters of a sha1 of the note's file read directly
 *                          off disk. OFF by default: memglow cannot know whether the host truly
 *                          re-injects the index at every session (a SessionStart hook, a CLAUDE.md
 *                          import…) — turn it on only when it does. The sha is captured once per
 *                          proxy session (at `initialize`, or at first use if a read arrives
 *                          first): a note that changed since is never stubbed, only flagged, and
 *                          the full text is returned. 0.4.3.1 ("never stub the injection hook"):
 *                          the very mechanism that is supposed to re-inject the index at session
 *                          start (a SessionStart hook) typically reads it through this SAME proxy
 *                          — if lever 8 stubs THAT read, the session starts with no index at all.
 *                          Two independent guards, both skip the stub (never alter a read any
 *                          other way either): rule 1, `alreadyLoadedExemptClients` (config) /
 *                          `MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT` (env, comma-separated) — a list
 *                          of substrings matched case-insensitively against this session's
 *                          `clientInfo.name`/`.title` (sent at `initialize`); default `["hook",
 *                          "inject", "session-start", "sessionstart", "memglow-init"]`, `[]` to
 *                          disable. Rule 2, `alreadyLoadedRequireActivity` (default true) — name
 *                          match or not, the stub itself additionally requires that this session
 *                          already made at least one OTHER tool call, or a `tools/list`, before
 *                          this read: an injector characteristically reads immediately after
 *                          `initialize`, an assistant mid-conversation almost never does.
 *   9 multiQuery     (default: see DEFAULTS.multiQuery below) a search tool call that carries
 *                          `memglow_queries` (2-4 extra phrasings, added to the search tools'
 *                          schemas in `tools/list` when this lever is on) is sent upstream as ONE
 *                          call per phrasing — sequentially, the original query first — instead of
 *                          the model spending a separate turn on each extra phrasing (the built-in
 *                          rule "search in 2-3 phrasings", lib/memory-rules.js, used to cost 2-3
 *                          model turns for exactly this reason). The hits are merged, deduped by
 *                          note id (a note found by several phrasings ranks higher), capped to the
 *                          upstream's usual result count, and returned as ONE result, in the
 *                          upstream's own format when that is safe (plain-text hits, reassembled
 *                          from the server's own blocks — see mergeSearchResults()), else a compact
 *                          text listing built from whatever note ids can be resolved; if neither is
 *                          possible, or any later phrasing's call fails, the FIRST phrasing's own
 *                          result (= what a plain single search would have returned) is relayed
 *                          unchanged — "fail open" (runSearchCall()). `memglow_queries` is always
 *                          stripped before a call reaches the server, even when this lever is off.
 *  10 aliases        (default: see DEFAULTS.aliases below; lever `aliases`, learning gated by the
 *                          separate `learnAliases` switch, see lib/learned-aliases.js) the owner's
 *                          own real usage log: the note finally read was the proxy's 1st search
 *                          result only 7/28 times, and not among the results AT ALL 13/28 times —
 *                          so the next similar search fails again. When, in the SAME session, a
 *                          search is followed (within ALIAS_LEARN_WINDOW_MS = 2 minutes, before
 *                          another search) by a single-note read of a note NOT in that search's
 *                          own results, the query's significant words (lowercased, stop-words
 *                          dropped, lib/learned-aliases.js `significantWords`) are learned as
 *                          aliases of that note, with a count, in a small local file
 *                          (`learned-aliases.json`, mode 600, bounded, nothing ever sent
 *                          anywhere — see lib/learned-aliases.js). On a LATER search whose words
 *                          match ≥ 2 learned aliases of some note X (or 1 alias seen ≥ 2 times),
 *                          and X is not already among this search's results, X is added at the
 *                          TOP of the answer — in the upstream's own per-hit row format when the
 *                          answer is plain text (reusing lever 9's own row helper, `hitRow`),
 *                          else one compact line: "memglow: likely relevant — <label> (<id>),
 *                          learned from your past searches". Never removes a result, never
 *                          touches a note file; an alias whose note no longer exists is forgotten
 *                          (`forgetMissing`). `learnAliases` (recording) and `aliases` (using what
 *                          was recorded) are independent switches: learning can keep running
 *                          quietly while injection is paused, and injection can keep using
 *                          whatever was already learned while recording itself is paused.
 *  11 negativeCache (default: see DEFAULTS.negativeCache below; lib/negative-cache.js) the
 *                          owner's own log: 12 of 40 searches led to NO READ AT ALL. When a
 *                          search in a session is not followed by a read (of anything) within
 *                          ALIAS_LEARN_WINDOW_MS, or is superseded by another search or a write
 *                          in the same session first, it is remembered, locally, as "futile" for
 *                          the live memory's current FINGERPRINT (note count + latest mtime). A
 *                          LATER search with the same significant words, while the fingerprint
 *                          is unchanged, gets one line prepended: "memglow: this search found
 *                          nothing you used last time (<date>); the memory has not changed
 *                          since." — the results themselves are always still relayed, unchanged,
 *                          right after: this never hides anything, only adds a line. Any write
 *                          anywhere changes the fingerprint, so it invalidates every remembered
 *                          entry at once ("invalidate on any write"). A single switch gates both
 *                          recording and using it (unlike lever 10's two switches): see
 *                          lib/negative-cache.js's top comment for why. Known gap: a search
 *                          merged by lever 9 (multiQuery, `memglow_queries`) bypasses
 *                          `handleSearch` entirely (see applyAliasesToSearch's own top comment),
 *                          so this lever neither learns from nor hints into a MERGED multi-
 *                          phrasing call — only a lone search (no burst) goes through it. A
 *                          future stage could extend applyAliasesToSearch the way it already
 *                          covers lever 10.
 *  12 indexHint     (default: see DEFAULTS.indexHint below) a search whose results are ONLY the
 *                          index note, or a read of the index itself while lever 8
 *                          (alreadyLoaded) is off, gets a short suffix: "memglow: the index
 *                          already says:" followed by up to 3 lines of the index's OWN text
 *                          (secret-masked, each capped) that mention one of the query's
 *                          significant words — grepped, not summarised. The read case reuses
 *                          lever 10's own "search right before a read" correlation
 *                          (`s.lastSearch`) to know what to grep for; with no recent search at
 *                          all, nothing is added. Never replaces the note's own content.
 *  13 deltaRead      (default: see DEFAULTS.deltaRead below; lib/delta-read.js) the hottest notes
 *                          get re-read in every new
 *                          session — a brand new session has an EMPTY context, so lever 4's
 *                          short "unchanged" stub would be WRONG there (the model never saw this
 *                          note's text in THIS session). Two mechanisms, neither ever touched by
 *                          lever 4:
 *                           - CROSS-SESSION: the first read of a note in a session always gets the
 *                             full current text (correctness) — this only ADDS, at most once, a
 *                             one-line header when the note changed since the LAST time this same
 *                             CLIENT read it, in an earlier session: "memglow: changed since your
 *                             last read on <date> — sections changed: <## titles>" (up to 5).
 *                             Remembered in a small persisted ledger, per client (clientBucket),
 *                             `delta-read.json` in memglow's data folder (mode 600, bounded,
 *                             atomic — see lib/delta-read.js createDeltaReadStore). Never shortens
 *                             anything; costs a few tokens whenever it fires.
 *                           - WITHIN-SESSION, note CHANGED: the gap dedupe's own "unchanged" stub
 *                             leaves open — a note already delivered in full THIS session (version
 *                             A), re-read after it changed (now version B), gets ONLY the diff
 *                             between A and B (lib/delta-read.js renderDiff, reusing
 *                             lib/assistant/diff.js's line diff), with a header saying so and
 *                             naming the escape hatch; too large a diff (> 60% of B) falls back to
 *                             B in full instead. Same escape hatch and "repeat the call" rule as
 *                             4/5/8 below.
 *                          The header never saves anything by itself (it only ever adds a line),
 *                          but on every replay file tested it either never fires at all, or
 *                          fires exactly because the note really did change — the usual merge
 *                          rule (bench/replay.js) holds on every one of them. Still OFF by
 *                          default for now (opt-in): see DEFAULTS.deltaRead below for why.
 *  14 duplicateHint (default: see DEFAULTS.duplicateHint below) memglow's product rule is that it
 *                          never writes a note itself; levers only ADD advisory text. Users' own
 *                          memories were getting duplicate notes because the assistant called
 *                          `write_note` with a new title on a subject that already had a note. This
 *                          lever adds ONE short line to a `write_note` response — never to
 *                          `edit_note`/`move_note` — when the title just used already names an
 *                          EXISTING note ("exact": the title itself, its kebab slug, or its label —
 *                          whatever `index.resolve` already matches, same helper every other lever
 *                          uses to turn a reference into a note id) or is close enough to one
 *                          ("similar": shares >= 2 significant words — lib/learned-aliases.js
 *                          significantWords, EN+FR stop-words, secret-masked, >= 3 characters —
 *                          with an existing note's own id+label+description, AND those shared
 *                          words cover >= 60% of the title's own significant words; see
 *                          duplicateHintCandidates() for the exact rule, deliberately conservative
 *                          — a false hint costs more than a missed one). Exact wins outright over
 *                          similar. Index notes and notes in the archive folder never count for
 *                          the similar rule. Ranked by shared-word count then note size; at most 2
 *                          candidates shown. The match is computed in `oneFromClient`, BEFORE the
 *                          write reaches the server (and before `index.afterWrite()` ever rescans
 *                          for it) — the note this very call is about to create must never be
 *                          mistaken for its own duplicate. Advisory only, like every other lever
 *                          here: never blocks, never changes the arguments sent upstream, never
 *                          touches the upstream result's own content blocks (one block appended).
 *                          Same note never hinted twice in one session. MEMGLOW_PROXY_DUPLICATE_HINT
 *                          / `proxy.duplicateHint` — see DEFAULTS.duplicateHint for the default.
 *  15 slugHint       (default off, 0.4.10.9) after a successful `write_note` whose title is not a
 *                          kebab slug, or that lands in the notes root itself: one advisory line
 *                          suggesting the slug (`--kebab-filenames`' file name) and a
 *                          memory/<folder>/ directory. Never blocks. MEMGLOW_PROXY_SLUG_HINT.
 *  16 hubHint        (default off, 0.4.11.1) the owner's memory uses hub-and-spoke notes: a hub
 *                          lists its parts under a "## Parts" heading (`- [[slug]] — hook` lines)
 *                          and/or a part declares itself with frontmatter `part_of`/`parent`
 *                          (lib/hub-spoke.js's own marker, trusted the same way). Sessions kept
 *                          appending large content straight to the HUB instead of the right
 *                          part, so hubs grew back after being split (one real hub went 1.1k →
 *                          9.4k tokens in 4 days). When an `edit_note` (append / prepend /
 *                          insert_before_section / insert_after_section — never find_replace or
 *                          replace_section) or a `write_note` overwrite adds more than
 *                          `hubHintTokens` (default 400) tokens of new content — estimated from
 *                          the call's own `content` argument, not a byte-exact diff — to a note
 *                          that HAS parts (hubPartsFor(): its own "## Parts" list if non-empty,
 *                          else any OTHER note that declares `part_of`/`parent` this hub), one
 *                          advisory line is appended: `memglow: "<hub>" is a hub — add detail to
 *                          one of its parts instead: [[part-a]] (topic), [[part-b]] (topic)…`.
 *                          Parts are ranked by shared significant words (lib/learned-aliases.js)
 *                          between the ADDED text and each part's own topic (its hub-list "hook"
 *                          text, else its label/description) — the best match named first — and
 *                          capped to HUB_HINT_MAX_PARTS. Same note never hinted twice in one
 *                          session (`s.hubHinted`, like duplicateHint's own `s.duplicateHinted`).
 *                          Never blocks, never shortens or replaces the write's own answer — one
 *                          block appended, same mechanics as duplicateHint/slugHint above.
 *                          MEMGLOW_PROXY_HUB_HINT / `proxy.hubHint`; threshold:
 *                          MEMGLOW_PROXY_HUB_HINT_TOKENS / `proxy.hubHintTokens`.
 *  17 stateView      (OFF) "journal → current state view" (lib/levers/state-view.js): a note made
 *                          of appended DATED sections ("## Mise à jour 12/10", "## État au 5/10
 *                          soir"…) over `stateViewTokens` (default 1500, its OWN, smaller gate
 *                          than lever 5's `largeNoteTokens`) with at least 3 such sections gets,
 *                          on a plain read, its frontmatter/intro + undated sections (rules,
 *                          "## Parts"…) + its 2 most recent dated sections IN FULL, followed by
 *                          ONE line naming the older sections left out (never silently) and how
 *                          to get one (`memglow_section`) or the whole note (`memglow_fresh`).
 *                          Tried BEFORE lever 5 (toc) — see handleRead below for the exact
 *                          placement and why dedupe (4) and deltaRead's within-session diff (13)
 *                          still run first; a stateView answer never seeds dedupe/deltaRead's own
 *                          "delivered in full" bookkeeping, so the next read of the same note is
 *                          never diffed against a partial text. Fails open (returns the upstream
 *                          lever chain unchanged) on fewer than 3 parseable dated headings, a
 *                          note under the threshold, or less than 30% saved.
 *                          MEMGLOW_PROXY_STATE_VIEW / `proxy.stateView`; threshold:
 *                          MEMGLOW_PROXY_STATE_VIEW_TOKENS / `proxy.stateViewTokens`.
 *  18 orphanHint    (default off, 0.5.3) a `write_note` that creates a BRAND NEW note (never an
 *                          edit, never an overwrite of a note that already existed — matched
 *                          BEFORE the write reaches the server, same as lever 14) whose id,
 *                          once written, memglow's own graph finds no `[[wikilink]]` FROM, and
 *                          no link TO it from any other note either, gets one advisory line:
 *                          `memglow: note [[<id>]] links to nothing and nothing links to it —
 *                          add an "Up: [[hub]]" line or list it in its hub/index, or it will
 *                          float alone in the graph.` The index note(s) never qualify. Same note
 *                          never hinted twice in one session. Never blocks, never changes the
 *                          write's own arguments — one block appended, same mechanics as
 *                          duplicateHint/slugHint/hubHint above. MEMGLOW_PROXY_ORPHAN_HINT /
 *                          `proxy.orphanHint`.
 * Per-client accounting (0.4.10.9): every tools/call is counted once (createSavings.addClient),
 * under the session's clientInfo, else the request's `_meta` clientInfo, else the User-Agent.
 * Escape hatch for 4, 5, 8, 13 and 17: the argument `memglow_fresh: true` (added to the read tools' schemas
 * in `tools/list`, stripped before the call reaches the server), or simply repeating the same read:
 * the read that follows a short answer always returns the full upstream content (lever 8 does not
 * need the repeat: fresh is enough, since it would otherwise stub every matching read again).
 */
const crypto = require("crypto");
const { estimateTokens, sectionSpans, dayOf } = require("./cost");
const searchMeta = require("./search-meta");
const { permalinksIn } = searchMeta;
const archive = require("./archive");
const { significantWords } = require("./learned-aliases");
const deltaRead = require("./delta-read");

// 0.4.12.4: proxy-levers.js is the public entry — createLevers() (below) plus every lever's own
// module re-exported, unchanged, from lib/levers/ (one file per lever, or per small group of
// closely-related levers; see each file's own top comment). Every lever module is required
// eagerly, not behind its own cfg flag: their pure functions are PART OF THIS MODULE'S PUBLIC
// API regardless of which levers are on (bench/replay.js and many tests call e.g.
// L.duplicateHintFor/L.planMultiQuery directly, with no live session or cfg at all) — a
// flag-gated require would make those exports disappear exactly when a caller is testing the
// lever that is off, so eager loading here is the correct choice, not just the simpler one.
const configLib = require("./levers/config");
const controlPanelLib = require("./levers/control-panel");
const noteIndexLib = require("./levers/note-index");
const accountingLib = require("./levers/accounting");
const responsesLib = require("./levers/responses");
const hiddenToolsLib = require("./levers/hidden-tools");
const multiQueryLib = require("./levers/multi-query");
const aliasesLib = require("./levers/aliases");
const indexHintLib = require("./levers/index-hint");
const duplicateHintLib = require("./levers/duplicate-hint");
const hubHintLib = require("./levers/hub-hint");
const stateViewLib = require("./levers/state-view");
const orphanHintLib = require("./levers/orphan-hint");

const { proxyConfig, anyLever, DEFAULTS, DEFAULT_UNSUPPORTED_TOOLS, OPENAI_MCP_CLIENT_NAME } = configLib;
const { proxyControl, LEVER_META, LEVER_INT_CAPS } = controlPanelLib;
const { createNoteIndex } = noteIndexLib;
const { clientBucket, metaClientInfo, userAgentClientInfo, createSavings, readClientSavings, CLIENT_TOKENS_WINDOW_DAYS } = accountingLib;
const { textOf, isTextWrap, block, oneLine, noteRefsInArgs, resultIds } = responsesLib;
const { clientInfoKnown, clientInfoAllowed, clientInfoExempt, hiddenToolsFor } = hiddenToolsLib;
const {
  ARG_QUERIES, MULTI_QUERY_MAX, MULTI_QUERY_LEN_MAX, queryKeyOf, queryOf, emptyAnswer, planMultiQuery,
  rankKeys, mergeRankedIds, mergeSearchResults, hitChunksOf, runSearchCall, hitRow, isPlainTextResult,
} = multiQueryLib;
const { ALIAS_LEARN_WINDOW_MS, aliasInjection, applyAliasesToSearch } = aliasesLib;
const { indexHintLines, indexHintBlock, INDEX_HINT_MAX_LINES, INDEX_HINT_LINE_MAX } = indexHintLib;
const {
  duplicateHintCandidates, duplicateHintBlock, duplicateHintFor, noteWords,
  DUPLICATE_HINT_MIN_SHARED, DUPLICATE_HINT_COVERAGE, DUPLICATE_HINT_MAX_CANDIDATES, slugHintFor, KEBAB_SLUG_RE,
} = duplicateHintLib;
const { parsePartsSection, hubPartsFor, hubHintFor, HUB_HINT_EDIT_OPS, HUB_HINT_MAX_PARTS } = hubHintLib;
const { buildStateView, stateViewBlocks } = stateViewLib;
const { orphanHintFor } = orphanHintLib;

const ARG_FRESH = "memglow_fresh";
const ARG_SECTION = "memglow_section";

/**
 * createLevers({ config, index, savings, serverName }) → { clientMessage(msg, sessionKey), serverMessage(msg, sessionKey) }
 * Both return { msg, changed }. `msg` may be a JSON-RPC object or a batch (array). `serverName` is
 * the upstream server's `--name` (or guessed label): only used to pick the right
 * `unsupportedTools` table entry for lever 7.
 */
const NOOP_ALIAS_STORE = { available: () => false, learn() {}, match() { return null; }, forgetMissing() {} };
// Lever 11 (negativeCache, lib/negative-cache.js) — same "no data folder, no store" shape.
const NOOP_NEGATIVE_CACHE_STORE = { available: () => false, recordFutile() {}, lookup() { return null; }, forgetStale() {} };
// Lever 13 (deltaRead, lib/delta-read.js) — same shape again, for the cross-session ledger.
const NOOP_DELTA_READ_STORE = { available: () => false, get() { return null; }, set() {} };
function createLevers({ config, index, savings, serverName, aliasStore, negativeCacheStore, deltaReadStore }) {
  const cfg = config;
  const aliases = aliasStore || NOOP_ALIAS_STORE;
  const negativeCache = negativeCacheStore || NOOP_NEGATIVE_CACHE_STORE;
  const deltaStore = deltaReadStore || NOOP_DELTA_READ_STORE;
  const readTools = new Set(cfg.readTools), multi = new Set(cfg.multiNoteTools);
  const searchTools = new Set(cfg.searchTools), writeTools = new Set(cfg.writeTools);
  const replacing = cfg.dedupe || cfg.toc || cfg.alreadyLoaded || cfg.deltaRead || cfg.stateView;
  const listIntercept = replacing || cfg.hideUnsupportedTools || cfg.multiQuery;
  const sessions = new Map();
  const T = cfg.largeNoteTokens;
  const themeLabel = (id) => { const t = cfg.memory.themes.find((x) => x.id === id); return t ? t.label : id; };

  /**
   * Lever 8's baseline: sha1 of every known-always-loaded note's file, read right now — "this
   * session began" is approximated by the first time it is captured for a session (at
   * `initialize`, or lazily at session creation if a read arrives first; never throws). A note
   * unreadable at capture time is simply absent from the map, so it is never stubbed.
   */
  function captureBaseline() {
    if (!cfg.alreadyLoaded) return null;
    const baseline = new Map();
    try {
      for (const aid of index.alwaysLoadedIds(cfg.alwaysLoaded)) {
        const h = index.fileHash(aid);
        if (h) baseline.set(aid, h);
      }
    } catch { /* best effort: an empty or partial baseline just stubs less, never breaks the relay */ }
    return baseline;
  }

  /** Lever 11 (negativeCache): a session's still-pending search, if any, is now provably "no
   * read at all" — nothing else is ever going to redeem it (the session is gone). */
  function finalizePending(s) {
    if (cfg.negativeCache && negativeCache.available() && s && s.pendingNegative) {
      negativeCache.recordFutile(s.pendingNegative.words, s.pendingNegative.fingerprint, s.pendingNegative.t);
      s.pendingNegative = null;
    }
  }

  function session(key) {
    const k = String(key || "default");
    let s = sessions.get(k);
    if (!s) {
      s = { pending: new Map(), warned: new Set(), delivered: new Map(), shortened: new Set(), read: new Set(), suggested: new Set(), searchDescribed: new Set(), duplicateHinted: new Set(), hubHinted: new Set(), orphanHinted: new Set(), clientInfo: null, alreadyLoadedBaseline: captureBaseline(), lastSearch: null, pendingNegative: null, deltaText: new Map(), toolCallCount: 0, sawToolsList: false, metaClientInfo: null };
      sessions.set(k, s);
      if (sessions.size > 200) {
        // 0.4.10.9: the least recently used per-connection session ("conn:…", a stateless MCP
        // 2026-07-28 request — a client opening a new connection per call makes one per call)
        // goes first, so a churn of those never pushes out a real session (and its clientInfo).
        let evictKey = sessions.keys().next().value;
        for (const key of sessions.keys()) { if (key !== k && key.startsWith("conn:")) { evictKey = key; break; } }
        finalizePending(sessions.get(evictKey)); // 0.4.2.6: an evicted session's search is settled now, not lost
        sessions.delete(evictKey);
      }
    } else { sessions.delete(k); sessions.set(k, s); } // LRU
    return s;
  }

  function sizeWarning(note, tokens, now) {
    const theme = note && note.theme && !["other", "index"].includes(note.theme) ? ` within the same theme "${themeLabel(note.theme)}"` : "";
    return `⚠ memglow: this note is ${now ? "now " : ""}≈${tokens} tokens (threshold ${T}). Consider offering the user to split it into smaller notes${theme}; memglow's \`split_plan\` tool can propose sections.`;
  }

  /**
   * 0.4.10.9 — who made this call, for accounting (per-client savings, lever 13's per-client
   * ledger): the session's `initialize` clientInfo; else this request's own `_meta` clientInfo
   * (MCP 2026-07-28, remembered for the rest of this session/connection); else one an earlier
   * request of this session carried; else the HTTP User-Agent (`hints.userAgent`); else null
   * ("unknown"). Never used for lever 7 nor lever 8's exemption, which stay on `s.clientInfo`.
   */
  function identityFor(s, params, hints) {
    if (clientInfoKnown(s.clientInfo)) return s.clientInfo;
    const meta = metaClientInfo(params);
    if (meta) { s.metaClientInfo = meta; return meta; }
    if (s.metaClientInfo) return s.metaClientInfo;
    return userAgentClientInfo(hints && hints.userAgent);
  }

  /** Tokens of one answer (result or error) as relayed — the per-client baseline. */
  function answerTokens(m) {
    if (!m || typeof m !== "object") return 0;
    if (m.result && typeof m.result === "object" && Array.isArray(m.result.content)) return estimateTokens(textOf(m.result.content));
    try { return estimateTokens(JSON.stringify(m.error || m.result || "")); } catch { return 0; }
  }

  // ---- client → server ----
  function oneFromClient(m, s, hints) {
    if (!m || typeof m !== "object") return m;
    if (m.method === "initialize") {
      s.warned.clear(); s.delivered.clear(); s.shortened.clear(); s.read.clear(); s.suggested.clear(); s.searchDescribed.clear(); s.duplicateHinted.clear(); s.hubHinted.clear(); s.orphanHinted.clear();
      s.deltaText.clear(); // lever 13: version A of a note, kept only for THIS session's own diffing
      s.lastSearch = null; // a fresh session never correlates a read with a search from before it
      s.pendingNegative = null; // lever 11: a fresh session starts with no futility verdict pending
      s.alreadyLoadedBaseline = captureBaseline(); // a fresh "session begins" point, reconnects included
      s.toolCallCount = 0; s.sawToolsList = false; // lever 8 rule 2: a fresh session has done nothing yet
      // The client's self-identification for this session (stdio: the whole process; HTTP: this
      // Mcp-Session-Id) — lever 7's only input. Re-sent on every `initialize` (reconnects included).
      const ci = m.params && typeof m.params === "object" ? m.params.clientInfo : null;
      s.clientInfo = ci && typeof ci === "object" && !Array.isArray(ci)
        ? { name: typeof ci.name === "string" ? ci.name : null, title: typeof ci.title === "string" ? ci.title : null, version: typeof ci.version === "string" ? ci.version : null }
        : null;
    }
    if (m.id == null) return m;
    // Lever 8 rule 2: a `tools/list` is itself evidence of an assistant-shaped session (an
    // injector reads immediately after `initialize`, never lists tools first) — tracked
    // unconditionally, independently of `listIntercept` (lever 7's own, unrelated reason to
    // intercept the response).
    if (m.method === "tools/list") { s.sawToolsList = true; if (listIntercept) s.pending.set(String(m.id), { list: true }); return m; }
    if (m.method !== "tools/call" || !m.params || typeof m.params.name !== "string") return m;
    const tool = m.params.name;
    const args = m.params.arguments && typeof m.params.arguments === "object" && !Array.isArray(m.params.arguments) ? m.params.arguments : {};
    const kind = readTools.has(tool) ? "read" : searchTools.has(tool) ? "search" : writeTools.has(tool) ? "write" : null;
    // 0.4.10.9: EVERY tools/call is awaited, so that its answer is counted once (per-client
    // accounting), whatever the tool — a tool no lever acts on only gets counted.
    const client = identityFor(s, m.params, hints);
    if (!kind) {
      s.pending.set(String(m.id), { tool, kind: "other", args, client });
      if (s.pending.size > 1000) s.pending.delete(s.pending.keys().next().value);
      return m;
    }
    // Lever 8 rule 2: did this SAME session already do something else before this call was sent?
    // Captured now, on the call itself, not re-derived later — the counter below moves on.
    const priorActivity = s.toolCallCount > 0 || s.sawToolsList;
    s.toolCallCount++;
    // Lever 14 (duplicateHint) — matched now, BEFORE this write reaches the server: `index` still
    // reflects the memory as it was before this very call, so the note it is about to create is
    // never mistaken for its own duplicate. Only `write_note` (never edit_note/move_note).
    const duplicateHint = (cfg.duplicateHint && tool === "write_note") ? duplicateHintFor(index, args) : null;
    // orphanHint (0.5.3) — "is this write_note about to create a BRAND NEW note?", matched now,
    // BEFORE the write reaches the server, the same way duplicateHint is above: `index.resolve`
    // still reflects the memory as it was before this very call, so a title that already names
    // an existing note (whatever `resolve` already matches — same helper duplicateHint uses) is
    // never mistaken for a new one. Independent of `cfg.duplicateHint` — orphanHint needs this
    // regardless of whether that OTHER lever is on.
    const orphanCandidate = cfg.orphanHint && tool === "write_note" && typeof args.title === "string" && args.title.trim() && !index.resolve(args.title.trim());
    const call = { tool, kind, args, fresh: args[ARG_FRESH] === true, section: args[ARG_SECTION], priorActivity, duplicateHint, orphanCandidate, startedAt: Date.now(), client };
    s.pending.set(String(m.id), call);
    if (s.pending.size > 1000) s.pending.delete(s.pending.keys().next().value);
    if (kind === "read" && (ARG_FRESH in args || ARG_SECTION in args)) {
      const clean = { ...args };
      delete clean[ARG_FRESH]; delete clean[ARG_SECTION];
      return { ...m, params: { ...m.params, arguments: clean } };
    }
    // memglow_queries is always stripped before a call reaches the server, even with multiQuery
    // off: a search tool call for this id is handled normally (the transport never routes it
    // through runSearchCall when `cfg.multiQuery` is off or planMultiQuery finds nothing to do),
    // so the extra phrasings must not leak upstream as an unknown argument.
    if (kind === "search" && ARG_QUERIES in args) {
      const clean = { ...args };
      delete clean[ARG_QUERIES];
      return { ...m, params: { ...m.params, arguments: clean } };
    }
    return m;
  }

  // ---- server → client ----
  function augmentList(result, s) {
    if (!result || !Array.isArray(result.tools)) return null;
    let changed = false;
    let tools = result.tools;

    // Lever 7 — drop, for THIS client only, the tools its session's clientInfo is not allowed to
    // use (per cfg.unsupportedTools for this upstream server). Pure removal: schemas below are
    // unaffected, and a client that calls a hidden tool anyway still reaches the real server.
    if (cfg.hideUnsupportedTools) {
      const hidden = hiddenToolsFor(cfg, serverName, s.clientInfo);
      if (hidden && hidden.size) {
        const filtered = tools.filter((t) => !(t && hidden.has(t.name)));
        if (filtered.length !== tools.length) { tools = filtered; changed = true; }
      }
    }

    // Levers 4/5/8's escape hatch (memglow_fresh / memglow_section): only meaningful when one of
    // them can shorten an answer in the first place.
    if (replacing) {
      tools = tools.map((t) => {
        if (!t || !readTools.has(t.name) || multi.has(t.name) || !t.inputSchema || typeof t.inputSchema !== "object") return t;
        const props = { ...(t.inputSchema.properties || {}) };
        props[ARG_FRESH] = { type: "boolean", description: "memglow proxy: return the full note even if it was already read in this session or is large. Not sent to the memory server." };
        // ARG_SECTION is only meaningful once there is a table of contents (lever 5) OR a
        // stateView summary (lever 17) naming headings to ask for.
        if (cfg.toc || cfg.stateView) props[ARG_SECTION] = { type: "string", description: "memglow proxy: return only this section of a large note (its heading, or its number in the table of contents). Not sent to the memory server." };
        changed = true;
        return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
      });
    }

    // Lever 9 (multiQuery) — memglow_queries on every search tool's schema.
    if (cfg.multiQuery) {
      tools = tools.map((t) => {
        if (!t || !searchTools.has(t.name) || !t.inputSchema || typeof t.inputSchema !== "object") return t;
        const props = { ...(t.inputSchema.properties || {}) };
        props[ARG_QUERIES] = {
          type: "array", items: { type: "string", maxLength: MULTI_QUERY_LEN_MAX }, maxItems: MULTI_QUERY_MAX,
          description: "memglow proxy: alternate phrasings to search in the same call, alongside the main query argument (2-3 is usually enough). Sent upstream as one search per phrasing, merged into one result. Not sent to the memory server.",
        };
        changed = true;
        return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
      });
    }
    return changed ? { ...result, tools } : null;
  }

  function handleRead(call, result, s) {
    const content = result.content;
    const text = textOf(content);
    const refs = noteRefsInArgs(call.args);
    let id = null;
    for (const r of refs) { id = index.resolve(r); if (id) break; }
    if (!id) for (const r of permalinksIn(text)) { id = index.resolve(r); if (id) break; }
    const note = id ? index.note(id) : null;
    const respTokens = estimateTokens(text);
    const tokens = note ? note.tokens : respTokens;
    const key = id || call.tool + ":" + JSON.stringify(refs);
    const canReplace = !multi.has(call.tool) && (!("structuredContent" in result) || isTextWrap(result)) && content.length > 0
      && content.every((c) => c && c.type === "text" && typeof c.text === "string");
    const label = note ? note.label : (refs[0] || "this note");
    // Lever 13 (deltaRead): "the first read of a note in THIS session" has to be known BEFORE
    // `s.read` is updated for it — a brand new session's empty context is exactly why the
    // cross-session header only ever fires once per note per session, on that first read.
    const firstReadThisSession = !!(id && !s.read.has(id));
    if (id) s.read.add(id);
    // (per-client baseline: counted once for every tools/call in oneFromServer, BEFORE any lever.)
    const sectionRequested = call.section != null && call.section !== "";

    // 11 — negativeCache: ANY read redeems this session's pending search — "led to no read AT
    // ALL" is the literal thing being measured (lib/negative-cache.js), not "a read of a
    // matching note", so this runs before `id` is even known to resolve, and even for a
    // multi-note read (unlike lever 10's own learn() just below, which cannot name "the one"
    // note here). Too late (past the window): the pending search is recorded futile after all.
    if (cfg.negativeCache && negativeCache.available() && s.pendingNegative) {
      const elapsed = Date.now() - s.pendingNegative.t;
      if (elapsed >= 0 && elapsed <= ALIAS_LEARN_WINDOW_MS) s.pendingNegative = null; // redeemed: in time
      else finalizePending(s); // too late: futile after all
    }

    // 10 — aliases: a single-note read (never a multiNoteTools call — it answers for several
    // notes, naming none of them "the one") soon after a search that did NOT return this note
    // teaches that search's significant words as aliases of this note. Never alters the answer.
    if (cfg.learnAliases && id && !multi.has(call.tool) && s.lastSearch && s.lastSearch.words.length) {
      const elapsed = Date.now() - s.lastSearch.t;
      if (elapsed >= 0 && elapsed <= ALIAS_LEARN_WINDOW_MS && !s.lastSearch.resultIds.has(id)) {
        aliases.learn(id, s.lastSearch.words);
      }
    }

    // 8 — alreadyLoaded: a note memglow knows is loaded into the context at the start of every
    // session (the index, or a resolved `alwaysLoaded` entry). Skipped on an explicit section ask
    // (let 5/5b answer that) or "memglow_fresh" (the escape hatch) — every OTHER read of it keeps
    // getting the stub, unlike dedupe's "only the second+ read", since it was already there before
    // this session's first read too.
    //
    // 0.4.3.1 ("never stub the injection hook"): a session whose clientInfo matches
    // `alreadyLoadedExemptClients` (rule 1) never enters this block at all — not stubbed, not
    // even given the "changed since session start" notice below: the exact text the real server
    // would have sent, every time. This is what a SessionStart-style hook needs when ITS read of
    // the index is what injects it into the assistant's context in the first place — if THAT read
    // comes back as "already in your context", the session starts with no index at all.
    //
    // Independently, rule 2 (`alreadyLoadedRequireActivity`) only gates the STUB itself (not the
    // "changed" notice, which never shortens anything and is safe regardless): an injector
    // characteristically reads the index as the very first thing it does after `initialize`,
    // before any other tool call or `tools/list` — exactly the shape this rule refuses to stub,
    // name match or not. See bench/replay.js / CHANGELOG 0.4.3.1 for why it ships on by default.
    if (cfg.alreadyLoaded && canReplace && id && !call.fresh && !sectionRequested
        && !clientInfoExempt(s.clientInfo, cfg.alreadyLoadedExemptClients)
        && s.alreadyLoadedBaseline && s.alreadyLoadedBaseline.has(id)) {
      const baseline = s.alreadyLoadedBaseline.get(id);
      const current = index.fileHash(id);
      if (current && current === baseline) {
        if (!cfg.alreadyLoadedRequireActivity || call.priorActivity) {
          const stub = `memglow: "${label}" (≈${respTokens} tokens) is already in your context — it is loaded at the start of every session and has not changed since this session began (sha ${current.slice(0, 8)}). Use it from there. To get the full text anyway, call again with "${ARG_FRESH}": true.`;
          if (respTokens > estimateTokens(stub)) {
            savings.add("alreadyLoaded", respTokens - estimateTokens(stub), id);
            return { ...result, content: [block(stub)] };
          }
        }
        // else: rule 2 refuses the stub (no prior activity this session) — fall through to the
        // full, unaltered text below, exactly as if lever 8 had not matched this id at all.
      } else if (current) {
        // Changed since the start of this session: never stub a note the assistant's copy is now
        // outdated for — the full, current text instead, with a one-line heads-up.
        return { ...result, content: [...content, block(`memglow: "${label}" was already in your context at the start of this session, but it has changed since the start of this session (now sha ${current.slice(0, 8)}) — shown in full.`)] };
      }
      // current === null: the file cannot be read right now — stay silent and fall through below.
    }

    // 5b — one section on demand (sliced from the upstream answer, verbatim). Gated on cfg.toc OR
    // cfg.stateView: lever 17's own summary line names headings via this SAME argument (see
    // lib/levers/state-view.js's top comment), even when lever 5 (toc) itself is off.
    if ((cfg.toc || cfg.stateView) && canReplace && call.section != null && call.section !== "" && !call.fresh) {
      const spans = sectionSpans(text);
      const want = String(call.section).trim().replace(/^#+\s*/, "").toLowerCase();
      const num = /^\d+$/.test(want) ? Number(want) : 0;
      const i = num >= 1 && num <= spans.length ? num - 1 : spans.findIndex((x) => x.title.toLowerCase() === want);
      if (i >= 0) {
        const sp = spans[i];
        s.shortened.add(key);
        savings.add("toc", respTokens - sp.tokens, id);
        return { ...result, content: [block(`memglow: section ${i + 1}/${spans.length} of "${label}" (≈${sp.tokens} of ≈${respTokens} tokens). Add "${ARG_FRESH}": true for the whole note.`), block(text.slice(sp.start, sp.end))] };
      }
      // unknown section: fall through to the table of contents (it says so)
    }

    // A plain read right after a short answer (stub, outline or section) gets the full content.
    const askedSection = (cfg.toc || cfg.stateView) && call.section != null && call.section !== "";
    const forced = call.fresh || (!askedSection && s.shortened.has(key));
    s.shortened.delete(key);
    const hash = crypto.createHash("sha1").update(JSON.stringify(content)).digest("hex");

    // 4 — unchanged note already delivered in full in this session
    if (cfg.dedupe && canReplace && !forced) {
      const prev = s.delivered.get(key);
      const stub = prev && prev === hash
        ? `memglow: "${label}" is unchanged since you read it earlier in this session (≈${respTokens} tokens saved), so its content is not repeated. `
          + `If you need it again (for example if the earlier copy is no longer in your context), call ${call.tool} again with the same arguments plus "${ARG_FRESH}": true, or simply repeat the same call: the next read of this note returns the full content.`
        : null;
      // Only when it actually saves something: a tiny note is cheaper than the notice.
      if (stub && respTokens > estimateTokens(stub)) {
        s.shortened.add(key);
        savings.add("dedupe", respTokens - estimateTokens(stub), id);
        return { ...result, content: [block(stub)] };
      }
    }

    // 13 — deltaRead, mechanism 2: the gap dedupe's own stub does not cover — a note already
    // delivered in full THIS session (version A, kept in s.deltaText — dedupe's own s.delivered
    // only kept the HASH) has since CHANGED (prev !== hash, the `if` just above only matches
    // "unchanged"). The model already has A; only the diff to the current text (B) needs to
    // cross the wire. Falls through to a full delivery below when there is no version A to diff
    // against yet, the diff cannot be reconstructed, or it would not actually be smaller.
    if (cfg.deltaRead && canReplace && !forced && id && !multi.has(call.tool)) {
      const prevHash = s.delivered.get(key);
      const prevText = s.deltaText.get(key);
      if (prevHash && prevHash !== hash && typeof prevText === "string") {
        let diff = null;
        try { diff = deltaRead.renderDiff(prevText, text); } catch { diff = null; }
        if (deltaRead.worthDelivering(diff, text)) {
          const header = `memglow: "${label}" changed since you read it earlier in this session; only the changes below. Call ${call.tool} again with the same arguments plus "${ARG_FRESH}": true for the full text.`;
          const saved = respTokens - estimateTokens(header + diff.text);
          // Only when it actually saves something: same "a tiny note is cheaper than the notice"
          // rule as dedupe above — a diff that happens to be nearly as big as the header is not
          // worth sending instead of the full note.
          if (saved > 0) {
            // The model now effectively has B (A + this diff) — same session bookkeeping as a
            // genuine full delivery, so the NEXT read compares against B, not the stale A.
            s.delivered.set(key, hash);
            s.deltaText.set(key, text);
            s.shortened.add(key); // same "repeat the call -> full content" rule as 4/5/8
            // The cross-session ledger (mechanism 1) is refreshed too: this client HAS now seen
            // B, in full (A + this diff), even though it arrived as a diff — a LATER session's
            // first read must compare against B, not the stale version the ledger last recorded.
            if (deltaStore.available()) { try { deltaStore.set(clientBucket(s.clientInfo), id, { hash: deltaRead.sha1Hex(text), time: Date.now(), sections: deltaRead.sectionFingerprints(text) }); } catch { /* best effort */ } }
            savings.add("deltaRead", saved, id);
            return { ...result, content: [block(header), block(diff.text)] };
          }
        }
      }
    }

    // 17 — stateView: a journal-style note (>= 3 dated sections) gets its intro/rules/undated
    // sections plus its 2 most recent dated sections in full, with the older ones named (never
    // hidden) on one line — see lib/levers/state-view.js's own top comment for detection, year
    // inference and the full fail-open/ordering rules. Tried BEFORE lever 5 (toc) right below:
    // when it applies, toc's own big-note outline never also runs for the same read. `id` is
    // only used for the mtime lookup (year inference's anchor) and for per-note accounting below
    // — a note stateView cannot resolve an id for still gets a fair try, anchored on "now"
    // (buildStateView's own fallback). Like 4/13 above, a stateView answer never seeds
    // `s.delivered`/`s.deltaText`: the next read of this note is never diffed against a partial
    // text (see the module's own top comment, "ORDER WITH OTHER LEVERS").
    if (cfg.stateView && canReplace && !forced) {
      let sv = null;
      try {
        const st = id ? index.fileStat(id) : null;
        sv = buildStateView(text, {
          mtimeMs: st ? st.mtimeMs : Date.now(), minTokens: cfg.stateViewTokens, label, tool: call.tool,
          argSection: ARG_SECTION, argFresh: ARG_FRESH,
        });
      } catch { sv = null; }
      if (sv) {
        s.shortened.add(key); // same "repeat the call -> full content" rule as 4/5/8/13
        savings.add("stateView", sv.savedTokens, id);
        return { ...result, content: stateViewBlocks(sv) };
      }
    }

    // 5 — table of contents first for a large note
    if (cfg.toc && canReplace && !forced && tokens > T) {
      const spans = sectionSpans(text);
      if (spans.length >= 2) {
        const lines = [];
        if (cfg.sizeWarning && id && !s.warned.has(id)) { s.warned.add(id); lines.push(sizeWarning(note, tokens, false)); }
        const missing = call.section != null && call.section !== "" ? ` Section ${JSON.stringify(String(call.section))} was not found.` : "";
        lines.push(`memglow: "${label}" is ≈${respTokens} tokens (threshold ${T}), so only its outline is shown.${missing}`);
        if (note && note.description) lines.push(`Description: ${oneLine(note.description, 300)}`);
        lines.push("Sections:");
        spans.forEach((sp, k) => lines.push(`${k + 1}. ${sp.title ? "#".repeat(sp.level) + " " + oneLine(sp.title, 120) : "(intro)"} (≈${sp.tokens} tokens)`));
        lines.push(`To read one section, call ${call.tool} again with the same arguments plus "${ARG_SECTION}": "<heading or number>". For the whole note, add "${ARG_FRESH}": true, or simply repeat the same call.`);
        const toc = lines.join("\n");
        s.shortened.add(key);
        savings.add("toc", respTokens - estimateTokens(toc), id);
        return { ...result, content: [block(toc)] };
      }
    }

    // full delivery (upstream content untouched) + levers 1, 3 and 13
    if (!multi.has(call.tool)) { s.delivered.set(key, hash); s.deltaText.set(key, text); }
    const before = [], after = [];
    const isIndex = !!(note && note.theme === "index");
    // 13 — deltaRead, mechanism 1: the FIRST read of this note in THIS session always gets the
    // full text above (never shortened for this reason) — this only ever ADDS a one-line header,
    // at most once, when THIS CLIENT's own persisted ledger shows the note changed since the
    // last time it read it, in an EARLIER session. The ledger itself is refreshed on every full
    // delivery (not only the first), so the next SESSION's first read always compares against
    // the truly latest version this client has seen, not a stale first-read snapshot.
    if (cfg.deltaRead && id && !multi.has(call.tool) && deltaStore.available()) {
      const clientKey = clientBucket(call.client || s.clientInfo);
      if (firstReadThisSession) {
        let hdr = null;
        try { hdr = deltaRead.crossSessionHeader(deltaStore.get(clientKey, id), text); } catch { hdr = null; }
        if (hdr) before.push(block(hdr));
      }
      try { deltaStore.set(clientKey, id, { hash: deltaRead.sha1Hex(text), time: Date.now(), sections: deltaRead.sectionFingerprints(text) }); } catch { /* best effort */ }
    }
    if (isIndex && cfg.indexWarning && tokens > (cfg.indexWarningTokens || 2000)) {
      // The index is loaded at every session: its own threshold and hint (lever indexWarning).
      if (!s.warned.has(id)) {
        s.warned.add(id);
        before.push(block(`⚠ memglow: the index note "${oneLine(note.label, 80)}" is ≈${tokens} tokens (index threshold ${cfg.indexWarningTokens || 2000}) and it is loaded at every session. Consider offering the user to trim it: one short line per note, details moved into the notes themselves.`));
      }
    } else if (cfg.sizeWarning && tokens > T && !s.warned.has(id || key)) { s.warned.add(id || key); before.push(block(sizeWarning(note, tokens, false))); }
    if (cfg.suggestions && id && !s.suggested.has(id)) {
      const exclude = new Set(s.read);
      const rel = index.related(id, cfg.suggestionsMax, exclude);
      if (rel.length) { s.suggested.add(id); after.push(block(`memglow: related notes: ${rel.map((n) => `${oneLine(n.label, 80)} \`${n.id}\` (≈${n.tokens} tokens)`).join(", ")}`)); }
    }
    // 12 — indexHint: reading the index directly, while lever 8 (alreadyLoaded) is off (if it
    // were on, this read would already have been stubbed above instead) — point to the line(s)
    // that match whatever search most recently led here (same correlation window as lever 10's
    // own `s.lastSearch`). No recent search at all: nothing to grep against, nothing added.
    if (isIndex && cfg.indexHint && !cfg.alreadyLoaded && id) {
      const recentWords = s.lastSearch && (Date.now() - s.lastSearch.t) <= ALIAS_LEARN_WINDOW_MS ? s.lastSearch.words : [];
      const lines = indexHintLines(index, id, recentWords);
      if (lines.length) after.push(indexHintBlock(lines));
    }
    if (!before.length && !after.length) return null;
    return { ...result, content: [...before, ...content, ...after] };
  }


  // 6 — nothing in the live memory: the archive summary's matching titles (never archived text).
  function archiveHint(call, result, text, ids) {
    const live = ids.filter((id) => !index.isArchive(id));
    if (live.length || !(ids.length || emptyAnswer(text))) return null;
    const entries = index.archiveEntries();
    if (!entries.length) return null;
    const q = queryOf(call.args);
    const hits = archive.matchEntries(entries, q, cfg.archiveHintMax);
    const sumId = cfg.archive.summaryNote;
    const msg = hits.length
      ? `memglow: nothing found in the live memory — the archive summary lists: ${hits.map((e) => `"${oneLine(e.title, 80)}" (from \`${e.from}\`, archived ${e.date} in \`${e.archive}\`, ≈${e.tokens} tokens)`).join("; ")}. Read one of these archived sections only if it may answer the question.`
      : `memglow: nothing found in the live memory — the archive summary (\`${sumId}\`, ${entries.length} archived section${entries.length === 1 ? "" : "s"}) lists no title matching this search.`;
    return { ...result, content: [...result.content, block(msg)] };
  }

  function handleSearch(call, result, s) {
    const needsIds = cfg.searchDetails || cfg.archiveHint || cfg.aliases || cfg.learnAliases || cfg.negativeCache || cfg.indexHint;
    if (!needsIds) return null;
    // The text is only needed by archiveHint (and then built lazily).
    let textMemo = null;
    const text = () => (textMemo != null ? textMemo : (textMemo = textOf(result.content) + (result.structuredContent ? "\n" + JSON.stringify(result.structuredContent) : "")));
    const ids = resultIds(index, result, cfg.searchDetailsMax);
    // Shared by levers 10 (aliases), 11 (negativeCache) and 12 (indexHint): the query's own
    // significant words (lib/learned-aliases.js significantWords — lowercased, masked,
    // stop-words dropped), computed once regardless of which lever ends up using it.
    const words = significantWords(queryOf(call.args));

    // 0.4.2.3 — correlation bookkeeping for the NEXT read, refreshed on every search regardless
    // of which lever actually consumes it: "another unrelated search" must end the PREVIOUS
    // search's 2-minute window, so this has to run even when the words end up unused. 0.4.2.6:
    // lever 12 (indexHint) reuses this same correlation for its own "read of the index right
    // after a search" case, so it needs `s.lastSearch` populated too, even with learnAliases off.
    if (cfg.learnAliases || cfg.indexHint) {
      s.lastSearch = { words, resultIds: new Set(ids), t: Date.now() };
    }

    let out = result, changed = false;

    // 11 — negativeCache: a cached "you searched this before and never read anything" goes
    // FIRST — see lib/negative-cache.js. Only ever ADDS a line: the results that follow right
    // after are always relayed unchanged, never hidden or reordered.
    if (cfg.negativeCache && negativeCache.available() && words.length) {
      const fp = index.fingerprint();
      if (fp != null) {
        negativeCache.forgetStale(fp); // "invalidate on any write" — see the module's top comment
        const hit = negativeCache.lookup(words, fp);
        if (hit) {
          out = { ...out, content: [block(`memglow: this search found nothing you used last time (${dayOf(hit.last)}); the memory has not changed since.`), ...out.content] };
          changed = true;
        }
      }
    }

    // 10 — aliases: a learned candidate goes next, before anything the levers below may add.
    if (cfg.aliases && aliases.available()) {
      aliases.forgetMissing((noteId) => !!index.note(noteId));
      const candidate = words.length ? aliases.match(words, new Set(ids), (noteId) => !!index.note(noteId)) : null;
      if (candidate) { out = { ...out, content: [aliasInjection(index, candidate, out), ...out.content] }; changed = true; }
    }

    if (cfg.archiveHint) {
      const r = archiveHint(call, out, text(), ids);
      if (r) { out = r; changed = true; }
    }

    // 12 — indexHint: this search's own results are ONLY the index note → point to the line(s)
    // of it that actually match the query, instead of making the model read (or guess at) the
    // whole thing. Never replaces anything: a suffix, like archiveHint/searchDetails below.
    if (cfg.indexHint && ids.length === 1) {
      const n = index.note(ids[0]);
      if (n && n.theme === "index") {
        const lines = indexHintLines(index, n.id, words);
        if (lines.length) { out = { ...out, content: [...out.content, indexHintBlock(lines)] }; changed = true; }
      }
    }

    if (cfg.searchDetails && ids.length) {
      // A note already read in full THIS session needs no teaser line at all: the assistant
      // already has its real content, not just a title/theme/description guess at it. This is
      // the main cost driver of this lever on a session with several searches over the same
      // working set (measured in bench/replay.js) — far more than the per-note description below.
      const reportIds = s ? ids.filter((id) => !s.read.has(id)) : ids;
      if (reportIds.length) {
        const rows = reportIds.map((id) => {
          const n = index.note(id);
          const theme = themeLabel(n.theme) + (n.subtheme && n.subtheme !== "general" ? "/" + n.subtheme : "");
          const size = `≈${n.tokens} tokens${n.tokens > T ? " (large)" : ""}`;
          // Description shown once per note per session: the assistant already has it after the
          // first search result that mentioned this note, repeating it on every later search
          // that turns up the same note again is a secondary cost driver.
          const already = s && s.searchDescribed.has(id);
          if (s) s.searchDescribed.add(id);
          const desc = !already && n.description ? " · " + oneLine(n.description, 100) : "";
          return `- ${oneLine(n.label, 80)} \`${n.id}\` · ${theme} · ${size}${desc}`;
        });
        out = { ...out, content: [...out.content, block("memglow: notes in these results (title `id` · theme · size · description):\n" + rows.join("\n"))] };
        changed = true;
      }
    }

    // 11 — negativeCache: this search's own pending "will it get read?" verdict. A NEW search
    // supersedes whatever was pending before in this SAME session: by definition no read came
    // between them, so the OLD one is now provably "no read at all" — recorded now, regardless
    // of whether ALIAS_LEARN_WINDOW_MS has fully elapsed yet (a second search starting is
    // already proof enough; the window itself is only enforced in handleRead/handleWrite, for
    // the "nothing at all happens next" and "a read arrives, but late" cases).
    if (cfg.negativeCache && negativeCache.available()) {
      finalizePending(s);
      const fp = index.fingerprint();
      s.pendingNegative = (words.length && fp != null) ? { words, fingerprint: fp, t: Date.now() } : null;
    }

    return changed ? out : null;
  }

  function handleWrite(call, result, s) {
    // 11 — negativeCache: a write is not a read either — same "supersedes whatever was pending"
    // rule as a new search, above. Runs even when sizeWarning/duplicateHint (below) are off.
    if (cfg.negativeCache && negativeCache.available()) finalizePending(s);
    if (cfg.negativeCache || cfg.sizeWarning || cfg.duplicateHint || cfg.hubHint || cfg.orphanHint) index.afterWrite();
    if (cfg.negativeCache) negativeCache.forgetStale(index.fingerprint());

    const before = [], after = [];

    if (cfg.sizeWarning) {
      let id = null;
      for (const r of [...noteRefsInArgs(call.args), ...permalinksIn(textOf(result.content))]) { id = index.resolve(r); if (id) break; }
      const note = id ? index.note(id) : null;
      // 0.4.5.1b: the size comes from the file as it is NOW, never from the index alone (which
      // could still hold the note from before this write). A file not modified since this call
      // was sent (the server has not written it yet, or wrote elsewhere) gets no warning at all:
      // a stale size is worse than none. 2 s of slack for clock/mtime granularity.
      const st = note ? index.fileStat(id) : null;
      const fresh = !!st && (typeof call.startedAt !== "number" || st.mtimeMs >= call.startedAt - 2000);
      const tokens = st ? Math.ceil(st.size / 4) : 0;
      if (note && fresh && tokens > T && !s.warned.has(id)) {
        s.warned.add(id);
        before.push(block(sizeWarning(note, tokens, true)));
      }
    }

    // 14 — duplicateHint: the candidate(s) were already matched in `oneFromClient`, BEFORE this
    // write changed the index (`call.duplicateHint`); here we only decide whether to show them
    // (same note never hinted twice in one session) and build the one advisory line. Exact wins
    // outright over similar — see duplicateHintFor()'s own comment.
    if (cfg.duplicateHint && call.duplicateHint) {
      const dh = call.duplicateHint;
      let hintBlock = null;
      if (dh.exact) {
        if (!s.duplicateHinted.has(dh.exact)) {
          hintBlock = duplicateHintBlock(index, dh.exact, null);
          s.duplicateHinted.add(dh.exact);
        }
      } else if (dh.similar && dh.similar.length) {
        const fresh = dh.similar.filter((id) => !s.duplicateHinted.has(id));
        if (fresh.length) {
          hintBlock = duplicateHintBlock(index, null, fresh);
          for (const id of fresh) s.duplicateHinted.add(id);
        }
      }
      if (hintBlock) after.push(hintBlock);
    }

    // 15 — slugHint: advisory only, after a successful write_note (never edit_note/move_note).
    if (cfg.slugHint && call.tool === "write_note") {
      let b = null;
      try { b = slugHintFor(call.args, cfg.memoryDir); } catch { b = null; }
      if (b) after.push(b);
    }

    // 16 — hubHint: an append-like edit_note (append / prepend / insert_before_section /
    // insert_after_section — never find_replace or replace_section, which target a specific,
    // already-chosen spot, not "whatever's at the end") or a write_note overwrite that adds more
    // than hubHintTokens of new content, estimated from the call's own `content` argument, to a
    // note that HAS parts. Same hub never hinted twice in one session (s.hubHinted).
    if (cfg.hubHint) {
      const qualifies = (call.tool === "edit_note" && HUB_HINT_EDIT_OPS.has(call.args.operation))
        || (call.tool === "write_note" && call.args.overwrite === true);
      const content = qualifies && typeof call.args.content === "string" ? call.args.content : "";
      if (qualifies && content && estimateTokens(content) > cfg.hubHintTokens) {
        const ref = call.tool === "edit_note" ? call.args.identifier : call.args.title;
        const hubId = typeof ref === "string" ? index.resolve(ref) : null;
        let b = null;
        if (hubId && !s.hubHinted.has(hubId)) {
          try { b = hubHintFor(index, hubId, content); } catch { b = null; }
          if (b) s.hubHinted.add(hubId);
        }
        if (b) after.push(b);
      }
    }

    // orphanHint (0.5.3) — a brand-new note (call.orphanCandidate, matched BEFORE the write in
    // oneFromClient) that memglow's own graph — rescanned just above — finds no link to or from,
    // either direction. The id is resolved the SAME way sizeWarning resolves it (the call's own
    // args, else a permalink the server's answer names): the server, not this lever, decides the
    // actual id/path a title ends up at. Index notes never qualify (excluded the same way
    // duplicateHint/hubHint exclude them); same note never hinted twice per session.
    if (cfg.orphanHint && call.tool === "write_note" && call.orphanCandidate) {
      let id = null;
      for (const r of [...noteRefsInArgs(call.args), ...permalinksIn(textOf(result.content))]) { id = index.resolve(r); if (id) break; }
      const note = id ? index.note(id) : null;
      if (note && note.theme !== "index" && !s.orphanHinted.has(id) && !index.linked(id)) {
        after.push(orphanHintFor(id));
        s.orphanHinted.add(id);
      }
    }

    if (!before.length && !after.length) return null;
    return { ...result, content: [...before, ...result.content, ...after] };
  }

  function oneFromServer(m, s) {
    // Only responses (no "method"): a server-to-client request may reuse an id of ours.
    if (!m || typeof m !== "object" || m.id == null || "method" in m) return m;
    const key = String(m.id);
    const call = s.pending.get(key);
    if (!call) return m;
    s.pending.delete(key);
    // 0.4.10.9: one count per tools/call — tokens as answered, BEFORE any lever shortens it.
    if (!call.list) { try { savings.addClient(call.client, answerTokens(m)); } catch { /* informative only */ } }
    if (m.error || !m.result || typeof m.result !== "object" || m.result.isError) return m;
    if (call.list) { const r = augmentList(m.result, s); return r ? { ...m, result: r } : m; }
    if (!Array.isArray(m.result.content)) return m;
    const wrap = isTextWrap(m.result);
    let r = null;
    if (call.kind === "read") r = handleRead(call, m.result, s);
    else if (call.kind === "search") r = handleSearch(call, m.result, s);
    else if (call.kind === "write") r = handleWrite(call, m.result, s);
    // Keep a FastMCP text wrapper in step with the change: it is what some clients show the model.
    if (r && wrap) r = { ...r, structuredContent: { result: r.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n\n") } };
    return r ? { ...m, result: r } : m;
  }

  function apply(msg, sessionKey, fn, hints) {
    const s = session(sessionKey);
    try {
      if (Array.isArray(msg)) {
        const out = msg.map((m) => fn(m, s, hints));
        return out.some((m, i) => m !== msg[i]) ? { msg: out, changed: true } : { msg, changed: false };
      }
      const out = fn(msg, s, hints);
      return { msg: out, changed: out !== msg };
    } catch (e) {
      return { msg, changed: false }; // a lever bug must never break the relay
    }
  }

  return {
    /** `hints` (optional, 0.4.10.9): { userAgent } — the HTTP User-Agent, an accounting fallback. */
    clientMessage: (msg, sessionKey, hints) => apply(msg, sessionKey, oneFromClient, hints),
    serverMessage: (msg, sessionKey) => apply(msg, sessionKey, oneFromServer),
    /**
     * 0.4.9.1: moves a session's state to another key — the standalone HTTP proxy keys an
     * `initialize` by its connection, then by the Mcp-Session-Id the upstream hands out for it.
     */
    renameSession(from, to) {
      const f = String(from || "default"), t = String(to || "default");
      if (f === t || !sessions.has(f)) return;
      const s = sessions.get(f);
      sessions.delete(f);
      if (sessions.has(t)) finalizePending(sessions.get(t)); // replaced: settle its pending search
      sessions.set(t, s);
    },
    /** True if a response to this request id is awaited by a lever (HTTP mode buffers only those). */
    wants: (ids, sessionKey) => { const s = session(sessionKey); return ids.some((id) => id != null && s.pending.has(String(id))); },
    /**
     * Lever 11 (negativeCache) — settles every session's still-pending search (if any) as
     * futile right now, same as a session being evicted from the LRU map. Meant for the host
     * process's own shutdown path (mirrors `savings.flush()`/`aliasStore.flush()` in
     * mcp-proxy/memglow-mcp-proxy.js): a search genuinely never followed by anything else before
     * the process exits is still "no read at all", not silently lost.
     */
    negativeCache: { flushPending() { for (const s of sessions.values()) finalizePending(s); } },
    /**
     * Lever 9 (multiQuery) — bypasses the normal 1 request : 1 response `clientMessage`/
     * `serverMessage` cycle entirely: a request this returns true for is handled by `run()`
     * instead (the transport never forwards it, and never feeds its sub-calls' responses back
     * into `serverMessage` — see mcp-proxy/memglow-mcp-proxy.js and bench/replay.js).
     */
    multiQuery: {
      applies(reqMsg) {
        if (!cfg.multiQuery || !reqMsg || reqMsg.method !== "tools/call" || !reqMsg.params) return false;
        const { name, arguments: a } = reqMsg.params;
        return typeof name === "string" && searchTools.has(name) && !!a && typeof a === "object" && !!planMultiQuery(a);
      },
      /** `sendUpstream(args) -> Promise<{result}|{error}>`, one call with the tool fixed to
       * reqMsg.params.name. `sessionKey` is the same session identifier `clientMessage`/
       * `serverMessage` take (stdio: omitted, "default"; HTTP: the Mcp-Session-Id) — needed so
       * lever 10 (aliases/learnAliases) can learn from and inject into this merged result the
       * same way it does for a normal single-phrasing search (see applyAliasesToSearch above).
       * Returns `{ message: {jsonrpc, id, result|error}, calls }`. */
      async run(reqMsg, sendUpstream, sessionKey, hints) {
        const args = (reqMsg.params && reqMsg.params.arguments) || {};
        // 0.4.10.9: the identity is taken now (it may be remembered from this request's `_meta`).
        let client = null;
        try { client = identityFor(session(sessionKey), reqMsg.params, hints); } catch { client = null; }
        const r = await runSearchCall(cfg, index, args, sendUpstream);
        let message = r.message;
        // One client call, counted once (its sub-calls never go through serverMessage).
        try { savings.addClient(client, answerTokens(message)); } catch { /* informative only */ }
        if (message && message.result && (cfg.aliases || cfg.learnAliases)) {
          const plan = planMultiQuery(args);
          const phrasings = plan ? plan.phrasings : [queryOf(args)];
          const s = session(sessionKey);
          const newResult = applyAliasesToSearch(cfg, index, aliases, s, phrasings, message.result);
          if (newResult !== message.result) message = { ...message, result: newResult };
        }
        // MCP 2026-07-28 requires `resultType` on every result: a safety net for a merged answer
        // whose phrasings carried none (the per-request `_meta` says the client speaks it).
        const meta = reqMsg.params && reqMsg.params._meta;
        const pv = meta && typeof meta === "object" ? meta["io.modelcontextprotocol/protocolVersion"] : null;
        if (message && message.result && typeof message.result === "object" && !("resultType" in message.result) && typeof pv === "string" && pv >= "2026-") {
          message = { ...message, result: searchMeta.copy(message.result, { ...message.result, resultType: "complete" }) };
        }
        return { message: { jsonrpc: "2.0", id: reqMsg.id, ...message }, calls: r.calls };
      },
    },
  };
}

module.exports = {
  proxyConfig, anyLever, createNoteIndex, createSavings, createLevers, DEFAULTS, ARG_FRESH, ARG_SECTION,
  // Control panel (0.4.7.2+) — see the module's own comment above proxyControl().
  proxyControl, LEVER_META, LEVER_INT_CAPS,
  DEFAULT_UNSUPPORTED_TOOLS, OPENAI_MCP_CLIENT_NAME, clientInfoAllowed, clientInfoKnown, clientBucket,
  // Lever 8 rule 1 (0.4.3.1) — see the module's top comment.
  clientInfoExempt,
  readClientSavings, CLIENT_TOKENS_WINDOW_DAYS,
  // Lever 9 (multiQuery) — see the module's top comment.
  ARG_QUERIES, MULTI_QUERY_MAX, MULTI_QUERY_LEN_MAX, queryKeyOf, queryOf, planMultiQuery, rankKeys,
  mergeRankedIds, mergeSearchResults, hitChunksOf, runSearchCall, resultIds, hitRow, isPlainTextResult,
  // Lever 10 (aliases, 0.4.2.3 + 0.4.2.4) — see the module's top comment and lib/learned-aliases.js.
  ALIAS_LEARN_WINDOW_MS, aliasInjection, applyAliasesToSearch,
  // Levers 11 (negativeCache) and 12 (indexHint), 0.4.2.6 — see the module's top comment and
  // lib/negative-cache.js.
  indexHintLines, indexHintBlock, INDEX_HINT_MAX_LINES, INDEX_HINT_LINE_MAX,
  // Lever 14 (duplicateHint), 0.4.4.1 — see the module's top comment.
  duplicateHintCandidates, duplicateHintBlock, duplicateHintFor, noteWords,
  DUPLICATE_HINT_MIN_SHARED, DUPLICATE_HINT_COVERAGE, DUPLICATE_HINT_MAX_CANDIDATES,
  // 0.4.10.9: per-client accounting identity (MCP 2026-07-28 `_meta`, User-Agent) and lever 15.
  metaClientInfo, userAgentClientInfo, slugHintFor, KEBAB_SLUG_RE,
  // Lever 16 (hubHint), 0.4.11.1 — see the module's top comment.
  parsePartsSection, hubPartsFor, hubHintFor, HUB_HINT_EDIT_OPS, HUB_HINT_MAX_PARTS,
  // Lever 17 (stateView), 0.5.1.2 — see lib/levers/state-view.js's own top comment.
  buildStateView, stateViewBlocks,
  // orphanHint, 0.5.3 — see lib/levers/orphan-hint.js's own top comment.
  orphanHintFor,
};
