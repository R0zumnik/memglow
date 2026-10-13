"use strict";
/**
 * Index tree (RAPTOR-like, deterministic, NO LLM) — a cheap, cacheable summary of the memory
 * index note (MEMORY.md), built once from plain text: its heading structure (`## Work`,
 * `### NAS & Docker`, …) and its own "- [[slug]] — hook" bullet lines (lib/index-trim.js's
 * `LINE_RE`, reused so both modules agree on what counts as an index entry).
 *
 * Pure: no fs, no network, no randomness — the same `indexText` always produces the same tree and
 * the same rendering at a given level. Used by memory-server's `memory_index_level` tool and by
 * lib/memory-core.js's `memory_core` (its compact global index is level 0's render).
 *
 * TREE SHAPE. The index's OWN headings decide the groups: the shallowest heading level found in
 * the body is the "top" level (`##` in a real MEMORY.md; an index with no headings at all — e.g.
 * this repo's demo/memory/MEMORY.md — gets ONE ungrouped group covering the whole list, which is
 * still correct, just not very group-y). A deeper heading (`###`…) is folded into its enclosing
 * top group: its bullets still count as that group's entries, and its own text still appears in
 * that group's RAW block (level 2 + `group`), but it is not a group of its own — one extra level
 * of structure buys little here and would complicate "groups only" (level 0) for no real gain.
 *
 * LEVELS (memory_index_level's `level` argument; see renderLevel() below):
 *   0  groups only, ONE LINE EACH: "<group title>: <entry title>, <entry title>, …" — no hooks.
 *      This is deliberately also what satisfies memory_core's "compact global index": a group
 *      with no heading at all (the ungrouped case) renders as a bare comma list. Target ≤ 300
 *      tokens on a ~2.3k-token real index (measured in test/index-tree.test.js) — achievable
 *      because hooks (the bulk of an index's bytes) are dropped entirely, only slugs/titles kept.
 *      CONFIRMED-HUB COVERAGE (0.5.1.4): lib/hub-spoke.js's detection is deliberately
 *      conservative (see its own top comment) — a real memory can easily have groups where it
 *      confirms NO hub at all, even though every group plainly has real content. A group with
 *      zero confirmed hubs therefore never renders empty: it falls back to its own entries'
 *      titles instead, capped at `ENTRY_CAP` per group with a trailing "+N more" when there are
 *      more — bounded (see `ENTRY_CAP`/`renderLevel` below), never silent.
 *   1  groups + entries, one per line, still no hooks (`## <group>` then `- <entry title>` per
 *      entry) — a bit more scannable than level 0's single line, same information.
 *   2  the index exactly as stored (hooks included) — `tree.raw` verbatim, or, with `group`, just
 *      that one group's own block of the original text (heading(s) + bullets, byte-identical).
 * `group` (optional, any level): restricts the render to the one group whose title matches
 * (case-insensitive, accents folded) — "expand this one group" without paying for the rest.
 */
const { splitFrontmatterBlock } = require("./store/frontmatter");
const { LINE_RE } = require("./index-trim");
const { fold } = require("./store/text");

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
// 0.5.1.4: how many entries a group's level 0/1 render shows before switching to "+N more" — the
// bound that keeps level 0 small even when a group has no confirmed hub at all (the common case
// against real memories: lib/hub-spoke.js's detection is conservative on purpose) and would
// otherwise fall back to listing every one of its entries.
const ENTRY_CAP = 4;

function eolOf(text) { return String(text || "").includes("\r\n") ? "\r\n" : "\n"; }

/**
 * indexText → { raw, groups: [{ title, level, entries: [{ id, hook }], raw }] }
 * `title` is null for the ungrouped (no-heading) group. `raw` on a group is the exact slice of
 * the index's BODY (frontmatter excluded) it was built from — heading line(s) and bullets
 * included, byte-identical to the source.
 */
