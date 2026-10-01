# memglow proxy levers — benchmark results (v0.4, 2026-10-01)

**Question.** Do the memglow MCP proxy levers reduce tool calls, tokens and time for a real
assistant, without making its answers worse?

**Short answer.**

1. **Before this benchmark, the levers did nothing at all for Claude Code behind basic-memory.**
   basic-memory (a FastMCP server) sends each answer twice — in `content` and as
   `structuredContent: { "result": … }` — and Claude Code gives the model the `structuredContent`.
   Every lever wrote into `content` only, and dedupe/toc skipped any answer with
   `structuredContent`. Fixed in this release (the proxy now keeps that wrapper equal to the
   annotated text); a control run with the previous proxy confirms the levers were inert.
2. **Default levers (size warning + search details + suggestions): no measurable effect.** All
   differences against the control are within the noise of this benchmark (≈ ±10 %).
3. **Table of contents first (`toc`, off by default): the only lever with a large effect —
   −64 % of note text received**, with 100 % correct answers. But the extra round trip to fetch
   the section costs more than it saves in raw tokens: **+15 % tool calls, +12 % input tokens,
   +12 % time**. Because the saved note text is fresh (uncached) input while the extra turn is
   mostly cached prompt, the **cost is 13 % lower** with Haiku (not significant with Sonnet, small
   sample).
4. **Session de-duplication (`dedupe`, off by default): no effect here** — one question per
   session rarely re-reads a note (it fired 10 times in 42 runs). It needs long sessions to be
   judged.
5. **Answer quality: no degradation detected — every answer of every variant was correct**
   (255/255 recorded runs — 225 Haiku, 30 Sonnet — including the "not in memory" question). This is also a ceiling:
   the questions are single-fact lookups, so a small loss of quality would not show.

## Protocol (as actually run)

| | |
|---|---|
| Memory | `demo/memory` (35 fictional notes) + 190 generated fictional notes (`bench/generate.js`, seed 42): **225 notes, ≈ 103,000 tokens**, 9 notes above 5,000 tokens (20–25 kB each), `[[links]]` everywhere, index note `MEMORY.md` ≈ 4,300 tokens. A throw-away copy, deleted afterwards. |
| Memory server | basic-memory **0.23.2** (`ghcr.io/basicmachines-co/basic-memory:latest`, image of 2026-08-25) in a disposable container on the copy, Streamable HTTP, SQLite full-text search (semantic search **off**). No write tool allowed. |
| Client | Claude Code CLI **2.1.283**, `claude -p … --output-format stream-json --verbose`, `--mcp-config` with ONE server named `memory`, `--strict-mcp-config`, `--tools ""` (no built-in tool: no shell, files or web), only `mcp__memory` allowed and its write tools denied, `--restricted` (no user/project settings, so no hooks), `--no-session-persistence`, `--max-budget-usd` per run, empty working folder, clean environment. |
| Models | **Haiku** (claude-haiku-4-5): all 21 questions × 5 variants × 2 repetitions = **210 runs**. **Sonnet**: 5 questions (1 small, 2 large, 2 link) × A, C, E × 2 = **30 runs**. |
| Questions | `bench/questions.json`: **21 factual questions** with a known answer — 7 in a small note, 8 deep inside a note over 5,000 tokens, 5 needing a `[[link]]` to be followed (2 of them ending in a large note), 1 whose answer is not in the memory (the assistant must say so). Automatic check: a regular expression on the final answer; `node bench/run.js --check` verifies each answer sits in the expected note. A sample of answers of every question was also read by hand: all regex verdicts were right. |
| Variants | **A** direct to the server · **B** through the proxy, every lever off (pure relay — the control for a lever) · **C** default levers (`sizeWarning`, `searchDetails`, `suggestions`) · **D** C + `dedupe` · **E** C + `toc`. |
| Order | (question × variant × repetition) shuffled with a fixed seed, one run at a time. |
| Measures | From stream-json: memory tool calls (and per tool), input tokens (uncached + cache read + cache write), output tokens, characters of tool results actually given to the model (÷ 4 ≈ tokens), duration, cost. From the proxy (`durationMs`, new in this release): memory server time per call. |
| Statistics | Mean, median, standard deviation per run; difference = ratio of per-question means, with a 95 % bootstrap interval resampling the questions (paired design). |

**Noise floor.** B is a byte-for-byte relay of A, yet the analysis reports B vs A at +7 % input
tokens and +10 % cost with intervals that exclude zero. That is run-to-run variability of the
model (e.g. on q16 one A run skipped the index note while the next ones read it), which the
question-level bootstrap with 2 repetitions under-estimates. **Read any difference below
≈ 10–15 % as noise**, and compare a lever with **B**, not A.

## Results — Haiku (210 runs)

