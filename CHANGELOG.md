# Changelog

## 0.4.2.6 — internal (not published)

"Negative cache + the index already answers."

### Added

- **MCP proxy: lever 11, `negativeCache`**, OFF by default (see Changed below). The owner's own
  log: 12 of 40 searches led to NO READ AT ALL — not a wrong pick, nothing opened afterwards. A
  search in a session not followed by a read (of anything) within `ALIAS_LEARN_WINDOW_MS` (2
  minutes), or superseded first by another search or a write in the same session, is remembered,
  locally, as "futile" against the live memory's current FINGERPRINT — note count + latest
  mtime, `lib/negative-cache.js`'s `memoryFingerprint`, cheap and derived straight from the note
  index's own graph cache, no new read of any note. A LATER search sharing the same normalized,
  significant words (`lib/learned-aliases.js` `significantWords`, reused unchanged), while the
  fingerprint is unchanged, gets one line PREPENDED: `memglow: this search found nothing you used
  last time (<date>); the memory has not changed since.` **The results are always kept, never
  hidden** — this lever only ever adds a line, same correctness rule as every other lever. Any
  write anywhere bumps the fingerprint, invalidating every remembered entry at once
  ("invalidate on any write" — deliberately global, not per-note).
  - A single switch (`negativeCache`) gates both recording and using it — unlike lever 10's two
    independent switches: this is only ever a one-line, never-hides-anything nudge, so there is
    no "quietly keep learning while the hint is paused" case worth a second knob here.
  - Pure logic in `lib/negative-cache.js` (`normalizedKey`, `memoryFingerprint`,
    `recordFutileEntries`, `lookupFutileEntry`, `forgetStaleEntries`, and the one fs-touching
    piece, `createNegativeCacheStore` — same atomic-write/mode-600/bounded shape as
    `lib/learned-aliases.js`'s `createAliasStore`, file `negative-cache.json` next to
    `learned-aliases.json`). Wiring in `lib/proxy-levers.js`: `createNoteIndex` gained
    `fingerprint()` (cached alongside the rest of its derived graph cache); `createLevers` gained
    a session field `pendingNegative` and a shared `finalizePending()` helper called from
    `handleSearch` (a new search supersedes whatever was pending), `handleRead` (any read redeems
    it, in time or too late), `handleWrite` (a write supersedes it too, then forces a rescan and
    prunes stale entries), and from LRU session eviction and a new `engine.negativeCache
    .flushPending()` (called on process exit in `mcp-proxy/memglow-mcp-proxy.js`, alongside
    `savings.flush()`/`aliasStore.flush()`) — so a search that is simply never followed by
    anything else in its session is still settled as futile, not silently lost.
  - **Known gap**: a search merged by lever 9 (`multiQuery`, `memglow_queries`) bypasses
    `handleSearch` entirely (`multiQuery.run()` answers the whole burst outside the normal
    `clientMessage`/`serverMessage` cycle — same limitation lever 10 had before 0.4.2.5), so this
    lever neither learns from nor hints into a MERGED multi-phrasing call; only a lone search
    (no burst) goes through it. Left as is for this stage — see CHANGELOG 0.4.2.5 for how lever
    10 closed the equivalent gap, a template for doing the same here later.
- **MCP proxy: lever 12, `indexHint`**, OFF by default (see Changed below). The owner's own log:
  the index note was read in full 6 times (≈16k tokens), each time without knowing in advance
  whether it actually answered the question. A search whose own results are ONLY the index note,
  or a read of the index itself while lever 8 (`alreadyLoaded`) is off, gets a suffix: `memglow:
  the index already says:` followed by up to 3 lines of the index's OWN text (secret-masked via
  `lib/memory.js`'s `maskedBody`, each capped to 160 characters) that mention one of the query's
  significant words — grepped, never summarised, and never replacing the note's own content. The
  read case reuses lever 10's own "search right before a read" correlation (`s.lastSearch`,
  extended to populate even with `learnAliases` off, as long as `indexHint` is on) to know what to
  grep for; with no recent search at all, nothing is added — never a bare "says:" line with
  nothing after it. New `indexHintLines`/`indexHintBlock`/`INDEX_HINT_MAX_LINES`/
  `INDEX_HINT_LINE_MAX` in `lib/proxy-levers.js`, exported for testing.

### Changed

- **`bench/replay.js`**: new fixture
  [`bench/replay-negative-cache.jsonl`](../bench/replay-negative-cache.jsonl) (3 sessions, 7
  calls) built specifically to exercise lever 11 — a search superseded with no read (futile), a
  second search redeemed by a read (not futile), then a dedicated session where the SAME search
  recurs once the memory is unchanged. `dropIfHinted` now also works WITHOUT `expect` (which is
  alias-specific, "a note id this search is about"): a new `lastNegativeCacheHinted` map tracks,
  per session, whether the MOST RECENT search's delivered text carried the negativeCache hint
  line, and a marked retry is dropped when either that OR the existing `expect`-based condition
  holds — additive, so every previously-recorded number for `bench/replay-demo.jsonl`,
  `bench/replay-heavy.jsonl` and `bench/replay-aliases.jsonl` is unchanged (verified: this lever
  is off by default, and the hint text never appears when it is off, so the new tracking is
  always `false` for every existing fixture/configuration unless `negativeCache` is explicitly
  turned on). `SHIPPED_DEFAULTS`/`LEVER_ENV` gained the two new lever names.
- **Levers 11/12 both ship OFF by default**, decided by the SAME merge rule 0.4.2.5 introduced (0
  violations AND effective tokens `<=` off's AND (raw tokens `<=` off's OR calls `<` off's)),
  `--each` on `bench/replay-demo.jsonl`, `bench/replay-heavy.jsonl`, `bench/replay-aliases.jsonl`
  and the new `bench/replay-negative-cache.jsonl`:

  | fixture | `negativeCache` alone (raw / effective, vs off) | `indexHint` alone (raw / effective, vs off) |
  |---|---|---|
  | replay-demo.jsonl | 0 / 0 (no-op) | +96 / +96 |
  | replay-heavy.jsonl | +52 / +52 (hint fires for real, no call saved to offset it) | +391 / +391 |
  | replay-aliases.jsonl | 0 / 0 (no-op) | 0 / 0 (no-op, never reads the index) |
  | replay-negative-cache.jsonl | +23 / **-4977** (1 call dropped) | +78 / +78 |

  `indexHint` never saves a call anywhere it fires — same bucket as
  `searchDetails`/`suggestions`/`archiveHint` (0.4.2.2): the rule fails outright. `negativeCache`
  WINS decisively on its own dedicated fixture (same shape as lever 10 at 0.4.2.5: 1 fewer call,
  +23 raw tokens, a clear win on effective tokens), exactly matching "measure honestly: it only
  saves if the model then stops searching" — but `bench/replay-heavy.jsonl` (built for OTHER
  levers, not retrofitted for this one) contains a genuinely recurring search that trips the same
  hint for real, with no corresponding dropped retry to offset the cost. The rule needs every
  tested file to pass; this one real, unmodelled cost on `replay-heavy.jsonl` is enough, so it
  ships off too — both fully available via `MEMGLOW_PROXY_NEGATIVE_CACHE=1` /
  `MEMGLOW_PROXY_INDEX_HINT=1` (or `"proxy": { "negativeCache": true }` / `{ "indexHint": true }`).

### Tests

