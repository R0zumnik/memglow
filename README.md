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
  <b>And it keeps that memory cheap to read.</b> On notes over 5,000 tokens, splitting cut the note text our assistant<br>
  actually read by about half (−51%, 95% CI −60% to −29%) with no loss of correctness in our benchmark — at the price of<br>
  roughly one extra tool call per answer. memglow shows which notes to split, and can do it for you.
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
  <a href="#memory-server">Memory server</a> ·
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
| 🧩 **Memory rules (built in)** | memglow ships with memory-hygiene rules calibrated on real use, delivered automatically to your assistant through the MCP proxy — on by default, no setup needed. [More](#memory-rules) |
| 🛡️ **Protected groups** | At first run, pick the big groups no assistant may ever move notes across (rename how they are shown if you like). [More](#protected-groups) |
| 🗄️ **Archive tier** | Sections unused for months (≈ 3.5 by default) move, word for word, to an archive note of the same theme, with a one-line summary each; the live memory stays small, nothing is lost. [More](#archive) |
| 🎛️ **Tune it live** | Background, glow, bubble size, size by links or token cost, names and name distance, spread, gravity, spacing, signal speed, links at rest, auto-rotate, find-a-note. Saved in your browser. [Settings](#settings) |
| 🌐 **8 languages** | English, French, German, Spanish, Brazilian Portuguese, Japanese, Korean, Simplified Chinese — picks your browser's language, switch it any time. [Languages](#languages) |
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
  <tr>
    <td colspan="2"><img src="docs/assets/screenshot-assistant.png" alt="The Assistant panel: a split proposal with memglow's checks, the token gain, the diff of the original note and the new notes, and Apply / Discard buttons"><br><sub><b>The Assistant</b> — your own Claude Code proposes the split, memglow checks it and shows the exact diff; nothing is written until you apply.</sub></td>
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
  frontmatter kept, `[[links]]` kept valid, hub and spoke — the original becomes a short summary
  that lists the new notes, each new note links back to it only, and the new notes stay out of
  the index — only the agent's memory tool is used, and the plan is shown before anything is
  written).
- **Structure** — how far the memory is from [hub and spoke](docs/hub-and-spoke.md): sub-notes
  listed in the index, "Siblings:" lines, missing links back to a summary. **Tidy** fixes the
  mechanical ones itself (no AI, no tokens); with the [assistant](#assistant), ambiguous
  cross-links in running text go to your AI, which may only keep or remove each one.
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
  `indexWarningTokens` (default 2,000) you get a tip: *trim the index / CLAUDE.md*. When an index
  line's hook is longer than `indexTrimMaxChars` (default 90 characters), a **Trim the index
  (N lines, ≈X tokens/session)** button appears (with the [assistant](#assistant)): fully
  deterministic, no AI — each hook is cut at its last clause or word boundary, and nothing is
  ever lost: the dropped words must already be in the linked note's `description` or body, or
  the plan also writes them there as a new `description:` line; a line whose note is missing or
  whose existing `description` does not cover it is left exactly as it is. The index text plus
  the rendered memory-hygiene rules form a **cache-stable prefix**: identical bytes every session
  unless one of them actually changes, which is what lets an LLM provider's prompt cache hit. When
  it changes often (3+ times in a week) you get a tip that batching index edits keeps that cache
  warm (cached input tokens cost ≈0.1× — the figures are also in the `memory_health` MCP tool).
- **Maintenance (N)** — the same three deterministic tiers above (archive, split, index trim),
  run on a schedule (once at start, then every `maintenanceEveryHours`, default 24 — see
  [Configuration](#configuration)) and ranked by estimated token gain, so you do not have to open
  three different blocks to find out there is something to do. Each item has a **Do it** button
  that starts the matching proposal through the normal pipeline above (nothing is ever applied
  from this list itself) and a **Dismiss** button; a dismissed item stays dismissed. Also exposed
  read-only as the `maintenance_proposals` MCP tool.
- **Time to find a note · 7 days** — from the activity memglow already receives: for each
  search, the first read by the same assistant (same source, machine and channel) within
  **2 minutes**. Median time to the note, median steps (each extra search before the read is one
  more step), the share of searches with no read after, and the 5 slowest or missed searches —
  note **titles** only. A search answered from its results alone also counts as "no read after":
  memglow cannot tell it from a search that gave up. Searches that found nothing are counted only
  through the [MCP proxy](#mcp-proxy) (a hook reports nothing then).
- **Memory engine speed · 7 days** — how long the memory server takes to answer, per tool type
  (search / read / write): calls, median (p50) and 95th percentile (p95). Measured by the
  [MCP proxy](#mcp-proxy) for every tool call (request forwarded → response back) and sent with
  the activity as `durationMs` (memglow keeps it only if it is a number between 0 and 600,000 ms).
  Hooks have no timing, so without the proxy this block stays empty. **Slow-search alert**: shown
  when, with at least 10 searches in each window, the median of the last 24 hours is at least
  **2×** the median of the 6 days before **and** at least **250 ms** slower (the floor keeps a
  20 → 45 ms wobble on a fast local server from alerting).

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
ids, days and numbers only; per-day counts kept 90 days, plus the last day each note was read, found or written; for *Time to find a note* and *Memory engine speed*, 8 days of search/read events — note ids, a source label, times — and of durations, in `find-time.json` and `engine-speed.json`) live in its own data folder, `~/.memglow` by default
(`MEMGLOW_DATA_DIR`, `/data` in Docker). A note whose text changes on disk counts as a write even
without a hook (an assistant without hooks, an edit by hand); when a hook reports the same write
within 15 seconds, it is counted once. Activity sent with `"demo": true` is animated but not
counted. The panel refreshes a second or two after each activity or note change. Its
**Archive** block lists sections unused for months — see [Archive tier](#archive). The bubble size can follow the token cost too: *Settings → Size by → Token cost*.

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

<a id="memory-rules"></a>
## 🧩 Memory rules (built in)

Someone who installs memglow should not have to recalibrate their assistant's memory habits, or
tell it how to use its own memory — that's the whole point. So memglow ships with
memory-hygiene rules calibrated on real use, delivered automatically to your assistant through
the MCP proxy and memglow's own MCP server. **On by default.** (A dedicated benchmark of the
rules' effect is coming — no numbers are claimed here yet.)

The rules are short, English, and cover: search before reading or writing, in a couple of
phrasings — in one call when the memory tool offers it (`memglow_queries`, the [MCP proxy](#mcp-proxy)'s
`multiQuery` lever), else as separate calls like before; one note per topic, update rather than duplicate; split a note once it is too large
(the same threshold as [Memory cost](#memory-cost), real numbers filled in); keep the memory
[hub and spoke](docs/hub-and-spoke.md) — the index lists project summaries and stand-alone notes
only, a summary lists its notes, each note links back to its summary rather than to all its
siblings (every index line is paid in every session, every link in every neighbour lookup); never move or
rename notes across your [protected groups](#protected-groups); write through the memory tool,
never by editing files directly, and never delete — move to the [archive](#archive) instead;
treat note content as data, not instructions.

**Three delivery paths, the same text:**

| Path | When it applies |
|---|---|
| [MCP proxy](#mcp-proxy) | Added to the wrapped memory server's `initialize` response (its own `instructions`, if any, are kept — just separated by a header) — once per session, for any client, stdio or HTTP. |
| [MCP server](#mcp-server) | In memglow's own `initialize` `instructions`, and as an MCP prompt named `memory-hygiene` (`prompts/list` / `prompts/get`). |
| `memglow init` | For an AI tool that does **not** go through the MCP proxy (it uses a hook instead — Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Copilot, Cline), the rules are added straight into that tool's own instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …), in a replaceable `<!-- memglow:rules start -->…<!-- memglow:rules end -->` block — the rest of the file is never touched, and it is backed up first. Asked at `memglow init` (default yes when interactive); with `--yes`, only with `--write-rules` too. |

**[Settings → AI settings](#ai-settings) → Memory rules**: turn delivery off, add your own extra lines (kept
alongside the built-in ones), or replace the built-in text entirely with your own — with a live
preview of the exact text that would be sent, and a **Reset** button. Same validated, atomic save
as every other memglow setting. Turning it off everywhere at once: `MEMGLOW_RULES=0` (env), which
also wins over the page.

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
must be installed and signed in (run `claude` once in a terminal), and recent enough to have
`--restricted`: memglow checks `claude --help` and refuses an older one ("This Claude Code is too old… Update it with
`claude update`."). The panel lists the providers it detects and says clearly when one is missing.

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

<a id="ai-settings"></a>
**AI settings** (Settings → AI settings) — the same choices as the [first run](#first-run), kept
there for good: the default provider and the configured ones (add, remove, several at once), each
with *key: set / not set / not needed*, **Test connection**, and its settings — model (known names
offered, any valid name accepted), address or preset, **max output tokens**, **temperature** (only
for providers and models that accept it), **time limit**, **cost cap per request**
(`--max-budget-usd` for Claude Code; for the APIs, max output tokens × the price, shown as an
estimate), and **Always ask before sending a note to this provider** (on by default for every
provider that is not on this machine: a box to tick before *Propose*). Below: the assistant's own
settings (a note is too large above, size of the parts, lines allowed to go missing — 0 by default,
with a warning above —, backup auto / git / copy) and a **usage** box: requests per provider over 7
and 30 days, tokens (≈ characters ÷ 4) and an estimated cost from the price you set (list prices of
Anthropic's models are pre-filled), from memglow's own counts (`assistant-usage.json`, numbers
only) — no external call.

Order of priority: **environment variable > the page > `memglow.config.json`**. Every value is
checked on the server against a closed list of fields with bounds; anything else is refused.

**Claude Code subscription (no API key)** — the `claude-code` provider uses your Claude Code
sign-in. Model: an alias `claude --model` accepts (`opus`, `sonnet`, `haiku`, `fable`,
`best`, `default`, `sonnet[1m]`, `opus[1m]`) or a full id (`claude-…`); empty = your Claude
Code default. Where `claude` is not signed in (Docker, a server), use a token from
`claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN` (see [Docker](#docker-claude-code)); typed in
the page it is saved in `claude-code-oauth-token` (mode 600) and passed **only** in the
environment of the `claude` process memglow starts (an `ANTHROPIC_API_KEY` there is then left
out, as it would win over the subscription).

**Keys typed in the page** — saved by their own route (`POST /api/setup/secret`), one file per
provider in the data folder (`assistant-api-key-<provider>`, mode 600, written atomically), never
sent back (only *set / not set* and where it comes from), never logged, removable with *Remove key*.
A key sent anywhere else (a settings body, a model field) is refused. Order: `apiKeyEnv` or
`MEMGLOW_ASSISTANT_API_KEY_<PROVIDER>` > `MEMGLOW_ASSISTANT_API_KEY` > the page's file >
`assistant-api-key`. Changing the address of a provider that has a key needs the same conditions
as typing one (this computer, or password + HTTPS).

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

**Tidy** (hub and spoke). Detection is pure and conservative: a note counts as part of a summary
only when it says so (`part_of:` in its frontmatter — memglow's own splits write it — or a header
line such as *Split on … from [[summary]]*, *Part of … [[summary]]*, *Up: [[summary]]*), or when
the structure leaves no doubt (same folder, linked both ways, cited by nobody else). Notes that
merely link to each other are never treated as parts. Index lines that point to a part, pure
"Siblings:" lines and missing links back are fixed without the AI; only ambiguous links inside a
sentence are sent to it, and it may only answer keep or remove for each — memglow then removes
just that `[[link]]`, nothing else. Never deletes a note. Same diff, backup and Undo as a split.

With **basic-memory**, memglow writes the Markdown files directly; basic-memory re-indexes changed
files on its own (its sync watches the folder). New notes have no `permalink` until basic-memory
adds one.

<a id="archive"></a>
## 🗄️ Archive tier

Parts of notes nobody has used for months still cost tokens every time their note is read. The
archive tier moves those **sections** (not only whole notes) out of the live memory, into an
archive note of the **same theme**, and keeps a compact **archive summary** — one line per archived
section. Retrieval order for the assistant: **the live memory first**; the archive summary only
when nothing was found there; then the archived section itself. **Nothing is ever lost**: each
section is moved word for word, and its note keeps a one-line link to it.

**Which sections are "dormant"** (Memory cost → *Archive* block, read only). A section S of note N
is listed when all of this holds:

1. **Enough history**: activity counting started at least `archiveAfterDays` days ago (default
   **105**, about 3.5 months). Before that, the block says *Not enough data yet since <day>* and
   when it will start.
2. N was **not read** during those days, and **did not appear in search results** (activity
   counters, per note).
3. S was **not edited** during those days: checked **per section** once memglow's section log
   (`section-ages.json` in its data folder: a hash and a first-seen day per section, never text)
   covers the whole window; until then, **per note** (no write counted, and the note's body
   unchanged on disk since the cutoff).
4. S is a heading section (the note's top heading level, sub-sections included) of at least
   `archive.minSectionTokens` (100) tokens — never the text before the first heading, an index
   note, a note without a theme, or a note already in the archive folder. At most
   `archive.maxSuggestions` (20) are listed, biggest first.

**Honest limits.** The counters only see **whole-note** reads and searches: a hook or the MCP proxy
reports "note X was read", never which part. So reads and searches are judged per note — a note
read once in the window keeps all its sections live — and only *edits* can be judged per section.
A read nobody reported (an assistant without hooks, you in an editor) is invisible to memglow.
After an archive, the note counts as written, so with the per-note check its other sections wait
another full window. The figures are estimates (≈ bytes ÷ 4).

**The move** — for each chosen section:

- the section goes, **verbatim**, to `archive/<theme>-archive.md` (created with `theme: <theme>`,
  `subtheme: archive`, `memglow_archive: true`), right after a marker line
  `<!-- memglow:archived from="<note>" date="YYYY-MM-DD" -->`; an existing archive note is only
  appended to;
- the original note keeps one line in its place, e.g.
  `Archived: Old plan → [[projects-archive#Old plan]] (2026-10-01)`; nothing else in it changes,
  frontmatter included;
- `archive/archive-summary.md` (`memglow_archive_summary: true`) is rebuilt from every archive
  note, one line each, newest first:
  `- 2026-10-01 · Old plan · from [[old-project]] → [[projects-archive#Old plan]] · ≈ 420 tokens`.
  About 25-30 tokens per line: small by construction (the panel shows its size).

**Three ways to do it**, from the *Archive* block (tick the sections you want):

- **Copy prompt for your AI** — always there: a ready-to-paste prompt asking your assistant to do
  the move with its own memory tool, in exactly this format, showing you the plan first.
- **Prepare without AI** (assistant on) — memglow builds the move itself. A verbatim move needs no
  judgement, so this is the safest path.
- **Do it with <provider>** (assistant on) — the AI **only reviews the list** (titles, sizes, last
  read day, a few lines of each section, secret-looking lines masked) and answers which sections to
  archive and which to keep live, with a reason. memglow then builds the move itself: the AI never
  writes any file content.

Either way it goes through the [assistant](#assistant)'s safeguards: memglow checks the plan —
**nothing lost** (each original note rebuilds exactly from the note and its archived sections;
each section is in its archive note once, word for word), **same theme** (every archive note has
the theme of the notes it receives; no `theme`/`subtheme` of an existing note changes), **no
overwrite** (a file memglow did not make is never touched; a new file never replaces one), **valid
links** (every `[[…#…]]` names an existing note and heading) — shows the exact diff, and writes
only after *Apply this plan* (one-time server token), after a backup, with **Undo**. The check
runs again right before writing.

For the assistant: `memglow-mcp` has a read-only [`archive_lookup`](#mcp-server) tool, and the
MCP proxy an optional [archive hint](#mcp-proxy) (lever 6, off by default). Search engines that
index your notes folder (basic-memory…) still index the archive notes: archived text stays
findable, it just stops costing tokens when its original note is read.

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
| | Language | interface language — see [Languages](#languages) below |
| Motion | Spread, Gravity | size of the graph, pull towards each theme |
| | Minimum spacing | gap kept between bubbles; wins over gravity |
| | Signal speed | how fast comets run along the links (default 1.8 s per link) |
| | Auto-rotate, Follow activity, Dragged bubbles stay put | camera and dragging |
| Forces | Repulsion | 0.3× to 3×; multiplies how strongly every bubble pushes every other one away |
| | Link force | 0.2× to 3×; multiplies the tension of every link, on top of Gravity (which only tunes the sub-theme threads) |
| | Link distance | 0.3× to 3×; multiplies the resting length of links alone, independently of Spread (which changes repulsion and distance together) |
| | Reset forces | puts Repulsion, Link force and Link distance back to 1× (today's look); Spread/Gravity/Minimum spacing and the current layout are untouched |
| Links | Links at rest | hidden, subtle or visible; comets light the way anyway |
| | Link opacity | 0× to 3×; intensifies whichever "Links at rest" level is chosen, it is not a fourth level |
| | Ambient flow | slow comets at rest |

Drag a bubble to move it, double-click it to release it; double-click the background to go
back to the overview. **Rearrange** starts again from a fresh layout (your settings stay). A note
added later appears next to its sub-theme bubble, without shaking the saved layout. With
*reduced motion* on, a saved layout is restored without animation.

**On a phone** (under 640 px wide, or a phone held sideways), the controls stop covering the
graph: the legend folds behind a **Themes** chip (folded the first time; your choice is then
remembered in this browser), *Find a note* behind a magnifier, and **Settings** behind a gear that
opens a bottom sheet — close it with *Close settings*, a tap on the dimmed background, a swipe down
on its handle, or Escape; the focus goes back to the gear. The activity journal shows each entry
on two lines (action · group, then **note** · source), Memory cost names wrap instead of being
cut, and the Assistant, Protected groups and Archive blocks get full-width rows and larger
buttons. Nothing changes on a larger screen.

<a id="languages"></a>
## 🌐 Languages

The interface ships in English (reference), French, German, Spanish, Brazilian Portuguese,
Japanese, Korean and Simplified Chinese. It picks your browser's language on first visit
(`navigator.languages`, falling back to English for anything else), and you can override it any
time with **Settings → Language** — the choice is saved with the rest of your view, like every
other setting, so it follows you to any browser or device that opens the same memglow instance.
Product names (Claude Code, Codex, Cursor, Ollama…) and the word "token" are never translated, by
design. Prompts memglow builds for your AI (the *Copy prompt for your AI* text, and what the
optional assistant sends) always stay in English, whatever the interface language — the AI reads
them, not you.

Numbers and dates follow the interface language too (`Intl`, with the language you chose, not the
browser's locale): "≈ 1 234 tokens" and "30 sept." in French, "1.234" and "30. Sept." in German,
"9月30日" in Japanese. The two exceptions keep fixed English formats on purpose: the prompts for
your AI, and the lines memglow writes into the archive summary (an ISO day and "≈ 1,234 tokens",
read back by memglow itself).

Zero runtime dependency, no build step: each language is one JSON file in `public/i18n/`, loaded
by the small `public/i18n.js` on demand. **To add a language**:

1. Copy `public/i18n/en.json` to `public/i18n/<code>.json` (a code like `it`, or `pt-PT`) and
   translate every value — technical, sober tone; keep every `{placeholder}` exactly as in the
   English file; a key that needs a plural keeps the `{ "one": "…", "other": "…" }` shape
   (a language without grammatical plural, like Japanese here, may give one plain string instead).
   Set `_meta.name` (English name) and `_meta.autonym` (the language's own name for itself, shown
   in the language picker).
2. Add the code to `SUPPORTED_LANGS` in `public/i18n.js`, to `SETTINGS.language.values` in
   `lib/view.js`, to `I18N_LANGS` in `server.js`, and as an `<option>` in the Language `<select>`
   of `public/index.html`.
3. Add the same code to `LANGS` at the top of `test/i18n.test.js`, then `npm test` — it checks
   that the new file has exactly the same keys as `en.json` (none missing, none extra) and the
   same `{placeholders}`, and that the server actually serves it.

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
4. proposes to put the [MCP proxy](#mcp-proxy) in front of Claude Desktop's memory servers;
5. proposes to add memglow's [built-in memory rules](#memory-rules) to the instruction file of
   each tool installed above that does not go through the MCP proxy (`CLAUDE.md`, `AGENTS.md`,
   `GEMINI.md`, …), in a replaceable block — default yes when interactive;
6. asks the **same questions as the page's [first run](#first-run)**: which AI tools you use
   (several are fine; the detected ones are proposed), whether to turn the optional assistant on,
   and with which provider(s) and model. An API key can be typed there **without echo** (it goes to
   `~/.memglow/assistant-api-key-<provider>`, mode 600) — or skipped, to set the variable or use
   the page later. `--yes` asks nothing and keeps the previous behaviour.

| Option | Meaning |
|---|---|
| `--yes`, `-y` | accept every proposal (non-interactive) |
| `--dir <folder>` | notes folder |
| `--port <n>` | viewer port (default `4747`) |
| `--agents <list>` | `claude-code,codex,gemini,cursor,windsurf,copilot,cline`, `all` (default: every detected tool) or `none` |
| `--wrap-mcp` | with `--yes`: also wrap Claude Desktop's memory MCP servers |
| `--write-rules` | with `--yes`: also add the [built-in memory rules](#memory-rules) to CLAUDE.md/AGENTS.md/GEMINI.md/… (interactive: asked, default yes, regardless of this flag) |
| `--clients <list>` | the AI tools you use (`claude-code,codex,gemini,cursor,windsurf,copilot,cline,chatgpt,other-mcp` or `none`), without asking |
| `--docker` | also write `~/.memglow/docker-compose.yml` and `.env` — with your first-run choices as variables, and the key lines **commented out** (no key is ever asked or written for Docker) |

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
there — `hook`, `mcp-proxy`, `file` or `api`; an event without them shows exactly as before).
`durationMs` (optional, v0.4, sent by the MCP proxy) is the memory server's response time for
that call, used by *Memory engine speed*; a value that is not a number from 0 to 600,000 is
ignored. Full
reference with Python and Node examples: [docs/api.md](docs/api.md).

<a id="mcp-proxy"></a>
## 🔌 MCP proxy

For MCP clients without hooks (Claude Desktop, Continue, Roo Code…), put the proxy in front of
the memory server. It reports note names only, and relays the server's answers — with, if you
want, a few levers that make the assistant find faster and read less. It also delivers
memglow's [built-in memory rules](#memory-rules) to the wrapped server's `initialize`
`instructions`, on by default, independently of every lever below.

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
server's own content; 4, 5 and 8 may replace a read answer, so they are off by default; 9
(`multiQuery`) replaces a search call's one request/response pair with several upstream calls
merged into one, so it is its own case (see below). `searchDetails` and `suggestions` (2 and 3)
were on by default through 0.4.2.1b; measured with the free replay harness
([bench/README.md](bench/README.md)) and against a real 2-day usage log, they only added
delivered tokens without a measurable upside, so stage 0.4.2.2 turned them off by default too
(shortened either way, for whoever turns them back on). `sizeWarning` and `multiQuery` are the
two levers on by default: the first is a single short line, once per large note per session,
that plausibly prevents a wasted call; the second genuinely removes both calls and tokens on a
real usage log (stage 0.4.2.2b — [bench/README.md](bench/README.md)).

| # | Lever (`proxy` key / variable) | Default | Effect |
|---|---|---|---|
| 1 | `sizeWarning` / `MEMGLOW_PROXY_SIZE_WARNING` | on | `⚠ memglow: this note is ≈N tokens (threshold T)…` before a large note, or after a write that makes it large — suggests a split within the same theme. Once per note and session. |
| 2 | `searchDetails` / `MEMGLOW_PROXY_SEARCH_DETAILS` | off | After search results: title · theme · ≈tokens · description of each note found — description shown once per note per session, and no line at all for a note already read in full this session. |
| 3 | `suggestions` / `MEMGLOW_PROXY_SUGGESTIONS` | off | After a read: up to 3-5 related notes (links, sub-theme, co-usage), names and sizes only — once per note per session. |
| 4 | `dedupe` / `MEMGLOW_PROXY_DEDUPE` | off | An unchanged note re-read in the same session → a short "unchanged, ≈N tokens saved" notice. |
| 5 | `toc` / `MEMGLOW_PROXY_TOC` | off | A large note → its outline with ≈tokens per section first; then one section on demand. |
| 6 | `archiveHint` / `MEMGLOW_PROXY_ARCHIVE_HINT` | off | A search that finds nothing in the live memory (no result, or only [archive](#archive) notes) → `memglow: nothing found in the live memory — the archive summary lists: …` with the **titles** of the archived sections that match the query (never their text). |
| 7 | `hideUnsupportedTools` / `MEMGLOW_PROXY_HIDE_UNSUPPORTED` | off | Hides, from `tools/list` and **per client session**, the tools a config table marks unsupported for that client — default: basic-memory's `search`/`fetch` (its ChatGPT-only adapters) hidden from any client that is not OpenAI's MCP client. A client that calls a hidden tool anyway is relayed unchanged; one unrecognised client is never filtered. |
| 8 | `alreadyLoaded` / `MEMGLOW_PROXY_ALREADY_LOADED` | off | A read of a note memglow knows is **already loaded into the assistant's context at the start of every session** (the index note(s), or an `alwaysLoaded` entry that resolves to a note) → `memglow: "…" is already in your context — … has not changed since this session began (sha …)`, instead of its content, for as long as it stays unchanged. Off by default: memglow cannot know whether your setup truly re-injects the index at session start (a `SessionStart` hook, a `CLAUDE.md` import…) — turn it on only when it does; `memglow init` does not install such an injection on its own. |
| 9 | `multiQuery` / `MEMGLOW_PROXY_MULTI_QUERY` | on | A search call carrying `memglow_queries` (2-4 extra phrasings, advertised in `tools/list`) is sent upstream as ONE call per phrasing, sequentially, the original first — instead of a separate model turn per phrasing. Hits merged, deduped by note id (found by more phrasings ranks higher), capped to one call's usual result count, returned as ONE result (the server's own hit blocks when safe, else a compact listing); any later phrasing's failed call fails the whole thing open to the first phrasing's own result. |
| 10 | `aliases` + `learnAliases` / `MEMGLOW_PROXY_ALIASES` + `MEMGLOW_PROXY_LEARN_ALIASES` | **on** (since 0.4.2.5) | `learnAliases` (recording): a search followed within 2 minutes by a single-note read of a note NOT in its results teaches that search's significant words as aliases of it, locally, nothing ever sent anywhere. `aliases` (using it): a LATER search sharing ≥ 2 learned aliases of a note (or 1 seen ≥ 2 times) gets that note added at the top, in the upstream's own row shape when safe. Independent switches. On by default since the harness learned to count a dropped retry call, not just raw tokens (0.4.2.5) — see that stage below. |
| 11 | `negativeCache` / `MEMGLOW_PROXY_NEGATIVE_CACHE` | off | A search not followed by any read within 2 minutes in the same session (or superseded by another search/write first) is remembered, locally, as "futile" for the memory's current state. A LATER search with the same significant words, while nothing has changed since, gets one line prepended: `memglow: this search found nothing you used last time (<date>); the memory has not changed since.` The results themselves are always still relayed right after — never hidden. Off by default: a clear win on its own dedicated fixture (a dropped retry call), but a real, unmodelled cost on `bench/replay-heavy.jsonl` (a naturally recurring search gets the hint with no call saved there) — see 0.4.2.6 below. |
| 12 | `indexHint` / `MEMGLOW_PROXY_INDEX_HINT` | off | A search whose own results are ONLY the index note, or a read of the index itself while `alreadyLoaded` is off, gets a short suffix: `memglow: the index already says:` followed by up to 3 lines of the index's own text (secret-masked) that mention one of the query's significant words. Off by default: it only ever adds a line, same bucket as `searchDetails`/`suggestions`/`archiveHint`. |
| 13 | `deltaRead` / `MEMGLOW_PROXY_DELTA_READ` | off | The hottest notes get re-read in every new session — `dedupe` cannot help there (a new session's context is empty). Two mechanisms: cross-session, the first read of a note in a session is always full, plus one header when it changed since this SAME client's own last read, in an earlier session (`memglow: changed since your last read on <date> — sections changed: …`), remembered in a small per-client ledger (`delta-read.json`); within-session, a note re-read after it changed THIS session gets ONLY the diff since its first read, falling back to the full text past a 60% size ratio. Off for now: a clean sweep on hand-built replay files, but not yet checked against a real usage log the way `multiQuery`/`aliases` were — see 0.4.3 in `bench/README.md`/`mcp-proxy/README.md`. |
| 14 | `duplicateHint` / `MEMGLOW_PROXY_DUPLICATE_HINT` | off | After a `write_note` (never `edit_note`/`move_note`) whose title already names an existing note: `memglow: a note with this title already exists: [[<id>]] — this write_note may replace or duplicate it; prefer edit_note.` A title close to (but not matching) an existing note's id/label/description gets up to 2 candidates instead, with the same "prefer edit_note" suggestion. Checked before the write reaches the server, so the note being created is never mistaken for its own duplicate; same note never hinted twice per session. Advisory only — never blocks the write, never changes its arguments. Off by default: a pure, unconditional add, same bucket as `searchDetails`/`suggestions`/`archiveHint`/`indexHint` — see 0.4.4.1 below. |
| — | `indexWarning` / `MEMGLOW_PROXY_INDEX_WARNING` | off | The **index** note read while above `indexWarningTokens` (default 2,000): `⚠ memglow: the index note … is loaded at every session` — suggests trimming it. Once per session. |

Levers 4, 5 and 8 change what the assistant receives: **measure answer quality before enabling
them**. Adding `"memglow_fresh": true` always brings the full note back; for 4 and 5, repeating
the same read works too (lever 8 keeps stubbing a still-unchanged, still-already-loaded note on
every read, so only `memglow_fresh` escapes it). Configuration (`memglow.config.json` →
`"proxy": {…}`), examples and the exact rules:
[mcp-proxy/README.md](mcp-proxy/README.md#token-saving-and-speed-levers-v04).

<a id="mcp-server"></a>
## 🧠 MCP server (read-only)

A second, separate MCP server — not the proxy above — that lets your assistant **ask memglow
questions about its own memory**, instead of only being watched by it: which notes are too
large, what to read first about a topic, what something costs to read. It starts entirely on its
own (no viewer, no network, nothing else to run first) and never writes anything — not the
notes, not even memglow's own counters. Like the proxy, it adds memglow's
[built-in memory rules](#memory-rules) to its own `initialize` `instructions`, and offers them
again as an MCP prompt named `memory-hygiene` (`prompts/list` / `prompts/get`).

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
| `archive_lookup` | `query`, `limit` | For when a search of the live memory found nothing: the [archived sections](#archive) whose topic or original note matches, read from the archive summary — title, original note, archive note, `[[link]]`, date, ≈tokens. Never the archived text. |
| `index_trim_plan` | `maxChars` | Which index lines could be shortened deterministically (same rule as Memory cost → Always loaded → **Trim the index**) and the tokens that would save per session, plus a "skipped" list with why a line was left as is. The plan only — it writes nothing; the assistant's own `indexTrim` proposal is what actually applies it. |
| `maintenance_proposals` | *(none)* | The same scheduled **Maintenance** list the viewer shows — dormant sections, over-threshold notes, an index-trim opportunity, ranked by estimated token gain — computed fresh and read-only on every call (never a cache file, never a counter touched). Applying one still goes through the normal assistant pipeline, not this tool. |

No write tool, and no tool ever returns a full note body: only ids, titles, token estimates,
frontmatter descriptions and section headings — masked for secret-looking lines like everywhere
else in memglow.

<a id="memory-server"></a>
## 🗃️ memglow memory server (preview)

A third, separate piece, still a **preview** (internal stage 0.4.5.2): memglow as the memory
server **itself** — a fast, file-based MCP memory server, tool-compatible with basic-memory's
own tools: same tool names, same arguments, compatible text output (`# Search Results` blocks
with `- permalink:` lines, `# Context:`, `## Recent Activity:` …), so existing clients, hooks
and the [MCP proxy](#mcp-proxy) in front of it keep working unchanged. Your Markdown files stay
the source of truth throughout — this server reads and writes the same notes folder basic-memory
does, in the same layout, nothing in a database. Notes are indexed in memory and refreshed on
every file change (`fs.watch` plus a cheap rescan every 3 s), searches are lexical (BM25-style;
accents folded, English + French stop-words, title boost, `"phrases"`, `AND`/`OR`/`NOT`/`-word`,
`prefix*`, `tag:x`) and answer in milliseconds, many requests at once. Zero dependencies.

**Quick start — try it as a shadow first, enable writes only once you trust it:**

```bash
memglow memory-server --root ~/knowledge --listen 127.0.0.1:8000   # Streamable HTTP on /mcp, read-only
memglow memory-server --root ~/knowledge --stdio                    # or stdio
memglow memory-server --root ~/knowledge --listen 127.0.0.1:8000 --read-write \
  --on-write 'node ~/bin/snapshot-notes.js'                         # writes on, git snapshot after them
# also: node memory-server/memglow-memory-server.js … / npx memglow-memory-server …
```

1. Point it at a **read-only copy** of your notes folder (or the real one — it never writes
   without `--read-write`) and run it alongside basic-memory, unused by any client yet: a
   **shadow deployment**. `--read-only` makes the read-only default explicit and always wins
   over `--read-write` if both are given.
2. **Compare it with basic-memory call by call** using `bench/compat.js` (latency, identical
   reads, search overlap, text shape — see below) before trusting it with real traffic.
3. **Switch the upstream**: point your hooks / the [MCP proxy](#mcp-proxy) at this server instead
   of basic-memory (`memglow-mcp-proxy --upstream http://127.0.0.1:8000/mcp`, or the stdio form
   in front of `memglow memory-server --stdio`) — reads only, still no `--read-write`.
4. Once you are comfortable, add `--read-write` to enable the write tools, and only then **stop
   basic-memory**.

**Safety flags**: `--read-only` / `--read-write` (writes are off unless `--read-write` or
`MEMGLOW_MEMORY_READ_WRITE=1` is given; `--read-only` always wins over either), `--token` /
`MEMGLOW_MEMORY_TOKEN` (requires `Authorization: Bearer …` on every request but `GET /healthz`),
`--allow-origin` (a browser-style `Origin` header is refused unless listed — MCP/CLI clients send
none and are accepted either way), `--on-write CMD` (a debounced hook run after writes, e.g. a
git snapshot), `--file-mode` (force the mode of files it writes, instead of keeping the existing
one), `--no-fsync` (skip the fsync in the atomic write, for very slow disks), `--kebab-filenames`
(write new notes as `kebab-case.md` instead of basic-memory's as-is title — useful since
memglow's own note index only resolves slugged file names).

**Measured — on the author's memory** (not a controlled benchmark; see `bench/compat.js` and
`bench/memory-server-speed.js` to measure your own): search median ≈22 ms vs ≈45 s for
basic-memory on the same notes folder; relevance (MRR) 0.283 vs 0.130 over 31 real
search→read pairs; reads byte-identical between the two servers. No claim beyond what was
measured this way — your own notes, query mix and hardware will differ.

- **Read tools**: `search_notes`, `read_note`, `read_content`, `view_note`,
  `build_context`, `recent_activity`, `list_directory`, `list_memory_projects`,
  `list_workspaces`, `search` / `fetch`, `basic_memory_diagnostics`. `schema_*`,
  `create_memory_project` and `delete_project` answer "not supported".
- **Write tools — only with `--read-write`** (or `MEMGLOW_MEMORY_READ_WRITE=1`; `--read-only`
  always wins). Without it they answer `memglow memory server: read-only (phase A / shadow mode)`.
  - `write_note` creates `<directory>/<title>.md` with the frontmatter laid out as
    basic-memory lays it out (`title`, `type`, `permalink`, the `metadata` keys, `tags`;
    same quoting and line folding), merges a frontmatter the content itself starts with, and
    refuses an existing note unless `overwrite=true` (`--overwrite-default` flips that default).
    Replacing keeps the note's other frontmatter keys and its permalink, and copies the previous
    version to `.trash/` first.
  - `edit_note`: `append`, `prepend` (after the frontmatter), `find_replace` (exactly
    `expected_replacements` occurrences, default 1, else nothing changes), `replace_section`
    (`replace_subsections`, default true), `insert_before_section`, `insert_after_section` (a
    missing or duplicated heading is an error); `metadata` merges frontmatter keys with any
    operation. Everything not changed stays byte-for-byte (CRLF and BOM included).
    `append`/`prepend` on a missing note create it.
  - `move_note` (a note or, with `is_directory`, a folder) never replaces an existing file; the
    permalink is kept (`--update-permalinks-on-move` makes it follow the new path).
  - `edit_note`, `move_note` and `delete_note` refuse an identifier that only matches by title or
    file name and fits several notes (use the permalink). A frontmatter change is read back before
    it is written: if any key would not read back as intended, nothing is written.
  - `delete_note` **never deletes**: files move to `<root>/.trash/<timestamp>/<same path>`, a
    dot-folder nothing indexes, searches or serves. Restore = move the file back; empty the trash
    by hand.
  - Answers keep basic-memory's shape (`# Created note` / `# Updated note` / `# Edited note (op)`
    with `project:`, `file_path:`, `permalink:`, `checksum:` lines; `true`/`false` for one
    delete), so the proxy's levers keep working.
- **Write safety**: one global write queue (writes run one at a time, in order — no lost update;
  reads never wait); every path must stay inside the root's real path (no `..`, no dot-folders,
  no symlink leading out); atomic replace (temporary dot-file in the same folder, fsync, rename,
  folder fsync — a crash leaves the old file; `--no-fsync` for very slow disks); a file changed
  on disk during an edit is re-read and the edit redone; a new note never replaces a file that
  appeared meanwhile; the index is updated by the write itself (the next read sees it, the watcher
  re-reads nothing). Files keep their mode (`--file-mode 0664` to force one); running as root,
  new files and folders take the owner of the folder they are created in (a container running as
  root keeps the share's owner, e.g. 1045:100 on a Synology). Names differing only by Unicode normalisation (NFD
  from a Mac over SMB) reuse the existing folder or file instead of creating a twin.
- **File names**: the title as is, like basic-memory (`--kebab-filenames` for kebab-case). memglow's
  own note index (viewer, proxy levers) only knows notes whose file name is a slug, so with
  free-form titles prefer `--kebab-filenames`.
- **Run it as the notes folder's owner** (1045:100 on the NAS) **or as root**: a write replaces the
  file, so a server running as another user makes every note it touches its own (it warns at
  startup). As root, new files get the folder's owner, and group-write when the folder has it.
- Startup removes temp files an interrupted write left (`.mg-<hex>.tmp`) and reports notes present
  under two paths (an interrupted move) in `basic_memory_diagnostics`.
- **`--on-write CMD`**: a shell command run in the notes folder after writes, debounced (10 s of
  quiet by default, `--on-write-delay-ms`, never less; at most 60 s after the first pending
  write), never blocking a write, never two at once; `MEMGLOW_CHANGED_FILES` lists the changed
  paths (one per line). Meant for a snapshot, e.g. a script that `git add -A && git commit`s the
  notes folder.
- **One project** (`--project`, default `main`): permalinks are the frontmatter `permalink:` when
  present, else `<project>/<path>`; `project` / `project_id` / `workspace` arguments are accepted
  and ignored.
- **Semantic search is not implemented**: `search_type` `vector` / `semantic` / `hybrid` run the
  same lexical engine.
- **HTTP**: legacy sessions (`initialize` → `Mcp-Session-Id`) and the MCP 2026-07-28
  per-request mode (no session, `MCP-Protocol-Version` header and/or `params._meta`) both work;
  JSON answers, or one SSE event for a client that only accepts `text/event-stream`.
- **Security**: a request carrying an `Origin` header (a browser page — DNS rebinding) is
  refused unless listed with `--allow-origin` (default: none; MCP and CLI clients send no
  Origin and are accepted). `--token` (better: env `MEMGLOW_MEMORY_TOKEN`) requires
  `Authorization: Bearer …` on every request but `GET /healthz`. Only regular files whose real
  path stays inside `--root` are indexed or read: symlinks leaving it, dot-files/dot-folders
  (`.git/…`) and special files are refused.
- `bench/compat.js` compares it with another server call by call (latency, identical reads,
  search overlap, text shape); `bench/memory-server-speed.js` measures it on a notes folder.

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
| `MEMGLOW_INDEX_TRIM_MAX_CHARS` / `indexTrimMaxChars` | `90` | **Trim the index**: an index line's hook longer than this many characters is a candidate for deterministic shortening (30-1000) |
| `MEMGLOW_MAINTENANCE_EVERY_HOURS` / `maintenanceEveryHours` | `24` | **Maintenance**: how often the scheduled scan (archive/split/indexTrim) reruns; `0` turns off the repeat (the start-up scan still runs once) (0-8784) |
| `MEMGLOW_ARCHIVE_AFTER_DAYS` / `archiveAfterDays` (or `archive.afterDays`) | `105` | [archive tier](#archive): a section is dormant after this many days without a read, a search hit or an edit (7-3650) |
| `archive.folder`, `archive.summaryNote` | `archive`, `archive-summary` | where archive notes and the archive summary go (inside the notes folder) |
| `archive.maxSuggestions`, `archive.minSectionTokens` | `20`, `100` | at most this many dormant sections listed (biggest first); smaller sections are never suggested |
| `themes`, `themeByFolder`, `defaultTheme`, `subthemeLabels`, `title` | — | config file only |

<a id="docker"></a>
## 🐳 Docker

```bash
docker run -d --name memglow -p 127.0.0.1:4747:4747 \
  -v /path/to/notes:/memory:ro \
  -v memglow-data:/data \
  -e MEMGLOW_TOKEN=$(cat ~/.memglow/token) \
  ghcr.io/r0zumnik/memglow:0.4.5
```

`/data` keeps the Memory cost counts (note ids and numbers only) and the saved view (settings,
layout, camera) across restarts.

Or with Compose: copy [`docker-compose.example.yml`](docker-compose.example.yml), set `NOTES`,
then `docker compose up -d` — `memglow init --docker` writes one for you in `~/.memglow/`.

Images for amd64 and arm64 (Apple silicon, Raspberry Pi) are published on every release; pin a version with `ghcr.io/r0zumnik/memglow:0.4.5`.

The hooks and the MCP proxy run next to your AI tools, not in the container: point them at the
container with `MEMGLOW_URL` (default `http://127.0.0.1:4747`) and the same token.

<a id="first-run"></a>
### First run

The first time the page opens (npx or Docker alike — everything goes through the page), memglow
shows a three-step set-up. Every step can be skipped, and Settings → **First-run setup** runs it
again.

1. **Your AI tools** — tick every tool you use (Claude Code, Codex, Gemini CLI, Cursor, Windsurf,
   Copilot, Cline, ChatGPT, other MCP client); what `memglow init` detected is pre-ticked. For each
   ticked tool the page shows exactly how memglow sees it: the hook `memglow init` installed, the
   command to install it, or the MCP proxy command. **In Docker** it reminds you that hooks run next
   to the tool, on your computer, and need `MEMGLOW_URL` and `MEMGLOW_TOKEN`.
2. **Assistant (optional)** — off or on; one or several providers (Claude Code subscription,
   Anthropic API, OpenAI-compatible API with a preset, Ollama / LM Studio on this machine), each with
   its model, its address, its key, a **Test connection** button and where your notes would go.
3. **Your big themes** — the [protected groups](#protected-groups) screen.

The choices are saved in `/data/setup.json` (the data folder, mode 600). The variables below do
the same from the environment, and **an environment variable always wins over the page** (the page
then shows the field as "set by …"):

| Variable | Same as |
|---|---|
| `MEMGLOW_CLIENTS` | step 1, e.g. `claude-code,codex` (or `none`) |
| `MEMGLOW_ASSISTANT=1` / `0` | step 2, on / off |
| `MEMGLOW_ASSISTANT_PROVIDER`, `MEMGLOW_ASSISTANT_MODEL`, `MEMGLOW_ASSISTANT_PRESET`, `MEMGLOW_ASSISTANT_BASE_URL` | default provider and its model / preset / address |
| `MEMGLOW_ASSISTANT_API_KEY_ANTHROPIC`, `MEMGLOW_ASSISTANT_API_KEY_OPENAI_COMPATIBLE` (or the shared `MEMGLOW_ASSISTANT_API_KEY`) | the key fields |
| `CLAUDE_CODE_OAUTH_TOKEN` | the Claude Code subscription token |
| `MEMGLOW_TRUST_PROXY=1` | trust `X-Forwarded-Proto` from your HTTPS reverse proxy (see below) |

`memglow init --docker` writes your answers in `~/.memglow/.env` (mode 600) with the key lines
commented out; delete a line to hand that choice back to the page.

**Typing a key in the page** works only when the browser is on the same computer
(`http://127.0.0.1`, no proxy in between) **or** when memglow has a password
(`MEMGLOW_PASSWORD`) and the connection is HTTPS. With Docker's port mapping the container never
sees a loopback address, so put the key in `.env` instead — or, behind an HTTPS reverse proxy with
a password, set `MEMGLOW_TRUST_PROXY=1`. Otherwise the field is disabled and the page says why.

<a id="docker-claude-code"></a>
### Claude Code subscription in Docker

The image does not include the `claude` command (the page then says *Claude Code not available in
this container*). Build the variant that does:

```bash
docker build --build-arg CLAUDE_CODE=1 -t memglow:claude .
```

It installs Claude Code from npm **at build time** (about +230 MB; nothing is downloaded when the
container starts, and its auto-update is off). To sign in without a browser, run
`claude setup-token` on a computer where you are signed in to your Claude subscription, and pass
the printed token as `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (or type it in the page from
`http://127.0.0.1`). memglow gives it only to the `claude` process it starts.

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
- No failed request fails silently: a lost connection, a `401`/`403` or a server error shows a
  visible, translated banner with a "Reload" or "Retry" button instead. `MEMGLOW_PASSWORD` is
  stateless HTTP Basic auth — there is no session to expire — so a `401` always means "reload the
  page to be asked for credentials again", never a stale login.
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
