# Changelog

## 0.5.0 — 2026-10-12 (release candidate, not published)

Everything published since 0.4.6, for users. The internal stages below (0.4.7.1 through
0.4.12.4) have the full detail; this section only groups and names what changed.

### Memory server

- **All-in-one: one process, one container, one port** (0.4.8.1 below). `memglow memory-server
  --levers` applies the MCP proxy's levers, memory rules and activity reporting inside the
  memory server itself — no separate proxy container needed.
- **Write durability — `--fsync-mode sync|deferred|none`** (default `sync`, 0.4.10.1 below):
  `sync` never loses an acknowledged write, even to a power cut, at the cost of an fsync per
  write (can be a second or more on a busy disk); `deferred` answers right after the rename and
  fsyncs in the background — writes ≈50 ms instead of 2–4 s, at the cost of a short window where
  a crash can lose the very last write (see README → memglow memory server → Write durability
  for the filesystem caveat on XFS/`noauto_da_alloc`); `none` skips fsync entirely.
- **`--kebab-filenames`**: new notes get a `kebab-case.md` file name (accents transliterated)
  instead of the title as-is, so memglow's own note index (viewer, proxy levers) can resolve
  them — pairs with the `slugHint` lever below.
- **`--stop-timeout`**: the server waits for in-flight writes and pending fsyncs on shutdown, up
  to `--shutdown-timeout` seconds (default 25) — give the container at least that much grace
  period (`docker run --stop-timeout 30`, or `stop_grace_period: 30s` in compose).
- **Responsiveness** (0.4.10.x below): startup, search and read latency measurably improved —
  search ≈20–75 ms vs ≈45 s for basic-memory on the author's memory, writes ≈50 ms with
  `--fsync-mode deferred` vs 2–4 s, relevance (MRR) 0.28 vs 0.13 on 31 real search→read pairs
  (`bench/compat.js`, `bench/memory-server-speed.js`; not a controlled benchmark — measure your
  own notes).
- **Security fixes** (0.4.9.1 below): file mode of new notes tightened (`0660`, was effectively
  world-readable), `--serve-files` defaults to text/image only.

### MCP proxy & levers

- **Per-client accounting** (0.4.10.9 below): every `tools/call` is counted once, bucketed by
  client (MCP `clientInfo`, its `_meta` envelope, or the User-Agent), for the Memory cost panel's
  "By AI tool" line and Settings → Control's "Mesures".
- **Three new levers**: `duplicateHint` (14, a `write_note` whose title already names an existing
  note gets an advisory line, "prefer edit_note"), `slugHint` (15, a title that is not a kebab
  slug gets the slug `--kebab-filenames` would give it), `hubHint` (16, an append that keeps
  growing a hub note instead of one of its parts gets pointed at the right part). All three
  advisory only, off by default.
- **Search recall improved** (0.4.11.1 below): a real-usage duel (31 search→read pairs) went
  from MRR 0.130 (basic-memory) / 0.280 (memglow, before) to 0.283 after retuning prefix/fuzzy
  matching and adding a light "hub" field — see Memory server's own relevance figure above.

### Control panel

- **Settings → Control** (0.4.7.x below): every lever in one place — current value, where it
  comes from (environment variable, the page, the config file, or the built-in default), and
  whether an environment variable locks it; the day-one levers (`sizeWarning`, `multiQuery`,
  `aliases`, `learnAliases`, `indexWarning`) can be switched right from the page.

### Maintenance

- **Technical debt pass** (0.4.12.1–0.4.12.4 below), entirely behaviour-preserving: a note kept
  three overlapping copies of its own text in memory (`raw`, `body`, `lines`) — now only `raw`,
  with `body`/`lines` derived on access (≈10% less heap for the note store on a 300-note
  corpus, measured with `bench/heap-0412-1.js`); five copies of the same frontmatter-block
  splitter and three directory walkers reduced to one shared helper each, where their semantics
  really were the same (two are kept deliberately independent — see the 0.4.12.2 entry below for
  why); a dozen exports nothing outside their own file used were dropped (the functions stayed,
  only the pointless export went); `lib/proxy-levers.js` (≈2,460 lines) split into `lib/levers/`,
  one file per lever or small group of related levers, with `lib/proxy-levers.js` staying the
  public entry point — same `module.exports`, verified byte-for-byte.

### Fixes

- **UI fixes** (0.4.11.2 below): the activity journal no longer shows the redundant
  "MCP proxy · MCP" when the specific tool name is not known.

## 0.4.12.4 — internal (not published)

**Split `lib/proxy-levers.js` (~2,460 lines) into `lib/levers/`** — one file per lever, or per
small group of closely-related levers that share pure helpers (`config.js`, `control-panel.js`,
`note-index.js`, `accounting.js`, `responses.js`, `hidden-tools.js`, `multi-query.js`,
`aliases.js`, `index-hint.js`, `duplicate-hint.js`, `hub-hint.js`). `lib/proxy-levers.js` is now
the small core (≈1,040 lines): its own top comment, `createLevers()` (the per-session factory),
and the same `module.exports` object, byte-for-byte unchanged — every caller
(`require("../lib/proxy-levers")`: server.js, the MCP proxy, the all-in-one process,
`bench/replay.js`, every test) keeps working with no changes. Every lever module is required
eagerly rather than behind its own config flag: their pure functions (`planMultiQuery`,
`duplicateHintFor`, `hubHintFor`, …) are part of this module's public API regardless of which
levers are on — several tests and `bench/replay.js` call them directly with no live session or
config at all, so a flag-gated require would make an export disappear exactly when a caller is
testing the lever that happens to be off. Full suite: 760 pass, 0 fail.

## 0.4.12.3 — internal (not published)

**Dead exports removed.** An earlier audit listed candidates across `lib/archive.js`
(`stubLine`, `anchorable`, `archiveIdOf`, `summaryLine`, `entriesOfArchive`, `ARCHIVE_FLAG`,
`LOG_FILE`), `lib/agent-core.js` (`idsInArgs`), `lib/assistant/index.js` (`TOKEN_TTL`,
`PROPOSAL_TTL`), `lib/assistant/proposal.js` (`hideSecrets`), `lib/assistant/providers/http.js`
(`httpError`, `MAX_ANSWER_BYTES`) and `bin/memglow.js` (`askChoices`). Verified each by grepping
the whole repo, tests included, for every external `require()` of its file: none of them is ever
imported from outside its own file, though every one is still called from inside it — so the
functions/constants stay, only the now-pointless export is removed. Nothing here is part of a
documented API (CLI command or MCP tool). Full suite: 760 pass, 0 fail.

## 0.4.12.2 — internal (not published)

**One frontmatter splitter, one documented reason each walker stays separate.** Five files
(`lib/archive.js`, `lib/hub-spoke.js`, `lib/index-trim.js`, `lib/assistant/proposal.js`,
`lib/assistant/tidy.js`) each carried their own byte-for-byte identical
`splitFrontmatter(text) → { fm, body }` (fm including the fences, for exact reconstruction) plus
its own copy of the same regex. Four of them now use one shared helper,
`splitFrontmatterBlock()`, added to `lib/store/frontmatter.js` next to the full YAML-subset
`splitFrontmatter()`/`parseYaml()` it already exports — same shape, same regex, so behaviour is
byte-for-byte unchanged; each file's own `module.exports.splitFrontmatter` keeps working for its
external users. `lib/hub-spoke.js` keeps its own copy: its top-of-file comment already states it
"must stay import-free and independently testable" — zero dependency on the rest of memglow, by
design. `lib/memory.js`'s own frontmatter reader (six known flat keys, not full YAML) and its own
directory walker are also left alone, now with a comment explaining why: the module declares
itself "zero dependencies… see server.js" at the top of the file. Of the three walkers named in
an earlier audit (`lib/store/store.js`, `memory-server/writer.js`, `lib/memory.js`):
`memory-server/writer.js`'s `cleanupTemps()` already imports `SKIP_DIRS` from `store.js`; its own
walk is kept separate, now documented why (it visits every file looking for crash-temp names, not
just `*.md`, and is depth- rather than count-bounded). No YAML subset semantics changed anywhere.
Full suite: 760 pass, 0 fail.

## 0.4.12.1 — internal (not published)

**One copy of note text in memory.** A note object stored `raw`, `body` and `lines`
(`body.split`) at once — three overlapping copies of the same text, the third a real duplicate
(an array of per-line strings). Now a note keeps only `raw` + `bodyOffset`; `body` and `lines`
are derived on access, through a real class (`Note`, `lib/store/note.js`) with `body`/`lines` as
shared-prototype getters rather than `Object.defineProperty` per instance (tried first, and
measured WORSE — it de-optimises each note's hidden class/shape in V8, costing more than the
strings it removed; the class keeps one shared shape for every note). `lib/store/search.js`'s
`tokeniseBody()` now reads `note.lines` into a local once instead of re-deriving it on every loop
iteration. Measured with `bench/heap-0412-1.js` (300 synthetic notes, `--expose-gc`): heap used
to load the corpus, 6,316,192 B before → 5,653,760 B after (≈10% less, ≈18.8 KB/note vs
≈21.0 KB/note). Full suite: 760 pass, 0 fail (unchanged).

## 0.4.11.2 — internal (not published)

A pass over the r0zumnik "Memory" lab tab's recent UI work (Forces sliders, compact phone layout,
journal machine/channel, Light background, no-silent-fetch-errors) checked against memglow's own
viewer: all five were already ported into v0.4.0 and unchanged since — `lib/view.js` SETTINGS
bounds (0.3–3 / 0.2–3 / 0.3–3 / 0–3, no link curvature), `public/app.css`/`app.js` compact layout
(`setupSheet`/`setupLegendFold`/`setupSearchFold`), `formatJournalLine`, `FONDS.clair` and
`mgErrorBanner`, all already tested and documented (see `## 0.4.0` above). No regressions found.

### Fixed

- **Journal: no more "MCP proxy · MCP".** `source: "mcp"` is the generic placeholder every
  mcp-proxy/memory-server report falls back to when the specific MCP tool is not known to the
  caller; shown right after a channel label that already says "MCP proxy" or "memory server" it
  only repeated the same word (`"NAS · MCP proxy · MCP"`). `formatJournalLine` (`public/app.js`)
  now drops it in that one case only (`REDUNDANT_GENERIC_SOURCE`) — a real agent/CLI name, or, once
  a sender passes it, the specific tool (e.g. `"search_notes"`), is still shown exactly as before.
  New test in `test/view.test.js`.
## 0.4.11.1 — internal (not published)

Two independent pieces of work on `wB-search` (branch), both scoped to `lib/proxy-levers.js`,
`lib/store/search.js` and their helpers/tests only — no `public/`, no `memory-server/` version
code (other worktrees own those).

### Added — lever 16 `hubHint` (hub-append hint)

- The owner's memory uses hub-and-spoke notes (lib/hub-spoke.js's own convention): a hub lists
  its parts under a "## Parts" heading (`- [[slug]] — hook` lines) and/or a part declares
  `part_of:`/`parent:` in its own frontmatter, starting its body `Up: [[hub]]`. Sessions kept
  appending large content straight to the HUB instead of the right part, so hubs grew back after
  being split (one real hub went 1.1k → 9.4k tokens in 4 days).
- New lever 16, `hubHint` (default OFF, `MEMGLOW_PROXY_HUB_HINT` / `"proxy": { "hubHint": true }`;
  threshold `hubHintTokens`, default 400, `MEMGLOW_PROXY_HUB_HINT_TOKENS` / `proxy.hubHintTokens`):
  an `edit_note` with `operation` append / prepend / insert_before_section / insert_after_section
  (never find_replace or replace_section — they target a specific, already-chosen spot, not
  "whatever's at the end"), or a `write_note` with `overwrite: true`, that adds more than the
  threshold's worth of new content (estimated from the call's own `content` argument) to a note
  that HAS parts, gets one advisory line appended: `memglow: "<hub>" is a hub — add detail to one
  of its parts instead: [[part-a]] (topic), [[part-b]] (topic)…`. The part whose own topic (its
  hub-list hook, else its label/description) shares the most significant words with the added
  text is named first. Parts are found either way, whichever the hub actually has (the "## Parts"
  list wins outright when non-empty; falling back to any OTHER note declaring `part_of`/`parent`
  this hub only when there is no list at all) — `lib/hub-spoke.js`'s own `declaredHubOf()` is
  reused for the marker, never re-implemented. Same hub never hinted twice in one session. Never
  blocks, never shortens or replaces the write's own answer — one block appended, the exact same
  mechanics as `duplicateHint`/`slugHint`. Works in both proxy and all-in-one modes (a new
  `index.noteText(id)` helper on `createNoteIndex`, same read-the-file-directly pattern as the
  existing `fileHash`, works in either). New tests: `test/mcp-proxy-levers.test.js` (pure
  `parsePartsSection`/`hubPartsFor`/`hubHintFor`, plus end-to-end over stdio — explicit Parts
  list, frontmatter-only fallback, `write_note overwrite`, the excluded operations, the token
  threshold, off-by-default, once-per-session).

### Changed — better search recall (`lib/store/search.js`, `lib/store/text.js`)

A real duel on the owner's memory (31 search → read pairs from real transcripts) had memglow at
rank-1 6/31, top-3 10/31, MRR 0.283, target anywhere in the results 15/31 (basic-memory: rank-1
1/31, in-results 17/31) — memglow ranks well but misses a few targets. A local, uncommitted eval
harness (`/tmp/eval-recall.js` — not part of this commit; the pairs and the memory copy it reads
are private and were never copied into the repo) reproduced close numbers on this worktree's own
copy of the task's private fixtures (31/31 pairs still present after the restriction to "target
exists in this copy"): rank-1 6/31, top-3 8/31, MRR 0.280, in-results 16/31 — and, after every
change below, **rank-1 6/31, top-3 8/31, in-results 16/31, MRR 0.281**: no pair regressed, one
pair's rank improved (10 → 8), nothing dropped out of the top 10 that was in it before.

- **Light stemming, EN + FR, applied symmetrically** (`stem()` in `lib/store/text.js`, used at
  both index and query time already — only its rules changed): plural `s`/`x` now normalises
  FIRST, so a word and its plural end up at the exact same stem once the OTHER suffixes apply to
  that normalised form — `-ing` ("deploying"/"deploy") and `-tion`/`-sion` ("decision"/
  "decisions", FR "télévision"/"télévisions") both kept, both neutral-to-positive on the 31-pair
  duel. `-ed` and `-ment` were ALSO tried (equally common EN/FR suffixes) and DROPPED: measured
  in isolation, `-ed` turned a borderline rank-10 hit into an outright miss (an unrelated word
  collided on the same stripped stem) and `-ment` quietly worsened one hit's rank with no
  offsetting gain anywhere — "if a technique hurts MRR, drop it."
- **Prefix matching raised from ≥ 3 to ≥ 5 characters** (`PREFIX_MIN_LEN`, `lib/store/search.js`):
  a short query/index term is no longer treated as a prefix stand-in for a longer word (too many
  unrelated 3-4-character words share a prefix) — applied to `queryTermScore`, `candidates()` and
  the observation prefix check. Neutral-to-positive on the duel; one pair's rank improved (10 → 8).
- **Fuzzy (edit-distance-1) matching for off-vocabulary query terms ≥ 6 characters**
  (`editDistanceLE1`, `fuzzyExpand`, `FUZZY_MIN_LEN` / `FUZZY_DISCOUNT`): only when a query term
  has NO exact hit anywhere in the index at all (a real, if rare, word already has one) — a plain
  linear vocabulary scan, length-filtered first, cached per query term. Neutral on the duel (no
  typo'd query among the 31 pairs), proven on the new synthetic fixture instead.
  `candidates()` also expands fuzzy hits into the scored document set, so a fuzzy-only match is
  never excluded before scoring gets a chance to find it.
  `OR_FALLBACK_DISCOUNT`/`FUZZY_DISCOUNT`/`PREFIX_DISCOUNT` are all independent constants — none
  of this is prefix matching in disguise.
- **A dedicated "hub" field, weight 0.5** (`FIELD_WEIGHTS`, `buildHubResolver()`/`docOf()`): a
  note's hub (frontmatter `part_of`/`parent`, resolved against base/slug/title/permalink, built
  once per index build/update — `buildIndex`, `updateIndex`, `warmAsync` all pass the same
  resolver) has its own title + description folded into the PART's index entry, so a search for
  the hub's words still surfaces the part even when the part's own text never repeats them — the
  owner's hub-and-spoke convention keeps a part's body about its own slice only. Weight tuned
  DOWN from an initial guess of 2.5 (between "desc" and "head") to 0.5 after the duel showed the
  higher weight made siblings of a multi-part hub score more alike — hurting the very common case
  of picking ONE part out of several (MRR 0.280 → 0.276) — while 0.5 never regressed a single
  pair (0.281) and still turns a "found nowhere" into a real hit on the synthetic fixture: a
  quiet tie-breaker, not a dominant signal.
- **OR fallback for a short AND-ish result** (`search()`): an explicit `AND`, or a required
  "quoted phrase", that comes up short of a full page is retried as a plain OR over the same
  terms — new notes only, at `OR_FALLBACK_DISCOUNT`, capped to EXACTLY fill the page (never more)
  so an unrelated common word shared by half the corpus can never turn a precise query's `total`
  into a flood of barely-related hits. Never fires for an already-OR query. Neutral on the duel
  (no AND/phrase pair came up short there); proven on the synthetic fixture.
- New committed test: `test/store-search-recall.test.js` — `stem()` suffix equivalences and length
  guards in isolation, then one engine-level assertion per mechanism above (FR + EN notes).
- `test/fixtures/ranking-golden.json` regenerated (`node test/fixtures/ranking-corpus.js
  --write`): 8 of the 215 snapshot queries changed (order and/or `total`), all traceable to the
  changes above — two quoted-phrase queries whose `total` grows from 1 to a full page (`"vegetable
  garden"`, `"jardin et la forêt"`: the OR fallback, exactly its intended effect) and six more
  with a few results reordered among an unchanged `total` (the prefix threshold, stemming or the
  hub field nudging scores on the 400-note synthetic corpus). No other query's result set changed
  at all.

## 0.4.10.9 — internal (not published)

"Every call counted, under the right name." In production (all-in-one server, 2026-10-12) the
per-client accounting in `<dataDir>/proxy-savings.json` had almost every call under `unknown`
and only 4 calls for the whole day.

### Fixed — per-client accounting (all-in-one and proxy)

- **Root cause 1: only reads were counted.** `savings.addClient` was called from `handleRead`
  alone, i.e. for the `readTools` (`read_note`, `view_note`, `read_content`, `fetch`,
  `build_context`). Searches, writes, edits, multiQuery searches (answered out of band by
  `multiQuery.run`, never through `serverMessage`) and every other tool were never counted. Now
  every `tools/call` with an id is awaited by the levers and counted once in `oneFromServer`
  (tokens of the answer as the server sent it, before any lever shortens it; errors and empty
  answers count as a call), and `multiQuery.run` counts its merged answer once.
- **Root cause 2: the client was only known from a legacy `initialize`.** An MCP 2026-07-28
  client (Claude Code on the NAS and the Mac) sends no `initialize`, only a per-request `_meta`
  envelope, so its session had no clientInfo → `unknown`. The identity is now, in order: the
  session's `initialize` clientInfo; else this request's `_meta`
  `io.modelcontextprotocol/clientInfo` (remembered for the rest of that session / connection);
  else the HTTP `User-Agent`'s first product token, mapped to a known client id
  (`claude-code/2.5.1 (…)` → `claude-code`); else `unknown`. Accounting only: lever 7 and lever
  8's exemption still use the session's `initialize` clientInfo alone. Lever 13's per-client
  ledger uses the same identity.
- A churn of stateless new-connection requests (one lever session per TCP connection) could push
  a legacy session — and its clientInfo — out of the 200-session LRU; the oldest per-connection
  session is now evicted first.
- `clientMessage(msg, key, hints)` and `multiQuery.run(…, key, hints)` take an optional
  `{ userAgent }`; `memory-server/http.js` passes it in `ctx.userAgent`, the HTTP proxy from the
  request headers. In proxy mode nothing else changes (it now buffers every `tools/call` answer
  to count it, as it already did for reads / searches / writes).
- Per-lever savings: checked to be recorded identically in all-in-one and proxy modes (new test).
  They stay 0 when `dedupe` / `toc` / `alreadyLoaded` / `deltaRead` are off (their default), and
  `dedupe`/`toc`/`alreadyLoaded` are per session: a 2026-07-28 client opening a new connection per
  call has a fresh lever session every call.
- Flushing: unchanged 2 s `unref`'d timer after the first count; on SIGTERM / SIGINT the server
  now writes the savings at once, before waiting for pending writes (and again at exit). File
  format unchanged (`version: 1`, same per-day fields; `clients` simply gets more buckets).

### Added

- `MEMGLOW_MEMORY_KEBAB_FILENAMES=1`, env equivalent of `--kebab-filenames` (checked: a title
  `Chantier eau cave Choisy – état au 2026-10-11 soir` gives
  `chantier-eau-cave-choisy-etat-au-2026-10-11-soir.md`, frontmatter `title:` kept as given).
  Documented in the README memory-server section and `--help`.
- Lever 15 `slugHint` (`MEMGLOW_PROXY_SLUG_HINT`, `"proxy": { "slugHint": true }`, off by
  default): after a successful `write_note` whose title is not a kebab slug, or whose directory is
  the notes root, one advisory line, e.g. `memglow: title "Chantier eau cave Choisy – état au
  2026-10-11 soir" is not a kebab slug — prefer "chantier-eau-cave-choisy-etat-au-2026-10-11-soir"
  in a memory/<folder>/ directory (title = kebab slug, file = slug.md).` Never blocks. In the
  control panel (8 languages), README and `mcp-proxy/README.md`.
- New test `test/accounting-0410-9.test.js` (the four real traffic shapes in all-in-one and
  proxy modes, per-lever parity, LRU churn, SIGTERM flush of the real server, kebab file names,
  slugHint). The accounting tests fail on 0.4.10.8 (the SIGTERM test too, through its counts:
  the shutdown flush itself already worked).

## 0.4.10.8 — internal (not published)

"A merged search answer is still a complete MCP answer." A search with `memglow_queries` lost
`result.resultType` (and `isError`, `_meta`). The merge (`mergeSearchResults`) rebuilt the result
from scratch, and the merged answer skipped the layer that adds `resultType: "complete"` on MCP
2026-07-28. Claude Code (protocol 2026-07-28) rejected the answer: "missing required resultType —
servers implementing protocol revision 2026-07-28 MUST include it". Found in production from the Mac.

