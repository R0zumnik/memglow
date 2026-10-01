"use strict";
// Archive tier (lib/archive.js): dormancy detection on synthetic dates, "not enough data yet",
// archive plans (valid; refused for lost content, another theme, an overwrite), the archive summary,
// the HTTP flow (nothing written without the one-time confirmation, CSRF, Undo), the AI review, the
// read-only `archive_lookup` MCP tool and the proxy's archive-hint lever (off / on).
// The AI is ALWAYS the fake `claude` of test/fixtures: no real AI is ever called.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const A = require("../lib/archive");
const { createCounters } = require("../lib/counters");
const { dayOf, daysBefore, estimateTokens } = require("../lib/cost");
const { createServer } = require("../server");
const { createMemory } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const L = require("../lib/proxy-levers");
const { createContext, HANDLERS } = require("../mcp-server/memglow-mcp");

const DAY = 86400000;
const NOW = Date.now();
const ago = (n) => daysBefore(NOW, n);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const FILL = (word) => Array.from({ length: 8 }, (_, i) => `${word} line ${i}: some details that nobody has needed for a long while now.`).join("\n");
const THEMES = loadConfig({}, os.tmpdir()).themes;

const OLD = `---\ntitle: Old project\ntheme: projects\nsubtheme: alpha\n---\nIntro: what this project is.\n\n## Old plan\n${FILL("Plan")}\n\n### Old plan details\n${FILL("Detail")}\n\n## Current rules\n${FILL("Rule")}\n\n## Tiny\nToo small to archive.\n`;

// ------------------------------------------------------------------ counters: started + last

test("counters: `started` and `last` survive the 90-day purge; older files are migrated", () => {
  const dir = tmp("memglow-arch-cnt-");
  let t = NOW - 200 * DAY;
  const c = createCounters({ dir, now: () => t });
  c.add({ type: "read", ids: ["a"], t });
  c.add({ type: "search", ids: ["b"], t });
  t = NOW;
  c.add({ type: "write", ids: ["c"], t });
  c.flush();
  assert.strictEqual(c.started(), dayOf(NOW - 200 * DAY), "started is never purged");
  assert.ok(c.since() > c.started(), "since moved with the purge");
  assert.strictEqual(c.last().a.read, dayOf(NOW - 200 * DAY), "last read kept after its day was purged");
  assert.strictEqual(c.last().b.search, dayOf(NOW - 200 * DAY));
  const again = createCounters({ dir, now: () => NOW });
  assert.strictEqual(again.started(), c.started());
  assert.deepStrictEqual(again.last().a, { read: dayOf(NOW - 200 * DAY) });
  // A file from before (no `started`, no `last`): started = since, last rebuilt from the days.
  const old = tmp("memglow-arch-cnt-old-");
  fs.writeFileSync(path.join(old, "activity-counts.json"), JSON.stringify({ version: 1, since: ago(40), days: { [ago(20)]: { notes: { x: { read: 2, search: 0, write: 1 } } } } }));
  const m = createCounters({ dir: old, now: () => NOW });
  assert.strictEqual(m.started(), ago(40));
  assert.deepStrictEqual(m.last().x, { read: ago(20), write: ago(20) });
});

// ------------------------------------------------------------------ blocks

test("blocksOf: top-level sections with their sub-sections; no intro; headings in code ignored", () => {
  const body = "Intro\n\n## A\na\n### A.1\na1\n```\n## not a heading\n```\n## B\nb\n";
  const b = A.blocksOf(body);
  assert.deepStrictEqual(b.map((x) => x.heading), ["A", "B"]);
  assert.ok(b[0].text.includes("### A.1") && b[0].text.includes("## not a heading"));
  assert.strictEqual(body.slice(b[0].start, b[0].end), b[0].text);
  assert.notStrictEqual(A.keyOf("n", b[0].text), A.keyOf("n", b[0].text + "x"), "an edit changes the key");
  // The section before an archived one gets its "Archived:" line: not an edit for the section log.
  const after = A.blocksOf("## A\na\n\nArchived: B → [[k-archive#B]] (2026-10-01)\n\n## C\nc\n");
  assert.strictEqual(after[0].hash, A.blocksOf("## A\na\n\n## C\nc\n")[0].hash);
  assert.notStrictEqual(after[0].hash, A.blocksOf("## A\na!\n\n## C\nc\n")[0].hash);
});

