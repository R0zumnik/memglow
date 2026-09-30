# memglow adapter — GitHub Copilot (CLI and coding agent)

Lights memglow up when GitHub Copilot (CLI and coding agent) reads, searches or writes one of your notes.

**Mechanism** (official): JSON files in `~/.copilot/hooks/` (user, Copilot CLI) or `.github/hooks/*.json` (repository), `{version: 1, hooks: {postToolUse: [{type: "command", bash, powershell, timeoutSec}]}}`. stdin: `{toolName, toolArgs, toolResult, cwd, timestamp}`.

Source: [Hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration)

## Install

`memglow init` does it for you (with a backup of the file it changes, and `memglow uninstall` to undo).
By hand: add the content of [`memglow.example.json`](memglow.example.json) to a new file, `~/.copilot/hooks/memglow.json`, with the real path of `hook.js`.

## What is reported

`view` → read; `edit`, `create` → write (`.md` inside your notes folder); memory MCP tools → read / search / write.

Only note names leave your machine's hook — never paths outside your notes folder, never content.
The script answers GitHub Copilot (CLI and coding agent) immediately, sends the event from a detached process that gives up
after 3 s, prints nothing else and always exits 0: memglow being down never slows the agent.

## Notes

For the coding agent on github.com, put the file in `.github/hooks/` of the repository instead; it then runs in GitHub's sandbox, which usually cannot reach a memglow running on your machine.

## Settings

Read from the environment, else from `~/.memglow/memglow.config.json` written by `memglow init`:
`MEMGLOW_URL`, `MEMGLOW_TOKEN` (or `MEMGLOW_TOKEN_FILE`, default `~/.memglow/token`),
`MEMGLOW_MEMORY_DIR`, `MEMGLOW_MCP_SERVERS`. See [the activity API](../../docs/api.md).
