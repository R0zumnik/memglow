"use strict";
// Lever 13 (deltaRead, 0.4.3 "cross-session delta reads") — lib/delta-read.js. Pure pieces
// (sha1Hex, sectionFingerprints, changedSectionTitles, crossSessionHeader, renderDiff, applyDiff,
// worthDelivering) plus the one fs-touching wrapper (createDeltaReadStore): atomic write, bounded
// size, mode 600 — same house style as lib/negative-cache.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../lib/delta-read");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "memglow-deltaread-")); }

test("sectionFingerprints: one entry per section (sectionSpans), hash over that section's own slice of text", () => {
  const text = "---\ntitle: x\n---\n# Intro\nhello\n\n## A\nalpha\n\n## B\nbeta\n";
  const fp = D.sectionFingerprints(text);
  assert.strictEqual(fp.length, 3);
  assert.deepStrictEqual(fp.map((s) => s.title), ["", "A", "B"]);
  assert.strictEqual(fp.every((s) => typeof s.hash === "string" && s.hash.length === 40), true);
  // Pure/deterministic: the same text always yields the same fingerprints.
  assert.deepStrictEqual(D.sectionFingerprints(text), fp);
});

test("changedSectionTitles: new title or differing hash counts as changed; '(intro)' for the untitled lead section; capped", () => {
  const prev = [{ title: "", hash: "h0" }, { title: "A", hash: "hA" }, { title: "B", hash: "hB" }];
  const cur = [{ title: "", hash: "h0-new" }, { title: "A", hash: "hA" }, { title: "C", hash: "hC" }];
  assert.deepStrictEqual(D.changedSectionTitles(prev, cur), ["(intro)", "C"], "A unchanged, intro changed, C is new");
  assert.deepStrictEqual(D.changedSectionTitles([], cur), ["(intro)", "A", "C"], "nothing previous: everything counts as changed");
  assert.deepStrictEqual(D.changedSectionTitles(prev, cur, 1), ["(intro)"], "capped");
  assert.deepStrictEqual(D.changedSectionTitles(null, []), []);
});

test("crossSessionHeader: null with no previous entry, or when the hash is unchanged; else names the date and changed sections", () => {
  const before = "---\ntitle: x\n---\n# Intro\nhello\n\n## A\nalpha\n";
  const after = "---\ntitle: x\n---\n# Intro\nhello\n\n## A\nalpha changed\n";
  assert.strictEqual(D.crossSessionHeader(null, after), null, "never read before by this client: nothing to say");
  assert.strictEqual(D.crossSessionHeader({ hash: "not-a-real-hash" }, after), null, "malformed entry (no time): treated as absent");
  const unchangedEntry = { hash: D.sha1Hex(after), time: Date.now(), sections: D.sectionFingerprints(after) };
  assert.strictEqual(D.crossSessionHeader(unchangedEntry, after), null, "same hash: unchanged since");
  const t = Date.UTC(2026, 0, 15, 12, 0, 0);
  const changedEntry = { hash: D.sha1Hex(before), time: t, sections: D.sectionFingerprints(before) };
  const hdr = D.crossSessionHeader(changedEntry, after);
  assert.match(hdr, /^memglow: changed since your last read on 2026-01-15 — sections changed: A$/);
});

test("renderDiff + applyDiff: round-trip — applying the rendered diff to `before` reconstructs `after` exactly", () => {
  let before = "---\ntitle: Big\n---\n# Intro\n";
  for (let i = 0; i < 50; i++) before += `## Section ${i}\nline one ${i}\nline two ${i}\n\n`;
  const after = before.replace("line two 20", "line two 20 CHANGED").replace("line one 40", "line one 40 ALSO CHANGED");
  const d = D.renderDiff(before, after, { context: 2 });
  assert.ok(d.text.startsWith(D.DELTA_READ_MARKER + "\n"));
  assert.strictEqual(d.truncated, false);
  assert.ok(d.added > 0 && d.removed > 0);
  assert.strictEqual(D.applyDiff(before, d.text), after);
  // Small, scattered edits in a big note: the diff is much smaller than the note itself.
  assert.ok(d.text.length < after.length * 0.3);
});

test("renderDiff + applyDiff: a brand new note (before = '') and a deletion round-trip too", () => {
  const d1 = D.renderDiff("", "fresh content\nsecond line\n");
  assert.strictEqual(D.applyDiff("", d1.text), "fresh content\nsecond line\n");
  const before2 = "a\nb\nc\nd\ne\n";
  const after2 = "a\nc\nd\ne\n"; // "b" removed
  const d2 = D.renderDiff(before2, after2);
  assert.strictEqual(D.applyDiff(before2, d2.text), after2);
});

