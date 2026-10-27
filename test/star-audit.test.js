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

test("audit: R1 — the index links to a DECLARED part (frontmatter part_of); report-only (fix: null), never auto-applied; buildFix still knows \"replace-index-line\" for an explicit caller", () => {
  const notes = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n# Index\n\n- [[hub]] — the hub\n- [[spoke]] — a part, should not be here\n"),
    rec("hub", "---\ntitle: hub\n---\n\n## Parts\n- [[spoke]] — the spoke\n"),
    rec("spoke", "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  const r1 = issues.filter((i) => i.rule === "R1");
  assert.strictEqual(r1.length, 1);
  assert.strictEqual(r1[0].fix, null, "0.5.4: the worker never removes or rewrites an index line automatically");
  assert.strictEqual(r1[0].part, "spoke");
  assert.strictEqual(r1[0].hub, "hub");
  assert.strictEqual(r1[0].hubAlreadyListed, true);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const built = star.buildFix({ type: "replace-index-line", index: "MEMORY", part: r1[0].part, hub: r1[0].hub, lineIndex: r1[0].lineIndex, hubAlreadyListed: r1[0].hubAlreadyListed }, byId);
  assert.doesNotMatch(built.after, /\[\[spoke\]\]/);
  assert.match(built.after, /\[\[hub\]\] — the hub/);

  // Hub NOT already listed: the manually-built fix would rewrite the line to point at it instead
  // of dropping it (still never done automatically).
  const notes2 = [
    rec("MEMORY", "---\ntitle: MEMORY\n---\n\n- [[spoke]] — a part, should not be here\n"),
    notes[1], notes[2],
  ];
  const issues2 = star.audit({ notes: notes2, indexId: "MEMORY" });
  const r1b = issues2.find((i) => i.rule === "R1");
  assert.strictEqual(r1b.fix, null);
  assert.strictEqual(r1b.hubAlreadyListed, false);
  const built2 = star.buildFix({ type: "replace-index-line", index: "MEMORY", part: r1b.part, hub: r1b.hub, lineIndex: r1b.lineIndex, hubAlreadyListed: r1b.hubAlreadyListed }, new Map(notes2.map((n) => [n.id, n])));
  assert.match(built2.after, /\[\[hub\]\] — a part, should not be here/);
});

test("audit/createStructureWorker (0.5.4 bug fix): a note with an Up: line naming OTHER notes, but no frontmatter part_of, is never treated as a part — R1 does not even report it, and the index is left byte-identical end to end", async () => {
  const indexText = "---\ntitle: MEMORY\n---\n\n- [[keyestudio]] — smart farm project\n";
  // The real-world shape: an "Up:" line naming TWO other notes, no part_of anywhere.
  const keyestudioText = "---\ntitle: keyestudio\n---\n\nUp: [[user-arthur]] and [[user-florent-profile]] both reference this.\n\nBody of the project note.\n";
  const notes = [
    rec("MEMORY", indexText),
    rec("keyestudio", keyestudioText),
    rec("user-arthur", "---\ntitle: user-arthur\n---\n\nBody.\n"),
    rec("user-florent-profile", "---\ntitle: user-florent-profile\n---\n\nBody.\n"),
  ];
  const issues = star.audit({ notes, indexId: "MEMORY" });
  assert.ok(!issues.some((i) => i.rule === "R1"), "keyestudio declares no part_of: not a part, so not an R1 violation at all, " + JSON.stringify(issues));

  const { root, srv, cleanup } = makeSrv({
    "memory/MEMORY.md": indexText,
    "memory/keyestudio.md": keyestudioText,
    "memory/user-arthur.md": "---\ntitle: user-arthur\n---\n\nBody.\n",
    "memory/user-florent-profile.md": "---\ntitle: user-florent-profile\n---\n\nBody.\n",
  });
  try {
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true } });
    await w.scanOnce();
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/MEMORY.md"), "utf8"), indexText, "the index is byte-identical: never touched");
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/keyestudio.md"), "utf8"), keyestudioText, "keyestudio itself is also untouched (no part_of was added to it either)");
  } finally { cleanup(); }
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
  // 0.5.4 bug fix: exact byte match — a prior bug (joinHeadBody) inserted a SECOND blank line
  // between the frontmatter fence and "Hub body…" (the body's own leading blank line, kept,
  // PLUS one more from the join itself).
  assert.strictEqual(built.after, "---\ntitle: hub\n---\n\nHub body, no Parts section yet.\n\n## Parts\n- [[spoke]] — spoke\n");
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
  assert.strictEqual(r4[0].fix, null); // 0.5.4: reported only — the worker never deletes a note's line
  const built = star.buildFix({ type: "remove-line", note: "a", lineIndex: r4[0].lineIndex }, new Map(notes.map((n) => [n.id, n])));
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

