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
 * file or talks to an AI. Callers (lib/assistant/tidy.js, mcp-server/memglow-mcp.js, server.js)
 * feed it `{ id, label, text, folder }` records built from lib/memory.js (`text` = the note's
 * FULL raw content, frontmatter included — this module splits it itself, see `splitFrontmatter`
 * below; `folder` = its path relative to MEMORY_DIR, "" at the top level).
 *
 * CONSERVATIVE BY DESIGN (2026-10-02 rewrite). An earlier version called any note that merely had
 * >= 2 mutual [[links]] with other notes a "hub" — tested only on small, controlled fixtures, it
 * looked right. Run on a real, 72-note memory full of ordinary cross-linking between independent
 * notes (a person's profile, their family, a feedback note, a reference note), it was wildly
 * over-eager: 33 "hubs" where there were really 4, including turning the user's own PROFILE note
 * into a "sub-note" of an unrelated feedback note, just because they happened to link to each
 * other twice. Applying fixes built on that would have REMOVED the profile and family notes from
 * the index. Mutual links between independent notes are ordinary content cross-links, not
 * structure, and must never be read as one note being the hub of another.
 *
 * So a hub/spoke relationship is now accepted in exactly two ways, in this order:
 *
 *   1. AN EXPLICIT MARKER on the sub-note — checked FIRST, and trusted outright, no further
 *      structural proof asked: either a `part_of:`/`parent:` frontmatter key, or one of a few
 *      fixed header-line phrasings near the top of the body ("Part of … [[Hub]]", "Split on …
 *      from [[Hub]]", "Summary: [[Hub]]", "Up: [[Hub]]" — see `HEADER_MARKER_RES`). This is
 *      exactly the convention memglow's own split already writes into a note's body by hand
 *      (lib/assistant/proposal.js now also writes `part_of:` into every new part's frontmatter,
 *      so a FUTURE split is exact, not inferred) — and, it turns out, exactly what a careful human
 *      splitting a note by hand already wrote, unprompted, on the memory this rewrite was tested
 *      against. `declaredHubOf()` below is the pure lookup, exported for its own unit tests.
 *   2. A STRUCTURAL FALLBACK, for notes with no marker, accepted ONLY when ALL of this holds for a
 *      candidate hub H and sub-note B: H links to B AND B links to H (a real, two-way
 *      relationship — one link alone is just a citation); B is in the SAME FOLDER as H (an
 *      unrelated note from another part of the memory is never structurally a sub-note); every
 *      note that links to B, other than the index, is EITHER H or another accepted sub-note of H
 *      (a note that outside notes also point to is a shared reference, not private structure —
 *      this single condition is what correctly rejects a tightly-linked family of independent
 *      "people" notes: the moment one outside note cites any of them, the whole candidate group is
 *      rejected); and H has at least 2 such B (one alone proves nothing). The set is grown by
 *      removing candidates that fail the closure test until it stops changing (`structuralSpokesOf`).
 *
 * Only CONFIRMED spokes (from either path) feed findings (b)–(e) below; a note merely mentioned
 * by a hub, or merely mentioning one, with no marker and no closed structural proof, is left alone
 * — the conservative default is to find nothing, not to guess.
 *
 * Findings, all keyed by note id (never note text beyond the one line a fix would touch):
 *   (a) hubs             — confirmed hub/spoke groups.
 *   (b) indexRedundant    — the index links to a confirmed sub-note S whose hub H is ALSO in the
 *                           index: S's entry is redundant (H's own line already covers it).
 *   (c) siblingLines      — inside a confirmed sub-note, a LINE that links to >= 2 OTHER confirmed
 *                           sub-notes of the SAME hub. `pure: true` when the line is nothing but
 *                           that list (a label, bullets, separators and the links — safe to delete
 *                           outright). `pure: false` means the links sit inside real prose: only
 *                           an AI, reading the text, can tell whether to keep each one.
 *   (d) missingUplinks    — a confirmed sub-note that does not (yet) link back to its hub. In
 *                           practice this only ever fires for a MARKER-confirmed spoke (the
 *                           structural path already requires the back-link to confirm at all).
 *   (e) missingHubLines   — a confirmed hub that does not (yet) list one of its confirmed
 *                           sub-notes. Same note: only fires for a marker-confirmed spoke.
 *
 * `counts` is what a dashboard or an MCP tool shows at a glance.
 */

// Same shape as lib/memory.js's linksOf, kept local on purpose: this module must stay import-free
// and independently testable.
const LINK_RE = /\[\[([^\]|#\n]{1,150})(?:[#|][^\]\n]*)?\]\]/g;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const SIBLING_LABEL_RE = /\b(siblings?|see also|related(?:\s+notes?)?|and|also)\b/gi;
const LIST_MARKER_RE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s*/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MARKER_KEY_RE = /^[ \t]*(part_of|parent)[ \t]*:[ \t]*(.+?)[ \t]*$/im;
// A header line "declares" its hub only near the very start of the line (an optional blockquote
// `>`, bullet or bold marker aside): a note that merely MENTIONS "part of" deep in a sentence, or
// well past the top of the body, is text, not a declaration. Checked against each of the first
// HEADER_SCAN_LINES non-empty lines of the body.
const HEADER_SCAN_LINES = 5;
const HEADER_LEAD_RE = "^[ \\t>*_]*";
const HEADER_MARKER_RES = [
  new RegExp(HEADER_LEAD_RE + "split\\s+on\\b.{0,80}?\\bfrom\\b[ \\t:]*\\[\\[([^\\]|#]+)", "i"),
  new RegExp(HEADER_LEAD_RE + "part\\s+of\\b.{0,80}?\\[\\[([^\\]|#]+)", "i"),
  new RegExp(HEADER_LEAD_RE + "summary\\s*:?\\s*\\[\\[([^\\]|#]+)", "i"),
  new RegExp(HEADER_LEAD_RE + "up\\s*:?\\s*\\[\\[([^\\]|#]+)", "i"),
];

function linkTargetsOf(line) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(line))) out.push(m[1].trim());
  return out;
}

/** `text` → { fm, body } (fm = the fenced block with its delimiters, "" if none). */
function splitFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(String(text || ""));
  return m ? { fm: m[0], body: String(text).slice(m[0].length) } : { fm: "", body: String(text || "") };
}