// ------------------------------------------------------------------ detection

function notesFixture() {
  const bodies = {
    old: A.splitFrontmatter(OLD).body,
    fresh: "## Something\n" + FILL("Fresh"),
    found: "## Found\n" + FILL("Found"),
    edited: "## Edited\n" + FILL("Edited"),
    MEMORY: "## Index\n" + FILL("Index"),
    inarch: "## Gone\n" + FILL("Gone"),
    loose: "## Loose\n" + FILL("Loose"),
  };
  const n = (id, theme, rel, mtimeDays) => ({ id, label: id, theme, folder: path.posix.dirname(rel), rel, bytes: Buffer.byteLength(bodies[id]), mtime: NOW - mtimeDays * DAY });
  const notes = [
    n("old", "projects", "projects/old.md", 200), n("fresh", "projects", "projects/fresh.md", 200),
    n("found", "knowledge", "found.md", 200), n("edited", "knowledge", "edited.md", 3),
    n("MEMORY", "index", "MEMORY.md", 200), n("inarch", "projects", "archive/inarch.md", 200), n("loose", "other", "loose.md", 200),
  ];
  const last = { fresh: { read: ago(10) }, found: { search: ago(5), read: ago(150) }, old: { read: ago(150) } };
  return { notes, last, readBody: (id) => bodies[id] };
}

test("detection: not enough data yet → nothing suggested, says since when and from when", () => {
  const f = notesFixture();
  const r = A.detectDormant({ ...f, started: ago(30), now: NOW });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.reason, "not enough data yet since " + ago(30));
  assert.strictEqual(r.readyOn, dayOf(new Date(ago(30) + "T12:00:00").getTime() + 105 * DAY));
  assert.deepStrictEqual(r.sections, []);
  const r2 = A.detectDormant({ ...f, started: ago(104), now: NOW });
  assert.strictEqual(r2.available, false, "104 days < 105");
});

test("detection: dormant = note not read nor found, section not edited (note level); exclusions; cap", () => {
  const f = notesFixture();
  const r = A.detectDormant({ ...f, started: ago(200), now: NOW });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.basis, "note", "no section log: note-level edit check");
  const got = r.sections.map((s) => s.note + "§" + s.title).sort();
  assert.deepStrictEqual(got, ["old§Current rules", "old§Old plan"], JSON.stringify(got));
  // read 10 days ago (fresh), found by a search 5 days ago (found), edited 3 days ago (edited),
  // index, already in the archive folder, no theme, intro, too small: all excluded.
  const plan = r.sections.find((s) => s.title === "Old plan");
  assert.ok(plan.tokens > 150, "with its ### sub-section");
  assert.strictEqual(plan.lastRead, ago(150));
  assert.match(plan.key, /^[0-9a-f]{16}$/);
  assert.ok(r.savedTokens > 0 && r.summaryTokens > 0 && r.summaryTokens < r.savedTokens);
  const capped = A.detectDormant({ ...f, started: ago(200), now: NOW, settings: { maxSuggestions: 1 } });
  assert.strictEqual(capped.sections.length, 1);
  assert.strictEqual(capped.total, 2);
  assert.strictEqual(capped.sections[0].title, "Old plan", "biggest first");
  const hidden = A.detectDormant({ ...f, started: ago(200), now: NOW, withTitles: false });
  assert.ok(hidden.sections.every((s) => s.title === ""), "no titles without MEMGLOW_SHOW_BODIES");
  const shorter = A.detectDormant({ ...f, started: ago(200), now: NOW, settings: { afterDays: 100 } });
  assert.ok(shorter.sections.length === 2);
  const longer = A.detectDormant({ ...f, started: ago(200), now: NOW, settings: { afterDays: 160 } });
  assert.deepStrictEqual(longer.sections, [], "with 160 days, a read 150 days ago keeps the note live");
});

test("detection: section level when the section log covers the window", () => {
  const f = notesFixture();
  let clock = NOW - 180 * DAY;
  const log = A.createSectionLog({ dir: null, now: () => clock });
  const v1 = "## Kept as is\n" + FILL("Same") + "\n\n## Rewritten\n" + FILL("Before");
  log.observe("edited", v1);
  clock = NOW - 3 * DAY;
  const v2 = "## Kept as is\n" + FILL("Same") + "\n\n## Rewritten\n" + FILL("After");
  log.observe("edited", v2);
  clock = NOW;
  const r = A.detectDormant({ ...f, readBody: (id) => (id === "edited" ? v2 : f.readBody(id)), started: ago(200), now: NOW, sectionLog: log });
  assert.strictEqual(r.basis, "section");
  const ed = r.sections.filter((s) => s.note === "edited").map((s) => s.title);
  assert.deepStrictEqual(ed, ["Kept as is"], "the note was edited 3 days ago, but only one section changed");
  assert.strictEqual(r.sections.find((s) => s.note === "edited").basis, "section");
});