test("createStructureWorker (0.5.4 bug fix): a scan of an already fully-compliant KB finds nothing and leaves every file byte-identical", async () => {
  const notes = {
    "memory/MEMORY.md": "---\ntitle: MEMORY\n---\n\n# Index\n\n## Work\n- [[hub]] — the hub\n",
    "memory/hub.md": "---\ntitle: hub\n---\n\n# Hub\n\nSome intro text.\n\n## Parts\n- [[spoke]] — the spoke\n",
    "memory/spoke.md": "---\ntitle: spoke\npart_of: hub\n---\n\nUp: [[hub]] — part of hub.\n\nBody.\n",
  };
  const { root, srv, cleanup } = makeSrv(notes);
  try {
    const before = {};
    for (const rel of Object.keys(notes)) before[rel] = fs.readFileSync(path.join(root, rel), "utf8");
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true } });
    const applied = await w.scanOnce();
    assert.strictEqual(applied.length, 0, "already fully compliant: nothing to fix");
    for (const rel of Object.keys(notes)) {
      assert.strictEqual(fs.readFileSync(path.join(root, rel), "utf8"), before[rel], `${rel} must be byte-identical`);
    }
  } finally { cleanup(); }
});

test("createStructureWorker (0.5.4): excludeFolders — a versioned-document folder is never scanned, fixed, or reported as an orphan", async () => {
  const versioned = "---\ntitle: design-spec\n---\n\nA versioned work document, left whole.\n";
  const { root, srv, cleanup } = makeSrv({
    "memory/project/work/initiatives/design-spec.md": versioned,
    "memory/hub.md": "---\ntitle: hub\n---\n\n## Parts\n- [[loose]] — a loose note\n",
    "memory/loose.md": "---\ntitle: loose\n---\n\nBody.\n",
  });
  try {
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, excludeFolders: ["memory/project/work/initiatives"] } });
    const applied = await w.scanOnce();
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/project/work/initiatives/design-spec.md"), "utf8"), versioned, "never touched");
    assert.ok(!applied.some((a) => a.note === "design-spec"));
    // The non-excluded loose note is still fixed normally.
    assert.match(fs.readFileSync(path.join(root, "memory/loose.md"), "utf8"), /part_of: hub/);
  } finally { cleanup(); }
});

