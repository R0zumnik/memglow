"use strict";
/**
 * Hub-and-spoke structure detector — PURE, zero fs, zero Express, zero dependency on the rest of
 * memglow (see the owner's rule, documented in lib/memory-rules.js and docs/hub-and-spoke.md):
 *
 *   - the memory index lists only project summaries ("hubs") and stand-alone notes;
 *   - a hub lists its sub-notes, one line each;
 *   - a sub-note links back to its hub only — never a list of all its siblings;
 *   - a cross-link to another note is fine only when the text really refers to it.
 *
 * This module finds where a memory DRIFTS from that shape, from plain data: nothing here reads a
 * file or talks to an AI. Callers (lib/assistant/tidy.js, mcp-server/memglow-mcp.js) feed it
 * `{ id, label, body }` records built from lib/memory.js (body = text with frontmatter already
 * stripped; the index note is any of them, named by `indexId`).
 *
 * A HUB is a note that links to >= 2 notes which link back to it (a genuine, mutual, listed
 * relationship — not just "a note that happens to have many neighbours"). Its "sub-notes" are
 * every note it links to or that links to it (the mutual ones, plus any one-directional straggler
 * that rules (d)/(e) below exist to fix).
 *
 * Findings, all keyed by note id (never note text beyond the one line a fix would touch):
 *   (a) hubs             — see above.
 *   (b) indexRedundant    — the index links to a sub-note S whose hub H is ALSO in the index: S's
 *                           entry is redundant (H's own line already covers it). Deterministic:
 *                           no AI needed, memglow can just drop that index line.
 *   (c) siblingLines      — inside a sub-note, a LINE that links to >= 2 other sub-notes of the
 *                           same hub. `pure: true` when the line is nothing but that list (a
 *                           "Siblings:"/"See also:"/"Related:" label, bullets, separators and the
 *                           links — safe to delete outright, deterministically). `pure: false`
 *                           means the links sit inside real prose: only an AI, reading the text,
 *                           can tell whether the cross-link is a legitimate reference or should go.
 *   (d) missingUplinks    — a hub lists a sub-note that never links back to it: that sub-note is
 *                           missing its one-line uplink.
 *   (e) missingHubLines   — a sub-note links to a hub the hub itself never lists: the hub is
 *                           missing a line for it.
 *
 * `counts` is what a dashboard or an MCP tool shows at a glance.
 */

// Same shape as lib/memory.js's linksOf, kept local on purpose: this module must stay import-free
// and independently testable.
const LINK_RE = /\[\[([^\]|#\n]{1,150})(?:[#|][^\]\n]*)?\]\]/g;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const SIBLING_LABEL_RE = /\b(siblings?|see also|related(?:\s+notes?)?|and|also)\b/gi;
const LIST_MARKER_RE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s*/;

function linkTargetsOf(line) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(line))) out.push(m[1].trim());
  return out;
}

/**
 * One entry per physical line of `body`: { text, links: [target ids] }. Lines inside a fenced code
 * block (``` or ~~~) or an inline code span carry no links — a note that quotes "[[example]]" as
 * sample text is never treated as a real link. The line COUNT is preserved (one entry per `\n`),
 * which matters to callers that later edit one exact line.
 */
