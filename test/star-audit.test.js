"use strict";
// lib/star-audit.js — the star-structure guardian: pure detection of R1-R5 drift from the
// hub-and-spoke layout, the mechanical fix builder, and (briefly) the store/writer-backed worker
// that applies deterministic fixes on temp knowledge bases. Idempotence (a second audit after the
// fixes land finds nothing left to fix) and "archive/ is never touched" are checked explicitly.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMemoryServer } = require("../memory-server/memglow-memory-server");
const star = require("../lib/star-audit");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function rec(id, text, folder = "") { return { id, label: id, text, folder }; }

test("audit: R1 — the index links to a confirmed part; fix replaces the line with the hub (or drops it if the hub is already listed)", () => {
  const notes = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n# Index\n\n- [[hub]] — the hub\n- [[spoke]] — a part, should not be here\n"),
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[spoke]] — the spoke\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  const r1 = issues.filter((i) => i.rule === "R1");
  assert.strictEqual(r1.length, 1);
  assert.strictEqual(r1[0].fix.type, "replace-index-line");
  assert.strictEqual(r1[0].fix.hubAlreadyListed, true);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const built = star.buildFix(r1[0].fix, byId);
  assert.doesNotMatch(built.after, /\[\[spoke\]\]/);
  assert.match(built.after, /\[\[hub\]\] — the hub/);

  // Hub NOT already listed: the line is rewritten to point at it instead of dropped.
  const notes2 = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n- [[spoke]] — a part, should not be here\n"),
    notes[1], notes[2],
  ];
  const issues2 = star.audit({ notes: notes2, indexId: "MEMORY" });
  const r1b = issues2.find((i) => i.rule === "R1");
  assert.strictEqual(r1b.fix.hubAlreadyListed, false);
  const built2 = star.buildFix(r1b.fix, new Map(notes2.map((n) => [n.id, n])));
  assert.match(built2.after, /\[\[hub\]\] — a part, should not be here/);
});

test("audit: R2 — a confirmed part with no link back to its hub; fix adds an Up: line", () => {
  const notes = [
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[spoke]] — the spoke\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nNo uplink here at all.\n"),
  ];
  const issues = star.audit({ notes, indexId: null });
  const r2 = issues.find((i) => i.rule === "R2");
  assert.ok(r2, JSON.stringify(issues));
  assert.strictEqual(r2.fix.type, "add-up-line");
  const built = star.buildFix(r2.fix, new Map(notes.map((n) => [n.id, n])));
  assert.match(built.after, /^---\ntitle: spoke\npart_of: hub\n---\n\nUp: \[\[hub\]\] — part of hub\.\n\nNo uplink here at all\.\n$/);
});

test("audit: R3 (half 1) — a confirmed part the hub forgot to list; fix appends the bullet", () => {
  const notes = [
    rec("hub", "---\ntitle: hub\n---\n\nHub body, no Parts section yet.\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n"),
  ];
  const issues = star.audit({ notes, indexId: null });
  const r3 = issues.find((i) => i.rule === "R3" && i.note === "hub");
  assert.ok(r3);
  assert.strictEqual(r3.fix.type, "append-hub-parts-line");
  const built = star.buildFix(r3.fix, new Map(notes.map((n) => [n.id, n])));
  assert.match(built.after, /## Parts\n- \[\[spoke\]\] — spoke\n/);
});

test("audit: R3 (half 2) — a hub's ## Parts names a note with no part_of; fix adds it, UNLESS two hubs both claim it", () => {
  const notes = [
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[loose]] — loose note\n"),
    rec("loose", "---\ntitle: loose\n---\n\nBody.\n"),
  ];
  const issues = star.audit({ notes, indexId: null });
  const r3 = issues.find((i) => i.rule === "R3" && i.note === "loose");
  assert.ok(r3);
  assert.strictEqual(r3.fix.type, "add-part-of");
  const built = star.buildFix(r3.fix, new Map(notes.map((n) => [n.id, n])));
  assert.match(built.after, /^---\ntitle: loose\npart_of: hub\n---\n/);

  const notesClaimedTwice = [
    rec("hub-a", "---\ntitle: hub-a\n---\n\n## Parts\n- [[loose]] — loose note\n"),
    rec("hub-b", "---\ntitle: hub-b\n---\n\n## Parts\n- [[loose]] — loose note\n"),
    rec("loose", "---\ntitle: loose\n---\n\nBody.\n"),
  ];
  const issues2 = star.audit({ notes: notesClaimedTwice, indexId: null });
  const r3b = issues2.find((i) => i.rule === "R3" && i.note === "loose");
  assert.strictEqual(r3b.fix, null, "ambiguous: left for review, never a coin flip");
  assert.match(r3b.detail, /claimed by 2 hubs/);
});