test("createStructureWorker (0.5.4 bug fix): SCOPE — a KB root with memory/ (the memory, with its index note) plus one-way-synced workspace/ and infra-acces/ folders — only memory/ is scanned, fixed, or flagged, by default", async () => {
  const { root, srv, cleanup } = makeSrv({
    "memory/MEMORY.md": "---\ntitle: MEMORY\ntype: index\n---\n\n- [[hub]] — the hub\n",
    "memory/hub.md": "---\ntitle: hub\n---\n\n## Parts\n- [[loose]] — a loose note\n",
    "memory/loose.md": "---\ntitle: loose\n---\n\nBody.\n",
    "workspace/doc.md": "---\ntitle: doc\n---\n\nSome synced project doc, unrelated to the memory, never flagged as an orphan.\n",
    "infra-acces/x.md": "---\ntitle: x\n---\n\nAnother synced doc.\n",
  });
  try {
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true }, indexNote: ["MEMORY", "index"] });
    const applied = await w.scanOnce();
    assert.ok(applied.some((a) => a.note === "loose"), "memory/ itself is still fixed normally");
    const indexId = star.indexIdOf(srv.store, ["MEMORY", "index"]);
    const notesAll = star.recordsFrom(srv.store.notes());
    const issuesUnfiltered = star.audit({ notes: notesAll, indexId, archiveFolder: "archive" });
    assert.ok(issuesUnfiltered.some((i) => i.rule === "R5" && (i.note === "doc" || i.note === "x")), "sanity: without scoping, the synced docs WOULD be flagged as orphans");
    assert.ok(!applied.some((a) => a.note === "doc" || a.note === "x"), "but the worker itself never touches or flags them");
    assert.strictEqual(fs.readFileSync(path.join(root, "workspace/doc.md"), "utf8"), "---\ntitle: doc\n---\n\nSome synced project doc, unrelated to the memory, never flagged as an orphan.\n");
    assert.strictEqual(fs.readFileSync(path.join(root, "infra-acces/x.md"), "utf8"), "---\ntitle: x\n---\n\nAnother synced doc.\n");
    const s = w.status();
    assert.strictEqual(s.issues.byRule.R5 || 0, 0, "no orphan reported at all once scoped to memory/");
  } finally { cleanup(); }
});

test("structureSettings: off by default, MEMGLOW_AUTO_STRUCTURE=1 turns it on; excludeFolders/includeFolders shared resolution (archiveFolder alias, default)", () => {
  assert.strictEqual(star.structureSettings({}, {}).enabled, false);
  assert.strictEqual(star.structureSettings({}, { MEMGLOW_AUTO_STRUCTURE: "1" }).enabled, true);
  assert.deepStrictEqual(star.structureSettings({}, {}).excludeFolders, ["archive"]);
  assert.deepStrictEqual(star.structureSettings({ archiveFolder: "memory/archive" }, {}).excludeFolders, ["memory/archive"]);
  assert.deepStrictEqual(star.structureSettings({ archiveFolder: "memory/archive", excludeFolders: ["a", "b"] }, {}).excludeFolders, ["a", "b"]);
  assert.strictEqual(star.structureSettings({}, {}).includeFolders, null, "no explicit includeFolders: resolved at scan time instead");
  assert.deepStrictEqual(star.structureSettings({ includeFolders: ["memory"] }, {}).includeFolders, ["memory"]);
});

// ------------------------------------------------------------------ AI judgement (R5 / ambiguous R3)

function makeJudgeKb() {
  return makeSrv({
    "memory/MEMORY.md": "---\ntitle: MEMORY\n---\n\n## Projects\n- [[hub-proj]] — the project hub\n\n## People\n- [[alice]] — a person\n",
    "memory/hub-proj.md": "---\ntitle: hub-proj\n---\n\n## Parts\n- [[spoke-a]] — spoke a\n",
    "memory/spoke-a.md": "---\ntitle: spoke-a\npart_of: hub-proj\n---\n\nUp: [[hub-proj]] — part of hub-proj.\n\nBody.\n",
    "memory/alice.md": "---\ntitle: alice\n---\n\nA person, linked from the index only.\n",
    "memory/orphan1.md": "---\ntitle: orphan1\ndescription: Some orphaned note about the project\n---\n\nNobody links here, and it links nowhere.\n",
  });
}

function judgeSetup(aiRun) {
  const { root, srv, cleanup } = makeJudgeKb();
  const cfg = star.structureSettings({ ai: { enabled: true, maxDecisionsPerScan: 10 } }, {});
  const indexId = star.indexIdOf(srv.store, ["MEMORY", "index"]);
  const notes = star.recordsFrom(srv.store.notes());
  const issues = star.audit({ notes, indexId, archiveFolder: "archive" });
  const logs = [];
  const run = async () => star.judgeIssues({ store: srv.store, writer: srv.writer, cfg, env: {}, dataDir: null, log: (s) => logs.push(s), indexId, notes, issues, aiRun });
  return { root, srv, cleanup, cfg, indexId, notes, issues, logs, run };
}

