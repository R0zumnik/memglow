# memglow adapter — Claude Code

Lights memglow up when Claude Code reads, searches or writes one of your notes.

**Mechanism** (official): a `PostToolUse` command hook in `~/.claude/settings.json` (or a project's `.claude/settings.json`). Claude Code sends `{tool_name, tool_input, tool_response}` on stdin; MCP tools are named `mcp__<server>__<tool>`.

Source: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`config.example.json`](config.example.json) to `~/.claude/settings.json`, merged into `hooks.PostToolUse`, with the real path of `hook.js`.

## What is reported

`Read` → read; `Write`, `Edit`, `MultiEdit` → write (only `.md` files inside your notes folder); any memory MCP tool → read / search / write from its name.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers Claude Code immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

The v0.1 hook (`hooks/memglow-activity.js`) still works unchanged; this adapter is the same idea on the shared core, so it also understands any memory MCP server (not only basic-memory).

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