Mean per run; differences against **B** (the control) with a 95 % interval; **bold** = interval
excludes 0.

| Variant | Correct | Tool calls | Input tokens | Output tokens | Note text received (≈ tokens) | Time (s) | Cost ($, list price) |
|---|---|---|---|---|---|---|---|
| A direct | 42/42 | 3.95 (−2 %) | 50,030 (**−7 %**) | 520 (−5 %) | 3,138 (**−15 %**) | 8.4 (−4 %) | 0.0170 (**−9 %**) |
| B proxy, off | 42/42 | 4.02 | 53,771 | 545 | 3,693 | 8.8 | 0.0187 |
| C defaults | 42/42 | 3.76 (−7 % [−14, +1]) | 50,652 (**−6 %** [−11, −0]) | 520 (−4 %) | 3,540 (−4 % [−20, +7]) | 10.0 (+14 % [−8, +53]) ¹ | 0.0180 (−4 % [−11, +2]) |
| D + dedupe | 42/42 | 4.14 (+3 % [−5, +11]) | 55,982 (+4 % [−3, +11]) | 556 (+2 %) | 3,547 (−4 % [−20, +7]) | 9.0 (+2 %) | 0.0193 (+3 % [−5, +12]) |
| E + toc | 42/42 | 4.62 (**+15 %** [+4, +25]) | 60,449 (**+12 %** [+6, +20]) | 609 (**+12 %**) | 1,325 (**−64 %** [−76, −45]) | 9.8 (**+12 %** [+5, +19]) | 0.0162 (**−13 %** [−21, −4]) |

¹ one C run took 81 s (a slow API answer); median C time 7.8 s vs 8.2 s for B.

Questions where a large note is involved (large + link, 13 questions, 26 runs per variant):

| Variant | Correct | Note text received | Input tokens | Tool calls | Time (s) |
|---|---|---|---|---|---|
| A | 26/26 | 4,776 | 54,119 | 4.23 | 9.1 |
| B | 26/26 | 5,252 | 57,152 | 4.12 | 9.2 |
| C | 26/26 | 5,337 | 55,827 | 4.15 | 11.6 |
| D | 26/26 | 5,330 | 61,408 | 4.50 | 9.7 |
| E | 26/26 | **1,643** | 68,462 | 5.27 | 11.0 |

## Results — Sonnet (30 runs, small sample)

| Variant | Correct | Tool calls | Input tokens | Note text received | Time (s) | Cost ($) |
|---|---|---|---|---|---|---|
| A direct | 10/10 | 2.20 | 45,402 | 3,797 | 8.7 | 0.0395 |
| C defaults | 10/10 | 2.30 (+5 %) | 47,167 (**+4 %**) | 3,948 (**+4 %**) | 8.0 (−8 %, n.s.) | 0.0368 (−7 %, n.s.) |
| E + toc | 10/10 | 3.20 (**+45 %**) | 55,861 (**+23 %**) | 1,375 (**−64 %**) | 9.7 (+11 %, n.s.) | 0.0326 (−17 %, n.s.) |

(vs A — no B in this subset; 5 questions only, so intervals are wide.) Same picture as Haiku:
`toc` cuts the note text by two thirds and adds a round trip; the defaults change nothing visible.

## Control — the previous proxy (before the `structuredContent` fix)

Same server, Haiku, 5 questions (q01, q09, q10, q16, q19) × B, C, E, proxy of commit `115e7d7`:

| Variant | Correct | Note text received (≈ tokens) | vs B |
|---|---|---|---|
| B | 5/5 | 3,746 | |
| C | 5/5 | 3,741 | −0 % [−2, +2] |
| E | 5/5 | 4,562 | +22 % [−1, +155] (noise: one run read more) |

The proxy's own log confirms it: 0 table-of-contents cut before the fix, 38 after (E, 42 runs).
The probe behind the diagnosis: a stdio MCP tool returning `content: "ALPHA"` and
`structuredContent: { result: "BRAVO" }` — Claude Code 2.1.283 hands the model
`{"result":"BRAVO"}`.

## Memory engine speed (new `durationMs`, measured by the proxy)

| Type | Calls | p50 | p95 | max |
|---|---|---|---|---|
| search | 374 | 109 ms | 191 ms | 553 ms |
| read | 319 | 197 ms | 293 ms | 993 ms |

(Haiku, all proxy variants; basic-memory on a small NAS.) The memory server accounts for about
**0.5 s of a 9 s answer**: the model's turns, not the engine, set the pace. That is why one extra
round trip (`toc`) costs ≈ 1 s while saving 4,000 tokens of reading does not show in time.

## Observations

1. **The fix matters more than any lever.** With Claude Code and basic-memory ≥ 0.23 (any FastMCP
   server using `wrap_result`), the v0.4 levers were invisible to the model. Any client that reads
   `structuredContent` was affected the same way.