test("applyDiff: not a delta-read diff at all (no marker), or a hunk that cannot be located -> null, never throws", () => {
  assert.strictEqual(D.applyDiff("a\nb\n", "plain text, not a diff"), null);
  assert.strictEqual(D.applyDiff("a\nb\n", ""), null);
  assert.strictEqual(D.applyDiff("a\nb\n", null), null);
  const fake = D.DELTA_READ_MARKER + "\n" + "- this line is not in `before`\n+ neither is this one\n";
  assert.strictEqual(D.applyDiff("a\nb\nc\n", fake), null, "the removed/context lines must actually be found in `before`");
});

test("worthDelivering: small, reconstructable diffs are worth it; large, truncated, or empty ones are not", () => {
  const big = "x\n".repeat(500);
  const smallEdit = big.replace("x\nx\nx\n", "x\nCHANGED\nx\n");
  const d = D.renderDiff(big, smallEdit);
  assert.strictEqual(D.worthDelivering(d, smallEdit), true);
  const rewritten = "y\n".repeat(500); // nothing shared: the whole thing is added+removed
  const dBig = D.renderDiff(big, rewritten);
  assert.strictEqual(D.worthDelivering(dBig, rewritten), false, "> 60% of the note: not worth it");
  assert.strictEqual(D.worthDelivering(null, "anything"), false);
  assert.strictEqual(D.worthDelivering({ text: "", truncated: false }, "anything"), false, "empty diff: nothing to deliver");
  assert.strictEqual(D.worthDelivering({ text: "short", truncated: true }, "x"), false, "truncated: never reconstructable, never worth it");
});

test("renderDiff: MAX_DIFF_LINES is a hard safety bound — a diff bigger than it is marked truncated", () => {
  const before = Array.from({ length: 300 }, (_, i) => "line " + i).join("\n") + "\n";
  const after = Array.from({ length: 300 }, (_, i) => "line " + i + " CHANGED").join("\n") + "\n"; // every line differs
  const d = D.renderDiff(before, after, { context: 1, maxLines: 50 });
  assert.strictEqual(d.truncated, true);
  assert.strictEqual(D.worthDelivering(d, after), false, "truncated diffs are never delivered");
});

// ---------------------------------------------------------------------------------------------
// createDeltaReadStore — the only fs-touching piece.

test("createDeltaReadStore: disabled without a data folder, or with the switch off — available() false, never throws", () => {
  const off1 = D.createDeltaReadStore({ dataDir: null, deltaRead: true });
  assert.strictEqual(off1.available(), false);
  off1.set("claude-code", "note-a", { hash: "x", time: 1 });
  assert.strictEqual(off1.get("claude-code", "note-a"), null);

  const dir = tmpDir();
  try {
    const off2 = D.createDeltaReadStore({ dataDir: dir, deltaRead: false });
    assert.strictEqual(off2.available(), false);
    off2.set("claude-code", "note-a", { hash: "x", time: 1 });
    off2.flush();
    assert.ok(!fs.existsSync(path.join(dir, "delta-read.json")), "switch off: nothing written at all");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createDeltaReadStore: records per client+note, persists atomically, mode 600, bounded, reloads", () => {
  const dir = tmpDir();
  try {
    const store = D.createDeltaReadStore({ dataDir: dir, deltaRead: true, deltaReadMax: 3 });
    assert.strictEqual(store.get("claude-code", "note-a"), null, "nothing recorded yet");
    store.set("claude-code", "note-a", { hash: "h1", time: 10, sections: [{ title: "", hash: "s1" }] });
    assert.deepStrictEqual(store.get("claude-code", "note-a"), { hash: "h1", time: 10, sections: [{ title: "", hash: "s1" }] });
    assert.strictEqual(store.get("cursor", "note-a"), null, "a different client never sees another client's entry");

    for (let i = 0; i < 5; i++) store.set("claude-code", "note-" + i, { hash: "h" + i, time: i });
    store.flush();
    const file = path.join(dir, "delta-read.json");
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.version, 1);
    assert.strictEqual(Object.keys(raw.entries).length, 3, "bounded to deltaReadMax, oldest dropped first");
    assert.ok(!fs.existsSync(file + "." + process.pid + ".tmp"), "temp file renamed away, not left behind");

    const reread = D.createDeltaReadStore({ dataDir: dir, deltaRead: true });
    assert.strictEqual(reread.size(), 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createDeltaReadStore: an invalid entry is never stored; a malformed or missing file on disk is treated as empty", () => {
  const dir = tmpDir();
  try {
    const store = D.createDeltaReadStore({ dataDir: dir, deltaRead: true });
    store.set("claude-code", "note-a", { hash: "", time: 1 }); // empty hash: invalid
    store.set("claude-code", "note-b", { time: 1 }); // no hash at all
    store.set("claude-code", "note-c", "not an object");
    assert.strictEqual(store.size(), 0);

    fs.writeFileSync(path.join(dir, "delta-read.json"), "{not json");
    const reread = D.createDeltaReadStore({ dataDir: dir, deltaRead: true });
    assert.strictEqual(reread.size(), 0);
    assert.strictEqual(reread.get("claude-code", "note-a"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
