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
  <a href="#memory-cost">Memory cost</a> ·
  <a href="#assistant">Assistant</a> ·
  <a href="#install">Install</a> ·
  <a href="#activity-api">API</a> ·
  <a href="#mcp-proxy">MCP proxy</a> ·
  <a href="#mcp-server">MCP server</a> ·
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
| 🪙 **Memory cost** | See roughly how many tokens your assistant spends reading its memory (≈ bytes ÷ 4): tokens read today and over 7 days, the notes that cost the most, notes too large to read comfortably, notes never read in 30 days. For each large note, a split along its `##` sections and a **Copy prompt for your AI** button. [More](#memory-cost) |
| 🗂️ **Themes & sub-themes** | Notes cluster by theme with relay bubbles for sub-themes — from frontmatter or folder names. **Organisation** spots notes about one subject scattered across sub-themes; **Always loaded** shows what the index and your CLAUDE.md / AGENTS.md cost at every session. |
| 🛡️ **Protected groups** | At first run, pick the big groups no assistant may ever move notes across (rename how they are shown if you like). [More](#protected-groups) |
| 🎛️ **Tune it live** | Background, glow, bubble size, size by links or token cost, names and name distance, spread, gravity, spacing, signal speed, links at rest, auto-rotate, find-a-note. Saved in your browser. [Settings](#settings) |
| 🔒 **Private by design** | Localhost by default, read-only access to your notes (the optional assistant writes only what you approve), secret-looking lines masked. Hooks send note names only, never content. No CDN, no analytics. |
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
  <tr>
    <td colspan="2"><img src="docs/assets/screenshot-cost.png" alt="The Memory cost panel: tokens read, the most expensive notes, a large note with its sections and a split suggestion"><br><sub><b>Memory cost</b> — which notes cost the most tokens, which to split, a ready prompt for your AI.</sub></td>
  </tr>
</table>

<sub>Captured from the fictional demo memory in <code>demo/memory</code>.</sub>

<a id="memory-cost"></a>
## 🪙 Memory cost

Below the graph, the **Memory cost** panel shows where your assistant's reading goes — on your
own memory, from the activity your hooks report:

- **Tokens read** today and over 7 days, **tokens written** over 7 days, the size of the whole
  memory and of the index note.
- **"N notes = X % of tokens read"** — reading is often concentrated on a few notes.
- **Most expensive to read** (7 days): the top 10 by tokens read (reads × size). Click a note to
  open it in the graph.
- **Too large**: notes above 5,000 tokens (`largeNoteTokens`), with their `##` sections and a
  deterministic split suggestion (consecutive sections grouped into parts of about 2,000 tokens,
  `splitChunkTokens`).
- **Never read in 30 days** — once 30 days of counts exist (before that: "Data since …").
- **Copy prompt for your AI** on each large or costly note: a ready-to-paste prompt with the
  note, its size, its reads, the threshold and the suggested parts, plus rules that keep the
  memory consistent (same group and folder, top-level groups unchanged, `theme`/`subtheme`
  frontmatter kept, `[[links]]` kept valid, the original becomes a short summary, only the
  agent's memory tool is used, and the plan is shown before anything is written).
- **Organisation** — notes about one subject scattered across several sub-themes of the same
  group: *"5 notes about “docker” are spread across 4 sub-themes of Knowledge — group them under
  “ops”?"*, with the notes, the reasons, **Copy prompt for your AI** and (with the
  [assistant](#assistant)) **Do it with …**. Read-only detection, never across big groups; the
  rules are below.
- **Always loaded · every session** — what your assistant receives before doing anything: the
  index note plus the instruction files you list in `alwaysLoaded` (`~/.claude/CLAUDE.md`,
  `./CLAUDE.md`, `AGENTS.md`…). memglow only reads their **size**, never their content; the page
  shows the path you wrote and ≈ tokens. *≈ X tokens per session × N sessions per day ≈ Y tokens
  per day* — sessions per day are estimated from the reads of the index note over the last 7
  days (an assistant reads it once per session), otherwise `sessionsPerDay` (default 5). Above
  `indexWarningTokens` (default 2,000) you get a tip: *trim the index / CLAUDE.md*.

**How Organisation decides** (deterministic, explainable, capped at 5 suggestions of 12 notes):
keywords of a note = words of 4+ letters of its title, id and description (minus common words
and id prefixes such as `reference-`). Two notes **of the same group** are strongly tied when
they score 3 or more: +2 for a `[[link]]` between them, +1 per shared keyword (at most +3).
(1) *Scattered*: notes joined by strong ties that span 2+ sub-themes and number 3+ → regroup them
under the sub-theme that already holds most of them; the topic is the keyword they share most;
the score is the sum of their ties. (2) *Alone*: the only note of a sub-theme, strongly tied
(total ≥ 3) to one other sub-theme of its group → move it there. Note bodies are never read for
this.

Numbers are **estimates** (≈ bytes ÷ 4, not a tokenizer), meant to compare notes with each
other — memglow promises no saving. Memory cost never touches your notes: the counts (note
ids and numbers only, 90 days) live in its own data folder, `~/.memglow` by default
(`MEMGLOW_DATA_DIR`, `/data` in Docker). A note whose text changes on disk counts as a write even
without a hook (an assistant without hooks, an edit by hand); when a hook reports the same write
within 15 seconds, it is counted once. Activity sent with `"demo": true` is animated but not
counted. The panel refreshes a second or two after each activity or note change. The bubble size can follow the token cost too: *Settings → Size by → Token cost*.

<a id="protected-groups"></a>
## 🛡️ Protected groups

Your big groups (top-level themes: *People*, *Work*, *Home*…) are yours. The first time you open
memglow, a **"What are your big themes?"** screen lists the groups found in your folders and
`theme:` keys (with their note counts and folders): tick the ones to **protect**, and rename how
a group is shown if you like (display only — your notes are not changed). Change it any time in
*Settings → Protected groups*. The choice is saved on the memglow server, in its data folder
(`zones.json`), with the same guard as the saved view (page password if set, memglow's own
header and same origin, strict validation). You can also set it in the config file:
`"protectedThemes": ["people", "work"]` (a choice saved from the page wins).

The [assistant](#assistant) refuses any proposal that would **move a note into or out of a
protected group, create a note in another group, rename a group, or change the `theme`
frontmatter** of a note in a protected group — checked on every file, with the group computed
the way the viewer computes it (`theme:` key, then folder rules), and checked again at Apply.
The protected groups are also named in every prompt memglow writes for an AI (*"never move notes
across these groups"*), including the copyable ones.

<a id="assistant"></a>
## 🤖 Assistant (optional, off by default)

> **The AI only proposes. memglow only writes what you approved in a diff, with a backup and Undo.**

Turn it on and every large or costly note in Memory cost gets a **Do it with Claude** button next
to *Copy prompt for your AI*, and an **Assistant** panel appears below Memory cost:

1. **Ask** — memglow sends the note (and its context: title, group, folder, sections, suggested
   split, the lines of other notes that link to it) to the AI you chose. The AI gets **no tool at
   all**: it cannot read, write, run or fetch anything. It answers with one JSON proposal:
   a short summary for the original note, the new notes (title, file name, content), and optional
   link updates in the notes that point to it.
2. **Check** — memglow validates the proposal and refuses it, with the reasons, if anything is off:
   a file name with a path or `..`, a new note that would replace an existing one, content missing
   from the original note (every non-empty line must be found in a part or in the summary), a part
   that brings its own frontmatter, a summary that does not link every part, a link update outside
   the notes that link to the original. New notes get the original note's `theme` / `subtheme`
   lines, so the group never changes; the original note keeps its frontmatter byte for byte.
   Nothing is ever deleted, moved or renamed.
3. **Review** — the panel shows the **exact changes, file by file** (added lines in green, removed
   in red), the AI's short note, and the gain: tokens to read the note today vs the new summary.
4. **Apply** — the *Apply this plan* button asks the server for a **one-time confirmation token**
   (random, 2 minutes, single use, bound to this proposal; typing "yes" anywhere does nothing).
   memglow then checks that no file changed since the proposal, **backs up** the notes it will
   modify — a snapshot commit if your notes are a git repository (only those files, author
   `memglow`, your hooks not run), otherwise a copy in `<dataDir>/backups/<time>-<job>/` — and
   **if the backup fails, nothing is written**. Files are written atomically; a new note never
   overwrites a file.
5. **Undo** — restores the backup and removes the new notes, except files you changed since
   (those are listed and left alone). The last 5 applied changes keep their Undo button; every
   backup folder also has a `job.json` for a manual restore.

Lines that look like secrets (API keys, tokens, `password: …`) **never leave your machine**: memglow
replaces them with placeholders before sending the note, checks they all come back once, and puts
the real lines back when writing. Everything else in the note **is sent to the AI** you chose.

**Turn it on** — in `memglow.config.json`:

```json
{ "assistant": { "enabled": true, "provider": "claude-code" } }
```

or `MEMGLOW_ASSISTANT=1`. It needs `MEMGLOW_SHOW_BODIES` on (you must see what will be written)
and a data folder outside your notes (for backups). Off, its routes answer `404` like any unknown
route, and no button or panel is shown.

**Providers** (`assistant.provider` sets the default; every ready provider can be picked in the
panel when you ask):

| Provider | Runs | Where your note goes | Status |
|---|---|---|---|
| `claude-code` (default) | your own Claude Code CLI (`claude`), your subscription or key | wherever your CLI sends it (Anthropic by default) | ✅ supported |
| `anthropic` | Anthropic Messages API, your API key | `api.anthropic.com` | ✅ supported |
| `openai-compatible` + `preset: "openai"` | OpenAI Chat Completions, your key | `api.openai.com` | ✅ supported |
| `openai-compatible` + `preset: "mistral"` | Mistral, your key | `api.mistral.ai` | ✅ supported |
| `openai-compatible` + `preset: "openrouter"` | OpenRouter, your key | `openrouter.ai` (then the model's vendor) | ✅ supported |
| `openai-compatible` + `preset: "ollama"` | Ollama on this machine, `http://127.0.0.1:11434/v1`, no key | **nowhere: it stays on your machine** | ✅ supported |
| `openai-compatible` + `preset: "lmstudio"` | LM Studio on this machine, `http://127.0.0.1:1234/v1`, no key | **nowhere: it stays on your machine** | ✅ supported |
| `codex`, `gemini`, `cursor` | their CLIs | — | not yet: memglow has not verified a way to run them with no tool at all |

Any other OpenAI-compatible server works with `baseUrl` instead of `preset` (memglow calls
`<baseUrl>/chat/completions`).

`claude-code` is run as `claude -p --tools "" --strict-mcp-config --restricted --permission-mode
dontAsk` with a deny-all permission rule, no session saved, the prompt on stdin (never on the
command line, never through a shell), in an empty folder of memglow's data folder. Options:
`command` (path to `claude`), `model`, `maxBudgetUsd`, `timeoutMinutes` (default 10). Claude Code
must be installed and signed in (run `claude` once in a terminal). The panel lists the providers it
detects and says clearly when one is missing.

**HTTP providers** (`anthropic`, `openai-compatible`) — examples:

```json
{ "assistant": { "enabled": true, "provider": "anthropic", "model": "claude-sonnet-5-5" } }
```

```json
{ "assistant": { "enabled": true, "provider": "openai-compatible", "preset": "ollama", "model": "llama3.1" } }
```

The top-level `model`, `baseUrl`, `preset`, `maxTokens`, `apiKeyEnv`, `apiKeyFile` apply to the
default provider. To have several ready at once, give the others their own section, e.g.
`"anthropic": { "model": "…" }` or `"openai-compatible": { "preset": "lmstudio", "model": "…" }`
inside `assistant`. `anthropic` defaults to `claude-sonnet-5-5` and `maxTokens` 32000;
`openai-compatible` needs a `model` (the name your server knows) and sends `max_tokens` only if
you set `maxTokens`.

- **The API key is never in `memglow.config.json`** — memglow refuses to start the assistant if
  it finds `apiKey` (or `key`, `token`, `secret`…) there. Put it in the environment variable
  `MEMGLOW_ASSISTANT_API_KEY` (or the variable named by `apiKeyEnv`, e.g. `"apiKeyEnv":
  "ANTHROPIC_API_KEY"`), or alone in the file `assistant-api-key` of memglow's data folder
  (`apiKeyFile` to rename it) with mode `600` — a file other users can read is refused, with the
  `chmod` to run. The key is sent only to the provider's address (`x-api-key` for Anthropic,
  `Authorization: Bearer` otherwise), never to the browser (the panel only says *key: set / not
  set*), never logged, never in an error message. Ollama and LM Studio need no key.
- **HTTPS is required** for any address that is not this machine (`127.0.0.1`, `::1`,
  `localhost`): `http://` to anything else is refused, and so is a URL with a user name or
  password in it. Redirects are not followed. In Docker, a model on the host is not loopback
  from inside the container: run memglow with host networking, or put the model behind HTTPS.
- **Before you click Propose**, the panel says where the note goes: *Local model — nothing leaves
  your machine*, or *Your note will be sent to api.example.com*.
- **What is sent** is exactly the prompt built for every provider, nothing else from your memory:
  the note you picked (secret-looking lines replaced by placeholders), its title, group, size and
  sections, the lines of other notes that link to it, the names of your existing notes (so new
  files never reuse one), and your optional extra instructions. No tool is declared in the request
  (no `tools` / `functions`); an answer that tries to call one is rejected, as is an answer that is
  not valid JSON, cut off, or larger than 4 MB. Each request is time-limited (`timeoutMinutes`).
  HTTP errors are reported plainly (401 key refused, 429 rate limit with its delay, 5xx).

**Regroup** (Organisation suggestions). *Do it with …* on an Organisation suggestion asks the AI
which notes of that suggestion should share one sub-theme. The AI receives **only metadata** —
ids, titles, descriptions (secret-looking lines masked), current sub-themes and the folders of
the group, never a note's text — and answers `{"subtheme", "moves": [{"note", "folder"?}],
"notes"}`. memglow then changes **only the `subtheme` line** (or an existing `sous_theme` line;
one is added if missing) of the notes moved, and moves a file only to a folder of the **same
group** when the AI names one. Refused, with the reasons: a key that would change or rename a
group (`theme`, `group`, `rename`…), a note memglow did not list, an unknown folder, a file
that would replace another, a note that would leave its group (or a protected group), any change
of a note's text or `theme` line. Links by name stay valid (names never change); links written as
a path (`[[folder/note]]`) to a moved file are updated. Same diff, one-time token, backup and
Undo as a split (Undo puts a moved note back in its old place).

With **basic-memory**, memglow writes the Markdown files directly; basic-memory re-indexes changed
files on its own (its sync watches the folder). New notes have no `permalink` until basic-memory
adds one.

<a id="settings"></a>
## 🎛️ Settings

The **Settings** panel on the graph. Your **view** — these settings, the layout of the bubbles
(where they are, which ones you pinned by dragging) and the camera — is **saved on the memglow
instance**, in its data folder (`view.json` in `~/.memglow`, `MEMGLOW_DATA_DIR`, or the `/data`
volume in Docker). memglow has one user per instance, so every browser and device that opens it
gets the **same view**: set it up on your laptop, open it on your phone, same picture. The page
also keeps a copy in the browser (`localStorage`, keys `memglow.*`) and uses it if the server does
not answer within a few seconds.

| Section | Setting | What it does |
|---|---|---|
| Display | Glow | strength of the glow |
| | Names | none, active notes only, or all |
| | Name distance | names fade out beyond this distance (20 = always shown) |
| | Background | Deep (gradient and faint stars, default), Plain, Night blue, Light |
| | Bubble size | 0.5× to 3× |
| | Size by | number of links, or token cost |
| | Group by theme / Sub-themes | clusters and sub-theme bubbles |
| Motion | Spread, Gravity | size of the graph, pull towards each theme |
| | Minimum spacing | gap kept between bubbles; wins over gravity |
| | Signal speed | how fast comets run along the links (default 1.8 s per link) |
| | Auto-rotate, Follow activity, Dragged bubbles stay put | camera and dragging |
| Links | Links at rest | hidden, subtle or visible; comets light the way anyway |
| | Ambient flow | slow comets at rest |

Drag a bubble to move it, double-click it to release it; double-click the background to go
back to the overview. **Rearrange** starts again from a fresh layout (your settings stay). A note
added later appears next to its sub-theme bubble, without shaking the saved layout. With
*reduced motion* on, a saved layout is restored without animation.

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
node demo/simulate.js 60             # add --counted to fill Memory cost as well
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
journal says *Note changed · Projects · Release notes · file* (it also counts as a write in
Memory cost). Hooks and the proxy add what the disk cannot tell: **reads and searches**, and
*which* tool did it, from *which* machine, over *which* channel — e.g.
*Read · Projects · Release notes · laptop · hook · Claude Code*.

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
| `MEMGLOW_MACHINE` | short hostname | label for this machine in the journal (e.g. "laptop"); also settable as `machine` in `~/.memglow/memglow.config.json` |

Every adapter answers its tool at once, sends the event from a detached process that gives up
after 3 s, prints nothing else and exits 0: memglow being down never slows your assistant.

The v0.1 Claude Code hook, `hooks/memglow-activity.js`, keeps working unchanged (it also reads
`MEMGLOW_MACHINE`, same default).

<a id="activity-api"></a>
## 📡 Activity API

Any program can light notes up:

```bash
curl -H "Authorization: Bearer $(cat ~/.memglow/token)" -H 'Content-Type: application/json' \
  -d '{"type":"read","ids":["alice"],"source":"my-agent"}' http://127.0.0.1:4747/api/activity
```

`type` is `read`, `search` or `write`; `ids` are note names or paths (only existing notes are
kept); `source` is the tool shown in the journal (each line reads *action · group · note ·
machine · channel · tool*, e.g. *Write · Projects · Release notes · laptop · hook · my-agent* —
`machine` and `channel` are optional extras, v0.4: a short per-sender label and how the event got
there — `hook`, `mcp-proxy`, `file` or `api`; an event without them shows exactly as before). Full
reference with Python and Node examples: [docs/api.md](docs/api.md).

<a id="mcp-proxy"></a>
## 🔌 MCP proxy

For MCP clients without hooks (Claude Desktop, Continue, Roo Code…), put the proxy in front of
the memory server. It reports note names only, and relays the server's answers — with, if you
want, a few levers that make the assistant find faster and read less:

```json
"basic-memory": {
  "command": "node",
  "args": ["/path/to/memglow/mcp-proxy/memglow-mcp-proxy.js", "--name", "basic-memory", "--", "uvx", "basic-memory", "mcp"]
}
```

Streamable HTTP servers too: `memglow-mcp-proxy --upstream http://127.0.0.1:8000/mcp --listen 127.0.0.1:8765`.
Tool-name mapping is configurable. Details: [mcp-proxy/README.md](mcp-proxy/README.md).

**Token-saving and speed levers (v0.4).** The proxy annotates the memory server's *answers* —
never your notes, which it only reads. Levers 1-3 only add a short block before or after the
server's own content; 4 and 5 may replace a read answer, so they are off by default.

| # | Lever (`proxy` key / variable) | Default | Effect |
|---|---|---|---|
| 1 | `sizeWarning` / `MEMGLOW_PROXY_SIZE_WARNING` | on | `⚠ memglow: this note is ≈N tokens (threshold T)…` before a large note, or after a write that makes it large — suggests a split within the same theme. Once per note and session. |
| 2 | `searchDetails` / `MEMGLOW_PROXY_SEARCH_DETAILS` | on | After search results: title · theme · ≈tokens · description of each note found. |
| 3 | `suggestions` / `MEMGLOW_PROXY_SUGGESTIONS` | on | After a read: up to 3-5 related notes (links, sub-theme, co-usage), names and sizes only. |
| 4 | `dedupe` / `MEMGLOW_PROXY_DEDUPE` | off | An unchanged note re-read in the same session → a short "unchanged, ≈N tokens saved" notice. |
| 5 | `toc` / `MEMGLOW_PROXY_TOC` | off | A large note → its outline with ≈tokens per section first; then one section on demand. |
| — | `indexWarning` / `MEMGLOW_PROXY_INDEX_WARNING` | off | The **index** note read while above `indexWarningTokens` (default 2,000): `⚠ memglow: the index note … is loaded at every session` — suggests trimming it. Once per session. |

Levers 4 and 5 change what the assistant receives: **measure answer quality before enabling
them**. Repeating the same read, or adding `"memglow_fresh": true`, always brings the full note
back. Configuration (`memglow.config.json` → `"proxy": {…}`), examples and the exact rules:
[mcp-proxy/README.md](mcp-proxy/README.md#token-saving-and-speed-levers-v04).

<a id="mcp-server"></a>
## 🧠 MCP server (read-only)

A second, separate MCP server — not the proxy above — that lets your assistant **ask memglow
questions about its own memory**, instead of only being watched by it: which notes are too
large, what to read first about a topic, what something costs to read. It starts entirely on its
own (no viewer, no network, nothing else to run first) and never writes anything — not the
notes, not even memglow's own counters.

```json
"memglow": {
  "command": "npx",
  "args": ["-y", "memglow-mcp"],
  "env": { "MEMORY_DIR": "/path/to/your/notes" }
}
```

Works the same way in Claude Code (`claude mcp add memglow -- npx -y memglow-mcp`), Cursor
(`.cursor/mcp.json`, same `command`/`args`/`env`) or any MCP client that can run a stdio
command. Locally, straight from the repo: `node mcp-server/memglow-mcp.js`. Configuration is the
same as the viewer's (`MEMORY_DIR`, `memglow.config.json`, `MEMGLOW_DATA_DIR`, `MEMGLOW_LARGE_NOTE_TOKENS`,
`splitChunkTokens` — see [Configuration](#configuration)); if `MEMGLOW_DATA_DIR` holds the
viewer's activity counters, the tools below use real 7-day read counts, otherwise they say so
plainly instead of guessing. An empty or missing notes folder is not an error: the tools just
answer "no notes found".

| Tool | Arguments | What it returns |
|---|---|---|
| `memory_health` | *(none)* | Notes over the large-note threshold, the costliest notes to read over 7 days and the notes never read in 30 days (both only once enough activity history exists), the size of the index note, and the always-loaded cost (index + `alwaysLoaded` files, × sessions per day). |
| `split_plan` | `note` | A deterministic split of one note along its `##` sections (same rule as the Memory cost panel), or an honest "no split needed" under the threshold — plus a ready-to-paste English instruction for the assistant's **own** memory tool (memglow itself never edits notes). |
| `related_notes` | `note` or `topic`, `limit` | Notes related to a note (its outgoing/incoming `[[wikilinks]]`, notes in the same sub-theme, and — when activity history exists — notes read on the same days) or to a free-text topic matched against titles, descriptions, ids and sub-themes. |
| `note_cost` | `note` | Estimated tokens, the large-note threshold, status, and reads over the last 7 days (when available) for one note. |
| `organisation_suggestions` | `limit` | Notes about one subject scattered across sub-themes of a group (same rules as Memory cost → Organisation), with the reasons and a ready-to-paste instruction for the assistant's own memory tool that names your protected groups. |

No write tool, and no tool ever returns a full note body: only ids, titles, token estimates,
frontmatter descriptions and section headings — masked for secret-looking lines like everywhere
else in memglow.

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
| `MEMORY_DIR` | `./memory` | folder of notes (read-only access is enough, unless you use the assistant) |
| `PORT` / `HOST` | `4747` / `127.0.0.1` | use `HOST=0.0.0.0` to expose it (then set a password) |
| `MEMGLOW_TOKEN` | — | enables `POST /api/activity` for hooks (32+ chars) |
| `MEMGLOW_PASSWORD` | — | HTTP Basic auth on the viewer (user `memglow`, 12+ chars) |
| `MEMGLOW_ALLOWED_HOSTS` | — | extra host names served without a password, comma-separated (e.g. `mybox.local`); localhost names are always allowed |
| `MEMGLOW_SHOW_BODIES` | `true` | show note text in the side panel |
| `MEMGLOW_POLL_MS` | `2000` | how often the folder is checked |
| `MEMGLOW_DATA_DIR` / `dataDir` | `~/.memglow` | memglow's own data (Memory cost counts, saved view); never the notes folder |
| `MEMGLOW_LARGE_NOTE_TOKENS` / `largeNoteTokens` | `5000` | Memory cost: a note above this is "too large" |
| `splitChunkTokens` | `2000` | Memory cost: target size of each part of a split suggestion |
| `MEMGLOW_ASSISTANT` / `assistant.enabled` | off | the optional [assistant](#assistant) (`1` on, `0` off whatever the file says) |
| `MEMGLOW_ASSISTANT_PROVIDER` / `assistant.provider` | `claude-code` | which AI proposes |
| `MEMGLOW_ASSISTANT_COMMAND` / `assistant.command` | `claude` | path of the Claude Code CLI |
| `MEMGLOW_ASSISTANT_MODEL` / `assistant.model` | CLI default; `claude-sonnet-5-5` for `anthropic` | model name passed to the provider |
| `MEMGLOW_ASSISTANT_BASE_URL` / `assistant.baseUrl` | — | API address of `openai-compatible` (or another Anthropic endpoint); HTTPS unless on this machine |
| `MEMGLOW_ASSISTANT_PRESET` / `assistant.preset` | — | `openai`, `mistral`, `openrouter`, `ollama`, `lmstudio` (fills `baseUrl`) |
| `MEMGLOW_ASSISTANT_API_KEY` | — | API key of the HTTP provider (never in the config file); or `assistant.apiKeyEnv` = name of another variable, or a mode-600 file `assistant-api-key` (`assistant.apiKeyFile`) in the data folder |
| `assistant.maxTokens` | `32000` (`anthropic`), unset | longest answer allowed |
| `assistant.timeoutMinutes`, `assistant.maxBudgetUsd` | `10`, — | stop a proposal after this long; spending cap for Claude Code |
| `assistant.backup` | `auto` | `auto` (git snapshot if the notes are a git repository, else a copy), `git` or `copy` |
| `assistant.allowMissingLines` | `0` | how many original lines may be missing from a proposal (0 = none) |
| `protectedThemes` | not set (asked at first run) | [protected groups](#protected-groups): theme ids the assistant never moves notes across; a choice saved from the page wins |
| `alwaysLoaded` | `[]` | instruction files loaded at every session (`"~/.claude/CLAUDE.md"`, `"./CLAUDE.md"`, `"AGENTS.md"`…); size only, never read; relative paths from where memglow starts |
| `sessionsPerDay` | `5` | Always loaded: sessions per day when no read of the index note was counted |
| `indexWarningTokens` | `2000` | Always loaded: "trim" tip above this; also the threshold of the proxy's `indexWarning` |
| `themes`, `themeByFolder`, `defaultTheme`, `subthemeLabels`, `title` | — | config file only |

<a id="docker"></a>
## 🐳 Docker

```bash
docker run -d --name memglow -p 127.0.0.1:4747:4747 \
  -v /path/to/notes:/memory:ro \
  -v memglow-data:/data \
  -e MEMGLOW_TOKEN=$(cat ~/.memglow/token) \
  ghcr.io/r0zumnik/memglow:0.3.1
```

`/data` keeps the Memory cost counts (note ids and numbers only) and the saved view (settings,
layout, camera) across restarts.

Or with Compose: copy [`docker-compose.example.yml`](docker-compose.example.yml), set `NOTES`,
then `docker compose up -d` — `memglow init --docker` writes one for you in `~/.memglow/`.

Images for amd64 and arm64 (Apple silicon, Raspberry Pi) are published on every release; pin a version with `ghcr.io/r0zumnik/memglow:0.3.1`.

The hooks and the MCP proxy run next to your AI tools, not in the container: point them at the
container with `MEMGLOW_URL` (default `http://127.0.0.1:4747`) and the same token.

<a id="security"></a>
## 🔒 Security

- Notes are read **read-only**; memglow never writes to `MEMORY_DIR` — with one opt-in exception,
  the [assistant](#assistant), off by default: **the AI only proposes; memglow only writes what you
  approved in a diff, with a backup and Undo.**
- Assistant: its routes do not exist unless it is enabled (`404` like any unknown route). They follow
  the page's access rule (localhost / `MEMGLOW_ALLOWED_HOSTS`, or `MEMGLOW_PASSWORD`), and every
  action (ask, confirm, apply, undo, cancel) needs the same CSRF protection as the saved view
  (`X-Memglow: 1` + same `Origin`), is rate limited (30 per minute, 6 proposals per 10 minutes),
  and takes an 8 KB JSON body at most. One job at a time. The AI gets no tool (for Claude Code:
  `--tools ""`, no MCP server, deny-all rule, `dontAsk`, `--restricted`, never a bypass mode); an
  answer that calls a tool anyway is rejected. Note content is sent to it as **data**, and its
  instructions say so: a note that tries to give orders can at worst produce a proposal that
  memglow's checks refuse or that you see, line by line, before deciding. Applying needs a
  one-time server token (256 bits, 2 minutes, single use, only its hash kept); a backup that fails
  stops everything. memglow's logs carry job ids, states and durations — never note text nor the
  AI's answer. Secret-looking lines are replaced by placeholders before anything is sent. HTTP
  providers: API key only from an environment variable or a mode-600 file (refused in the config
  file), never sent to the browser, logged or shown in an error; HTTPS required off this machine;
  no redirect followed; answers capped in time and size.
- By default it listens on `127.0.0.1` only. If you expose it, set `MEMGLOW_PASSWORD` and put it
  behind HTTPS.
- Without a password, memglow only answers requests addressed to `localhost`, `127.0.0.1` or
  `[::1]` (plus any name you list in `MEMGLOW_ALLOWED_HOSTS`): this blocks DNS-rebinding, where a
  malicious web page points its own domain at your machine to read the viewer from your browser.
  Other host names get a `403` explaining what to do. With a password the credentials protect it.
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
- Memory cost (`GET /api/cost`) is behind the same password as the rest. It sends note titles,
  sizes and counts; section titles only when note bodies may be shown, with secret-looking
  headings masked. Its counts are written to memglow's data folder, never to `MEMORY_DIR`.
- The saved view (`GET`/`PUT /api/view`) follows the same rule as the page: behind
  `MEMGLOW_PASSWORD` when it is set. A write must come from the page itself: it needs memglow's
  own `X-Memglow: 1` header and an `Origin` of the same host (`Host`, or `X-Forwarded-Host` behind
  a reverse proxy); anything else gets `403` (no cross-site request can save a view). Bodies are
  capped at 256 KB (`413`), unreadable ones get `400`, writes are rate limited (`429`), and the
  content is **strictly validated**: a closed list of settings with their types and bounds, finite
  bounded coordinates for existing notes and sub-theme bubbles only (2,000 at most), pinned
  bubbles among them, a bounded camera — anything else is dropped, never stored as sent. It is
  written atomically in memglow's data folder; if that folder is inside `MEMORY_DIR`, memglow
  writes nothing and keeps counts and view in memory only.
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

No. Any browser with WebGL works; a few hundred notes run smoothly on a laptop. The demo GIF was
rendered in software, in a headless browser without a GPU.
</details>

<details>
<summary><b>Why polling and not file watching?</b></summary>

Watching is unreliable on network shares and many NAS filesystems; polling a few hundred notes
every 2 s is cheap and always works.
</details>

<details>
<summary><b>Does memglow write my notes?</b></summary>

Not unless you turn on the optional [assistant](#assistant) and click *Apply* on a proposal you
have reviewed. The AI only proposes; memglow checks the proposal, shows you the exact diff, backs
up the notes (git snapshot or copy) and writes only then, with Undo. Off by default.
</details>

<details>
<summary><b>Can the assistant run with something else than Claude Code?</b></summary>

Yes: the Anthropic API with your key, or any OpenAI-compatible API — OpenAI, Mistral, OpenRouter,
or a model on your own machine with Ollama or LM Studio, where nothing leaves your computer. See
[Providers](#assistant). memglow only enables an AI it can run with **no tool at all**: HTTP
requests declare none. Codex, Gemini and Cursor CLIs are listed in the panel when installed but
stay off until memglow can verify the same guarantee.
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
