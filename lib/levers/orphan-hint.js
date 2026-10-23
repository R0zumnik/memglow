"use strict";
/**
 * MCP proxy levers — orphanHint, 0.5.3 (split of lib/proxy-levers.js, see that file's own top
 * comment for the full picture). Gated and wired the same way as duplicateHint/slugHint/hubHint
 * (lib/levers/duplicate-hint.js, lib/levers/hub-hint.js): advisory only, never blocks, never
 * changes the write's own arguments or result content beyond one appended block.
 *
 * A note memglow's own graph (lib/memory.js, via lib/levers/note-index.js's `linked()`) finds
 * NEITHER an outgoing `[[wikilink]]` from it NOR an incoming one to it floats alone — nothing
 * leads a reader (or an assistant later re-reading the index/hub tree) to it, and it leads
 * nowhere either. Checked only for a brand-new note (never an edit, never an overwrite of a note
 * that already existed — the caller, proxy-levers.js's handleWrite, decides that BEFORE this
 * write reaches the server, the same way duplicateHint does) and never for the index note(s)
 * (theme "index" — the caller's job to exclude, same exclusion duplicateHint/hubHint use).
 */
const { block } = require("./responses");

/**
 * The one advisory block orphanHint ever adds — null for no id (never called that way in
 * practice, but kept pure/total like every other lever helper here).
 */
function orphanHintFor(id) {
  if (typeof id !== "string" || !id) return null;
  return block(`memglow: note [[${id}]] links to nothing and nothing links to it — add an "Up: [[hub]]" line or list it in its hub/index, or it will float alone in the graph.`);
}

module.exports = { orphanHintFor };