- `test/negative-cache.test.js` — pure pieces (`normalizedKey`, `memoryFingerprint`,
  `recordFutileEntries`, `lookupFutileEntry`, `forgetStaleEntries`) and `createNegativeCacheStore`
  (disabled without a folder/switch, atomic write, mode 600, bounded, malformed file treated as
  empty, and invalidation on write: a fingerprint change drops every entry, not just one note's).
- `test/negative-cache-levers.test.js` — integration through `lib/proxy-levers.js`'s
  `createLevers` (no process spawn, hand-crafted upstream answers, same pattern as lever 10's own
  "never duplicated" test): a search superseded with no read is recorded futile and later hinted
  with the results always kept after it; a read within the window redeems a search (no later
  hint); a REAL write on disk invalidates a previously-recorded futile verdict; the hint never
  carries a fragment of a secret-looking query; the lever off end to end; a broken index/store
  never breaks the relay; both `indexHint` cases (search-returns-only-index,
  read-right-after-a-search), no match → nothing added, no recent search → nothing added, and the
  `alreadyLoaded` interaction (that read is stubbed by lever 8 instead, so `indexHint`'s own text
  never appears on it).
- `npm test` green (438 tests).

## 0.4.2.5 — internal (not published)

"Count the turns; aliases learn from multi-phrasing searches."

### Added

- **`bench/replay.js`: "effective tokens" column** = raw tool-result tokens + `calls *
  turnTokens` (`--turn-tokens`, default `DEFAULT_TURN_TOKENS` = 5,000). Before this stage, the
  harness scored a lever purely on tool-result tokens, so a lever that trades a CALL for a few
  extra tokens always looked like a loss — on `bench/replay-aliases.jsonl`,
  `aliases`+`learnAliases` made 2 fewer calls but cost +25 raw tokens (758 → 783), which is why
  it shipped off at 0.4.2.4. In reality every extra tool call is a whole extra model turn, which
  re-sends the system prompt, every MCP tool's schema, and the conversation so far — not just
  that one tool's own result.
  - `DEFAULT_TURN_TOKENS` = 5,000 is derived from `bench/results/*.jsonl` (326 real recorded
    turns from real `claude -p` runs: `sonnet.jsonl`, `haiku.jsonl`, `haiku-prefix.jsonl`,
    `split-gain.jsonl`): "overhead per call" = `(tokens.input + tokens.cacheCreate +
    tokens.cacheRead) - estimateTokens(toolResultChars)`, divided by `toolCalls`. Across all 326
    rows this ranges ≈4,000-19,000 per call (median ≈12,750; 10th percentile ≈6,500) — mostly
    the system prompt + tool schemas resent on every turn. 5,000 is a deliberate
    UNDER-estimate (below the 10th percentile, not the median): the point is to stop penalizing
    a lever for cutting a call, not to inflate how much cutting one is worth. See
    `bench/replay.js`'s own `DEFAULT_TURN_TOKENS` comment for the full derivation.
  - **New merge rule for a lever's default**: 0 violations AND effective tokens `<=` off's AND
    (raw tokens `<=` off's OR calls `<` off's) — applied by eye against the table, same as every
    earlier stage, not auto-verdicted by this file.
  - Raw `tokens`/`calls` columns are unchanged and still printed; `printEachBreakdown` (`--each`)
    also gained an "effective" column. `summarize()` takes a `turnTokens` parameter (default
    `DEFAULT_TURN_TOKENS`); JSON output (`--json`) includes `effectiveTokens`/`effSavingsAbs`/
    `effSavingsPct` per row plus the `turnTokens` used.

### Changed

- **MCP proxy: lever 10, `aliases` + `learnAliases` — ON by default** (`lib/proxy-levers.js`'s
  `DEFAULTS`, mirrored in `bench/replay.js`'s `SHIPPED_DEFAULTS`). Re-decided with the new merge
  rule above, on all three fixtures that exercise levers 9/10 (`--with
  aliases,learnAliases,-multiQuery` vs `off`): a no-op (identical calls/tokens to `off`) on
  `bench/replay-demo.jsonl` and `bench/replay-heavy.jsonl`; on `bench/replay-aliases.jsonl`, 2
  fewer calls (16 → 14) at +25 raw tokens (758 → 783) now reads as a clear win on EFFECTIVE
  tokens (80,758 → 70,783). The rule holds on all three, so this lever flips from OFF to ON.
  `MEMGLOW_PROXY_ALIASES=0` / `"proxy": { "aliases": false }` (and the `learnAliases` equivalent)
  turn it back off for whoever wants that.
  - **`dedupe` re-checked against the same rule, for completeness — default left UNCHANGED
    (still off)**: it also PASSES the rule on all three fixtures (it only ever saves raw tokens,
    `off`-or-better calls everywhere), but turning it on is left to the owner — it replaces a
    note's content mid-session with a short "unchanged" stub, a context-compaction risk the
    effective-tokens number does not capture. Reported in `bench/README.md`'s 0.4.2.5 section,
    not acted on here.
- **Lever 10 now learns from, and injects into, a lever 9 (`multiQuery`) multi-phrasing search**
  — previously a known limitation (see 0.4.2.4's own entry below): a request carrying
  `memglow_queries` bypasses the normal `clientMessage`/`serverMessage` cycle entirely
  (`multiQuery.run()` answers the whole burst itself, merged, outside `handleSearch`), so
  `aliases`/`learnAliases` could neither learn from such a search nor inject a candidate into its
  merged result.
  - New `applyAliasesToSearch(cfg, index, aliases, s, phrasings, result)` in
    `lib/proxy-levers.js` (pure, exported, unit-tested): records `s.lastSearch.words` as the
    UNION of every phrasing's own significant words (not just the main query's — a note read
    right after now learns from every phrasing the model tried) and `resultIds` from the merged
    result, then applies the same injection rule `handleSearch` already used (first learned
    candidate, prepended, never replacing or removing a row; upstream's-own-format when the
    merged result is plain text).
  - `createLevers(...).multiQuery.run(reqMsg, sendUpstream, sessionKey)` gained a third
    parameter — the same session identifier `clientMessage`/`serverMessage` already take — so it
    can find (or create) the right session to record into and read from. `createHttpProxy` in
    `mcp-proxy/memglow-mcp-proxy.js` now passes its `Mcp-Session-Id` (`sk`) through on this call
    (it already did for every other lever entry point); the stdio path still omits it, same as
    every other lever call there (stdio is already one single implicit "default" session, same
    as before this change). `bench/replay.js`'s own `multiQuery` branch passes the event's
    `session` through too, so the replay harness exercises the exact same code path.
  - Tests: `test/mcp-proxy-levers.test.js` — a missed multi-phrasing search teaches every
    phrasing's words (not just the main query), and a learned candidate is injected into a later
    multi-phrasing search's own merged result; `applyAliasesToSearch` unit-tested directly
    (learns from several phrasings, never duplicates an already-present note, no-op when both
    switches are off). Pre-existing alias tests that relied on the old OFF-by-default behaviour
    were updated to either assert the new ON-by-default behaviour directly, or explicitly force
    the switches off/on with env vars where the test is specifically about isolating one switch
    from the other.

## 0.4.2.4 — internal (not published)

Includes 0.4.2.3 ("query log") below it: the recording half of this same feature, shipped in the
same stage since the lever only makes sense with both halves in place.

### Added

- **MCP proxy: lever 10, `aliases` ("learned aliases")**, OFF by default (see Changed below).
  The owner's own real search log: the note finally read was the proxy's 1st search result only
  7 times out of 28, and not among the results AT ALL 13 times out of 28 — found instead via the
  index or a link — so the very next similarly-worded search failed again, the same way. This
  lever lets the proxy learn, privately and locally, which of the assistant's own words actually
  lead to which note, from THIS proxy's own past sessions, and use that the next time a similar
  search would otherwise come up empty-handed for that note.
  - **0.4.2.3, "query log" (lever switch `learnAliases`)**: when, in the SAME session, a search
    is followed (within `ALIAS_LEARN_WINDOW_MS` = 2 minutes, before another search) by a
    single-note read of a note NOT among that search's own results, the query's significant
    words (lowercased, stop-words dropped — a short EN + FR list, ≥ 3 letters,
    `lib/learned-aliases.js` `significantWords`, secret-masked with the existing
    `maskSecrets` BEFORE extraction) are learned as aliases of that note, with a count. Kept in
    one small local file, `learned-aliases.json` in memglow's data folder (mode 600, atomic
    write, bounded to `aliasesMax` = 2,000 (word, note) entries, oldest by last-use dropped
    first). **Nothing here is ever sent anywhere** — the file has no network code at all.
  - **0.4.2.4, "learned aliases" (lever switch `aliases`)**: on a LATER search, if its words
    match ≥ 2 of some note X's learned aliases (or 1 alias seen ≥ 2 times), and X is not already
    among that search's own results, X is added at the TOP of the answer — in the upstream's own
    per-hit row shape when the answer is plain text (reusing lever 9's own row helper, `hitRow`,
    factored out of `mergeSearchResults`'s tier B for this), else one compact, explicitly-labelled
    line: `memglow: likely relevant — <label> (<id>), learned from your past searches`. Never
    removes a result, never touches a note file, never duplicates a note already in the answer.
    An alias whose note no longer exists is forgotten (`forgetMissing`, run opportunistically on
    every search while the lever is on).
  - `learnAliases` (recording) and `aliases` (using what was recorded) are **independent**
    switches, both under the `proxy` config key / `MEMGLOW_PROXY_ALIASES` and
    `MEMGLOW_PROXY_LEARN_ALIASES` env vars: learning can keep running quietly while injection is
    paused, and injection can keep using whatever was already learned while recording is paused.
  - Pure logic in `lib/learned-aliases.js` (`significantWords`, `maskedQuery`, `learnEntries`,
    `matchAlias`, `forgetMissing`, and the one fs-touching piece, `createAliasStore`) — zero
    Express, zero three.js, meant to be lifted into memglow proper as is. Wiring in
    `lib/proxy-levers.js` (`hitRow`/`isPlainTextResult` factored out and reused, `aliasInjection`,
    the correlation bookkeeping in `handleSearch`/`handleRead`, session field `lastSearch`) and
    `mcp-proxy/memglow-mcp-proxy.js` (`setupLevers` creates the store, flushes it at exit).
  - **Known limitation, same family as searchDetails/archiveHint**: a search carrying
    `memglow_queries` (lever 9, `multiQuery`) bypasses `handleSearch` entirely while it is being
    merged (the merge happens against the raw upstream, outside the normal
    `clientMessage`/`serverMessage` cycle — see lever 9's own doc comment) — `aliases` cannot
    inject into, or learn from, a merged multi-phrasing call. It still works normally on every
    ordinary, single-phrasing search, which is what the owner's own log above was measuring (it
    predates `multiQuery`).
  - `bench/replay.js` gained the measurement this lever needed: `expect`/`dropIfHinted` on an
    event (`normalizeCalls`), a per-config hit-rate counter (`aliasSearches`/`aliasHits`,
    `printAliasHitRate`), and `droppedCalls` (a `dropIfHinted` search is skipped — no upstream
    call, nothing counted — once the session's most recent `expect` search already found that
    exact note: "a later re-search that becomes unnecessary once the note is already there").
    `--with` now also accepts a lever name prefixed with `-` to force it OFF (`namedConfigs`), so
    this lever's own effect can be isolated from `multiQuery`'s call-merging on the same fixture.
  - New fixture `bench/replay-aliases.jsonl`: 3 scenarios (mqtt, stripe-webhooks, git-workflow —
    the last one specifically for the "1 alias seen ≥ 2 times" threshold branch), each a miss,
    a read, then a later similar search (the mqtt/stripe ones also carry a `dropIfHinted` retry
    search right after). `node bench/replay.js --events bench/replay-aliases.jsonl --with
    aliases,learnAliases,-multiQuery` (multiQuery isolated out, see the limitation above):

    | configuration | calls | tokens | hit rate | violations |
    |---|---|---|---|---|
    | off | 16 | 758 | 0/5 (0%) | 0 |
    | +aliases,learnAliases,-multiQuery | 14 | 783 | 3/3 (100%) on the measured searches, 2 retries dropped | 0 |

### Changed

- **`DEFAULTS.aliases = false`, `DEFAULTS.learnAliases = false`** (`lib/proxy-levers.js`): the
  replay numbers above are 0 violations (passed) and a much better hit rate (passed), but tokens
  were WORSE, not "not worse" (758 → 783, +3.3%) — this lever only ever ADDS a hit row, it never
  replaces or removes one (same family as `searchDetails`/`suggestions`/`archiveHint`, all OFF by
  default for exactly this reason), and the 2 dropped retry calls' tokens did not outweigh the 3
  injected rows'. Per the same rule every other lever's default is decided by (0 violations AND
  hit rate improves AND tokens not worse, all three), this one ships OFF. Both still fully built,
  tested and documented, and one env var away:
  `MEMGLOW_PROXY_ALIASES=1` / `"proxy": { "aliases": true }`, `MEMGLOW_PROXY_LEARN_ALIASES=1` /
  `"proxy": { "learnAliases": true }`.

## 0.4.2.2b — internal (not published)

### Added

- **MCP proxy: lever 9, `multiQuery` ("several phrasings, one call")**, ON by default. The
  owner's own real usage log: 20 of 40 searches were immediately followed by ANOTHER search,
  before any read — the built-in rule "search in 2-3 phrasings" (`lib/memory-rules.js`) was
  costing 2-3 separate model turns every time, each with its own latency and re-sent context.
  The proxy now accepts an extra argument on every search tool (advertised in `tools/list` when
  this lever is on, stripped before the call reaches the server either way): `memglow_queries`
  (an array of up to `MULTI_QUERY_MAX` = 4 extra phrasings, each up to `MULTI_QUERY_LEN_MAX` =
  200 characters). A call carrying it is sent upstream as ONE call per phrasing — sequentially,
  the original query first, never in parallel or as a JSON-RPC batch — and the hits are merged:
  deduped by note id (a note found by several phrasings ranks higher, ties broken by the best
  rank it had anywhere then by which phrasing found it first), capped to the biggest single
  phrasing's own hit count, returned as ONE result in the upstream's own format when every
  phrasing answered in plain text (reassembled from the SERVER'S OWN hit blocks, split on blank
  lines — never a line memglow invented), else a compact listing of whatever note ids resolve
  (same style as lever 2, `searchDetails`). Any later phrasing's failed call fails the whole
  thing open to the FIRST phrasing's own result — what a plain single search would have
  returned; nothing resolvable anywhere does the same.
  - Pure logic in `lib/proxy-levers.js`: `planMultiQuery` (validates/caps `memglow_queries`),
    `mergeRankedIds`/`rankKeys` (the dedup/rank/cap algorithm, usable on its own), merge
    `mergeSearchResults` (the three tiers above), and the async, transport-agnostic
    `runSearchCall` (sequential calls + fail-open), all exported for direct testing.
  - Transport wiring in `mcp-proxy/memglow-mcp-proxy.js`: a multiQuery call bypasses the normal
    1-request-in/1-response-out relay — `lineRelay`/`sseRelay` gained a `SUPPRESS` sentinel (write
    nothing for this line/event) so the client's original request and each sub-call's own
    response are never relayed as is, only the ONE merged reply is. Stdio sends each sub-call as
    its own `tools/call` with a synthetic id (`createSubCallSender`); HTTP sends each as its own
    POST to the upstream (`postJsonRpc`) — JSON answers only for sub-calls (the one call the
    CLIENT asked for still streams normally, SSE included).
  - `lib/memory-rules.js`'s first rule updated: "if that tool's `memglow_queries` argument is
    offered, pass all the phrasings in that ONE call; otherwise call it 2-3 times as before" —
    so an assistant that already follows the habit switches to one call for free.
  - `bench/replay.js` models it: a run of consecutive searches by the same session, no read in
    between, within 2 minutes (`mergeSearchBursts`, `MULTI_QUERY_GAP_MS`), becomes ONE call
    carrying `memglow_queries` before the replay loop runs, so `calls` counts client-facing round
    trips — exactly what this lever is meant to cut. `bench/replay-heavy.jsonl` gained a few such
    bursts (67 calls now, up from 60) to exercise it; `bench/replay-demo.jsonl` has none (no
    change either way, by design — a small demo file was never going to have a realistic burst).

### Changed

- **`DEFAULTS.multiQuery = true`** (`lib/proxy-levers.js`), decided the same way every other
  lever's default is: `node bench/replay.js --each`, fewer calls AND no more tokens than `off`,
  or it ships off.

  | file | off | defaults (multiQuery on) | multiQuery alone vs off |
  |---|---|---|---|
  | `bench/replay-demo.jsonl` (no bursts) | 14 calls / 5,288 tokens | 14 calls / 5,288 tokens | +0 calls / +0 tokens |
  | `bench/replay-heavy.jsonl` (a few bursts added) | 67 calls / 17,581 tokens | 60 calls / 16,864 tokens | −7 calls / −717 tokens |

  Fewer calls AND fewer tokens on the only file with bursts to show it, no change on the file
  without any, 0 violations on both — unlike levers 2/3/6 (`searchDetails`/`suggestions`/
  `archiveHint`), which only ever ADD explanatory text, this lever can genuinely remove both
  calls and tokens, so it ships ON alongside `sizeWarning`.

## 0.4.2.2 — internal (not published)

### Changed

- **MCP proxy: lean defaults.** `bench/replay.js` (stage 0.4.2.1b) measured, and a real 2-day
  usage log confirmed, that the shipped `defaults` delivered MORE tokens than `off` — −19.7% on
  the shipped demo (`off` 5,288 → `defaults` 6,329 tokens), **+14% on the real log** (91 calls:
  `off` 116,052 → `defaults` 132,257 tokens). `searchDetails` and `suggestions` only ever ADD
  explanatory text (never cut anything), and the free replay harness cannot credit the extra
  reads/searches such text might avoid, so any amount of it reads as a pure loss — the real log's
  +14% is the same effect, just noisier. Per lever (`node bench/replay.js --each`, each lever
  alone against `off`, demo file / heavy synthetic file — see below):

  | lever | demo (14 calls) | heavy (60 calls) | decision |
  |---|---|---|---|
  | `sizeWarning` | +0 | +0 (both files avoid an oversized note on purpose — see below) | **keep** |
  | `searchDetails` | +483 | +1,179 | **off by default** (shortened) |
  | `suggestions` | +331 | +1,376 | **off by default** (shortened) |
  | `dedupe` | −1,449 | −4,314 | unchanged (off by default) |
  | `toc` | 0 | 0 | unchanged (off by default) |
  | `alreadyLoaded` | −3,710 | −9,646 | unchanged (off by default) |

  Decisions, with the numbers above:
  - **`sizeWarning` — keep, unchanged.** A single short line, once per large note per session —
    exactly the "short and plausibly prevents a wasted call" case. It is the one lever still on
    by default (`DEFAULTS.sizeWarning = true` in `lib/proxy-levers.js`); on a session that reads
    an oversized note it can still make `defaults` cost a few tokens more than `off` — that is
    this lever doing its job, not a regression.
  - **`searchDetails` — shortened AND turned off by default.** Shortening (kept for whoever opts
    back in via `MEMGLOW_PROXY_SEARCH_DETAILS=1`): a note already read **in full** this session
    gets no teaser line at all (its real content, not a guess at it, is already in context); a
    note merely *described* once this session (an earlier search mentioned it) gets the compact
    line (no description) the next time a search turns it up. Neither optimisation was enough to
    flip the sign on either event file (a nearly-cold demo/heavy file has few repeats to exploit),
    so `DEFAULTS.searchDetails` is now `false`.
  - **`suggestions` — shortened AND turned off by default.** Shortening: shown once per note
    **per session** (re-reading the same note later in the session does not repeat its
    related-notes suffix) — kept for `MEMGLOW_PROXY_SUGGESTIONS=1`. `DEFAULTS.suggestions` is now
    `false`, same reasoning as `searchDetails`.

  `dedupe`, `toc`, `archiveHint`, `hideUnsupportedTools` and `alreadyLoaded` are unchanged (still
  off by default, for the reasons already documented) — this stage only touched the three levers
  that were on by default.

### Added

- **`bench/replay.js --each`**: one row per lever, each lever ALONE against the `off` baseline
  (every other lever off) — unlike `--with`, which starts from `defaults`. Reports the tokens
  each lever adds or saves in isolation; this is the table stage 0.4.2.2 was decided from, and
  the one to re-run before changing any lever's default again. `--json` includes the same rows
  (`key: "alone:<lever>"`).
- **`bench/replay-heavy.jsonl`**: a synthetic 60-call, 4-session event file, heavier and more
  repetitive than the 14-call demo (the same handful of notes read and searched repeatedly across
  a few topics — a storefront project, a docker/home-lab investigation, a weather-app session —
  plus a one-off tail of notes touched once), closer to a real working session. Used by
  `test/bench-replay.test.js` alongside the demo file to confirm `defaults` tokens `<=` `off`
  tokens holds at a larger scale too, not just on the small demo.
- **`bench/replay.js`: `--memory` is now an alias for `--memory-dir`.** Before this stage, typing
  `--memory` (plausible shorthand, or a typo for `--memory-dir`) was silently ignored — the flag
  and its value were dropped as unrecognised positional tokens, and the run silently used the
  DEFAULT memory folder instead of the one intended. Now it works exactly like `--memory-dir`.
- **`bench/replay.js`: any other unrecognised flag is now a hard error** (exit code 2, naming the
  unknown token(s)) instead of being silently ignored — the same class of mistake as `--memory`
  above, for every flag this CLI does not know.

### Tests

- `test/bench-replay.test.js`: `SHIPPED_DEFAULTS` (the harness's own copy of the shipped defaults)
  pinned equal to `lib/proxy-levers.js`'s `DEFAULTS`, so the two can never silently drift again;
  `defaults` tokens `<=` `off` tokens on both the demo and the new heavy file, 0 violations
  everywhere; `eachLeverConfigs()` shape (one lever on per row); the demo/heavy per-lever
  breakdown itself (`searchDetails`/`suggestions` only add, `dedupe`/`alreadyLoaded` only save,
  the rest are no-ops on these two files); `parseArgs` (`--memory` alias, unknown flags recorded,
  `--each` parses).
- `test/mcp-proxy-levers.test.js`: the "defaults" end-to-end test updated for the new defaults
  (only `sizeWarning` fires without opt-in); `searchDetails`/`suggestions` end-to-end mechanics
  moved to their own opt-in tests (`MEMGLOW_PROXY_SEARCH_DETAILS=1` / `MEMGLOW_PROXY_SUGGESTIONS=1`),
  including the new "already read in full this session → no row at all" case; the FastMCP
  wrapper test, the HTTP proxy test and the config-clamping test updated to opt back in where
  they specifically exercise those two levers.
- `npm test`: 368 tests, all green. `node bench/replay.js` / `--each` / `--events
  bench/replay-heavy.jsonl --each`: 0 violations on every configuration.

## 0.4.2.1b — internal (not published)

### Added

- **Free replay harness, `bench/replay.js`** (+ `bench/replay-demo.jsonl`, `bench/README.md`): a
  self-verification loop for every future change to the MCP proxy levers, with zero model calls,
  zero network, deterministic. Drives `lib/proxy-levers.js::createLevers` directly — the same
  `clientMessage`/`serverMessage` entry points the real proxy uses — against a tiny in-process
  fake upstream answering from a notes folder, under named configurations (`off`, `defaults`, and
  any `--with lever,lever` combination on top of `defaults`). Reports calls, tokens delivered to
  the model, and savings against `off`; accepts either a JSONL/JSON-array file of tool calls
  (`{session,tool,args,t}`) or the r0zumnik portal's own `{evenements:[...]}` activity shape
  (sessions inferred from `source` + a 30-minute silence). A **correctness guard** checks, for
  every read, that the note's full current text stays reachable (delivered in full earlier in
  the same session and unchanged, in the always-loaded context and unchanged, or the stub names
  the `memglow_fresh` escape hatch) — exit code 1 on any violation. `test/bench-replay.test.js`
  pins the guard (including an artificially broken lever), event loading/grouping, and the demo
  table's own invariant (`off` vs `+alreadyLoaded`: positive saving, 0 violations).

## 0.4.2.1 — internal (not published)

### Added

- **MCP proxy lever 8, `alreadyLoaded`** (`lib/proxy-levers.js`, off by default): real usage data
  on the owner's own memory showed the always-loaded index note — already injected into context
  at session start by a host's `SessionStart` hook — was ALSO read explicitly 6 times through the
  memory MCP server over two days (≈16k tokens, ≈17 % of all tokens read): a pure duplicate. The
  new lever stubs a single-note read (never a `multiNoteTools` call) of a note memglow knows is
  always loaded — the index note(s), or a configured `alwaysLoaded` entry that resolves to a note
  — with a short `memglow: "<label>" (≈N tokens) is already in your context — … has not changed
  since this session began (sha …8 chars). Use it from there. To get the full text anyway, call
  again with "memglow_fresh": true.` A note that changed since the session began is never stubbed:
  its full, current text is returned instead, with a one-line "(changed since the start of this
  session)" note. Default **off**: memglow cannot know whether a given setup truly re-injects the
  index at session start (checked: `memglow init` does not install any such injection itself, only
  memglow's memory rules in `CLAUDE.md`/`AGENTS.md`) — turn it on (`proxy.alreadyLoaded` /
  `MEMGLOW_PROXY_ALREADY_LOADED`) only when it does. Tokens saved are counted the same way as
  `dedupe`/`toc` (`createSavings`, kind `"alreadyLoaded"`), coexisting with stage 0.4.2's per-client
  accounting in the same `proxy-savings.json`. Config-only for now (no settings-page toggle), like
  every other lever before a settings UI exists. Documented in `README.md` and
  `mcp-proxy/README.md`; a non-run `I` variant added to `bench/run.js` for a future benchmark.

## 0.4.2 — internal (not published)

### Added

- **Multi-question bench sessions** (`bench/run.js --mode sessions`, `bench/sessions.json`): several
  related questions asked in order inside ONE `claude -p` call (one MCP session), the only way to
  measure dedupe/toc/context-reuse across turns — a single-question-per-call bench never gives them
  a second turn to do anything with. `--dry-run` prints the run plan and a cost estimate (from past
  single-question runs already in `bench/results/*.jsonl`) without calling `claude` at all.
  Documented in `bench/RESULTS.md`.
- **Tokenizer accuracy check** (`bench/tokenizer-check.js`): compares `estimateTokens` (`ceil(bytes
  / 4)`, `lib/cost.js`) against the real token counts already recorded in `bench/results/*.jsonl`,
  by question `kind` and by the holder note's real size (regenerated locally and deterministically
  with `bench/generate.js` — no network, no model call). Reports it honestly as an upper bound: the
  recorded runs keep only session-total figures, never the token delta one tool result alone
  caused — what is actually missing to do better (and why it is not re-measured here) is spelled
  out in the script's header and in `bench/RESULTS.md`.
