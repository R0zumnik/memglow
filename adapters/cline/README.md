# memglow adapter — Cline

Lights memglow up when Cline reads, searches or writes one of your notes.

**Mechanism** (official): an executable file named exactly after the hook type — `PostToolUse`, no extension — in `~/Documents/Cline/Rules/Hooks/` (global) or `.clinerules/hooks/` (workspace). Cline 3.36+, macOS and Linux. The script receives JSON on stdin and must print control JSON; the adapter prints `{"cancel":false}`.

Source: [Cline v3.36 — hooks](https://cline.bot/blog/cline-v3-36-hooks)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`PostToolUse.example`](PostToolUse.example) to `~/Documents/Cline/Rules/Hooks/PostToolUse` (a two-line shell script), with the real path of `hook.js`.

## What is reported

`read_file` → read; `write_to_file`, `replace_in_file` → write (`.md` inside your notes folder); `use_mcp_tool` / `access_mcp_resource` on a memory server → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers Cline immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

The exact field names of Cline's stdin payload are only partly documented: the parser accepts `postToolUse.tool` or `toolName`, and `parameters` or `params`. If an event is missed, the MCP proxy and the file watcher still catch it. Cline allows one `PostToolUse` file per folder: `memglow init` never replaces one that is not its own and tells you the line to add instead.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
