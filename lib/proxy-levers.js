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
 * Escape hatch for 4, 5, 8 and 13: the argument `memglow_fresh: true` (added to the read tools' schemas
 * in `tools/list`, stripped before the call reaches the server), or simply repeating the same read:
 * the read that follows a short answer always returns the full upstream content (lever 8 does not
 * need the repeat: fresh is enough, since it would otherwise stub every matching read again).
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemory, maskSecrets } = require("./memory");
const { createCounters } = require("./counters");
const { estimateTokens, sectionSpans, dayOf } = require("./cost");
const { rankRelated } = require("./related");
const { idsInText } = require("./agent-core");
const archive = require("./archive");
const { CLIENTS } = require("./clients");
const { significantWords } = require("./learned-aliases");
const { memoryFingerprint } = require("./negative-cache");
const deltaRead = require("./delta-read");

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
const ARG_FRESH = "memglow_fresh";
const ARG_SECTION = "memglow_section";
const ARG_QUERIES = "memglow_queries";
const MULTI_QUERY_MAX = 4; // memglow_queries: at most this many entries (tools/list maxItems)
const MULTI_QUERY_LEN_MAX = 200; // each phrasing, trimmed
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
// Lever 10 (aliases): a read within this long after a search, with no OTHER search in between,
// may still teach that search's words to the note it reads (see lib/learned-aliases.js).
const ALIAS_LEARN_WINDOW_MS = 2 * 60 * 1000;

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
 * Proxy settings: MEMGLOW_CONFIG (a memglow.config.json), else ~/.memglow/memglow.config.json
 * (written by `memglow init`), then environment overrides. Never throws.
 */