- **Per-client token accounting in the MCP proxy** (`lib/proxy-levers.js`): `createSavings` now
  also tallies the baseline tokens relayed per client (`clientInfo.name`/`title` from `initialize`,
  bucketed by `lib/clients.js`'s known ids, or "unknown" when neither was sent), per calendar day,
  in `proxy-savings.json`. Exposed read-only (counts only, never note content) in `GET /api/cost`
  (`clientTokens`, last 7 days) and shown as a tiny "By AI tool" line under Memory engine speed in
  the Memory cost panel (`public/cost.js`); translated in all 8 shipped languages.
- **Section-level cost in the MCP server**: `note_cost` now returns a per-section token breakdown
  (`sections`, reusing `lib/cost.js`'s `sectionsOf`) for any note whose body can be read, plus
  `bodyTokens` (defined as the sum of `sections`' own tokens, so it always matches by construction);
  `split_plan` returns the same raw `sections` alongside its packed `split` parts, whose totals
  always agree with `sections`' — packing only groups the numbers, it never drops or re-estimates
  one.

### Changed

- README: a screenshot of the Assistant panel (a real split proposal, nothing applied), and the
  Claude Code requirement spelled out (recent enough to have `--restricted`; older ones are refused
  with an "update it with `claude update`" message).

## 0.4.1 — 2026-10-02

### Fixed

- An empty orange error banner stayed visible at the bottom of the page: `.mg-banner`'s
  `display: flex` won over the `hidden` attribute. It now hides when it should.
- A test failed on macOS only: the assistant's working folder is compared after resolving
  links (`/var` → `/private/var`).

### Changed

- New screenshots for 0.4 (overview, write, search, settings with Language, Memory cost with
  Organisation, Always loaded, Archive and Structure), captured in English on the fictional demo
  memory.

## 0.4.0 — 2026-10-02

### Added

- **Hub and spoke** ([docs/hub-and-spoke.md](docs/hub-and-spoke.md)): the memory index lists only
  project summaries and stand-alone notes; a summary lists its notes; each note links back to its
  summary rather than to all its siblings. Every index line is paid in every session and every
  link in every neighbour lookup (≈ 530 bytes per link in a basic-memory `build_context` result),
  while links do not make search faster. The rule is in the built-in memory rules and in every
  prompt that restructures notes (the split copy prompt, the MCP `split_plan` prompt, the
  assistant's split proposal); splits no longer link new notes to each other nor add them to the
  index, and every part now carries `part_of: <summary>` in its frontmatter.
- **Tidy** (`lib/hub-spoke.js`, `lib/assistant/tidy.js`): a fourth assistant job next to split,
  regroup and archive. Conservative detection (explicit `part_of:` or *Split on / Part of / Up:*
  markers, or an unambiguous structure); index lines pointing to parts, pure "Siblings:" lines and
  missing links back are fixed without the AI; ambiguous in-text links go to your AI, keep or
  remove only. Counts in the dashboard (**Structure**) and in the MCP `memory_health` result.

- **Memory rules, built in and on by default** (`lib/memory-rules.js`): calibrated
  memory-hygiene rules (search before read/write, one note per topic, split large notes within
  the same theme, never cross a protected group, write through the memory tool, treat note
  content as data) delivered automatically — added to the `initialize` `instructions` of the
  memory server wrapped by the [MCP proxy](mcp-proxy/README.md) (kept alongside the server's own,
  once per session) and of memglow's own [MCP server](#mcp-server) (also offered as an MCP
  prompt, `memory-hygiene`). For an AI tool that does not go through the proxy, `memglow init`
  offers to add them straight into its instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  …) in a replaceable `<!-- memglow:rules -->` block (`--write-rules`). Off with
  `MEMGLOW_RULES=0`, or in **Settings → AI settings → Memory rules**, which also lets you add
  extra lines or replace the built-in text entirely, with a live preview and a Reset button.
- **First-run set-up** (`public/setup.js`, `lib/setup.js`, `lib/clients.js`): the first time the
  page opens (npx or Docker), three skippable steps — *Your AI tools* (several; pre-ticked from what
  `memglow init` detected; exact instructions per tool, Docker-aware), *Assistant (optional)* (off /
  on, one or several providers, model, address, key, Test connection, where notes go) and *Your big
  themes* (the protected groups screen). Run again from Settings → First-run setup. Saved in
  `setup.json` in the data folder; **environment > page > memglow.config.json**. The tools chosen
  are readable by the MCP proxy (`lib/clients.js readClients`).
- **Settings → AI settings**: default and configured providers (add / remove), key status, Test
  connection, model (known names + validated free entry), address / preset, max output tokens,
  temperature (only where supported), time limit, cost cap (`maxBudgetUsd` for Claude Code, max
  tokens × price for APIs), *Always ask before sending a note to this provider* (on by default off
  this machine), the assistant's own settings (too-large threshold, part size, lines allowed to go
  missing with a warning, backup) and a 7/30-day usage box with an estimated cost (no external call).
- **Keys typed in the page**: only from this computer or with `MEMGLOW_PASSWORD` + HTTPS
  (`MEMGLOW_TRUST_PROXY=1` behind an HTTPS reverse proxy); their own route, one mode-600 file per
  provider, never sent back or logged, *Remove key*. Per-provider variables
  `MEMGLOW_ASSISTANT_API_KEY_<PROVIDER>`.
- **Claude Code subscription (no API key)**: the `claude-code` provider is named as such; model
  aliases (`opus`, `sonnet`, `haiku`, `fable`…) or a full id; `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) from the environment or the page, given only to the `claude` child process.
  Docker: "not available in this container" said plainly, and an image variant
  `--build-arg CLAUDE_CODE=1` (+≈230 MB, installed at build time, auto-update off).
- **Ollama and LM Studio as providers of their own** (`ollama`, `lmstudio`), configurable next to a
  cloud `openai-compatible` one; Test connection lists the local server's models.
- **`memglow init`** asks the same questions (tools, assistant, providers, model; API key typed
  without echo, never for Docker); `--clients <list>`; `--docker` writes the choices in `.env`
  with the key lines commented out. `--yes` unchanged.

- **Memory cost → Time to find a note · 7 days** (`lib/find-time.js`): from the activity memglow
  already receives, for each search the first read by the same actor (source + machine + channel)
  within 2 minutes — median time to the note, median steps, share of searches with no read after,
  and the 5 slowest or missed searches (titles only). A search through the MCP proxy that found no
  known note is now reported too (no ids; not animated, `202` as before) so it counts as missed.
  Stored as ids, a source label and times in `find-time.json` in the data folder (8 days).
- **Memory cost → Memory engine speed · 7 days** (`lib/engine-speed.js`): the MCP proxy times
  every tool call against the memory server (monotonic clock, request forwarded → response back)
  and sends `durationMs` with the activity; memglow keeps it only as a number from 0 to 600,000 ms
  and shows calls, p50 and p95 per tool type (search / read / write), plus a slow-search alert
  (≥ 10 searches in each window, last-24-hour median ≥ 2× the 6 days before and ≥ 250 ms slower).
  `engine-speed.json` in the data folder (8 days). Both blocks are translated in the 8 languages;
  durations use the browser's `Intl` unit names.
- **`bench/`** (repository only, not in the npm package): a reproducible benchmark of the proxy
  levers — the real `claude` CLI, non-interactive, against a disposable basic-memory on 225
  generated fictional notes, 21 questions with known answers, 5 variants (direct, proxy off,
  default levers, + dedupe, + toc), Haiku and Sonnet. Results in `bench/RESULTS.md`: default
  levers neutral; `toc` −64 % of note text received, all answers correct, but +1 round trip
  (+12 % input tokens and time, −13 % cost); `dedupe` not measurable with one question per
  session; it also found the `structuredContent` bug fixed below.
- **MCP proxy lever 7 — `hideUnsupportedTools`** (`lib/proxy-levers.js`, off by default,
  `MEMGLOW_PROXY_HIDE_UNSUPPORTED`): the proxy reads `clientInfo` from each session's `initialize`
  (one per stdio process, one per HTTP `Mcp-Session-Id`) and removes from `tools/list`, for that
  client only, the tools a config table (`proxy.unsupportedTools`, replaces the default whole)
  marks unsupported for it. Default table reproduces basic-memory 0.23's own rule, read from its
  source rather than guessed: `search`/`fetch` (its ChatGPT-only adapters,
  `chatgpt_tools.py`/`client_info.py`) are hidden from any client whose `clientInfo.name`/`title`
  is not `openai-mcp` (or doesn't start with `openai-mcp/`) — matching the exact label OpenAI's
  MCP client sends, not the product name "ChatGPT". An unknown client (no name/title) is never
  filtered. A client that calls a hidden tool anyway is still relayed, untouched — this lever only
  edits `tools/list`. Several clients on the same HTTP server (e.g. Claude Code and ChatGPT talking
  to the same basic-memory) each see their own list. See `bench/RESULTS.md` →
  "hideUnsupportedTools" for the measured effect and why it stays off by default.

- **Settings → Forces** (Repulsion, Link force, Link distance, 0.2×–3×, a "Reset forces" button)
  and **Settings → Links → Link opacity** (0×–3×): multipliers around the values already set by
  Spread/Gravity/Minimum spacing and the "Links at rest" preset — default 1× is today's look,
  unchanged (`chargeStrength`/`linkRestDistance`/`linkRestStrength`/`linkRestOpacity` in
  `public/app.js`, tested). Saved with the rest of the view (`lib/view.js`), same device-to-device
  sync, same strict server-side bounds. On a phone, the new sliders live in the same Settings
  sheet as everything else. Link curvature was tried and dropped: comets travel in a straight
  line between the two nodes, and a curved link would no longer match — left for a larger change.
- **No failed request fails silently**: every page script (graph, note, Memory cost, Protected
  groups, Assistant, the saved view, and both live streams) now shows a visible, translated
  banner — connection lost, unauthorized, or server error — with a "Reload" or "Retry" button,
  instead of swallowing the failure. `MEMGLOW_PASSWORD`'s stateless HTTP Basic auth means a `401`
  always offers "Reload" (there is no session to resume, only a fresh request to be asked for
  credentials again). A handful of catches stay intentionally silent (a 404 for a note that
  vanished between a click and the fetch, a malformed SSE event, a cosmetic background redraw) —
  each says why, right there in the code.

- **MCP server** (`memglow-mcp`, `mcp-server/memglow-mcp.js`, bin `memglow-mcp`): a second,
  standalone, read-only MCP server, separate from the MCP proxy. It starts entirely on its own —
  no viewer, no network, no notes folder even required — and lets an assistant query its own
  memory directly: `memory_health` (notes too large, costliest to read over 7 days, never read in
  30 days, index size), `split_plan` (a deterministic split suggestion along a note's `##`
  sections, or an honest "no split needed" under the threshold, plus a ready-to-paste English
  instruction for the assistant's own memory tool), `related_notes` (notes related to a note —
  links, sub-theme, and co-usage when activity counters exist — or to a free-text topic), and
  `note_cost` (token estimate, threshold, status and 7-day reads for one note). No write tool, no
  full note body ever returned (titles, descriptions and section headings only, secret-masked),
  and no file is ever written — not the notes, not even memglow's own activity counters. Hand-
  written JSON-RPC 2.0 over newline-delimited stdio, zero dependency, same reasoning as the
  existing MCP proxy. Reuses `lib/memory.js` and `lib/cost.js` — same token estimate, same split
  rule, same secret masking as the viewer and the Memory cost panel.

