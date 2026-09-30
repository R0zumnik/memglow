<p align="center">
  <img src="docs/assets/banner.svg" alt="memglow — See your AI's memory come alive" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memglow"><img alt="npm" src="https://img.shields.io/npm/v/memglow?style=flat-square&labelColor=04120F&color=2EE89B"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0F4F46?style=flat-square&labelColor=04120F"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-009597?style=flat-square&labelColor=04120F&logo=nodedotjs&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/no%20build%20step-zero%20deps-00696B?style=flat-square&labelColor=04120F">
  <a href="#works-with"><img alt="Works with Claude Code, Codex, Gemini CLI, Cursor, Copilot and more" src="https://img.shields.io/badge/works%20with-Claude%20·%20Codex%20·%20Gemini%20·%20Cursor%20·%20Copilot%20·%20more-2EE89B?style=flat-square&labelColor=04120F"></a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="memglow demo: a search lights up several notes and the camera follows, then a write flashes one note red-orange" width="100%">
</p>

<p align="center">
  <b>Watch your AI assistant think.</b> memglow turns the Markdown memory of your AI tools — a basic-memory<br>
  knowledge base, an Obsidian vault, any folder of notes — into a live 3D brain that lights up as notes are read, searched and written.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#works-with">Works with</a> ·
  <a href="#install">Install</a> ·
  <a href="#activity-api">API</a> ·
  <a href="#mcp-proxy">MCP proxy</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#pro-coming-soon">Pro</a>
</p>

---

<a id="features"></a>
## ✨ Features

| Feature | What it does |
|---|---|
| 🧠 **Live 3D brain** | Every note is a glowing neuron, every `[[wikilink]]` a connection. Recent notes shine brighter. |
| ⚡ **Assistant activity, live** | Hooks for Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Copilot and Cline — or an MCP proxy for any other client — report each read, search and write. The note flashes — 🔵 cyan for a read, 🔴 red-orange for a write, 🟣 violet for a search — and comets run along its links. |
| 🎥 **Camera that follows** | Glides to what the assistant touches, frames a search's results, drifts back to the overview after a few calm seconds. |
| 🗂️ **Themes & sub-themes** | Notes cluster by theme with relay bubbles for sub-themes — from frontmatter or folder names. |
| 🎛️ **Tune it live** | Glow, names, spread, gravity, spacing, links at rest, auto-rotate, find-a-note. Saved in your browser. |
| 🔒 **Private by design** | Localhost by default, read-only access to your notes, secret-looking lines masked. Hooks send note names only, never content. No CDN, no analytics. |
| 📦 **Zero dependencies** | One command, Node 18+. No build step, no database. Or one Docker container. |

<a id="screenshots"></a>
## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-overview.png" alt="Overview: coloured clusters of notes around a central index"><br><sub><b>Overview</b> — five themes, sub-theme bubbles, the index at the centre.</sub></td>
    <td width="50%"><img src="docs/assets/screenshot-write.png" alt="A note flashing red-orange with its name after a write"><br><sub><b>A write</b> — the note flashes red-orange and shows its name.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-search.png" alt="A search: several notes light up, comets run along their links"><br><sub><b>A search</b> — the camera frames the results, comets run along the links.</sub></td>
    <td width="50%"><img src="docs/assets/screenshot-settings.png" alt="The settings panel open next to the 3D brain"><br><sub><b>Settings</b> — display, motion and links, tuned live.</sub></td>
  </tr>
</table>

<sub>Captured from the fictional demo memory in <code>demo/memory</code>.</sub>

<a id="how-it-works"></a>
## 🧭 How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="An AI tool runs a hook, which posts note ids to POST /api/activity on memglow. memglow reads the Markdown notes folder read-only and streams everything to the live 3D brain in the browser." width="100%">
</p>

