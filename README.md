# memglow

**See your AI assistant think.** memglow turns a folder of Markdown notes — the long-term memory
of Claude Code, an Obsidian vault, a basic-memory knowledge base — into a live 3D brain. When your
assistant reads, searches or writes a note, the neuron lights up and a comet runs along its links.

<!-- Demo GIF placeholder: record demo/apercu.html (node demo/build-preview.js) and put it here. -->
![memglow demo](docs/demo.gif)

- **Live** — changes appear within seconds; assistant activity shows up as it happens.
- **Readable** — notes grouped by theme and sub-theme, calm at rest, the camera follows the action.
- **Private by design** — runs on your machine, reads your notes read-only, never sends them anywhere.
- **Zero dependencies** — one `node server.js`, Node 18+. Or Docker.

## Quick start

```bash
git clone https://github.com/<you>/memglow && cd memglow
MEMORY_DIR=./demo/memory node server.js     # the fictional demo memory
# open http://127.0.0.1:4747
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

## Live activity from Claude Code

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

Hook settings (environment of the Claude Code session): `MEMGLOW_URL` (default
`http://127.0.0.1:4747`), `MEMGLOW_MEMORY_DIR` (so plain `Read`/`Write`/`Edit` of `.md` files in
that folder count), `MEMGLOW_MCP_PREFIX` (default `mcp__basic-memory__`), `MEMGLOW_SOURCE` (label in
the journal). The hook never blocks the session: it detaches, gives up after 3 s and prints nothing.

Colours of a single-note action: **read** cyan, **write** red-orange, **search** violet.

## Your notes

Any folder of `*.md` files works. memglow reads, if present:

| Frontmatter | Meaning |
|---|---|
| `title` | display name (otherwise derived from the file name) |
| `description` | shown in the tooltip and the note panel |
| `theme` | big group (must be one of the configured themes) |
| `subtheme` (or `sous_theme`) | relay bubble inside the group |

Links are `[[wikilinks]]` to another note's file name (links quoted inside code are ignored).
A note named `MEMORY` or `index` sits at the centre.

Without a `theme`, a note inherits one from its folder (`themeByFolder`), else `defaultTheme`.

## Configuration

Environment variables, or `memglow.config.json` (see `memglow.config.example.json`):

| Setting | Default | |
|---|---|---|
| `MEMORY_DIR` | `./memory` | folder of notes (read-only access is enough) |
| `PORT` / `HOST` | `4747` / `127.0.0.1` | use `HOST=0.0.0.0` to expose it (then set a password) |
| `MEMGLOW_TOKEN` | — | enables `POST /api/activity` for hooks (32+ chars) |
| `MEMGLOW_PASSWORD` | — | HTTP Basic auth on the viewer (user `memglow`, 12+ chars) |
| `MEMGLOW_SHOW_BODIES` | `true` | show note text in the side panel |
| `MEMGLOW_POLL_MS` | `2000` | how often the folder is checked |
| `themes`, `themeByFolder`, `defaultTheme`, `subthemeLabels`, `title` | | config file only |

## Docker

```bash
docker build -t memglow .
docker run -d --name memglow -p 4747:4747 \
  -v /path/to/notes:/memory:ro \
  -e MEMGLOW_TOKEN=... -e MEMGLOW_PASSWORD=... \
  memglow
```

## Security

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

## FAQ

**Does it work with basic-memory?** Yes — point `MEMORY_DIR` at the project folder of your
basic-memory knowledge base; the hook understands basic-memory's MCP tools out of the box.
memglow is not affiliated with basic-memory and does not include or modify it.

**With Obsidian?** Yes — any vault works; use `theme` frontmatter or `themeByFolder`.

**Why polling and not file watching?** Watching is unreliable on network shares and many NAS
filesystems; polling a few hundred notes every 2 s is cheap and always works.

**Why does a note not flash when a sync tool rewrites it?** Only a change of the note's *body*
counts as a write: frontmatter-only rewrites and file copies are ignored.

## Pro (coming soon)

A Pro edition is being considered for people who live in their assistant's memory every day:

- **Dashboard** — words, notes, links and activity over time, most-read notes, memory health.
- **History & diffs** — click a write in the journal to see exactly which lines changed.
- **Several memories and users** — per-person access, theme-level visibility.
- **Two-factor login** and one-click install.

Interested? See [docs/pro.html](docs/pro.html) — no payment, just tell us you'd use it.

## License

MIT — see `LICENSE`. Bundled libraries (3d-force-graph, three.js, UnrealBloomPass, MIT and
compatible licenses) are listed in `THIRD_PARTY_LICENSES`.