- **MCP proxy levers** (`lib/proxy-levers.js`): the proxy can now annotate the memory server's
  answers to save tokens and round trips — never the notes, which it only reads (cached: one folder
  scan per poll interval, plus one after each write). Each lever has a switch in
  `memglow.config.json` → `"proxy"` and a `MEMGLOW_PROXY_*` variable. On by default, and only
  ever *adding* a text block before or after the server's untouched content: (1) **size warning**
  when a note over `largeNoteTokens` is read, or written past it, suggesting a split within the
  same theme (once per note and session); (2) **richer search results** — title, theme, ≈tokens
  and description of each note found; (3) **context suggestions** — up to 3-5 related notes after
  a read (links, sub-theme, co-usage), names and sizes only. Off by default, because they change
  what the assistant receives (measure answer quality first): (4) **session read de-duplication**
  — an unchanged note re-read in the same session gets a short notice instead of its content;
  (5) **table of contents first** — a large note comes back as its outline with ≈tokens per
  section, then one section on demand, cut verbatim from the server's answer (basic-memory's
  `read_note` has no section parameter). For 4 and 5, an optional `memglow_fresh` argument (added
  to the read tools in `tools/list`, stripped before the server) or simply repeating the read
  returns the full note. Tokens saved are logged on stderr and summed per day in
  `proxy-savings.json` in memglow's data folder. Works in stdio and Streamable HTTP (JSON and SSE)
  modes; with every lever off the proxy is the same pure byte relay as before. Readers of
  frontmatter, sections and related notes are shared with the viewer and `memglow-mcp`
  (`lib/related.js`, `sectionSpans()` in `lib/cost.js`).