test("judgeIssues: R5 candidates are offered the confirmed hub(s) and the index sections", () => {
  const { srv, cleanup, indexId, notes } = judgeSetup(async () => ({ ok: true, text: '{"action":"leave"}' }));
  try {
    const byId = new Map(star.recordsFrom(srv.store.notes()).map((r) => [r.id, r]));
    const { hubs, sections } = star.candidatesFor(notes, indexId, byId);
    assert.deepStrictEqual(hubs.map((h) => h.id).sort(), ["alice", "hub-proj"], "a confirmed hub and a stand-alone index note are both valid attach targets");
    assert.deepStrictEqual(sections.sort(), ["People", "Projects"]);
    const prompt = star.buildJudgePrompt(byId.get("orphan1"), hubs, sections);
    assert.match(prompt, /Note: "orphan1"/);
    assert.match(prompt, /Some orphaned note about the project/);
    assert.match(prompt, /- hub-proj —/);
    assert.match(prompt, /- Projects/);
  } finally { cleanup(); }
});

test("judgeIssues: \"attach\" — adds part_of + Up (ADD-only) and appends the hub's own bullet with the AI's hook", async () => {
  const { srv, cleanup, logs, run } = judgeSetup(async (prompt) => {
    assert.match(prompt, /orphan1/);
    return { ok: true, text: JSON.stringify({ action: "attach", hub: "hub-proj", hook: "the orphaned project note" }) };
  });
  try {
    const applied = await run();
    assert.strictEqual(applied.length, 2);
    const orphan = fs.readFileSync(path.join(srv.store.root, "memory/orphan1.md"), "utf8");
    assert.match(orphan, /^---\ntitle: orphan1\ndescription: Some orphaned note about the project\npart_of: hub-proj\n---\n\nUp: \[\[hub-proj\]\] — part of hub-proj\.\n\nNobody links here/);
    const hub = fs.readFileSync(path.join(srv.store.root, "memory/hub-proj.md"), "utf8");
    assert.match(hub, /## Parts\n- \[\[spoke-a\]\] — spoke a\n- \[\[orphan1\]\] — the orphaned project note\n/);
    assert.ok(logs.some((l) => /AI attached "orphan1" to "hub-proj"/.test(l)));
  } finally { cleanup(); }
});

test("judgeIssues: \"index\" — inserts a bullet at the end of the named section, touching nothing else", async () => {
  const { srv, cleanup, run } = judgeSetup(async () => ({ ok: true, text: JSON.stringify({ action: "index", section: "Projects", hook: "an orphaned project note" }) }));
  try {
    const applied = await run();
    assert.strictEqual(applied.length, 1);
    const index = fs.readFileSync(path.join(srv.store.root, "memory/MEMORY.md"), "utf8");
    assert.match(index, /## Projects\n- \[\[hub-proj\]\] — the project hub\n- \[\[orphan1\]\] — an orphaned project note\n\n## People/);
    // nothing else written.
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/orphan1.md"), "utf8"), "---\ntitle: orphan1\ndescription: Some orphaned note about the project\n---\n\nNobody links here, and it links nowhere.\n");
  } finally { cleanup(); }
});

test("judgeIssues: \"leave\" — never guesses, nothing written", async () => {
  const { srv, cleanup, run } = judgeSetup(async () => ({ ok: true, text: '{"action":"leave"}' }));
  try {
    const applied = await run();
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(srv.store.root, "memory/MEMORY.md"), "utf8"), fs.readFileSync(path.join(srv.store.root, "memory/MEMORY.md"), "utf8"));
  } finally { cleanup(); }
});

