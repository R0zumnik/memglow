# memglow adapter — OpenAI Codex CLI

Lights memglow up when OpenAI Codex CLI reads, searches or writes one of your notes.

**Mechanism** (official): a `PostToolUse` command hook in `~/.codex/hooks.json` (also possible: a `[hooks]` table in `~/.codex/config.toml`, or `<repo>/.codex/hooks.json`). Same stdin shape as Claude Code: `{tool_name, tool_input, tool_response, cwd, session_id, turn_id}`. File edits go through the `apply_patch` tool; MCP tools are `mcp__<server>__<tool>`. Hooks are on by default (`[features] hooks = false` turns them off).

Source: [Codex hooks](https://learn.chatgpt.com/docs/hooks)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`hooks.example.json`](hooks.example.json) to `~/.codex/hooks.json`, merged into `hooks.PostToolUse`, with the real path of `hook.js`.

## What is reported

`apply_patch` → write for every `*** Add/Update/Delete File:` and `*** Move to:` path that is a `.md` inside your notes folder; memory MCP tools → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers OpenAI Codex CLI immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

Codex has no separate "read file" tool (reads happen through the shell), so reads are only seen through MCP. Use the MCP proxy or the file watcher for the rest.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