### Fixed

- `mergeSearchResults` keeps every top-level field of the first phrasing's own result, except the
  content it rebuilds (new `withResultFields`). Both tiers, all-in-one and proxy modes.
- `multiQuery.run`: when the request carries the 2026-07-28 envelope and the merged result still
  has no `resultType`, sets it to `"complete"` (safety net).
- Checked: every other rewritten or synthesised answer (lever stubs and notices, alias injection,
  `structuredContent` wrap, tools/list augmentation, the server's own tool errors) already copies
  the original result or goes through the server's `resultType` layer.
- New test `test/result-type-0410-8.test.js`: it fails on 0.4.10.7 and passes now (all-in-one and
  proxy → server, header-only and `_meta` requests).

## 0.4.10.7 — internal (not published)

Fix round before the production deploy (a cold review said GO with conditions). One regression
test per item, `test/fix-0410-7.test.js`.

1. **MAJOR — a stale note served forever after a racing outside save.** `writeAtomic` returned a
   stat taken after the rename; an editor's save landing in that gap left the store with the
   server's text under the editor's stat, so neither the watcher nor the poll ever re-read it.
   The written file's identity is now taken from the temp file's descriptor before the rename;
   when the path no longer holds that inode / size / mtime, the stat is marked `stale`, the store
   keeps no valid stat for its text and re-reads the file at once.
2. **MAJOR — shutdown could outlast Docker's grace period.** Deferred fsyncs ran one path at a
   time (60 writes then SIGTERM: exit after 10 s, the old cap = Docker's default grace). Each
   batch is now coalesced (a file once, a folder once) and synced 8 at a time; the shutdown wait
   is `--shutdown-timeout` (default 25 s, env `MEMGLOW_MEMORY_SHUTDOWN_TIMEOUT`). README: the
   deferred window can be several seconds on a slow btrfs; use `--stop-timeout 30` /
   `stop_grace_period: 30s`. (This machine's /tmp fsync is ≈2 s: 60 pending writes now drain in
   ≈16 s, exit 0.)
3. Startup: each folder is watched as soon as the chunked load reaches it (before listing it);
   events wait for the load to be applied, then apply.
4. A rescan overlapping writes is merged (the files the writer changed meanwhile are left as
   they are) instead of dropped: a write burst no longer postpones indexing a new folder.
5. The `.trash` backup copy is fsync'd (sync: at once; deferred: queued). A file moved while its
   deferred fsync was pending or in flight is synced at its new path (moves are followed).
6. `read_note`, `edit_note` (`move_note`, `delete_note`) and lever 8's "unchanged" hash apply the
   watcher events still in their debounce and stat the requested note first
   (`store.refreshNote`): a read right after an outside save answers the new version.

## 0.4.10.6b — internal (not published)

Fixes from an adversarial review of 0.4.9.1 → 0.4.10.6 (a read-only review, findings reproduced).
Ranking, `updateIndex`, the snippet rewrite, `candidates()` and the search metadata's `pure`
shortcut were checked equivalent to the old code; these were not:

- **Watcher: a folder deleted and recreated was never watched again** (its dead watcher stayed in
  the map). Watchers now remember their folder's inode and are replaced when it changes; an event
  about a known folder whose inode changed triggers a rescan. A non-note file written in a note
  folder (a log, a database) no longer triggers rescans at all — only a new / gone / replaced
  folder does.
- **Watcher: a wanted rescan was dropped** when a write landed during its asynchronous walk
  (`scanAsync` discards a result older than a write) — with `--poll-ms 0` forever. It is now
  re-queued.
- **Startup: changes during the chunked load were missed** (watchers were armed only after it).
  They are armed right after the listing now. And a store change during a deferred start no
  longer queues a full synchronous `tools.warm()` that defeated the chunked warm-up.
- **Deferred fsync**: the docs claimed "never torn" unconditionally. Corrected (README, `--help`,
  writer comment): on XFS / ext4 `noauto_da_alloc` an edited note can come back empty after a
  power cut inside the window; `sync` there. A background fsync error other than "gone" is now
  logged and counted (`stats().deferredSyncErrors`). Stdio mode now also waits for pending
  writes and fsyncs on SIGTERM / SIGINT.
- **A failed listen exited 0**: the new `uncaughtException` handlers swallowed EADDRINUSE. The
  viewer and the HTTP proxy now exit 1 on a listen error.
- `childEnv` also keeps `ANTHROPIC_FOUNDRY_API_KEY` (Claude Code's own). The rules relay's
  per-session set is capped at 5000 keys; the levers' `renameSession` settles a replaced
  session's pending search.
- Tests: `test/review-0410-6b.test.js`, one more in `test/watch-0410-4.test.js`.
- Left as is (documented risks): new notes are 0660 (a reader under another uid outside the
  folder's group loses access — `--file-mode 0664` restores world-read); Bedrock / Vertex
  credentials (`AWS_*`, `GOOGLE_*` keys) are stripped from the assistant's `claude` child by S7;
  lever 8's hash of a note the store skips (> 4 MB, not UTF-8) is not the file's own bytes;
  stateless clients opening one connection per request get one lever session each.

## 0.4.10.6 — internal (not published)

Responsiveness, step 6: shorter answers. **Goldens updated on purpose** (listed below).

- `search_notes` TEXT output (`memory-server/tools.js`):
  - no `- external_id:` line any more (still in `output_format: "json"`, as `external_id`);
  - the `- match:` excerpt cut to 120 characters around the first query term
    (`lib/store/search.js` `clip()`, the snippet's own cut generalised — at 200 it is
    byte-for-byte the old cut, the ranking snapshot still passes); no match line at all when the
    excerpt only repeats the title (the note's `# title` heading, or the title used when no line
    matched);
  - footer `*N results | page P, page_size S | more available*` → `*N results*`, with
    `, page P` only beyond page 1 or when more exist, and `, more: page=P+1` when they do.
  - The block layout the levers rely on is unchanged (`### title`, `- permalink:` first, blank
    line between hits, a `---` footer): `permalinksIn` / `idsInText`, `hitChunksOf`,
    `resultIds`, searchDetails and the multiQuery merge all still resolve every hit (tested).
- New `--no-structured-read` (env `MEMGLOW_MEMORY_STRUCTURED_READ=0`; default off = unchanged):
  `read_note`'s text answer carries the note once, in `content`, without the FastMCP
  `structuredContent: { result }` copy. JSON answers unchanged.
- Measured, tokens (bytes / 4) per 10-hit search, text only: a production-like corpus
  (kebab-case titles, long bullet lines, a `# title` heading per note) 779 → 491 (−37 %);
  this repository's docs cut in 265 notes 608 → 461 (−24 %); the bench's dense synthetic corpus
  1214 → ≈940 counting the structuredContent copy (−22 %); the test's own long-line corpus
  881 → 549 (−38 %). The −40 % target is reached only where match lines were long or repeated
  the title; the rest of a hit (title, permalink, score) is what the levers and clients need.
- **Goldens changed on purpose**: `test/memory-server-tools.test.js` (search text block without
  `external_id`, match ≤ 120, the new footer forms), `test/memory-server-proxy.test.js` (merged
  footer `*1 result*`). The all-in-one ≡ proxy equivalence test is unchanged and passes (both
  sides use the same server output).
- Tests: `test/answers-0410-6.test.js`.

## 0.4.10.5 — internal (not published)

Responsiveness, step 5: structured hand-off, posting lists.

- **Structured hand-off** (`lib/search-meta.js`). A `search_notes` text result built by the
  in-process server carries, out of band (a WeakMap keyed by the result object — never
  serialised, never sent to a client; kept on the 2026-07-28 copy with `resultType`), the blocks
  its text is made of — exactly what `hitChunksOf()` would cut — with each block's note references
  as the levers' own parsers (`permalinksIn`, `idsInText`) find them, and a `pure` flag (no
  reference but each hit's own permalink line: no path, file name, `permalink:` or `memory:` in
  a title, a snippet or the query).
  - multiQuery (all-in-one): the merge takes each phrasing's blocks and references from that
    metadata — no re-splitting, no regex scan of the phrasings' texts — through the SAME merge
    code (so the output cannot differ), and the merged text is assembled once; the merged result
    gets its own metadata.
  - The levers' "which notes does this search name" (`resultIds`: searchDetails, archiveHint,
    aliases / learnAliases, negativeCache, indexHint; and the multiQuery alias step) reads the
    hits' permalinks from the metadata when the result is pure — exactly what scanning the text
    and its structuredContent copy gives (proved by test) — else scans the text as before.
  - The standalone proxy has no such metadata: the text parsing stays its path.
  - Not done literally: each phrasing's own text is still assembled by `search_notes` (a cheap
    join; phrasing 1's text is what a failed merge falls back to) — it is just never re-parsed.
- **Posting lists** in `lib/store/search.js`: every index term → the docs holding it (kept
  incrementally with df/vocab); a text query scores only the union of its positive terms' and
  their prefix expansions' docs (exactly the docs that can score; filter-only, NOT-only and
  stop-word-only-phrase queries still scan all). Plus, with identical arithmetic: each doc's
  field-weighted term frequencies summed once at index time (the per-query loop over 7 fields
  is gone), idf cached per index version, the length normalisation computed once per doc and
  index, and snippets that visit only the lines holding a query term (a per-note term → lines map,
  prefix range by binary search) instead of testing every line. The 215-query ranking snapshot
  (`test/search-ranking.test.js`) still matches exactly, scores and snippets included.
- Measured, raw `engine.search` (no transport): realistic corpus (265 notes cut from this
  repository's docs, 3 k distinct words) ≈1.4–2.3 → ≈0.8–1.1 ms per 2-word query; the dense
  synthetic corpus (60-word vocabulary, every note matches) ≈3.5 → ≈2.2 ms (2 noisy cores).
- All-in-one output still byte-identical to "proxy → memory server" (equivalence test).
- Tests: `test/structured-0410-5.test.js` (metadata blocks = `hitChunksOf`, references = the
  parsers', a pure result names nothing else even in its JSON copy, `resultIds` and multiQuery
  merges identical with and without metadata, posting lists consistent with df).

## 0.4.10.4 — internal (not published)

Responsiveness, step 4: freshness under a second at ~0 % CPU.

- `lib/store/store.js`: the recursive `fs.watch` on the root (which also woke up for every object
  a git snapshot wrote in `.git` — the reason production runs `--no-watch`) is replaced by one
  NON-recursive watch on the root and on each note folder the listing finds; dot-folders
  (`.git`, `.trash`), `@eaDir`, `#recycle`, `#snapshot`, `node_modules`, `__pycache__` are never
  listed, hence never watched. The watched set is re-armed after every listing (a folder created,
  removed or renamed).
- An event naming a `.md` file → only that file is (l)stat'ed and applied, asynchronously, after a
  25 ms debounce gathering a burst; dot-files (the writer's temp files) are ignored; an event
  about anything else (a folder) or without a name → an asynchronous rescan; more than 1000
  pending files → one rescan. `fresh()` never scans synchronously any more on a read (only the
  very first read of a store whose initial load has not finished).
- The fallback poll stays (`--poll-ms`, default 3000). Watching stays the default; `--no-watch`
  opts out. **`--no-watch` is no longer needed in production** (README, `--help`).
- `store.stats()` adds `watchedFolders`, `fullScans`, `eventApplies`, `events`.
- Tests (`test/watch-0410-4.test.js`): one watcher per note folder, never `.git` / `.trash` /
  `node_modules`; 200 writes inside `.git` → 0 rescans, 0 event applies; an edited note visible
  in ≈0.1 s through the event (no rescan), a new note, a delete, a new folder (then watched
  itself); the writer's own writes not re-read; `--no-watch` → no watcher.

## 0.4.10.3 — internal (not published)

Responsiveness, step 3: one index.

- **The levers' note index reads the store** in all-in-one mode (`memory-server/store-memory.js`):
  an object with the subset of lib/memory.js's API that `createNoteIndex` uses, built from the
  notes the server has already read and parsed — no second scan of the folder by lib/memory.js.
  Same semantics, so the levers answer byte for byte as in "proxy → memory server" (the
  equivalence test still passes, and a new test compares the graph with a lib/memory.js scan,
  before and after writes): the notes under the index folder, depth-first name order, slug ids
  (first wins), lib/memory.js's own frontmatter reader, theme rules and `[[link]]` parser, 512 KB
  limit, files the store skips (not UTF-8, too large) still listed, the "last BODY change" mtime
  rule (fingerprints now computed only when two versions of a note are compared). Documented
  difference: the store also skips `#recycle`, `#snapshot` and `__pycache__` folders. Used only
  when the index folder is inside the server's root; the standalone proxy keeps its own index.
  `createNoteIndex(cfg, { memory })` takes such a source.
- **Lever 8 hashes the in-memory text** (`fileHash` → `textOf`, the file's exact bytes, a BOM
  the reader dropped put back — the store now records `note.bom`); the archive summary and the
  size after a write (`fileStat`) come from memory too. **`afterWrite`** is now a no-op refresh:
  the writer already updated the store.
- **`store.data()` split**: the resolution maps are built at once, the link graph (outgoing /
  incoming edges) only by `store.graph()` on first use per version (only `build_context` needs it).
- **Search index updated incrementally** on a small change (`updateIndex`): df counts adjusted
  for the docs that left / arrived, the sorted vocabulary merged, total length adjusted — exactly
  a full rebuild (tested after write / edit / move / delete); a big change still rebuilds.
- With `deferStart` the levers' index is built during the warm-up, not by the first request.
- Measured (265 notes, the index-reading levers on, in process): `initialize` 128 → 42 ms
  (the first `initialize` built the levers' index by scanning and reading every file; now it is
  derived from parsed notes, and prebuilt at startup in the CLI); first `read_note` after
  `initialize` ≈120 → ≈6 ms with no file read; a search right after a write ≈+9 ms over a steady
  one on 120 notes (test), was a full df/vocab rebuild.
- Tests: `test/one-index-0410-3.test.js`.

## 0.4.10.2 — internal (not published)

Responsiveness, step 2: startup.

- **The port opens before the warm-up.** `createMemoryServer({ deferStart: true })` (what the CLI
  now uses) returns at once: `store.startAsync()` lists and stats the folder asynchronously, then
  reads and parses the notes in `setImmediate` chunks of 16; `engine.warmAsync()` then builds the
  index entries in chunks and assembles the index. `srv.ready` resolves when both are done. A
  request arriving before that waits for `ready` (HTTP and stdio both already handle a promised
  answer) — it never fails and never sees a half-loaded folder; any direct read of the store
  before the chunked load ends gets the plain synchronous scan, which the load then gives way to.
  `GET /healthz` answers at once. Tests and other callers keep the old synchronous behaviour.
  stdio: lines that arrive before `ready` are buffered and handled in arrival order once it
  resolves, so answers keep their usual order. The CLI now logs "listening" before "N notes
  indexed" (`test/memory-server-http.test.js` waits for both).
- **Each note body is tokenised once** (`lib/store/search.js` `tokeniseBody`): the body is
  folded in one call, split into lines (fold never adds or removes a line break), each line
  matched once; the body's index terms, its phrase text and the per-line snippet term sets all
  come from that pass (they were three separate passes: `terms(body)`, `phraseText(...body)`,
  `terms(line)` per line). Warm-up of 265 notes ≈640 → ≈425 ms (same machine, same corpus).
- **Ranking is unchanged**, proven by `test/search-ranking.test.js`: the top-10 of 215 queries
  (the existing search tests' queries plus generated ones) over the memory-server fixture, a
  400-note synthetic corpus and edge notes (NFD accents, ligatures, Greek, CRLF, emoji, a lone
  combining mark) — same notes, order, kind and match snippet, scores equal to 1e-9 — against a
  snapshot taken with the 0.4.10.1 code (`test/fixtures/ranking-golden.json`), both with the
  synchronous index and after `warmAsync()`.
- **`fold()`: NOT rewritten, on purpose.** A whole-string NFD + strip-marks version with exactly
  today's output was written and proven equal (on accented French text and on every code point
  up to U+2FFFF — it needs a few explicit rules: a mark or surrogate already in the input → a
  space, the ligature table applied before NFD, 5 BMP characters whose decomposition is ASCII
  punctuation → a space). Measured, it is SLOWER on V8 than the current cached per-character
  fold (16.6 vs 7.3 ms per 200 k characters of accented text; the `\p{M}` passes dominate), so
  the current `fold()` stays. The reference and the equality proof are kept in
  `test/search-ranking.test.js` (a future rewrite has its oracle). The real saving is folding
  each body once instead of per line (above).
- Measured (real process, 265 notes, levers on): spawn → first `initialize` answer 1239 →
  965 ms (that answer waits for `ready`; the port itself is open within node's boot time).
- Tests: `test/startup-0410-2.test.js` (requests before ready wait and match a fully loaded
  server, the event loop keeps turning during the load, the CLI's `/healthz` and a search answer
  while/after it loads), `test/search-ranking.test.js`.

## 0.4.10.1 — internal (not published)

Responsiveness, step 1: `--fsync-mode sync|deferred|none` for the memory server's writes.

- `memory-server/writer.js`: `fsyncMode`. **`sync` stays the public default** (the file and its
  folder fsync'd before the answer, as before). `deferred`: the write is answered right after the
  atomic rename; the file and folder fsyncs are queued to the writer's background flusher (one at
  a time, a path queued twice synced once, files before folders); `idle()` — used by the HTTP
  shutdown path, and now by the stdio exit path too — waits for every pending fsync; the
  `.trash` backup copy is not fsync'd. `none`: no fsync (`--no-fsync` is its old spelling).
- Settings: `--fsync-mode`, env `MEMGLOW_MEMORY_FSYNC`, or `memoryServer.fsyncMode` in
  `memglow.config.json` read ONLY from `MEMGLOW_CONFIG` or `~/.memglow/` (never the current
  folder, the 0.4.7.6 trust boundary); flag > env > file > `sync`. Logged at startup with its
  source.
- The mode is shown READ-ONLY: `GET /healthz` adds `fsyncMode` to the full (authorised) answer;
  `lib/setup.js` `memoryServerStatus()` passes it on when present; the Control panel's "Memory
  server" / "Serveur de mémoire" line shows a badge (`control.memoryServerFsync`, 8 languages).
  Nothing on the page can set it.
- README: the trade-off spelled out (deferred: a power cut within ~1–3 s of a write can lose that
  write, never tear a file; safe with a UPS).
- Tests (`test/fsync-mode.test.js`): mode resolution and precedence (cwd file ignored);
  `idle()` waits for gated pending fsyncs; sync/none never leave one pending; healthz shows the
  mode only when authorised; the badge is not a control; `kill -9` during a stream of deferred
  writes leaves every file exactly one whole version; deferred p50 < 50 ms on a temp folder.
- Measured on this machine's temp folder: write p50 sync ≈2.4 s → deferred ≈7.6 ms (none ≈5 ms).

## 0.4.10.0 — internal (not published)

Responsiveness, step 0: the activity report is off the request path.

- The all-in-one server reported each call BEFORE sending its answer, and `lib/agent-core.js`
  `report()` re-read the config file and the token synchronously and spawned one detached node
  process per call. New `reportInProcess()`: scheduled with `setImmediate` (the answer is
  written first), classified there, sent with an in-process `fetch` (`AbortSignal.timeout(3000)`,
  at most 32 in flight), config and token cached and re-read every 30 s. Used by the all-in-one
  server and by the standalone proxy's watcher (stdio and HTTP). Hooks keep `report()`: their
  process exits right away, a detached sender is still what they need.
- `bench/responsiveness.js`: the production set-up measured end to end (startup, `initialize`,
  search / multiQuery / read / write latency, first search after a write, tokens per 10-hit
  search, child processes per call, reports delivered, a real process's freshness and idle CPU).
- Measured (265 synthetic notes, 2 cores, all-in-one with the default levers, over HTTP): search
  p50 149 → 10 ms, multiQuery 218 → 17 ms, read 125 → 7 ms; child processes per call 1 → 0;
  reports delivered 161/160 before and after (the `initialize` too).
- Test: `test/report-inprocess.test.js` (no child process spawned, every report arrives, with
  channel / machine / durationMs; settings cached; a viewer that is down is harmless).

## 0.4.9.1 — internal (not published)

Security fixes from an audit, and two production bugs. One regression test per item
(`test/security-0491.test.js`).

- **S1 — the HTTP proxy could be killed by one malformed request.** `new URL(req.url)` threw on a
  bad request-target (e.g. a raw `POST http://[::1 HTTP/1.1`) outside any handler. It now answers
  400; the whole request handler is wrapped (500 on an unexpected error), and the CLI installs
  `uncaughtException` / `unhandledRejection` handlers that log and keep serving, as the memory
  server already did (which now also logs unhandled rejections).
- **S2 — the viewer could be killed by `/api/note/%E0%A4%A`** (`decodeURIComponent` threw a
  `URIError`). Now 400, as is a malformed request-target; the request handler is wrapped (500
  instead of a crash) and `main()` installs the same last-line handlers. Every other
  `decodeURIComponent` / `new URL` / `JSON.parse` on request input in the server code was
  already guarded (checked by grep: `memory-server/http.js`, `lib/store/store.js`,
  `lib/setup.js`, `server.js` bodies, the proxy's relays).
- **Proxy session keys.** The HTTP proxy filed every request without an `Mcp-Session-Id` under
  one shared "default" session: only the first client after a restart got the memory rules, and
  lever 7, lever 8's exemption and per-client savings lost who the client was. A stateless
  request is now keyed by its TCP connection (`memory-server/http.js` `connKey`, same as the
  all-in-one server); an `initialize` is keyed by its connection, then its state moves under the
  `Mcp-Session-Id` the upstream hands out (`renameSession` on the levers and the rules relay).
- **multiQuery listed a note twice** (production: `project-memglow-v05-engine-roadmap` in hit 1
  and again as the last block). Two causes, both fixed in `lib/proxy-levers.js`: (1) a hit whose
  note the levers' index cannot resolve (file name ≠ permalink, a note outside the index folder)
  was keyed by its whole block text, which differs per phrasing (score, match) — it is now keyed
  by its own `permalink:` line first; (2) `frameOf` only recognised a footer when nothing but
  "---" blocks followed it, so a section after the footer (related notes…) became a "hit" — in a
  page of `### ` hits everything from the first "---" block after the last hit heading is now
  frame. The kept frame never repeats a note already listed among the merged hits.
- **S5** — a proxy request body over 10 MB was truncated silently and still relayed. Now 413,
  "Connection: close", and the request is dropped (declared or streamed length).
- **S6** — `read_content` served any regular file under the root. It now serves only
  `.md .txt .json .csv .yaml .yml .png .jpg .jpeg .gif .webp .svg .pdf`; `--serve-files any`
  (env `MEMGLOW_MEMORY_SERVE_FILES=any`) restores the old behaviour.
- **S7** — the CLI assistant provider's child environment now also drops `MEMGLOW_MEMORY_*` and
  every variable whose name contains TOKEN / PASSWORD / SECRET / KEY — except Claude Code's own
  sign-in variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`),
  which the `claude` child needs to run at all.
- **S8** — a new note file got `0666 & ~umask` (usually world-readable). It now gets `0660` when
  no `--file-mode` is given; an existing file still keeps its mode, and the group still comes
  from the folder (chown to the parent's owner when running as root, as before).

## 0.4.7.6 — internal (not published)

Fix round on the 0.4.7 settings / control panel, after a cold review confirmed 2 critical, 2
major and 7 minor issues. All fixed, each with a regression test.

### Critical

- **A `maintenanceEveryHours` above ≈596.5 h overflowed Node's timer and fired hundreds of times
  a second.** `lib/setup.js`/`lib/config.js`/`public/control.js` now cap the bound at 168 h (one
  week); `lib/maintenance.js`'s `createScheduler` also clamps the actual ms it ever hands to
  `setIntervalFn` to `2^31-1` defensively, for any value that reaches it another way (e.g. the
  environment variable, which bypasses the UI's own bound).

### Major

- **`tuning`/`proxy` were saved as whole-object replaces**: two independent panels (Control's
  levers, Control's maintenance tuning, AI settings' own tuning) each sending only their own keys
  silently erased whatever the OTHER had just saved. `lib/setup.js` `createSetupStore.write()` now
  MERGES `tuning` and `proxy` per key; `validate()` keeps an explicit `null` (previously dropped)
  so a key can still be reset to its default without disturbing any other key.
- **Trust boundary**: `./memglow.config.json` (the notes folder's own, possibly untrusted, cwd
  file) controlled the MCP proxy, the memory rules and the all-in-one memory server since 0.4.7.1
  — able to set `dataDir`/`memoryDir`, replace the tool-mapping tables, or inject text into
  `initialize.instructions` via the rules. `lib/defaults.js` `resolveConfigFiles()` gains
  `allowCwd` (default true); `lib/proxy-levers.js proxyConfig()`/`lib/memory-rules.js
  lightConfig()` (and transitively the all-in-one server) now pass `allowCwd: false` — only an
  explicit `MEMGLOW_CONFIG` or `~/.memglow/memglow.config.json` is ever read by those three, same
  as before 0.4.7.1. The viewer (`lib/config.js`) is unaffected: its own project folder, never the
  notes folder.

### Minor

1. The config-divergence warning now logs at most once per process per (cwd file, home file) pair
   (`lib/defaults.js` `warnOnce`), not on every `GET`/`PUT /api/setup`.
2. Saving levers no longer pins all 16 as `source: "page"`: `public/control.js`
   `controlCollectProxy()` diffs against the effective value and sends only real changes; each
   non-default, non-locked lever gets a "Reset to default" control (sends `null`).
3. `lib/proxy-levers.js` `proxyControl()` now returns each lever/cap's own `env` var name, so the
   "Locked by …" badge has something after it.
4. A relative `memoryDir`/`dataDir` could resolve against two different base directories (the
   viewer always used cwd; the proxy/rules used the config file's own directory). `lib/defaults.js`
   `resolveBase()` is now the one shared rule, used by all three; `server.js` additionally detects
   and logs (server log only, never in any API response) a genuine viewer/proxy `dataDir` mismatch.
5. `GET /api/setup` no longer waits up to 2 s on `/healthz` on every request: `server.js` caches
   the memory-server status for 30 s and refreshes it in the background (one refresh in flight at
   a time); `setupNow()` itself is now wrapped in a try/catch (no unhandled rejection / crash).
6. The first "Run now" scanned twice (`maintenanceEnsureStarted()`'s own start-up scan, then an
   unconditional `runOnce()`): `server.js` now only asks for a second scan when the scheduler was
   already running before that request.
7. `GET /healthz` (`memory-server/http.js`) now answers only `ok`/`version`/`notes` to an
   unauthenticated caller when the server has a token configured; `readOnly`/`tokenRequired` (and
   `name`/`indexVersion`/`lastScanAt`) require the right Bearer token — or nothing at all when the
   server has no token configured, matching `lib/setup.js` `memoryServerStatus()`'s own shape.

## 0.4.7.5 — internal (not published)

"Settings / control panel, step 5: proxy present + per-lever savings." The Control panel's
"Measures" section now shows a live "MCP proxy last seen X ago (N ms)" badge, and the per-lever
token savings (`dedupe`/`toc`/`alreadyLoaded`/`deltaRead`) alongside the existing per-AI-tool
figures — both already written to `proxy-savings.json` by `lib/proxy-levers.js`'s own
`createSavings`, but never read back until now.

### Added

- **`server.js`**: an in-memory `proxySeen = { t, durationMs }`, updated from `POST
  /api/activity` whenever an accepted (or "unknown", e.g. a missed search) event carries
  `channel: "mcp-proxy"` — never persisted (a live "is one running right now" signal, not a
  history); fed into `publicSetup()`'s `control.proxySeen`.
- **`lib/proxy-levers.js`**: `readClientSavings()` now also returns `byLever` — the SAME
  `proxy-savings.json` the per-AI-tool figures already come from, summed over the window, one
  entry per lever that has ever saved tokens. A day missing `clients` entirely still contributes
  its lever figures (the two were always independent writes).
- **`public/control.js`**: "Measures" shows the proxy-seen badge (already partly wired in
  0.4.7.2) with "ago" at second/minute/hour/day granularity, and a new "By lever" list next to
  "By AI tool".
- i18n: `control.byLeverTitle`, all 8 languages (the badge and "by AI tool" strings already
  shipped in 0.4.7.2).

### Tests

- `test/mcp-proxy-levers.test.js`: `readClientSavings().byLever` — summed across the window,
  independent of `clients` presence, outside-window days ignored, malformed entries dropped.
- `test/setup.test.js`: `control.proxySeen` end to end — `null` until a real `channel:"mcp-proxy"`
  `POST /api/activity`, then reflects `t`/`durationMs`; a `channel:"hook"` event never touches it.
- `test/speed.test.js`: `/api/cost`'s `clientTokens` now carries `byLever` too (updated the two
  existing exact-shape assertions this added field changed).

## 0.4.7.4 — internal (not published)

"Settings / control panel, step 4: maintenance tuning." The Control panel's "Memory maintenance"
section gains five tuning fields (scan interval, archive-after days, index-trim candidate line
length, the index's own "too large" threshold, sessions/day) and a "Run now" button.

### Added

- **`lib/setup.js`**: five new `tuning` fields — `maintenanceEveryHours`, `archiveAfterDays`,
  `indexTrimMaxChars`, `indexWarningTokens`, `sessionsPerDay` — validated through the existing
  closed `TUNING` bounds table (no new code path: `validate()` already walks it generically).
  `baseOf()`/`envLocks()`/`effective()`/`apply()` carry them with the same env > page > file
  priority as `largeNoteTokens` already has; `archiveAfterDays` recomputes the whole
  `lib/archive.js` settings object (folder/summaryNote/etc. untouched, env still wins). `publicSetup()`'s
  `tuning` gains the five values plus their `locked` flags.
- **`lib/maintenance.js`**: `createScheduler().setEveryHours(hours)` — re-creates the periodic
  timer at the new interval, with NO process restart and no forced extra scan; a no-op before
  `start()` has actually run.
- **`server.js`**: `POST /api/maintenance/run` (same guard as `/dismiss`: page access, CSRF, rate
  limit) → `runOnce()`, so "Run now" shows exactly what the next scheduled scan would. `PUT
  /api/setup` calls `setEveryHours()` right after applying a saved `tuning.maintenanceEveryHours`.
- **`public/control.js`**: the "Memory maintenance" section gains its own form (the five tuning
  fields, env-locked ones disabled) and a "Run now" button — both independent of the lever
  switches' form, saved through the same `PUT /api/setup`/`POST /api/maintenance/run` routes.
- i18n: 7 new `control.*` keys (5 field labels, `runNow`, `ranNow`), all 8 languages.

### Tests

- `test/maintenance.test.js`: `setEveryHours()` (before/after `start()`, no forced scan, 0 turns
  the repeat off); `POST /api/maintenance/run` end to end (CSRF, GET reflects it); the five tuning
  fields round-trip through `PUT /api/setup`/persist; `maintenanceEveryHours` locked by its env
  variable is reported and wins over a page value.

## 0.4.7.3 — internal (not published)

"Settings / control panel, step 3: lever switches." The Control panel's levers are no longer
read-only: a checkbox per lever, day-one levers first (sizeWarning, multiQuery, aliases,
learnAliases, indexWarning), the rest under "Advanced", each with its one-line help text. An
env-locked lever's checkbox is disabled, with a "locked by MEMGLOW_PROXY_…" badge. Saving shows a
banner: levers are read once at proxy start, so a change needs a restart to take effect.

### Added

- **`lib/setup.js`**: a new `proxy` body part in `validate()` — a CLOSED list, exactly
  `lib/proxy-levers.js`'s `LEVER_META` keys (`PROXY_LEVER_KEYS`, kept automatically in sync: a new
  lever added there is automatically save-able here, no second list), each value a strict
  boolean; anything else (a tool-mapping table, a cap, a disk path, a token, an unknown key) is
  refused with `unknown-field`/`bad-value`/`secret-field`, never silently dropped. `reread()` and
  `createSetupStore.write()` carry the new section through like every other one. Saved as a WHOLE
  (no deep merge across calls, same as `tuning`/`assistant.providers`) — the page always sends
  every lever it currently renders.
- **`public/control.js`**: the lever rows are now checkboxes, saved through `PUT /api/setup`
  (the exact same route, CSRF guard and rate limit as every other Settings write); a restart
  banner after a successful save; the two integer caps (largeNoteTokens, indexWarningTokens) are
  now also shown (read-only — they stay editable from AI settings' "tuning", not duplicated here).
- i18n: `control.restartNotice`, plus three already-shipped keys (`setup.saving`/`setup.saved`/
  `setup.notSaved`, `aiset.save`) reused for the save flow — all 8 languages.

### Tests

- `test/setup.test.js`: saving a lever round-trips and persists; the whole-object save semantics
  (a lever not resent reverts, like `tuning`); an env-locked lever's page value is accepted but
  never used (the environment still wins); a CSRF-refused write never saves. **Security**: a
  dedicated test sends every excluded shape (tool-mapping tables, per-lever caps, disk paths, a
  token-named field, wrong types, an unknown key alongside a valid one) and asserts every single
  one is refused (400), then confirms the full, legitimate closed list saves together in one call.

## 0.4.7.2 — internal (not published)

"Settings / control panel, step 2: read-only control panel." A new Settings → Control tile shows,
all read-only for now: every MCP proxy lever's current value and where it comes from (environment
variable / Settings page / memglow.config.json / built-in default), the last memory-maintenance
scan, an optional memory server's health, and a few measurements. Nothing here can be changed yet
(0.4.7.3 adds the switches) — this step is only about SEEING the truth consistently.

### Added

- **`lib/proxy-levers.js`**: `proxyControl(env, cwd)` → `{ levers: [{ key, value, source, envLocked,
  day1 }], caps: [{ key, value, source, envLocked, min, max }], dataDir }` for the 16 lever
  booleans (`LEVER_META`, with `day1: true` for the five day-one levers — sizeWarning, multiQuery,
  aliases, learnAliases, indexWarning) and two integer caps (`LEVER_INT_CAPS`: largeNoteTokens,
  indexWarningTokens). `proxyConfig()` itself now ALSO resolves every lever boolean through the
  page's saved `<dataDir>/setup.json` "proxy" section (env > page > file > default — `lib/defaults.js`
  `resolveBool`, mirroring `resolveInt`), so "value" and "source" can never drift apart even though
  nothing can save to that section until 0.4.7.3 (it reads as `{}` until then, a pure no-op).
- **`lib/defaults.js`**: `resolveBool(envVal, pageVal, fileVal, def)` and `readSavedProxy(dataDir)`
  (the "proxy" section of setup.json, read-only, {} until 0.4.7.3 can write it).
- **`lib/setup.js`**: `memoryServerStatus({ url, fetchImpl, timeoutMs })` — an optional
  `MEMGLOW_MEMORY_URL`'s own `GET /healthz`, 2 s timeout, never throws, never a secret:
  `{ configured, ok, readOnly, tokenRequired, version, notes }` or `{ configured: false }` when
  unset. `publicSetup()` gains `control: { proxy, maintenance: { generatedAt }, memoryServer,
  proxySeen }` (the last field stays `null` until 0.4.7.5 wires it up).
- **`memory-server/http.js`**: `GET /healthz` now also answers `readOnly` and `tokenRequired`
  (booleans only — never the token itself, never any other start-up flag), threaded from
  `memglow-memory-server.js`'s own `--read-write`/`--token`.
- **`server.js`**: `setupNow()` includes the last maintenance scan's `generatedAt`; `GET /api/setup`
  awaits an optional memory-server health check (short timeout, never blocks on a slow/absent one
  past that timeout).
- **`public/control.js`** (new) + a new "Control panel" tile in `public/index.html`
  (`#mg-control`, opened from the gear menu's new "Control" button): four read-only sections —
  Token savings (day-one levers, the rest under "Advanced", each with its one-line help text, its
  on/off value and its source), Memory maintenance (last scan + opportunity count), Memory server
  (health, or "not configured"), Measures (by-AI-tool tokens from `/api/cost`, and the proxy-seen
  line — "not reported in yet" until 0.4.7.5). Never shows a secret, a disk path, a tool-mapping
  table or any of the memory server's own start-up flags.
- i18n: `settings.control`, 29 `control.*` keys, 16 `control.lever.*` one-line help texts (from the
  lever descriptions at the top of `lib/proxy-levers.js`), and `common.hoursAgo`/`minutesAgo`/
  `secondsAgo` (finer-grained than the existing `common.daysAgo`, for the proxy-seen badge) — all 8
  languages.

### Tests

- `test/mcp-proxy-levers.test.js`: `proxyControl()` — default/file/env/page sources, envLocked,
  the day-one list, the largeNoteTokens/indexWarningTokens caps.
- `test/setup.test.js`: `memoryServerStatus()` (not configured, unreachable, a fake `/healthz`
  with a secret-looking field that must never surface), and `GET /api/setup`'s `control` key end
  to end (default sources, an env-locked lever, a page-saved tuning value reflected as "page").
- `test/i18n.test.js`: `control.js`'s `EN_CONTROL` fallback added to the "matches en.json exactly"
  and "every page language" checks; a new assertion that `controlRender()` routes every section
  through `T()` (lever names themselves are never translated).

## 0.4.7.1 — internal (not published)

"Settings / control panel, step 1: single source of truth for config." Start of 0.4.7 ("the
settings / control panel"). Today there is no UI for the 14+ MCP proxy levers nor for the memory
server; this first step fixes the configuration defects a control panel would otherwise inherit:
two config files that could silently disagree, three numeric defaults (`largeNoteTokens`,
`splitChunkTokens`, `indexWarningTokens`) duplicated across four modules, and the MCP proxy never
reading the Settings page's own saved tuning, so a lever's threshold could diverge from what the
page showed.

### Added

- **`lib/defaults.js`** (new): the single source of truth for `LARGE_NOTE_TOKENS` (5000),
  `SPLIT_CHUNK_TOKENS` (2000) and `INDEX_WARNING_TOKENS` (2000); `resolveConfigFiles({ env, cwd,
  home, strict })`, which resolves `memglow.config.json` across its two possible locations (an
  explicit `MEMGLOW_CONFIG` alone, else `./memglow.config.json` merged OVER
  `~/.memglow/memglow.config.json` per top-level key, the project file winning, with a `warnings`
  entry for any key the two files set to a genuinely different value — `strict` throws on a
  broken EXPLICIT or PROJECT file, never on a broken home file); `resolveInt(envVal, pageVal,
  fileVal, def, min, max)` (env > page > file > default, each candidate clamped); and
  `readSavedTuning(dataDir)`, a read-only read of `<dataDir>/setup.json`'s `tuning` section for
  callers (the MCP proxy, memglow's own MCP server) that do not load `lib/setup.js`'s full
  pipeline.

### Changed

- **`lib/config.js`**: `loadConfig()` now reads BOTH config file locations (previously: the
  project/explicit file only — the home file `memglow init` writes was invisible to the main
  viewer unless `MEMGLOW_CONFIG` pointed at it), and its three numeric defaults come from
  `lib/defaults.js`.
- **`lib/proxy-levers.js`**: `proxyConfig()` now reads BOTH config file locations too (previously:
  the home file only, by default — a project `./memglow.config.json` was invisible to the proxy
  unless `MEMGLOW_CONFIG` was set). It also now reads the Settings page's saved
  `<dataDir>/setup.json` tuning for `largeNoteTokens` (lever 1, `sizeWarning`'s threshold) and
  `indexWarningTokens`, with the documented priority env > page > file > default — so lever 1's
  threshold can no longer diverge from what Settings → AI settings shows. `proxyConfig()` takes an
  optional second `cwd` argument now (defaults to `process.cwd()`, fully backward compatible).
- **`lib/memory-rules.js`**: `lightConfig()` gets the exact same two fixes (both config locations,
  plus the page's saved tuning for `largeNoteTokens`/`splitChunkTokens`) — the rules text's own
  "keep notes under N tokens" line now matches Settings too. `lightConfig()` and
  `computeRulesText()` both take an optional second `cwd` argument, backward compatible.
- **`lib/cost.js`**: kept a pure module (no `fs`) on purpose; its own fallback constants are now
  commented as required to equal `lib/defaults.js`'s, checked by a test.

### Tests

- `test/defaults.test.js` (new, 13 tests): `resolveConfigFiles` precedence (explicit alone, cwd
  over home, home-only, neither, divergence warning, strict vs non-strict throwing), `resolveInt`
  priority, `readSavedTuning`, the "no divergence" cross-module checks, and the end-to-end lever-1
  / rules-text fix (a page-saved `largeNoteTokens` now actually changes what the proxy and the
  rules text use, with env still winning over everything).
## 0.4.8.1 — internal (not published)

**Memory server "all-in-one": one process, one container, one port.**

- `memglow memory-server --levers` (env `MEMGLOW_MEMORY_LEVERS=1`) applies the MCP proxy's levers,
  memglow's memory rules and the proxy's activity reporting **inside** the memory server
  (`memory-server/all-in-one.js`), around its own JSON-RPC dispatch: before dispatch the levers'
  `clientMessage` (strips `memglow_*` arguments, records pending calls), after it `serverMessage`
  (stubs, warnings, hints, dedupe…). Same settings as the proxy (`MEMGLOW_PROXY_*`,
  `memglow.config.json` → `"proxy"`, `MEMGLOW_DATA_DIR`), built through the levers' public API
  only. `--name` / `--source` as for the proxy (default name `memglow-memory`).
- multiQuery (`memglow_queries`) calls the server's own search once per phrasing, in process,
  then merges with the proxy's merge code.
- The levers' note index points at `<root>/memory` (or the root) unless `MEMGLOW_MEMORY_DIR` is
  set, and is rescanned right after the server's own writes (also `move_note` / `delete_note`).
- Activity reports use a new channel, `memory-server` (accepted by the viewer's `/api/activity`
  and shown as "memory server" in the journal).
- Sessions: the `Mcp-Session-Id`, including for the `initialize` that opens the session (its
  clientInfo and the "once per session" memory rules land in that session); stateless 2026-07-28
  calls get one session per connection. Unlike the HTTP proxy, which keys every request without a
  session id (every `initialize`, every stateless call) as one shared "default" session — so,
  through the proxy, only the first client after a restart gets the memory rules.
- Equivalence test (`test/memory-server-all-in-one.test.js`): one scripted session (initialize,
  tools/list, search with `memglow_queries`, reads → dedupe / alreadyLoaded / sizeWarning, writes →
  duplicateHint + sizeWarning, edit, read → delta, recent_activity, a stateless call, a batch)
  replayed through "proxy → memory server" and through "memory server --levers": identical
  response bodies and activity reports.
- `bench/all-in-one-speed.js`: latency of both set-ups side by side (200 notes, in one process,
  medians): search ≈5 ms vs ≈8 ms through the proxy, multiQuery ≈10 vs ≈19 ms, read ≈2.4 vs ≈4.7 ms,
  write ≈31 vs ≈33 ms (the write itself dominates).
- README: "All-in-one: one container" — a `docker run` for one container on port 8765, and the
  migration from the two containers (and the rollback).
- Without `--levers` nothing changes.

## 0.4.6 — 2026-10-09

The first published version since 0.4.1. It is 0.4.5 below plus one fix. 0.4.5 was tagged but never
reached npm, because its release run failed on the test that this version fixes.

### Fixed

- **MCP proxy, lever 11 (`negativeCache`): a write in the same millisecond as the previous change
  could go unnoticed.** The "has the memory changed" fingerprint used only the note count and the
  latest modification time. On a fast machine, an append landing in the same millisecond left both
  unchanged, so a stale "this search finds nothing" verdict could survive the write. The
  fingerprint now also includes the sum of note sizes and of modification times. This was found by
  the GitHub Actions release run of 0.4.5 (1 failing test out of 631).

## 0.4.5 — 2026-10-09

**Tagged, never published** (see 0.4.6 above). Everything below
summarises, for users, the internal steps 0.4.2 → 0.4.5.2c made since the last published
version, 0.4.1. Each item links to its detailed section further down this file by version
number.

### Memory server

- A new, separate **memglow memory server**: memglow itself as an MCP memory server, tool- and
  text-compatible with basic-memory (same tool names and arguments, same note folder, your
  Markdown stays the source of truth) — read tools first (0.4.5.1), then the four write tools
  (`write_note`, `edit_note`, `move_note`, `delete_note`), off unless `--read-write` is given
  (0.4.5.2). Hardening and review-fix passes followed on both the read side (0.4.5.1b) and the
  write side (0.4.5.2b, 0.4.5.2c) — see Fixes below.

### MCP proxy

- Six new optional levers that make an assistant find notes faster or read less, all off by
  default except where noted: lever 8 `alreadyLoaded` (0.4.2.1, hardened in 0.4.3.1), lever 10
  `aliases` + `learnAliases` learned from past searches (0.4.2.3/0.4.2.4, **on by default** since
  0.4.2.5), lever 11 `negativeCache` and lever 12 `indexHint` (0.4.2.6), lever 13 `deltaRead`
  cross-session delta reads (0.4.3), and lever 14 `duplicateHint` on a near-duplicate `write_note`
  (0.4.4.1). Lever 9 `multiQuery` (several search phrasings in one upstream round trip) shipped
  **on by default** (0.4.2.2b). `searchDetails` and `suggestions` (levers 2-3) were turned off by
  default after real-usage measurement showed no net benefit (0.4.2.2).
- Per-client token accounting, shown as "By AI tool" in the Memory cost panel (0.4.2).

### Memory maintenance

- **Index trim**: a deterministic proposal to shorten over-length index lines (0.4.4.2).
- **Scheduled maintenance proposals**: a ranked list — dormant sections, over-threshold notes, an
  index-trim opportunity — rescanned on a timer, surfaced in the viewer and as an MCP tool
  (0.4.4.3).
- **Cache-stable always-loaded prefix**: the index + memory-hygiene text an assistant loads at
  every session start is now assembled in a deterministic order, with a measure of how often it
  actually changes (prompt caching only pays off when it stays byte-identical) (0.4.4.3, 0.4.4.4).

### Measurement

- Multi-question bench sessions, a tokenizer accuracy check, and "effective tokens" (counting a
  dropped retry call, not just raw tokens) in the free replay harness `bench/replay.js` (0.4.2,
  0.4.2.5).
- `bench/compat.js`, an A/B harness comparing the memglow memory server with basic-memory call by
  call (latency, identical reads, search overlap, text shape), and `bench/memory-server-speed.js`
  (0.4.5.1).

### Fixes

- A cold review of the memory server's read side (0.4.5.1b) and two review passes of its write
  side (0.4.5.2b, 0.4.5.2c) fixed data-loss, race, path-escape and frontmatter-corruption risks
  found by adversarial review and a dry run against a real knowledge base — each with its own
  regression test.
- A production bug in the `alreadyLoaded` lever that could stub a `SessionStart` injection hook's
  own read of the index (0.4.3.1).
- MCP proxy `multiQuery` merge: a page's own frame was sometimes counted as a hit (0.4.5.1); a
  `sizeWarning` after a write could report a stale (pre-write) size (0.4.5.1b).

## 0.4.5.2c — internal (not published)

"Cold-review fixes, write side." Each with a regression test in
`test/memory-server-write-fixes.test.js`.

### Fixed

- append/prepend on a missing note named by a project-prefixed permalink (`main/memory/x`) no
  longer creates a stray `main/` tree with a `main/main/…` permalink: the prefix is dropped
  whatever the identifier form (kept only if the root really has a `<project>` folder).
- Case-insensitive name collisions (the share is reached over SMB): a name differing only by case
  from an existing file or folder is that file or folder — write_note refuses it (or overwrites it
  with `overwrite=true`), move_note refuses it.
- A metadata merge keeps the frontmatter's comment and blank lines.
- Section operations: setext headings (`Title\n===` / `---`) are headings; a code fence that is
  never closed makes them refuse with a clear error instead of hiding the headings after it.
- Every frontmatter written is read back before the write (refused on mismatch); keys like
  `a:b` are read correctly; NEL / LINE / PARAGRAPH SEPARATOR are written escaped in double quotes.
- move_note refuses symbolic links (a note, or a directory containing any) instead of breaking them.
- Ownership: a startup warning when the server's user does not own the notes folder (run it as
  the folder's owner — 1045:100 on the NAS — or as root); as root, new files and folders are
  group-writable when their parent folder is.
- Startup removes temp files left by an interrupted write (exact names only, inside the root,
  older than a minute) and reports notes present under several paths (an interrupted move leaves
  two hard links) or permalinks; diagnostics list them.
- The temp file name is short (`.mg-<8 hex>.tmp`): a 240-character title works.
- `## C#` is the heading "C#" (a closing `#` run needs a space before it; read side too).
- Mixed line endings: lines an edit does not touch keep their own ending; new lines take the
  note's dominant one.

## 0.4.5.2b — internal (not published)

"Write-side review fixes." An adversarial review of 0.4.5.2 (data loss, races, path escape,
frontmatter corruption, crash paths), plus a dry run of every write tool on a scratch copy of a
real 265-note knowledge base (metadata merge, append, section replace, move, delete: every
change exactly the one asked for, every read-back identical).

### Fixed

- **Metadata-only edits** (`append` with empty content + `metadata`) no longer add a final newline
  to a file that had none: empty content leaves the body untouched.
- **Frontmatter corruption guard**: after changing keys, the block is read back; every changed key
  must hold its new value and every other key its old one, else nothing is written (a quoted value
  continued at column 0 could otherwise be cut by the line-based edit).
- **Frontmatter reader** (phase A too): multi-line quoted values are folded as YAML does (blank
  line = newline, escaped line break, `\\x`/`\\U`/`\\e`… escapes), plain list items folded over
  several lines, quoted keys with escapes, a comment after a quoted value. The writer's output
  reads back exactly (seeded fuzz test); parsing of the real notes is unchanged.
- **Ambiguous identifiers**: edit/move/delete refuse an identifier that only matches by title or
  file name and fits several notes (they used to pick the first one).
- **Overwrite keeps the old version**: `write_note(overwrite=true)` copies the previous file to
  `.trash/<timestamp>/` before replacing it.
- **Unicode normalisation**: a folder or file name differing only by NFC/NFD (a Mac over SMB) is
  reused instead of creating a twin; new names are written in NFC.
- **Ownership when running as root**: the `.trash` folders and the overwrite backups now get the
  parent folder's / original file's owner too.
- A frontmatter error during an overwrite is a clear tool error (was "internal error"); with
  `--update-permalinks-on-move`, a permalink that cannot be rewritten safely is left as it was
  instead of failing a move that already happened.
- `edit_note` creating a note from a path identifier ending in `.md` no longer makes `x.md.md`.

## 0.4.5.2 — internal (not published)

"The memory server, write side." Phase B of replacing basic-memory: the four write tools, with
basic-memory's arguments, defaults and answer shapes, and the file layout its notes already have.
Writes are OFF unless `--read-write` is given (a shadow deployment stays read-only). package.json
stays 0.4.3.

### Added

- **`write_note`**: `<directory>/<title>.md` (title → file name and path → permalink by
  basic-memory's rules: accents transliterated, camelCase split, apostrophes dropped, CJK kept);
  frontmatter `title`, `type`, `permalink`, metadata keys, `tags` written by a YAML writer that
  reproduces basic-memory's layout (checked byte-for-byte against 222 real notes: quoting, folding
  after column 80, unindented block lists); content frontmatter merged (its `type`/`permalink`
  honoured, a plain date kept unquoted); an existing note is refused unless `overwrite=true`
  (`--overwrite-default`); a permalink already declared elsewhere gets `-1`, `-2`…; aliases
  `folder`/`dir`/`path`; text and JSON answers.
- **`edit_note`**: append, prepend (after the frontmatter), find_replace (exact count, the
  frontmatter must stay readable), replace_section (with or without sub-sections),
  insert_before_section, insert_after_section (headings matched exactly, code blocks ignored;
  missing or duplicated heading → error); `metadata` merges keys (title/type/permalink ignored,
  null refused) rewriting only the keys whose value changes; append/prepend on a missing note
  create it; CRLF and BOM kept; argument aliases (`new_content`, `find`, `heading`…).
- **`move_note`**: note (path or folder) or directory; never over an existing file; permalink kept
  (`--update-permalinks-on-move` to follow the path).
- **`delete_note`**: moves to `.trash/<timestamp>/…` (never indexed, never served); one note
  answers `true`/`false`; directories too.
- **Writer** (`memory-server/writer.js`): one write queue, confinement to the root's real path,
  atomic writes (temp dot-file, fsync, rename, folder fsync; `--no-fsync`), retry when the file
  changed on disk mid-edit, no-clobber creation, mode kept or `--file-mode`, owner taken from
  the parent folder when running as root, size limit, `--on-write CMD` snapshot hook (debounced
  ≥ 10 s, `MEMGLOW_CHANGED_FILES`), the store updated in place after each write.
- Transports: write answers are awaited (HTTP, batches, stdio — which now exits only after
  pending writes are answered); SIGINT/SIGTERM wait for queued writes (10 s at most).
- Tests: `memory-server-write.test.js`, `memory-server-write-safety.test.js` (50 parallel
  edits, crash mid-write, on-disk change mid-edit, symlink escape, modes, hook, transports),
  `memory-server-write-golden.test.js` (11 synthetic note shapes vs basic-memory's layout),
  `memory-server-write-proxy.test.js` (proxy levers in front: duplicateHint, sizeWarning,
  alreadyLoaded after a write).

### Differences from basic-memory (deliberate)

- `replace_section` on a heading that does not exist is an error (no section is appended).
- A file name that would start with "." (e.g. a title "../x") is refused instead of creating a
  hidden file; transliteration covers Latin, Greek, Cyrillic and common symbols only.
- `checksum:` in edit answers is the real one (basic-memory sometimes prints `unknown`).
- Frontmatter keys a write does not change are kept as they are (basic-memory re-dumps the whole
  block on some edits).
## 0.4.4.4 — internal (not published)

"Cache-stable always-loaded prefix." An LLM provider's prompt cache only pays off while the start
of the prompt stays byte-identical between calls; memglow's own always-loaded prefix (the index
note's text + its rendered memory-hygiene rules) silently broke that every time either one so much
as reordered, because `lib/memory.js` scanned the notes folder in raw `readdirSync` order — never
promised stable by any filesystem. This step makes that order deterministic and adds a small,
honest measure of how often the prefix actually changes, with a tip only when it changes often.

### Changed

- **`lib/memory.js`**: `walk()` now sorts directory entries by name before recursing, so
  `costNotes()`, `graph()` and every list derived from them are always in relative-path order,
  whatever order the filesystem's own `readdirSync` happens to return. No test relied on the old
  (incidental) order.

### Added

- **`lib/always-loaded.js`**: `prefixHash(indexText, rulesText)` (sha256, 16 hex characters) and
  `createPrefixHistory({ dir, now })`, which records in `<dataDir>/prefix-history.json` only an
  actual CHANGE of hash (never the bootstrap entry) and answers `{ changesLast7d, changesLast30d
  }`. `prefixStatus({ dataDir, indexText, rulesText, now })` combines both and adds a `tip`, non
  empty only once the prefix changed `PREFIX_TIP_THRESHOLD` (3) times or more in the last 7 days:
  *"The always-loaded prefix changed N times this week; every change invalidates prompt caching
  (cached input costs ≈0.1×). Batch index edits."* Also `shareStable(before, after)`: the share of
  `before` that is still the literal, unbroken start of `after` (1 = identical, 0 = the very first
  character already differs) — the practical measure of how cache-friendly an edit was, not a diff
  size.
- **`lib/memory-rules.js`**: no code change needed — `buildRulesText()` was already free of dates
  and unordered object iteration; added a regression test that an identical config, even with its
  own keys in a different order, renders byte-identical rules text every time.
- **`server.js`**: `GET /api/cost`'s `alwaysLoaded` gains a `prefix: { hash, changesLast7d,
  changesLast30d, tip }` (read fresh each call, like the existing `indexTrim` plan summary); a tip
  line appears in the Memory cost panel's "Always loaded" block next to the index/file tips.
- **`mcp-server/memglow-mcp.js`**: `memory_health`'s data gains the same `prefix` figure and, when
  present, its tip in the summary — computed strictly READ-ONLY (it never calls `.record()`, so
  this tool never writes `<dataDir>/prefix-history.json`; only the viewer process does).
- **UI** (`public/cost.js`): `always.tipPrefix` tip line, translated, 8 languages.
- **Measurement**: a test scans `demo/memory` twice, independently, and checks the rendered
  always-loaded prefix is byte-identical both times (`shareStable` = 1) — the order fix above is
  what makes that guaranteed rather than incidental.
- `test/always-loaded.test.js` (7 tests: hash stability, history bootstrap-vs-change counting and
  7/30-day windows, the tip threshold, `shareStable`, the demo-memory measurement, the `/api/cost`
  and `memory_health` wiring including the read-only guarantee) and one more test each in
  `test/memory.test.js` (sorted `costNotes()`/`graph()`, written in reverse order on purpose) and
  `test/memory-rules.test.js` (byte-identical rules text, key order independent).

## 0.4.4.3 — internal (not published)

"Scheduled maintenance proposals." memglow already has three deterministic, no-AI detection tiers
— dormant sections (`lib/archive.js`), over-threshold notes (Memory cost's own split hint) and an
index-trim plan (`lib/index-trim.js`) — but each needed its own tab and its own click to even find
out there was something to do. This step runs the same three detectors on a schedule, ranks what
they find by estimated token gain, and surfaces one short list — still only a PROPOSAL: applying
an item starts the very same `propose` → diff → confirm token → backup → atomic apply → undo
pipeline (`lib/assistant/index.js`) as the Memory cost panel's own buttons. memglow never applies
maintenance by itself.

### Added

- **`lib/maintenance.js`**: `computeMaintenance({ memory, config, dataDir, now, readOnly })` →
  `{ generatedAt, items }`. `items`: one per dormant section (`kind: "archive"`, `target` = the
  section's key), one per note above `largeNoteTokens` (`kind: "split"`, `target` = the note id,
  `why` includes the `split_plan` packing as a hint), and at most one index-trim item (`kind:
  "indexTrim"`, only when it would save at least `MIN_INDEX_TRIM_GAIN` (20) tokens/session) —
  ranked by `gainTokens`, ties broken by id. Ids are a stable hash of `kind + target`
  (`itemId()`), so a dismissed item stays dismissed across rescans even as the ranking shifts.
  `readOnly: true` (mcp-server's own use) skips the archive tier's section log entirely, so the
  call never touches `<dataDir>/section-ages.json` either — the default (the scheduler's own use)
  advances it exactly like `server.js`'s existing archive detection already did.
- **Scheduler** (`createScheduler`): runs `computeMaintenance` once immediately, then every
  `config.maintenanceEveryHours` (default 24, env `MEMGLOW_MAINTENANCE_EVERY_HOURS`, 0 = no
  repeat — the start-up scan still runs once), via an injectable `setIntervalFn`/`clearIntervalFn`
  for tests. Never writes a note. `createMaintenanceStore({ dir })` persists the latest scan in
  `<dataDir>/maintenance.json` and a dismissed-ids list in `<dataDir>/maintenance-dismissed.json`
  (atomic writes, capped at 500 entries); `write()` filters out already-dismissed ids, `dismiss()`
  removes an id from the cached result right away, before the next scheduled rescan even runs.
  In `server.js`, construction itself touches neither the notes nor the memory model (no scan): a
  real deployment (`main()`) starts the scheduler right after `listen()`; a caller that only uses
  `createServer()` directly (every Node test) gets it lazily instead, the first time `GET
  /api/maintenance` is actually requested — exactly like `cost()`/`alwaysLoaded()` already only
  scan once something is actually asked for.
- **HTTP**: `GET /api/maintenance` (available even with the assistant disabled: the list is
  informational); `POST /api/maintenance/dismiss { id }` (same-origin CSRF header, rate limited,
  strict id shape). Neither route ever writes a note.
- **UI** (`public/cost.js`): a "Maintenance (N)" block in the Memory cost panel, fetched
  alongside (never blocking) the main `/api/cost` load; each item shows its title, why and
  estimated gain, with a "Do it" button that dispatches the matching existing event
  (`memglow:archive`/`memglow:assistant`/`memglow:indexTrim` — the normal proposal flow, nothing
  applied here) and a "Dismiss" button. 8 languages.
- **MCP server** (`mcp-server/memglow-mcp.js`): read-only tool `maintenance_proposals` — the same
  list, computed fresh with `readOnly: true` on every call (no cache file, no counter advanced).
  Updated the stale "Seven read-only tools" header count (now eight).
- **Config**: `maintenanceEveryHours` (default 24, 0–8784, env
  `MEMGLOW_MAINTENANCE_EVERY_HOURS`).
- `test/maintenance.test.js` (11 tests: archive/split/indexTrim detection and ranking, stable ids
  across independent computations, `readOnly` never touching the data folder, a before/after
  snapshot of the notes folder proving no note is ever written, store dismiss-and-reload
  persistence, the scheduler's start/stop with an injectable timer including the 0-hours case and
  a simulated tick, the HTTP endpoints' CSRF/validation/persistence, and the config setting) and
  one more MCP tool in `test/mcp-server.test.js`.

### Full test suite (0.4.4.3 + 0.4.4.4 together)

`for f in test/*.test.js; do timeout 300 node --test --test-timeout=120000 "$f"; done` — 44
files, 578 tests (baseline 558 + 20 new: 11 `test/maintenance.test.js`, 7
`test/always-loaded.test.js`, 1 `test/memory.test.js`, 1 `test/memory-rules.test.js`), 0 fail.

package.json stays at 0.4.3 (these two tags are local, unpublished micro-steps).

## 0.4.5.1b — internal (not published)

"Review fixes." A cold review of 0.4.5.1 reproduced fourteen problems; each is fixed with its own
regression test (`test/memory-server-fixes.test.js`, two more in `test/mcp-proxy-levers.test.js`).

### Fixed

- **HTTP hardening**: a malformed request-target (`GET http://[`) threw out of the handler and
  killed the process — now 400; every request path is wrapped (500 at worst), and the CLI logs
  any escaped exception instead of dying.
- **Root confinement**: symlinked `*.md` pointing outside the root are no longer indexed (warning in
  diagnostics); `read_content` requires the real path inside the root's real path, refuses
  dot-files/dot-folders (`.git/config`) and anything but a regular file (`/proc/self/environ`).
- **Origin / token**: requests carrying an `Origin` not listed with `--allow-origin` get 403
  (no Origin = allowed, as MCP clients send); optional `--token` / `MEMGLOW_MEMORY_TOKEN` bearer
  token (401 without it; `/healthz` exempt).
- **stdio**: end of input no longer exits before stdout drains (a 7 MB answer was cut at 64 KB).
- **Permalinks**: a declared frontmatter permalink always wins over another note's path-derived
  one; two notes declaring the same permalink resolve deterministically (first in permalink, path
  order) and are listed under "Permalink collisions" in `basic_memory_diagnostics`; an explicit
  `folder/note.md` identifier is a path first. `external_id`/`entity_id` are unique per file.
- **Globs** are matched by a linear wildcard matcher (no regex backtracking: a pathological pattern
  took 49 s).
- **Limits**: queries over 2,000 characters or 64 words get a clear error; a body over 10 MB is
  refused at once (declared length, or as soon as it grows past it) instead of being read whole.
- **Protocol**: an unsupported `MCP-Protocol-Version` header → HTTP 400 (JSON-RPC -32602 with the
  supported list); an unsupported `_meta` version → the same JSON-RPC error.
- **Tool lookup** no longer reaches `Object.prototype` (`toString`, `constructor`, `__proto__`).
- **Timeframes**: "30s" accepted; a bare number means days ("7" = 7d; it was read as the year 2001).
- **build_context** honours `depth: 0` (the note alone).
- **Proxy, lever 9 merge**: a hit is everything from its `### ` heading to the next one (or the
  footer) — basic-memory's `- match:` excerpt can contain blank lines, which split one hit into
  several blocks that were then deduped away or shuffled.
- **Proxy, sizeWarning after a write**: the size is read from the file as it is after the write;
  a file not modified since the call was sent gets no warning (it used to report the old size —
  ≈10.8k tokens for a hub just cut down to ≈1.4k).

## 0.4.5.1 — internal (not published)

"The memory server, read side." basic-memory takes ≈45 s per search on the owner's NAS and
answers one request at a time; memglow already relays every call, so the upstream was the only
weak link. Phase A of replacing it: a memory server written from scratch in memglow (MIT, zero
dependencies), tool-compatible with basic-memory, with the engine and every READ tool — and no
writes yet. Clients (Claude Code, hooks, the memglow proxy and its levers) keep their tool names,
arguments and the text shapes they parse. package.json stays 0.4.3.

### Added

- **Store** (`lib/store/`): `frontmatter.js` (a YAML-subset reader for what notes really carry:
  quoted/folded scalars, flow and block lists, nested maps, block scalars; never throws, keeps the
  readable keys of a broken block), `note.js` (title, type, permalink — frontmatter first, else
  `<project>/<path>` —, tags, sections by heading, `[[links]]`, observations
  `- [category] text #tag (context)`, relations `- rel_type [[Target]]`, any other link =
  `links_to`; code blocks ignored), `store.js` (in-memory indexes by permalink with or without
  the project prefix, path, title and slug, plus the link graph; `fs.watch` recursive + an async
  stat rescan every 3 s, re-reading only changed files; a request applies a pending watch event
  first; non-UTF-8, too-large and unreadable files are skipped with a warning, BOM/CRLF handled),
  `timeframe.js` ("7d", "2 weeks", "3 days ago", "last week", "yesterday", ISO and month-name
  dates), `text.js` (accent folding, EN+FR stop-words reused from `lib/learned-aliases.js`
  minus "été", a light plural stemmer, slugs, stable UUID-shaped ids).
- **Search engine** (`lib/store/search.js`): BM25-style over weighted fields (title ≫
  permalink/slug, tags > description > headings > other frontmatter > body), prefix matching
  (3+ characters, discounted and never scored as rarer than the typed word; `term*` explicit),
  coverage, exact-title and phrase bonuses; `"phrases"` (required), `AND`, `OR`,
  `NOT`/`-word`, `tag:x`; search types text / title (exact > prefix > contains) / permalink
  (exact, prefix, `*` glob; a `memory://` query switches to it) / vector / semantic / hybrid (the
  same lexical engine — **semantic search is not implemented**); filters note_types, entity_types
  (entity, observation, relation), categories, tags, status, metadata_filters (`$in`, `$gt`,
  `$gte`, `$lt`, `$lte`, `$contains`…, dotted keys, `note_type` → `type`), after_date;
  pagination; deterministic order (score, then permalink). Per-note index entries and snippet line
  terms are cached on the note object, so a one-file change rebuilds one entry.
- **Server** (`memory-server/`): `schemas.js` (the 21 basic-memory tool names, argument names,
  types, defaults, enums and output schemas, memglow's own descriptions), `tools.js` (handlers:
  `search_notes` text/json, `read_note` — the file as stored, json with/without frontmatter,
  closest-notes fallback —, `read_content`, `view_note`, `build_context` — memory:// URL,
  `folder/*`, depth, timeframe on related notes, max_related, json/text —, `recent_activity`,
  `list_directory`, `list_memory_projects`, `list_workspaces`, `search`/`fetch`,
  `basic_memory_diagnostics`; write tools answer `memglow memory server: read-only (phase A /
  shadow mode)`, schema/project tools "not supported"), `rpc.js` (JSON-RPC: legacy
  `initialize` 2024-11-05…2025-11-25 and the MCP 2026-07-28 per-request mode, `resultType`
  on modern answers, lenient without `_meta`, batches), `http.js` (Streamable HTTP on `/mcp`:
  sessions, 2026-07-28 headers, JSON or a single SSE event, 202 for notifications, 405 on GET,
  `/healthz`), `memglow-memory-server.js` (CLI: `--root`, `--project`, `--listen`,
  `--stdio`, `--read-only`, `--poll-ms`, `--no-watch`; also `memglow memory-server …` and the
  `memglow-memory-server` bin).
- **`bench/compat.js`**: A/B harness — per call, latency A/B, read text identical or not (first
  differing line), search overlap@k and top hit, structural text-shape diff; legacy or 2026-07-28
  mode; never sends a write tool. `bench/compat-calls.example.json` uses demo data only.
  **`bench/memory-server-speed.js`**: startup, search/read median/p95/max over HTTP, 20 parallel
  searches, memory — numbers only, never note text.
- Tests: `memory-server-store`, `-search`, `-tools`, `-http`, `-proxy` (the memglow proxy
  in front of this server: search, multiQuery, read_note, alreadyLoaded) and `bench-compat`
  (+38 tests; 41 files / 547 tests, 0 fail).

### Changed

- **Proxy lever 9 (multiQuery) merge**: a page's own frame — the leading `# Search Results: …`
  block and the trailing `---` footer — is no longer ranked as a hit. Identical footers were
  "found by every phrasing" and ranked first; with small pages they pushed every real hit out of
  the cap (seen with this server's output, and true of basic-memory's identical layout). The
  first phrasing's frame now wraps the merged hits; text without a frame merges as before.

### Compatibility (vs basic-memory 4.0.0b1, captured answers)

- Identical: `read_note` text and json, `read_content` (byte for byte); same text shape for
  `search_notes` (title and text), `recent_activity`, `list_directory`, `build_context`
  text, `list_memory_projects`, the read_note miss page; same JSON keys for `search_notes`,
  `read_note`, `build_context`.
- Differs: scores and ranking (lexical, no embeddings); `- match:` is one line (basic-memory's
  multi-line chunk could split a hit into several blank-line blocks); `external_id`/`entity_id`
  are stable hashes, not basic-memory's database ids; `memory://x` resolves exactly (basic-memory
  answered `memory://project-memglow` with another note); `search`/`fetch` answer any client
  (basic-memory refuses non-OpenAI ones — the proxy's hideUnsupportedTools lever covers that);
  `depth` is accepted but not used by `recent_activity`; directories with no note are not listed.

### Measured

On a read-only copy of the owner's memory (136 notes, 1.3 MB), Node 22, a 2-vCPU container,
over real HTTP (MCP 2026-07-28 calls, `bench/memory-server-speed.js`, 3 runs): startup 0.5–0.9 s
(scan 0.18–0.24 s warm; 7.5 s once on a cold file cache); 50 varied searches median 9–17 ms, p95
38–55 ms, max ≤ 80 ms (in-process: 3.7 ms average); 50 reads median 4.2–4.9 ms, p95 6.7–10 ms;
20 searches at once 170–300 ms wall; RSS ≈ 130 MB (heap ≈ 40 MB). basic-memory: ≈45 s per search.

## 0.4.4.2 — internal (not published)

"Index trim." The memory index is loaded into **every** session, so each of its tokens is paid
every time — and real indexes drift toward one long hook sentence per note. This micro-step adds
a fully deterministic (no AI) way to shorten an over-length index line, with memglow's one
non-negotiable rule still holding: nothing is ever just dropped. A line is only shortened when the
text it loses is provably still reachable — already in the linked note's `description` or body,
or, when the note has none, moved there as a new `description:` line in the very same proposal.

### Added

- **`lib/index-trim.js`** (pure, no fs): `planIndexTrim({ indexText, notes, maxChars, tokenize })`.
  Candidate lines are exactly `- [[target]] <sep> hook` (one `[[link]]`, `<sep>` one of
  `—`/`–`/`-`); a heading, prose, an unresolved link, or a hook that already names a second note
  is left untouched. A hook over `maxChars` (default 90) is cut at the last clause boundary
  (`" — "`, `": "`, `"; "`, `" ("`, `", "`) that keeps 20-`maxChars` characters, else the last word
  boundary — no ellipsis, no paraphrase. Loss check (reusing `significantWords` from
  `lib/learned-aliases.js`, ≥80% overlap): the dropped words already in the note's `description`
  or body → kept as is; no `description` at all → the proposal ALSO writes one, the full ORIGINAL
  hook, YAML-safe quoted, the rest of the frontmatter and the whole body byte-identical; a
  *different*, insufficient `description` → the line is skipped, reported with why. Also exports
  `candidateTargets()` (which notes a caller ever needs to read — never the whole memory),
  `shortenHook`, `detailKept`, `setDescription`.
- **Assistant kind `indexTrim`** (`lib/assistant/index.js` `proposeIndexTrim({ maxChars })`):
  deterministic, no provider, finished in the same call (same template as `proposeTidy`'s/
  `proposeArchive`'s no-AI path) — one job, the index note plus any note that also gets a
  `description:` line, through the usual diff / confirm token / backup / atomic apply / Undo.
  Protected groups and the archive folder are never touched.
- **HTTP**: `POST /api/assistant/propose { kind: "indexTrim", maxChars? }`. `GET /api/cost`'s
  `alwaysLoaded` gains an `indexTrim: { lines, tokensSaved }` plan summary next to the existing
  index tip (read only — a separate call actually proposes it).
- **UI** (`public/cost.js`, `public/assistant.js`): a **"Trim the index (N lines, ≈X
  tokens/session)"** button next to the always-loaded figures (shown only with the assistant on
  and something to trim); the assistant panel gets its own title/checked-message copy for the
  `indexTrim` job kind. 8 languages.
- **MCP server** (`mcp-server/memglow-mcp.js`): read-only tool `index_trim_plan` (`maxChars`) —
  the same plan, writes nothing. Fixed the stale "Five read-only tools" header count (it was
  already six before this change; now seven).
- **Config**: `indexTrimMaxChars` (default 90, 30-1000), env `MEMGLOW_INDEX_TRIM_MAX_CHARS`.
- `test/index-trim.test.js` (20 tests: clause cut, word cut, short/heading/prose/multi-link
  lines untouched, unresolved link skipped, description/body already holds the detail → kept, no
  description → moved with the frontmatter otherwise byte-identical, a different insufficient
  description → skipped, French accented text, Windows (CRLF) line endings, idempotence, a custom
  `tokenize`), `test/assistant-index-trim.test.js` (4 tests: propose → diff → confirm → apply →
  index and note changed on disk, backup made, Undo restores bytes exactly; a hash change between
  propose and apply is refused; nothing-to-trim is an honest "invalid"; the `/api/cost` summary),
  and 2 more in `test/mcp-server.test.js` for `index_trim_plan`.

### Measured (`demo/memory`'s index, `MEMORY.md`, 31 index lines)

| `maxChars` | lines shortened | skipped | moved (new `description:`) | tokens before → after |
|---|---|---|---|---|
| 90 (default) | 0 | 0 | 0 | 801 → 801 (every hook is already ≤ 90 characters) |
| 70 | 12 | 0 | 0 | 801 → 716 (**-85** tokens/session) |
| 60 | 22 | 1 (`detail not in note`) | 0 | 801 → 666 (**-135** tokens/session) |

The demo memory's hooks were written short to begin with (max 88 characters), so the default
threshold finds nothing to do on it — an honest result, not a bug: `indexTrimMaxChars` exists
precisely so an owner whose real index drifted longer (the motivating example: a ~150-character
hook like `"memglow: open-source product from the Memory tab, github.com/R0zumnik/memglow —
releases, publishing, diffusion, backlog"`, which this planner cuts to 88 characters at its own
`" — "` clause boundary) can lower it. Every demo note already carries a `description:` matching
its index hook, so every shortened line in this run is "kept as is" — none exercises the "moved"
(new `description:`) path on this fixture; that path is covered in
`test/index-trim.test.js`/`test/assistant-index-trim.test.js` with a note that has none. The
owner's own real memory was never read for this measurement.

### Full test suite

`for f in test/*.test.js; do timeout 300 node --test --test-timeout=60000 "$f"; done` — 35 files,
509 tests (baseline 483 + 26 new), 0 fail.

package.json stays at 0.4.3 (this tag is a local, unpublished micro-step).

## 0.4.4.1 — internal (not published)

"Duplicate-write hint." memglow's own product rule is that it never writes a note itself — every
lever only ADDS advisory text to what the memory server already answered. Users' own memories
were still getting duplicate notes anyway, because the assistant would call `write_note` with a
brand new title on a subject that already had a note. This micro-step adds a 14th lever,
`duplicateHint` (OFF by default — see Measured below), that nudges the assistant toward
`edit_note` instead, without ever blocking or rewriting anything itself.

### Added

- **MCP proxy: lever 14, `duplicateHint`** (`lib/proxy-levers.js`), OFF by default. After a
  `write_note` call (never `edit_note`/`move_note`):
  - **Exact** — the `title` just used (or its kebab slug, or its label) already names an
    EXISTING note, via `index.resolve` (the same helper every other lever uses to turn a
    reference into a note id): `memglow: a note with this title already exists: [[<id>]] — this
    write_note may replace or duplicate it; prefer edit_note.`
  - **Similar**, only when there is no exact match — the title shares `>= 2` significant words
    (`significantWords`, EN+FR stop-words, secret-masked, `>= 3` characters, `lib/learned-
    aliases.js`) with an existing note's own id+label+description, AND those shared words cover
    `>= 60%` of the title's own significant words (so a title with fewer than 2 significant words
    can never match anything — deliberately conservative: a false hint costs more than a missed
    one). Index notes and archive-folder notes never count. Ranked by shared-word count then note
    size, capped to 2 candidates: `memglow: a note on this subject already exists — [[<id1>]]
    (<label1>); [[<id2>]] (<label2>). Prefer edit_note on it (append / replace_section) over a new
    note.`
  - Matched in `oneFromClient`, on the `tools/call` request itself, BEFORE the write reaches the
    server — the note this very call is about to create is never mistaken for its own duplicate.
    Advisory only, like every other lever here: never blocks, never changes the arguments sent
    upstream, never touches the write's own confirmation text (one block appended, after it). The
    same note is never hinted twice in one session (`s.duplicateHinted`, cleared at `initialize`
    like every other per-session set).
  - New pure helpers, exported from `lib/proxy-levers.js`: `duplicateHintCandidates(titleWords,
    notes)` (the matcher itself), `duplicateHintBlock(index, exactId, similarIds)` (the one-line
    builder), `duplicateHintFor(index, args)` (the glue: exact-vs-similar, index/archive
    exclusion), and `noteWords(note)`. `lib/proxy-levers.js`'s `createNoteIndex` gained
    `allNotes()` (every note's own metadata, unfiltered — the caller excludes index/archive
    notes itself).
- `MEMGLOW_PROXY_DUPLICATE_HINT` env / `"proxy": { "duplicateHint": true }` config to opt in.
- `mcp-proxy/README.md`: lever 14 documented next to the other 13 (table row + a dedicated
  "Stage 0.4.4.1" section), including the full config example.
- `bench/replay.js`: `duplicateHint` added to the lever name list (`--with`/`--each`), `LEVER_ENV`
  and `SHIPPED_DEFAULTS`.
- New fixture [`bench/replay-duplicate.jsonl`](bench/replay-duplicate.jsonl): two `write_note`
  calls against `demo/memory` — one an exact title match (`project-smart-home`, the note's own
  id), one a near-duplicate (`"Home lighting and heating automations"`, sharing "home", "heating"
  and "automations" with that note's own label/description).
- `test/mcp-proxy-levers.test.js`: 12 new tests (same file as levers 9/12 — no separate module for
  this lever) — the pure matcher, the glue, the block builder, then end to end over stdio: exact
  title/kebab-slug match, EN and FR near-duplicates, an unrelated and a generic title getting
  nothing, index/archive exclusion (both in the pure matcher and end to end), `edit_note` never
  checked, off by default, same note never hinted twice in a session (a fresh session hints it
  again), and arguments reaching the server byte-for-byte unchanged.

### Measured (bench/replay.js, `--each` on all five existing fixtures + the new
`bench/replay-duplicate.jsonl`)

| fixture | `duplicateHint` alone (raw / effective, vs off) | violations |
|---|---|---|
| `replay-demo.jsonl` | 0 / 0 (no-op: no `write_note` with a `title` resembling an existing note) | 0 |
| `replay-heavy.jsonl` | 0 / 0 (no-op, same reason) | 0 |
| `replay-aliases.jsonl` | 0 / 0 (no-op, same reason) | 0 |
| `replay-negative-cache.jsonl` | 0 / 0 (no-op, same reason) | 0 |
| `replay-delta-read.jsonl` | 0 / 0 (no-op, same reason) | 0 |
| `replay-duplicate.jsonl` | **+35 / +35** (both calls hinted; 0 calls saved) | 0 |

Same merge rule as levers 9-13 (0 violations AND effective tokens `<=` off's AND (raw tokens `<=`
off's OR calls `<` off's)): it holds — trivially — on every existing fixture, none of which has a
`write_note`-with-`title` event to begin with (exactly the "fixtures may have no
write_note-with-title events" case this stage is explicitly allowed to report as 0). But on its
OWN dedicated fixture, built specifically to make it fire, it is a pure, unconditional ADD:
advisory only, by design, it never saves a call, so raw tokens go up with nothing to offset them
— the same bucket as `searchDetails`/`suggestions`/`archiveHint`/`indexHint` at earlier stages,
and the same reasoning: the rule fails outright wherever the lever actually does something, so it
**ships OFF by default**. `MEMGLOW_PROXY_DUPLICATE_HINT=1` / `"proxy": { "duplicateHint": true }`
to opt in.

### Full test suite

`for f in test/*.test.js; do timeout 300 node --test --test-timeout=60000 "$f"; done` — 33 files,
483 tests (baseline 471 + 12 new), 0 fail.

package.json stays at 0.4.3 (this tag is a local, unpublished micro-step).

## 0.4.3.1 — internal (not published)

"Never stub the injection hook." A production bug: lever 8 (`alreadyLoaded`) answers a read of
the always-loaded index with a short stub ("already in your context…") — but a `SessionStart`
hook that INJECTS the index at session start typically reads it through this SAME proxy. If that
read gets stubbed, the session starts WITHOUT the index at all — the real hook sends
`initialize` (`clientInfo: { name: "session-start-hook", version: "1" }`), then `tools/call
read_note {identifier: "MEMORY"}` and/or `recent_activity`, with nothing in between.

### Added

- **MCP proxy: lever 8 rule 1, `alreadyLoadedExemptClients`** (config) /
  `MEMGLOW_PROXY_ALREADY_LOADED_EXEMPT` (env, comma-separated) — a session is never stubbed by
  lever 8 (not even given the "changed since session start" notice: the exact upstream text,
  always) once its `clientInfo.name`/`.title` (sent at `initialize`) contains one of these
  substrings, case-insensitively. Default `["hook", "inject", "session-start", "sessionstart",
  "memglow-init"]`; `[]`, or the env var set to an empty string, is a deliberate empty list
  (disables the exemption). New pure helper `clientInfoExempt(ci, substrings)` in
  `lib/proxy-levers.js`, exported for tests.
- **MCP proxy: lever 8 rule 2, `alreadyLoadedRequireActivity`** (default **true**) — independent
  of any client name: the STUB itself (never the "changed" notice, which never shortens anything)
  is refused unless this session already made at least one OTHER tool call, or a `tools/list`,
  before this read. An injector characteristically reads the index as the very first thing after
  `initialize`; an assistant mid-conversation has almost always listed tools or made another call
  by the time it re-reads the index. `MEMGLOW_PROXY_ALREADY_LOADED_REQUIRE_ACTIVITY=0` / `"proxy":
  { "alreadyLoadedRequireActivity": false }` to turn it off.
- `mcp-proxy/README.md`: a new subsection under lever 8 documenting both guards for hook authors,
  and the existing `memglow_fresh: true` escape hatch as the one unconditional, lever-proof way
  for an injection hook's own read to always get the full text, with a worked `tools/call` example.

### Measured (bench/replay.js, `--with alreadyLoaded`, `alreadyLoadedRequireActivity` at its
shipped default of `true`, no exempt match in any fixture — none of their sessions name a
`clientInfo`)

Rule 2 costs some of lever 8's own measured gain wherever a fixture's session starts with an
immediate read of the index (exactly the shape this rule is designed to be cautious about) — but
never erases it, and 0 violations throughout:

| fixture | +alreadyLoaded, before 0.4.3.1 | +alreadyLoaded, after (rule 2 on) | violations |
|---|---|---|---|
| `replay-demo.jsonl` | 14 calls / 1578 tok / +3710 eff. saved | 14 calls / 3062 tok / +2226 eff. saved | 0 |
| `replay-heavy.jsonl` | 60 calls / 7226 tok / +45355 eff. saved | 60 calls / 10194 tok / +42387 eff. saved | 0 |
| `replay-aliases.jsonl` | — | 14 calls / 783 tok / +9975 eff. saved | 0 |
| `replay-negative-cache.jsonl` | — | 5 calls / 242 tok / +10748 eff. saved | 0 |
| `replay-delta-read.jsonl` | — | no-op (lever never matches there) | 0 |

The gain survives, with margin, on every fixture tested, so rule 2 ships ON by default as
designed — see lib/proxy-levers.js DEFAULTS.alreadyLoadedRequireActivity for the reasoning. Had
any fixture's gain gone to zero or negative, rule 2 would have shipped off, keeping only rule 1
(the exempt-client list) — it did not.

### Fixed

- Two existing lever-8 tests in `test/mcp-proxy-levers.test.js` read the index right after
  `initialize` with no other call in between — exactly the shape rule 2 now treats cautiously.
  Updated to send a `tools/list` first (what any real assistant session does), so they keep
  testing the stub itself rather than passing vacuously on content length alone.

package.json stays at 0.4.3 (this tag is a local, unpublished micro-step).

## 0.4.3 — internal (not published)

"Cross-session delta reads." Since 0.4.1, six internal micro-steps (0.4.2 → 0.4.2.6) built up the
MCP proxy's lever system one measured lever at a time: lean defaults for `searchDetails`/
`suggestions` (0.4.2.2), `multiQuery` — several search phrasings in one upstream round trip
(0.4.2.2b, shipped ON), `aliases`/`learnAliases` — the owner's own search log taught back to the
proxy (0.4.2.3/0.4.2.4, shipped ON at 0.4.2.5 once the harness learned to count a dropped CALL,
not just raw tokens — "effective tokens" = tokens + calls × a per-turn overhead), and
`negativeCache`/`indexHint` (0.4.2.6, both shipped OFF: a real, unmodelled cost on one fixture for
the first, no call ever saved for the second). This stage adds a 13th lever, `deltaRead` (OFF by
default), for a gap none of the first twelve cover: the hottest notes get **re-read in every new
session** (≈21 reads/7 days for one note, in the owner's own log) — lever 4 (`dedupe`) only
covers a re-read in the SAME session, and a brand new session's EMPTY context makes its short
"unchanged" stub actively wrong there.

### Added

- **MCP proxy: lever 13, `deltaRead`** (`lib/delta-read.js`), OFF by default (see Changed below).
  Two mechanisms:
  1. **Cross-session.** The first read of a note in a session always gets the full current text
     (never shortened for this) — the only addition is a one-line header, at most once, when the
     note changed since the LAST time this SAME CLIENT read it, in an EARLIER session: `memglow:
     changed since your last read on <date> — sections changed: <## titles>` (up to 5, "(intro)"
     for the untitled lead section). Remembered in a small persisted ledger, per client
     (`clientBucket`), `delta-read.json` in memglow's data folder — same house style as
     `negative-cache.json`/`learned-aliases.json`: atomic write, mode 600, bounded
     (`deltaReadMax`, default 5,000 entries, oldest dropped).
  2. **Within-session, note CHANGED.** The gap `dedupe` leaves open: a note already delivered in
     full THIS session (version A), re-read after it changed (now version B), falls through to a
     second full delivery today. Since the model already has A, only the DIFF to B crosses the
     wire — `renderDiff`, reusing `lib/assistant/diff.js`'s existing prefix/suffix + bounded-LCS
     line diff (the same diff code the Assistant tab's proposals already use), rendered as a
     compact, bounded, line-oriented format tagged with a `DELTA_READ_MARKER` sentinel and
     reconstructable by `applyDiff` given version A — with a header naming the escape hatch. Too
     large a diff (> 60% of B, `DIFF_FALLBACK_RATIO`) or one that hit the hard `MAX_DIFF_LINES`
     safety bound falls back to B in full instead. Same escape hatch (`memglow_fresh`) and
     "repeat the call → full content" rule as levers 4/5/8; a successful diff delivery updates
     BOTH the within-session bookkeeping (`s.deltaText`) AND the cross-session ledger (this
     client now has B, even though it arrived as a diff).
  - Pure logic in `lib/delta-read.js`: `sha1Hex`, `sectionFingerprints` (reuses `lib/cost.js`'s
    `sectionSpans`), `changedSectionTitles`, `crossSessionHeader`, `renderDiff`/`applyDiff`
    (round-trip tested: `applyDiff(before, renderDiff(before, after).text) === after`),
    `worthDelivering`; the one fs-touching piece, `createDeltaReadStore`.
  - Wiring in `lib/proxy-levers.js` `handleRead`: a new session field `deltaText` (version A's
    text, cleared on `initialize`), a `firstReadThisSession` flag captured BEFORE `s.read` is
    updated for it (dedupe's `s.read` is reused, not duplicated), the within-session diff slot
    placed right after lever 4's own "unchanged" check (so it only ever sees the "changed" case
    dedupe's own `if` did not already handle), and the cross-session header/ledger-write folded
    into the existing "full delivery" block (alongside levers 1/3) since mechanism 1 never
    replaces anything. `createLevers` takes an optional `deltaReadStore` (new `NOOP_DELTA_READ_
    STORE` default, same shape as the alias/negative-cache no-op stores); wired into
    `mcp-proxy/memglow-mcp-proxy.js` (`setupLevers`, flushed on exit) and `bench/replay.js`.
  - `createSavings` gained a `deltaRead`/`deltaReadCalls` bucket alongside `dedupe`/`toc`/
    `alreadyLoaded`.
- **`bench/replay.js` correctness guard**: `isReachable` now understands a delta-read diff
  delivery (`deliveredText` carrying `DR.DELTA_READ_MARKER`) — reachable iff `DR.applyDiff`,
  given the session's own `previousFullText` (now tracked alongside the existing
  `previousFullHash`), truly reconstructs the real, current file. A REAL check, not the
  escape-hatch loophole the other branches fall back to: a diff that reconstructs the WRONG text
  (or arrives with no known `previousFullText` to check it against) is a VIOLATION even though
  its own header also names `memglow_fresh`.
- New fixtures: [`bench/replay-delta-read.jsonl`](../bench/replay-delta-read.jsonl) (one note
  read, edited and re-read in the same session, edited again and read from a brand new session,
  plus a same-session unchanged re-read and a later unchanged first read — pinning "no header/
  diff when nothing changed") and
  [`bench/replay-delta-read-portal.json`](../bench/replay-delta-read-portal.json) (the same idea
  through the owner-style portal shape).

### Changed

- **`deltaRead` ships OFF by default.** `--each` against `off`, on all five fixtures above plus
  the pre-existing three (`replay-demo.jsonl`, `replay-heavy.jsonl`, `replay-aliases.jsonl`,
  `replay-negative-cache.jsonl`):

  | fixture | raw / effective tokens, vs off |
  |---|---|
  | replay-demo.jsonl | -11 / -11 |
  | replay-heavy.jsonl | -11 / -11 |
  | replay-aliases.jsonl | 0 / 0 (no-op) |
  | replay-negative-cache.jsonl | 0 / 0 (no-op) |
  | replay-delta-read.jsonl | **-5992 / -5992** |

  The merge rule (0 violations AND effective tokens `<=` off AND (raw tokens `<=` off OR calls
  `<` off)) holds on every file, with margin, and unlike `negativeCache`/`indexHint` at 0.4.2.6
  there is no file where it costs anything — the header never even fires outside its own
  dedicated fixture. Still shipped OFF: `multiQuery` and `aliases` both flipped to ON only after
  a real, multi-day usage log backed the decision (0.4.2.2b, 0.4.2.5) — a clean sweep on
  hand-built replay files is encouraging, not the same bar, and this lever starts a brand new
  per-client ledger file on disk the moment it is on. `MEMGLOW_PROXY_DELTA_READ=1` /
  `"proxy": { "deltaRead": true }` to opt in.
  [`bench/replay-delta-read-portal.json`](../bench/replay-delta-read-portal.json) comes back
  identical to `defaults` — a no-op **by construction**: the portal log's `ecriture` events carry
  only a note id, never content (the whole point of that format), so `portalToCalls()` turns one
  into an `edit_note` call with `content: ""`, which never actually changes the replayed note.
  An honest limit of the measurement format, not evidence against the lever.
- `README.md`, `mcp-proxy/README.md` and `bench/README.md`: lever 13 documented in the levers
  table, a new "Stage 0.4.3" section in each of the latter two, and the `deltaRead`/
  `deltaReadMax` keys added to the `memglow.config.json` example.

### Tests

- `test/delta-read.test.js` — pure pieces (`sectionFingerprints`, `changedSectionTitles`,
  `crossSessionHeader`, `renderDiff`/`applyDiff` round-trips including a brand-new note, a
  deletion, truncation past `MAX_DIFF_LINES`, and the > 60% fallback threshold, `worthDelivering`)
  plus the one fs-touching `createDeltaReadStore` (disabled without a data folder or with the
  switch off, atomic write, mode 600, bounded with oldest dropped first, invalid entries never
  stored, a malformed file on disk treated as empty).
- `test/delta-read-levers.test.js` — integration through `createLevers`: the first read of a note
  in a session is always full; a within-session re-read after a change gets a reconstructable
  diff; repeating the call (or `memglow_fresh`) returns the full text again; an unchanged
  re-read is untouched (dedupe's job, not this lever's); a near-total rewrite falls back to the
  full text; a new session's first read of a changed note gets the header naming the changed
  section; no header when nothing changed, even across sessions; a within-session diff delivery
  also updates the cross-session ledger; the ledger persists across a brand new engine/store
  pointed at the same data folder (a process restart); off by default end to end; and a
  deliberately broken store never breaks the relay.
- `test/bench-replay.test.js`: `isReachable`'s new diff-reconstruction branch (a valid diff with
  its matching `previousFullText` → reachable; missing `previousFullText`, or a diff that
  reconstructs the wrong text → a violation despite the escape-hatch text; `deliveredFull` still
  takes priority even if the text happens to also contain the marker), plus an end-to-end
  `runConfig` test over `bench/replay-delta-read.jsonl` pinning "0 violations everywhere, fewer
  tokens with `deltaRead` on".
- `npm test` green (465 tests).

## 0.4.2.6 — internal (not published)

"Negative cache + the index already answers."

### Added

- **MCP proxy: lever 11, `negativeCache`**, OFF by default (see Changed below). The owner's own
  log: 12 of 40 searches led to NO READ AT ALL — not a wrong pick, nothing opened afterwards. A
  search in a session not followed by a read (of anything) within `ALIAS_LEARN_WINDOW_MS` (2
  minutes), or superseded first by another search or a write in the same session, is remembered,
  locally, as "futile" against the live memory's current FINGERPRINT — note count + latest
  mtime, `lib/negative-cache.js`'s `memoryFingerprint`, cheap and derived straight from the note
  index's own graph cache, no new read of any note. A LATER search sharing the same normalized,
  significant words (`lib/learned-aliases.js` `significantWords`, reused unchanged), while the
  fingerprint is unchanged, gets one line PREPENDED: `memglow: this search found nothing you used
  last time (<date>); the memory has not changed since.` **The results are always kept, never
  hidden** — this lever only ever adds a line, same correctness rule as every other lever. Any
  write anywhere bumps the fingerprint, invalidating every remembered entry at once
  ("invalidate on any write" — deliberately global, not per-note).
  - A single switch (`negativeCache`) gates both recording and using it — unlike lever 10's two
    independent switches: this is only ever a one-line, never-hides-anything nudge, so there is
    no "quietly keep learning while the hint is paused" case worth a second knob here.
  - Pure logic in `lib/negative-cache.js` (`normalizedKey`, `memoryFingerprint`,
    `recordFutileEntries`, `lookupFutileEntry`, `forgetStaleEntries`, and the one fs-touching
    piece, `createNegativeCacheStore` — same atomic-write/mode-600/bounded shape as
    `lib/learned-aliases.js`'s `createAliasStore`, file `negative-cache.json` next to
    `learned-aliases.json`). Wiring in `lib/proxy-levers.js`: `createNoteIndex` gained
    `fingerprint()` (cached alongside the rest of its derived graph cache); `createLevers` gained
    a session field `pendingNegative` and a shared `finalizePending()` helper called from
    `handleSearch` (a new search supersedes whatever was pending), `handleRead` (any read redeems
    it, in time or too late), `handleWrite` (a write supersedes it too, then forces a rescan and
    prunes stale entries), and from LRU session eviction and a new `engine.negativeCache
    .flushPending()` (called on process exit in `mcp-proxy/memglow-mcp-proxy.js`, alongside
    `savings.flush()`/`aliasStore.flush()`) — so a search that is simply never followed by
    anything else in its session is still settled as futile, not silently lost.
  - **Known gap**: a search merged by lever 9 (`multiQuery`, `memglow_queries`) bypasses
    `handleSearch` entirely (`multiQuery.run()` answers the whole burst outside the normal
    `clientMessage`/`serverMessage` cycle — same limitation lever 10 had before 0.4.2.5), so this
    lever neither learns from nor hints into a MERGED multi-phrasing call; only a lone search
    (no burst) goes through it. Left as is for this stage — see CHANGELOG 0.4.2.5 for how lever
    10 closed the equivalent gap, a template for doing the same here later.
- **MCP proxy: lever 12, `indexHint`**, OFF by default (see Changed below). The owner's own log:
  the index note was read in full 6 times (≈16k tokens), each time without knowing in advance
  whether it actually answered the question. A search whose own results are ONLY the index note,
  or a read of the index itself while lever 8 (`alreadyLoaded`) is off, gets a suffix: `memglow:
  the index already says:` followed by up to 3 lines of the index's OWN text (secret-masked via
  `lib/memory.js`'s `maskedBody`, each capped to 160 characters) that mention one of the query's
  significant words — grepped, never summarised, and never replacing the note's own content. The
  read case reuses lever 10's own "search right before a read" correlation (`s.lastSearch`,
  extended to populate even with `learnAliases` off, as long as `indexHint` is on) to know what to
  grep for; with no recent search at all, nothing is added — never a bare "says:" line with
  nothing after it. New `indexHintLines`/`indexHintBlock`/`INDEX_HINT_MAX_LINES`/
  `INDEX_HINT_LINE_MAX` in `lib/proxy-levers.js`, exported for testing.

### Changed

- **`bench/replay.js`**: new fixture
  [`bench/replay-negative-cache.jsonl`](../bench/replay-negative-cache.jsonl) (3 sessions, 7
  calls) built specifically to exercise lever 11 — a search superseded with no read (futile), a
  second search redeemed by a read (not futile), then a dedicated session where the SAME search
  recurs once the memory is unchanged. `dropIfHinted` now also works WITHOUT `expect` (which is
  alias-specific, "a note id this search is about"): a new `lastNegativeCacheHinted` map tracks,
  per session, whether the MOST RECENT search's delivered text carried the negativeCache hint
  line, and a marked retry is dropped when either that OR the existing `expect`-based condition
  holds — additive, so every previously-recorded number for `bench/replay-demo.jsonl`,
  `bench/replay-heavy.jsonl` and `bench/replay-aliases.jsonl` is unchanged (verified: this lever
  is off by default, and the hint text never appears when it is off, so the new tracking is
  always `false` for every existing fixture/configuration unless `negativeCache` is explicitly
  turned on). `SHIPPED_DEFAULTS`/`LEVER_ENV` gained the two new lever names.
- **Levers 11/12 both ship OFF by default**, decided by the SAME merge rule 0.4.2.5 introduced (0
  violations AND effective tokens `<=` off's AND (raw tokens `<=` off's OR calls `<` off's)),
  `--each` on `bench/replay-demo.jsonl`, `bench/replay-heavy.jsonl`, `bench/replay-aliases.jsonl`
  and the new `bench/replay-negative-cache.jsonl`:

  | fixture | `negativeCache` alone (raw / effective, vs off) | `indexHint` alone (raw / effective, vs off) |
  |---|---|---|
  | replay-demo.jsonl | 0 / 0 (no-op) | +96 / +96 |
  | replay-heavy.jsonl | +52 / +52 (hint fires for real, no call saved to offset it) | +391 / +391 |
  | replay-aliases.jsonl | 0 / 0 (no-op) | 0 / 0 (no-op, never reads the index) |
  | replay-negative-cache.jsonl | +23 / **-4977** (1 call dropped) | +78 / +78 |

  `indexHint` never saves a call anywhere it fires — same bucket as
  `searchDetails`/`suggestions`/`archiveHint` (0.4.2.2): the rule fails outright. `negativeCache`
  WINS decisively on its own dedicated fixture (same shape as lever 10 at 0.4.2.5: 1 fewer call,
  +23 raw tokens, a clear win on effective tokens), exactly matching "measure honestly: it only
  saves if the model then stops searching" — but `bench/replay-heavy.jsonl` (built for OTHER
  levers, not retrofitted for this one) contains a genuinely recurring search that trips the same
  hint for real, with no corresponding dropped retry to offset the cost. The rule needs every
  tested file to pass; this one real, unmodelled cost on `replay-heavy.jsonl` is enough, so it
  ships off too — both fully available via `MEMGLOW_PROXY_NEGATIVE_CACHE=1` /
  `MEMGLOW_PROXY_INDEX_HINT=1` (or `"proxy": { "negativeCache": true }` / `{ "indexHint": true }`).

### Tests

- `test/negative-cache.test.js` — pure pieces (`normalizedKey`, `memoryFingerprint`,
  `recordFutileEntries`, `lookupFutileEntry`, `forgetStaleEntries`) and `createNegativeCacheStore`
  (disabled without a folder/switch, atomic write, mode 600, bounded, malformed file treated as
  empty, and invalidation on write: a fingerprint change drops every entry, not just one note's).
- `test/negative-cache-levers.test.js` — integration through `lib/proxy-levers.js`'s
  `createLevers` (no process spawn, hand-crafted upstream answers, same pattern as lever 10's own
  "never duplicated" test): a search superseded with no read is recorded futile and later hinted
  with the results always kept after it; a read within the window redeems a search (no later
  hint); a REAL write on disk invalidates a previously-recorded futile verdict; the hint never
  carries a fragment of a secret-looking query; the lever off end to end; a broken index/store
  never breaks the relay; both `indexHint` cases (search-returns-only-index,
  read-right-after-a-search), no match → nothing added, no recent search → nothing added, and the
  `alreadyLoaded` interaction (that read is stubbed by lever 8 instead, so `indexHint`'s own text
  never appears on it).
- `npm test` green (438 tests).

## 0.4.2.5 — internal (not published)

"Count the turns; aliases learn from multi-phrasing searches."

### Added

- **`bench/replay.js`: "effective tokens" column** = raw tool-result tokens + `calls *
  turnTokens` (`--turn-tokens`, default `DEFAULT_TURN_TOKENS` = 5,000). Before this stage, the
  harness scored a lever purely on tool-result tokens, so a lever that trades a CALL for a few
  extra tokens always looked like a loss — on `bench/replay-aliases.jsonl`,
  `aliases`+`learnAliases` made 2 fewer calls but cost +25 raw tokens (758 → 783), which is why
  it shipped off at 0.4.2.4. In reality every extra tool call is a whole extra model turn, which
  re-sends the system prompt, every MCP tool's schema, and the conversation so far — not just
  that one tool's own result.
  - `DEFAULT_TURN_TOKENS` = 5,000 is derived from `bench/results/*.jsonl` (326 real recorded
    turns from real `claude -p` runs: `sonnet.jsonl`, `haiku.jsonl`, `haiku-prefix.jsonl`,
    `split-gain.jsonl`): "overhead per call" = `(tokens.input + tokens.cacheCreate +
    tokens.cacheRead) - estimateTokens(toolResultChars)`, divided by `toolCalls`. Across all 326
    rows this ranges ≈4,000-19,000 per call (median ≈12,750; 10th percentile ≈6,500) — mostly
    the system prompt + tool schemas resent on every turn. 5,000 is a deliberate
    UNDER-estimate (below the 10th percentile, not the median): the point is to stop penalizing
    a lever for cutting a call, not to inflate how much cutting one is worth. See
    `bench/replay.js`'s own `DEFAULT_TURN_TOKENS` comment for the full derivation.
  - **New merge rule for a lever's default**: 0 violations AND effective tokens `<=` off's AND
    (raw tokens `<=` off's OR calls `<` off's) — applied by eye against the table, same as every
    earlier stage, not auto-verdicted by this file.
  - Raw `tokens`/`calls` columns are unchanged and still printed; `printEachBreakdown` (`--each`)
    also gained an "effective" column. `summarize()` takes a `turnTokens` parameter (default
    `DEFAULT_TURN_TOKENS`); JSON output (`--json`) includes `effectiveTokens`/`effSavingsAbs`/
    `effSavingsPct` per row plus the `turnTokens` used.

### Changed

- **MCP proxy: lever 10, `aliases` + `learnAliases` — ON by default** (`lib/proxy-levers.js`'s
  `DEFAULTS`, mirrored in `bench/replay.js`'s `SHIPPED_DEFAULTS`). Re-decided with the new merge
  rule above, on all three fixtures that exercise levers 9/10 (`--with
  aliases,learnAliases,-multiQuery` vs `off`): a no-op (identical calls/tokens to `off`) on
  `bench/replay-demo.jsonl` and `bench/replay-heavy.jsonl`; on `bench/replay-aliases.jsonl`, 2
  fewer calls (16 → 14) at +25 raw tokens (758 → 783) now reads as a clear win on EFFECTIVE
  tokens (80,758 → 70,783). The rule holds on all three, so this lever flips from OFF to ON.
  `MEMGLOW_PROXY_ALIASES=0` / `"proxy": { "aliases": false }` (and the `learnAliases` equivalent)
  turn it back off for whoever wants that.
  - **`dedupe` re-checked against the same rule, for completeness — default left UNCHANGED
    (still off)**: it also PASSES the rule on all three fixtures (it only ever saves raw tokens,
    `off`-or-better calls everywhere), but turning it on is left to the owner — it replaces a
    note's content mid-session with a short "unchanged" stub, a context-compaction risk the
    effective-tokens number does not capture. Reported in `bench/README.md`'s 0.4.2.5 section,
    not acted on here.
- **Lever 10 now learns from, and injects into, a lever 9 (`multiQuery`) multi-phrasing search**
  — previously a known limitation (see 0.4.2.4's own entry below): a request carrying
  `memglow_queries` bypasses the normal `clientMessage`/`serverMessage` cycle entirely
  (`multiQuery.run()` answers the whole burst itself, merged, outside `handleSearch`), so
  `aliases`/`learnAliases` could neither learn from such a search nor inject a candidate into its
  merged result.
  - New `applyAliasesToSearch(cfg, index, aliases, s, phrasings, result)` in
    `lib/proxy-levers.js` (pure, exported, unit-tested): records `s.lastSearch.words` as the
    UNION of every phrasing's own significant words (not just the main query's — a note read
    right after now learns from every phrasing the model tried) and `resultIds` from the merged
    result, then applies the same injection rule `handleSearch` already used (first learned
    candidate, prepended, never replacing or removing a row; upstream's-own-format when the
    merged result is plain text).
  - `createLevers(...).multiQuery.run(reqMsg, sendUpstream, sessionKey)` gained a third
    parameter — the same session identifier `clientMessage`/`serverMessage` already take — so it
    can find (or create) the right session to record into and read from. `createHttpProxy` in
    `mcp-proxy/memglow-mcp-proxy.js` now passes its `Mcp-Session-Id` (`sk`) through on this call
    (it already did for every other lever entry point); the stdio path still omits it, same as
    every other lever call there (stdio is already one single implicit "default" session, same
    as before this change). `bench/replay.js`'s own `multiQuery` branch passes the event's
    `session` through too, so the replay harness exercises the exact same code path.
  - Tests: `test/mcp-proxy-levers.test.js` — a missed multi-phrasing search teaches every
    phrasing's words (not just the main query), and a learned candidate is injected into a later
    multi-phrasing search's own merged result; `applyAliasesToSearch` unit-tested directly
    (learns from several phrasings, never duplicates an already-present note, no-op when both
    switches are off). Pre-existing alias tests that relied on the old OFF-by-default behaviour
    were updated to either assert the new ON-by-default behaviour directly, or explicitly force
    the switches off/on with env vars where the test is specifically about isolating one switch
    from the other.

## 0.4.2.4 — internal (not published)

Includes 0.4.2.3 ("query log") below it: the recording half of this same feature, shipped in the
same stage since the lever only makes sense with both halves in place.

### Added

- **MCP proxy: lever 10, `aliases` ("learned aliases")**, OFF by default (see Changed below).
  The owner's own real search log: the note finally read was the proxy's 1st search result only
  7 times out of 28, and not among the results AT ALL 13 times out of 28 — found instead via the
  index or a link — so the very next similarly-worded search failed again, the same way. This
  lever lets the proxy learn, privately and locally, which of the assistant's own words actually
  lead to which note, from THIS proxy's own past sessions, and use that the next time a similar
  search would otherwise come up empty-handed for that note.
  - **0.4.2.3, "query log" (lever switch `learnAliases`)**: when, in the SAME session, a search
    is followed (within `ALIAS_LEARN_WINDOW_MS` = 2 minutes, before another search) by a
    single-note read of a note NOT among that search's own results, the query's significant
    words (lowercased, stop-words dropped — a short EN + FR list, ≥ 3 letters,
    `lib/learned-aliases.js` `significantWords`, secret-masked with the existing
    `maskSecrets` BEFORE extraction) are learned as aliases of that note, with a count. Kept in
    one small local file, `learned-aliases.json` in memglow's data folder (mode 600, atomic
    write, bounded to `aliasesMax` = 2,000 (word, note) entries, oldest by last-use dropped
    first). **Nothing here is ever sent anywhere** — the file has no network code at all.
  - **0.4.2.4, "learned aliases" (lever switch `aliases`)**: on a LATER search, if its words
    match ≥ 2 of some note X's learned aliases (or 1 alias seen ≥ 2 times), and X is not already
    among that search's own results, X is added at the TOP of the answer — in the upstream's own
    per-hit row shape when the answer is plain text (reusing lever 9's own row helper, `hitRow`,
    factored out of `mergeSearchResults`'s tier B for this), else one compact, explicitly-labelled
    line: `memglow: likely relevant — <label> (<id>), learned from your past searches`. Never
    removes a result, never touches a note file, never duplicates a note already in the answer.
    An alias whose note no longer exists is forgotten (`forgetMissing`, run opportunistically on
    every search while the lever is on).
  - `learnAliases` (recording) and `aliases` (using what was recorded) are **independent**
    switches, both under the `proxy` config key / `MEMGLOW_PROXY_ALIASES` and
    `MEMGLOW_PROXY_LEARN_ALIASES` env vars: learning can keep running quietly while injection is
    paused, and injection can keep using whatever was already learned while recording is paused.
  - Pure logic in `lib/learned-aliases.js` (`significantWords`, `maskedQuery`, `learnEntries`,
    `matchAlias`, `forgetMissing`, and the one fs-touching piece, `createAliasStore`) — zero
    Express, zero three.js, meant to be lifted into memglow proper as is. Wiring in
    `lib/proxy-levers.js` (`hitRow`/`isPlainTextResult` factored out and reused, `aliasInjection`,
    the correlation bookkeeping in `handleSearch`/`handleRead`, session field `lastSearch`) and
    `mcp-proxy/memglow-mcp-proxy.js` (`setupLevers` creates the store, flushes it at exit).
  - **Known limitation, same family as searchDetails/archiveHint**: a search carrying
    `memglow_queries` (lever 9, `multiQuery`) bypasses `handleSearch` entirely while it is being
    merged (the merge happens against the raw upstream, outside the normal
    `clientMessage`/`serverMessage` cycle — see lever 9's own doc comment) — `aliases` cannot
    inject into, or learn from, a merged multi-phrasing call. It still works normally on every
    ordinary, single-phrasing search, which is what the owner's own log above was measuring (it
    predates `multiQuery`).
  - `bench/replay.js` gained the measurement this lever needed: `expect`/`dropIfHinted` on an
    event (`normalizeCalls`), a per-config hit-rate counter (`aliasSearches`/`aliasHits`,
    `printAliasHitRate`), and `droppedCalls` (a `dropIfHinted` search is skipped — no upstream
    call, nothing counted — once the session's most recent `expect` search already found that
    exact note: "a later re-search that becomes unnecessary once the note is already there").
    `--with` now also accepts a lever name prefixed with `-` to force it OFF (`namedConfigs`), so
    this lever's own effect can be isolated from `multiQuery`'s call-merging on the same fixture.
  - New fixture `bench/replay-aliases.jsonl`: 3 scenarios (mqtt, stripe-webhooks, git-workflow —
    the last one specifically for the "1 alias seen ≥ 2 times" threshold branch), each a miss,
    a read, then a later similar search (the mqtt/stripe ones also carry a `dropIfHinted` retry
    search right after). `node bench/replay.js --events bench/replay-aliases.jsonl --with
    aliases,learnAliases,-multiQuery` (multiQuery isolated out, see the limitation above):

    | configuration | calls | tokens | hit rate | violations |
    |---|---|---|---|---|
    | off | 16 | 758 | 0/5 (0%) | 0 |
    | +aliases,learnAliases,-multiQuery | 14 | 783 | 3/3 (100%) on the measured searches, 2 retries dropped | 0 |

### Changed

- **`DEFAULTS.aliases = false`, `DEFAULTS.learnAliases = false`** (`lib/proxy-levers.js`): the
  replay numbers above are 0 violations (passed) and a much better hit rate (passed), but tokens
  were WORSE, not "not worse" (758 → 783, +3.3%) — this lever only ever ADDS a hit row, it never
  replaces or removes one (same family as `searchDetails`/`suggestions`/`archiveHint`, all OFF by
  default for exactly this reason), and the 2 dropped retry calls' tokens did not outweigh the 3
  injected rows'. Per the same rule every other lever's default is decided by (0 violations AND
  hit rate improves AND tokens not worse, all three), this one ships OFF. Both still fully built,
  tested and documented, and one env var away:
  `MEMGLOW_PROXY_ALIASES=1` / `"proxy": { "aliases": true }`, `MEMGLOW_PROXY_LEARN_ALIASES=1` /
  `"proxy": { "learnAliases": true }`.

## 0.4.2.2b — internal (not published)

### Added

- **MCP proxy: lever 9, `multiQuery` ("several phrasings, one call")**, ON by default. The
  owner's own real usage log: 20 of 40 searches were immediately followed by ANOTHER search,
  before any read — the built-in rule "search in 2-3 phrasings" (`lib/memory-rules.js`) was
  costing 2-3 separate model turns every time, each with its own latency and re-sent context.
  The proxy now accepts an extra argument on every search tool (advertised in `tools/list` when
  this lever is on, stripped before the call reaches the server either way): `memglow_queries`
  (an array of up to `MULTI_QUERY_MAX` = 4 extra phrasings, each up to `MULTI_QUERY_LEN_MAX` =
  200 characters). A call carrying it is sent upstream as ONE call per phrasing — sequentially,
  the original query first, never in parallel or as a JSON-RPC batch — and the hits are merged:
  deduped by note id (a note found by several phrasings ranks higher, ties broken by the best
  rank it had anywhere then by which phrasing found it first), capped to the biggest single
  phrasing's own hit count, returned as ONE result in the upstream's own format when every
  phrasing answered in plain text (reassembled from the SERVER'S OWN hit blocks, split on blank
  lines — never a line memglow invented), else a compact listing of whatever note ids resolve
  (same style as lever 2, `searchDetails`). Any later phrasing's failed call fails the whole
  thing open to the FIRST phrasing's own result — what a plain single search would have
  returned; nothing resolvable anywhere does the same.
  - Pure logic in `lib/proxy-levers.js`: `planMultiQuery` (validates/caps `memglow_queries`),
    `mergeRankedIds`/`rankKeys` (the dedup/rank/cap algorithm, usable on its own), merge
    `mergeSearchResults` (the three tiers above), and the async, transport-agnostic
    `runSearchCall` (sequential calls + fail-open), all exported for direct testing.
  - Transport wiring in `mcp-proxy/memglow-mcp-proxy.js`: a multiQuery call bypasses the normal
    1-request-in/1-response-out relay — `lineRelay`/`sseRelay` gained a `SUPPRESS` sentinel (write
    nothing for this line/event) so the client's original request and each sub-call's own
    response are never relayed as is, only the ONE merged reply is. Stdio sends each sub-call as
    its own `tools/call` with a synthetic id (`createSubCallSender`); HTTP sends each as its own
    POST to the upstream (`postJsonRpc`) — JSON answers only for sub-calls (the one call the
    CLIENT asked for still streams normally, SSE included).
  - `lib/memory-rules.js`'s first rule updated: "if that tool's `memglow_queries` argument is
    offered, pass all the phrasings in that ONE call; otherwise call it 2-3 times as before" —
    so an assistant that already follows the habit switches to one call for free.
  - `bench/replay.js` models it: a run of consecutive searches by the same session, no read in
    between, within 2 minutes (`mergeSearchBursts`, `MULTI_QUERY_GAP_MS`), becomes ONE call
    carrying `memglow_queries` before the replay loop runs, so `calls` counts client-facing round
    trips — exactly what this lever is meant to cut. `bench/replay-heavy.jsonl` gained a few such
    bursts (67 calls now, up from 60) to exercise it; `bench/replay-demo.jsonl` has none (no
    change either way, by design — a small demo file was never going to have a realistic burst).

### Changed

- **`DEFAULTS.multiQuery = true`** (`lib/proxy-levers.js`), decided the same way every other
  lever's default is: `node bench/replay.js --each`, fewer calls AND no more tokens than `off`,
  or it ships off.

  | file | off | defaults (multiQuery on) | multiQuery alone vs off |
  |---|---|---|---|
  | `bench/replay-demo.jsonl` (no bursts) | 14 calls / 5,288 tokens | 14 calls / 5,288 tokens | +0 calls / +0 tokens |
  | `bench/replay-heavy.jsonl` (a few bursts added) | 67 calls / 17,581 tokens | 60 calls / 16,864 tokens | −7 calls / −717 tokens |

  Fewer calls AND fewer tokens on the only file with bursts to show it, no change on the file
  without any, 0 violations on both — unlike levers 2/3/6 (`searchDetails`/`suggestions`/
  `archiveHint`), which only ever ADD explanatory text, this lever can genuinely remove both
  calls and tokens, so it ships ON alongside `sizeWarning`.

## 0.4.2.2 — internal (not published)

### Changed

- **MCP proxy: lean defaults.** `bench/replay.js` (stage 0.4.2.1b) measured, and a real 2-day
  usage log confirmed, that the shipped `defaults` delivered MORE tokens than `off` — −19.7% on
  the shipped demo (`off` 5,288 → `defaults` 6,329 tokens), **+14% on the real log** (91 calls:
  `off` 116,052 → `defaults` 132,257 tokens). `searchDetails` and `suggestions` only ever ADD
  explanatory text (never cut anything), and the free replay harness cannot credit the extra
  reads/searches such text might avoid, so any amount of it reads as a pure loss — the real log's
  +14% is the same effect, just noisier. Per lever (`node bench/replay.js --each`, each lever
  alone against `off`, demo file / heavy synthetic file — see below):

  | lever | demo (14 calls) | heavy (60 calls) | decision |
  |---|---|---|---|
  | `sizeWarning` | +0 | +0 (both files avoid an oversized note on purpose — see below) | **keep** |
  | `searchDetails` | +483 | +1,179 | **off by default** (shortened) |
  | `suggestions` | +331 | +1,376 | **off by default** (shortened) |
  | `dedupe` | −1,449 | −4,314 | unchanged (off by default) |
  | `toc` | 0 | 0 | unchanged (off by default) |
  | `alreadyLoaded` | −3,710 | −9,646 | unchanged (off by default) |

  Decisions, with the numbers above:
  - **`sizeWarning` — keep, unchanged.** A single short line, once per large note per session —
    exactly the "short and plausibly prevents a wasted call" case. It is the one lever still on
    by default (`DEFAULTS.sizeWarning = true` in `lib/proxy-levers.js`); on a session that reads
    an oversized note it can still make `defaults` cost a few tokens more than `off` — that is
    this lever doing its job, not a regression.
  - **`searchDetails` — shortened AND turned off by default.** Shortening (kept for whoever opts
    back in via `MEMGLOW_PROXY_SEARCH_DETAILS=1`): a note already read **in full** this session
    gets no teaser line at all (its real content, not a guess at it, is already in context); a
    note merely *described* once this session (an earlier search mentioned it) gets the compact
    line (no description) the next time a search turns it up. Neither optimisation was enough to
    flip the sign on either event file (a nearly-cold demo/heavy file has few repeats to exploit),
    so `DEFAULTS.searchDetails` is now `false`.
  - **`suggestions` — shortened AND turned off by default.** Shortening: shown once per note
    **per session** (re-reading the same note later in the session does not repeat its
    related-notes suffix) — kept for `MEMGLOW_PROXY_SUGGESTIONS=1`. `DEFAULTS.suggestions` is now
    `false`, same reasoning as `searchDetails`.

  `dedupe`, `toc`, `archiveHint`, `hideUnsupportedTools` and `alreadyLoaded` are unchanged (still
  off by default, for the reasons already documented) — this stage only touched the three levers
  that were on by default.

### Added

- **`bench/replay.js --each`**: one row per lever, each lever ALONE against the `off` baseline
  (every other lever off) — unlike `--with`, which starts from `defaults`. Reports the tokens
  each lever adds or saves in isolation; this is the table stage 0.4.2.2 was decided from, and
  the one to re-run before changing any lever's default again. `--json` includes the same rows
  (`key: "alone:<lever>"`).
- **`bench/replay-heavy.jsonl`**: a synthetic 60-call, 4-session event file, heavier and more
  repetitive than the 14-call demo (the same handful of notes read and searched repeatedly across
  a few topics — a storefront project, a docker/home-lab investigation, a weather-app session —
  plus a one-off tail of notes touched once), closer to a real working session. Used by
  `test/bench-replay.test.js` alongside the demo file to confirm `defaults` tokens `<=` `off`
  tokens holds at a larger scale too, not just on the small demo.
- **`bench/replay.js`: `--memory` is now an alias for `--memory-dir`.** Before this stage, typing
  `--memory` (plausible shorthand, or a typo for `--memory-dir`) was silently ignored — the flag
  and its value were dropped as unrecognised positional tokens, and the run silently used the
  DEFAULT memory folder instead of the one intended. Now it works exactly like `--memory-dir`.
- **`bench/replay.js`: any other unrecognised flag is now a hard error** (exit code 2, naming the
  unknown token(s)) instead of being silently ignored — the same class of mistake as `--memory`
  above, for every flag this CLI does not know.

### Tests

- `test/bench-replay.test.js`: `SHIPPED_DEFAULTS` (the harness's own copy of the shipped defaults)
  pinned equal to `lib/proxy-levers.js`'s `DEFAULTS`, so the two can never silently drift again;
  `defaults` tokens `<=` `off` tokens on both the demo and the new heavy file, 0 violations
  everywhere; `eachLeverConfigs()` shape (one lever on per row); the demo/heavy per-lever
  breakdown itself (`searchDetails`/`suggestions` only add, `dedupe`/`alreadyLoaded` only save,
  the rest are no-ops on these two files); `parseArgs` (`--memory` alias, unknown flags recorded,
  `--each` parses).
- `test/mcp-proxy-levers.test.js`: the "defaults" end-to-end test updated for the new defaults
  (only `sizeWarning` fires without opt-in); `searchDetails`/`suggestions` end-to-end mechanics
  moved to their own opt-in tests (`MEMGLOW_PROXY_SEARCH_DETAILS=1` / `MEMGLOW_PROXY_SUGGESTIONS=1`),
  including the new "already read in full this session → no row at all" case; the FastMCP
  wrapper test, the HTTP proxy test and the config-clamping test updated to opt back in where
  they specifically exercise those two levers.
- `npm test`: 368 tests, all green. `node bench/replay.js` / `--each` / `--events
  bench/replay-heavy.jsonl --each`: 0 violations on every configuration.

## 0.4.2.1b — internal (not published)

### Added

- **Free replay harness, `bench/replay.js`** (+ `bench/replay-demo.jsonl`, `bench/README.md`): a
  self-verification loop for every future change to the MCP proxy levers, with zero model calls,
  zero network, deterministic. Drives `lib/proxy-levers.js::createLevers` directly — the same
  `clientMessage`/`serverMessage` entry points the real proxy uses — against a tiny in-process
  fake upstream answering from a notes folder, under named configurations (`off`, `defaults`, and
  any `--with lever,lever` combination on top of `defaults`). Reports calls, tokens delivered to
  the model, and savings against `off`; accepts either a JSONL/JSON-array file of tool calls
  (`{session,tool,args,t}`) or the r0zumnik portal's own `{evenements:[...]}` activity shape
  (sessions inferred from `source` + a 30-minute silence). A **correctness guard** checks, for
  every read, that the note's full current text stays reachable (delivered in full earlier in
  the same session and unchanged, in the always-loaded context and unchanged, or the stub names
  the `memglow_fresh` escape hatch) — exit code 1 on any violation. `test/bench-replay.test.js`
  pins the guard (including an artificially broken lever), event loading/grouping, and the demo
  table's own invariant (`off` vs `+alreadyLoaded`: positive saving, 0 violations).

## 0.4.2.1 — internal (not published)

### Added

- **MCP proxy lever 8, `alreadyLoaded`** (`lib/proxy-levers.js`, off by default): real usage data
  on the owner's own memory showed the always-loaded index note — already injected into context
  at session start by a host's `SessionStart` hook — was ALSO read explicitly 6 times through the
  memory MCP server over two days (≈16k tokens, ≈17 % of all tokens read): a pure duplicate. The
  new lever stubs a single-note read (never a `multiNoteTools` call) of a note memglow knows is
  always loaded — the index note(s), or a configured `alwaysLoaded` entry that resolves to a note
  — with a short `memglow: "<label>" (≈N tokens) is already in your context — … has not changed
  since this session began (sha …8 chars). Use it from there. To get the full text anyway, call
  again with "memglow_fresh": true.` A note that changed since the session began is never stubbed:
  its full, current text is returned instead, with a one-line "(changed since the start of this
  session)" note. Default **off**: memglow cannot know whether a given setup truly re-injects the
  index at session start (checked: `memglow init` does not install any such injection itself, only
  memglow's memory rules in `CLAUDE.md`/`AGENTS.md`) — turn it on (`proxy.alreadyLoaded` /
  `MEMGLOW_PROXY_ALREADY_LOADED`) only when it does. Tokens saved are counted the same way as
  `dedupe`/`toc` (`createSavings`, kind `"alreadyLoaded"`), coexisting with stage 0.4.2's per-client
  accounting in the same `proxy-savings.json`. Config-only for now (no settings-page toggle), like
  every other lever before a settings UI exists. Documented in `README.md` and
  `mcp-proxy/README.md`; a non-run `I` variant added to `bench/run.js` for a future benchmark.

## 0.4.2 — internal (not published)

### Added

- **Multi-question bench sessions** (`bench/run.js --mode sessions`, `bench/sessions.json`): several
  related questions asked in order inside ONE `claude -p` call (one MCP session), the only way to
  measure dedupe/toc/context-reuse across turns — a single-question-per-call bench never gives them
  a second turn to do anything with. `--dry-run` prints the run plan and a cost estimate (from past
  single-question runs already in `bench/results/*.jsonl`) without calling `claude` at all.
  Documented in `bench/RESULTS.md`.
- **Tokenizer accuracy check** (`bench/tokenizer-check.js`): compares `estimateTokens` (`ceil(bytes
  / 4)`, `lib/cost.js`) against the real token counts already recorded in `bench/results/*.jsonl`,
  by question `kind` and by the holder note's real size (regenerated locally and deterministically
  with `bench/generate.js` — no network, no model call). Reports it honestly as an upper bound: the
  recorded runs keep only session-total figures, never the token delta one tool result alone
  caused — what is actually missing to do better (and why it is not re-measured here) is spelled
  out in the script's header and in `bench/RESULTS.md`.
- **Per-client token accounting in the MCP proxy** (`lib/proxy-levers.js`): `createSavings` now
  also tallies the baseline tokens relayed per client (`clientInfo.name`/`title` from `initialize`,
  bucketed by `lib/clients.js`'s known ids, or "unknown" when neither was sent), per calendar day,
  in `proxy-savings.json`. Exposed read-only (counts only, never note content) in `GET /api/cost`
  (`clientTokens`, last 7 days) and shown as a tiny "By AI tool" line under Memory engine speed in
  the Memory cost panel (`public/cost.js`); translated in all 8 shipped languages.
- **Section-level cost in the MCP server**: `note_cost` now returns a per-section token breakdown
  (`sections`, reusing `lib/cost.js`'s `sectionsOf`) for any note whose body can be read, plus
  `bodyTokens` (defined as the sum of `sections`' own tokens, so it always matches by construction);
  `split_plan` returns the same raw `sections` alongside its packed `split` parts, whose totals
  always agree with `sections`' — packing only groups the numbers, it never drops or re-estimates
  one.

### Changed

- README: a screenshot of the Assistant panel (a real split proposal, nothing applied), and the
  Claude Code requirement spelled out (recent enough to have `--restricted`; older ones are refused
  with an "update it with `claude update`" message).

## 0.4.1 — 2026-10-02

### Fixed

- An empty orange error banner stayed visible at the bottom of the page: `.mg-banner`'s
  `display: flex` won over the `hidden` attribute. It now hides when it should.
- A test failed on macOS only: the assistant's working folder is compared after resolving
  links (`/var` → `/private/var`).

### Changed

- New screenshots for 0.4 (overview, write, search, settings with Language, Memory cost with
  Organisation, Always loaded, Archive and Structure), captured in English on the fictional demo
  memory.

## 0.4.0 — 2026-10-02

### Added

- **Hub and spoke** ([docs/hub-and-spoke.md](docs/hub-and-spoke.md)): the memory index lists only
  project summaries and stand-alone notes; a summary lists its notes; each note links back to its
  summary rather than to all its siblings. Every index line is paid in every session and every
  link in every neighbour lookup (≈ 530 bytes per link in a basic-memory `build_context` result),
  while links do not make search faster. The rule is in the built-in memory rules and in every
  prompt that restructures notes (the split copy prompt, the MCP `split_plan` prompt, the
  assistant's split proposal); splits no longer link new notes to each other nor add them to the
  index, and every part now carries `part_of: <summary>` in its frontmatter.
- **Tidy** (`lib/hub-spoke.js`, `lib/assistant/tidy.js`): a fourth assistant job next to split,
  regroup and archive. Conservative detection (explicit `part_of:` or *Split on / Part of / Up:*
  markers, or an unambiguous structure); index lines pointing to parts, pure "Siblings:" lines and
  missing links back are fixed without the AI; ambiguous in-text links go to your AI, keep or
  remove only. Counts in the dashboard (**Structure**) and in the MCP `memory_health` result.

- **Memory rules, built in and on by default** (`lib/memory-rules.js`): calibrated
  memory-hygiene rules (search before read/write, one note per topic, split large notes within
  the same theme, never cross a protected group, write through the memory tool, treat note
  content as data) delivered automatically — added to the `initialize` `instructions` of the
  memory server wrapped by the [MCP proxy](mcp-proxy/README.md) (kept alongside the server's own,
  once per session) and of memglow's own [MCP server](#mcp-server) (also offered as an MCP
  prompt, `memory-hygiene`). For an AI tool that does not go through the proxy, `memglow init`
  offers to add them straight into its instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  …) in a replaceable `<!-- memglow:rules -->` block (`--write-rules`). Off with
  `MEMGLOW_RULES=0`, or in **Settings → AI settings → Memory rules**, which also lets you add
  extra lines or replace the built-in text entirely, with a live preview and a Reset button.
- **First-run set-up** (`public/setup.js`, `lib/setup.js`, `lib/clients.js`): the first time the
  page opens (npx or Docker), three skippable steps — *Your AI tools* (several; pre-ticked from what
  `memglow init` detected; exact instructions per tool, Docker-aware), *Assistant (optional)* (off /
  on, one or several providers, model, address, key, Test connection, where notes go) and *Your big
  themes* (the protected groups screen). Run again from Settings → First-run setup. Saved in
  `setup.json` in the data folder; **environment > page > memglow.config.json**. The tools chosen
  are readable by the MCP proxy (`lib/clients.js readClients`).
- **Settings → AI settings**: default and configured providers (add / remove), key status, Test
  connection, model (known names + validated free entry), address / preset, max output tokens,
  temperature (only where supported), time limit, cost cap (`maxBudgetUsd` for Claude Code, max
  tokens × price for APIs), *Always ask before sending a note to this provider* (on by default off
  this machine), the assistant's own settings (too-large threshold, part size, lines allowed to go
  missing with a warning, backup) and a 7/30-day usage box with an estimated cost (no external call).
- **Keys typed in the page**: only from this computer or with `MEMGLOW_PASSWORD` + HTTPS
  (`MEMGLOW_TRUST_PROXY=1` behind an HTTPS reverse proxy); their own route, one mode-600 file per
  provider, never sent back or logged, *Remove key*. Per-provider variables
  `MEMGLOW_ASSISTANT_API_KEY_<PROVIDER>`.
- **Claude Code subscription (no API key)**: the `claude-code` provider is named as such; model
  aliases (`opus`, `sonnet`, `haiku`, `fable`…) or a full id; `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) from the environment or the page, given only to the `claude` child process.
  Docker: "not available in this container" said plainly, and an image variant
  `--build-arg CLAUDE_CODE=1` (+≈230 MB, installed at build time, auto-update off).
- **Ollama and LM Studio as providers of their own** (`ollama`, `lmstudio`), configurable next to a
  cloud `openai-compatible` one; Test connection lists the local server's models.
- **`memglow init`** asks the same questions (tools, assistant, providers, model; API key typed
  without echo, never for Docker); `--clients <list>`; `--docker` writes the choices in `.env`
  with the key lines commented out. `--yes` unchanged.

- **Memory cost → Time to find a note · 7 days** (`lib/find-time.js`): from the activity memglow
  already receives, for each search the first read by the same actor (source + machine + channel)
  within 2 minutes — median time to the note, median steps, share of searches with no read after,
  and the 5 slowest or missed searches (titles only). A search through the MCP proxy that found no
  known note is now reported too (no ids; not animated, `202` as before) so it counts as missed.
  Stored as ids, a source label and times in `find-time.json` in the data folder (8 days).
- **Memory cost → Memory engine speed · 7 days** (`lib/engine-speed.js`): the MCP proxy times
  every tool call against the memory server (monotonic clock, request forwarded → response back)
  and sends `durationMs` with the activity; memglow keeps it only as a number from 0 to 600,000 ms
  and shows calls, p50 and p95 per tool type (search / read / write), plus a slow-search alert
  (≥ 10 searches in each window, last-24-hour median ≥ 2× the 6 days before and ≥ 250 ms slower).
  `engine-speed.json` in the data folder (8 days). Both blocks are translated in the 8 languages;
  durations use the browser's `Intl` unit names.
- **`bench/`** (repository only, not in the npm package): a reproducible benchmark of the proxy
  levers — the real `claude` CLI, non-interactive, against a disposable basic-memory on 225
  generated fictional notes, 21 questions with known answers, 5 variants (direct, proxy off,
  default levers, + dedupe, + toc), Haiku and Sonnet. Results in `bench/RESULTS.md`: default
  levers neutral; `toc` −64 % of note text received, all answers correct, but +1 round trip
  (+12 % input tokens and time, −13 % cost); `dedupe` not measurable with one question per
  session; it also found the `structuredContent` bug fixed below.
- **MCP proxy lever 7 — `hideUnsupportedTools`** (`lib/proxy-levers.js`, off by default,
  `MEMGLOW_PROXY_HIDE_UNSUPPORTED`): the proxy reads `clientInfo` from each session's `initialize`
  (one per stdio process, one per HTTP `Mcp-Session-Id`) and removes from `tools/list`, for that
  client only, the tools a config table (`proxy.unsupportedTools`, replaces the default whole)
  marks unsupported for it. Default table reproduces basic-memory 0.23's own rule, read from its
  source rather than guessed: `search`/`fetch` (its ChatGPT-only adapters,
  `chatgpt_tools.py`/`client_info.py`) are hidden from any client whose `clientInfo.name`/`title`
  is not `openai-mcp` (or doesn't start with `openai-mcp/`) — matching the exact label OpenAI's
  MCP client sends, not the product name "ChatGPT". An unknown client (no name/title) is never
  filtered. A client that calls a hidden tool anyway is still relayed, untouched — this lever only
  edits `tools/list`. Several clients on the same HTTP server (e.g. Claude Code and ChatGPT talking
  to the same basic-memory) each see their own list. See `bench/RESULTS.md` →
  "hideUnsupportedTools" for the measured effect and why it stays off by default.

- **Settings → Forces** (Repulsion, Link force, Link distance, 0.2×–3×, a "Reset forces" button)
  and **Settings → Links → Link opacity** (0×–3×): multipliers around the values already set by
  Spread/Gravity/Minimum spacing and the "Links at rest" preset — default 1× is today's look,
  unchanged (`chargeStrength`/`linkRestDistance`/`linkRestStrength`/`linkRestOpacity` in
  `public/app.js`, tested). Saved with the rest of the view (`lib/view.js`), same device-to-device
  sync, same strict server-side bounds. On a phone, the new sliders live in the same Settings
  sheet as everything else. Link curvature was tried and dropped: comets travel in a straight
  line between the two nodes, and a curved link would no longer match — left for a larger change.
- **No failed request fails silently**: every page script (graph, note, Memory cost, Protected
  groups, Assistant, the saved view, and both live streams) now shows a visible, translated
  banner — connection lost, unauthorized, or server error — with a "Reload" or "Retry" button,
  instead of swallowing the failure. `MEMGLOW_PASSWORD`'s stateless HTTP Basic auth means a `401`
  always offers "Reload" (there is no session to resume, only a fresh request to be asked for
  credentials again). A handful of catches stay intentionally silent (a 404 for a note that
  vanished between a click and the fetch, a malformed SSE event, a cosmetic background redraw) —
  each says why, right there in the code.

- **MCP server** (`memglow-mcp`, `mcp-server/memglow-mcp.js`, bin `memglow-mcp`): a second,
  standalone, read-only MCP server, separate from the MCP proxy. It starts entirely on its own —
  no viewer, no network, no notes folder even required — and lets an assistant query its own
  memory directly: `memory_health` (notes too large, costliest to read over 7 days, never read in
  30 days, index size), `split_plan` (a deterministic split suggestion along a note's `##`
  sections, or an honest "no split needed" under the threshold, plus a ready-to-paste English
  instruction for the assistant's own memory tool), `related_notes` (notes related to a note —
  links, sub-theme, and co-usage when activity counters exist — or to a free-text topic), and
  `note_cost` (token estimate, threshold, status and 7-day reads for one note). No write tool, no
  full note body ever returned (titles, descriptions and section headings only, secret-masked),
  and no file is ever written — not the notes, not even memglow's own activity counters. Hand-
  written JSON-RPC 2.0 over newline-delimited stdio, zero dependency, same reasoning as the
  existing MCP proxy. Reuses `lib/memory.js` and `lib/cost.js` — same token estimate, same split
  rule, same secret masking as the viewer and the Memory cost panel.

- **MCP proxy levers** (`lib/proxy-levers.js`): the proxy can now annotate the memory server's
  answers to save tokens and round trips — never the notes, which it only reads (cached: one folder
  scan per poll interval, plus one after each write). Each lever has a switch in
  `memglow.config.json` → `"proxy"` and a `MEMGLOW_PROXY_*` variable. On by default, and only
  ever *adding* a text block before or after the server's untouched content: (1) **size warning**
  when a note over `largeNoteTokens` is read, or written past it, suggesting a split within the
  same theme (once per note and session); (2) **richer search results** — title, theme, ≈tokens
  and description of each note found; (3) **context suggestions** — up to 3-5 related notes after
  a read (links, sub-theme, co-usage), names and sizes only. Off by default, because they change
  what the assistant receives (measure answer quality first): (4) **session read de-duplication**
  — an unchanged note re-read in the same session gets a short notice instead of its content;
  (5) **table of contents first** — a large note comes back as its outline with ≈tokens per
  section, then one section on demand, cut verbatim from the server's answer (basic-memory's
  `read_note` has no section parameter). For 4 and 5, an optional `memglow_fresh` argument (added
  to the read tools in `tools/list`, stripped before the server) or simply repeating the read
  returns the full note. Tokens saved are logged on stderr and summed per day in
  `proxy-savings.json` in memglow's data folder. Works in stdio and Streamable HTTP (JSON and SSE)
  modes; with every lever off the proxy is the same pure byte relay as before. Readers of
  frontmatter, sections and related notes are shared with the viewer and `memglow-mcp`
  (`lib/related.js`, `sectionSpans()` in `lib/cost.js`).

- **Assistant (optional, off by default)**: a *Do it with Claude* button next to *Copy prompt for
  your AI* on each large or costly note, and an *Assistant* panel below Memory cost. **The AI only
  proposes; memglow only writes what you approved in a diff, with a backup and Undo.** The user's
  own Claude Code CLI is run by the memglow server itself (no separate program) with no tool at
  all (`--tools ""`, no MCP server, deny-all rule, `dontAsk`, `--restricted`, prompt on stdin,
  no shell) and answers with a JSON proposal (summary, parts, link updates). memglow refuses it
  unless every original line is kept, new files stay in the same folder under new names, parts
  carry no frontmatter of their own (memglow copies the original `theme`/`subtheme`), the
  summary links every part, and link updates only touch notes that link to the original. Then:
  exact per-file diff, *Apply this plan* with a one-time server token (2 min, single use), a check
  that nothing changed since, a backup (git snapshot commit of the touched files, or a copy in
  `<dataDir>/backups/`) — no backup, no write — atomic writes, and *Undo* (never overwrites a file
  changed since). Secret-looking lines are replaced by placeholders before the note is sent.
  Enabled with `assistant.enabled` / `MEMGLOW_ASSISTANT=1`; its routes answer `404` otherwise;
  same access rule as the page, CSRF header + same origin, rate limited, one job at a time.
  Providers are adapters (`lib/assistant/providers/`); the Codex, Gemini and Cursor CLIs are
  listed as not supported yet.

- **Assistant HTTP providers**: `anthropic` (Messages API, streamed, your key; default model
  `claude-sonnet-5-5`) and `openai-compatible` (`<baseUrl>/chat/completions`, streamed) with
  presets `openai`, `mistral`, `openrouter`, `ollama` (`http://127.0.0.1:11434/v1`) and `lmstudio`
  (`http://127.0.0.1:1234/v1`) — local models need no key and nothing leaves the machine. Native
  `fetch`, no dependency. Same prompt and same validation as `claude-code`; no tool declared, an
  answer calling one is rejected, as is invalid JSON, a cut-off answer or one over 4 MB; time
  limit; no redirect followed; clean messages for 401 / 429 (with its delay) / 5xx. The API key
  comes only from `MEMGLOW_ASSISTANT_API_KEY` (or the variable named by `assistant.apiKeyEnv`) or
  a mode-600 `assistant-api-key` file in the data folder — a key in `memglow.config.json` or a
  readable key file is refused with a message; never sent to the browser (*key: set / not set*),
  never logged, never in an error. HTTPS required for any non-loopback address. The panel lets
  you pick any ready provider per request and says, before *Propose*, where the note goes
  (*Local model — nothing leaves your machine* or *Your note will be sent to <host>*). Per-provider
  settings sections (`assistant.anthropic`, `assistant["openai-compatible"]`).

- **Protected groups** (`lib/zones.js`): a first-run screen, *"What are your big themes?"*, lists
  the groups found in the folders and `theme:` keys (note counts, folders); tick the ones to
  protect and optionally rename how they are shown (display only). Saved in the data folder
  (`zones.json`, mode 600, atomic) through `PUT /api/zones` — page access rule, `X-Memglow`
  header + same origin, rate limited, 4 KB body, strict validation; editable in *Settings →
  Protected groups*; `protectedThemes` in the config file works too (a saved choice wins). The
  assistant refuses any proposal that would move a note into or out of a protected group, create a
  note in another group, rename a group or change a protected note's `theme` line (checked per
  file at validation and again at Apply), and every prompt memglow writes names them.

- **Organisation suggestions** (`lib/organise.js`, read-only, deterministic): notes of one group
  strongly tied (a link +2, shared title/description keywords +1 each up to +3; strong at 3) that
  span 2+ sub-themes, or the only note of a sub-theme tied to another one → *"N notes about X are
  spread across K sub-themes of G — group them under Y?"*, max 5. New *Organisation* block in
  Memory cost with *Copy prompt for your AI* and, with the assistant, *Do it with …*: a new
  `regroup` proposal (`lib/assistant/regroup.js`) — the AI gets metadata only (never note
  text) and answers `{subtheme, moves, notes}`; memglow edits only the `subtheme`/`sous_theme`
  line, may move a file to a folder of the same group, updates path links, and refuses group
  changes, unknown notes or folders, overwrites and any text change. Same diff, one-time token,
  backup and Undo (moves included). New `memglow-mcp` tool `organisation_suggestions`.
  Three scattered "docker" notes added to the demo memory to show it.

- **Always-loaded cost** (`lib/always-loaded.js`): Memory cost shows what is loaded at every
  session — the index note plus the files listed in `alwaysLoaded` (e.g. `~/.claude/CLAUDE.md`,
  `AGENTS.md`; size only, never read, only the configured name and ≈ tokens reach the page) —
  × sessions per day (estimated from index reads over 7 days, else `sessionsPerDay`), with a
  *trim the index / CLAUDE.md* tip above `indexWarningTokens`. Also in `memory_health`. MCP
  proxy: new opt-in lever `indexWarning` (`MEMGLOW_PROXY_INDEX_WARNING`) warns once per session
  when the index note read is above that threshold.

- **Archive tier** (`lib/archive.js`): sections of notes unused for months move, word for word, to
  an archive note of the same theme (`archive/<theme>-archive.md`), the original note keeps one
  line `Archived: <section> → [[<theme>-archive#<section>]] (YYYY-MM-DD)`, and an archive summary
  (`archive/archive-summary.md`, one ≈ 25-token line per archived section) is rebuilt at each
  application. **Detection** (read only, *Archive* block of Memory cost): a section is dormant when
  its note was neither read nor found by a search for `archiveAfterDays` days (default 105) and
  the section was not edited in that time — per section once memglow's new section log
  (`section-ages.json`: hashes and days, never text) covers the window, per note before that; it
  needs that much counted history first (*Not enough data yet since …*), lists at most 20
  sections (biggest first), never the intro, index notes, notes without a theme or the archive
  itself. Documented limit: counters only see whole-note reads, so reads and searches are judged
  per note. **Applying**: *Copy prompt for your AI* always; with the assistant on, *Prepare
  without AI* (memglow builds the verbatim move itself) or *Do it with <provider>* (the AI only
  reviews the list — titles, sizes, a few masked lines — and chooses what to archive; memglow
  builds the move). Strict checks before showing and again before writing: every original note
  rebuilds exactly from the note and its archived sections, each section is in its archive note
  once and verbatim, same theme, append-only archive notes, never a file memglow did not make,
  every link names an existing note and heading; then diff, one-time token, backup, Undo.
  New route `POST /api/assistant/archive` (same access, CSRF and rate rules as the others).

- **`archive_lookup`** in `memglow-mcp` (read only): the archived sections whose topic or original
  note matches a query, from the archive summary — references only, never the archived text.

- **Proxy lever 6, `archiveHint`** (off by default, `MEMGLOW_PROXY_ARCHIVE_HINT`): when a search finds
  nothing in the live memory, adds "memglow: nothing found in the live memory — the archive summary
  lists: …" with matching archived section titles only.

- **Journal: machine and channel.** Each line now reads *action · group · note · machine ·
  channel · tool*, e.g. *Write · Projects · Smart home · laptop · hook · Claude Code* (was
  *action · group · note · source*). `channel` is a closed list — `hook` (the bundled adapters and
  the legacy `hooks/memglow-activity.js`), `mcp-proxy`, `file` (a note changed on disk, no hook
  involved) or `api` (a direct call to the activity API) — and `machine` a short per-sender label
  (`MEMGLOW_MACHINE`, or `machine` in `~/.memglow/memglow.config.json`; default: short hostname),
  validated server-side (closed charset, 32 characters at most, never a path or an IP). Both are
  optional and purely additive: an activity sent without them (every pre-v0.4 sender, any direct
  `POST /api/activity` that does not set them) displays exactly as before. `POST /api/activity`
  accepts the two new optional fields; see [docs/api.md](docs/api.md).

- **Background: Light preset.** A fourth option next to Deep / Plain / Night blue: a near-white,
  mint-tinted scene, in the spirit of the project's own light charte. The glow is cut to a trace
  (threshold raised above the background itself); notes, links, names, sub-theme bubbles, the 3D
  legend and the read/search/write highlight colours (comets, target rings) are all darkened —
  same hue, just dark enough to read against white — instead of the near-white tones used on the
  three dark presets. Nothing changes for Deep, Plain or Night blue. Saved like every other
  setting (`lib/view.js` → `background`, now `"deep" | "plain" | "night" | "light"`).

- **Interface in 8 languages**: English (reference), French, German, Spanish, Brazilian
  Portuguese, Japanese, Korean and Simplified Chinese. Picks `navigator.languages` on first visit,
  falls back to English; switchable any time from **Settings → Language**, saved with the rest of
  the view (`lib/view.js` `SETTINGS.language`, `public/app.js` `VIEW_SETTINGS.langue`) like every
  other setting — one browser's choice follows to any device that opens the same instance. Zero
  dependency: one JSON file per language in `public/i18n/<code>.json`, served statically with the
  page's usual security headers, loaded by a small new `public/i18n.js` (`t(key, params)`, simple
  `{placeholder}` interpolation, `one`/`other` plurals, a plain string for a plural-less language).
  Product names (Claude Code, Codex, Cursor, Ollama…) and the word "token" are never translated;
  prompts memglow builds for the AI (the *Copy prompt for your AI* text, and what the optional
  assistant sends) always stay in English regardless of the interface language. See
  [Languages](README.md#languages) for how to add one.

- **v0.4 texts translated**: everything the protected groups, organisation, always-loaded,
  archive and journal work added to the page goes through the same keys, in all 8 languages
  (252 keys in all). Organisation suggestions carry their figures and display names (`facts`) and
  trimming tips their numbers (`tokens`, `threshold`, `name`), so the page words them in its own
  language; the English `message`, `reasons` and `text` stay in `/api/cost` for the MCP tool,
  the AI prompts and older pages.

- **Phone layout**: under 640 px wide, and on a phone held sideways (`(max-height: 500px) and
  (orientation: landscape)`, one query shared by `app.css` and `app.js`), the legend folds behind
  a *Themes* chip, *Find a note* behind a magnifier, and Settings behind a gear that opens a bottom
  sheet (dimmed background, drag handle, *Close settings*, Escape; focus moved in and given back to
  the gear; no animation with reduced motion). The journal reads on two lines per entry, Memory
  cost names wrap, and the Assistant, Protected groups, Organisation, Always loaded and Archive
  blocks get full-width rows and 40 px buttons. Nothing changes above 640 px. Two new keys
  (`legend.toggle`, `settings.close`) in all 8 languages.

### Changed

- **Numbers and dates in the interface language**: token and note counts, percentages, days
  ("30 sept.", "9月30日"), the journal clock and change times now use `Intl` with the language
  chosen in Settings (before: English "3,000" / "Sep 1" everywhere, and the browser's locale for
  the clock). `t()` formats numeric parameters the same way. Prompts for the AI and the lines of
  the archive summary keep fixed English formats on purpose. The note tooltip ("≈ N tokens",
  "N notes") is translated too.

- Activity counters keep `started` (first day of counting) and `last` (last read / search / write
  day per note) beyond the 90-day purge; older counter files are migrated on load.

- **Journal line**: *action · group · note · machine · channel · tool* instead of
  *action · group · note · source* (see *Journal: machine and channel* above); the `file` and
  `demo` channels are translated, `hook`, `MCP proxy` and `API` are shown as they are.

- **`memglow-mcp`** now lists six read-only tools: `memory_health` (which also reports the
  always-loaded cost), `split_plan`, `related_notes`, `note_cost`, `organisation_suggestions` and
  `archive_lookup`.

- **Memory cost**: two new blocks side by side, *Organisation* and *Always loaded · every
  session*, then *Archive*. The assistant buttons are named after the default provider
  (*Do it with <provider>*, was *Do it with Claude*), and the Assistant panel handles three kinds of
  proposal — split, regroup, archive — with the same diff, one-time token, backup and Undo.

### Fixed

- **MCP proxy levers were invisible to Claude Code behind basic-memory** (found by the `bench/`
  benchmark): basic-memory, as a FastMCP server, sends every answer both in `content` and as
  `structuredContent: { "result": <same text> }`, and Claude Code gives the model the
  `structuredContent` when there is one — so the blocks the levers added to `content` never
  reached it, and dedupe/table-of-contents never applied (they skipped any `structuredContent`).
  The proxy now recognises that exact wrapper (one `result` key equal to the text of `content`)
  and keeps it equal to the annotated text; any other `structuredContent` is untouched, as before.

- **Archiving inside a protected group** (found while integrating the protected groups and the
  archive tier): an archive note is created in the group of the sections it receives, and now says
  so (`source` on the file), so the protected-groups check accepts it instead of refusing every
  archive plan that touches a protected group. A forged archive note in another group is still
  refused.

- **Archiving with a protected `defaultTheme` and no `archive` theme**: the archive summary
  (generated by memglow, without a group of its own) fell into the protected default group and the
  whole archive was refused. The plan now marks it as owned by memglow (`owner: "memglow"`, role
  `summary`, `memglow_archive_summary: true` in its frontmatter before and after), and only that
  file skips the protected-groups check; originals and same-theme archive notes are checked as
  strictly as before, and the flag written in a file's text grants nothing on its own.

### Security

- **Protected groups cover every proposal**: split, regroup and archive plans are checked against
  them when proposed and again at Apply, and every prompt memglow writes for an AI — split, regroup
  and archive copy prompts included — names them.

- **Assistant**: off by default; when off its routes, script and buttons do not exist (`404`). The
  AI never gets a tool and never writes: memglow validates, shows the exact diff, needs a one-time
  server token (2 min, single use), backs up first (no backup, no write) and keeps Undo. Secret-
  looking lines are masked before anything is sent. API keys only from the environment or a
  mode-600 file, never sent to the browser, never logged.

- **New write routes** (`PUT /api/zones`, `POST /api/assistant/archive`): same access rule as the
  page, `X-Memglow` header + same origin, rate limited, small bodies, strict validation;
  `zones.json` is mode 600, written atomically in the data folder, never in the notes folder.

- **Read-only by construction**: `memglow-mcp` has no write tool and returns no full note body;
  `archive_lookup` and the proxy's `archiveHint` return titles and references only, never archived
  text. The journal's `machine` field is validated server-side (closed charset, 32 characters, never
  a path or an IP).

- **Interface texts**: translations are static files shipped with memglow; note titles, group
  names, sub-themes and every server text are escaped before they reach `innerHTML`.

## 0.3.1 — 2026-10-01

### Fixed

- Double-click on the background (recenter / overview) now works with Mac trackpads: the native
  `dblclick` event is used, small pointer moves between the two clicks no longer cancel it.
- Memory cost: the "N notes = X %" line now uses the smallest set of notes covering 80 % of the
  reading (it said "8 notes = 100 %" when only 8 notes had been read).

### Changed

- New README screenshots, including the Memory cost panel and the Deep background.
  `demo/record/screenshots.js` also captures Memory cost (counts in a throw-away data folder) and
  can render on a GPU (`GPU=1`).
- Release workflow on the Node 24 majors of its actions (checkout, setup-node, Docker actions).

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