test("audit: R4 — a pure sibling-listing line is removable", () => {
  const notes = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n- [[hub]] — the hub\n"),
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[a]] — a\n- [[b]] — b\n- [[c]] — c\n"),
    // A pure bullet line naming >= 2 OTHER confirmed siblings of the same hub (lib/hub-spoke.js's
    // own rule) — nothing else on the line, so it is mechanically removable.
    rec("a", "---\ntitle: a\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\n- See also: [[b]], [[c]]\n\nBody of a.\n"),
    rec("b", "---\ntitle: b\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody of b.\n"),
    rec("c", "---\ntitle: c\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody of c.\n"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  const r4 = issues.filter((i) => i.rule === "R4");
  assert.strictEqual(r4.length, 1, JSON.stringify(issues));
  assert.strictEqual(r4[0].note, "a");
  assert.strictEqual(r4[0].fix.type, "remove-line");
  const built = star.buildFix(r4[0].fix, new Map(notes.map((n) => [n.id, n])));
  assert.doesNotMatch(built.after, /See also/);
  assert.match(built.after, /Body of a\./);
});

test("audit: R5 — an orphan note (not indexed, not a part, not named in any ## Parts) is flagged with no fix", () => {
  const notes = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n- [[hub]] — the hub\n"),
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[spoke]] — the spoke\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n"),
    rec("floating", "---\ntitle: floating\n---\n\nNobody links here, and it links nowhere.\n"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  const r5 = issues.find((i) => i.rule === "R5");
  assert.ok(r5);
  assert.strictEqual(r5.note, "floating");
  assert.strictEqual(r5.fix, null);
  // the index, the hub and the spoke are all reachable: never flagged.
  assert.ok(!issues.some((i) => i.rule === "R5" && ["MEMORY", "hub", "spoke"].includes(i.note)));
});

test("audit: archived notes are never flagged by R5", () => {
  const notes = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\nEmpty index.\n"),
    rec("old", "---\ntitle: old\n---\n\nArchived content.\n", "archive"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY", archiveFolder: "archive" });
  assert.ok(!issues.some((i) => i.note === "old"));
});

test("summarize(): counts fixable vs needing review, by rule", () => {
  const notes = [
    rec("hub", "---\ntitle: hub\n---\n\nNo Parts section.\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n"),
    rec("floating", "---\ntitle: floating\n---\n\nNothing links here.\n"),
  ];
  const issues = star.audit({ notes, indexId: null });
  const s = star.summarize(issues);
  assert.strictEqual(s.total, issues.length);
  assert.strictEqual(s.fixable + s.needsReview, s.total);
  assert.ok(s.byRule.R3 >= 1);
  assert.ok(s.byRule.R5 >= 1);
});

// ------------------------------------------------------------------ the worker, on a real temp KB

function makeSrv(notes) {
  const root = tmp("memglow-star-kb-");
  for (const [rel, text] of Object.entries(notes)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const srv = createMemoryServer({ root, readOnly: false, watch: false, pollMs: 0, fsync: false, structure: { enabled: false } });
  return { root, srv, cleanup: () => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("createStructureWorker: disabled by default is inert; enabled applies deterministic fixes, idempotent on a second scan, never touches archive/", async () => {
  const { root, srv, cleanup } = makeSrv({
    "memory/hub.md": "---\ntitle: hub\n---\n\n## Parts\n- [[loose]] — a loose note\n",
    "memory/loose.md": "---\ntitle: loose\n---\n\nBody.\n",
    "memory/spoke.md": "---\ntitle: spoke\npart_of: hub\n---\n\nNo uplink yet.\n",
    "memory/archive/old.md": "---\ntitle: old\n---\n\nUntouched.\n",
  });
  try {
    const off = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: false } });
    assert.strictEqual(off.inert, true);

    const logs = [];
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, archiveFolder: "memory/archive" }, log: (s) => logs.push(s) });
    const applied1 = await w.scanOnce();
    assert.ok(applied1.length >= 2, JSON.stringify(applied1));
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/archive/old.md"), "utf8"), "---\ntitle: old\n---\n\nUntouched.\n");
    assert.match(fs.readFileSync(path.join(root, "memory/loose.md"), "utf8"), /part_of: hub/);
    assert.match(fs.readFileSync(path.join(root, "memory/spoke.md"), "utf8"), /Up: \[\[hub\]\]/);

    const applied2 = await w.scanOnce();
    assert.strictEqual(applied2.length, 0, "idempotent: nothing left to fix");
  } finally { cleanup(); }
});

test("structureSettings: off by default, MEMGLOW_AUTO_STRUCTURE=1 turns it on", () => {
  assert.strictEqual(star.structureSettings({}, {}).enabled, false);
  assert.strictEqual(star.structureSettings({}, { MEMGLOW_AUTO_STRUCTURE: "1" }).enabled, true);
});
