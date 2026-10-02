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
  server's own `content` items, which stay byte-for-byte identical. Only levers 4 and 5, both off by
  default, replace an answer — and only a plain-text read answer (never one carrying other
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
| 2 | `searchDetails` | **on** | After search results: one line per note found — title, id, theme/sub-theme, ≈tokens, description — so the right note is picked without opening several. |
| 3 | `suggestions` | **on** | After a note is read: `memglow: related notes: A (≈t), B (≈t), C (≈t)` — linked notes, same sub-theme and, when activity counters exist, notes usually read the same days. 3 by default (`suggestionsMax`, up to 5); notes already read in the session are skipped. |
| 4 | `dedupe` | off | A note re-read in the same session with **exactly the same answer** gets a short "unchanged since you read it earlier in this session (≈N tokens saved)" instead of its content (only when that is shorter). |
| 5 | `toc` | off | A note over the threshold first comes back as its description plus its sections with ≈tokens each; the assistant then asks for one section (`"memglow_section": "Decisions"` or `"3"`), cut verbatim from the server's answer. |
| 6 | `archiveHint` | off | A search that finds nothing in the live memory (an empty answer such as `No results` or `"results": []`, or hits only in the [archive folder](../README.md#archive)) → after the server's answer: `memglow: nothing found in the live memory — the archive summary lists: "Router setup" (from \`home-net\`, archived 2026-06-01 in \`habits-archive\`, ≈420 tokens)`. Titles of the archived sections matching the query (up to `archiveHintMax`, 5), read from the archive summary note — never their text. Nothing matches: a one-line pointer to the summary note. No archive summary: nothing added. |
| 7 | `hideUnsupportedTools` | off | Removes, from `tools/list`, the tools a per-server table marks unsupported for the client that just said hello — never from a `tools/call`, which always reaches the real server untouched. |
| — | `indexWarning` | off | Before the content of the **index** note when it is over `indexWarningTokens` (top-level key, default 2,000): `⚠ memglow: the index note "…" is ≈N tokens (index threshold T) and it is loaded at every session. Consider offering the user to trim it…`. Once per session. Replaces lever 1 for the index note when on. |

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

> **Levers 4 and 5 change what the assistant receives. Measure answer quality before enabling
> them**, not only the tokens saved: an assistant whose context was compacted may no longer have
> the earlier copy of a note, and an outline is not the note.

**Measured** (Claude Code + basic-memory, 225 test notes, 21 questions, Haiku and Sonnet —
[bench/RESULTS.md](../bench/RESULTS.md)): the default levers 1-3 made no measurable difference;
`toc` cut the note text the assistant received by about two thirds with every answer still
correct, but added a round trip (≈ +12 % input tokens and time, ≈ −13 % cost with Haiku);
`dedupe` could not be judged with one question per session.

**Getting the full note back (levers 4 and 5).** When either is on, the proxy adds an optional
`memglow_fresh` argument (and `memglow_section` for lever 5) to the read tools it lists in
`tools/list`; the proxy strips them before the call reaches the server. And for clients that cannot
send extra arguments: **the read that follows a short answer always returns the full content** —
repeating the same call is enough.

Why lever 5 works this way: basic-memory's `read_note` has no section parameter (`page` /
`page_size` only page fallback-search results and never cut the note), so the proxy fetches the
whole note from the server and returns the outline or the requested section itself.

**Savings** from levers 4 and 5 are written as one line on the proxy's stderr (your MCP client's
log: `memglow-mcp-proxy: dedupe saved ≈5291 tokens on garden-project (session total ≈5291)`) and
added per day to `proxy-savings.json` in memglow's data folder (`~/.memglow` by default, never the
notes folder). The read itself is still reported to the viewer, which lights the note up as usual.

### Examples

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
  "proxy": {
    "sizeWarning": true,
    "searchDetails": true,
    "suggestions": true,
    "suggestionsMax": 3,
    "dedupe": false,
    "toc": false,
    "archiveHint": false,
    "archiveHintMax": 5,
    "hideUnsupportedTools": false,
    "unsupportedTools": { "basic-memory": { "search": ["openai-mcp"], "fetch": ["openai-mcp"] } },
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

Environment variables win over the file:

| Variable | Meaning |
|---|---|
| `MEMGLOW_PROXY_SIZE_WARNING`, `MEMGLOW_PROXY_INDEX_WARNING`, `MEMGLOW_PROXY_SEARCH_DETAILS`, `MEMGLOW_PROXY_SUGGESTIONS`, `MEMGLOW_PROXY_DEDUPE`, `MEMGLOW_PROXY_TOC`, `MEMGLOW_PROXY_ARCHIVE_HINT`, `MEMGLOW_PROXY_HIDE_UNSUPPORTED` | `1`/`0` (also `true`/`false`, `on`/`off`) for each lever |
| `MEMGLOW_PROXY_READ_TOOLS`, `MEMGLOW_PROXY_MULTI_NOTE_TOOLS`, `MEMGLOW_PROXY_SEARCH_TOOLS`, `MEMGLOW_PROXY_WRITE_TOOLS` | comma-separated tool names (defaults above: basic-memory's) |
| `MEMGLOW_LARGE_NOTE_TOKENS` | the threshold (default 5000) |
| `MEMGLOW_MEMORY_DIR` (or `MEMORY_DIR`) | the notes folder, if not in the config file |
| `MEMGLOW_DATA_DIR` | where `proxy-savings.json` goes (default `~/.memglow`) |
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