- **Assistant (optional, off by default)**: a *Do it with Claude* button next to *Copy prompt for
  your AI* on each large or costly note, and an *Assistant* panel below Memory cost. **The AI only
  proposes; memglow only writes what you approved in a diff, with a backup and Undo.** The user's
  own Claude Code CLI is run by the memglow server itself (no separate program) with no tool at
  all (`--tools ""`, no MCP server, deny-all rule, `dontAsk`, `--restricted`, prompt on stdin,
  no shell) and answers with a JSON proposal (summary, parts, link updates). memglow refuses it
  unless every original line is kept, new files stay in the same folder under new names, parts
  carry no frontmatter of their own (memglow copies the original `theme`/`subtheme`), the
  summary links every part, and link updates only touch notes that link to the original. Then:
  exact per-file diff, *Apply this plan* with a one-time server token (2 min, single use), a check
  that nothing changed since, a backup (git snapshot commit of the touched files, or a copy in
  `<dataDir>/backups/`) — no backup, no write — atomic writes, and *Undo* (never overwrites a file
  changed since). Secret-looking lines are replaced by placeholders before the note is sent.
  Enabled with `assistant.enabled` / `MEMGLOW_ASSISTANT=1`; its routes answer `404` otherwise;
  same access rule as the page, CSRF header + same origin, rate limited, one job at a time.
  Providers are adapters (`lib/assistant/providers/`); the Codex, Gemini and Cursor CLIs are
  listed as not supported yet.