// ------------------------------------------------------------------ plans

function planFixture() {
  const dir = tmp("memglow-arch-plan-");
  fs.mkdirSync(path.join(dir, "projects"));
  fs.writeFileSync(path.join(dir, "projects", "old.md"), OLD);
  fs.writeFileSync(path.join(dir, "other.md"), "---\ntheme: knowledge\n---\nOther.\n");
  const infos = { old: { id: "old", rel: "projects/old.md", theme: "projects" }, other: { id: "other", rel: "other.md", theme: "knowledge" } };
  const body = A.splitFrontmatter(OLD).body;
  const blocks = A.blocksOf(body);
  const key = (h) => A.keyOf("old", blocks.find((b) => b.heading === h).text);
  const make = (picks, extra = {}) => A.planArchive({
    memoryDir: dir, picks, settings: {}, themes: THEMES, today: "2026-10-01",
    noteInfo: (id) => infos[id] || null, existingIds: Object.keys(infos), ...extra,
  });
  const check = (p) => A.checkArchivePlan({ files: p.files, moved: p.moved, memoryDir: dir, noteTheme: (id) => (infos[id] || {}).theme, knownIds: Object.keys(infos) });
  return { dir, infos, key, make, check };
}

test("plan: a valid archive — verbatim move, link line, same-theme archive note, summary", () => {
  const f = planFixture();
  const p = f.make([{ note: "old", key: f.key("Old plan") }]);
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.deepStrictEqual(f.check(p), []);
  const origin = p.files.find((x) => x.role === "origin");
  const arch = p.files.find((x) => x.role === "archive");
  const sum = p.files.find((x) => x.role === "summary");
  assert.strictEqual(arch.rel, "archive/projects-archive.md");
  assert.strictEqual(arch.kind, "create");
  assert.ok(origin.after.startsWith("---\ntitle: Old project\ntheme: projects\nsubtheme: alpha\n---\n"), "frontmatter untouched");
  assert.ok(origin.after.includes("Archived: Old plan → [[projects-archive#Old plan]] (2026-10-01)\n\n## Current rules"));
  assert.ok(!origin.after.includes("Plan line 3") && !origin.after.includes("### Old plan details"));
  for (const l of A.blocksOf(A.splitFrontmatter(OLD).body)[0].text.split("\n").filter(Boolean)) assert.ok(arch.after.includes(l + "\n"), "moved line kept: " + l);
  assert.match(arch.after, /\ntheme: projects\n/);
  assert.match(arch.after, /\nmemglow_archive: true\n/);
  assert.ok(arch.after.includes('<!-- memglow:archived from="old" date="2026-10-01" -->\n## Old plan\n'));
  // Summary: one parseable line, small.
  const entries = A.parseSummary(sum.after);
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual({ ...entries[0], tokens: 0 }, { date: "2026-10-01", title: "Old plan", from: "old", archive: "projects-archive", anchor: "Old plan", tokens: 0 });
  assert.ok(estimateTokens(sum.after) < 150, "summary stays small: " + estimateTokens(sum.after));
  assert.ok(p.gain.saved > 100 && p.gain.summaryTokens === estimateTokens(sum.after));
  // Rebuilding the original from the note + the archive gives it back byte for byte.
  const m = p.moved[0];
  assert.strictEqual(origin.after.replace(m.stub, m.text), OLD);
});