function parseIndexTree(indexText) {
  const { fm, body } = splitFrontmatterBlock(String(indexText || ""));
  const eol = eolOf(body);
  const lines = body.split(/\r?\n/);

  // Pass 1: the shallowest heading level present (ignoring the note's own "# Title", level 1,
  // which is the index's OWN title, never a group) decides what counts as a "top" group.
  let topLevel = null;
  lines.forEach((l) => {
    const m = HEADING_RE.exec(l);
    if (m && m[1].length >= 2 && (topLevel == null || m[1].length < topLevel)) topLevel = m[1].length;
  });

  const groups = [];
  let cur = null; // the group bullets currently belong to
  let curStart = 0;
  function closeCurrent(endLine) {
    if (!cur) return;
    cur.raw = lines.slice(curStart, endLine).join(eol);
  }

  lines.forEach((l, i) => {
    const h = HEADING_RE.exec(l);
    if (h && h[1].length >= 2) {
      const level = h[1].length;
      if (topLevel != null && level === topLevel) {
        closeCurrent(i);
        cur = { title: h[2].trim(), level, entries: [] };
        curStart = i;
        groups.push(cur);
      }
      // A deeper heading (level > topLevel): stays inside the current top group — nothing to do
      // beyond letting it fall into that group's raw block below.
      return;
    }
    const b = LINE_RE.exec(l);
    if (b) {
      // A bullet with no top heading yet (or no heading at all in the whole index, e.g. this
      // repo's demo/memory): one ungrouped group, opened lazily, starting at the top of the body.
      if (!cur) { cur = { title: null, level: null, entries: [] }; curStart = i; groups.push(cur); }
      cur.entries.push({ id: b[2].trim(), hook: b[4] });
    }
  });
  closeCurrent(lines.length);

  return { raw: String(indexText || ""), fm, groups };
}

/** Case/accent-insensitive match of a group's title against a `group` filter string. */
function groupMatches(g, filter) {
  if (g.title == null) return false;
  return fold(g.title) === fold(filter) || fold(g.title).includes(fold(filter));
}

/**
 * renderLevel(tree, level, { group, titleOf, hubIds }) → string.
 *   titleOf(id)  optionally maps an entry's link target to a display title (falls back to the id
 *                itself — e.g. when the caller has no note list handy, or the id does not
 *                resolve to a known note).
 *   hubIds       optional Set of entry ids that are CONFIRMED hubs (lib/hub-spoke.js's `detect()`
 *                — a note other notes declare `part_of`, or that structurally has sub-notes).
 *                When given, levels 0 and 1 list each group's hubs first; a group with NO
 *                confirmed hub (common — hub-spoke detection is conservative, see the module doc
 *                above) falls back to that group's own entries instead of rendering empty, same
 *                as when `hubIds` is omitted altogether (no hub/part relations known at all).
 *                Either way the list is capped at `ENTRY_CAP` entries with a trailing "+N more"
 *                — level 0/1 never grow with an unbounded group.
 * Levels 0 and 1 carry the SAME filtered content; they differ only in how compactly it reads —
 * 0 in one comma-joined line per group (the smallest a meaningful summary can be), 1 as a
 * `## heading` + one `- title` per line block (easier to scan, same information, still no hooks).
 */
function renderLevel(tree, level, { group = null, titleOf = null, hubIds = null } = {}) {
  const groups = group ? tree.groups.filter((g) => groupMatches(g, group)) : tree.groups;
  const nameOf = (id) => (typeof titleOf === "function" ? String(titleOf(id) || id) : id);
  // Confirmed hubs first; a group with none falls back to its own entries (never silence), and
  // either way the shown list is capped — "+N more" says what was left out, it is never just cut.
  function entriesOf(g) {
    const confirmed = hubIds ? g.entries.filter((e) => hubIds.has(e.id)) : g.entries;
    const pool = confirmed.length ? confirmed : g.entries;
    return { shown: pool.slice(0, ENTRY_CAP), extra: Math.max(0, pool.length - ENTRY_CAP) };
  }
  const lvl = Number(level) || 0;

  if (lvl >= 2) {
    if (!group) return tree.raw;
    return groups.map((g) => g.raw).join("\n\n");
  }
  if (lvl === 1) {
    return groups.map((g) => {
      const head = g.title != null ? `## ${g.title}` : "(ungrouped)";
      const { shown, extra } = entriesOf(g);
      const items = shown.map((e) => `- ${nameOf(e.id)}`);
      if (extra) items.push(`- +${extra} more`);
      return [head, ...items].join("\n");
    }).join("\n\n");
  }
  // level 0 (default/fallback for anything < 0 too): one compact line per group.
  return groups.map((g) => {
    const label = g.title != null ? g.title : "(index)";
    const { shown, extra } = entriesOf(g);
    const names = shown.map((e) => nameOf(e.id));
    if (extra) names.push(`+${extra} more`);
    return names.length ? `${label}: ${names.join(", ")}` : label;
  }).join("\n");
}

module.exports = { parseIndexTree, renderLevel, groupMatches, ENTRY_CAP };