- **Assistant HTTP providers**: `anthropic` (Messages API, streamed, your key; default model
  `claude-sonnet-5-5`) and `openai-compatible` (`<baseUrl>/chat/completions`, streamed) with
  presets `openai`, `mistral`, `openrouter`, `ollama` (`http://127.0.0.1:11434/v1`) and `lmstudio`
  (`http://127.0.0.1:1234/v1`) — local models need no key and nothing leaves the machine. Native
  `fetch`, no dependency. Same prompt and same validation as `claude-code`; no tool declared, an
  answer calling one is rejected, as is invalid JSON, a cut-off answer or one over 4 MB; time
  limit; no redirect followed; clean messages for 401 / 429 (with its delay) / 5xx. The API key
  comes only from `MEMGLOW_ASSISTANT_API_KEY` (or the variable named by `assistant.apiKeyEnv`) or
  a mode-600 `assistant-api-key` file in the data folder — a key in `memglow.config.json` or a
  readable key file is refused with a message; never sent to the browser (*key: set / not set*),
  never logged, never in an error. HTTPS required for any non-loopback address. The panel lets
  you pick any ready provider per request and says, before *Propose*, where the note goes
  (*Local model — nothing leaves your machine* or *Your note will be sent to <host>*). Per-provider
  settings sections (`assistant.anthropic`, `assistant["openai-compatible"]`).

- **Protected groups** (`lib/zones.js`): a first-run screen, *"What are your big themes?"*, lists
  the groups found in the folders and `theme:` keys (note counts, folders); tick the ones to
  protect and optionally rename how they are shown (display only). Saved in the data folder
  (`zones.json`, mode 600, atomic) through `PUT /api/zones` — page access rule, `X-Memglow`
  header + same origin, rate limited, 4 KB body, strict validation; editable in *Settings →
  Protected groups*; `protectedThemes` in the config file works too (a saved choice wins). The
  assistant refuses any proposal that would move a note into or out of a protected group, create a
  note in another group, rename a group or change a protected note's `theme` line (checked per
  file at validation and again at Apply), and every prompt memglow writes names them.

- **Organisation suggestions** (`lib/organise.js`, read-only, deterministic): notes of one group
  strongly tied (a link +2, shared title/description keywords +1 each up to +3; strong at 3) that
  span 2+ sub-themes, or the only note of a sub-theme tied to another one → *"N notes about X are
  spread across K sub-themes of G — group them under Y?"*, max 5. New *Organisation* block in
  Memory cost with *Copy prompt for your AI* and, with the assistant, *Do it with …*: a new
  `regroup` proposal (`lib/assistant/regroup.js`) — the AI gets metadata only (never note
  text) and answers `{subtheme, moves, notes}`; memglow edits only the `subtheme`/`sous_theme`
  line, may move a file to a folder of the same group, updates path links, and refuses group
  changes, unknown notes or folders, overwrites and any text change. Same diff, one-time token,
  backup and Undo (moves included). New `memglow-mcp` tool `organisation_suggestions`.
  Three scattered "docker" notes added to the demo memory to show it.

- **Always-loaded cost** (`lib/always-loaded.js`): Memory cost shows what is loaded at every
  session — the index note plus the files listed in `alwaysLoaded` (e.g. `~/.claude/CLAUDE.md`,
  `AGENTS.md`; size only, never read, only the configured name and ≈ tokens reach the page) —
  × sessions per day (estimated from index reads over 7 days, else `sessionsPerDay`), with a
  *trim the index / CLAUDE.md* tip above `indexWarningTokens`. Also in `memory_health`. MCP
  proxy: new opt-in lever `indexWarning` (`MEMGLOW_PROXY_INDEX_WARNING`) warns once per session
  when the index note read is above that threshold.

- **Archive tier** (`lib/archive.js`): sections of notes unused for months move, word for word, to
  an archive note of the same theme (`archive/<theme>-archive.md`), the original note keeps one
  line `Archived: <section> → [[<theme>-archive#<section>]] (YYYY-MM-DD)`, and an archive summary
  (`archive/archive-summary.md`, one ≈ 25-token line per archived section) is rebuilt at each
  application. **Detection** (read only, *Archive* block of Memory cost): a section is dormant when
  its note was neither read nor found by a search for `archiveAfterDays` days (default 105) and
  the section was not edited in that time — per section once memglow's new section log
  (`section-ages.json`: hashes and days, never text) covers the window, per note before that; it
  needs that much counted history first (*Not enough data yet since …*), lists at most 20
  sections (biggest first), never the intro, index notes, notes without a theme or the archive
  itself. Documented limit: counters only see whole-note reads, so reads and searches are judged
  per note. **Applying**: *Copy prompt for your AI* always; with the assistant on, *Prepare
  without AI* (memglow builds the verbatim move itself) or *Do it with <provider>* (the AI only
  reviews the list — titles, sizes, a few masked lines — and chooses what to archive; memglow
  builds the move). Strict checks before showing and again before writing: every original note
  rebuilds exactly from the note and its archived sections, each section is in its archive note
  once and verbatim, same theme, append-only archive notes, never a file memglow did not make,
  every link names an existing note and heading; then diff, one-time token, backup, Undo.
  New route `POST /api/assistant/archive` (same access, CSRF and rate rules as the others).