test("plan: refused when content would be lost, the theme changes, or a file would be overwritten", () => {
  const f = planFixture();
  const p = f.make([{ note: "old", key: f.key("Old plan") }]);
  const arch = p.files.find((x) => x.role === "archive");
  const lose = { ...p, files: p.files.map((x) => (x === arch ? { ...x, after: x.after.replace("Plan line 3: some details that nobody has needed for a long while now.\n", "") } : x)) };
  assert.ok(f.check(lose).some((e) => /word for word/.test(e)), "lost line");
  const lose2 = { ...p, files: p.files.map((x) => (x.role === "origin" ? { ...x, after: x.after.replace("Rule line 2", "Rule line two") } : x)) };
  assert.ok(f.check(lose2).some((e) => /rebuilt exactly/.test(e)), "origin changed elsewhere");
  const theme = { ...p, files: p.files.map((x) => (x === arch ? { ...x, after: x.after.replace("theme: projects", "theme: knowledge") } : x)) };
  assert.ok(f.check(theme).some((e) => /theme "knowledge" is not the theme "projects"/.test(e)), "other theme");
  const fm = { ...p, files: p.files.map((x) => (x.role === "origin" ? { ...x, after: x.after.replace("theme: projects", "theme: knowledge") } : x)) };
  assert.ok(f.check(fm).some((e) => /frontmatter/.test(e)), "origin theme never changes");
  const badLink = { ...p, moved: p.moved.map((m) => ({ ...m, line: m.line.replace("#Old plan", "#Nope"), stub: m.stub })) };
  assert.ok(f.check(badLink).some((e) => /names no heading/.test(e)), "link to a missing heading");
  // The archive file appears after the plan was made: never overwritten.
  fs.mkdirSync(path.join(f.dir, "archive"));
  fs.writeFileSync(path.join(f.dir, "archive", "projects-archive.md"), "my own note\n");
  assert.ok(f.check(p).some((e) => /already exists: it would be overwritten/.test(e)));
  // And a new plan refuses to touch a file memglow did not make.
  const p2 = f.make([{ note: "old", key: f.key("Old plan") }]);
  assert.strictEqual(p2.ok, false);
  assert.match(p2.errors.join(" "), /not a memglow archive note: memglow never overwrites it/);
  // A memglow archive note of another theme under that name: refused.
  fs.writeFileSync(path.join(f.dir, "archive", "projects-archive.md"), "---\ntheme: knowledge\nmemglow_archive: true\n---\n");
  assert.match(f.make([{ note: "old", key: f.key("Old plan") }]).errors.join(" "), /another theme/);
});

test("plan: appends to an existing archive note; refuses stale keys and duplicate titles", () => {
  const f = planFixture();
  fs.mkdirSync(path.join(f.dir, "archive"));
  const existing = "---\ntitle: \"Projects — archive\"\ntheme: projects\nsubtheme: archive\nmemglow_archive: true\n---\n\nIntro.\n\n<!-- memglow:archived from=\"gone\" date=\"2026-01-01\" -->\n## Ancient\nOld text.\n";
  fs.writeFileSync(path.join(f.dir, "archive", "projects-archive.md"), existing);
  const p = f.make([{ note: "old", key: f.key("Old plan") }, { note: "old", key: f.key("Current rules") }]);
  assert.ok(p.ok, JSON.stringify(p.errors));
  const arch = p.files.find((x) => x.role === "archive");
  assert.strictEqual(arch.kind, "modify");
  assert.ok(arch.after.startsWith(existing), "append only");
  const entries = A.parseSummary(p.files.find((x) => x.role === "summary").after);
  assert.deepStrictEqual(entries.map((e) => e.title), ["Current rules", "Old plan", "Ancient"], "rebuilt from every archive note, newest first");
  assert.match(f.make([{ note: "old", key: "0123456789abcdef" }]).errors.join(" "), /changed since it was listed/);
  fs.writeFileSync(path.join(f.dir, "archive", "projects-archive.md"), existing.replace("## Ancient", "## Old plan"));
  assert.match(f.make([{ note: "old", key: f.key("Old plan") }]).errors.join(" "), /already in archive\/projects-archive\.md/);
});

// ------------------------------------------------------------------ AI selection

test("AI review: only listed ids, once each; nothing chosen is refused", () => {
  const ids = new Map([["s1", { key: "a" }], ["s2", { key: "b" }]]);
  assert.ok(A.validateSelection({ archive: ["s1"], keep: [{ id: "s2", why: "rule" }], notes: "" }, ids).ok);
  assert.match(A.validateSelection({ archive: ["s3"] }, ids).errors.join(), /not one of the listed/);
  assert.match(A.validateSelection({ archive: ["s1", "s1"] }, ids).errors.join(), /twice/);
  assert.match(A.validateSelection({ archive: ["s1"], keep: [{ id: "s1", why: "" }] }, ids).errors.join(), /both archived and kept/);
  assert.match(A.validateSelection({ archive: ["s1"], file: "x.md" }, ids).errors.join(), /unknown key/);
  assert.match(A.validateSelection({ archive: [] }, ids).errors.join(), /nothing to archive/);
  const req = A.buildSelectionRequest([{ id: "s1", section: { label: "L", note: "n", title: "T", tokens: 5, lastRead: null } }], () => "first line");
  assert.match(req.system, /NO tools/);
  assert.match(req.prompt, /<sections>\n\[s1\] note "L" \(n\) · section "T"/);
});

