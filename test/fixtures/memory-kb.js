"use strict";
// Shared fixture for the memglow memory server tests (test/memory-server-*.test.js): a small
// knowledge base in a temp folder, laid out like a basic-memory project root (memory/, docs/),
// with the edge cases the store must survive. Requiring this file has no side effect.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY = 86400000;

const NOTES = {
  "memory/MEMORY.md": "---\ntitle: MEMORY\ntype: note\npermalink: main/memory/memory\n---\n\n# Memory index\n\n- [[alice]] — Alice, a friend\n- [[Garden Project]] — the garden\n",
  "memory/people/alice.md": [
    "---",
    "title: Alice Martin",
    "type: person",
    "permalink: main/memory/people/alice",
    "tags: [family, friend]",
    "status: active",
    "description: 'Alice, a close friend who lives in Orléans and loves",
    "  gardening'",
    "---",
    "",
    "Alice is a friend of the family.",
    "",
    "## Contact",
    "Phone in the address book.",
    "",
    "## Observations",
    "- [fact] Alice lives in Orléans #city (since 2020)",
    "- [preference] Alice prefers tea over coffee",
    "- [ ] a task, not an observation",
    "",
    "## Relations",
    "- knows [[bob]]",
    "- works_with [[Garden Project]]",
    "",
  ].join("\n"),
  "memory/people/bob.md": "Bob plays rugby at the stade every Saturday.\nHe is a friend of [[alice]].\n",
  "memory/projects/garden-project.md": [
    "---",
    "title: Garden Project",
    "type: project",
    "permalink: main/memory/projects/garden-project",
    "status: in-progress",
    "tags:",
    "- garden",
    "- home",
    "metadata:",
    "  priority: 2",
    "  owner: alice",
    "---",
    "",
    "Plan the vegetable garden with [[alice]].",
    "",
    "## Été 2026",
    "Tomates et courgettes en été, arrosage le soir.",
    "",
    "```",
    "# not a heading",
    "[[not-a-link]]",
    "```",
    "- [todo] buy seeds for the garden",
  ].join("\n"),
  "memory/projects/rugby-club.md": "---\ntitle: Rugby Club\ntype: project\nstatus: done\n---\n\nThe rugby club of Bob. Training at the stade; a small garden behind the clubhouse.\n",
  "memory/notes/réseau-maison.md": "---\ntitle: Réseau maison\ntype: note\n---\n\nLe réseau wifi de la maison : box, répéteur et câble.\n",
  "memory/notes/crlf.md": "﻿---\r\ntitle: Windows Note\r\ntype: note\r\n---\r\n\r\n## Heading CRLF\r\nLine with windows endings and [[bob]].\r\n",
  "memory/notes/bad-yaml.md": "---\ntitle: Broken Yaml\n  nonsense: [unclosed\n: : :\ntype: note\n---\n\nThe body is still searchable: zebra.\n",
  "docs/readme.md": "# Docs readme\n\nA document outside the memory folder about the knowledge base.\n",
};

/**
 * makeKb({ old: [rel…] }) → { root, dir(rel), write(rel, text), cleanup() }. Every note is dated
 * now - 1 day, except `old` ones (now - 40 days). Adds a non-UTF-8 file and a too-large file.
 */
function makeKb({ old = ["memory/projects/rugby-club.md", "docs/readme.md"], hugeBytes = 300 * 1024 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memglow-ms-"));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  const now = Date.now();
  for (const [rel, text] of Object.entries(NOTES)) {
    const abs = write(rel, text);
    const t = (old.includes(rel) ? now - 40 * DAY : now - DAY) / 1000;
    fs.utimesSync(abs, t, t);
  }
  // Not UTF-8 (Latin-1 bytes): skipped with a warning.
  const bin = path.join(root, "memory/notes/latin1.md");
  fs.writeFileSync(bin, Buffer.from([0x52, 0xe9, 0x73, 0x65, 0x61, 0x75, 0xff, 0xfe, 0x0a]));
  // Too large for the store's limit used in the tests (maxFileBytes 200 KB).
  write("memory/notes/huge.md", "# Huge\n" + "lorem ipsum ".repeat(Math.ceil(hugeBytes / 12)));
  // Hidden folder: never indexed.
  write(".git/ignored.md", "secret");
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { makeKb, NOTES, DAY };
