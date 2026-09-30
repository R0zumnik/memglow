<p align="center">
  <img src="docs/assets/banner.svg" alt="memglow — See your AI's memory come alive" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0F4F46?style=flat-square&labelColor=04120F"></a>
  <img alt="Node 18+" src="https://img.shields.io/badge/node-18%2B-009597?style=flat-square&labelColor=04120F&logo=nodedotjs&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/no%20build%20step-zero%20deps-00696B?style=flat-square&labelColor=04120F">
  <img alt="Works with Claude Code" src="https://img.shields.io/badge/works%20with-Claude%20Code-2EE89B?style=flat-square&labelColor=04120F">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="memglow demo: a search lights up several notes and the camera follows, then a write flashes one note red-orange" width="100%">
</p>

<p align="center">
  <b>Watch your AI assistant think.</b> memglow turns the Markdown memory of Claude Code, a basic-memory<br>
  knowledge base or an Obsidian vault into a live 3D brain that lights up as notes are read, searched and written.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#live-activity-from-claude-code">Claude Code hook</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#pro-coming-soon">Pro</a>
</p>

---

## ✨ Features

| | |
|---|---|
| 🧠 **Live 3D brain** | Every note is a glowing neuron, every `[[wikilink]]` a connection. Recent notes shine brighter. |
| ⚡ **Assistant activity, live** | A tiny Claude Code hook reports each read, search and write. The note flashes — 🔵 cyan for a read, 🔴 red-orange for a write, 🟣 violet for a search — and comets run along its links. |
| 🎥 **Camera that follows** | Glides to what the assistant touches, frames a search's results, drifts back to the overview after a few calm seconds. |
| 🗂️ **Themes & sub-themes** | Notes cluster by theme with relay bubbles for sub-themes — from frontmatter or folder names. |
| 🎛️ **Tune it live** | Glow, names, spread, gravity, spacing, links at rest, auto-rotate, find-a-note. Saved in your browser. |
| 🔒 **Private by design** | Localhost by default, read-only access to your notes, secret-looking lines masked. No CDN, no analytics, no outbound calls. |
| 📦 **Zero dependencies** | One `node server.js`, Node 18+. No `npm install`, no build step, no database. Or one Docker container. |

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

## 🧭 How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Claude Code runs a PostToolUse hook, which posts note ids to POST /api/activity on memglow. memglow reads the Markdown notes folder read-only and streams everything to the live 3D brain in the browser." width="100%">
</p>

memglow does two things: it **polls a folder of Markdown notes** (read-only) and it **listens to a
hook** that tells it what your assistant just did. Both reach the browser over a server-sent events
stream. That's it.

## 🚀 Quick start

```bash
git clone https://github.com/R0zumnik/memglow && cd memglow
MEMORY_DIR=./demo/memory node server.js     # the fictional demo memory
open http://127.0.0.1:4747                  # or just open it in your browser
```

Point it at your own notes:

```bash
MEMORY_DIR=~/path/to/notes node server.js
```

Want to see it move without an assistant? Start the server with a token, then run the simulator:

```bash
export MEMGLOW_TOKEN=$(openssl rand -hex 32)
MEMORY_DIR=./demo/memory node server.js &
node demo/simulate.js 60
```

## 🤖 Live activity from Claude Code

memglow can show what the assistant is doing, not only what changed on disk. A small
**PostToolUse hook** reports every read, search and write of a memory note (note ids only, never
content).

1. Choose a token (32+ characters) and give it to the server: `MEMGLOW_TOKEN=...`
2. Store the same token for the hook: `mkdir -p ~/.memglow && printf '%s' "$MEMGLOW_TOKEN" > ~/.memglow/token && chmod 600 ~/.memglow/token`
3. Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__basic-memory__.*|Read|Write|Edit",
        "hooks": [{ "type": "command", "command": "node /path/to/memglow/hooks/memglow-activity.js", "timeout": 5 }]
      }
    ]
  }
}
```

Hook settings (environment of the Claude Code session):

| Variable | Default | |
|---|---|---|
| `MEMGLOW_URL` | `http://127.0.0.1:4747` | where memglow runs |
| `MEMGLOW_MEMORY_DIR` | — | so plain `Read` / `Write` / `Edit` of `.md` files in that folder count |
| `MEMGLOW_MCP_PREFIX` | `mcp__basic-memory__` | MCP tool prefix of your memory server |
| `MEMGLOW_SOURCE` | `claude` | label shown in the live journal |