test("summary: render → parse round trip; matching by topic words", () => {
  const e = [
    { date: "2026-10-01", title: "Old plan · v1", from: "old", archive: "projects-archive", anchor: "Old plan · v1", tokens: 1234 },
    { date: "2026-09-01", title: "Router setup", from: "home-net", archive: "habits-archive", anchor: "", tokens: 50 },
  ];
  const text = A.renderSummary("---\nmemglow_archive_summary: true\n---\n", e);
  assert.deepStrictEqual(A.parseSummary(text), e);
  assert.strictEqual(A.parseSummary(text.replace("memglow_archive_summary: true", "x: y")), null, "not memglow's");
  assert.deepStrictEqual(A.matchEntries(e, "router").map((x) => x.title), ["Router setup"]);
  assert.deepStrictEqual(A.matchEntries(e, "home net").map((x) => x.from), ["home-net"]);
  assert.deepStrictEqual(A.matchEntries(e, "zebra"), []);
});

// ------------------------------------------------------------------ HTTP flow (assistant on)

function makeFake(mode = "split") {
  const dir = tmp("memglow-arch-fake-");
  const src = fs.readFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(path.join(dir, "claude"), src, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mode"), mode);
  return dir;
}
function start({ mode = "split", started = ago(200) } = {}) {
  const dir = tmp("memglow-arch-mem-");
  fs.mkdirSync(path.join(dir, "projects"));
  fs.writeFileSync(path.join(dir, "projects", "old.md"), OLD);
  fs.writeFileSync(path.join(dir, "projects", "fresh.md"), "---\ntheme: projects\n---\n## Live\n" + FILL("Live") + "\n");
  const old = new Date(NOW - 200 * DAY);
  for (const f of ["projects/old.md", "projects/fresh.md"]) fs.utimesSync(path.join(dir, f), old, old);
  const dataDir = tmp("memglow-arch-data-");
  fs.writeFileSync(path.join(dataDir, "activity-counts.json"), JSON.stringify({ version: 1, since: ago(80), started, days: {}, last: { fresh: { read: ago(2) }, old: { read: ago(130) } } }));
  const fakeDir = makeFake(mode);
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1" }, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 500 });
  const server = createServer(config, memory, { assistantEnv: { PATH: fakeDir, HOME: os.tmpdir() } });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, fakeDir, port: server.address().port })));
}
function req(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* text */ } ok({ status: res.statusCode, body: b, json: j }); });
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const write = (port, extra = {}) => ({ "Content-Type": "application/json", "X-Memglow": "1", Origin: `http://127.0.0.1:${port}`, ...extra });
const post = (s, action, body, headers) => req(s.port, "/api/assistant/" + action, { method: "POST", headers: headers || write(s.port), body: body || {} });
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8"); } };
  walk(dir);
  return out;
}
async function settle(s, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const st = (await req(s.port, "/api/assistant")).json;
    if (st.job && st.job.state !== "running" && st.job.state !== "applying") return st;
    if (Date.now() - t0 > ms) throw new Error("job still running");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("HTTP: Memory cost lists dormant sections; archive proposal → nothing written until confirmed; apply; lookup; Undo", async () => {
  const s = await start();
  try {
    const c = (await req(s.port, "/api/cost")).json;
    assert.strictEqual(c.archive.available, true, JSON.stringify(c.archive));
    const titles = c.archive.sections.map((x) => x.title).sort();
    assert.deepStrictEqual(titles, ["Current rules", "Old plan"], "fresh (read 2 days ago) is not listed");
    const key = c.archive.sections.find((x) => x.title === "Old plan").key;
    const before = snapshot(s.dir);

    // Access: CSRF header, origin.
    const noHeader = write(s.port); delete noHeader["X-Memglow"];
    assert.strictEqual((await post(s, "archive", { sections: [key] }, noHeader)).status, 403);
    assert.strictEqual((await post(s, "archive", { sections: [key] }, write(s.port, { Origin: "http://evil.example" }))).status, 403);
    assert.strictEqual((await post(s, "archive", { sections: ["0123456789abcdef"] })).status, 409, "unknown section");
    assert.strictEqual((await post(s, "archive", { sections: ["../../etc"] })).status, 400);
    assert.deepStrictEqual(snapshot(s.dir), before);

    const r = await post(s, "archive", { sections: [key] });
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json.job.kind, "archive");
    assert.strictEqual(r.json.job.state, "proposed", JSON.stringify(r.json.job.errors));
    assert.deepStrictEqual(r.json.job.files.map((f) => f.rel).sort(), ["archive/archive-summary.md", "archive/projects-archive.md", "projects/old.md"]);
    assert.ok(r.json.job.archive.gain.saved > 100);
    assert.deepStrictEqual(snapshot(s.dir), before, "a proposal writes nothing");
    // Apply without the one-time token: refused, still nothing written.
    assert.strictEqual((await post(s, "apply", { job: r.json.job.id, token: "f".repeat(64) })).status, 403);
    assert.deepStrictEqual(snapshot(s.dir), before);

    const proposed = r.json.job; // a wrong token is refused; the proposal itself stays
    const tok = (await post(s, "confirm", { job: proposed.id })).json.token;
    const ap = await post(s, "apply", { job: proposed.id, token: tok });
    assert.strictEqual(ap.status, 200, ap.body);
    assert.strictEqual(ap.json.job.state, "applied");
    const oldNow = fs.readFileSync(path.join(s.dir, "projects", "old.md"), "utf8");
    assert.ok(oldNow.includes("Archived: Old plan → [[projects-archive#Old plan]]"));
    const arch = fs.readFileSync(path.join(s.dir, "archive", "projects-archive.md"), "utf8");
    assert.ok(arch.includes("### Old plan details") && arch.includes("Plan line 7"));
    const sum = A.parseSummary(fs.readFileSync(path.join(s.dir, "archive", "archive-summary.md"), "utf8"));
    assert.deepStrictEqual(sum.map((e) => e.title), ["Old plan"]);

    // archive_lookup (memglow-mcp, read only): references, never the archived text.
    const ctx = createContext({ MEMORY_DIR: s.dir, MEMGLOW_DATA_DIR: tmp("memglow-arch-mcp-") }, os.tmpdir());
    const hit = HANDLERS.archive_lookup(ctx, { query: "old plan" });
    assert.strictEqual(hit.data.available, true);
    assert.strictEqual(hit.data.matches.length, 1);
    assert.deepStrictEqual(hit.data.matches[0], { section: "Old plan", from: "old", archiveNote: "projects-archive", link: "[[projects-archive#Old plan]]", date: dayOf(Date.now()), tokens: hit.data.matches[0].tokens });
    assert.ok(!JSON.stringify(hit).includes("Plan line"), "never the archived text");
    assert.match(HANDLERS.archive_lookup(ctx, { query: "zebra" }).summary, /No archived section matches "zebra" \(1 archived section/);

    // Undo: back to exactly the original state.
    const u = await post(s, "undo", { job: proposed.id });
    assert.strictEqual(u.status, 200, u.body);
    assert.deepStrictEqual(snapshot(s.dir), before, "Undo restores every file and removes the new ones");
  } finally { s.server.close(); }
});

test("HTTP: not enough history → no section, and an archive request is refused", async () => {
  const s = await start({ started: ago(20) });
  try {
    const c = (await req(s.port, "/api/cost")).json;
    assert.strictEqual(c.archive.available, false);
    assert.match(c.archive.reason, /^not enough data yet since \d{4}-\d{2}-\d{2}$/);
    const r = await post(s, "archive", { sections: ["0123456789abcdef"] });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /not enough data yet/);
  } finally { s.server.close(); }
});