function parseLines(body) {
  const rawLines = String(body || "").split(/\r?\n/);
  let inFence = false;
  return rawLines.map((text) => {
    if (FENCE_RE.test(text)) { inFence = !inFence; return { text, links: [] }; }
    if (inFence) return { text, links: [] };
    return { text, links: linkTargetsOf(text.replace(/`[^`\n]*`/g, " ")) };
  });
}

/** Whether `line`, once its sibling links and connective words/markers are removed, says nothing else. */
function isPureSiblingLine(text) {
  const stripped = text
    .replace(LIST_MARKER_RE, "")
    .replace(LINK_RE, " ")
    .replace(SIBLING_LABEL_RE, " ")
    .replace(/[*_]/g, " ")
    .replace(/[,;:·•\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "";
}

/**
 * detect({ notes: [{ id, label, body }], indexId }) → {
 *   hubs: [{ id, label, subNotes: [id,…] }],
 *   indexRedundant: [{ note, hub }],
 *   siblingLines: [{ note, hub, lineIndex, text, links: [id,…], pure }],
 *   missingUplinks: [{ hub, note }],
 *   missingHubLines: [{ hub, note }],
 *   counts: { hubs, indexRedundant, siblingLines, pureSiblingLines, missingUplinks, missingHubLines },
 * }
 * Everything is pure: same input → same output, no I/O, no randomness.
 */
function detect({ notes = [], indexId = null } = {}) {
  const byId = new Map((notes || []).filter((n) => n && typeof n.id === "string").map((n) => [n.id, n]));
  const linesById = new Map();
  const outgoing = new Map();   // id -> Set(target)
  const incoming = new Map();   // id -> Set(source)
  for (const id of byId.keys()) incoming.set(id, new Set());

  for (const [id, n] of byId) {
    const lines = parseLines(n.body).map((l) => ({ text: l.text, links: l.links.filter((t) => t !== id && byId.has(t)) }));
    linesById.set(id, lines);
    const out = new Set();
    for (const l of lines) for (const t of l.links) out.add(t);
    outgoing.set(id, out);
  }
  for (const [id, out] of outgoing) for (const t of out) incoming.get(t).add(id);

  // (a) hubs: >= 2 mutual (listed by this note AND linking back to it). The index note itself is
  // never a hub, and a link to/from the index never counts towards a hub relationship — the index
  // naturally links to every hub it lists, which is expected and not a spoke relationship.
  const hubs = [];
  const hubOf = new Map(); // sub-note id -> first hub that claims it
  for (const id of byId.keys()) {
    if (id === indexId) continue;
    const out = new Set([...outgoing.get(id)].filter((t) => t !== indexId));
    const inc = new Set([...incoming.get(id)].filter((t) => t !== indexId));
    const mutual = [...out].filter((t) => inc.has(t));
    if (mutual.length < 2) continue;
    const subNotes = [...new Set([...out, ...inc])].sort();
    const n = byId.get(id);
    hubs.push({ id, label: n.label || id, subNotes });
    for (const s of subNotes) if (!hubOf.has(s)) hubOf.set(s, id);
  }
  const hubIds = new Set(hubs.map((h) => h.id));

  // (b) index redundancy: the index links to a sub-note S whose hub H is also linked by the index.
  const indexRedundant = [];
  if (indexId && outgoing.has(indexId)) {
    const indexOut = outgoing.get(indexId);
    for (const target of indexOut) {
      const hub = hubOf.get(target);
      if (hub && hub !== target && indexOut.has(hub)) indexRedundant.push({ note: target, hub });
    }
  }

  // (c) sibling lines: inside a sub-note, a line naming >= 2 OTHER sub-notes of the same hub.
  const siblingLines = [];
  for (const hub of hubs) {
    const siblingSet = new Set(hub.subNotes);
    for (const s of hub.subNotes) {
      if (s === hub.id) continue;
      const lines = linesById.get(s) || [];
      lines.forEach((line, lineIndex) => {
        const others = [...new Set(line.links.filter((t) => t !== s && siblingSet.has(t)))];
        if (others.length < 2) return;
        siblingLines.push({ note: s, hub: hub.id, lineIndex, text: line.text, links: others.sort(), pure: isPureSiblingLine(line.text) });
      });
    }
  }

  // (d) a hub lists a sub-note that never links back.
  const missingUplinks = [];
  for (const hub of hubs) {
    const inc = incoming.get(hub.id);
    for (const s of outgoing.get(hub.id)) if (s !== indexId && !inc.has(s)) missingUplinks.push({ hub: hub.id, note: s });
  }

  // (e) a sub-note links to a hub the hub itself never lists (the index itself never needs a line
  // added to the hub it lists — that is the whole point of it being the index).
  const missingHubLines = [];
  for (const hub of hubs) {
    const out = outgoing.get(hub.id);
    for (const s of incoming.get(hub.id)) if (s !== indexId && !out.has(s)) missingHubLines.push({ hub: hub.id, note: s });
  }

  const pureSiblingLines = siblingLines.filter((l) => l.pure).length;
  return {
    hubs, indexRedundant, siblingLines, missingUplinks, missingHubLines,
    counts: {
      hubs: hubs.length,
      indexRedundant: indexRedundant.length,
      siblingLines: siblingLines.length,
      pureSiblingLines,
      missingUplinks: missingUplinks.length,
      missingHubLines: missingHubLines.length,
    },
    _internal: { byId, linesById, outgoing, incoming, hubIds },
  };
}

module.exports = { detect, parseLines, linkTargetsOf, isPureSiblingLine };
