# Changelog

## 0.3.0 — 2026-10-01

Memory cost: see which notes cost your assistant the most tokens, and which ones to split.

### Added

- **Memory cost** panel, below the graph (`GET /api/cost`). Token estimates (≈ bytes ÷ 4, shown
  with "≈" everywhere — an estimate, not a promise of savings): tokens read today and over 7 days,
  tokens written over 7 days, size of the whole memory and of the index note, "N notes = X % of
  tokens read", the 10 notes that cost the most to read (click to open), notes above 5,000 tokens
  with their `##` sections and a deterministic split suggestion (consecutive sections, parts of
  about 2,000 tokens), and notes never read in 30 days (once 30 days of counts exist; before
  that, "Data since …").
- **Copy prompt for your AI** on each large or costly note: a ready-to-paste prompt (note,
  ≈ tokens, reads over 7 days, threshold, suggested parts) with rules that keep the memory
  consistent — same theme and folder, top-level themes unchanged, `theme`/`subtheme` frontmatter
  kept, `[[links]]` kept valid, the original becomes a short summary or goes away, only the
  agent's memory tool is used, and the plan is shown before anything is written.
- Activity counts per day, per note and per type (read / search / write) in memglow's own data
  folder (`MEMGLOW_DATA_DIR`, default `~/.memglow`, `/data` in the Docker image): note ids and
  numbers only, 90 days kept. Activity sent with `"demo": true` is not counted.
- New settings: **Size by** (links / token cost), **Bubble size** (0.5× to 3×), **Background**
  (Deep, Plain, Night blue), **Signal speed**, **Name distance**.
- Config: `largeNoteTokens` (or `MEMGLOW_LARGE_NOTE_TOKENS`), `splitChunkTokens`, `dataDir`.
- Token estimate in the note tooltip and the note panel.
- Demo: a long fictional incident log to show the split suggestion; `demo/simulate.js --counted`
  fills Memory cost.
- **View saved on the instance** (`GET`/`PUT /api/view`): settings, bubble layout (positions,
  pinned bubbles) and camera, in `view.json` in memglow's data folder (`/data` in Docker). One
  view per instance: every browser and device that opens it gets the same view. The page reads
  it before building the graph (falls back to its `localStorage` copy if the server does not
  answer within 2.5 s), restores the camera without animation, puts new notes next to their
  sub-theme bubble, and saves in groups (settings after 0.5 s, layout and camera after 2 s, a
  last save when the page is closed). Reduced motion is respected.
- **Rearrange** button in Settings: a fresh layout, settings kept.

### Changed — journal and counts

- Journal lines read **action · group · note · source** — *Write · Projects · Release notes ·
  Claude Code* — with the group (top-level theme) as a small tag tinted with its colour; the dot
  keeps the action's colour. Same for *Note changed / New note / Note removed* (source *File*).
  Known tools get their product name (Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf,
  Cline, MCP).
- Memory cost counts are **dynamic and de-duplicated**: a note whose body changes on disk counts
  as a write even without a hook (an assistant without hooks, an edit by hand); a hook reporting
  the same write within 15 s is not counted twice, whichever comes first. Frontmatter-only
  changes and moved files are not writes. The panel refreshes about 1.5 s after an activity or a
  note change (bursts grouped); the server recomputes only when counts or notes changed.
- *Copy prompt for your AI*: the group is spelled out, the split is given as K numbered parts,
  a costly note under the size threshold is described as such (not as "too large"), and a
  partial first week says "counted since …".

### Changed — visual polish

- The signal, not the link: while a comet runs along a link the link stays dark; only the comet
  lights the way (bigger, brighter head, additive trail), then a trace fades out. Comets are a bit
  slower by default (1.8 s per link, see *Signal speed*).
- Deep background by default: radial gradient, vignette and faint fixed star dust, all below the
  glow threshold (no washed-out background).
- Bubbles keep a minimum size on screen, so they stay visible when zoomed out.
- The index note is the "sun" of the graph: larger, warm white, with a soft corona.
- Double-click on the empty background goes back to the overview.
- "Links at rest: Hidden" now hides everything, including the threads to sub-theme bubbles.

### Fixed

- Clicking a sub-theme bubble now lights its notes (it lit none).
- memglow writes nothing if its data folder is set inside the notes folder (counts and view are
  then kept in memory only, with a warning).
- **Spacing**: "Minimum spacing" had almost no effect at the default spread. It is now relative
  to the spread and the collision is firmer, so spacing wins over gravity.
- Hidden themes (legend) were dropped on reload with custom themes.
- A masked secret-looking heading now stays a heading, so a note keeps its sections.
- Release workflow: GitHub Actions moved to their Node 24 majors.

### Security