test("HTTP: the AI review chooses among the listed sections; memglow builds the move; a bad answer writes nothing", async () => {
  const s = await start();
  try {
    const keys = (await req(s.port, "/api/cost")).json.archive.sections.map((x) => x.key);
    const before = snapshot(s.dir);
    const r = await post(s, "archive", { sections: keys, ai: true });
    assert.strictEqual(r.status, 200, r.body);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job.errors));
    assert.strictEqual(st.job.archive.moved.length, 1);
    assert.strictEqual(st.job.keep.length, 1);
    assert.strictEqual(st.job.keep[0].why, "A durable rule.");
    const call = JSON.parse(fs.readFileSync(path.join(s.fakeDir, "calls.log"), "utf8").trim().split("\n")[0]);
    assert.ok(call.stdin.includes("<sections>") && !call.stdin.includes("Plan line 7"), "only a few lines of each section are sent");
    assert.deepStrictEqual(snapshot(s.dir), before);
  } finally { s.server.close(); }
  const s2 = await start({ mode: "archive-bad" });
  try {
    const keys = (await req(s2.port, "/api/cost")).json.archive.sections.map((x) => x.key);
    const before = snapshot(s2.dir);
    await post(s2, "archive", { sections: keys, ai: true });
    const st = await settle(s2);
    assert.strictEqual(st.job.state, "invalid");
    assert.match(st.job.errors.join(" "), /not one of the listed sections/);
    assert.deepStrictEqual(snapshot(s2.dir), before);
  } finally { s2.server.close(); }
});