test("judgeIssues: an invalid hub id is refused and retried once — a second, valid answer is then applied", async () => {
  let calls = 0;
  const { cleanup, logs, run } = judgeSetup(async () => {
    calls++;
    if (calls === 1) return { ok: true, text: JSON.stringify({ action: "attach", hub: "not-a-real-hub", hook: "x" }) };
    return { ok: true, text: JSON.stringify({ action: "attach", hub: "hub-proj", hook: "retried ok" }) };
  });
  try {
    const applied = await run();
    assert.strictEqual(calls, 2, "exactly one retry");
    assert.strictEqual(applied.length, 2);
    assert.ok(!logs.some((l) => /judgement for "orphan1" failed/.test(l)));
  } finally { cleanup(); }
});

test("judgeIssues: an invalid section is refused and retried once; two failures in a row give up and log", async () => {
  const { cleanup, logs, run } = judgeSetup(async () => ({ ok: true, text: JSON.stringify({ action: "index", section: "Not A Real Section", hook: "x" }) }));
  try {
    const applied = await run();
    assert.strictEqual(applied.length, 0);
    assert.ok(logs.some((l) => /AI judgement for "orphan1" failed/.test(l)));
  } finally { cleanup(); }
});

test("judgeIssues: garbage (unparseable) JSON is also retried once, then given up on", async () => {
  const { cleanup, logs, run } = judgeSetup(async () => ({ ok: true, text: "not json at all, sorry" }));
  try {
    const applied = await run();
    assert.strictEqual(applied.length, 0);
    assert.ok(logs.some((l) => /AI judgement for "orphan1" failed/.test(l)));
  } finally { cleanup(); }
});

test("judgeIssues: a note claimed by 2+ hubs' own \"## Parts\" (ambiguous R3) is also offered to the AI", async () => {
  const { root, srv, cleanup } = makeSrv({
    "memory/MEMORY.md": "---\ntitle: MEMORY\n---\n\n## Projects\n- [[hub-a]] — hub a\n- [[hub-b]] — hub b\n",
    "memory/hub-a.md": "---\ntitle: hub-a\n---\n\n## Parts\n- [[loose]] — loose note\n",
    "memory/hub-b.md": "---\ntitle: hub-b\n---\n\n## Parts\n- [[loose]] — loose note\n",
    "memory/loose.md": "---\ntitle: loose\ndescription: A note two hubs both list\n---\n\nBody.\n",
  });
  try {
    const cfg = star.structureSettings({ ai: { enabled: true } }, {});
    const indexId = star.indexIdOf(srv.store, ["MEMORY", "index"]);
    const notes = star.recordsFrom(srv.store.notes());
    const issues = star.audit({ notes, indexId, archiveFolder: "archive" });
    assert.ok(issues.some((i) => i.rule === "R3" && i.note === "loose" && i.fix === null));
    const applied = await star.judgeIssues({
      store: srv.store, writer: srv.writer, cfg, env: {}, dataDir: null, log: () => {}, indexId, notes, issues,
      aiRun: async () => ({ ok: true, text: JSON.stringify({ action: "attach", hub: "hub-a", hook: "the right one" }) }),
    });
    // hub-a's own "## Parts" already names "loose" (that is exactly what made this ambiguous) —
    // only loose.md itself needs a change (part_of + Up); hub-a.md is untouched.
    assert.strictEqual(applied.length, 1);
    assert.match(fs.readFileSync(path.join(root, "memory/loose.md"), "utf8"), /part_of: hub-a/);
  } finally { cleanup(); }
});

