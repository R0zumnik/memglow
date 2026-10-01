# memglow MCP proxy

Put it in front of **any** memory MCP server (basic-memory, the filesystem server, an Obsidian
server…) and every MCP client that talks to that server lights memglow up — Claude Desktop,
Continue, Roo Code, or any other client, including the ones without a hook system.

It *watches* the traffic: when a `tools/call` succeeds, it reports `read`, `search` or `write`
with **note names only** (from the call's arguments and from note references in the result —
never the content) to [`POST /api/activity`](../docs/api.md). Failed calls (`error` or `isError`)
are not reported. It can also make the assistant faster and cheaper with a few
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
  default, replace an answer — and only a plain-text read answer (never one carrying
  `structuredContent`, never `build_context`, which returns several notes).
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
| — | `indexWarning` | off | Before the content of the **index** note when it is over `indexWarningTokens` (top-level key, default 2,000): `⚠ memglow: the index note "…" is ≈N tokens (index threshold T) and it is loaded at every session. Consider offering the user to trim it…`. Once per session. Replaces lever 1 for the index note when on. |

> **Levers 4 and 5 change what the assistant receives. Measure answer quality before enabling
> them**, not only the tokens saved: an assistant whose context was compacted may no longer have
> the earlier copy of a note, and an outline is not the note.

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
| `MEMGLOW_PROXY_SIZE_WARNING`, `MEMGLOW_PROXY_INDEX_WARNING`, `MEMGLOW_PROXY_SEARCH_DETAILS`, `MEMGLOW_PROXY_SUGGESTIONS`, `MEMGLOW_PROXY_DEDUPE`, `MEMGLOW_PROXY_TOC` | `1`/`0` (also `true`/`false`, `on`/`off`) for each lever |
| `MEMGLOW_PROXY_READ_TOOLS`, `MEMGLOW_PROXY_MULTI_NOTE_TOOLS`, `MEMGLOW_PROXY_SEARCH_TOOLS`, `MEMGLOW_PROXY_WRITE_TOOLS` | comma-separated tool names (defaults above: basic-memory's) |
| `MEMGLOW_LARGE_NOTE_TOKENS` | the threshold (default 5000) |
| `MEMGLOW_MEMORY_DIR` (or `MEMORY_DIR`) | the notes folder, if not in the config file |
| `MEMGLOW_DATA_DIR` | where `proxy-savings.json` goes (default `~/.memglow`) |
| `MEMGLOW_PROXY_SAVINGS_FILE`, `MEMGLOW_PROXY_LOG` | `0` to stop writing the savings file / the stderr line |

Without a notes folder, levers 2 and 3 stay silent and lever 1 estimates the size from the answer
itself (without a theme). With all five levers off the proxy is a pure byte relay, exactly as in
0.3. Sessions: one per proxy process in stdio mode (reset by `initialize`), one per
`Mcp-Session-Id` in HTTP mode, where JSON answers the levers touch get a correct `Content-Length`
and server-sent events are rewritten event by event.

## Settings

Same as the adapters: `MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default
`~/.memglow/token`), else `~/.memglow/memglow.config.json`. Without a token the proxy still relays
everything; it just reports nothing.

## Avoid counting twice

If a client already has a memglow hook (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, Copilot,
Cline), do not also route its memory server through the proxy: each call would light up twice.
`memglow init` only offers to wrap the servers of clients without hooks (Claude Desktop).