- **`archive_lookup`** in `memglow-mcp` (read only): the archived sections whose topic or original
  note matches a query, from the archive summary — references only, never the archived text.

- **Proxy lever 6, `archiveHint`** (off by default, `MEMGLOW_PROXY_ARCHIVE_HINT`): when a search finds
  nothing in the live memory, adds "memglow: nothing found in the live memory — the archive summary
  lists: …" with matching archived section titles only.

- **Journal: machine and channel.** Each line now reads *action · group · note · machine ·
  channel · tool*, e.g. *Write · Projects · Smart home · laptop · hook · Claude Code* (was
  *action · group · note · source*). `channel` is a closed list — `hook` (the bundled adapters and
  the legacy `hooks/memglow-activity.js`), `mcp-proxy`, `file` (a note changed on disk, no hook
  involved) or `api` (a direct call to the activity API) — and `machine` a short per-sender label
  (`MEMGLOW_MACHINE`, or `machine` in `~/.memglow/memglow.config.json`; default: short hostname),
  validated server-side (closed charset, 32 characters at most, never a path or an IP). Both are
  optional and purely additive: an activity sent without them (every pre-v0.4 sender, any direct
  `POST /api/activity` that does not set them) displays exactly as before. `POST /api/activity`
  accepts the two new optional fields; see [docs/api.md](docs/api.md).

- **Background: Light preset.** A fourth option next to Deep / Plain / Night blue: a near-white,
  mint-tinted scene, in the spirit of the project's own light charte. The glow is cut to a trace
  (threshold raised above the background itself); notes, links, names, sub-theme bubbles, the 3D
  legend and the read/search/write highlight colours (comets, target rings) are all darkened —
  same hue, just dark enough to read against white — instead of the near-white tones used on the
  three dark presets. Nothing changes for Deep, Plain or Night blue. Saved like every other
  setting (`lib/view.js` → `background`, now `"deep" | "plain" | "night" | "light"`).

- **Interface in 8 languages**: English (reference), French, German, Spanish, Brazilian
  Portuguese, Japanese, Korean and Simplified Chinese. Picks `navigator.languages` on first visit,
  falls back to English; switchable any time from **Settings → Language**, saved with the rest of
  the view (`lib/view.js` `SETTINGS.language`, `public/app.js` `VIEW_SETTINGS.langue`) like every
  other setting — one browser's choice follows to any device that opens the same instance. Zero
  dependency: one JSON file per language in `public/i18n/<code>.json`, served statically with the
  page's usual security headers, loaded by a small new `public/i18n.js` (`t(key, params)`, simple
  `{placeholder}` interpolation, `one`/`other` plurals, a plain string for a plural-less language).
  Product names (Claude Code, Codex, Cursor, Ollama…) and the word "token" are never translated;
  prompts memglow builds for the AI (the *Copy prompt for your AI* text, and what the optional
  assistant sends) always stay in English regardless of the interface language. See
  [Languages](README.md#languages) for how to add one.

- **v0.4 texts translated**: everything the protected groups, organisation, always-loaded,
  archive and journal work added to the page goes through the same keys, in all 8 languages
  (252 keys in all). Organisation suggestions carry their figures and display names (`facts`) and
  trimming tips their numbers (`tokens`, `threshold`, `name`), so the page words them in its own
  language; the English `message`, `reasons` and `text` stay in `/api/cost` for the MCP tool,
  the AI prompts and older pages.

- **Phone layout**: under 640 px wide, and on a phone held sideways (`(max-height: 500px) and
  (orientation: landscape)`, one query shared by `app.css` and `app.js`), the legend folds behind
  a *Themes* chip, *Find a note* behind a magnifier, and Settings behind a gear that opens a bottom
  sheet (dimmed background, drag handle, *Close settings*, Escape; focus moved in and given back to
  the gear; no animation with reduced motion). The journal reads on two lines per entry, Memory
  cost names wrap, and the Assistant, Protected groups, Organisation, Always loaded and Archive
  blocks get full-width rows and 40 px buttons. Nothing changes above 640 px. Two new keys
  (`legend.toggle`, `settings.close`) in all 8 languages.

### Changed

- **Numbers and dates in the interface language**: token and note counts, percentages, days
  ("30 sept.", "9月30日"), the journal clock and change times now use `Intl` with the language
  chosen in Settings (before: English "3,000" / "Sep 1" everywhere, and the browser's locale for
  the clock). `t()` formats numeric parameters the same way. Prompts for the AI and the lines of
  the archive summary keep fixed English formats on purpose. The note tooltip ("≈ N tokens",
  "N notes") is translated too.

- Activity counters keep `started` (first day of counting) and `last` (last read / search / write
  day per note) beyond the 90-day purge; older counter files are migrated on load.

- **Journal line**: *action · group · note · machine · channel · tool* instead of
  *action · group · note · source* (see *Journal: machine and channel* above); the `file` and
  `demo` channels are translated, `hook`, `MCP proxy` and `API` are shown as they are.

- **`memglow-mcp`** now lists six read-only tools: `memory_health` (which also reports the
  always-loaded cost), `split_plan`, `related_notes`, `note_cost`, `organisation_suggestions` and
  `archive_lookup`.

- **Memory cost**: two new blocks side by side, *Organisation* and *Always loaded · every
  session*, then *Archive*. The assistant buttons are named after the default provider
  (*Do it with <provider>*, was *Do it with Claude*), and the Assistant panel handles three kinds of
  proposal — split, regroup, archive — with the same diff, one-time token, backup and Undo.

### Fixed

- **MCP proxy levers were invisible to Claude Code behind basic-memory** (found by the `bench/`
  benchmark): basic-memory, as a FastMCP server, sends every answer both in `content` and as
  `structuredContent: { "result": <same text> }`, and Claude Code gives the model the
  `structuredContent` when there is one — so the blocks the levers added to `content` never
  reached it, and dedupe/table-of-contents never applied (they skipped any `structuredContent`).
  The proxy now recognises that exact wrapper (one `result` key equal to the text of `content`)
  and keeps it equal to the annotated text; any other `structuredContent` is untouched, as before.

- **Archiving inside a protected group** (found while integrating the protected groups and the
  archive tier): an archive note is created in the group of the sections it receives, and now says
  so (`source` on the file), so the protected-groups check accepts it instead of refusing every
  archive plan that touches a protected group. A forged archive note in another group is still
  refused.

- **Archiving with a protected `defaultTheme` and no `archive` theme**: the archive summary
  (generated by memglow, without a group of its own) fell into the protected default group and the
  whole archive was refused. The plan now marks it as owned by memglow (`owner: "memglow"`, role
  `summary`, `memglow_archive_summary: true` in its frontmatter before and after), and only that
  file skips the protected-groups check; originals and same-theme archive notes are checked as
  strictly as before, and the flag written in a file's text grants nothing on its own.

### Security

- **Protected groups cover every proposal**: split, regroup and archive plans are checked against
  them when proposed and again at Apply, and every prompt memglow writes for an AI — split, regroup
  and archive copy prompts included — names them.

- **Assistant**: off by default; when off its routes, script and buttons do not exist (`404`). The
  AI never gets a tool and never writes: memglow validates, shows the exact diff, needs a one-time
  server token (2 min, single use), backs up first (no backup, no write) and keeps Undo. Secret-
  looking lines are masked before anything is sent. API keys only from the environment or a
  mode-600 file, never sent to the browser, never logged.

- **New write routes** (`PUT /api/zones`, `POST /api/assistant/archive`): same access rule as the
  page, `X-Memglow` header + same origin, rate limited, small bodies, strict validation;
  `zones.json` is mode 600, written atomically in the data folder, never in the notes folder.

- **Read-only by construction**: `memglow-mcp` has no write tool and returns no full note body;
  `archive_lookup` and the proxy's `archiveHint` return titles and references only, never archived
  text. The journal's `machine` field is validated server-side (closed charset, 32 characters, never
  a path or an IP).

- **Interface texts**: translations are static files shipped with memglow; note titles, group
  names, sub-themes and every server text are escaped before they reach `innerHTML`.

## 0.3.1 — 2026-10-01

### Fixed

- Double-click on the background (recenter / overview) now works with Mac trackpads: the native
  `dblclick` event is used, small pointer moves between the two clicks no longer cancel it.
- Memory cost: the "N notes = X %" line now uses the smallest set of notes covering 80 % of the
  reading (it said "8 notes = 100 %" when only 8 notes had been read).

### Changed

- New README screenshots, including the Memory cost panel and the Deep background.
  `demo/record/screenshots.js` also captures Memory cost (counts in a throw-away data folder) and
  can render on a GPU (`GPU=1`).
- Release workflow on the Node 24 majors of its actions (checkout, setup-node, Docker actions).

## 0.3.0 — 2026-10-01

Memory cost: see which notes cost your assistant the most tokens, and which ones to split.

### Added