test("judgeIssues (0.5.4 bug fix): an auth error stops the REST of this call's candidates at once (never retried, never hammered per candidate), surfaced as .authError", async () => {
  const { root, srv, cleanup } = makeSrv({
    "memory/orphan1.md": "---\ntitle: orphan1\n---\n\nNobody links here.\n",
    "memory/orphan2.md": "---\ntitle: orphan2\n---\n\nNobody links here either.\n",
  });
  try {
    const cfg = star.structureSettings({ ai: { enabled: true } }, {});
    const indexId = star.indexIdOf(srv.store, ["MEMORY", "index"]);
    const notes = star.recordsFrom(srv.store.notes());
    const issues = star.audit({ notes, indexId, archiveFolder: "archive" });
    assert.strictEqual(issues.filter((i) => i.rule === "R5").length, 2);
    let calls = 0;
    const logs = [];
    const applied = await star.judgeIssues({
      store: srv.store, writer: srv.writer, cfg, env: {}, dataDir: null, log: (s) => logs.push(s), indexId, notes, issues,
      aiRun: async () => { calls++; return { ok: false, error: "The API key was refused by api.anthropic.com (HTTP 401): check the key you set for memglow." }; },
    });
    assert.strictEqual(calls, 1, "no retry for an auth error, and the second orphan is never even attempted");
    assert.ok(applied.authError, "surfaced on the returned array");
    assert.match(applied.authError, /401/);
    assert.ok(logs.some((l) => /auth error/.test(l)));
    assert.strictEqual(fs.readFileSync(path.join(root, "memory/orphan1.md"), "utf8"), "---\ntitle: orphan1\n---\n\nNobody links here.\n", "nothing written");
  } finally { cleanup(); }
});

test("createStructureWorker (0.5.4 bug fix): an auth error from the AI judgement pass becomes a persistent status().lastError, and the AI pass is skipped on every later scan", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/orphan1.md": "---\ntitle: orphan1\n---\n\nNobody links here.\n",
  });
  try {
    let calls = 0;
    const w = star.createStructureWorker({
      store: srv.store, writer: srv.writer, config: { enabled: true, ai: { enabled: true } },
      aiRun: async () => { calls++; return { ok: false, error: "Failed to authenticate. API Error: 401 Invalid bearer token" }; },
    });
    await w.scanOnce();
    assert.strictEqual(calls, 1);
    assert.ok(w.status().lastError);
    assert.match(w.status().lastError.message, /401|authenticate/);
    await w.scanOnce();
    assert.strictEqual(calls, 1, "a later scan's AI pass is skipped outright once a bad credential was seen");
  } finally { cleanup(); }
});

test("createStructureWorker: structure.ai gates the judgement pass — off by default, and inert without a provider even when enabled", async () => {
  const { srv, cleanup } = makeJudgeKb();
  try {
    let aiCalls = 0;
    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, ai: { enabled: false } }, aiRun: async () => { aiCalls++; return { ok: true, text: '{"action":"leave"}' }; } });
    await w.scanOnce();
    assert.strictEqual(aiCalls, 0, "structure.ai.enabled defaults to false: no AI call at all");

    const logs = [];
    const w2 = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true, ai: { enabled: true } }, log: (s) => logs.push(s) });
    await w2.scanOnce();
    assert.ok(logs.some((l) => /structure\.ai is enabled, but no AI provider is available/.test(l)));
  } finally { cleanup(); }
});

test("createStructureWorker: status() reports issue counts by rule, lastScan/nextScan, and recentEvents() lists applied fixes", async () => {
  const { srv, cleanup } = makeSrv({
    "memory/hub.md": "---\ntitle: hub\n---\n\n## Parts\n- [[loose]] — a loose note\n",
    "memory/loose.md": "---\ntitle: loose\n---\n\nBody.\n",
  });
  try {
    const off = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: false } });
    assert.strictEqual(off.status().enabled, false);

    const w = star.createStructureWorker({ store: srv.store, writer: srv.writer, config: { enabled: true } });
    await w.scanOnce();
    const s = w.status();
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(typeof s.lastScanAt, "number");
    assert.strictEqual(s.nextScanAt, s.lastScanAt + 24 * 3600000);
    assert.strictEqual(s.issues.fixable, 0, "every mechanically-fixable issue converged within one scan");
    const events = w.recentEvents();
    assert.ok(events.some((e) => e.kind === "fix" && e.note === "loose"));
  } finally { cleanup(); }
});