memglow does two things: it **polls a folder of Markdown notes** (read-only) and it **listens for
activity** — from a hook in your AI tool, from the MCP proxy, or from any script through the
[activity API](#activity-api). Both reach the browser over a server-sent events stream. That's it.

<a id="quick-start"></a>
## 🚀 Quick start

One command sets everything up — notes folder, token, and the hooks of the AI tools it finds:

```bash
npx memglow init   # interactive; add --yes to accept everything
npx memglow        # start the viewer, then open http://127.0.0.1:4747
```

Just want to look at the demo?

```bash
git clone https://github.com/R0zumnik/memglow && cd memglow
MEMORY_DIR=./demo/memory node server.js     # the fictional demo memory
open http://127.0.0.1:4747                  # or just open it in your browser
```

Want to see it move without an assistant? Start the server with a token, then run the simulator:

```bash
export MEMGLOW_TOKEN=$(openssl rand -hex 32)
MEMORY_DIR=./demo/memory node server.js &
node demo/simulate.js 60
```

<a id="works-with"></a>
## 🤝 Works with

| Tool | How memglow sees it | Reads | Searches | Writes |
|---|---|:---:|:---:|:---:|
| **Claude Code** | native hook · `PostToolUse` · [adapter](adapters/claude-code/) | ✅ | ✅ MCP | ✅ |
| **OpenAI Codex CLI** | native hook · `PostToolUse` · [adapter](adapters/codex/) | ✅ MCP | ✅ MCP | ✅ |
| **Gemini CLI** | native hook · `AfterTool` · [adapter](adapters/gemini/) | ✅ | ✅ MCP | ✅ |
| **Cursor** | native hooks · `beforeReadFile`, `afterFileEdit`, `afterMCPExecution` · [adapter](adapters/cursor/) | ✅ | ✅ MCP | ✅ |
| **Windsurf / Devin Desktop** | native Cascade hooks · `post_read_code`, `post_write_code`, `post_mcp_tool_use` · [adapter](adapters/windsurf/) | ✅ | ✅ MCP | ✅ |
| **GitHub Copilot CLI** | native hook · `postToolUse` · [adapter](adapters/copilot/) | ✅ | ✅ MCP | ✅ |
| **Cline** (3.36+, macOS / Linux) | native hook · `PostToolUse` script · [adapter](adapters/cline/) | ✅ | ✅ MCP | ✅ |
| **Claude Desktop, Continue, Roo Code**, any MCP client | [MCP proxy](#mcp-proxy) in front of the memory server | ✅ MCP | ✅ MCP | ✅ |
| **Aider**, editors, sync tools, anything that writes files | file detection (built in) | — | — | ✅ |
| **Your own agent or script** | [activity API](#activity-api) | ✅ | ✅ | ✅ |

**✅ MCP** = seen when the tool goes through a memory MCP server (basic-memory, an Obsidian or
filesystem server…). Plain file reads and edits of `.md` notes are seen directly where the tool's
hooks expose them. Each hook mechanism was checked against the vendor's documentation; the
link is in each adapter's README.

**Writes from anything are already covered.** memglow polls the notes folder: whenever a note's
body changes on disk — whoever changed it — the note blooms, the camera goes to it and the
journal says *Note changed*. Hooks and the proxy add what the disk cannot tell: **reads and
searches**, and *which* tool did it.

<a id="install"></a>
## 🛠️ Install: `memglow init`

```bash
npx memglow init         # asks before each change
npx memglow init --yes   # non-interactive
```

It:

1. **finds your notes** — the default basic-memory project, `~/basic-memory`, or your most recent
   Obsidian vault (`--dir <folder>` to choose);
2. writes `~/.memglow/memglow.config.json` and a **random token** in `~/.memglow/token` (mode 600);
3. **detects your AI tools** and proposes each hook (Claude Code, Codex, Gemini CLI, Cursor,
   Windsurf, Copilot CLI, Cline). Every file it changes is **backed up** first
   (`<file>.memglow-backup`), existing entries are kept, a file it cannot parse is left untouched;
4. proposes to put the [MCP proxy](#mcp-proxy) in front of Claude Desktop's memory servers.

| Option | Meaning |
|---|---|
| `--yes`, `-y` | accept every proposal (non-interactive) |
| `--dir <folder>` | notes folder |
| `--port <n>` | viewer port (default `4747`) |
| `--agents <list>` | `claude-code,codex,gemini,cursor,windsurf,copilot,cline`, `all` (default: every detected tool) or `none` |
| `--wrap-mcp` | with `--yes`: also wrap Claude Desktop's memory MCP servers |
| `--docker` | also write `~/.memglow/docker-compose.yml` and `.env` |

**Undo:** `memglow uninstall` removes exactly what `init` added — hooks, the Cline script, MCP
wrappings — and nothing else, even if you edited those files since. `--restore-backups` puts the
original files back instead; `--purge` also deletes `~/.memglow`.

Then start the viewer (`npx memglow`) and restart your AI tools.

<a id="claude-code-hook"></a>
<a id="live-activity-from-claude-code"></a>
## 🤖 Hooks by hand

Prefer to edit config files yourself? Each [adapter](adapters/) has a README with the official
mechanism, its source, and a ready-to-paste config snippet. For Claude Code, for example, add to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__.*|Read|Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node /path/to/memglow/adapters/claude-code/hook.js", "timeout": 5 }]
      }
    ]
  }
}
```

and store the server's token: `mkdir -p ~/.memglow && printf '%s' "$MEMGLOW_TOKEN" > ~/.memglow/token && chmod 600 ~/.memglow/token`.

Adapter settings (environment of the AI tool, else `~/.memglow/memglow.config.json`):

| Variable | Default | What it does |
|---|---|---|
| `MEMGLOW_URL` | `http://127.0.0.1:4747` | where memglow runs |
| `MEMGLOW_TOKEN` / `MEMGLOW_TOKEN_FILE` | `~/.memglow/token` | the server's activity token |
| `MEMGLOW_MEMORY_DIR` | from `memglow init` | plain file reads / edits count only for `.md` files in this folder |
| `MEMGLOW_MCP_SERVERS` | `basic-memory,memory,obsidian,notes,filesystem` | MCP servers that count as "memory" |