- **DNS-rebinding guard.** Without `MEMGLOW_PASSWORD`, only requests addressed to `localhost`,
  `127.0.0.1`, `[::1]` or a name listed in the new `MEMGLOW_ALLOWED_HOSTS` are served; any other
  host name gets a `403` with instructions. Before, a malicious page could re-point its domain to
  127.0.0.1 and read the viewer (note bodies included) from a visitor's browser. Hooks are not
  affected (`/api/activity` is checked by its token first). If you open memglow by a LAN name
  without a password, add that name to `MEMGLOW_ALLOWED_HOSTS` (or set a password).
- `/api/view` follows the page's access rule (`MEMGLOW_PASSWORD`). Writes need memglow's own
  `X-Memglow` header and a same-host `Origin` (else `403`), are capped at 256 KB (`413`), rate
  limited (`429`), and strictly validated: a closed list of settings with types and bounds,
  finite bounded coordinates for existing notes and sub-theme bubbles only (2,000 at most),
  pinned ⊆ positions, bounded camera; everything else — `__proto__` included — is dropped.
  Written atomically (mode 600) in the data folder, never in the notes folder.

## 0.2.1 — 2026-09-30

Published on npm (`npx memglow`) and as a Docker image (`ghcr.io/r0zumnik/memglow`, amd64 + arm64).

## 0.2.0 — 2026-09-30

Not only Claude Code any more.

### Added

- **Adapters for seven AI tools**, each on its vendor's documented hook mechanism: Claude Code
  (`PostToolUse`), OpenAI Codex CLI (`PostToolUse`, `apply_patch` paths), Gemini CLI
  (`AfterTool`), Cursor (`beforeReadFile`, `afterFileEdit`, `afterMCPExecution`), Windsurf /
  Devin Desktop (Cascade `post_read_code`, `post_write_code`, `post_mcp_tool_use`), GitHub
  Copilot CLI (`postToolUse`) and Cline (`PostToolUse` script). One shared core
  (`lib/agent-core.js`): note names only, detached sender, 3 s timeout, silent, always exit 0,
  and the exact stdout each tool expects (`{}` for Gemini, `{"permission":"allow"}` for Cursor's
  read hook, `{"cancel":false}` for Cline).
- **MCP proxy** (`memglow-mcp-proxy`) for any MCP client, including those without hooks
  (Claude Desktop, Continue, Roo Code…): stdio and streamable HTTP, relays bytes unchanged,
  reports successful `tools/call` as read / search / write, mapping overridable with
  `MEMGLOW_PROXY_MAP`.
- **Installer**: `memglow init` finds the notes folder (basic-memory, Obsidian or `--dir`), writes
  a config and a random token to `~/.memglow`, detects installed AI tools and adds their hooks
  (backup first, existing entries kept, unparsable files left untouched), optionally wraps Claude
  Desktop's memory MCP servers, optionally writes a Docker Compose file. Interactive, or `--yes`.
  `memglow uninstall` removes exactly what it added (`--restore-backups`, `--purge`).
- `bin/memglow.js` (`memglow`, `memglow init`, `memglow uninstall`), usable today with
  `npx github:R0zumnik/memglow`; the server falls back to `~/.memglow` when nothing else is
  configured.
- `docs/api.md`: the activity API for any agent or script, with curl, Python and Node examples.
- `docker-compose.example.yml` and Docker instructions for `ghcr.io/r0zumnik/memglow` (image not
  published yet; local `docker build` documented).
- README "Works with" table and a matching section on the project page.
- Tests for every adapter (realistic payloads and the real hook scripts against a fake
  receiver), the installer (fake home, backup, idempotence, uninstall, restore) and the proxy
  (fake stdio and HTTP upstreams, faithful relay, errors, exit codes).

### Fixed

- README menu links: headings start with an emoji, so GitHub's generated anchors did not match
  the links (`#-quick-start`, and worse for `⚙️`). Every targeted heading now has an explicit
  `<a id="…">` anchor, and every internal link has been checked.
- The Features table no longer shows an empty header row on GitHub (`| Feature | What it does |`);
  the other tables got real headers too.

## 0.1.0 — unreleased

First version.

- Live 3D graph of a folder of Markdown notes: `[[wikilinks]]` as links, themes and sub-themes
  from frontmatter or folders, glow by recency.
- Live changes by polling (works on network volumes); a note only "changes" when its body does.
- Activity API (`POST /api/activity`, bearer token) and a ready-to-use Claude Code hook:
  reads, searches and writes light up the matching notes, with comets along the links and a
  camera that follows the action.
- Settings panel (spread, gravity, spacing, glow, names, links at rest, auto-rotate…),
  searchable notes, note panel with body (secret-looking lines masked).
- Optional HTTP Basic auth, zero runtime dependencies, Dockerfile.