test("HTTP: assistant off → dormant sections are still listed (read only), the archive route does not exist", async () => {
  const dir = tmp("memglow-arch-off-");
  fs.writeFileSync(path.join(dir, "old.md"), OLD);
  const old = new Date(NOW - 200 * DAY);
  fs.utimesSync(path.join(dir, "old.md"), old, old);
  const dataDir = tmp("memglow-arch-offd-");
  fs.writeFileSync(path.join(dataDir, "activity-counts.json"), JSON.stringify({ version: 1, since: ago(80), started: ago(200), days: {}, last: {} }));
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir }, os.tmpdir());
  const server = createServer(config, createMemory({ dir, config, pollMs: 500 }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    const c = (await req(port, "/api/cost")).json;
    assert.strictEqual(c.archive.sections.length, 2);
    const r = await req(port, "/api/assistant/archive", { method: "POST", headers: write(port), body: { sections: [c.archive.sections[0].key] } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(fs.readFileSync(path.join(dir, "old.md"), "utf8"), OLD);
  } finally { server.close(); }
});

test("HTTP: password set → the archive route needs it", async () => {
  const s = await start();
  s.server.close();
  const dir = s.dir, dataDir = s.dataDir;
  const pw = "correct horse battery";
  const config = loadConfig({ MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, MEMGLOW_ASSISTANT: "1", MEMGLOW_PASSWORD: pw }, os.tmpdir());
  const server = createServer(config, createMemory({ dir, config, pollMs: 500 }), { assistantEnv: { PATH: s.fakeDir, HOME: os.tmpdir() } });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    assert.strictEqual((await req(port, "/api/assistant/archive", { method: "POST", headers: write(port), body: { sections: ["0123456789abcdef"] } })).status, 401);
    const auth = "Basic " + Buffer.from("memglow:" + pw).toString("base64");
    assert.strictEqual((await req(port, "/api/assistant/archive", { method: "POST", headers: write(port, { Authorization: auth }), body: { sections: ["0123456789abcdef"] } })).status, 409);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ proxy lever

function proxySetup(env) {
  const dir = tmp("memglow-arch-proxy-");
  fs.mkdirSync(path.join(dir, "archive"));
  fs.writeFileSync(path.join(dir, "live.md"), "---\ntheme: projects\n---\nLive note.\n");
  fs.writeFileSync(path.join(dir, "archive", "projects-archive.md"), "---\ntheme: projects\nmemglow_archive: true\n---\n<!-- memglow:archived from=\"old\" date=\"2026-06-01\" -->\n## Router setup\nSECRET-BODY-TEXT\n");
  fs.writeFileSync(path.join(dir, "archive", "archive-summary.md"), A.renderSummary("---\nmemglow_archive_summary: true\n---\n", [{ date: "2026-06-01", title: "Router setup", from: "old", archive: "projects-archive", anchor: "Router setup", tokens: 40 }]));
  const config = L.proxyConfig({ MEMGLOW_HOME: tmp("memglow-arch-home-"), MEMGLOW_MEMORY_DIR: dir, MEMGLOW_DATA_DIR: tmp("memglow-arch-pd-"), MEMGLOW_PROXY_LOG: "0", ...env });
  const index = L.createNoteIndex(config);
  const lv = L.createLevers({ config, index, savings: L.createSavings(config, () => {}) });
  let n = 0;
  return {
    config,
    search(query, text) {
      const id = ++n;
      lv.clientMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_notes", arguments: { query } } });
      const res = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      return lv.serverMessage(res);
    },
  };
}

test("proxy archive hint: OFF by default; ON adds matching archived titles when the live memory has nothing", () => {
  const off = proxySetup({});
  assert.strictEqual(off.config.archiveHint, false);
  assert.strictEqual(off.search("router", "No results").changed, false);
  const on = proxySetup({ MEMGLOW_PROXY_ARCHIVE_HINT: "1" });
  const r = on.search("router setup", "No results");
  assert.strictEqual(r.changed, true);
  const texts = r.msg.result.content.map((c) => c.text);
  assert.strictEqual(texts[0], "No results", "the server's answer is untouched");
  assert.match(texts[1], /^memglow: nothing found in the live memory — the archive summary lists: "Router setup" \(from `old`, archived 2026-06-01 in `projects-archive`/);
  assert.ok(!texts.join("").includes("SECRET-BODY-TEXT"), "titles only");
  // Only archive notes found: still "nothing in the live memory".
  const only = on.search("router", "### projects-archive\npermalink: archive/projects-archive\n");
  assert.match(only.msg.result.content.slice(-1)[0].text, /nothing found in the live memory/);
  // A live note found: no hint.
  const live = on.search("live", "### live\npermalink: live\n");
  assert.ok(!live.msg.result.content.some((c) => /nothing found in the live memory/.test(c.text)));
  // Nothing matching in the archive either: a short pointer, no titles.
  assert.match(on.search("zebra", "No results").msg.result.content[1].text, /lists no title matching this search/);
});

// ------------------------------------------------------------------ page rendering

test("UI: Archive block — escaped titles, gain, buttons, not-enough-data message, prompt", () => {
  const cost = require("../public/cost.js");
  const a = {
    available: true, afterDays: 105, cutoff: "2026-06-18", folder: "archive", summaryNote: "archive-summary", basis: "note", withTitles: true, total: 1, totalTokens: 300,
    sections: [{ key: "0123456789abcdef", note: "old", label: "Old <b>", theme: "projects", title: "Plan <script>", tokens: 300, stubTokens: 12, lineTokens: 25, lastRead: null }],
  };
  cost.setAssistant(false);
  let html = cost.costArchive(a, {});
  assert.ok(html.includes("Plan &lt;script&gt;") && !html.includes("<script>"));
  assert.ok(html.includes('data-archive-key="0123456789abcdef"') && html.includes("Copy prompt for your AI") && !html.includes("data-archive-ai"));
  assert.match(html, /≈ 288<\/strong> tokens smaller/);
  cost.setAssistant(true, "Claude Code");
  html = cost.costArchive(a, {});
  assert.ok(html.includes("Do it with Claude Code") && html.includes("Prepare without AI"));
  assert.match(cost.costArchive({ available: false, since: "2026-09-01", afterDays: 105, readyOn: "2026-12-15" }, {}), /Not enough data yet since Sep 1 — .*from Dec 15/);
  const prompt = cost.costArchivePrompt(a, a.sections, { projects: "Projects" }, "2026-10-01");
  assert.match(prompt, /Section "Plan <script>" of note "Old <b>" \(id: old, group: Projects\)/);
  assert.match(prompt, /Archived: <section title> → \[\[<group id>-archive#<section title>\]\] \(2026-10-01\)/);
  assert.match(prompt, /memglow_archive_summary: true/);
  assert.match(prompt, /wait for my OK/);
  const ai = require("../public/assistant.js");
  const job = ai.aiRenderJob({ id: "x", kind: "archive", state: "proposed", note: { label: "1 dormant section" }, files: [], keep: [{ label: "L", title: "T", why: "<i>" }], archive: { moved: [{ note: "old", heading: "Plan <x>", archive: "projects-archive", tokens: 300 }], gain: { saved: 280, live: [{ rel: "projects/old.md", before: 900, after: 620 }], summaryTokens: 60, summaryLines: 1 } } }, "Claude Code");
  assert.ok(job.includes("Archive <strong>1 dormant section") && job.includes("Plan &lt;x&gt;") && job.includes("&lt;i&gt;") && job.includes("Apply this plan"));
});