Every adapter answers its tool at once, sends the event from a detached process that gives up
after 3 s, prints nothing else and exits 0: memglow being down never slows your assistant.

The v0.1 Claude Code hook, `hooks/memglow-activity.js`, keeps working unchanged.

<a id="activity-api"></a>
## 📡 Activity API

Any program can light notes up:

```bash
curl -H "Authorization: Bearer $(cat ~/.memglow/token)" -H 'Content-Type: application/json' \
  -d '{"type":"read","ids":["alice"],"source":"my-agent"}' http://127.0.0.1:4747/api/activity
```

`type` is `read`, `search` or `write`; `ids` are note names or paths (only existing notes are
kept); `source` is the label in the journal. Full reference with Python and Node examples:
[docs/api.md](docs/api.md).

<a id="mcp-proxy"></a>
## 🔌 MCP proxy

For MCP clients without hooks (Claude Desktop, Continue, Roo Code…), put the proxy in front of
the memory server. It relays every byte unchanged and reports note names only:

```json
"basic-memory": {
  "command": "node",
  "args": ["/path/to/memglow/mcp-proxy/memglow-mcp-proxy.js", "--name", "basic-memory", "--", "uvx", "basic-memory", "mcp"]
}
```

Streamable HTTP servers too: `memglow-mcp-proxy --upstream http://127.0.0.1:8000/mcp --listen 127.0.0.1:8765`.
Tool-name mapping is configurable. Details: [mcp-proxy/README.md](mcp-proxy/README.md).

<a id="your-notes"></a>
## 📝 Your notes

Any folder of `*.md` files works. memglow reads, if present:

| Frontmatter | Meaning |
|---|---|
| `title` | display name (otherwise derived from the file name) |
| `description` | shown in the tooltip and the note panel |
| `theme` | big group (must be one of the configured themes) |
| `subtheme` (or `sous_theme`) | relay bubble inside the group |

Links are `[[wikilinks]]` to another note's file name (links quoted inside code are ignored).
A note named `MEMORY` or `index` sits at the centre. Without a `theme`, a note inherits one from
its folder (`themeByFolder`), else `defaultTheme`.

<a id="configuration"></a>
## ⚙️ Configuration

Environment variables, or `memglow.config.json` (see [`memglow.config.example.json`](memglow.config.example.json)).
With neither, `memglow` uses what `memglow init` wrote in `~/.memglow`.

| Setting | Default | What it does |
|---|---|---|
| `MEMORY_DIR` | `./memory` | folder of notes (read-only access is enough) |
| `PORT` / `HOST` | `4747` / `127.0.0.1` | use `HOST=0.0.0.0` to expose it (then set a password) |
| `MEMGLOW_TOKEN` | — | enables `POST /api/activity` for hooks (32+ chars) |
| `MEMGLOW_PASSWORD` | — | HTTP Basic auth on the viewer (user `memglow`, 12+ chars) |
| `MEMGLOW_SHOW_BODIES` | `true` | show note text in the side panel |
| `MEMGLOW_POLL_MS` | `2000` | how often the folder is checked |
| `themes`, `themeByFolder`, `defaultTheme`, `subthemeLabels`, `title` | — | config file only |

<a id="docker"></a>
## 🐳 Docker

```bash
docker run -d --name memglow -p 127.0.0.1:4747:4747 \
  -v /path/to/notes:/memory:ro \
  -e MEMGLOW_TOKEN=$(cat ~/.memglow/token) \
  ghcr.io/r0zumnik/memglow
```

Or with Compose: copy [`docker-compose.example.yml`](docker-compose.example.yml), set `NOTES`,
then `docker compose up -d` — `memglow init --docker` writes one for you in `~/.memglow/`.

