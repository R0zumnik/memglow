# memglow MCP proxy

Put it in front of **any** memory MCP server (basic-memory, the filesystem server, an Obsidian
server…) and every MCP client that talks to that server lights memglow up — Claude Desktop,
Continue, Roo Code, or any other client, including the ones without a hook system.

It *watches* the traffic: when a `tools/call` succeeds, it reports `read`, `search` or `write`
with **note names only** (from the call's arguments and from note references in the result —
never the content) to [`POST /api/activity`](../docs/api.md). Failed calls (`error` or `isError`)
are not reported. Each report carries the memory server's **response time** for that call
(`durationMs`, from the request forwarded to the response back), which memglow shows as
*Memory engine speed* (p50/p95 per tool type, slow-search alert); a search that found nothing is
reported too, without ids, so *Time to find a note* can count it as missed. It can also make the assistant faster and cheaper with a few
[levers](#token-saving-and-speed-levers-v04) that annotate the memory server's answers — never
the notes themselves.

## stdio (most MCP servers)

Prefix the server's command with the proxy and `--`:

```json
{
  "mcpServers": {
    "basic-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/memglow/mcp-proxy/memglow-mcp-proxy.js", "--name", "basic-memory", "--",
               "uvx", "basic-memory", "mcp"]
    }
  }
}
```

Installed from npm (coming soon) the command becomes `memglow-mcp-proxy`. `memglow init --wrap-mcp`
does this for Claude Desktop's memory servers, and `memglow uninstall` puts the original command
back.

The server's exit code is passed through, `SIGINT` / `SIGTERM` / `SIGHUP` are forwarded, and the
server's stderr is left untouched.

## Streamable HTTP

```bash
memglow-mcp-proxy --upstream http://127.0.0.1:8000/mcp --listen 127.0.0.1:8765 --name notes
```

Then point the client at `http://127.0.0.1:8765/mcp`. Method, path query, headers (including
`Mcp-Session-Id`) and status are forwarded; JSON and server-sent-event responses are streamed
back as they arrive. If the upstream is unreachable the client receives a `502` with a JSON-RPC
error.

## Options

| Option | Meaning |
|---|---|
| `--name <name>` | server name shown for the events (default: guessed from the command or URL) |
| `--source <label>` | label in memglow's live journal (default `mcp`) |
| `--upstream <url>` | HTTP mode: the real server's MCP endpoint |
| `--listen <host:port>` | HTTP mode: where the proxy listens (default `127.0.0.1:8765`) |
| `-- <command…>` | stdio mode: the real server's command line |

## Tool → activity mapping

By default, from the tool's name:

| Tool name contains | Reported as |
|---|---|
| write, edit, create, update, move, rename, delete, remove, append, prepend, replace, patch, insert, save | `write` |
| search, find, query, grep, glob, recent | `search` |
| read, view, fetch, open, show, context, load, or starts with `get_` | `read` |
| anything else (e.g. `list_directory`) | nothing |

Override it with `MEMGLOW_PROXY_MAP`, a JSON object:

```bash
MEMGLOW_PROXY_MAP='{"lookup":"read","sync_everything":"ignore"}'
```

Values: `read`, `search`, `write`, `ignore`.

## Token-saving and speed levers (v0.4)

The proxy sees every answer of the memory server before the assistant does, so it can add what
the server does not know: how big a note is, which notes go with it, what each search hit is
about. Rules, for every lever:

- **Nothing is ever written in your notes.** The levers only change the *answer* sent back to the
  assistant. The notes folder is only read (titles, frontmatter `description`, themes, links,
  sizes), through the same code as the viewer, and cached: it is rescanned at most once per
  `pollMs` (2 s), plus once after each successful write.
- **The server's answer is kept as is.** Levers 1-3 only *add* a text block before or after the
  server's own `content` items, which stay byte-for-byte identical. Only levers 4, 5 and 8, all off
  by default, replace an answer — and only a plain-text read answer (never one carrying other
  `structuredContent`, never `build_context`, which returns several notes).
- **FastMCP text wrapper.** basic-memory (like any FastMCP server with `wrap_result`) sends each
  answer twice: in `content` and as `structuredContent: { "result": "<the same text>" }`. Claude
  Code (checked with v2.1) gives the *model* the `structuredContent` when there is one — so the
  proxy keeps that wrapper equal to the annotated text (`content` blocks joined by a blank line).
  Before this, every lever was invisible to Claude Code behind basic-memory. Only that exact shape
  is touched (a single `result` key holding the same text as `content`); any other
  `structuredContent` is relayed as is.
- **No note body is ever added.** Titles, ids, themes, token estimates (≈ bytes / 4, as in the
  Memory cost panel) and frontmatter descriptions only, with secret-looking text masked.
- Unknown tools, errors (`error` or `isError`) and every other message pass through untouched. If a
  lever fails, the original answer is relayed.

| # | Lever | Default | What the assistant gets |
|---|---|---|---|
| 1 | `sizeWarning` | **on** | Before the content of a note over `largeNoteTokens` (default 5,000): `⚠ memglow: this note is ≈N tokens (threshold T). Consider offering the user to split it into smaller notes within the same theme "<theme>"; memglow's split_plan tool can propose sections.` Also after a `write_note` / `edit_note` that leaves the note over the threshold (`…this note is now ≈N tokens…`). Once per note and per session. |
| 2 | `searchDetails` | off (was on through 0.4.2.1b) | After search results: one line per note found — title, id, theme/sub-theme, ≈tokens, description — so the right note is picked without opening several. The description is shown once per note **per session**; a note found again by a later search in the same session gets the compact line (no description), and a note already read **in full** this session gets no line at all. |
| 3 | `suggestions` | off (was on through 0.4.2.1b) | After a note is read: `memglow: related notes: A (≈t), B (≈t), C (≈t)` — linked notes, same sub-theme and, when activity counters exist, notes usually read the same days. 3 by default (`suggestionsMax`, up to 5); notes already read in the session are skipped, and shown **once per note per session** (re-reading the same note later in the session does not repeat it). |
| 4 | `dedupe` | off | A note re-read in the same session with **exactly the same answer** gets a short "unchanged since you read it earlier in this session (≈N tokens saved)" instead of its content (only when that is shorter). |
| 5 | `toc` | off | A note over the threshold first comes back as its description plus its sections with ≈tokens each; the assistant then asks for one section (`"memglow_section": "Decisions"` or `"3"`), cut verbatim from the server's answer. |
| 6 | `archiveHint` | off | A search that finds nothing in the live memory (an empty answer such as `No results` or `"results": []`, or hits only in the [archive folder](../README.md#archive)) → after the server's answer: `memglow: nothing found in the live memory — the archive summary lists: "Router setup" (from \`home-net\`, archived 2026-06-01 in \`habits-archive\`, ≈420 tokens)`. Titles of the archived sections matching the query (up to `archiveHintMax`, 5), read from the archive summary note — never their text. Nothing matches: a one-line pointer to the summary note. No archive summary: nothing added. |
| 7 | `hideUnsupportedTools` | off | Removes, from `tools/list`, the tools a per-server table marks unsupported for the client that just said hello — never from a `tools/call`, which always reaches the real server untouched. |
| 8 | `alreadyLoaded` | off | A single-note read (never `build_context` or another `multiNoteTools` entry) of a note memglow knows is loaded into the context at the start of **every** session — the index note(s), or an `alwaysLoaded` entry (see `README.md`'s "Always loaded" cost, `lib/always-loaded.js`) that resolves to a note — gets `memglow: "<label>" (≈N tokens) is already in your context — it is loaded at the start of every session and has not changed since this session began (sha <8 hex chars>). Use it from there. To get the full text anyway, call again with "memglow_fresh": true.` instead of its content, for as long as the note's file (read directly off disk) matches the hash captured at the start of the session. A note that changed meanwhile is never stubbed: its full, current text comes back with one extra line saying so. |
| 9 | `multiQuery` | **on** | A search tool call carrying `memglow_queries` (2-4 extra phrasings, up to `MULTI_QUERY_MAX` total, added to the search tools' schemas in `tools/list`) is sent upstream as ONE call per phrasing — sequentially, the original query first — instead of the assistant spending a separate turn on each one. Hits are merged, deduped by note id (found by more phrasings ranks higher), capped to the biggest single phrasing's own hit count, and returned as ONE result: in the upstream's own format when safe (plain-text hits reassembled from the server's own blocks), else a compact listing of whatever note ids resolve; a later phrasing's failed call fails the whole thing open to the FIRST phrasing's own result — what a plain single search would have returned. `memglow_queries` is always stripped before a call reaches the server, even with this lever off. |
| 10 | `aliases` + `learnAliases` | **on** | **`learnAliases`** (0.4.2.3, "query log"): when a search is followed, in the SAME session within 2 minutes and before another search, by a single-note read of a note NOT in that search's own results, the query's significant words (lowercased, EN+FR stop-words dropped, ≥ 3 letters, secret-masked) are learned as aliases of that note, with a count — in one small local file, `learned-aliases.json` (mode 600, bounded to `aliasesMax` = 2,000 entries, oldest dropped). Nothing is ever sent anywhere. **`aliases`** (0.4.2.4, "learned aliases"): on a LATER search, a note whose learned aliases match ≥ 2 of the query's words (or 1 alias seen ≥ 2 times), and that is not already among this search's own results, is added at the TOP of the answer — the upstream's own per-hit row shape when the answer is plain text, else one compact line `memglow: likely relevant — <label> (<id>), learned from your past searches`. Never removes a result, never duplicates a note already present; an alias whose note no longer exists is forgotten. The two switches are independent (recording vs. using what was recorded). Since 0.4.2.5, a search carrying lever 9's own `memglow_queries` no longer bypasses this lever: it learns from every phrasing's words and can inject into the merged result too. **On by default since 0.4.2.5** — see that stage's section below for why a lever that costs slightly MORE raw tokens now ships on. |
| 11 | `negativeCache` | off | A search in a session not followed by a read (of anything) within 2 minutes, or superseded first by another search or a write in the same session, is remembered, locally, as "futile" for the live memory's current FINGERPRINT (note count + latest mtime — `lib/negative-cache.js`). A LATER search with the same significant words, while the fingerprint is unchanged, gets one line PREPENDED: `memglow: this search found nothing you used last time (<date>); the memory has not changed since.` The results that follow are always relayed right after, unchanged — this never hides anything. Any write anywhere changes the fingerprint, invalidating every remembered entry at once. A single switch gates both recording and using it. Off by default — see 0.4.2.6 below: a clear win on its own dedicated fixture (one dropped retry call), but `bench/replay-heavy.jsonl` triggers the hint for real on a naturally recurring search with no call saved there to offset it, since that fixture was never built to model the dropped turn. |
| 12 | `indexHint` | off | A search whose own results are ONLY the index note, or a read of the index itself while `alreadyLoaded` (lever 8) is off, gets a suffix: `memglow: the index already says:` followed by up to 3 lines of the index's OWN text (secret-masked, each capped to 160 characters) that mention one of the query's significant words — grepped, not summarised. The read case reuses lever 10's own "search right before a read" correlation to know what to grep for; no recent search at all → nothing added. Never replaces the note's own content. Off by default: a pure, unconditional add wherever it fires — same bucket as `searchDetails`/`suggestions`/`archiveHint`. |
| — | `indexWarning` | off | Before the content of the **index** note when it is over `indexWarningTokens` (top-level key, default 2,000): `⚠ memglow: the index note "…" is ≈N tokens (index threshold T) and it is loaded at every session. Consider offering the user to trim it…`. Once per session. Replaces lever 1 for the index note when on. |

### Stage 0.4.2.2 — "lean defaults"

Through 0.4.2.1b, `searchDetails` and `suggestions` were on by default, same as `sizeWarning`.
Measured with the free replay harness (`bench/replay.js`, see [bench/README.md](../bench/README.md))
and against a real 2-day usage log (91 calls), `defaults` delivered MORE tokens than `off` —
−19.7% on the shipped demo, +14% on the real log (116,052 → 132,257 tokens). Both levers only
ever ADD explanatory text (never cut anything), and the harness cannot credit the extra reads or
searches that text might avoid, so any amount of it reads as a pure loss; the real log's own
+14% is the same effect at a larger, noisier scale. Neither lever is "short" the way `sizeWarning`
is (a search's `searchDetails` suffix can be close to the size of the search results themselves),
and neither has a measured upside, so this stage turns both OFF by default. They are shortened
either way, for whoever opts back in (`MEMGLOW_PROXY_SEARCH_DETAILS=1` /
`MEMGLOW_PROXY_SUGGESTIONS=1`, or the `proxy` config keys):

- `searchDetails`: a note already read **in full** this session gets no teaser line at all (its
  real content, not a guess at it, is already in context); a note merely *described* once this
  session (an earlier search mentioned it) gets the compact line (no description) on a later
  search that turns it up again.
- `suggestions`: shown once per note **per session** — re-reading the same note later in the same
  session does not repeat its related-notes suffix.

`sizeWarning` stays on by default: one short line, once per large note per session, that
plausibly prevents a wasted call (the model blindly reading, or growing, an oversized note) —
exactly the "keep" case the other two did not meet. `node bench/replay.js --each` prints what
each lever adds or saves alone, against `off`, independent of every other lever; that is the
table this decision was made from, and the one to re-run before changing any lever's default
again.

### Lever 7 — `hideUnsupportedTools`: one client, one tool list

Some memory servers expose tools that only work for one particular MCP client. basic-memory
≥ 0.15 is one: its `search` and `fetch` tools (`src/basic_memory/mcp/tools/chatgpt_tools.py`) exist
only to match the exact schema OpenAI's MCP connector for ChatGPT expects, and basic-memory's own
`client_info_is_openai_mcp()` (`client_info.py`) rejects every other caller with
`{"error": "Unsupported MCP client", …}` — yet the tool is listed to everyone, so an assistant that
does not know better keeps calling it for nothing. In memglow's own benchmark (Claude Code + Haiku,
[bench/RESULTS.md](../bench/RESULTS.md)), `search` was called in **197 of 210 runs**, always
failing the same way.

`hideUnsupportedTools` reproduces that exact rule instead of guessing one: for each session (one
stdio process, or one HTTP `Mcp-Session-Id`), the proxy reads the `clientInfo` sent in `initialize`
and, in the next `tools/list`, drops a tool when the client's **name or title** — trimmed,
lower-cased — is not `openai-mcp` and does not start with `openai-mcp/` (the label OpenAI's MCP
client actually sends; "ChatGPT" is the product name, not the wire value). A client that never
sends a name or title is **never filtered** — unknown means cautious, not guilty. Calling a hidden
tool anyway still reaches the real server: this lever only edits `tools/list`, it never fabricates
an error or blocks a call. Several clients at once (e.g. Claude Code and ChatGPT talking to the
same basic-memory over HTTP) each see their own list — no cross-session effect.

Default table (`proxy.unsupportedTools` in the config, replaced whole, not merged, by any
override):

```json
{ "basic-memory": { "search": ["openai-mcp"], "fetch": ["openai-mcp"] } }
```

The outer key is matched against the proxy's `--name` (case-insensitive, substring either way), so
`--name basic-memory-mcp` still matches `"basic-memory"`. Add another server's tools, or loosen an
allow list, by giving your own table — it replaces this one entirely, so repeat basic-memory's
entry if you still want it.

**Measured** ([bench/RESULTS.md](../bench/RESULTS.md) → "hideUnsupportedTools", Haiku, 31 runs):
hiding `search` roughly halved how often Haiku attempted it (0.50 → 0.27 calls/run — not to zero:
the model sometimes tries the name anyway from prior training-time familiarity with basic-memory's
own tool pair), with accuracy unchanged. Every other measure (calls, tokens, time, cost) stayed
inside this benchmark's noise floor except a small, real drop in output tokens. **Default: off**
— the lever is zero-risk (pure removal from `tools/list`; a call that slips through is still
relayed untouched), but the measured gain was not large or certain enough on this sample to flip
memglow's own bar for an on-by-default lever. Turning it on is reasonable for a basic-memory setup
behind a non-OpenAI client: `MEMGLOW_PROXY_HIDE_UNSUPPORTED=1`.

> **Levers 4, 5 and 8 change what the assistant receives. Measure answer quality before enabling
> them**, not only the tokens saved: an assistant whose context was compacted may no longer have
> the earlier copy of a note, and an outline — or "it's already in your context" — is not the note.

**Measured** (Claude Code + basic-memory, 225 test notes, 21 questions, Haiku and Sonnet —
[bench/RESULTS.md](../bench/RESULTS.md)): the default levers 1-3 made no measurable difference;
`toc` cut the note text the assistant received by about two thirds with every answer still
correct, but added a round trip (≈ +12 % input tokens and time, ≈ −13 % cost with Haiku);
`dedupe` could not be judged with one question per session. `alreadyLoaded` (stage 0.4.2.1) has
not been benchmarked yet — see variant `I` in `bench/run.js`, not run by default.

**Getting the full note back (levers 4, 5 and 8).** When any of them is on, the proxy adds an
optional `memglow_fresh` argument (and `memglow_section` for lever 5) to the read tools it lists in
`tools/list`; the proxy strips them before the call reaches the server. For levers 4 and 5, clients
that cannot send extra arguments have another way out: **the read that follows a short answer
always returns the full content** — repeating the same call is enough. Lever 8 does not work that
way: unlike a dedupe stub (shown once, for the second-and-later read of the same note), its stub
would come back on every matching read for as long as the note stays unchanged, exactly because
the note is *still* already loaded — so only `"memglow_fresh": true` brings the full text back.

Why lever 5 works this way: basic-memory's `read_note` has no section parameter (`page` /
`page_size` only page fallback-search results and never cut the note), so the proxy fetches the
whole note from the server and returns the outline or the requested section itself.

**Savings** from levers 4, 5 and 8 are written as one line on the proxy's stderr (your MCP client's
log: `memglow-mcp-proxy: dedupe saved ≈5291 tokens on garden-project (session total ≈5291)`) and
added per day to `proxy-savings.json` in memglow's data folder (`~/.memglow` by default, never the
notes folder). The read itself is still reported to the viewer, which lights the note up as usual.

### Lever 8 — `alreadyLoaded`: skip what the assistant's context already has

Prompted by real basic-memory usage logs where the always-loaded index note (already injected at
session start by a host's own mechanism — a `SessionStart` hook, a `CLAUDE.md` import) was ALSO
read explicitly several times through the MCP server: a pure duplicate, every time.

"Known always loaded" is the index note(s) (`memory.indexNote` / `indexNote`, default
`["MEMORY", "index"]`) plus any `alwaysLoaded` entry (the main config's own list, used for the
Memory cost panel's "Always loaded" figure, `lib/always-loaded.js`) that **resolves to an existing
note** — an instruction file outside the notes folder (`CLAUDE.md`, `AGENTS.md`…) simply never
matches and is harmlessly skipped: this lever can only ever replace an answer the memory server
itself would have returned.

**Default: off.** memglow has no way to know whether your setup truly re-injects the index at the
start of every session — turning this on when it does not would hide a note the assistant has
in fact never seen. `memglow init` does not install any such injection itself (checked: it only
offers to add memglow's own *memory rules* to `CLAUDE.md`/`AGENTS.md`, instructions to use the MCP
tools — never the index's actual content); if your own setup does inject it (your own
`SessionStart` hook, or a `CLAUDE.md` `@import` of the index file), turn this on with
`MEMGLOW_PROXY_ALREADY_LOADED=1` or `"proxy": { "alreadyLoaded": true }`.

**"Has not changed since this session began"** is checked against a sha1 of the note's file, read
directly off disk (never through the memory server) and captured once per proxy session — at
`initialize` (every reconnect gets a fresh one), or lazily at the first read if a read arrives
first. A note that changed since is **never stubbed**: its full, current text comes back, with one
extra line saying it changed — the assistant's in-context copy of it really is stale, so handing it
the short stub back would be actively wrong, not just unhelpful. A file that cannot be read at the
moment of the check (removed, permissions) is treated the same as "not already loaded": full
content, no note.

### Lever 9 — `multiQuery`: several phrasings, one call

memglow's own [memory rules](../README.md#memory-rules) tell the assistant to search in 2-3
phrasings before reading or writing — good advice, but without this lever each phrasing is a
separate `tools/call`, i.e. a separate model turn: a real usage log showed 20 of 40 searches were
immediately followed by ANOTHER search, with no read in between, each one costing latency and
re-sent context for nothing the model couldn't have asked for in one go.

`multiQuery` adds an argument to every search tool's schema in `tools/list`:

```json
"memglow_queries": { "type": "array", "items": { "type": "string", "maxLength": 200 }, "maxItems": 4 }
```

When a call carries it (alongside the tool's own query argument, which always stays the FIRST
phrasing), the proxy makes one upstream call per phrasing — **sequentially**, never in parallel
or as a JSON-RPC batch — and merges the hits into ONE answer:

1. **Dedup and rank** by note id: a note found by several phrasings ranks ahead of one found by
   only one, ties broken by the best (lowest) rank it had in any single phrasing, then by which
   phrasing found it first.
2. **Cap** to the biggest single phrasing's own hit count ("the upstream's usual result count") —
   several phrasings never balloon the answer past what one search normally returns.
3. **Format**: when every phrasing's answer is plain text (no `structuredContent` other than the
   FastMCP text wrap), the merged answer is reassembled from the SERVER'S OWN hit blocks (split on
   blank lines, the same convention basic-memory and this proxy's own test fixtures use) — "the
   upstream's own format", just reordered and deduped, never a line memglow invented. Otherwise
   (a non-text part, or real structured hit data the proxy does not understand) it falls back to a
   compact listing of whatever note ids it can resolve, same style as lever 2 (`searchDetails`).
4. **Fail open**: a phrasing's call that errors or rejects stops the run right there. If it was the
   FIRST phrasing, its own error is relayed — exactly what a plain single search would have
   returned. If it was a LATER one, the FIRST phrasing's own successful result is relayed
   unchanged, never a partial merge. If nothing resolves to a note id anywhere (and the text isn't
   safe to reassemble as is), the first phrasing's result is relayed unchanged too.

`memglow_queries` is **always** stripped before a call reaches the server, even with this lever
off — a client that sends it anyway (having seen it advertised once, then the lever got turned
off) never leaks it upstream as an unrecognised argument.

**On by default** — stage 0.4.2.2b, measured with the free replay harness
([bench/replay.js](../bench/README.md)): `bench/replay-demo.jsonl` has no back-to-back searches
to collapse (no change either way); `bench/replay-heavy.jsonl` (after adding a few bursts of 2-3
consecutive searches) drops from 67 to 60 calls AND from 17,581 to 16,864 tokens with the lever
on (alone, vs off: -717 tokens AND 7 fewer calls — one per burst), 0 violations on both files.
Unlike levers 2/3/6 (which only ever ADD explanatory text) this lever can genuinely remove both
calls and tokens, which is why it ships on, alongside `sizeWarning`.

Reused by [`lib/memory-rules.js`](../lib/memory-rules.js)'s first rule: "if that tool's
`memglow_queries` argument is offered, pass all the phrasings in that ONE call; otherwise call it
2-3 times as before" — so an assistant that already follows memglow's search-in-phrasings habit
switches to one call for free, the day its memory server is wrapped by a proxy with this lever on.

### Stage 0.4.2.5 — "count the turns": effective tokens, and `aliases`/`learnAliases` turned on

Through 0.4.2.4, [`bench/replay.js`](../bench/README.md) scored a lever purely on tool-RESULT
tokens, so a lever that trades a call for a few extra tokens always looked like a loss — exactly
what happened to `aliases`/`learnAliases`: 2 fewer calls, but +25 raw tokens on
`bench/replay-aliases.jsonl`, so it shipped off. In reality every extra tool call is a whole extra
**model turn**, which re-sends the system prompt, every MCP tool's schema, and the conversation so
far — not just that one tool's result.

`bench/replay.js` now also reports **effective tokens** = raw tokens + calls × a per-call
`turnTokens` overhead (`--turn-tokens`, default 5,000 — a deliberate UNDER-estimate of the
~6,500-13,000-per-call overhead measured across `bench/results/*.jsonl`'s real `claude -p` runs;
see that file's `DEFAULT_TURN_TOKENS` comment for the derivation). A lever now earns ON by default
only when, vs `off`: 0 violations, AND its effective tokens are `<=` off's, AND (its raw tokens
are `<=` off's OR it makes fewer calls than off).

Re-run against that rule on all three levers-relevant fixtures (`bench/replay-demo.jsonl`,
`bench/replay-heavy.jsonl`, `bench/replay-aliases.jsonl`): `aliases`+`learnAliases` is a no-op
(identical calls and tokens to `off`) on the first two, and on `replay-aliases.jsonl` its 2 fewer
calls make its effective tokens 70,783 vs `off`'s 80,758 — a clear win even though raw tokens are
still +25. The rule holds on all three files, so this lever now **ships on by default**. The
`dedupe` lever (still off by default) was also re-checked against the same rule for completeness —
it passes on all three files too (it only ever saves raw tokens, never costs any) — but its
default is left unchanged pending the owner's own call: it replaces a note's content with a short
stub mid-session, which carries a context-compaction risk the effective-tokens number does not
capture.

This stage also fixed a real gap, not just a scoring one: a search carrying lever 9's own
`memglow_queries` bypassed `aliases`/`learnAliases` entirely (`multiQuery.run` answers the whole
burst outside the normal `clientMessage`/`serverMessage` cycle that lever 10 hooks into) — so it
could neither learn from a multi-phrasing search nor inject into one. Fixed in
`applyAliasesToSearch()` (`lib/proxy-levers.js`): `s.lastSearch` now records the UNION of every
phrasing's significant words (not just the main query's), and the same injection rule applies to
the merged result.

### Stage 0.4.2.6 — "negative cache + the index already answers"

Two more owner-log-motivated levers, both OFF by default. The owner's own log: 12 of 40 searches
led to NO READ AT ALL — not a wrong pick, nothing opened afterwards — and the index note was read
in full 6 times (≈16k tokens), each time without knowing in advance whether it actually answered
the question at hand.

**`negativeCache`** (lever 11, [`lib/negative-cache.js`](../lib/negative-cache.js)): a search not
followed by a read (of anything) within 2 minutes in the same session, or superseded first by
another search or a write, is remembered as "futile" against the live memory's current
FINGERPRINT (note count + latest mtime, cheap, no new read of any note). A later search sharing
the same significant words, while the fingerprint is unchanged, gets one line PREPENDED —
`memglow: this search found nothing you used last time (<date>); the memory has not changed
since.` — and the results that follow are always relayed right after, unchanged: this never hides
anything, only adds a line. Any write anywhere bumps the fingerprint, invalidating every
remembered entry at once.

Re-run against the same merge rule as lever 10 (`--each`, 0 violations AND effective tokens `<=`
off's AND (raw tokens `<=` off's OR calls `<` off's)) on `bench/replay-demo.jsonl`,
`bench/replay-heavy.jsonl`, `bench/replay-aliases.jsonl` and a new, dedicated
[`bench/replay-negative-cache.jsonl`](../bench/replay-negative-cache.jsonl): a no-op on the first
two general fixtures and on `replay-aliases.jsonl`; on its own dedicated fixture, a dropped retry
call (modelled with the existing `dropIfHinted` mechanism — see `bench/README.md`) makes its
effective tokens 31,013 vs `off`'s 35,990, a clear win, at +23 raw tokens. But on
`bench/replay-heavy.jsonl` a naturally recurring search ("storefront", searched again later in the
same session with nothing having changed) genuinely matches an earlier futile verdict and gets the
hint FOR REAL — +52 raw AND effective tokens there, with no call saved to offset it, because that
fixture was never built with a `dropIfHinted` retry modelling the model actually skipping the
repeat. The rule needs every tested file to pass, and this one real, unmodelled cost is enough to
keep it off by default — exactly the "measure honestly: it only saves if the model then stops
searching" caution this lever was built with.

**`indexHint`** (lever 12): a search whose own results are ONLY the index note, or a read of the
index itself while lever 8 (`alreadyLoaded`) is off, gets a suffix — `memglow: the index already
says:` followed by up to 3 lines of the index's OWN text (secret-masked, each capped to 160
characters) that mention one of the query's significant words, grepped straight off the already
cached note body, never summarised. The read case reuses lever 10's own "search right before a
read" correlation (`s.lastSearch`) to know what to grep for; with no recent search at all, nothing
is added — never a bare "says:" line with nothing after it. Measured the same way: a pure,
unconditional ADD everywhere it fires (demo +96, heavy +391, its own fixture +78 tokens; a no-op
only on `replay-aliases.jsonl`, which never reads the index) — same bucket as
`searchDetails`/`suggestions`/`archiveHint`, so it ships off too.

Both remain fully available: `MEMGLOW_PROXY_NEGATIVE_CACHE=1` / `"proxy": { "negativeCache": true
}`, `MEMGLOW_PROXY_INDEX_HINT=1` / `"proxy": { "indexHint": true }`.

### Examples

(Levers 2 and 3 are off by default since stage 0.4.2.2 — these examples assume they were turned
on, as shown.)

A search (lever 2), the server's own text first, unchanged:

```text
permalink: projects/garden-project
permalink: projects/seed-suppliers
memglow: notes in these results (title `id` · theme · size · description):
- Garden project `garden-project` · Projects/garden · ≈5291 tokens (large) · Raised beds, watering plan and seed list
- Seed suppliers `seed-suppliers` · Projects/garden · ≈30 tokens · Where to buy seeds
```

Reading that note (levers 1 and 3; the note's text in the middle is the server's, unchanged):

```text
⚠ memglow: this note is ≈5291 tokens (threshold 5000). Consider offering the user to split it into smaller notes within the same theme "Projects"; memglow's `split_plan` tool can propose sections.
---
title: Garden project
…the note, as the server sent it…
memglow: related notes: Seed suppliers `seed-suppliers` (≈30 tokens), Tool shed `tool-shed` (≈24 tokens)
```

The same read with lever 5 on:

```text
memglow: "Garden project" is ≈5291 tokens (threshold 5000), so only its outline is shown.
Description: Raised beds, watering plan and seed list
Sections:
1. (intro) (≈32 tokens)
2. ## Beds (≈2253 tokens)
3. ## Watering (≈2004 tokens)
4. ## Seeds (≈1003 tokens)
To read one section, call read_note again with the same arguments plus "memglow_section": "<heading or number>". For the whole note, add "memglow_fresh": true, or simply repeat the same call.
```

### Configuration

In memglow's config file — `~/.memglow/memglow.config.json` (written by `memglow init`, which also
sets `memoryDir`), or the file named by `MEMGLOW_CONFIG`:

```json
{
  "memoryDir": "/path/to/notes",
  "largeNoteTokens": 5000,
  "alwaysLoaded": ["~/.claude/CLAUDE.md"],
  "proxy": {
    "sizeWarning": true,
    "searchDetails": false,
    "suggestions": false,
    "suggestionsMax": 3,
    "dedupe": false,
    "toc": false,
    "archiveHint": false,
    "archiveHintMax": 5,
    "hideUnsupportedTools": false,
    "unsupportedTools": { "basic-memory": { "search": ["openai-mcp"], "fetch": ["openai-mcp"] } },
    "alreadyLoaded": false,
    "multiQuery": true,
    "aliases": true,
    "learnAliases": true,
    "aliasesMax": 2000,
    "negativeCache": false,
    "negativeCacheMax": 1000,
    "indexHint": false,
    "readTools": ["read_note", "view_note", "read_content", "fetch", "build_context"],
    "multiNoteTools": ["build_context"],
    "searchTools": ["search_notes", "search"],
    "writeTools": ["write_note", "edit_note"],
    "searchDetailsMax": 10,
    "savingsFile": true,
    "log": true
  }
}
```

`alwaysLoaded` is the top-level key (not under `proxy`): the same list the Memory cost panel's
"Always loaded" figure already reads (`lib/always-loaded.js`). Lever 8 reuses it as is; an entry
that is not a note (most instruction files) is simply never matched.

Environment variables win over the file:

| Variable | Meaning |
|---|---|
| `MEMGLOW_PROXY_SIZE_WARNING`, `MEMGLOW_PROXY_INDEX_WARNING`, `MEMGLOW_PROXY_SEARCH_DETAILS`, `MEMGLOW_PROXY_SUGGESTIONS`, `MEMGLOW_PROXY_DEDUPE`, `MEMGLOW_PROXY_TOC`, `MEMGLOW_PROXY_ARCHIVE_HINT`, `MEMGLOW_PROXY_HIDE_UNSUPPORTED`, `MEMGLOW_PROXY_ALREADY_LOADED`, `MEMGLOW_PROXY_MULTI_QUERY`, `MEMGLOW_PROXY_ALIASES`, `MEMGLOW_PROXY_LEARN_ALIASES`, `MEMGLOW_PROXY_NEGATIVE_CACHE`, `MEMGLOW_PROXY_INDEX_HINT` | `1`/`0` (also `true`/`false`, `on`/`off`) for each lever |
| `MEMGLOW_PROXY_READ_TOOLS`, `MEMGLOW_PROXY_MULTI_NOTE_TOOLS`, `MEMGLOW_PROXY_SEARCH_TOOLS`, `MEMGLOW_PROXY_WRITE_TOOLS` | comma-separated tool names (defaults above: basic-memory's) |
| `MEMGLOW_LARGE_NOTE_TOKENS` | the threshold (default 5000) |
| `MEMGLOW_MEMORY_DIR` (or `MEMORY_DIR`) | the notes folder, if not in the config file |
| `MEMGLOW_DATA_DIR` | where `proxy-savings.json` and `learned-aliases.json` go (default `~/.memglow`) |
| `MEMGLOW_PROXY_SAVINGS_FILE`, `MEMGLOW_PROXY_LOG` | `0` to stop writing the savings file / the stderr line |

Without a notes folder, levers 2 and 3 stay silent and lever 1 estimates the size from the answer
itself (without a theme). With every lever off the proxy is a pure byte relay, exactly as in 0.3.
Sessions: one per proxy process in stdio mode (reset by `initialize`), one per `Mcp-Session-Id` in
HTTP mode, where JSON answers the levers touch get a correct `Content-Length`
and server-sent events are rewritten event by event.

## Settings

Same as the adapters: `MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default
`~/.memglow/token`), else `~/.memglow/memglow.config.json`. Without a token the proxy still relays
everything; it just reports nothing.

## Avoid counting twice

If a client already has a memglow hook (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, Copilot,
Cline), do not also route its memory server through the proxy: each call would light up twice.
`memglow init` only offers to wrap the servers of clients without hooks (Claude Desktop).
