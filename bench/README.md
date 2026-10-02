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
  CI-equivalent tests (`test/bench-replay.test.js`).
- `--with a,b,c` adds a configuration: the shipped **defaults** (stage 0.4.2.2b: sizeWarning +
  multiQuery — see below) with levers `a`, `b`, `c` also forced on. Repeat the flag for more rows.
- `--each` adds one row per lever (sizeWarning, indexWarning, searchDetails, suggestions, dedupe,
  toc, archiveHint, hideUnsupportedTools, alreadyLoaded, multiQuery), each ALONE against the `off`
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
configuration              calls   tokens      savings vs off   violations
--------------------------------------------------------------------------
off                           14     5288          +0 (+0.0%)            0
defaults                      14     5288          +0 (+0.0%)            0
+alreadyLoaded                14     1578      +3710 (+70.2%)            0
```

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
lever                     tokens added/saved   violations
---------------------------------------------------------
sizeWarning                                0            0
indexWarning                               0            0
searchDetails                     +483 added            0
suggestions                       +331 added            0
dedupe                           -1449 saved            0
toc                                        0            0
archiveHint                                0            0
hideUnsupportedTools                       0            0
alreadyLoaded                    -3710 saved            0
```

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