Images for amd64 and arm64 (Apple silicon, Raspberry Pi) are published on every release; pin a version with `ghcr.io/r0zumnik/memglow:0.2.1`.

The hooks and the MCP proxy run next to your AI tools, not in the container: point them at the
container with `MEMGLOW_URL` (default `http://127.0.0.1:4747`) and the same token.

<a id="security"></a>
## 🔒 Security

- Notes are read **read-only**; memglow never writes to `MEMORY_DIR`.
- By default it listens on `127.0.0.1` only. If you expose it, set `MEMGLOW_PASSWORD` and put it
  behind HTTPS.
- `/api/activity` does not exist without `MEMGLOW_TOKEN`; with a wrong or missing token it answers
  the same `404` as any unknown route (it does not reveal itself). Tokens are compared in constant
  time, bodies are capped at 4 KB, 30 events/s at most, and note ids are checked against existing
  notes.
- Hooks and the MCP proxy send **note names only** — never note content, prompts or tool results.
  The token is read from a mode-600 file and passed to the sender through its environment, never
  on a command line.
- `memglow init` backs up every file before changing it, never rewrites a file it cannot parse,
  and `memglow uninstall` removes only its own entries.
- What is **never** exposed: note bodies in the graph or the live stream (only in the note panel,
  and only if `MEMGLOW_SHOW_BODIES` is on), files outside `MEMORY_DIR`, hidden folders. Lines that
  look like secrets (API keys, tokens, `password: …`) are masked before a body is sent.
- Strict Content-Security-Policy (`script-src 'self'`), `nosniff`, no framing, no referrer.
  No CDN, no analytics, no network calls from the page.

<a id="faq"></a>
## ❓ FAQ

<details>
<summary><b>Does it work with basic-memory?</b></summary>

Yes — `memglow init` finds your default basic-memory project, and the hooks and the MCP proxy
understand basic-memory's tools out of the box. memglow is not affiliated with basic-memory
and does not include or modify it.
</details>

<details>
<summary><b>With Obsidian?</b></summary>

Yes — any vault works; `memglow init` finds your most recent one. Use `theme` frontmatter or
`themeByFolder` for the groups.
</details>

<details>
<summary><b>My AI tool is not in the list.</b></summary>

If it writes notes, memglow already sees the writes. If it uses a memory MCP server, put the
[MCP proxy](#mcp-proxy) in front of it. Otherwise, a few lines against the
[activity API](#activity-api) are enough.
</details>

<details>
<summary><b>Does it need a GPU?</b></summary>

No. Any browser with WebGL works; a few hundred notes run smoothly on a laptop. The demo GIF and
the screenshots were rendered in software, in a headless browser without a GPU.
</details>

<details>
<summary><b>Why polling and not file watching?</b></summary>

Watching is unreliable on network shares and many NAS filesystems; polling a few hundred notes
every 2 s is cheap and always works.
</details>

<details>
<summary><b>Why does a note not flash when a sync tool rewrites it?</b></summary>

Only a change of the note's *body* counts as a write: frontmatter-only rewrites and file copies
are ignored.
</details>

<a id="pro-coming-soon"></a>
## 💎 Pro (coming soon)

A Pro edition is being considered for people who live in their assistant's memory every day:

- **Dashboard** — words, notes, links and activity over time, most-read notes, memory health.
- **History & diffs** — click a write in the journal to see exactly which lines changed.
- **Several memories and users** — per-person access, theme-level visibility.
- **Two-factor login.**

Interested? Say so in [GitHub Discussions → Pro interest](https://github.com/R0zumnik/memglow/discussions) — no payment, no e-mail, just tell us which feature you'd use. Details: [docs/pro.html](docs/pro.html).

The open-source edition stays free and MIT.

<a id="license"></a>
## 📄 License & thanks

MIT — see [`LICENSE`](LICENSE).

memglow stands on the shoulders of [three.js](https://threejs.org/) and
[3d-force-graph](https://github.com/vasturiano/3d-force-graph) by Vasco Asturiano (with
UnrealBloomPass for the glow). Their licenses (MIT and compatible) are listed in
[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES). Thanks to the hook systems of Claude Code, Codex,
Gemini CLI, Cursor, Windsurf, Copilot and Cline, and to basic-memory, for making an assistant's
memory something you can look at.

<p align="center"><sub>Not affiliated with Anthropic, OpenAI, Google, Anysphere, Cognition, GitHub, Cline, basic-memory or Obsidian.</sub></p>
