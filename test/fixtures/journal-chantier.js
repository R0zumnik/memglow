"use strict";
// Synthetic fixture for lever 17 (stateView, "journal → current state view", 0.5.1.2): a
// fictitious building-site log in French, shaped the way the owner's own dated notes are —
// undated rules/parts up top, then sections appended over time, their headings mixing the
// formats the task calls out (`2/9`, `10/9 soir`, `(2026-09-28)`, `12/10`…). Entirely made up —
// no real address, no real person, no real supplier — safe to commit.
function fillerParagraph(n, tag) {
  return Array.from({ length: n }, (_, i) => `Avancement du chantier${tag ? " " + tag : ""}, détail ligne ${i} sur les travaux en cours.`).join(" ") + "\n";
}

/**
 * journalChantier({ fillerLines, tagged }) -> markdown text (frontmatter included):
 *   - intro (frontmatter + one paragraph)
 *   - "## Règles" and "## Parts" — undated
 *   - 6 dated sections, oldest to newest: "2/9", "10/9 soir", "20/9", "(2026-09-28)", "5/10 soir",
 *     "12/10" — the last two are the ones lever 17 is expected to keep in full.
 * `tagged`: when true, each dated section's filler carries its own heading as a distinguishing
 * marker (tests can assert a given section's text is, or is not, present in a shortened answer).
 */
function journalChantier({ fillerLines = 40, tagged = false } = {}) {
  const titles = ["Mise à jour 2/9", "État au 10/9 soir", "Mise à jour 20/9", "Chantier en cours (2026-09-28)", "État au 5/10 soir", "Mise à jour 12/10"];
  const section = (title) => `## ${title}\n${fillerParagraph(fillerLines, tagged ? `[${title}]` : "")}\n`;
  return [
    "---",
    "title: Chantier Rénovation Grange",
    "theme: projects",
    "---",
    "",
    "Suivi du chantier de rénovation de la grange : atelier au rez-de-chaussée, logement à l'étage.",
    "",
    "## Règles",
    "- Toujours couper l'électricité avant toute intervention sur le tableau.",
    "- Les livraisons de matériaux se font le matin avant 9h.",
    "",
    "## Parts",
    "- [[chantier-renovation-grange-electricite]] — électricité",
    "- [[chantier-renovation-grange-plomberie]] — plomberie",
    "",
    ...titles.map(section),
  ].join("\n");
}

module.exports = { journalChantier };
