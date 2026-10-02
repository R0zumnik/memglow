# memglow bench

Two very different tools live here:

- **`bench/run.js`** — real `claude -p` runs against a real memory server. Costs real money,
  needs a network and an API/subscription budget. See its own header comment and
  `bench/RESULTS.md` for the protocol and the results it has produced so far.
- **`bench/replay.js`** — the **free replay harness** (stage 0.4.2.1b). No model call, no
  network, deterministic. Read on.

## Replay (free)

`bench/replay.js` drives `lib/proxy-levers.js::createLevers` directly — the exact same
`clientMessage`/`serverMessage` entry points the real MCP proxy uses — against a tiny in-process
fake upstream that answers from a folder of notes. It replays a fixed sequence of tool calls
(reads, searches, writes) through several named lever configurations and reports, per
configuration: calls, tokens delivered to the model, and savings against the `off` baseline.

It also runs a **correctness guard**: for every read, the note's full CURRENT text must still be
reachable by the model — delivered in full earlier in the same session and unchanged since, or
in the always-loaded context (the index note, or a configured `alwaysLoaded` entry) and
unchanged, or the stub names the escape hatch (`memglow_fresh`). Anything else is a violation,
and the process exits 1.

```
node bench/replay.js                                    # off vs defaults, demo/memory + bench/replay-demo.jsonl
node bench/replay.js --each                               # + a per-lever breakdown (each lever alone, vs off)
node bench/replay.js --with alreadyLoaded                # + a defaults-plus-alreadyLoaded row
node bench/replay.js --with dedupe,toc --with alreadyLoaded   # one row per --with (repeatable)
node bench/replay.js --memory-dir path/to/notes --events path/to/events.jsonl --json
node bench/replay.js --memory path/to/notes                # "--memory" is an alias for "--memory-dir"
node bench/replay.js --turn-tokens 8000                 # a different per-call overhead (default 5000, see 0.4.2.5)
```