2. **`toc` is a real but double-edged saving.** Note text received −64 %, answers still all
   correct (the model read the outline, then asked for the right section — or for the whole note),
   cost −13 % with Haiku. But +1 tool call, +12 % input tokens and +12 % time per answer: each turn
   re-sends Claude Code's ≈ 35–40k-token context (cached), which outweighs the ≈ 4,000 tokens saved.
   Worth it when cost matters more than latency, and when notes are much larger than 5,000 tokens.
   It stays **off by default**.
3. **Default levers: neutral.** No significant change in calls, tokens, time or cost against the
   control; a slight tendency to fewer calls (−7 %, interval [−14 %, +1 %]) that this benchmark
   cannot confirm. They add a few hundred tokens of text per answer.
4. **`dedupe` cannot be judged with one question per session** — it fired 10 times in 42 runs.
   Its schema addition (`memglow_fresh`, also added by `toc`) costs ≈ 1,000–1,600 input tokens per
   run on simple questions (q01: 40.1k tokens for A/C, 40.9–41.7k for D/E) — small, but not free.
5. **What costs most here is not the notes.** Haiku called basic-memory's `search` tool (the
   ChatGPT-connector tool, which answers "Unsupported MCP client" to Claude Code) in **197 of 210
   runs**, and `fetch` in 90 — wasted round trips the levers do not address. Sonnet used only
   `search_notes` and `read_note` (2.2 calls on average). Full-text search with several words
   often found only the index note, which the model then read in full (≈ 4,300 tokens, under the
   5,000-token threshold, so `toc` does not cut it).

## Limits

- **Single-fact questions, one per session.** Accuracy is at the ceiling (100 % everywhere), so a
  small loss of quality would not be detected; long sessions (where `dedupe` acts and where an
  outline may be lost to compaction) are not covered.
- **Two repetitions per cell** (Haiku), **one subset** for Sonnet: differences under ≈ 10–15 % are
  within noise (see the A/B noise floor). The bootstrap resamples questions, not runs.
- **Generated notes**: realistic in size and structure, repetitive in wording (template
  sentences); full-text search only (semantic search off); one memory server (basic-memory 0.23.2)
  and one client (Claude Code 2.1.283) — another client may read `content` instead of
  `structuredContent`.
- **Cost** is Claude Code's list-price estimate (`total_cost_usd`); the runs used a subscription
  account, so nothing was billed per token. Time includes API latency of the evening it ran.
- The run hit the account's **session usage limit** after 156 Haiku runs; the 54 interrupted runs
  (answer "You've hit your session limit", no model call) were discarded and re-run after the reset
  with the same plan (`--resume`).

## Cost of this benchmark

5.36 $ at list price for 265 runs in total (pilot 6, Haiku 210, control 15, Sonnet 30, one
debugging pair 4 — plus the 54 empty runs, at 0 $), under a global cap of 6 $.

## How to reproduce

Never against a real memory: the generator refuses a non-empty folder, and the runner should only
point at a disposable server.

```bash
# 1. Test notes (fictional, deterministic)
node bench/generate.js /tmp/mg-bench/notes
node bench/run.js --check --memory-dir /tmp/mg-bench/notes

# 2. A disposable basic-memory on that copy (Streamable HTTP, no semantic search)
docker run -d --name mg-bench-bm -p 127.0.0.1:8123:8000 --user "$(id -u):$(id -g)" \
  -v /tmp/mg-bench/notes:/app/data/basic-memory -v /tmp/mg-bench/bmconfig:/home/appuser/.basic-memory \
  -e HOME=/home/appuser -e BASIC_MEMORY_HOME=/app/data/basic-memory -e BASIC_MEMORY_DEFAULT_PROJECT=main \
  -e BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED=false \
  ghcr.io/basicmachines-co/basic-memory:latest \
  basic-memory mcp --transport streamable-http --host 0.0.0.0 --port 8000 --path /mcp
# wait until every note has a `permalink:` line (initial indexing)

# 3. Runs (claude CLI logged in), then tables
node bench/run.js --upstream http://127.0.0.1:8123/mcp --memory-dir /tmp/mg-bench/notes \
  --out bench/results/haiku.jsonl --variants A,B,C,D,E --reps 2 --model haiku --budget-total 5
node bench/analyze.js bench/results/haiku.jsonl

# 4. Clean up
docker rm -f mg-bench-bm && rm -rf /tmp/mg-bench
```

Options: `--questions q01,q09`, `--seed`, `--budget-run` (per run, default 0.30 $), `--resume`
(re-run only what is missing), `--proxy-root <other checkout>` (compare another proxy version),
`--keep-streams <dir>` (raw transcripts). Raw results of this report: `bench/results/*.jsonl`.
