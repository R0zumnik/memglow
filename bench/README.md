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
node bench/replay.js --with alreadyLoaded                # + a defaults-plus-alreadyLoaded row
node bench/replay.js --with dedupe,toc --with alreadyLoaded   # one row per --with (repeatable)
node bench/replay.js --memory-dir path/to/notes --events path/to/events.jsonl --json
```

- `--events` accepts a JSONL file (or a plain JSON array) of tool calls, one call per line:
  `{"session":"s1","tool":"read_note","args":{"identifier":"MEMORY"},"t":1}`. It also accepts the
  r0zumnik portal's own activity shape, `{"evenements":[{"type":"lecture"|"recherche"|"ecriture",
  "ids":[...],"source":"nas"|"mac","t":...}]}` — sessions are inferred from `source` plus a
  silence of more than 30 minutes.
- `--with a,b,c` adds a configuration: the shipped **defaults** (sizeWarning + searchDetails +
  suggestions on) with levers `a`, `b`, `c` also forced on. Repeat the flag for more rows.
- `off` and `defaults` are always run, as the two fixed reference points.
- `--json` for machine output (`{ rows, anyViolations }`); otherwise a short table.

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
defaults                      14     6329      -1041 (-19.7%)            0
+alreadyLoaded                14     2379      +2909 (+55.0%)            0
```

`defaults` costs MORE tokens than `off` here, and that is expected: sizeWarning / searchDetails /
suggestions only ADD explanatory text, they never cut anything. `alreadyLoaded` is the lever that
actually removes tokens (by stubbing a note memglow knows is already in context), which is why
its row drops well below both — on this event file it stubs every one of the 4 re-reads of
`MEMORY.md`. `dedupe` and `toc` would do the same for same-session re-reads / oversized notes
respectively; the demo memory has none large enough to trigger `toc` (threshold 5,000 tokens),
which is why `--with toc` alone matches `defaults` exactly on this particular event file — not a
bug, just nothing in it to cut.

Tests: `test/bench-replay.test.js` (the correctness guard on hand-built fixtures, including one
that pins what an artificially broken lever looks like to the guard; event loading/grouping; the
demo table's own invariant — `off` vs `+alreadyLoaded`, positive saving, 0 violations).
