# memglow adapter — Gemini CLI

Lights memglow up when Gemini CLI reads, searches or writes one of your notes.

**Mechanism** (official): an `AfterTool` command hook in `~/.gemini/settings.json` (or a project's `.gemini/settings.json`). stdin: `{tool_name, tool_input, tool_response, mcp_context, cwd}`. MCP tools are named `mcp_<server>_<tool>`. The hook's stdout must be JSON only, so the adapter prints `{}`.

Source: [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`settings.example.json`](settings.example.json) to `~/.gemini/settings.json`, merged into `hooks.AfterTool`, with the real path of `hook.js`.

## What is reported

`read_file`, `read_many_files` → read; `write_file`, `replace` → write (`.md` inside your notes folder); memory MCP tools → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers Gemini CLI immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

`timeout` is in milliseconds for Gemini CLI.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