function cleanMarkerValue(raw) {
  const v = String(raw || "").trim();
  const link = /^\[\[([^\]|#]+)/.exec(v);
  if (link) return link[1].trim();
  return v.replace(/^["']|["']$/g, "").trim();
}

/**
 * The hub id a note DECLARES for itself (not yet resolved against known notes — that is the
 * caller's job, case-insensitively), or null. Pure: frontmatter `part_of`/`parent` first, then the
 * first of the first few body lines that matches one of `HEADER_MARKER_RES`. Exported for its own
 * unit tests.
 */
function declaredHubOf(text) {
  const { fm, body } = splitFrontmatter(text);
  const fmMatch = MARKER_KEY_RE.exec(fm);
  if (fmMatch) {
    const v = cleanMarkerValue(fmMatch[2]);
    if (v) return v;
  }
  const lines = String(body || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, HEADER_SCAN_LINES);
  for (const line of lines) {
    for (const re of HEADER_MARKER_RES) {
      const m = re.exec(line);
      if (m) return m[1].trim();
    }
  }
  return null;
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
    .replace(/[,;:·•\-–—.!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "";
}

/**
 * detect({ notes: [{ id, label, text, folder }], indexId }) → {
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
  const records = (notes || []).filter((n) => n && typeof n.id === "string");
  const byId = new Map(records.map((n) => [n.id, n]));
  const byLowerId = new Map(records.map((n) => [n.id.toLowerCase(), n.id]));
  const linesById = new Map();
  const outgoing = new Map();   // id -> Set(target)
  const incoming = new Map();   // id -> Set(source)
  for (const id of byId.keys()) incoming.set(id, new Set());

  for (const [id, n] of byId) {
    const { body } = splitFrontmatter(n.text);
    const lines = parseLines(body).map((l) => ({ text: l.text, links: l.links.filter((t) => t !== id && byId.has(t)) }));
    linesById.set(id, lines);
    const out = new Set();
    for (const l of lines) for (const t of l.links) out.add(t);
    outgoing.set(id, out);
  }
  for (const [id, out] of outgoing) for (const t of out) incoming.get(t).add(id);

  /** The hub id a note declares for itself, resolved to a KNOWN note id (case-insensitive), or null. */
  function resolvedDeclaredHub(id) {
    const n = byId.get(id);
    if (!n) return null;
    const raw = declaredHubOf(n.text);
    if (!raw) return null;
    const hit = byId.has(raw) ? raw : byLowerId.get(raw.toLowerCase());
    return hit && hit !== id && hit !== indexId ? hit : null;
  }

  // Pass 1: explicit markers — trusted outright, no structural proof asked.
  const confirmedHub = new Map(); // sub-note id -> hub id
  for (const id of byId.keys()) {
    if (id === indexId) continue;
    const h = resolvedDeclaredHub(id);
    if (h) confirmedHub.set(id, h);
  }

  // Pass 2: structural fallback, only for notes with no marker, processed in a fixed (sorted)
  // order so the result never depends on object/Map iteration order.
  const candidateHubIds = [...byId.keys()].filter((id) => id !== indexId).sort();
  for (const h of candidateHubIds) {
    const hub = byId.get(h);
    const outH = outgoing.get(h);
    const incH = incoming.get(h);
    let group = new Set();
    for (const b of outH) {
      if (b === h || b === indexId) continue;
      if (!incH.has(b)) continue; // must be mutual: a citation alone proves nothing
      const bRec = byId.get(b);
      if (!bRec || (bRec.folder || "") !== (hub.folder || "")) continue; // same folder only
      if (confirmedHub.has(b) && confirmedHub.get(b) !== h) continue; // already claimed elsewhere
      group.add(b);
    }
    // Shrink until every member's incoming (excluding the index) comes only from H or the group.
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of [...group]) {
        const incB = incoming.get(b);
        for (const src of incB) {
          if (src === indexId) continue;
          if (src === h || group.has(src)) continue;
          group.delete(b);
          changed = true;
          break;
        }
      }
    }
    if (group.size >= 2) {
      for (const b of group) if (!confirmedHub.has(b)) confirmedHub.set(b, h);
    }
  }

  // Build the hub list from the confirmed map.
  const hubGroups = new Map(); // hub id -> Set(sub-note ids)
  for (const [sub, hubId] of confirmedHub) {
    if (!hubGroups.has(hubId)) hubGroups.set(hubId, new Set());
    hubGroups.get(hubId).add(sub);
  }
  const hubs = [...hubGroups.entries()].map(([id, subs]) => ({
    id, label: (byId.get(id) || {}).label || id, subNotes: [...subs].sort(),
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // (b) index redundancy: the index links to a confirmed sub-note S whose hub H is also listed.
  const indexRedundant = [];
  if (indexId && outgoing.has(indexId)) {
    const indexOut = outgoing.get(indexId);
    for (const [sub, hubId] of confirmedHub) {
      if (indexOut.has(sub) && indexOut.has(hubId) && sub !== hubId) indexRedundant.push({ note: sub, hub: hubId });
    }
  }

  // (c) sibling lines: inside a confirmed sub-note, a line naming >= 2 OTHER confirmed sub-notes
  // of the SAME hub.
  const siblingLines = [];
  for (const hub of hubs) {
    const siblingSet = new Set(hub.subNotes);
    for (const s of hub.subNotes) {
      const lines = linesById.get(s) || [];
      lines.forEach((line, lineIndex) => {
        const others = [...new Set(line.links.filter((t) => t !== s && siblingSet.has(t) && confirmedHub.get(t) === hub.id))];
        if (others.length < 2) return;
        siblingLines.push({ note: s, hub: hub.id, lineIndex, text: line.text, links: others.sort(), pure: isPureSiblingLine(line.text) });
      });
    }
  }

  // (d) a confirmed sub-note that does not (yet) link back to its hub.
  const missingUplinks = [];
  for (const [sub, hubId] of confirmedHub) if (!outgoing.get(sub).has(hubId)) missingUplinks.push({ hub: hubId, note: sub });

  // (e) a confirmed sub-note that ALREADY links to its hub, but the hub does not (yet) list it
  // back. (A confirmed sub-note that does not even link to its hub is (d)'s missing uplink, not
  // this: the hub cannot be faulted for not listing a note that does not point to it at all.)
  const missingHubLines = [];
  for (const [sub, hubId] of confirmedHub) {
    if (outgoing.get(sub).has(hubId) && !outgoing.get(hubId).has(sub)) missingHubLines.push({ hub: hubId, note: sub });
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
    _internal: { byId, linesById, outgoing, incoming, confirmedHub },
  };
}

module.exports = { detect, parseLines, linkTargetsOf, isPureSiblingLine, declaredHubOf, splitFrontmatter };
