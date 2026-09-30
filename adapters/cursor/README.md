# memglow adapter — Cursor

Lights memglow up when Cursor reads, searches or writes one of your notes.

**Mechanism** (official): `~/.cursor/hooks.json` (or a project's `.cursor/hooks.json`), `{version: 1, hooks: {<event>: [{command}]}}`. memglow uses `beforeReadFile` (`{file_path, content}`), `afterFileEdit` (`{file_path, edits}`) and `afterMCPExecution` (`{tool_name, tool_input, mcp_server_name, result_json}`). The event name is passed to the script as its first argument.

Source: [Cursor hooks](https://cursor.com/docs/hooks)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`hooks.example.json`](hooks.example.json) to `~/.cursor/hooks.json`, with the real path of `hook.js`.

## What is reported

`beforeReadFile` → read, `afterFileEdit` → write (`.md` inside your notes folder); `afterMCPExecution` on a memory server → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers Cursor immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

`beforeReadFile` is a permission hook: the adapter always answers `{"permission":"allow"}` first, before doing anything else, so it can never block a read. It does not set `failClosed`.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