The hook never blocks the session: it detaches, gives up after 3 s and prints nothing.

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

## ⚙️ Configuration

Environment variables, or `memglow.config.json` (see [`memglow.config.example.json`](memglow.config.example.json)):

| Setting | Default | |
|---|---|---|
| `MEMORY_DIR` | `./memory` | folder of notes (read-only access is enough) |
| `PORT` / `HOST` | `4747` / `127.0.0.1` | use `HOST=0.0.0.0` to expose it (then set a password) |
| `MEMGLOW_TOKEN` | — | enables `POST /api/activity` for hooks (32+ chars) |
| `MEMGLOW_PASSWORD` | — | HTTP Basic auth on the viewer (user `memglow`, 12+ chars) |
| `MEMGLOW_SHOW_BODIES` | `true` | show note text in the side panel |
| `MEMGLOW_POLL_MS` | `2000` | how often the folder is checked |
| `themes`, `themeByFolder`, `defaultTheme`, `subthemeLabels`, `title` | | config file only |

## 🐳 Docker

```bash
docker build -t memglow .
docker run -d --name memglow -p 4747:4747 \
  -v /path/to/notes:/memory:ro \
  -e MEMGLOW_TOKEN=... -e MEMGLOW_PASSWORD=... \
  memglow
```

## 🔒 Security

- Notes are read **read-only**; memglow never writes to `MEMORY_DIR`.
- By default it listens on `127.0.0.1` only. If you expose it, set `MEMGLOW_PASSWORD` and put it
  behind HTTPS.
- `/api/activity` does not exist without `MEMGLOW_TOKEN`; with a wrong or missing token it answers
  the same `404` as any unknown route (it does not reveal itself). Tokens are compared in constant
  time, bodies are capped at 4 KB, 30 events/s at most, and note ids are checked against existing
  notes.
- What is **never** exposed: note bodies in the graph or the live stream (only in the note panel,
  and only if `MEMGLOW_SHOW_BODIES` is on), files outside `MEMORY_DIR`, hidden folders. Lines that
  look like secrets (API keys, tokens, `password: …`) are masked before a body is sent.
- Strict Content-Security-Policy (`script-src 'self'`), `nosniff`, no framing, no referrer.
  No CDN, no analytics, no network calls from the page.

## ❓ FAQ

<details>
<summary><b>Does it work with basic-memory?</b></summary>

Yes — point `MEMORY_DIR` at the project folder of your basic-memory knowledge base; the hook
understands basic-memory's MCP tools out of the box. memglow is not affiliated with basic-memory
and does not include or modify it.
</details>

<details>
<summary><b>With Obsidian?</b></summary>

Yes — any vault works; use `theme` frontmatter or `themeByFolder`.
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

## 💎 Pro (coming soon)

A Pro edition is being considered for people who live in their assistant's memory every day:

- **Dashboard** — words, notes, links and activity over time, most-read notes, memory health.
- **History & diffs** — click a write in the journal to see exactly which lines changed.
- **Several memories and users** — per-person access, theme-level visibility.
- **Two-factor login** and one-click install.

Interested? Say so in [GitHub Discussions → Pro interest](https://github.com/R0zumnik/memglow/discussions) — no payment, no e-mail, just tell us which feature you'd use. Details: [docs/pro.html](docs/pro.html).

The open-source edition stays free and MIT.

## 📄 License & thanks

MIT — see [`LICENSE`](LICENSE).

memglow stands on the shoulders of [three.js](https://threejs.org/) and
[3d-force-graph](https://github.com/vasturiano/3d-force-graph) by Vasco Asturiano (with
UnrealBloomPass for the glow). Their licenses (MIT and compatible) are listed in
[`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES). Thanks to the Claude Code hooks system and to
basic-memory for making an assistant's memory something you can look at.

<p align="center"><sub>Not affiliated with Anthropic, basic-memory or Obsidian.</sub></p>
