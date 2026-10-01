"use strict";
/**
 * Related notes — one scoring rule shared by the memglow MCP server (`related_notes` tool) and the
 * MCP proxy ("context suggestions" lever). Pure: no fs, no network; note metadata in, ranked ids out.
 *
 *   link to or from the note      +3 per direction  ("outgoing link", "incoming link")
 *   same theme AND sub-theme       +1               ("same sub-theme")
 *   read on the same days          +min(reads, 5)   ("co-usage"; only when activity counters exist)
 *
 * Ties are broken by id, so the same input always gives the same answer. Never looks at bodies.
 */

/** Notes read on the same days as `id`, from the activity counters: Map(otherId → reads). */
function coReads(days, id) {
  const out = new Map();
  if (!days || typeof days !== "object") return out;
  for (const o of Object.values(days)) {
    const notes = o && o.notes;
    if (!notes || !notes[id] || !(notes[id].read > 0)) continue;
    for (const [oid, c] of Object.entries(notes)) {
      if (oid === id || !c || !(c.read > 0)) continue;
      out.set(oid, (out.get(oid) || 0) + c.read);
    }
  }
  return out;
}

/**
 * rankRelated({ id, theme, subtheme, outgoing, incoming, nodes, days, limit, exclude })
 *   nodes   : iterable of { id, theme, subtheme } (every candidate note)
 *   days    : activity counters (lib/counters.js `days()`), or null when unavailable
 *   exclude : optional Set of ids never to return
 * → [{ id, score, reasons: [...] }], best first.
 */
function rankRelated({ id, theme, subtheme, outgoing = [], incoming = [], nodes = [], days = null, limit = 10, exclude = null }) {
  const known = new Set();
  for (const n of nodes) known.add(n.id);
  const scored = new Map();
  const bump = (oid, reason, weight) => {
    if (oid === id || !known.has(oid) || (exclude && exclude.has(oid))) return;
    const e = scored.get(oid) || { reasons: new Set(), score: 0 };
    e.reasons.add(reason);
    e.score += weight;
    scored.set(oid, e);
  };
  for (const t of outgoing) bump(t, "outgoing link", 3);
  for (const t of incoming) bump(t, "incoming link", 3);
  if (subtheme) {
    for (const n of nodes) if (n.id !== id && n.subtheme && n.theme === theme && n.subtheme === subtheme) bump(n.id, "same sub-theme", 1);
  }
  if (days) for (const [oid, n] of coReads(days, id)) bump(oid, "co-usage", Math.min(n, 5));
  return [...scored.entries()]
    .sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map(([oid, e]) => ({ id: oid, score: e.score, reasons: [...e.reasons] }));
}

module.exports = { rankRelated, coReads };