- **Memory cost** panel, below the graph (`GET /api/cost`). Token estimates (≈ bytes ÷ 4, shown
  with "≈" everywhere — an estimate, not a promise of savings): tokens read today and over 7 days,
  tokens written over 7 days, size of the whole memory and of the index note, "N notes = X % of
  tokens read", the 10 notes that cost the most to read (click to open), notes above 5,000 tokens
  with their `##` sections and a deterministic split suggestion (consecutive sections, parts of
  about 2,000 tokens), and notes never read in 30 days (once 30 days of counts exist; before
  that, "Data since …").
- **Copy prompt for your AI** on each large or costly note: a ready-to-paste prompt (note,
  ≈ tokens, reads over 7 days, threshold, suggested parts) with rules that keep the memory
  consistent — same theme and folder, top-level themes unchanged, `theme`/`subtheme` frontmatter
  kept, `[[links]]` kept valid, the original becomes a short summary or goes away, only the
  agent's memory tool is used, and the plan is shown before anything is written.
- Activity counts per day, per note and per type (read / search / write) in memglow's own data
  folder (`MEMGLOW_DATA_DIR`, default `~/.memglow`, `/data` in the Docker image): note ids and
  numbers only, 90 days kept. Activity sent with `"demo": true` is not counted.
- New settings: **Size by** (links / token cost), **Bubble size** (0.5× to 3×), **Background**
  (Deep, Plain, Night blue), **Signal speed**, **Name distance**.
- Config: `largeNoteTokens` (or `MEMGLOW_LARGE_NOTE_TOKENS`), `splitChunkTokens`, `dataDir`.
- Token estimate in the note tooltip and the note panel.
- Demo: a long fictional incident log to show the split suggestion; `demo/simulate.js --counted`
  fills Memory cost.
- **View saved on the instance** (`GET`/`PUT /api/view`): settings, bubble layout (positions,
  pinned bubbles) and camera, in `view.json` in memglow's data folder (`/data` in Docker). One
  view per instance: every browser and device that opens it gets the same view. The page reads
  it before building the graph (falls back to its `localStorage` copy if the server does not
  answer within 2.5 s), restores the camera without animation, puts new notes next to their
  sub-theme bubble, and saves in groups (settings after 0.5 s, layout and camera after 2 s, a
  last save when the page is closed). Reduced motion is respected.
- **Rearrange** button in Settings: a fresh layout, settings kept.

### Changed — journal and counts

- Journal lines read **action · group · note · source** — *Write · Projects · Release notes ·
  Claude Code* — with the group (top-level theme) as a small tag tinted with its colour; the dot
  keeps the action's colour. Same for *Note changed / New note / Note removed* (source *File*).
  Known tools get their product name (Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf,
  Cline, MCP).
- Memory cost counts are **dynamic and de-duplicated**: a note whose body changes on disk counts
  as a write even without a hook (an assistant without hooks, an edit by hand); a hook reporting
  the same write within 15 s is not counted twice, whichever comes first. Frontmatter-only
  changes and moved files are not writes. The panel refreshes about 1.5 s after an activity or a
  note change (bursts grouped); the server recomputes only when counts or notes changed.
- *Copy prompt for your AI*: the group is spelled out, the split is given as K numbered parts,
  a costly note under the size threshold is described as such (not as "too large"), and a
  partial first week says "counted since …".

### Changed — visual polish

- The signal, not the link: while a comet runs along a link the link stays dark; only the comet
  lights the way (bigger, brighter head, additive trail), then a trace fades out. Comets are a bit
  slower by default (1.8 s per link, see *Signal speed*).
- Deep background by default: radial gradient, vignette and faint fixed star dust, all below the
  glow threshold (no washed-out background).
- Bubbles keep a minimum size on screen, so they stay visible when zoomed out.
- The index note is the "sun" of the graph: larger, warm white, with a soft corona.
- Double-click on the empty background goes back to the overview.
- "Links at rest: Hidden" now hides everything, including the threads to sub-theme bubbles.

### Fixed

- Clicking a sub-theme bubble now lights its notes (it lit none).
- memglow writes nothing if its data folder is set inside the notes folder (counts and view are
  then kept in memory only, with a warning).
- **Spacing**: "Minimum spacing" had almost no effect at the default spread. It is now relative
  to the spread and the collision is firmer, so spacing wins over gravity.
- Hidden themes (legend) were dropped on reload with custom themes.
- A masked secret-looking heading now stays a heading, so a note keeps its sections.

### Security

- **DNS-rebinding guard.** Without `MEMGLOW_PASSWORD`, only requests addressed to `localhost`,
  `127.0.0.1`, `[::1]` or a name listed in the new `MEMGLOW_ALLOWED_HOSTS` are served; any other
  host name gets a `403` with instructions. Before, a malicious page could re-point its domain to
  127.0.0.1 and read the viewer (note bodies included) from a visitor's browser. Hooks are not
  affected (`/api/activity` is checked by its token first). If you open memglow by a LAN name
  without a password, add that name to `MEMGLOW_ALLOWED_HOSTS` (or set a password).
- `/api/view` follows the page's access rule (`MEMGLOW_PASSWORD`). Writes need memglow's own
  `X-Memglow` header and a same-host `Origin` (else `403`), are capped at 256 KB (`413`), rate
  limited (`429`), and strictly validated: a closed list of settings with types and bounds,
  finite bounded coordinates for existing notes and sub-theme bubbles only (2,000 at most),
  pinned ⊆ positions, bounded camera; everything else — `__proto__` included — is dropped.
  Written atomically (mode 600) in the data folder, never in the notes folder.

## 0.2.1 — 2026-09-30

Published on npm (`npx memglow`) and as a Docker image (`ghcr.io/r0zumnik/memglow`, amd64 + arm64).

## 0.2.0 — 2026-09-30

Not only Claude Code any more.

### Added

- **Adapters for seven AI tools**, each on its vendor's documented hook mechanism: Claude Code
  (`PostToolUse`), OpenAI Codex CLI (`PostToolUse`, `apply_patch` paths), Gemini CLI
  (`AfterTool`), Cursor (`beforeReadFile`, `afterFileEdit`, `afterMCPExecution`), Windsurf /
  Devin Desktop (Cascade `post_read_code`, `post_write_code`, `post_mcp_tool_use`), GitHub
  Copilot CLI (`postToolUse`) and Cline (`PostToolUse` script). One shared core
  (`lib/agent-core.js`): note names only, detached sender, 3 s timeout, silent, always exit 0,
  and the exact stdout each tool expects (`{}` for Gemini, `{"permission":"allow"}` for Cursor's
  read hook, `{"cancel":false}` for Cline).
- **MCP proxy** (`memglow-mcp-proxy`) for any MCP client, including those without hooks
  (Claude Desktop, Continue, Roo Code…): stdio and streamable HTTP, relays bytes unchanged,
  reports successful `tools/call` as read / search / write, mapping overridable with
  `MEMGLOW_PROXY_MAP`.
- **Installer**: `memglow init` finds the notes folder (basic-memory, Obsidian or `--dir`), writes
  a config and a random token to `~/.memglow`, detects installed AI tools and adds their hooks
  (backup first, existing entries kept, unparsable files left untouched), optionally wraps Claude
  Desktop's memory MCP servers, optionally writes a Docker Compose file. Interactive, or `--yes`.
  `memglow uninstall` removes exactly what it added (`--restore-backups`, `--purge`).
- `bin/memglow.js` (`memglow`, `memglow init`, `memglow uninstall`), usable today with
  `npx github:R0zumnik/memglow`; the server falls back to `~/.memglow` when nothing else is
  configured.
- `docs/api.md`: the activity API for any agent or script, with curl, Python and Node examples.
- `docker-compose.example.yml` and Docker instructions for `ghcr.io/r0zumnik/memglow` (image not
  published yet; local `docker build` documented).
- README "Works with" table and a matching section on the project page.
- Tests for every adapter (realistic payloads and the real hook scripts against a fake
  receiver), the installer (fake home, backup, idempotence, uninstall, restore) and the proxy
  (fake stdio and HTTP upstreams, faithful relay, errors, exit codes).

### Fixed

- README menu links: headings start with an emoji, so GitHub's generated anchors did not match
  the links (`#-quick-start`, and worse for `⚙️`). Every targeted heading now has an explicit
  `<a id="…">` anchor, and every internal link has been checked.
- The Features table no longer shows an empty header row on GitHub (`| Feature | What it does |`);
  the other tables got real headers too.

## 0.1.0 — unreleased

First version.

- Live 3D graph of a folder of Markdown notes: `[[wikilinks]]` as links, themes and sub-themes
  from frontmatter or folders, glow by recency.
- Live changes by polling (works on network volumes); a note only "changes" when its body does.
- Activity API (`POST /api/activity`, bearer token) and a ready-to-use Claude Code hook:
  reads, searches and writes light up the matching notes, with comets along the links and a
  camera that follows the action.
- Settings panel (spread, gravity, spacing, glow, names, links at rest, auto-rotate…),
  searchable notes, note panel with body (secret-looking lines masked).
- Optional HTTP Basic auth, zero runtime dependencies, Dockerfile.
