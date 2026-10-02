# Hub and spoke

A rule memglow applies to its own memory-hygiene advice, built on one measurement: on a real
memory, asking basic-memory's `build_context` for a note costs roughly **530 bytes per `[[link]]`**
it carries, on top of the note's own text — and that cost is paid again at *every* session that
loads the note, not once. A memory wired as a dense web of cross-links reads cheaply to a human
skimming it, and expensively to an assistant that re-reads a chunk of it before every task. Search
(`search_notes`) is text and semantic, not graph traversal: extra links do not help it find
anything faster. They only add bytes the assistant pays for and gets nothing back from.

Hub and spoke is the shape that keeps the index — the one note loaded at the start of every
session — as small as possible, while still letting a human or an assistant get from the index to
any note in at most two hops:

- The **index** lists only **hubs** (a project's summary note) and **stand-alone notes**. It never
  lists a note that belongs to a project a hub already summarises — that entry is redundant: the
  hub's own line already says the project exists, and the hub lists the note underneath it.
- A **hub** lists its own notes, one line each, saying in a few words what each one holds. That
  list is the only place those notes need to be enumerated.
- A **sub-note** links back to its hub, and only its hub — never to a list of every other note
  under the same hub ("Siblings: …", "See also: …"). If a sub-note needs something from a sibling,
  reaching it through the hub costs one extra hop, which is cheap; a direct link that exists just
  to enumerate siblings costs ~530 bytes at every session for no benefit.
- A **cross-link between two notes that are not hub and sub-note** is fine exactly when the text
  genuinely refers to the other note — a real citation, not a structural listing. The rule never
  asks for fewer links in running prose that actually means to point somewhere; it only targets
  links whose sole job is restating structure the hub (or the index) already states.
- Splitting a note keeps this shape rather than reproducing the old one: the original note becomes
  a short summary (the new hub) that lists the parts it was split into; the parts link back to that
  summary only; and the parts are never added to the index — the summary's own index entry already
  covers them.

## Where this lives in the code

- `lib/memory-rules.js` — the built-in instruction text sent to an assistant's memory tool (via the
  MCP proxy's `initialize` instructions, the `memglow-mcp` server's own instructions and prompt, and
  `memglow init`'s `CLAUDE.md`/`AGENTS.md` block) states the rule in one short paragraph.
- `public/cost.js` (`costSplitPrompt`) and `mcp-server/memglow-mcp.js` (`split_plan`'s copy prompt)
  carry the same rule in the ready-to-paste instructions they hand an assistant for splitting one
  large note.
- `lib/hub-spoke.js` is the **detector**: a pure function, no file system, no network, that takes
  notes (id, label, body) and the index note's id, and finds exactly where a memory drifts from the
  shape above — a hub and its sub-notes, a redundant index entry, a sibling-listing line (flagged
  `pure: true` when it is nothing but a label and a list of links, safe to delete outright; `pure:
  false` when the links sit inside real prose and only a reader — human or AI — can tell whether
  the reference is genuine), a sub-note missing its one-line uplink, a hub missing a line for one of
  its notes.
- `lib/assistant/tidy.js` turns those findings into exact file edits: the deterministic ones
  (redundant index lines, pure sibling-listing lines, missing uplinks, missing hub lines) need no
  AI and spend no tokens; an ambiguous cross-link is only ever touched after the user's own AI
  reviews it and says, per link, keep or remove — it may never rewrite anything else on the line,
  and memglow never deletes a note.
- The "**Tidy into hub and spoke**" job (`lib/assistant/index.js`'s `proposeTidy`) runs this through
  the same proposal → diff → confirm → backup → apply → Undo machinery as every other assistant
  job, and is surfaced as a "Structure" block in the Memory cost dashboard (`public/cost.js`) and as
  a field of the `memory_health` tool of the read-only MCP server (`mcp-server/memglow-mcp.js`) —
  counts only, never a note's text, so an assistant connected over MCP can see there is drift
  without reading anything private.