function proxyConfig(env = process.env) {
  const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
  const file = env.MEMGLOW_CONFIG || path.join(home, "memglow.config.json");
  const cfg = readJson(file) || {};
  const p = cfg.proxy && typeof cfg.proxy === "object" ? cfg.proxy : {};
  const base = env.MEMGLOW_CONFIG ? path.dirname(path.resolve(env.MEMGLOW_CONFIG)) : process.cwd();
  const dir = env.MEMGLOW_MEMORY_DIR || env.MEMORY_DIR || cfg.memoryDir || "";
  const themes = Array.isArray(cfg.themes) && cfg.themes.length ? cfg.themes.filter((t) => t && typeof t.id === "string") : DEFAULT_THEMES;
  return {
    sizeWarning: flag(env.MEMGLOW_PROXY_SIZE_WARNING, p.sizeWarning, DEFAULTS.sizeWarning),
    indexWarning: flag(env.MEMGLOW_PROXY_INDEX_WARNING, p.indexWarning, DEFAULTS.indexWarning),
    indexWarningTokens: int(cfg.indexWarningTokens, 2000, 100, 1000000),
    searchDetails: flag(env.MEMGLOW_PROXY_SEARCH_DETAILS, p.searchDetails, DEFAULTS.searchDetails),
    suggestions: flag(env.MEMGLOW_PROXY_SUGGESTIONS, p.suggestions, DEFAULTS.suggestions),
    dedupe: flag(env.MEMGLOW_PROXY_DEDUPE, p.dedupe, DEFAULTS.dedupe),
    toc: flag(env.MEMGLOW_PROXY_TOC, p.toc, DEFAULTS.toc),
    archiveHint: flag(env.MEMGLOW_PROXY_ARCHIVE_HINT, p.archiveHint, DEFAULTS.archiveHint),
    archiveHintMax: int(p.archiveHintMax, DEFAULTS.archiveHintMax, 1, 20),
    hideUnsupportedTools: flag(env.MEMGLOW_PROXY_HIDE_UNSUPPORTED, p.hideUnsupportedTools, DEFAULTS.hideUnsupportedTools),
    unsupportedTools: unsupportedToolsOf(p.unsupportedTools),
    multiQuery: flag(env.MEMGLOW_PROXY_MULTI_QUERY, p.multiQuery, DEFAULTS.multiQuery),
    // Lever 10 (aliases, lib/learned-aliases.js): `aliases` gates injection, `learnAliases`
    // gates recording — independent switches, see DEFAULTS.aliases above.
    aliases: flag(env.MEMGLOW_PROXY_ALIASES, p.aliases, DEFAULTS.aliases),
    learnAliases: flag(env.MEMGLOW_PROXY_LEARN_ALIASES, p.learnAliases, DEFAULTS.learnAliases),
    aliasesMax: int(p.aliasesMax, 2000, 50, 20000),
    // Lever 11 (negativeCache, lib/negative-cache.js): a single switch gates both recording and
    // using the hint — see that module's top comment for why.
    negativeCache: flag(env.MEMGLOW_PROXY_NEGATIVE_CACHE, p.negativeCache, DEFAULTS.negativeCache),
    negativeCacheMax: int(p.negativeCacheMax, DEFAULTS.negativeCacheMax, 50, 20000),
    // Lever 12 (indexHint): no separate max/window — it reuses ALIAS_LEARN_WINDOW_MS and
    // searchDetailsMax-style small caps baked into lib/proxy-levers.js itself.
    indexHint: flag(env.MEMGLOW_PROXY_INDEX_HINT, p.indexHint, DEFAULTS.indexHint),
    // Lever 13 (deltaRead, lib/delta-read.js): a single switch gates both mechanisms (the
    // cross-session header and the within-session diff) — see DEFAULTS.deltaRead above.
    deltaRead: flag(env.MEMGLOW_PROXY_DELTA_READ, p.deltaRead, DEFAULTS.deltaRead),
    deltaReadMax: int(p.deltaReadMax, DEFAULTS.deltaReadMax, 50, 50000),
    // Lever 14 (duplicateHint) — see DEFAULTS.duplicateHint above.
    duplicateHint: flag(env.MEMGLOW_PROXY_DUPLICATE_HINT, p.duplicateHint, DEFAULTS.duplicateHint),
    // Lever 8: OFF unless the user turns it on (memglow cannot know the host re-injects the index
    // at session start). "Known always loaded" = the index note(s) + this list, same shape and
    // same caps as the main config's own `alwaysLoaded` (lib/config.js) — paths that are not notes
    // (CLAUDE.md, AGENTS.md…) are harmless here: resolve() simply never matches them.
    alreadyLoaded: flag(env.MEMGLOW_PROXY_ALREADY_LOADED, p.alreadyLoaded, DEFAULTS.alreadyLoaded),
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
    largeNoteTokens: int(env.MEMGLOW_LARGE_NOTE_TOKENS || cfg.largeNoteTokens, 5000, 200, 1000000),
    memoryDir: dir ? path.resolve(base, dir) : null,
    dataDir: path.resolve(base, env.MEMGLOW_DATA_DIR || cfg.dataDir || home),
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
function anyLever(c) { return !!(c && (c.sizeWarning || c.indexWarning || c.searchDetails || c.suggestions || c.dedupe || c.toc || c.archiveHint || c.hideUnsupportedTools || c.alreadyLoaded || c.multiQuery || c.aliases || c.learnAliases || c.negativeCache || c.indexHint || c.deltaRead || c.duplicateHint)); }

// ---------------------------------------------------------------------------------------------
// Note metadata (read-only, cached)

/**
 * Note metadata from the notes folder, cached: the folder is rescanned at most once per pollMs
 * (stat only for unchanged files, lib/memory.js), and the derived maps are rebuilt only when the
 * memory version changes. Without a notes folder every lookup returns null.
 */
function createNoteIndex(cfg) {
  let memory = null;
  try { if (cfg.memoryDir && fs.statSync(cfg.memoryDir).isDirectory()) memory = createMemory({ dir: cfg.memoryDir, config: cfg.memory, pollMs: cfg.pollMs }); }
  catch { memory = null; }
  let cache = null, cacheVersion = -1;
  let summaryCache = null, summaryVersion = -1;

  function data() {
    if (!memory) return null;
    memory.refresh();
    if (cache && cacheVersion === memory.version()) return cache;
    const g = memory.graph();
    const byId = new Map(), byLabel = new Map(), outgoing = new Map(), incoming = new Map();
    for (const n of g.nodes) {
      byId.set(n.id, n);
      const l = String(n.label || "").toLowerCase();
      if (l && !byLabel.has(l)) byLabel.set(l, n.id);
    }
    for (const e of g.links) {
      (outgoing.get(e.source) || outgoing.set(e.source, []).get(e.source)).push(e.target);
      (incoming.get(e.target) || incoming.set(e.target, []).get(e.target)).push(e.source);
    }
    // Lever 11 (negativeCache): a cheap, global stand-in for "has anything changed" — see
    // lib/negative-cache.js's memoryFingerprint. Computed here, alongside the rest of this
    // derived cache, so it is recomputed only when the memory's own `version()` changes.
    cache = { byId, byLabel, outgoing, incoming, nodes: g.nodes, fingerprint: memoryFingerprint(g.nodes) };
    cacheVersion = memory.version();
    return cache;
  }

  /** A note reference (id, permalink, path, memory:// URL, title) → an existing note id, or null. */
  function resolve(raw) {
    const d = data();
    if (!d || typeof raw !== "string") return null;
    const s = raw.trim().replace(/^memory:\/\//i, "");
    if (!s) return null;
    const base = s.split(/[\\/]/).pop().replace(/\.md$/i, "").trim();
    const kebab = (x) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    for (const c of [s, base, base.replace(/_/g, "-"), base.toLowerCase(), base.replace(/_/g, "-").toLowerCase(), kebab(base)]) {
      if (c && SLUG_RE.test(c) && d.byId.has(c)) return c;
    }
    return d.byLabel.get(s.toLowerCase()) || d.byLabel.get(base.toLowerCase()) || null;
  }

  // Activity counters (co-usage) — read only, reloaded when the file changes (checked every 30 s).
  let counters = null, countersMtime = -1, countersChecked = 0;
  function days() {
    if (!cfg.dataDir) return null;
    const now = Date.now();
    if (now - countersChecked > 30000) {
      countersChecked = now;
      let mtime = -1;
      try { mtime = fs.statSync(path.join(cfg.dataDir, "activity-counts.json")).mtimeMs; } catch { mtime = -1; }
      if (mtime !== countersMtime) { countersMtime = mtime; counters = mtime >= 0 ? createCounters({ dir: cfg.dataDir }) : null; }
    }
    return counters ? counters.days() : null;
  }

  return {
    available: () => !!memory,
    note(id) { const d = data(); return d && id ? d.byId.get(id) || null : null; },
    /** Lever 14 (duplicateHint) — every note's own metadata ({ id, label, description, theme,
     * subtheme, tokens }), unfiltered: the caller excludes index/archive notes itself (theme,
     * isArchive). [] when there is no memory folder at all. */
    allNotes() { const d = data(); return d ? d.nodes : []; },
    /** Lever 11 (negativeCache) — the live memory's current fingerprint, or null when there is
     * no memory folder at all (never 0:0, which would be a real, matching fingerprint for an
     * EMPTY folder). */
    fingerprint() { const d = data(); return d ? d.fingerprint : null; },
    resolve,
    /**
     * After a successful write: rescan now so the new size is seen. Writes only (reads and searches
     * use the poll-interval cache); unchanged files cost one stat each.
     */
    afterWrite() {
      if (!memory) return;
      try { memory.scan(); } catch { /* keep the old view */ }
    },
    related(id, limit, exclude) {
      const d = data();
      const n = d && d.byId.get(id);
      if (!n) return [];
      return rankRelated({
        id, theme: n.theme, subtheme: n.subtheme, outgoing: d.outgoing.get(id) || [], incoming: d.incoming.get(id) || [],
        nodes: d.nodes.filter((x) => x.theme !== "index"), days: days(), limit, exclude,
      }).map((r) => d.byId.get(r.id));
    },
    /** True for a note of the archive folder (archive notes and the archive summary). */
    isArchive(id) {
      const rel = memory && id ? memory.fileOf(id) : null;
      return !!rel && !!cfg.archive && archive.inArchiveFolder(rel, cfg.archive.folder);
    },
    /** Entries of the archive summary note (lib/archive.js), [] when there is none. Cached per version. */
    archiveEntries() {
      if (!memory || !cfg.archive) return [];
      memory.refresh();
      if (summaryCache && summaryVersion === memory.version()) return summaryCache;
      let entries = [];
      const rel = memory.fileOf(cfg.archive.summaryNote);
      if (rel) { try { entries = archive.parseSummary(fs.readFileSync(path.join(cfg.memoryDir, rel), "utf8")) || []; } catch { entries = []; } }
      summaryCache = entries;
      summaryVersion = memory.version();
      return entries;
    },
    /**
     * Lever 8 (alreadyLoaded) — ids memglow knows are loaded at the start of every session: every
     * note of theme "index" (same rule as the indexWarning lever), plus any of `extraEntries`
     * (the main config's own `alwaysLoaded`, lib/always-loaded.js) that resolves to an existing
     * note. An entry that is not a note (an instruction file such as CLAUDE.md, outside the notes
     * folder) simply never resolves — harmless, just never matched here.
     */
    alwaysLoadedIds(extraEntries) {
      const d = data();
      const ids = new Set();
      if (!d) return ids;
      for (const n of d.nodes) if (n.theme === "index") ids.add(n.id);
      for (const e of extraEntries || []) { const rid = resolve(e); if (rid) ids.add(rid); }
      return ids;
    },
    /**
     * sha1 of this note's file, read directly off disk (never through the memory server) — or
     * null when it cannot be read right now. Used only to tell whether a note already stubbed by
     * lever 8 has changed since its hash was captured; never sent anywhere but the first 8 hex
     * characters, in the stub text itself.
     */
    fileHash(id) {
      if (!memory || typeof id !== "string" || !id) return null;
      try {
        const rel = memory.fileOf(id);
        if (!rel) return null;
        return crypto.createHash("sha1").update(fs.readFileSync(path.join(cfg.memoryDir, rel))).digest("hex");
      } catch { return null; }
    },
    _memory: () => memory,
  };
}

// ---------------------------------------------------------------------------------------------
// Savings (levers 4 and 5) + per-client accounting: stderr journal line + memglow's own data file

/**
 * Bucket a session's `clientInfo` (set from `initialize`, see oneFromClient) into one of
 * lib/clients.js's known ids ("claude-code", "cursor", …) when the client's name or title
 * matches one, case-insensitively, by id or by label; else the client's own raw name/title
 * (trimmed, capped), so an unlisted tool still gets its own bucket instead of being lumped
 * together; else "unknown" (no name/title sent at all — never guessed). Purely informative:
 * never used for an access or security decision (unlike lever 7's clientInfoKnown/clientInfoAllowed).
 */
function clientBucket(ci) {
  const raw = (ci && typeof ci.name === "string" && ci.name.trim()) || (ci && typeof ci.title === "string" && ci.title.trim()) || "";
  if (!raw) return "unknown";
  const low = raw.toLowerCase();
  const known = CLIENTS.find((c) => low === c.id || low === c.label.toLowerCase());
  return known ? known.id : raw.slice(0, 60);
}

/** Merges `{ clientBucket: { tokens, calls } }` maps (used when flushing `pending` into the file). */
function mergeClientCounts(base, add) {
  const out = { ...(base || {}) };
  for (const [name, v] of Object.entries(add || {})) {
    const cur = out[name] && typeof out[name] === "object" ? out[name] : { tokens: 0, calls: 0 };
    out[name] = { tokens: (Number(cur.tokens) || 0) + (Number(v.tokens) || 0), calls: (Number(cur.calls) || 0) + (Number(v.calls) || 0) };
  }
  return out;
}

function createSavings(cfg, write = (s) => process.stderr.write(s)) {
  const pending = {};
  let timer = null;
  const file = cfg.savingsFile && cfg.dataDir ? path.join(cfg.dataDir, "proxy-savings.json") : null;
  function save() {
    timer = null;
    if (!file) return;
    try {
      const cur = readJson(file) || {};
      const out = { version: 1, days: cur.days && typeof cur.days === "object" ? cur.days : {} };
      for (const [day, v] of Object.entries(pending)) {
        const o = out.days[day] && typeof out.days[day] === "object" ? out.days[day] : {};
        for (const k of ["dedupe", "toc", "alreadyLoaded", "deltaRead", "dedupeCalls", "tocCalls", "alreadyLoadedCalls", "deltaReadCalls"]) o[k] = (Number(o[k]) || 0) + (v[k] || 0);
        if (v.clients) o.clients = mergeClientCounts(o.clients, v.clients);
        out.days[day] = o;
        delete pending[day];
      }
      const keep = Object.keys(out.days).sort().slice(-90);
      out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* savings are informative only */ }
  }
  let total = { dedupe: 0, toc: 0, alreadyLoaded: 0, deltaRead: 0 };
  return {
    add(kind, tokens, id) {
      if (!(tokens > 0)) return;
      total[kind] = (total[kind] || 0) + tokens;
      if (cfg.log) { try { write(`memglow-mcp-proxy: ${kind} saved ≈${tokens} tokens${id ? ` on ${id}` : ""} (session total ≈${total.dedupe + total.toc + total.alreadyLoaded + total.deltaRead})\n`); } catch { /* ignore */ } }
      const day = dayOf(Date.now());
      const o = pending[day] || (pending[day] = {});
      o[kind] = (o[kind] || 0) + tokens;
      o[kind + "Calls"] = (o[kind + "Calls"] || 0) + 1;
      if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
    },
    /**
     * Baseline tokens relayed to this client for one read — BEFORE dedupe/toc shorten it, so two
     * clients reading the same notes compare on what memory they touched, not on which lever
     * happened to be on. Tallied per calendar day, per client bucket (clientBucket above).
     */
    addClient(clientInfo, tokens) {
      if (!(tokens > 0)) return;
      const name = clientBucket(clientInfo);
      const day = dayOf(Date.now());
      const o = pending[day] || (pending[day] = {});
      o.clients = o.clients || {};
      const cur = o.clients[name] || (o.clients[name] = { tokens: 0, calls: 0 });
      cur.tokens += tokens; cur.calls++;
      if (file && !timer) { timer = setTimeout(save, 2000); if (timer.unref) timer.unref(); }
    },
    flush() { if (timer) { clearTimeout(timer); save(); } },
    total: () => ({ ...total }),
    file,
  };
}

const CLIENT_TOKENS_WINDOW_DAYS = 7;

/**
 * Reads the per-client baseline tokens createSavings/addClient wrote, summed over the last
 * `windowDays` days of <dataDir>/proxy-savings.json — for the Memory cost panel's "By AI tool"
 * line (server.js, `/api/cost`). Counts only, never note content. Absent, unreadable or
 * clients-less file → `{ days, byClient: {} }` (an empty, still-valid answer, not an error); no
 * `dataDir` at all → null. Never throws.
 */
function readClientSavings(dataDir, { now = Date.now(), windowDays = CLIENT_TOKENS_WINDOW_DAYS } = {}) {
  if (!dataDir) return null;
  const raw = readJson(path.join(dataDir, "proxy-savings.json"));
  const byClient = {};
  if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") {
    const from = dayOf(now - (windowDays - 1) * 86400000);
    const today = dayOf(now);
    for (const [day, o] of Object.entries(raw.days)) {
      if (day < from || day > today || !o || typeof o !== "object" || !o.clients || typeof o.clients !== "object") continue;
      for (const [name, v] of Object.entries(o.clients)) {
        if (!name || !v || typeof v !== "object") continue;
        const cur = byClient[name] || (byClient[name] = { tokens: 0, calls: 0 });
        cur.tokens += Number(v.tokens) || 0;
        cur.calls += Number(v.calls) || 0;
      }
    }
  }
  return { days: windowDays, byClient };
}

// ---------------------------------------------------------------------------------------------
// The levers

const textOf = (content) => content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");

/**
 * FastMCP servers (basic-memory among them, `wrap_result`) send every text answer twice: in
 * `content`, and as structuredContent { result: <the same text> }. Some clients — Claude Code
 * included, checked with v2.1 — give the MODEL the structuredContent when there is one, so a lever
 * that changed only `content` would be invisible to it. Such a wrapper is recognised strictly (an
 * object with the single key `result`, a string equal to the text of an all-text `content`) and
 * kept in step with any change (oneFromServer); any other structuredContent is left alone, and
 * levers 4/5 still never replace such an answer.
 */
function isTextWrap(result) {
  const sc = result && result.structuredContent;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return false;
  const keys = Object.keys(sc);
  if (keys.length !== 1 || keys[0] !== "result" || typeof sc.result !== "string") return false;
  const c = result.content;
  return Array.isArray(c) && c.length > 0 && c.every((x) => x && x.type === "text" && typeof x.text === "string") && textOf(c) === sc.result;
}
const block = (text) => ({ type: "text", text });
const oneLine = (s, max) => { const t = maskSecrets(String(s || "")).replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
const PERMALINK_RE = /permalink["']?\s*[:=]\s*["']?([A-Za-z0-9_./-]{1,200})/gi;

function noteRefsInArgs(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  for (const k of ["identifier", "url", "uri", "id", "permalink", "path", "file_path", "filePath", "note", "name"]) {
    if (typeof args[k] === "string" && args[k]) out.push(args[k]);
  }
  if (typeof args.title === "string" && args.title) {
    if (typeof args.directory === "string") out.push(args.directory.replace(/^\/+|\/+$/g, "") + "/" + args.title);
    out.push(args.title);
  }
  return out;
}
function permalinksIn(text) {
  const out = [];
  for (const m of String(text).slice(0, 200000).matchAll(PERMALINK_RE)) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lever 7 — hideUnsupportedTools: per-client, per-session `tools/list` filtering.

/** A client is "known" once it has said a non-empty name or title in `initialize` — else caution: hide nothing. */
function clientInfoKnown(ci) {
  return !!(ci && ((typeof ci.name === "string" && ci.name.trim()) || (typeof ci.title === "string" && ci.title.trim())));
}

/**
 * Same rule as basic-memory's `client_info_is_openai_mcp()`: the client's reported name OR
 * title, trimmed and lower-cased, equals one of `allow` or starts with it followed by "/"
 * (so "openai-mcp" matches a future "openai-mcp/1.2" the same way it does upstream).
 */
function clientInfoAllowed(ci, allow) {
  for (const key of ["name", "title"]) {
    const raw = ci && ci[key];
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    for (const a of allow) {
      const al = String(a).trim().toLowerCase();
      if (al && (v === al || v.startsWith(al + "/"))) return true;
    }
  }
  return false;
}

/**
 * Lever 8 rule 1 (alreadyLoadedExemptClients) — true when this session's clientInfo `name` OR
 * `title` CONTAINS any of `substrings`, case-insensitively. Deliberately a substring match, unlike
 * clientInfoAllowed's exact-id-or-prefix match above: an injection hook's clientInfo is whatever
 * the host happens to send (e.g. "session-start-hook", "my-app/inject-memory"), never one of
 * memglow's own known client ids, so "hook"/"inject" alone has to catch it. No clientInfo at all
 * never matches (nothing to search) — rule 2 is what still protects an unnamed injector.
 */
function clientInfoExempt(ci, substrings) {
  if (!ci || !Array.isArray(substrings) || !substrings.length) return false;
  const hay = `${typeof ci.name === "string" ? ci.name : ""} ${typeof ci.title === "string" ? ci.title : ""}`.trim().toLowerCase();
  if (!hay) return false;
  for (const raw of substrings) {
    const needle = String(raw || "").trim().toLowerCase();
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}

/** The unsupported-tools table entry for this upstream server name, or null (nothing configured for it). */
function unsupportedTableFor(cfg, serverName) {
  const s = String(serverName || "").trim().toLowerCase();
  if (!s || !cfg.unsupportedTools) return null;
  if (cfg.unsupportedTools[s]) return cfg.unsupportedTools[s];
  for (const [k, v] of Object.entries(cfg.unsupportedTools)) if (k && (s.includes(k) || k.includes(s))) return v;
  return null;
}

/**
 * Tool names to drop from `tools/list` for this client, or null to drop none — no table for this
 * server, or the client never announced a name/title (unknown: never filtered, by design).
 */
function hiddenToolsFor(cfg, serverName, clientInfo) {
  const table = unsupportedTableFor(cfg, serverName);
  if (!table || !clientInfoKnown(clientInfo)) return null;
  const hidden = new Set();
  for (const [tool, allow] of Object.entries(table)) if (!clientInfoAllowed(clientInfo, allow)) hidden.add(tool);
  return hidden;
}

// ---------------------------------------------------------------------------------------------
// Lever 9 — multiQuery: one call, several phrasings (see the module's top comment, and the first
// rule of lib/memory-rules.js). Everything below is pure (no `cfg`/`index` closed over by a live
// session) so it is usable, and unit-testable, on its own — by createLevers (production) and by
// bench/replay.js (the free replay harness) alike.

const QUERY_KEYS = ["query", "q", "search_text", "text", "pattern", "keywords"];

/** The key holding the search text (basic-memory `query`, or a usual name), or null. */
function queryKeyOf(args) {
  if (!args || typeof args !== "object") return null;
  for (const k of QUERY_KEYS) if (typeof args[k] === "string" && args[k].trim()) return k;
  return null;
}
/** The search text the assistant sent, or "" when there is none. */
function queryOf(args) { const k = queryKeyOf(args); return k ? args[k].trim() : ""; }

/** An answer that says "nothing": empty, [], "results": [], "No results", "nothing found"… */
function emptyAnswer(text) {
  const t = String(text).trim();
  return !t || /^\[\s*\]$/.test(t) || /"results"\s*:\s*\[\s*\]/.test(t) || /\b(no (results?|matches|notes?|documents?) (were )?found|no results|no matches|nothing found|0 results)\b/i.test(t);
}

/**
 * `{ phrasings, queryKey }` when `args` carries a usable `memglow_queries` (ARG_QUERIES) on top of
 * its own query argument — `phrasings[0]` is always the original query, never a duplicate of it,
 * at most MULTI_QUERY_MAX total — or null when there is nothing to multiply: no recognisable query
 * argument, no `memglow_queries` array, or every entry in it is blank, not a string, longer than
 * MULTI_QUERY_LEN_MAX, or a repeat of a phrasing already kept. A null plan means "behave exactly
 * like a plain single search" (the caller still strips `memglow_queries` before forwarding).
 */
function planMultiQuery(args) {
  const queryKey = queryKeyOf(args);
  if (!queryKey) return null;
  const main = args[queryKey].trim();
  const raw = args && args[ARG_QUERIES];
  if (!Array.isArray(raw) || !raw.length) return null;
  const seen = new Set([main]);
  const phrasings = [main];
  for (const q of raw) {
    if (phrasings.length >= MULTI_QUERY_MAX) break;
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (!t || t.length > MULTI_QUERY_LEN_MAX || seen.has(t)) continue;
    seen.add(t);
    phrasings.push(t);
  }
  return phrasings.length >= 2 ? { phrasings, queryKey } : null;
}

/**
 * Ranks keys found across several phrasings' ordered hit lists: a key seen by MORE phrasings
 * ranks first ("a note found by several phrasings ranks higher"); ties broken by the best
 * (lowest) rank it had in any one phrasing, then by which phrasing found it first. Pure, no
 * notion of what a "key" is (a note id, or a synthetic one — see mergeSearchResults below).
 */
function rankKeys(perPhrasingKeyLists) {
  const score = new Map();
  (perPhrasingKeyLists || []).forEach((keys, pi) => (keys || []).forEach((key, ri) => {
    if (!key) return;
    const cur = score.get(key);
    if (!cur) score.set(key, { count: 1, bestRank: ri, firstPhrasing: pi });
    else cur.count++;
  }));
  return [...score.keys()].sort((a, b) => {
    const A = score.get(a), B = score.get(b);
    return B.count - A.count || A.bestRank - B.bestRank || A.firstPhrasing - B.firstPhrasing;
  });
}
/** rankKeys(), deduped by note id and capped to the upstream's usual result count. Pure, tested. */
function mergeRankedIds(perPhrasingIds, cap) {
  const order = rankKeys(perPhrasingIds);
  return cap > 0 ? order.slice(0, cap) : order;
}

/** Search results split into per-hit blocks the way basic-memory (and this proxy's own test
 * fixtures) separate them: a blank line. Good enough to reorder/dedup hits without understanding
 * any server's schema; text with no blank line is a single block. */
function chunksOf(text) {
  return String(text).split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
}
/** The note id a hit block names, via the same permalink/id sniffing the rest of this module uses. */
function chunkId(index, chunk) {
  for (const r of permalinksIn(chunk)) { const id = index.resolve(r); if (id) return id; }
  for (const r of idsInText(chunk)) { const id = index.resolve(r); if (id) return id; }
  return null;
}

/** One compact hit row for a note id — the "upstream's own format" lever 9 falls back to for its
 * tier B, and lever 10 (aliases) reuses verbatim for its own "upstream's own format" case below. */
function hitRow(index, id) { const n = index.note(id); return n ? `- ${oneLine(n.label, 80)} \`${n.id}\`` : `- \`${id}\``; }

/** True when `r` is a plain-text answer — every `content` item is text, and any
 * `structuredContent` is only the FastMCP text wrap (isTextWrap) — the shape mergeSearchResults'
 * tier A, and lever 10's own "upstream's own format" case, both require to be safe to add to. */
function isPlainTextResult(r) {
  return !!(r && Array.isArray(r.content) && r.content.length > 0
    && r.content.every((c) => c && c.type === "text" && typeof c.text === "string")
    && (!("structuredContent" in r) || isTextWrap(r)));
}

/** Indexes of a phrasing's frame chunks: the un-identified "# Heading" blocks before its first
 * other block, and the un-identified "---" blocks (plus what follows them) after its last one. */
function frameOf(chunks) {
  const out = new Set();
  for (let j = 0; j < chunks.length && !chunks[j].id && /^# /.test(chunks[j].text); j++) out.add(j);
  for (let j = chunks.length - 1; j >= 0 && !chunks[j].id && !out.has(j); j--) {
    if (/^-{3,}\s*(\n|$)/.test(chunks[j].text)) { for (let k = j; k < chunks.length; k++) out.add(k); }
    else if (!out.has(j + 1)) break;
  }
  return out;
}

/**
 * Merges several phrasings' successful search `result`s (responses[0] = the original query) into
 * ONE `result`, or null when it cannot be done safely — the caller then relays `responses[0]`
 * unchanged ("fail open"; see runSearchCall below). Three tiers:
 *  A. Every response is plain text (no `structuredContent` other than the FastMCP text wrap,
 *     isTextWrap()): split into hit blocks (chunksOf), dedup/rank by note id when one resolves,
 *     else by the block's own text (two byte-identical un-identifiable blocks still dedup; two
 *     different ones are both kept) — reassembled from the SERVER'S OWN blocks, "the upstream's
 *     own format", just reordered and deduped.
 *  B. Otherwise (a response has other structured content, or a non-text part): a compact text
 *     listing of whatever note ids resolve from each phrasing's full text, same style as lever 2
 *     (searchDetails).
 *  C. Neither tier found a single resolvable hit anywhere → null (fail open).
 * Capped to `cap` = the largest single phrasing's own hit count ("the upstream's usual result
 * count") in both tiers A and B.
 */
function mergeSearchResults(index, responses) {
  const isPlainText = isPlainTextResult;
  const perPhrasing = responses.map((r) => {
    const text = r ? textOf(r.content || []) : "";
    if (!text || emptyAnswer(text)) return { chunks: [] };
    return chunksOf(text).map((c) => ({ text: c, id: chunkId(index, c) }));
  }).map((chunks) => ({ chunks: Array.isArray(chunks) ? chunks : [] }));
  const cap = Math.max(0, ...perPhrasing.map((p) => p.chunks.length));
  if (!cap) return null; // nothing anywhere: let the caller relay responses[0] ("No results") as is

  if (responses.every(isPlainText)) {
    // 0.4.5.1: a page's own frame — a leading "# Title" block, a trailing "---" footer, as in
    // basic-memory's "# Search Results: q" / "---\n*N results | page …*" — is not a hit: identical
    // footers would otherwise rank first (found by every phrasing) and, with small pages, push the
    // real hits out of the cap. The first phrasing's frame is kept around the merged hits, the
    // other phrasings' frames are dropped; text without any frame block merges exactly as before.
    const frameIdx = perPhrasing.map((p) => frameOf(p.chunks));
    const hitsOf = (p, i) => p.chunks.filter((c, j) => !frameIdx[i].has(j));
    const hitLists = perPhrasing.map(hitsOf);
    const hitCap = Math.max(0, ...hitLists.map((h) => h.length));
    if (!hitCap) return null; // only frames (e.g. headers of empty pages): relay responses[0] as is
    const keysPerPhrasing = hitLists.map((h) => h.map((c) => c.id || "text:" + c.text));
    const textByKey = new Map();
    hitLists.forEach((h) => h.forEach((c) => { const k = c.id || "text:" + c.text; if (!textByKey.has(k)) textByKey.set(k, c.text); }));
    const order = rankKeys(keysPerPhrasing).slice(0, hitCap);
    const first = perPhrasing[0].chunks;
    const firstHit = first.findIndex((c, j) => !frameIdx[0].has(j));
    const head = (firstHit < 0 ? [] : first.slice(0, firstHit)).map((c) => c.text);
    let lastHit = -1;
    first.forEach((c, j) => { if (!frameIdx[0].has(j)) lastHit = j; });
    const tail = (lastHit < 0 ? [] : first.slice(lastHit + 1)).map((c) => c.text);
    const mergedText = head.concat(order.map((k) => textByKey.get(k)), tail).join("\n\n");
    const result = { content: [block(mergedText)] };
    return isTextWrap(responses[0]) ? { ...result, structuredContent: { result: mergedText } } : result;
  }

  const idsPerPhrasing = responses.map((r) => {
    const text = (r ? textOf(r.content || []) : "") + (r && r.structuredContent ? "\n" + JSON.stringify(r.structuredContent) : "");
    const ids = [];
    for (const ref of [...permalinksIn(text), ...idsInText(text)]) { const id = index.resolve(ref); if (id && !ids.includes(id)) ids.push(id); }
    return ids;
  });
  const merged = mergeRankedIds(idsPerPhrasing, cap);
  if (!merged.length) return null; // fail open: nothing resolvable at all
  const rows = merged.map((id) => hitRow(index, id));
  return { content: [block(`memglow: merged results across ${responses.length} phrasings:\n` + rows.join("\n"))] };
}

/**
 * Lever 10 (aliases) — the block added at the TOP of a search answer for a learned candidate
 * note `id` that this search's own results did not include. "The upstream's own format if
 * possible": when `result` is plain text (isPlainTextResult — reusing lever 9's own definition
 * of "safe to add a hit row to"), one more row in the exact shape lever 9's own tier B already
 * uses for a note it cannot otherwise show (`hitRow`) — it then reads like one more ordinary hit,
 * not a one-off marker. Otherwise (structured or non-text content, where no row shape can be
 * borrowed) a single compact, explicitly-labelled line, so the note is still named without
 * fabricating a shape this answer never had.
 */
function aliasInjection(index, id, result) {
  if (isPlainTextResult(result)) return block(hitRow(index, id));
  const n = index.note(id);
  const label = n ? oneLine(n.label, 80) : id;
  return block(`memglow: likely relevant — ${label} (${id}), learned from your past searches`);
}

/**
 * Lever 10 (aliases/learnAliases) for a multiQuery (lever 9) MERGED search result — the slice of
 * `handleSearch` below that `createLevers.multiQuery.run` cannot reach any other way: a request
 * carrying `memglow_queries` bypasses the normal `clientMessage`/`serverMessage` cycle entirely
 * (see the comment above `multiQuery` in `createLevers`'s return value), so without this call,
 * lever 10 neither learns from a multi-phrasing search (`s.lastSearch` is never set for it) nor
 * injects a learned candidate into one (the merged result never passes through `handleSearch`).
 *
 * `phrasings` is every phrasing actually sent upstream (the original query first, same as
 * `planMultiQuery`) — `s.lastSearch.words` is the UNION of each phrasing's own significant words
 * (order preserved, first occurrence wins), not just the main query's, so a note read right after
 * learns from every phrasing the model tried, not only the first. `resultIds` and the injection
 * rule (first learned candidate, prepended, never removing a row; upstream's-own-format when the
 * merged result is plain text) are otherwise identical to `handleSearch`'s own lever-10 slice.
 * Pure given its inputs; `aliases` may be the real store or `NOOP_ALIAS_STORE`. Returns `result`
 * unchanged (same reference) when there is nothing to learn or inject.
 */
function applyAliasesToSearch(cfg, index, aliases, s, phrasings, result) {
  if (!cfg.aliases && !cfg.learnAliases && !cfg.indexHint) return result;
  if (!result || !Array.isArray(result.content)) return result;
  const text = textOf(result.content) + (result.structuredContent ? "\n" + JSON.stringify(result.structuredContent) : "");
  const ids = [];
  for (const r of [...permalinksIn(text), ...idsInText(text)]) {
    const id = index.resolve(r);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= cfg.searchDetailsMax) break;
  }

  const words = [];
  const seen = new Set();
  for (const p of phrasings || []) for (const w of significantWords(p)) { if (!seen.has(w)) { seen.add(w); words.push(w); } }

  // Same correlation bookkeeping as handleSearch's 0.4.2.3 comment: refreshed regardless of
  // which part of this function ends up using it. 0.4.2.6: lever 12 (indexHint) needs it too —
  // see the same comment in handleSearch.
  if ((cfg.learnAliases || cfg.indexHint) && s) s.lastSearch = { words, resultIds: new Set(ids), t: Date.now() };

  if (cfg.aliases && aliases.available() && words.length) {
    aliases.forgetMissing((noteId) => !!index.note(noteId));
    const candidate = aliases.match(words, new Set(ids), (noteId) => !!index.note(noteId));
    if (candidate) return { ...result, content: [aliasInjection(index, candidate, result), ...result.content] };
  }
  return result;
}

/**
 * Runs one search `tools/call`'s arguments through the multiQuery lever. `sendUpstream(args) ->
 * Promise<{result}|{error}>` makes ONE upstream call with these exact arguments (never
 * `memglow_queries`) — the tool name is fixed by the caller (the real proxy writes a request and
 * awaits the matching response; bench/replay.js calls its in-process fake upstream). When
 * `cfg.multiQuery` is off, or `planMultiQuery` finds nothing to multiply, exactly one call is
 * made (memglow_queries stripped) — unchanged behaviour. Otherwise one call per phrasing,
 * SEQUENTIALLY, the original query first; any rejected or errored call stops the run and "fails
 * open": the FIRST phrasing's own result (or error) — what a plain single search would have
 * returned — is what comes back, never a partial merge. Never throws. Returns `{ message:
 * {result}|{error}, calls }`, `calls` being how many upstream calls were actually made.
 */
async function runSearchCall(cfg, index, args, sendUpstream) {
  const clean = { ...(args || {}) };
  delete clean[ARG_QUERIES];
  const plan = cfg.multiQuery ? planMultiQuery(args || {}) : null;
  if (!plan) {
    let message;
    try { message = await sendUpstream(clean); } catch (e) { message = { error: { code: -32000, message: "memglow multiQuery: " + ((e && e.message) || "upstream failed") } }; }
    return { message, calls: 1 };
  }
  const responses = [];
  for (const phrasing of plan.phrasings) {
    let r;
    try { r = await sendUpstream({ ...clean, [plan.queryKey]: phrasing }); } catch (e) { r = { error: { code: -32000, message: "memglow multiQuery: " + ((e && e.message) || "upstream failed") } }; }
    if (!r || r.error) return { message: responses.length ? { result: responses[0] } : (r || { error: { code: -32000, message: "memglow multiQuery: no response" } }), calls: responses.length + 1 };
    responses.push(r.result);
  }
  let merged = null;
  try { merged = mergeSearchResults(index, responses); } catch { merged = null; }
  return { message: { result: merged || responses[0] }, calls: responses.length };
}

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

// Lever 12 (indexHint) — small, fixed caps; not worth a config knob of their own.
const INDEX_HINT_MAX_LINES = 3;
const INDEX_HINT_LINE_MAX = 160;

/**
 * Lines of the index note's OWN text that mention at least one of `words` — "the index already
 * says" (lever 12, indexHint): grepped straight through the memory layer's own masked body
 * (lib/memory.js `maskedBody`, already secret-masked; `oneLine` masks again on top, harmless),
 * never more than INDEX_HINT_MAX_LINES, each capped to INDEX_HINT_LINE_MAX. Returns [] when
 * there is nothing to grep (no words, no readable body, no match) — the caller then adds
 * nothing, never a bare "says:" line with nothing after it.
 */
function indexHintLines(index, id, words) {
  if (!Array.isArray(words) || !words.length) return [];
  const mem = index && typeof index._memory === "function" ? index._memory() : null;
  const body = mem ? mem.maskedBody(id) : null;
  if (!body) return [];
  const lower = words.map((w) => w.toLowerCase());
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lc = line.toLowerCase();
    if (lower.some((w) => lc.includes(w))) {
      out.push(oneLine(line, INDEX_HINT_LINE_MAX));
      if (out.length >= INDEX_HINT_MAX_LINES) break;
    }
  }
  return out;
}
const indexHintBlock = (lines) => block("memglow: the index already says:\n" + lines.map((l) => "- " + l).join("\n"));

// ---------------------------------------------------------------------------------------------
// Lever 14 — duplicateHint: see the module's top comment. Pure helpers, testable alone: none of
// them touches `index.resolve`/`index.allNotes`/`index.isArchive` directly — the caller
// (duplicateHintFor, right below) does that and passes already-filtered data in.

const DUPLICATE_HINT_MIN_SHARED = 2;
const DUPLICATE_HINT_COVERAGE = 0.6;
const DUPLICATE_HINT_MAX_CANDIDATES = 2;

/** Significant words of a note's OWN identifying text (id + label + description) — the SAME
 * helper (EN+FR stop-words, secret-masked, >= 3 characters, lib/learned-aliases.js
 * significantWords) used for the title's own words, so a French title can match a French note
 * and an English one an English note, symmetrically. */
function noteWords(note) {
  return significantWords([note && note.id, note && note.label, note && note.description].filter(Boolean).join(" "));
}

/**
 * Candidate notes a `write_note`'s `title` is a likely duplicate of — conservative on purpose (a
 * false hint costs more than a missed one, see the module's top comment): a note only qualifies
 * when it shares >= DUPLICATE_HINT_MIN_SHARED of `titleWords` (significantWords(title), computed
 * by the caller) AND those shared words cover >= DUPLICATE_HINT_COVERAGE of `titleWords` itself —
 * a title with fewer than 2 significant words can never match anything, by construction (nothing
 * specific enough to compare). `notes` is a plain [{ id, label, description, tokens }] array,
 * already filtered by the caller (duplicateHintFor excludes index notes and notes in the archive
 * folder before calling this). Ranked by shared-word count (desc), then note size (desc — a
 * tie-break only, never a size preference), then id (for a deterministic order); capped to
 * DUPLICATE_HINT_MAX_CANDIDATES. Pure, never throws on malformed input.
 */
function duplicateHintCandidates(titleWords, notes) {
  if (!Array.isArray(titleWords) || titleWords.length < DUPLICATE_HINT_MIN_SHARED) return [];
  const titleSet = new Set(titleWords);
  const need = Math.max(DUPLICATE_HINT_MIN_SHARED, Math.ceil(titleWords.length * DUPLICATE_HINT_COVERAGE));
  const scored = [];
  for (const n of notes || []) {
    if (!n || typeof n.id !== "string" || !n.id) continue;
    const words = new Set(noteWords(n));
    let shared = 0;
    for (const w of titleSet) if (words.has(w)) shared++;
    if (shared >= DUPLICATE_HINT_MIN_SHARED && shared >= need) scored.push({ id: n.id, shared, tokens: Number(n.tokens) || 0 });
  }
  scored.sort((a, b) => b.shared - a.shared || b.tokens - a.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, DUPLICATE_HINT_MAX_CANDIDATES).map((s) => s.id);
}

/**
 * The one advisory block duplicateHint ever adds — exact (one id) or similar (1-2 ids, already
 * ranked by duplicateHintCandidates). Labels pass through `oneLine` (secret-masked, capped) like
 * every other lever's own text here; never a note's body.
 */
function duplicateHintBlock(index, exactId, similarIds) {
  if (exactId) {
    return block(`memglow: a note with this title already exists: [[${exactId}]] — this write_note may replace or duplicate it; prefer edit_note.`);
  }
  if (Array.isArray(similarIds) && similarIds.length) {
    const parts = similarIds.map((id) => {
      const n = index && typeof index.note === "function" ? index.note(id) : null;
      return n ? `[[${id}]] (${oneLine(n.label, 80)})` : `[[${id}]]`;
    });
    return block(`memglow: a note on this subject already exists — ${parts.join("; ")}. Prefer edit_note on it (append / replace_section) over a new note.`);
  }
  return null;
}

/**
 * Lever 14 (duplicateHint) for one `write_note` call's own arguments — `{ exact: id }` when the
 * title itself (or its kebab slug, or its label — whatever `index.resolve` already matches, same
 * helper every other lever uses) names an EXISTING note; `{ similar: [id, ...] }` (1-2 ids) when
 * it does not but is close enough to one or two (duplicateHintCandidates); or null when there is
 * nothing to warn about (no usable `title`, no match either way). Exact wins outright over
 * similar — a title that already IS a note's own name is a stronger signal than a handful of
 * shared words, and showing both would just be noisier. Index notes and notes in the archive
 * folder never count for the SIMILAR rule; an exact match bypasses that filter entirely (resolve()
 * does not special-case either kind, and nor does this). Called from `oneFromClient`, BEFORE the
 * write reaches the server — `index` still reflects the memory as it was before this very call.
 */
function duplicateHintFor(index, args) {
  const title = args && typeof args.title === "string" ? args.title.trim() : "";
  if (!title || !index) return null;
  const exact = index.resolve(title);
  if (exact) return { exact };
  const titleWords = significantWords(title);
  if (titleWords.length < DUPLICATE_HINT_MIN_SHARED) return null;
  const all = typeof index.allNotes === "function" ? index.allNotes() : [];
  const isArchive = typeof index.isArchive === "function" ? index.isArchive : () => false;
  const notes = all.filter((n) => n && n.theme !== "index" && !isArchive(n.id));
  const similar = duplicateHintCandidates(titleWords, notes);
  return similar.length ? { similar } : null;
}

function createLevers({ config, index, savings, serverName, aliasStore, negativeCacheStore, deltaReadStore }) {
  const cfg = config;
  const aliases = aliasStore || NOOP_ALIAS_STORE;
  const negativeCache = negativeCacheStore || NOOP_NEGATIVE_CACHE_STORE;
  const deltaStore = deltaReadStore || NOOP_DELTA_READ_STORE;
  const readTools = new Set(cfg.readTools), multi = new Set(cfg.multiNoteTools);
  const searchTools = new Set(cfg.searchTools), writeTools = new Set(cfg.writeTools);
  const replacing = cfg.dedupe || cfg.toc || cfg.alreadyLoaded || cfg.deltaRead;
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
      s = { pending: new Map(), warned: new Set(), delivered: new Map(), shortened: new Set(), read: new Set(), suggested: new Set(), searchDescribed: new Set(), duplicateHinted: new Set(), clientInfo: null, alreadyLoadedBaseline: captureBaseline(), lastSearch: null, pendingNegative: null, deltaText: new Map(), toolCallCount: 0, sawToolsList: false };
      sessions.set(k, s);
      if (sessions.size > 200) {
        const evictKey = sessions.keys().next().value;
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

  // ---- client → server ----
  function oneFromClient(m, s) {
    if (!m || typeof m !== "object") return m;
    if (m.method === "initialize") {
      s.warned.clear(); s.delivered.clear(); s.shortened.clear(); s.read.clear(); s.suggested.clear(); s.searchDescribed.clear(); s.duplicateHinted.clear();
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
    if (!kind) return m;
    // Lever 8 rule 2: did this SAME session already do something else before this call was sent?
    // Captured now, on the call itself, not re-derived later — the counter below moves on.
    const priorActivity = s.toolCallCount > 0 || s.sawToolsList;
    s.toolCallCount++;
    // Lever 14 (duplicateHint) — matched now, BEFORE this write reaches the server: `index` still
    // reflects the memory as it was before this very call, so the note it is about to create is
    // never mistaken for its own duplicate. Only `write_note` (never edit_note/move_note).
    const duplicateHint = (cfg.duplicateHint && tool === "write_note") ? duplicateHintFor(index, args) : null;
    const call = { tool, kind, args, fresh: args[ARG_FRESH] === true, section: args[ARG_SECTION], priorActivity, duplicateHint };
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
        if (cfg.toc) props[ARG_SECTION] = { type: "string", description: "memglow proxy: return only this section of a large note (its heading, or its number in the table of contents). Not sent to the memory server." };
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
    savings.addClient(s.clientInfo, respTokens); // baseline, BEFORE any lever below shortens the answer
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

    // 5b — one section on demand (sliced from the upstream answer, verbatim)
    if (cfg.toc && canReplace && call.section != null && call.section !== "" && !call.fresh) {
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
    const askedSection = cfg.toc && call.section != null && call.section !== "";
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
      const clientKey = clientBucket(s.clientInfo);
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
    const text = textOf(result.content) + (result.structuredContent ? "\n" + JSON.stringify(result.structuredContent) : "");
    const ids = [];
    for (const r of [...permalinksIn(text), ...idsInText(text)]) {
      const id = index.resolve(r);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= cfg.searchDetailsMax) break;
    }
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
      const r = archiveHint(call, out, text, ids);
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
    if (cfg.negativeCache || cfg.sizeWarning || cfg.duplicateHint) index.afterWrite();
    if (cfg.negativeCache) negativeCache.forgetStale(index.fingerprint());

    const before = [], after = [];

    if (cfg.sizeWarning) {
      let id = null;
      for (const r of [...noteRefsInArgs(call.args), ...permalinksIn(textOf(result.content))]) { id = index.resolve(r); if (id) break; }
      const note = id ? index.note(id) : null;
      if (note && note.tokens > T && !s.warned.has(id)) {
        s.warned.add(id);
        before.push(block(sizeWarning(note, note.tokens, true)));
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

  function apply(msg, sessionKey, fn) {
    const s = session(sessionKey);
    try {
      if (Array.isArray(msg)) {
        const out = msg.map((m) => fn(m, s));
        return out.some((m, i) => m !== msg[i]) ? { msg: out, changed: true } : { msg, changed: false };
      }
      const out = fn(msg, s);
      return { msg: out, changed: out !== msg };
    } catch (e) {
      return { msg, changed: false }; // a lever bug must never break the relay
    }
  }

  return {
    clientMessage: (msg, sessionKey) => apply(msg, sessionKey, oneFromClient),
    serverMessage: (msg, sessionKey) => apply(msg, sessionKey, oneFromServer),
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
      async run(reqMsg, sendUpstream, sessionKey) {
        const args = (reqMsg.params && reqMsg.params.arguments) || {};
        const r = await runSearchCall(cfg, index, args, sendUpstream);
        let message = r.message;
        if (message && message.result && (cfg.aliases || cfg.learnAliases)) {
          const plan = planMultiQuery(args);
          const phrasings = plan ? plan.phrasings : [queryOf(args)];
          const s = session(sessionKey);
          const newResult = applyAliasesToSearch(cfg, index, aliases, s, phrasings, message.result);
          if (newResult !== message.result) message = { ...message, result: newResult };
        }
        return { message: { jsonrpc: "2.0", id: reqMsg.id, ...message }, calls: r.calls };
      },
    },
  };
}

module.exports = {
  proxyConfig, anyLever, createNoteIndex, createSavings, createLevers, DEFAULTS, ARG_FRESH, ARG_SECTION,
  DEFAULT_UNSUPPORTED_TOOLS, OPENAI_MCP_CLIENT_NAME, clientInfoAllowed, clientInfoKnown, clientBucket,
  // Lever 8 rule 1 (0.4.3.1) — see the module's top comment.
  clientInfoExempt,
  readClientSavings, CLIENT_TOKENS_WINDOW_DAYS,
  // Lever 9 (multiQuery) — see the module's top comment.
  ARG_QUERIES, MULTI_QUERY_MAX, MULTI_QUERY_LEN_MAX, queryKeyOf, queryOf, planMultiQuery, rankKeys,
  mergeRankedIds, mergeSearchResults, runSearchCall, hitRow, isPlainTextResult,
  // Lever 10 (aliases, 0.4.2.3 + 0.4.2.4) — see the module's top comment and lib/learned-aliases.js.
  ALIAS_LEARN_WINDOW_MS, aliasInjection, applyAliasesToSearch,
  // Levers 11 (negativeCache) and 12 (indexHint), 0.4.2.6 — see the module's top comment and
  // lib/negative-cache.js.
  indexHintLines, indexHintBlock, INDEX_HINT_MAX_LINES, INDEX_HINT_LINE_MAX,
  // Lever 14 (duplicateHint), 0.4.4.1 — see the module's top comment.
  duplicateHintCandidates, duplicateHintBlock, duplicateHintFor, noteWords,
  DUPLICATE_HINT_MIN_SHARED, DUPLICATE_HINT_COVERAGE, DUPLICATE_HINT_MAX_CANDIDATES,
};