- `--events` accepts a JSONL file (or a plain JSON array) of tool calls, one call per line:
  `{"session":"s1","tool":"read_note","args":{"identifier":"MEMORY"},"t":1}`. It also accepts the
  r0zumnik portal's own activity shape, `{"evenements":[{"type":"lecture"|"recherche"|"ecriture",
  "ids":[...],"source":"nas"|"mac","t":...}]}` — sessions are inferred from `source` plus a
  silence of more than 30 minutes. `bench/replay-demo.jsonl` is the small shipped demo (14 calls,
  3 sessions); `bench/replay-heavy.jsonl` is a bigger synthetic one (67 calls, 4 sessions, closer
  to a real working session: the same handful of notes read and searched repeatedly, plus a
  one-off tail, plus — since stage 0.4.2.2b — a few bursts of 2-3 consecutive searches with no
  read between them, to exercise the `multiQuery` lever below) — both are replayed in
  CI-equivalent tests (`test/bench-replay.test.js`). `bench/replay-aliases.jsonl` (stage
  0.4.2.4) is for the `aliases`/`learnAliases` levers: a few miss → read → similar-search
  scenarios, some followed by a `dropIfHinted` retry search. Two extra, measurement-only event
  fields support it: `expect` (the note id a search is "about", to count whether it came back in
  the delivered answer — reported as a separate "hit rate" block under the main table, silent for
  every other fixture) and `dropIfHinted` (a retry search skipped entirely — no call, nothing
  counted — once the session's most recent `expect` search already found that exact note,
  modelling "a later re-search that becomes unnecessary once the note is already there").
  `bench/replay-negative-cache.jsonl` (stage 0.4.2.6) is for the `negativeCache`/`indexHint`
  levers: a search superseded with no read, then read-redeemed, then a dedicated session where
  the SAME search recurs once the memory is unchanged — `dropIfHinted` there works WITHOUT
  `expect` (it has nothing to do with a note id): the retry is dropped whenever the most recent
  search in that session already carried the `negativeCache` hint text, tracked the same way as
  the `expect`-based case but independently of it (see `runConfig`'s `lastNegativeCacheHinted`).
- `--with a,b,c` adds a configuration: the shipped **defaults** (sizeWarning + multiQuery +
  aliases + learnAliases — see 0.4.2.2b and 0.4.2.5 below) with levers `a`, `b`, `c` also forced
  on. Repeat the flag for more rows. A name prefixed with `-` forces that lever OFF instead (e.g.
  `-multiQuery`), to isolate one lever from another's own effect on the same fixture — see
  `aliases`/`learnAliases` below.
- `--turn-tokens n` (0.4.2.5, default 5000) sets the per-call overhead used for the **effective
  tokens** column — see that stage's section below.
- `--each` adds one row per lever (sizeWarning, indexWarning, searchDetails, suggestions, dedupe,
  toc, archiveHint, hideUnsupportedTools, alreadyLoaded, multiQuery, aliases, learnAliases,
  negativeCache, indexHint), each ALONE against the `off`
  baseline (every other lever off) — unlike `--with`, which starts from the shipped defaults. This
  is the per-lever "does it add or save tokens, and how much" breakdown used to decide, lever by
  lever, whether to keep it as shipped, shorten its text, or turn it off by default (see
  `lib/proxy-levers.js`'s `DEFAULTS` comment and the CHANGELOG entries for stages 0.4.2.2 and
  0.4.2.2b). For `multiQuery`, "tokens added/saved" also comes with a call-count change — see
  the main table's `calls` column, since that lever's whole point is fewer round trips, not just
  fewer tokens.
- `off` and `defaults` are always run, as the two fixed reference points.
- `--json` for machine output (`{ rows, anyViolations }`); otherwise a short table (plus the
  per-lever one with `--each`).
- Any flag not in this list is a **hard error** (exit 2) instead of being silently ignored —
  `--memory` (a common typo for the real flag, `--memory-dir`) is the one exception: it is an
  alias, not a typo, and works exactly like `--memory-dir`.

**Rule for every future engine micro-step touching `lib/proxy-levers.js`, `mcp-proxy/`, or the
always-loaded/archive helpers it calls into: run `bench/replay.js` and show the numbers (gain +
0 violations) before merging.** It costs nothing and takes under a second, so there is no excuse
to skip it — a real `bench/run.js` pass is still worth doing before a release, but it is not a
substitute for this one on every commit.

Sample output on the shipped demo (`off` vs `defaults` vs `+alreadyLoaded`, `demo/memory` +
`bench/replay-demo.jsonl`, 3 sessions with two re-reads of the index note each):

```
(effective tokens = tokens + calls × turn-tokens; turn-tokens = 5000)
configuration              calls   tokens  effective   eff. savings vs off   violations
---------------------------------------------------------------------------------------
off                           14     5288      75288            +0 (+0.0%)            0
defaults                      14     5288      75288            +0 (+0.0%)            0
+alreadyLoaded                14     1578      71578         +3710 (+4.9%)            0
```

(The "effective" column and its `turn-tokens` constant are new at stage 0.4.2.5 — see that
stage's section below. `defaults` here already includes `aliases`+`learnAliases` since that same
stage; neither has anything to learn or inject on this fixture, so the row is unchanged.)

**Stage 0.4.2.2 ("lean defaults")**: `defaults` no longer costs more than `off`. Before this
stage, `searchDetails` and `suggestions` were ON by default and only ADDED explanatory text (they
never cut anything) — on this same demo file `defaults` used to deliver 6,329 tokens, −19.7% vs
`off`'s 5,288, and the free replay harness cannot credit the extra reads/searches such text might
avoid, so it always reads as a pure loss. Measured against a real 2-day usage log too (91 calls:
`off` 116,052 tokens, `defaults` 132,257, +14%), the numbers did not support keeping either lever
on: `searchDetails` and `suggestions` are now OFF by default (shortened either way — see
`lib/proxy-levers.js`'s `DEFAULTS` comment — for whoever opts back in). `sizeWarning` stays ON: a
single short line, once per large note per session, that plausibly prevents a wasted call — on a
session that touches an oversized note it can still make `defaults` cost a FEW tokens more than
`off` (this is that lever doing its job), which is why both shipped event files avoid reading one;
see `bench/replay-heavy.jsonl` below and the `sizeWarning` tests in
`test/mcp-proxy-levers.test.js` for that case on its own. `alreadyLoaded` is the lever that
actually removes tokens (by stubbing a note memglow knows is already in context), which is why
its row drops well below both — on this event file it stubs every one of the 4 re-reads of
`MEMORY.md`. `dedupe` and `toc` would do the same for same-session re-reads / oversized notes
respectively; the demo memory has none large enough to trigger `toc` (threshold 5,000 tokens).

`node bench/replay.js --each` isolates each lever against `off` (every OTHER lever off), rather
than starting from `defaults` like `--with` does — this is the table used to decide, per lever,
keep / shorten / off by default:

```
per-lever breakdown (each lever alone, vs off):
lever                     tokens added/saved           effective   violations
-----------------------------------------------------------------------------
sizeWarning                                0                   0            0
indexWarning                               0                   0            0
searchDetails                     +483 added          +483 added            0
suggestions                       +331 added          +331 added            0
dedupe                           -1449 saved         -1449 saved            0
toc                                        0                   0            0
archiveHint                                0                   0            0
hideUnsupportedTools                       0                   0            0
alreadyLoaded                    -3710 saved         -3710 saved            0
multiQuery                                 0                   0            0
aliases                                    0                   0            0
learnAliases                               0                   0            0
```

(The extra `effective` column is 0.4.2.5; on this fixture it never differs from the raw column
because no row here changes the CALL count. `bench/replay-aliases.jsonl`, below, is where it
differs — that is the whole point of this stage.)

On `bench/replay-heavy.jsonl` (67 calls, 4 sessions, closer to a real working session — the same
handful of notes read and searched repeatedly across a few topics, a few bursts of 2-3 searches
in a row, plus a one-off tail of notes touched once), the same shape holds at a larger scale:
`off` 67 calls / 17,581 tokens, `defaults` 60 calls / 16,864 tokens (+717 vs off — no large note
in this file, so that's entirely `multiQuery`'s doing); alone against `off`, `searchDetails`
+1,466, `suggestions` +1,376, `dedupe` −4,314, `alreadyLoaded` −9,646, `multiQuery` −717 tokens
AND 7 fewer calls (one per burst — see lib/proxy-levers.js's `DEFAULTS.multiQuery` comment and
`mergeSearchBursts` in this file for how a burst becomes one call here).

### Stage 0.4.2.2b — `multiQuery` ("several phrasings, one call")

The built-in rule "search in 2-3 phrasings" (lib/memory-rules.js's first rule) used to cost 2-3
separate model turns, every time: a real usage log showed 20 of 40 searches were immediately
followed by ANOTHER search, before any read. `multiQuery` (lever 9, `lib/proxy-levers.js`) lets a
client send all of them in ONE call (`memglow_queries`, advertised on search tools in
`tools/list`), sends one upstream search per phrasing sequentially, merges the hits (deduped by
note id — a note found by several phrasings ranks higher — capped to the upstream's usual result
count), and returns ONE result. Modelled here by `mergeSearchBursts()`: a run of consecutive
searches by the same session, no read in between, within 2 minutes, becomes one call carrying
`memglow_queries` before the replay loop runs — so `calls` below counts client-facing round
trips, exactly what this lever is meant to cut. On by default (`DEFAULTS.multiQuery`): fewer
calls AND fewer tokens than `off`, on the only file with bursts to show it, 0 violations.

Tests: `test/bench-replay.test.js` (the correctness guard on hand-built fixtures, including one
that pins what an artificially broken lever looks like to the guard; event loading/grouping,
`mergeSearchBursts` on its own; the demo AND heavy tables' own invariant — `defaults` tokens
`<=` `off` tokens AND `defaults` calls `<=` `off` calls, 0 violations everywhere; a guard against
`SHIPPED_DEFAULTS` drifting from `lib/proxy-levers.js`'s own `DEFAULTS`; `parseArgs` — the
`--memory` alias, unknown flags rejected, `--each`).

### Stage 0.4.2.5 — "count the turns": effective tokens, and `aliases`+`learnAliases` turned on

**The problem.** Scoring a lever on raw tool-result tokens alone undercounts what a tool CALL
costs: every extra call is an extra model turn, which re-sends the system prompt, every MCP
tool's schema, and the conversation so far — not just that one tool's own result. On
`bench/replay-aliases.jsonl`, `aliases`+`learnAliases` (isolated from `multiQuery`'s own
call-merging with `-multiQuery`) makes 2 FEWER calls than `off` but costs 25 MORE raw tokens
(758 → 783) — a real win on calls that the raw-tokens column alone makes look like a loss,
which is exactly why this lever shipped off at 0.4.2.4.

**The fix: effective tokens.** Every row now also reports `effective = tokens + calls *
turnTokens` (`--turn-tokens`, default `DEFAULT_TURN_TOKENS` = 5000). That default is derived from
`bench/results/*.jsonl` (326 real recorded turns from real `claude -p` runs — `sonnet.jsonl`,
`haiku.jsonl`, `haiku-prefix.jsonl`, `split-gain.jsonl`, see `bench/run.js`): for each row,
"overhead per call" = `(tokens.input + tokens.cacheCreate + tokens.cacheRead) -
estimateTokens(toolResultChars)`, divided by `toolCalls` — i.e. everything the API billed for
MINUS what the tool results themselves are worth. Across all 326 rows that ranges roughly
4,000-19,000 per call (median ≈12,750; 10th percentile ≈6,500), almost all of it the system
prompt and tool schemas resent on every turn. **5,000 is a deliberate UNDER-estimate** (below the
10th percentile, not the median): the goal is to stop penalizing a lever for cutting a call, not
to inflate how much cutting one is worth. See `bench/replay.js`'s `DEFAULT_TURN_TOKENS` comment
for the exact numbers; a host or fixture with smaller tool schemas will see a smaller REAL
overhead than this default, so treat it as a floor and pass `--turn-tokens` with a number measured
for your own setup when it matters.

**The new merge rule.** A lever earns ON by default only when, vs `off`: 0 violations, AND its
effective tokens are `<=` off's, AND (its raw tokens are `<=` off's OR it makes fewer calls than
off). This is still a human reading the table and applying the rule by eye — same as every earlier
stage — not something this file auto-verdicts.

**Re-decided**, on all three fixtures that exercise levers 9/10 (`bench/replay-demo.jsonl`,
`bench/replay-heavy.jsonl`, `bench/replay-aliases.jsonl`), `--with aliases,learnAliases,
-multiQuery` vs `off`:

| fixture | calls (off → lever) | raw tokens (off → lever) | effective (off → lever) | rule holds? |
|---|---|---|---|---|
| replay-demo.jsonl | 14 → 14 | 5288 → 5288 | 75288 → 75288 | yes (no-op, nothing to learn/inject here) |
| replay-heavy.jsonl | 67 → 67 | 17581 → 17581 | 352581 → 352581 | yes (no-op, same reason) |
| replay-aliases.jsonl | 16 → 14 | 758 → 783 | 80758 → 70783 | yes (fewer calls wins: effective 70,783 < 80,758) |

The rule holds on all three, so **`aliases` and `learnAliases` now ship ON by default**
(`lib/proxy-levers.js`'s `DEFAULTS.aliases`/`DEFAULTS.learnAliases`, and `SHIPPED_DEFAULTS` here,
mirrored in lockstep as always).

**`dedupe` was also re-checked** against the same rule, for completeness — it is still OFF by
default and this stage does **not** change that (left to the owner: it replaces a note's content
with a short "unchanged" stub mid-session, a context-compaction risk the effective-tokens number
does not capture). For the record, it also PASSES the rule on all three files (it only ever saves
raw tokens, same `off`-or-better calls everywhere), so there is nothing in this harness's own
numbers blocking turning it on too — purely a judgment call left for later.

**Also fixed**: a search carrying lever 9's own `memglow_queries` used to bypass
`aliases`/`learnAliases` entirely — `multiQuery.run()` answers the whole multi-phrasing burst
OUTSIDE the normal `clientMessage`/`serverMessage` cycle that lever 10 hooks into via
`handleSearch`, so it could neither learn from a multi-phrasing search nor inject into one (see
the "known limitation" callout in CHANGELOG 0.4.2.4's own entry, now resolved). Fixed by
`applyAliasesToSearch()` (`lib/proxy-levers.js`), called from `multiQuery.run()` on the merged
result: `s.lastSearch` now records the UNION of every phrasing's own significant words (not just
the main query's), and the same injection rule (first learned candidate, prepended, never
replacing a row) applies to the merged result. `bench/replay.js`'s own `multiQuery` branch passes
the event's `session` through to `engine.multiQuery.run()` so this has a session to record into
during a replay, same as the real proxy (`mcp-proxy/memglow-mcp-proxy.js` now passes the HTTP
`Mcp-Session-Id` through too; stdio already used a single implicit session).

Tests: `test/mcp-proxy-levers.test.js` (end to end, stdio: a multi-phrasing search that misses
teaches EVERY phrasing's words, not just the main query; a learned candidate is injected into a
multi-phrasing search's own merged result; `applyAliasesToSearch` unit-tested on its own) and
`test/bench-replay.test.js` (`--turn-tokens` parsing, `summarize`'s `effectiveTokens`/
`effSavingsAbs` arithmetic, including the `turnTokens = 0` no-op case).

### Stage 0.4.2.6 — "negative cache + the index already answers"

Two new levers (11 `negativeCache`, 12 `indexHint`; `lib/negative-cache.js` + `lib/proxy-levers.js`),
re-run against the SAME 0.4.2.5 merge rule, `--each` (each ALONE vs `off`) on all four
levers-relevant fixtures — the three above plus a new, dedicated
[`bench/replay-negative-cache.jsonl`](replay-negative-cache.jsonl):

| fixture | `negativeCache` alone (raw / effective, vs off) | `indexHint` alone (raw / effective, vs off) |
|---|---|---|
| replay-demo.jsonl | 0 / 0 (no-op) | +96 / +96 |
| replay-heavy.jsonl | +52 / +52 (hint fires for real, no call saved to offset it) | +391 / +391 |
| replay-aliases.jsonl | 0 / 0 (no-op) | 0 / 0 (no-op, never reads the index) |
| replay-negative-cache.jsonl | +23 / **-4977** (1 call dropped — see below) | +78 / +78 |

`indexHint` never saves a call anywhere it fires — same bucket as `searchDetails`/`suggestions`/
`archiveHint` (stage 0.4.2.2): the rule fails outright, so it **ships off**.

`negativeCache` is the more interesting case. Its own dedicated fixture (`neg-3` session: the same
search, once answered "no" and once repeated after nothing changed) models the win EXACTLY like
`bench/replay-aliases.jsonl` modelled lever 10's at 0.4.2.4 — a `dropIfHinted` retry search that is
unnecessary once the first repeat already carried the negativeCache hint (tracked without `expect`,
see the file list above): calls 7 → 6, raw tokens 990 → 1013 (+23), effective 35,990 → 31,013, a
clear win. But `bench/replay-heavy.jsonl` was built for OTHER levers (`multiQuery`'s search
bursts), and it happens to contain a genuinely recurring search ("storefront", searched again
later in the same session after nothing changed) that trips the SAME hint for real — +52 raw AND
effective tokens there, because that fixture has no matching `dropIfHinted` retry to model the
model actually skipping the repeat. The merge rule requires EVERY tested file to pass, and this
one real, unmodelled cost on `replay-heavy.jsonl` is enough on its own: **`negativeCache` ships
off**, same shape as `aliases` at 0.4.2.4 before its own dedicated fixture (and the effective-
tokens rule) made the case for turning it on. Flipping it on later would need either a broader
fixture that models the dropped retries a real session would have, or accepting the honest
trade-off as is.

Tests: `test/negative-cache.test.js` (pure pieces — `normalizedKey`, `memoryFingerprint`,
`recordFutileEntries`, `lookupFutileEntry`, `forgetStaleEntries` — plus the one fs-touching
`createNegativeCacheStore`: atomic write, mode 600, bounded, invalidation on write) and
`test/negative-cache-levers.test.js` (integration through `createLevers`: futile-then-hinted,
read-redeemed, write-invalidated, never leaks query text, both `indexHint` cases, and the
`alreadyLoaded` interaction).
