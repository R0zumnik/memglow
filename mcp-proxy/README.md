# memglow MCP proxy

Put it in front of **any** memory MCP server (basic-memory, the filesystem server, an Obsidian
server…) and every MCP client that talks to that server lights memglow up — Claude Desktop,
Continue, Roo Code, or any other client, including the ones without a hook system.

It relays every byte unchanged in both directions and only *watches* the traffic: when a
`tools/call` succeeds, it reports `read`, `search` or `write` with **note names only** (from the
call's arguments and from note references in the result — never the content) to
[`POST /api/activity`](../docs/api.md). Failed calls (`error` or `isError`) are not reported.

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

## Settings

Same as the adapters: `MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default
`~/.memglow/token`), else `~/.memglow/memglow.config.json`. Without a token the proxy still relays
everything; it just reports nothing.

## Avoid counting twice

If a client already has a memglow hook (Claude Code, Cursor, Codex, Gemini CLI, Windsurf, Copilot,
Cline), do not also route its memory server through the proxy: each call would light up twice.
`memglow init` only offers to wrap the servers of clients without hooks (Claude Desktop).
