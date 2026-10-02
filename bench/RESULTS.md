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

## hideUnsupportedTools (mini-bench, 2026-10-02)

**Question.** basic-memory's own ChatGPT-compatibility tools, `search` and `fetch`
(`src/basic_memory/mcp/tools/chatgpt_tools.py`), are always listed in `tools/list` but reject any
caller that is not OpenAI's MCP client (`client_info_is_openai_mcp()`, `client_info.py`) — which is
exactly what observation 5 above measured: Haiku called `search` in 197 of 210 Claude Code runs,
always getting `"Unsupported MCP client"` back. Lever 7, `hideUnsupportedTools`, removes such a
tool from `tools/list` for a client its config table says is not allowed to use it (default table:
basic-memory's `search`/`fetch`, gated to `openai-mcp` — the exact rule read from basic-memory
0.23's own source, not a guess). Does hiding it actually help, and does it cost anything?

**What's different from the rest of this report — read before trusting the numbers.** This
environment has no `docker`, `uvx` or `python3` available, so the real
`ghcr.io/basicmachines-co/basic-memory` container could not be started. In its place, a small
Node-only stand-in server (`fake-basic-memory.js`, not committed — built for this run only)
re-implements, from basic-memory 0.23.2's actual source read on GitHub (quoted above): `read_note`
/ `search_notes` (plain substring search, not basic-memory's real ranking) over a copy of the same
225 generated notes `bench/generate.js` produces, and `search` / `fetch` with the **exact** gating
rule and **exact** error payload (`{"results":[],"error":"Unsupported MCP client",...}`) copied
from `chatgpt_tools.py`. It is not basic-memory, and this section's absolute numbers (tokens, time)
are **not comparable** to the Haiku table above (different search quality, no real SQLite FTS);
only the **B vs H comparison within this run** — same stand-in, same notes, same questions, only
the lever flipped — is meaningful. The real, disposable-container protocol described in "How to
reproduce" below still applies for anyone re-running this with docker available; this substitution
is a limitation of the sandbox this run happened in, not a change to that protocol. The real
production `basic-memory-server` container was never touched (confirmed `healthy` before and
after); the real memory was never touched either (the stand-in only ever read a throw-away copy of
the generated test notes, same as the rest of this report).

**Protocol.** 10 of the 21 questions (`q01, q02, q05, q08, q09, q13, q16, q17, q19, q21` — a mix of
small/large/link/none), × **B** (proxy, every lever off) and **H** (proxy, only
`hideUnsupportedTools` on — isolating lever 7 against the same control the rest of this report
uses) × 2 repetitions = 40 planned runs, Haiku only, `claude` CLI 2.1.283, same flags and clean
environment as the rest of this report. Budget: **31 of 40 runs completed before the 0.60 $ cap
for this run was reached** (total cost of this mini-bench: **0.615 $**; combined with ~0.04 $ of
setup/smoke checks, **≈ 0.65 $ of the 1.00 $ budget given for this work** — no run ever failed
before reaching the model, so the account's usage limit was never at risk here).

| Variant | Correct | Tool calls | Input tokens (all) | Output tokens | Tool results ≈ tokens | Time (s) | Cost ($) | `search` tool calls |
|---|---|---|---|---|---|---|---|---|
| B (control) | 16/16 | 3.38 | 25,494 | 478.9 | 3,291 | 6.8 | 0.0205 | 8 (0.50/run) |
| H (+ hideUnsupportedTools) | 15/15 | 3.20 (−7 % [−14, +5]) | 24,177 (−3 % [−8, +5]) | 468.1 (**−7 % [−10, −2]**) | 2,575 (−0 % [−2, +5]) | 7.2 (+5 % [−1, +12]) | 0.0192 (−2 % [−3, +1]) | 4 (0.27/run) |

(Differences: ratio of per-question means against B, 95 % bootstrap interval over the 10 questions;
**bold** = interval excludes 0 — `node bench/analyze.js`, same method as the rest of this report.)

**Observations.**

1. **The wasted call is reduced, not eliminated.** Hiding `search` from `tools/list` cut how often
   Haiku attempted it by roughly half (0.50 → 0.27 calls per run) — but in 4 of the 15 `H` runs it
   still emitted a `tools/call` for `search` even though the tool was never in its list. The most
   likely explanation: Haiku has prior, training-time familiarity with basic-memory's own
   `search`/`fetch` pair (the same pair this very report documents) and occasionally tries the name
   anyway, the way a person might try a command they remember from a similar tool even after being
   told it's gone. Each attempt still got basic-memory's real `"Unsupported MCP client"` answer (the
   lever never fabricates a different one) and the model recovered via `search_notes` every time —
   accuracy stayed 100 % on both sides.
2. **Everything else is inside this report's established noise floor (≈ 10–15 %).** Tool calls
   −7 %, input tokens −3 %, time +5 %, cost −2 % — all intervals include 0. Only output tokens
   (−7 %, interval excludes 0) reaches significance, and it is a small effect on a small part of the
   bill. On the large-note subset (where a wasted round trip costs the most context), `H` still
   looks directionally better — fewer calls (3.33 vs 3.80), less tool-result text (≈3,759 vs
   ≈4,861 tokens), lower input tokens (≈25,836 vs ≈29,604) — but with 9–10 runs per side this is
   suggestive, not a confirmed effect.
3. **No downside measured, and the lever cannot make an answer worse by construction**: it only
   ever removes an item from `tools/list`; a client that calls the tool anyway is relayed untouched
   (verified directly, not just inferred from this bench — see the lever's own unit/integration
   tests), so the worst case is "no effect", not "broken".

**Decision: default stays OFF** (`MEMGLOW_PROXY_HIDE_UNSUPPORTED` / `proxy.hideUnsupportedTools`
unset → `false`). The stated bar was "ON only if the gain is net and correctness intact" — accuracy
is intact, but across 31 runs only one of six measures reaches statistical significance here, and
even that one is a modest −7 % on output tokens; the rest sit inside the noise this report already
flags as unreliable at this sample size. That is not "no reason to use it" — the lever is zero-risk
and the mechanism it targets is real and documented (conclusion 5, and basic-memory's own source),
so turning it on for a setup that specifically uses basic-memory behind Claude Code (or any
non-OpenAI client) is a reasonable, low-risk choice. It is just not large or certain enough, on
this sample, to flip memglow's own default the way the stated rule requires.

## Split gain (`bench/split-gain.js`, 2026-10-02)

**Question.** The "Memory cost" panel suggests splitting a note over 5,000 tokens into parts of
≈2,000 tokens each. Memory cost itself never claims a saving ("estimate", "memglow promises no
saving" — `lib/cost.js`). Does splitting actually reduce what a real assistant reads, calls and
pays for to answer a question that lives in one of those notes — and does it cost anything in
calls, latency or correctness?

**What's different from the rest of this report — read before trusting the numbers.** This run
had no `docker`, `uvx` or `python3` available (checked: `which docker uvx python3` empty), so the
real `ghcr.io/basicmachines-co/basic-memory` container used above could not be started. In its
place, a small Node-only stand-in server is built directly into `bench/split-gain.js`
(`startFakeMemory`, not a separate file, not committed as its own artifact): `read_note` /
`search_notes` (plain case-insensitive **substring** search — a query must appear as one
contiguous run of characters in the note, unlike basic-memory's real word-based SQLite FTS) plus
the same always-listed, always-erroring ChatGPT-only `search`/`fetch` pair as
`test/fixtures/fake-memory-mcp.js` (ported from basic-memory 0.23's `chatgpt_tools.py`), and the
same `structuredContent` wrapping real basic-memory uses — the exact mechanism the proxy fix at
the top of this report depends on. This is a **limitation of this run's sandbox**, not a change to
the protocol, exactly like the hideUnsupportedTools mini-bench above. Consequence seen in the data:
the weak substring search caused a handful of search misses on both sides (4 wrong answers out of
71, see below) that real basic-memory's FTS would likely have avoided, and neither side's Haiku
ever called the ChatGPT-only `search`/`fetch` tools (0 of 71 runs) — unlike the 197/210 in the main
Haiku table above, so the "wasted call" tax described in observation 5 is absent here. **Only the
BEFORE vs AFTER comparison within this run is meaningful**; absolute tool-call and token counts are
not comparable to the tables above. The real `basic-memory-server` container and the real memory
were never touched (confirmed `healthy` before and after; the stand-in only ever read a throw-away
copy of `bench/generate.js`'s fictional notes).

**Protocol.** Same 225 fictional notes as the rest of this report (`bench/generate.js`, seed 42,
≈103,000 tokens, 9 notes over 5,000 tokens), in two disposable copies:

- **BEFORE** — untouched.
- **AFTER** — the 9 large notes split by code, deterministically (no AI, no cost, reproducible
  byte-for-byte): `lib/cost.js`'s own `sectionSpans` cut into sections, packed in order into parts
  of at most 2,000 tokens (the same greedy rule as `lib/cost.js packSections`, the rule
  `lib/assistant/proposal.js` suggests to the AI for the real, AI-proposed split). Each part becomes
  its own note next to the original, with its `theme`/`subtheme` frontmatter copied verbatim; the
  original note's id and filename are **kept**, only its body is replaced by a short summary
  linking to every part — exactly what `lib/assistant/proposal.js` does for the real feature, so
  every existing `[[link]]` to the note keeps resolving with no rewrite needed (the real feature's
  optional `linkUpdates`, redirecting a link to a specific part, is itself optional — `[]` is a
  valid answer there too — and out of scope for a deterministic, AI-free split). Checked, the same
  way the real validator does, that every non-blank line of the original body reappears in a part
  before writing anything: all 9 notes split cleanly, 0 lines lost. Resulting parts: 935–2,014
  tokens; summaries: 125–279 tokens (97% smaller than the original on average — before/after detail
  in the table below).
- **Questions**: the 21 of `bench/questions.json` + 6 new ones in `bench/split-gain-questions.json`,
  aimed at sections of the large notes those 21 don't already cover (two more vendor-catalogue
  accounts, a second rack in the network inventory, a second API's rate limit, a distractor meeting
  outcome, a specific incident-log entry) — every fact checked against the actually generated files
  (seed 42 is reproducible: verified byte-identical across two runs), not guessed.
- **Client**: the real `claude -p` CLI, Haiku only, restricted, same flags as `bench/run.js`
  (clean environment, empty working folder, `--strict-mcp-config`, one `memory` server, write tools
  disallowed, `--no-session-persistence`). **Proxy levers fixed at the C defaults** (sizeWarning +
  searchDetails + suggestions on, dedupe/toc off) **on both conditions** — only the memory changes.
- Plan: 27 questions × {before, after} × 2 repetitions = 108 calls, shuffled with a fixed seed, one
  at a time, budget checked before each call.
- **Budget: a hard $1.50 cap** (shared with this run's own setup/smoke checks, ≈$0.044). **71 of 108
  planned runs completed before the cap** (budget is checked before a run starts, so the run in
  flight when the cap was crossed still finished: **$1.524 actually spent, 1.6% over the $1.50
  target** — the same post-hoc-check overshoot the hideUnsupportedTools mini-bench above describes).
  No run ever failed before reaching the model (no account usage-limit hit, so nothing was
  discarded). Coverage is uneven across the shuffle: every question got at least one run on at
  least one side, but several got **0 runs on one side** (q09, q11, q14, q17: 0 "after"; q05, q07,
  q12: 0 "before") — those rows are simply absent from the per-kind tables below rather than
  guessed.

**Results.** Differences: ratio of per-question means, AFTER vs BEFORE, with a 95% bootstrap
interval over questions (paired where both sides have the question); **bold** = interval excludes
0. Read anything below the ≈10–15% noise floor this report's own A/B relay check establishes as
unreliable at this sample size — the small/none row below, where BEFORE and AFTER are *byte-identical*
notes, is this run's own illustration of that floor.

| | n (before/after) | Correct | Tool calls | Input tokens | Output tokens | Note text received (≈tokens) | Time (s) | Cost ($) |
|---|---|---|---|---|---|---|---|---|
| **All questions** | 36/35 | 33/36, 34/35 | 3.9 → 4.5 (+10% [−2,+22]) | 28,639 → 30,420 (+2% [−7,+11]) | 539 → 587 (+6% [−1,+14]) | 3,365 → 1,647 (**−51% [−60,−29]**) | 8.4 → 8.9 (+2% [−7,+12]) | 0.0219 → 0.0198 (**−10% [−16,−1]**) |
| Large-note questions | 18/16 | 16/18, 15/16 | 3.7 → 4.9 (**+23% [+10,+35]**) | 28,578 → 33,509 (+8% [−6,+23]) | 521 → 631 (**+13% [+3,+22]**) | 5,095 → 2,557 (**−50% [−63,−25]**) | 8.2 → 9.5 (+6% [−7,+21]) | 0.0246 → 0.0221 (−12% [−22,+3]) |
| New questions (s01–s06) | 9/9 | 8/9, 8/9 | 3.9 → 5.0 (**+24% [+9,+39]**) | 29,750 → 33,785 (+8% [−10,+27]) | 535 → 638 (+13% [−1,+24]) | 4,984 → 2,593 (−47% [−63,+13]) | 8.4 → 9.7 (+11% [−5,+29]) | 0.0247 → 0.0224 (−9% [−24,+17]) |
| Link questions | 8/7 | 8/8, 7/7 | 4.1 → 4.4 (+13% [−6,+36]) | 29,110 → 30,510 (+6% [−5,+17]) | 559 → 587 (+10% [−7,+30]) | 2,515 → 1,624 (−54% [−61,+6]) | 8.6 → 8.9 (+8% [−11,+35]) | 0.0206 → 0.0197 (**−10% [−15,−2]**) |
| Small/none (sanity: notes untouched) | 10/12 | 9/10, 12/12 | 4.2 → 4.1 (−9% [−28,+10]) | 28,372 → 26,250 (**−11% [−19,−2]**) | 556 → 528 (−7% [−13,+1]) | 930 → 446 (−44% [−70,+45]) | 8.6 → 8.1 (−8% [−18,+3]) | 0.0179 → 0.0168 (**−7% [−13,−0]**) |

Tool calls by tool, totalled: `search_notes` 96 before / 94 after, `read_note` 44 before / 63
after, `list_directory` 1/1, `search`/`fetch` 0/0. Reading one more note per answer after the split
(1.22 → 1.80 `read_note` calls per run) is exactly the mechanism: the summary points at the right
part, but reaching it costs a second read.

**Observations — honest, not oversold.**

1. **The core effect is real and large: about half the note text, for about the same cost.** Over
   all questions, the text an assistant actually receives from the memory tools drops **51%**
   (interval excludes 0), and cost drops **10%** (interval excludes 0) — Haiku's output stays short
   regardless of how much it read, so halving the input text it has to read shows up in cost even
   though input *tokens* barely move (+2%, not significant: the extra tool-call overhead and
   Claude Code's own context roughly cancel the saved note text in the token count, the same
   pattern the `toc` lever shows in the main report above — but here the saving is structural, not a
   per-call lever, and it is already in place before the question is asked).
2. **It costs one extra round trip, and that shows most where it matters most.** On the 18
   large-note questions specifically, tool calls rise **23%** and output tokens **13%** (both
   intervals exclude 0) — the model reads the summary, follows a link to the right part, and often
   restates more context in its answer. Net cost on that subset alone is directionally down (−12%)
   but the interval [−22%, +3%] does not exclude 0: unlike the "all questions" row, this is not a
   confirmed saving by itself, only consistent with one.
3. **No loss of correctness detected** — if anything the opposite, 34/35 (97%) after vs 33/36 (92%)
   before, but neither this direction nor its reverse would be meaningful at n≈35 per side. All 4
   wrong answers trace to the stand-in's weak substring search missing a multi-word query (verified
   by re-reading the note: the fact was present on both sides every time), not to anything the split
   removed or hid — one question (s06) failed on both BEFORE and AFTER for the same search-quality
   reason, which is itself evidence the two conditions were treated symmetrically by the harness.
4. **The "sanity" row is this bench's own noise floor, and it is not flat.** Small/none questions
   point at notes that are byte-identical between BEFORE and AFTER, yet input tokens read **−11%**
   and cost **−7%** (both intervals exclude 0) on the AFTER side. Nothing about those specific notes
   changed; what changed is the corpus around them (36 extra split-part files), which can shift
   which notes a substring search turns up first. Treat differences under this report's established
   ≈10–15% noise band with the same skepticism here, and note that this stand-in's simplistic search
   makes that band, if anything, wider than with real basic-memory's FTS.
5. **A split is not a one-time fix** (see the real `project-memglow` figures below): a part that
   keeps being written to can grow back past the point where Memory cost would suggest splitting it
   again.

**A real, complementary data point (read-only, no cost) — but only 1–2 days of hindsight.** On
Florent's actual memory, `project-memglow` was split on 2026-10-01 (per Florent: ≈15,500 tokens →
a ≈1,200-token summary + 4 parts of 2,400–4,900 tokens: `project-memglow-{roadmap,releases,history,launch}`).
Real counters (`data/memoire-compteurs.json` on the NAS) and file sizes:

| Day | Reads of the (now-)summary | Reads of `-roadmap` | Note on size |
|---|---|---|---|
| 2026-09-30 (day before) | 1 | — (didn't exist yet) | note was ≈15,500 tokens; 13 writes that same day |
| 2026-10-01 (split day) | 2 | 18 | 23+12+1+14 = 50 writes across the 4 parts that same day |
| 2026-10-02 (today, partial) | 0 so far | 0 so far | — |

Current sizes (2026-10-02): summary 5,346 B (≈1,337 tokens), `-history` 17,670 B (≈4,418),
`-launch` 21,575 B (≈5,394 — **back above the 5,000-token split threshold**), `-releases` 33,304 B
(≈8,326), `-roadmap` 34,677 B (≈8,669). **Honestly: this is not a clean before/after measurement.**
Unlike the synthetic bench above, production content kept changing heavily on the very day of the
split and the day after (50+ writes), so there is no way to separate "tokens saved by splitting"
from "tokens added by the work that followed" using these counters alone — the synthetic bench's
fixed-content design exists precisely to isolate that. What the real numbers do show cleanly: the
split note was read far more right after splitting (18 reads of one part in a single day) than the
unsplit note ever was (1 read the day before), consistent with Florent's own project work moving
into it; and two of the four parts have already grown large enough, on their own, to be flagged by
Memory cost again — splitting once does not mean a part stays small.

**Proposed README benefit phrase** (not overselling the parts of this result that aren't
significant): *"On notes over 5,000 tokens, splitting cut the note text our assistant actually read
by about half (−51%, 95% CI −60% to −29%) with no loss of correctness in our benchmark — at the
price of roughly one extra tool call per answer."* A shorter, more conservative variant for a
one-line claim: *"Splitting a 5,000+-token note roughly halves the memory text an assistant has to
read to answer a question from it, in our benchmark."*

**Limits** (in addition to the stand-in caveats above): 71 of 108 planned runs (uneven coverage per
question, see above); 1–2 repetitions, not the full 2 everywhere; no repeated-identical-condition
control run in this mini-bench to measure this exact harness's own noise floor (borrowed from the
main report's A/B check instead); the deterministic split used here has no AI judgment, so it never
produces `linkUpdates` and never rewords anything — a real, AI-proposed split might group sections
differently or write a more useful summary, for better or worse; single-fact questions again, so
a subtle loss of answer quality (as opposed to a wrong answer) would not be detected.

**Cost of this mini-bench.** $1.524 at list price for 71 runs (plus the free `--dry-run` checks and
one $0.032 two-run smoke test counted in that total), against a $1.50 target — 1.6% over, because
the budget is checked before a run starts, not after (same mechanism, same honest overshoot, as the
hideUnsupportedTools mini-bench above).

**How to reproduce.** `node bench/split-gain.js --out bench/results/split-gain.jsonl
[--budget-total 1.5] [--budget-run 0.05] [--reps 2] [--model haiku] [--seed 1]
[--questions all|q01,s01] [--dry-run]` — `--dry-run` only generates and splits the two disposable
copies and sanity-checks the questions against them (no `claude` call, no cost). Like the rest of
`bench/`, never point this at a real memory: the copies live in a fresh `os.tmpdir()` folder,
deleted at the end unless `--keep` is passed.

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
