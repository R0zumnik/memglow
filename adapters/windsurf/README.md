# memglow adapter — Windsurf / Devin Desktop (Cascade)

Lights memglow up when Windsurf / Devin Desktop (Cascade) reads, searches or writes one of your notes.

**Mechanism** (official): `~/.codeium/windsurf/hooks.json` (user) or `.devin/hooks.json` in a workspace (legacy `.windsurf/hooks.json`), `{hooks: {<event>: [{command, show_output}]}}`. stdin: `{agent_action_name, tool_info}`. memglow uses the informational post hooks `post_read_code`, `post_write_code` and `post_mcp_tool_use`.

Source: [Cascade hooks](https://docs.devin.ai/desktop/cascade/hooks)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`hooks.example.json`](hooks.example.json) to `~/.codeium/windsurf/hooks.json`, with the real path of `hook.js`.

## What is reported

`post_read_code` → read, `post_write_code` → write (`.md` inside your notes folder); `post_mcp_tool_use` on a memory server → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers Windsurf / Devin Desktop (Cascade) immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
