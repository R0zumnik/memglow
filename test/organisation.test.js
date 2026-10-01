"use strict";
// v0.4 "organisation": protected zones (lib/zones.js), categorisation suggestions (lib/organise.js)
// and the assistant's `regroup` proposal (lib/assistant/regroup.js), always-loaded cost
// (lib/always-loaded.js), the new routes, the memglow-mcp tool and the proxy's index warning.
// The AI is ALWAYS the fake `claude` of test/fixtures (never the real CLI).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../server");
const { createMemory, themeResolver } = require("../lib/memory");
const { loadConfig } = require("../lib/config");
const zones = require("../lib/zones");
const organise = require("../lib/organise");
const regroup = require("../lib/assistant/regroup");
const proposal = require("../lib/assistant/proposal");
const { measureFiles, alwaysLoadedCost, resolveEntry } = require("../lib/always-loaded");
const { dayOf, daysBefore } = require("../lib/cost");

const DEMO = path.join(__dirname, "..", "demo", "memory");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (dir, rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
const note = (theme, sub, desc, body) => `---\ntheme: ${theme}\nsubtheme: ${sub}\ndescription: "${desc}"\n---\n${body}\n`;

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8"); } };
  walk(dir);
  return out;
}

/** A small memory with one scattered subject ("kafka") inside the group knowledge, two folders. */
function orgMemory() {
  const dir = tmp("memglow-org-mem-");
  write(dir, "k1/kafka-basics.md", note("knowledge", "ops", "Kafka basics: topics, partitions", "Body A, see [[kafka-consumers]] and [[kafka-tuning]]."));
  write(dir, "k2/kafka-consumers.md", note("knowledge", "web", "Kafka consumers: groups, offsets", "Body B, see [[kafka-basics]]."));
  write(dir, "k2/kafka-tuning.md", "---\ntheme: knowledge\nsous_theme: tools\ndescription: \"Kafka tuning: batching, compression\"\n---\nBody C, see [[kafka-basics]], path link [[k2/kafka-tuning]].\n");
  write(dir, "k1/other-ops.md", note("knowledge", "ops", "Unrelated ops note", "Body D."));
  write(dir, "people/alice.md", note("people", "friends", "Alice, who likes kafka", "Body E, see [[kafka-basics]]."));
  write(dir, "MEMORY.md", "# Index\n[[kafka-basics]]\n");
  return dir;
}

function req(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, ko) => {
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: h, setHost: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* text */ } ok({ status: res.statusCode, body: b, json: j, headers: res.headers }); });
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
const sameOrigin = (port, extra = {}) => ({ "Content-Type": "application/json", "X-Memglow": "1", Origin: `http://127.0.0.1:${port}`, ...extra });

function makeFake(mode) {
  const dir = tmp("memglow-fakeclaude-");
  const src = fs.readFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(path.join(dir, "claude"), src, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "mode"), mode);
  return dir;
}

function start({ dir = orgMemory(), env = {}, assistant = false, mode = "regroup", file = null } = {}) {
  const dataDir = tmp("memglow-org-data-");
  const e = { MEMORY_DIR: dir, MEMGLOW_DATA_DIR: dataDir, ...env };
  if (assistant) e.MEMGLOW_ASSISTANT = "1";
  if (file) { const f = path.join(tmp("memglow-org-cfg-"), "c.json"); fs.writeFileSync(f, JSON.stringify(file)); e.MEMGLOW_CONFIG = f; }
  const config = loadConfig(e, os.tmpdir());
  const memory = createMemory({ dir, config, pollMs: 300 });
  const fake = assistant ? makeFake(mode) : null;
  const server = createServer(config, memory, { assistantEnv: { PATH: fake || tmp("memglow-nofake-"), HOME: os.tmpdir() } });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, dir, dataDir, fake, port: server.address().port, config })));
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

// ------------------------------------------------------------------ 1. protected zones

test("zones: strict validation — unknown theme, bad labels, wrong shapes are refused; invisible characters removed", () => {
  const ids = ["people", "projects", "knowledge"];
  assert.deepStrictEqual(zones.validate({ protected: ["people", "people", "knowledge"] }, ids), { protected: ["people", "knowledge"], labels: {} });
  assert.strictEqual(zones.validate({ protected: ["nope"] }, ids), null);
  assert.strictEqual(zones.validate({ protected: "people" }, ids), null);
  assert.strictEqual(zones.validate(null, ids), null);
  assert.strictEqual(zones.validate({ protected: [], labels: { nope: "X" } }, ids), null);
  assert.strictEqual(zones.validate({ protected: [], labels: { people: "" } }, ids), null);
  assert.strictEqual(zones.validate({ protected: [], labels: { people: "x".repeat(41) } }, ids), null);
  assert.strictEqual(zones.validate({ protected: [], labels: { people: 7 } }, ids), null);
  assert.deepStrictEqual(zones.validate({ protected: [], labels: { people: " Fa​mily\u0007  & me " } }, ids).labels, { people: "Family & me" });
  assert.deepStrictEqual(zones.validate(JSON.parse('{"protected":[],"labels":{"__proto__":"x"}}'), ids), null);
});

test("zones: not defined → config value → saved choice (wins); mode 600, never in the notes folder", () => {
  const data = tmp("memglow-zones-");
  const config = { themes: [{ id: "people", label: "People" }, { id: "work", label: "Work" }], protectedThemes: null };
  assert.deepStrictEqual(zones.readZones(data, config), { defined: false, source: "none", protected: [], labels: {} });
  const fromCfg = { ...config, protectedThemes: ["work"] };
  assert.deepStrictEqual(zones.readZones(data, fromCfg).protected, ["work"]);
  assert.strictEqual(zones.readZones(data, fromCfg).source, "config");
  const store = zones.createZoneStore({ dir: data, config: fromCfg });
  assert.strictEqual(store.write({ protected: ["nope"] }), null, "refused: nothing written");
  assert.ok(!fs.existsSync(path.join(data, "zones.json")));
  store.write({ protected: ["people"], labels: { people: "Me & family" } });
  assert.deepStrictEqual(store.read(), { defined: true, source: "saved", protected: ["people"], labels: { people: "Me & family" } });
  assert.strictEqual(fs.statSync(path.join(data, "zones.json")).mode & 0o777, 0o600);
  assert.deepStrictEqual(store.themes().map((t) => t.label), ["Me & family", "Work"]);
  // the config's own default kept apart: an empty protected list is a valid choice
  store.write({ protected: [] });
  assert.deepStrictEqual(store.read().protected, []);
  assert.strictEqual(store.read().defined, true);
});

test("zones: checkFiles refuses leaving, entering, creating elsewhere, changing `theme`, deleting", () => {
  const config = { themes: [{ id: "people" }, { id: "work" }, { id: "misc" }], themeByFolder: [["p", "people"], ["w", "work"]], indexNote: ["MEMORY"] };
  const resolver = themeResolver(config);
  const opts = { resolver, protect: ["people"], name: (t) => t.toUpperCase() };
  const fm = (t, extra = "") => `---\ntheme: ${t}\n${extra}---\nbody\n`;
  const errs = (files) => zones.checkFiles(files, opts);
  // modify: theme line changed out of the protected group
  assert.match(errs([{ rel: "x.md", kind: "modify", before: fm("people"), after: fm("work") }])[0], /from the group "PEOPLE" to "WORK"/);
  // modify: into the protected group
  assert.match(errs([{ rel: "x.md", kind: "modify", before: fm("work"), after: fm("people") }])[0], /protected groups never change/);
  // modify: theme line rewritten (same value, other spelling) inside a protected group
  assert.match(errs([{ rel: "x.md", kind: "modify", before: fm("people"), after: "---\ntheme: People\n---\nbody\n" }])[0], /"theme" line/);
  // create: a part landing in another group than its source
  assert.match(errs([{ rel: "w/new.md", kind: "create", before: null, after: "---\n---\nb\n", source: "people" }])[0], /instead of "PEOPLE"/);
  // create: from outside into the protected group
  assert.match(errs([{ rel: "p/new.md", kind: "create", before: null, after: "b\n" }])[0], /from outside/);
  // delete without a move
  assert.match(errs([{ rel: "p/a.md", kind: "delete", before: "b\n", after: null }])[0], /never deleted/);
  // a move out of the protected group (folder rule)
  assert.match(errs([
    { rel: "w/a.md", kind: "create", before: null, after: "b\n", source: "people" },
    { rel: "p/a.md", kind: "delete", before: "b\n", after: null, movedTo: "w/a.md" },
  ]).join("\n"), /protected group "PEOPLE"/);
  // allowed: subtheme change inside the protected group; anything between unprotected groups
  assert.deepStrictEqual(errs([{ rel: "x.md", kind: "modify", before: fm("people", "subtheme: a\n"), after: fm("people", "subtheme: b\n") }]), []);
  assert.deepStrictEqual(errs([{ rel: "x.md", kind: "modify", before: fm("work"), after: fm("misc") }]), []);
  // nothing protected: never an error
  assert.deepStrictEqual(zones.checkFiles([{ rel: "x.md", kind: "modify", before: fm("people"), after: fm("work") }], { resolver, protect: [] }), []);
  assert.match(zones.promptLine(["people", "work"], (t) => t.toUpperCase()), /never move notes across these groups.*PEOPLE, WORK/);
  assert.strictEqual(zones.promptLine([]), "");
});

test("zones routes: GET (overview), PUT guarded (password, X-Memglow, same origin, size, validation), labels reach the page", async () => {
  const s = await start({ env: { MEMGLOW_PASSWORD: "a-long-enough-password" } });
  const auth = { Authorization: "Basic " + Buffer.from("memglow:a-long-enough-password").toString("base64") };
  const notesBefore = snapshot(s.dir);
  try {
    assert.strictEqual((await req(s.port, "/api/zones")).status, 401);
    const z = (await req(s.port, "/api/zones", { headers: auth })).json;
    assert.strictEqual(z.defined, false);
    const kn = z.themes.find((t) => t.id === "knowledge");
    assert.deepStrictEqual([kn.notes, kn.folders], [4, ["k1", "k2"]]);
    const body = { protected: ["knowledge"], labels: { knowledge: "Tech <b>stuff</b>" } };
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port), body })).status, 401, "password first");
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: { ...auth, "Content-Type": "application/json", Origin: `http://127.0.0.1:${s.port}` }, body })).status, 403, "no X-Memglow");
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port, { ...auth, Origin: "http://evil.example" }), body })).status, 403, "cross-origin");
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port, { ...auth, "Sec-Fetch-Site": "cross-site" }), body })).status, 403);
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port, auth), body: { protected: ["nope"] } })).status, 400);
    assert.strictEqual((await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port, auth), body: "x".repeat(5000) })).status, 413);
    assert.ok(!fs.existsSync(path.join(s.dataDir, "zones.json")), "nothing written by refused requests");
    const ok = await req(s.port, "/api/zones", { method: "PUT", headers: sameOrigin(s.port, auth), body });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.protected, ["knowledge"]);
    const after = (await req(s.port, "/api/zones", { headers: auth })).json;
    assert.deepStrictEqual([after.defined, after.source], [true, "saved"]);
    const page = (await req(s.port, "/", { headers: auth })).body;
    const cfg = JSON.parse(page.match(/id="memglow-config">([^<]*)</)[1]);
    assert.strictEqual(cfg.themes.find((t) => t.id === "knowledge").label, "Tech <b>stuff</b>");
    assert.ok(page.includes("Tech &lt;b&gt;stuff&lt;/b&gt;") && !page.includes("<b>stuff</b></button>"), "legend escaped");
    assert.ok(page.includes('id="mg-zones"') && page.includes("/zones.js?v="), "first-run screen and script");
    assert.deepStrictEqual(snapshot(s.dir), notesBefore, "notes untouched");
  } finally { s.server.close(); }
});

test("zones from the config file: protectedThemes ids filtered against the themes", () => {
  const f = path.join(tmp("memglow-zcfg-"), "c.json");
  fs.writeFileSync(f, JSON.stringify({ protectedThemes: ["people", "nope", "people"] }));
  const c = loadConfig({ MEMGLOW_CONFIG: f }, os.tmpdir());
  assert.deepStrictEqual(c.protectedThemes, ["people"]);
  assert.strictEqual(loadConfig({}, tmp("memglow-zcfg-")).protectedThemes, null);
});

// ------------------------------------------------------------------ 2. categorisation

function demoInput() {
  const config = loadConfig({ MEMORY_DIR: DEMO }, os.tmpdir());
  const m = createMemory({ dir: DEMO, config });
  return m.graph();
}

test("organise: deterministic on the demo — the scattered docker notes, grouped under ops; same ids every run", () => {
  const g = demoInput();
  const a = organise.suggest({ notes: g.nodes, links: g.links });
  const b = organise.suggest({ notes: [...g.nodes].reverse(), links: [...g.links].reverse() });
  assert.deepStrictEqual(a, b, "order of the input does not matter");
  assert.strictEqual(a.length, 1);
  const s = a[0];
  assert.strictEqual(s.kind, "scattered");
  assert.strictEqual(s.theme, "knowledge");
  assert.strictEqual(s.topic, "docker");
  assert.strictEqual(s.target, "ops");
  assert.deepStrictEqual(s.move, ["knowledge-docker-networking", "knowledge-docker-registry", "reference-docker-compose"]);
  assert.ok(s.notes.every((n) => g.nodes.find((x) => x.id === n.id).theme === "knowledge"), "never across groups");
  assert.match(s.id, /^rg-[0-9a-f]{12}$/);
  assert.match(s.message, /^5 notes about “docker” are spread across 4 sub-themes of knowledge — group them under “ops”\?$/);
  const p = organise.regroupPrompt(s, { protectedNames: ["People"] });
  assert.match(p, /never move notes across these groups: People/);
  assert.match(p, /BEFORE writing anything/);
});

test("organise: rule 2 (alone in its sub-theme), weak ties ignored, never across themes, capped", () => {
  const n = (id, theme, subtheme, label, description = "") => ({ id, theme, subtheme, label, description });
  const notes = [
    n("solo", "work", "lonely", "Invoices export", "billing invoices export"),
    n("b1", "work", "billing", "Invoices rules", "billing invoices rules"),
    n("b2", "work", "billing", "Invoices clients", "billing invoices clients"),
    n("far", "home", "billing", "Invoices at home", "billing invoices home"),   // other theme: never tied
    n("weak", "work", "misc", "Garden", "plants"),
    n("i", "index", "", "Index"),
  ];
  const links = [{ source: "solo", target: "b1" }, { source: "solo", target: "far" }, { source: "weak", target: "b2" }];
  const s = organise.suggest({ notes, links });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].kind, "alone");
  assert.deepStrictEqual([s[0].target, s[0].move], ["billing", ["solo"]]);
  assert.ok(!s[0].notes.some((x) => x.id === "far" || x.id === "weak"));
  // capped at 5 suggestions and 12 notes per suggestion
  const many = [], ml = [];
  for (let t = 0; t < 7; t++) for (let k = 0; k < 20; k++) many.push(n(`t${t}n${k}`, "work", `s${t}-${k % 3}`, `Topic${t} alpha${t} beta${t}`, `gamma${t}`));
  const out = organise.suggest({ notes: many, links: ml });
  assert.strictEqual(out.length, 5);
  assert.ok(out.every((x) => x.notes.length <= 12));
  assert.deepStrictEqual(organise.suggest({ notes: [], links: [] }), []);
});

test("cost API: organisation suggestions (read-only) and protected groups named in their prompt", async () => {
  const s = await start({ dir: DEMO, file: { protectedThemes: ["people"] } });
  try {
    const before = snapshot(DEMO);
    const c = (await req(s.port, "/api/cost")).json;
    assert.strictEqual(c.organisation.length, 1);
    assert.strictEqual(c.organisation[0].topic, "docker");
    assert.match(c.organisation[0].message, /sub-themes of Knowledge/);
    assert.match(c.organisation[0].prompt, /never move notes across these groups: People/);
    assert.deepStrictEqual(c.protectedGroups, ["People"]);
    assert.deepStrictEqual(snapshot(DEMO), before, "nothing written");
  } finally { s.server.close(); }
});

// ------------------------------------------------------------------ regroup proposals (unit)

function regroupCtx(dir, config, suggestion) {
  const m = createMemory({ dir, config });
  const notes = suggestion.notes.map((x) => { const meta = m.note(x.id, { withBody: false }); return { id: x.id, rel: m.fileOf(x.id), label: meta.label, description: meta.description, subtheme: meta.subtheme }; });
  const folders = [...new Set(m.costNotes().filter((n) => n.theme === suggestion.theme).map((n) => n.folder))].sort();
  return regroup.buildRequest({ memoryDir: dir, suggestion, notes, allNotes: m.ids().map((id) => ({ id, rel: m.fileOf(id) })), folders, groupName: "Knowledge", protectedLine: zones.promptLine(["knowledge"]) });
}
function orgSuggestion(dir, config) {
  const g = createMemory({ dir, config }).graph();
  return organise.suggest({ notes: g.nodes, links: g.links })[0];
}

test("regroup: request sends metadata only (no body), names protected groups; valid proposal edits only the sub-theme line", () => {
  const dir = orgMemory();
  const config = loadConfig({ MEMORY_DIR: dir }, os.tmpdir());
  const s = orgSuggestion(dir, config);
  assert.deepStrictEqual([s.topic, s.target, s.move], ["kafka", "ops", ["kafka-consumers", "kafka-tuning"]]);
  const r = regroupCtx(dir, config, s);
  assert.ok(!/Body [ABC]/.test(r.prompt), "no note body in the prompt");
  assert.match(r.prompt, /never move notes across these groups/);
  const before = snapshot(dir);
  const v = regroup.validate({ subtheme: "ops", moves: [{ note: "kafka-consumers" }, { note: "kafka-tuning" }, { note: "kafka-basics" }], notes: "ok" }, r.ctx,
    { resolver: themeResolver(config), zone: { resolver: themeResolver(config), protect: ["knowledge"] } });
  assert.ok(v.ok, v.errors.join("; "));
  assert.deepStrictEqual(v.files.map((f) => [f.rel, f.kind, f.role]), [["k2/kafka-consumers.md", "modify", "subtheme"], ["k2/kafka-tuning.md", "modify", "subtheme"]]);
  assert.match(v.warnings[0], /already in the sub-theme "ops"/);
  const consumers = v.files[0].after;
  assert.match(consumers, /^---\ntheme: knowledge\nsubtheme: ops\n/);
  assert.strictEqual(proposal.splitFrontmatter(consumers).body, proposal.splitFrontmatter(v.files[0].before).body, "body byte for byte");
  assert.match(v.files[1].after, /\nsous_theme: ops\n/, "the existing sous_theme key is kept");
  assert.deepStrictEqual(snapshot(dir), before, "validation writes nothing");
  // no frontmatter at all: one is added, the body is kept
  assert.strictEqual(regroup.setSubtheme("Hello\n", "x"), "---\nsubtheme: x\n---\nHello\n");
  assert.strictEqual(regroup.setSubtheme("---\r\ntitle: t\r\n---\r\nB", "y"), "---\r\ntitle: t\r\nsubtheme: y\r\n---\r\nB");
});

test("regroup: refusals — group change or rename, foreign note, unlisted folder, overwrite, leaving the group, protected zone", () => {
  const dir = orgMemory();
  write(dir, "k3/kafka-consumers.md", "occupied\n");             // a file already at a target place
  write(dir, "x/loose.md", note("people", "misc", "elsewhere", "Body."));
  // `misc` folder rule: a note WITHOUT a theme line in k2 would change group if moved to "x"
  const config = loadConfig({ MEMORY_DIR: dir }, os.tmpdir());
  const s = orgSuggestion(dir, config);
  const r = regroupCtx(dir, config, s);
  const resolver = themeResolver(config);
  const v = (p, protect = []) => regroup.validate(p, r.ctx, { resolver, zone: { resolver, protect } });
  const err = (p, protect) => { const x = v(p, protect); assert.strictEqual(x.ok, false, JSON.stringify(p)); assert.deepStrictEqual(x.files, []); return x.errors.join("\n"); };
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-tuning" }], theme: "people" }), /changing or renaming a group is not allowed/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-tuning", theme: "people" }] }), /changing a note's group is not allowed/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "alice" }] }), /not one of the notes memglow suggested/);
  assert.match(err({ subtheme: "Ops Team", moves: [{ note: "kafka-tuning" }] }), /lower-case id/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-tuning" }, { note: "kafka-tuning" }] }), /listed twice/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-tuning", folder: "people" }] }), /not one of the folders of this group/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-tuning", folder: "../outside" }] }), /not one of the folders/);
  assert.match(err({ subtheme: "ops", moves: [] }), /1 to 12/);
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-basics" }] }), /nothing to change/);
  // a listed folder that already holds a file of that name: never replaced
  r.ctx.folders.add("k3");
  assert.match(err({ subtheme: "ops", moves: [{ note: "kafka-consumers", folder: "k3" }] }), /already exists — memglow never replaces a file/);
  // leaving the group: a note without `theme:` whose group comes from its folder
  const cfg2 = { ...config, themeByFolder: [["k2", "knowledge"], ["x", "people"]] };
  write(dir, "k2/kafka-plain.md", "---\nsubtheme: web\ndescription: \"Kafka plain notes\"\n---\nBody F, see [[kafka-basics]] [[kafka-consumers]].\n");
  const s2 = { ...s, notes: s.notes.concat([{ id: "kafka-plain", label: "Kafka plain", subtheme: "web", folder: "k2" }]) };
  const r2 = regroupCtx(dir, cfg2, s2);
  r2.ctx.folders.add("x");
  const res2 = themeResolver(cfg2);
  const out = regroup.validate({ subtheme: "ops", moves: [{ note: "kafka-plain", folder: "x" }] }, r2.ctx, { resolver: res2, zone: { resolver: res2, protect: ["knowledge"] } });
  assert.strictEqual(out.ok, false);
  assert.match(out.errors.join("\n"), /would leave its group "knowledge" \(it would land in "people"\)/);
  // the protected-zone check alone (resolver skipped): still refused, by zones.checkFiles
  const out2 = regroup.validate({ subtheme: "ops", moves: [{ note: "kafka-plain", folder: "x" }] }, r2.ctx, { zone: { resolver: res2, protect: ["knowledge"] } });
  assert.strictEqual(out2.ok, false);
  assert.match(out2.errors.join("\n"), /protected group "knowledge"/);
});

test("regroup: a move inside the group updates path links; split proposals also respect protected zones", () => {
  const dir = orgMemory();
  const config = loadConfig({ MEMORY_DIR: dir }, os.tmpdir());
  const s = orgSuggestion(dir, config);
  const r = regroupCtx(dir, config, s);
  const resolver = themeResolver(config);
  const v = regroup.validate({ subtheme: "ops", moves: [{ note: "kafka-tuning", folder: "k1" }] }, r.ctx, { resolver, zone: { resolver, protect: ["knowledge"] } });
  assert.ok(v.ok, v.errors.join("; "));
  const byRel = Object.fromEntries(v.files.map((f) => [f.rel + ":" + f.kind, f]));
  assert.ok(byRel["k1/kafka-tuning.md:create"] && byRel["k2/kafka-tuning.md:delete"]);
  assert.strictEqual(byRel["k2/kafka-tuning.md:delete"].movedTo, "k1/kafka-tuning.md");
  assert.match(byRel["k1/kafka-tuning.md:create"].after, /path link \[\[k1\/kafka-tuning\]\]/, "path link to itself updated");
  // split: a hand-made ctx whose parts would land in another group are refused by the zone check
  const sdir = tmp("memglow-org-split-");
  write(sdir, "w/big.md", "---\ntitle: Big\n---\nline one\n## A\nline two\n");
  const cfg = { ...loadConfig({ MEMORY_DIR: sdir }, os.tmpdir()), themeByFolder: [["w", "projects"]] };
  const sres = themeResolver(cfg);
  const req = proposal.buildRequest({ memoryDir: sdir, note: { id: "big", rel: "w/big.md", label: "Big", theme: "people", subtheme: "general", folder: "w" }, existingIds: ["big"], protectedLine: zones.promptLine(["people"]) });
  assert.match(req.prompt, /Protected groups \(never move notes across these groups/);
  const sp = proposal.validate({ summary: "S [[big-a]] [[big-b]]", parts: [{ title: "A", file: "big-a.md", content: "line one" }, { title: "B", file: "big-b.md", content: "## A\nline two" }], linkUpdates: [] }, req.ctx, { zone: { resolver: sres, protect: ["people"] } });
  assert.strictEqual(sp.ok, false);
  assert.match(sp.errors.join("\n"), /created in the group "projects" instead of "people"/);
});

// ------------------------------------------------------------------ regroup end to end (fake AI)

test("assistant regroup: propose → nothing written → confirm + apply (backup) → Undo; unknown suggestion 404", async () => {
  const s = await start({ assistant: true, mode: "regroup", file: { protectedThemes: ["knowledge"] } });
  const post = (a, body, h) => req(s.port, "/api/assistant/" + a, { method: "POST", headers: h || sameOrigin(s.port), body });
  try {
    const before = snapshot(s.dir);
    const c = (await req(s.port, "/api/cost")).json;
    const sug = c.organisation[0];
    assert.strictEqual((await post("propose", { kind: "regroup", suggestion: "rg-000000000000" })).status, 404);
    assert.strictEqual((await post("propose", { kind: "regroup", suggestion: sug.id }, { "Content-Type": "application/json", Origin: `http://127.0.0.1:${s.port}` })).status, 403, "CSRF header required");
    const p = await post("propose", { kind: "regroup", suggestion: sug.id });
    assert.strictEqual(p.status, 200, p.body);
    const st = await settle(s);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job.errors));
    assert.strictEqual(st.job.kind, "regroup");
    assert.deepStrictEqual(st.job.files.map((f) => f.role).sort(), ["subtheme", "subtheme"]);
    const sent = fs.readFileSync(path.join(s.fake, "calls.log"), "utf8");
    assert.ok(!/Body [ABC]/.test(sent), "no note body sent to the AI");
    assert.match(sent, /Protected groups \(never move notes across these groups[^\n]*Knowledge/);
    assert.deepStrictEqual(snapshot(s.dir), before, "nothing written before confirmation");
    // apply without a token: refused, nothing written
    assert.strictEqual((await post("apply", { job: st.job.id, token: "0".repeat(64) })).status, 403);
    assert.deepStrictEqual(snapshot(s.dir), before);
    const tok = (await post("confirm", { job: st.job.id })).json.token;
    const ap = await post("apply", { job: st.job.id, token: tok });
    assert.strictEqual(ap.status, 200, ap.body);
    const now = snapshot(s.dir);
    assert.match(now["k2/kafka-consumers.md"], /\nsubtheme: ops\n/);
    assert.match(now["k2/kafka-tuning.md"], /\nsous_theme: ops\n/);
    assert.strictEqual(now["k1/kafka-basics.md"], before["k1/kafka-basics.md"]);
    const un = await post("undo", { job: st.job.id });
    assert.strictEqual(un.status, 200, un.body);
    assert.deepStrictEqual(snapshot(s.dir), before, "Undo restores everything");
  } finally { s.server.close(); }
});

test("assistant regroup: AI tries to change the group → refused, nothing written; a move within the group is undone cleanly", async () => {
  const bad = await start({ assistant: true, mode: "regroup-theme" });
  try {
    const before = snapshot(bad.dir);
    const sug = (await req(bad.port, "/api/cost")).json.organisation[0];
    await req(bad.port, "/api/assistant/propose", { method: "POST", headers: sameOrigin(bad.port), body: { kind: "regroup", suggestion: sug.id } });
    const st = await settle(bad);
    assert.strictEqual(st.job.state, "invalid");
    assert.match(st.job.errors.join("\n"), /changing or renaming a group is not allowed/);
    assert.deepStrictEqual(snapshot(bad.dir), before);
  } finally { bad.server.close(); }
  const foreign = await start({ assistant: true, mode: "regroup-foreign" });
  try {
    const sug = (await req(foreign.port, "/api/cost")).json.organisation[0];
    await req(foreign.port, "/api/assistant/propose", { method: "POST", headers: sameOrigin(foreign.port), body: { kind: "regroup", suggestion: sug.id } });
    const st = await settle(foreign);
    assert.strictEqual(st.job.state, "invalid");
    assert.match(st.job.errors.join("\n"), /not one of the notes memglow suggested/);
  } finally { foreign.server.close(); }
  const mv = await start({ assistant: true, mode: "regroup-move", file: { protectedThemes: ["knowledge"] } });
  const post = (a, body) => req(mv.port, "/api/assistant/" + a, { method: "POST", headers: sameOrigin(mv.port), body });
  try {
    const before = snapshot(mv.dir);
    const sug = (await req(mv.port, "/api/cost")).json.organisation[0];
    await post("propose", { kind: "regroup", suggestion: sug.id });
    const st = await settle(mv);
    assert.strictEqual(st.job.state, "proposed", JSON.stringify(st.job.errors));
    assert.ok(st.job.files.some((f) => f.kind === "delete") && st.job.files.some((f) => f.kind === "create"));
    const tok = (await post("confirm", { job: st.job.id })).json.token;
    assert.strictEqual((await post("apply", { job: st.job.id, token: tok })).status, 200);
    const now = snapshot(mv.dir);
    assert.ok(now["k1/kafka-consumers.md"] && !now["k2/kafka-consumers.md"], "moved inside the group");
    assert.strictEqual(Object.keys(now).length, Object.keys(before).length, "no note lost");
    assert.strictEqual((await post("undo", { job: st.job.id })).status, 200);
    assert.deepStrictEqual(snapshot(mv.dir), before, "Undo puts the note back in its old place");
  } finally { mv.server.close(); }
});

// ------------------------------------------------------------------ 3. always-loaded cost

test("always loaded: sizes only (content never read nor returned), sessions from index reads or the setting, tips", () => {
  const home = tmp("memglow-al-home-");
  const cwd = tmp("memglow-al-cwd-");
  write(home, ".claude/CLAUDE.md", "SECRET-INSTRUCTIONS ".repeat(500)); // 10,000 bytes → 2,500 tokens
  write(cwd, "AGENTS.md", "short\n");
  assert.strictEqual(resolveEntry("~/.claude/CLAUDE.md", { home, cwd }), path.join(home, ".claude/CLAUDE.md"));
  const files = measureFiles(["~/.claude/CLAUDE.md", "./AGENTS.md", "missing.md"], { home, cwd });
  assert.deepStrictEqual(files, [
    { name: "~/.claude/CLAUDE.md", found: true, tokens: 2500 },
    { name: "./AGENTS.md", found: true, tokens: 2 },
    { name: "missing.md", found: false, tokens: 0 },
  ]);
  const now = Date.now();
  const none = alwaysLoadedCost({ index: [{ id: "MEMORY", label: "MEMORY", tokens: 300 }], files, days: {}, now, sessionsPerDay: 4, indexWarningTokens: 2000 });
  assert.deepStrictEqual([none.perSession, none.sessionsPerDay, none.sessionsSource, none.perDay], [2802, 4, "setting", 11208]);
  assert.strictEqual(none.tips.length, 1);
  assert.match(none.tips[0].text, /^Trim ~\/\.claude\/CLAUDE\.md/);
  const days = { [dayOf(now)]: { notes: { MEMORY: { read: 6 } } }, [daysBefore(now, 1)]: { notes: { MEMORY: { read: 2 }, x: { read: 9 } } }, [daysBefore(now, 20)]: { notes: { MEMORY: { read: 50 } } } };
  const est = alwaysLoadedCost({ index: [{ id: "MEMORY", label: "MEMORY", tokens: 2400 }], files: [], days, now, sessionsPerDay: 4, indexWarningTokens: 2000 });
  assert.deepStrictEqual([est.sessionsPerDay, est.sessionsSource, est.perDay], [4, "index reads", 9600]);
  assert.match(est.tips[0].text, /^Trim the index/);
  assert.deepStrictEqual(alwaysLoadedCost({}).tips, []);
});

test("always loaded: /api/cost carries names and ≈tokens of configured files, never their content", async () => {
  const cwd = tmp("memglow-al-cwd-");
  write(cwd, "CLAUDE.md", "TOP-SECRET-LINE\n".repeat(100));
  const s = await start({ file: { alwaysLoaded: [path.join(cwd, "CLAUDE.md"), "nowhere/AGENTS.md"], sessionsPerDay: 3 } });
  try {
    const r = await req(s.port, "/api/cost");
    assert.ok(!r.body.includes("TOP-SECRET-LINE"));
    const a = r.json.alwaysLoaded;
    assert.deepStrictEqual(a.files.map((f) => [f.found, f.tokens]), [[true, 400], [false, 0]]);
    assert.strictEqual(a.sessionsPerDay, 3);
    assert.strictEqual(a.perSession, a.indexTokens + 400);
  } finally { s.server.close(); }
});

// ------------------------------------------------------------------ page pieces, MCP tool, proxy

test("cost panel: Organisation and Always loaded blocks — escaped, assistant button only when on, named after the provider", () => {
  const cost = require("../public/cost.js");
  const evil = '<img src=x onerror=alert(1)>';
  const c = { read: { today: 0, days7: 0 }, written: { days7: 0 }, totals: { tokens: 1, notes: 1 }, index: null, share: null, top: [], largeNoteTokens: 200, chunkTokens: 100, tooLarge: [], neverRead: { available: false },
    organisation: [{ id: "rg-0123456789ab", theme: "work", target: "ops", move: ["a"], message: evil, reasons: [evil], notes: [{ id: "a", label: evil, subtheme: "web" }] }],
    alwaysLoaded: { index: [{ id: "MEMORY", label: evil, tokens: 10 }], files: [{ name: evil, found: true, tokens: 5 }], perSession: 15, sessionsPerDay: 2, perDay: 30, sessionsSource: "setting", tips: [{ text: evil }] } };
  const html = cost.costRender(c, {});
  assert.ok(!html.includes("<img"), "escaped");
  assert.ok(html.includes('data-copy-org="rg-0123456789ab"'));
  assert.ok(!html.includes("data-assist-org"));
  assert.match(html, /≈ 15<\/strong> tokens per session/);
  cost.setAssistant(true, "Local model");
  try {
    const on = cost.costRender(c, {});
    assert.ok(on.includes('data-assist-org="rg-0123456789ab"') && on.includes("Do it with Local model"));
  } finally { cost.setAssistant(false); }
  assert.match(cost.costRender({ ...c, organisation: [] }, {}), /No scattered notes found/);
});

test("zones page script: rows escaped, first run pre-ticks groups that hold notes, collect sends only changed labels", () => {
  const z = require("../public/zones.js");
  const evil = '<img src=x onerror=alert(1)>';
  const html = z.zonesRender({ defined: false, themes: [{ id: "work", label: evil, defaultLabel: "Work", notes: 3, folders: [evil] }, { id: "empty", label: "Empty", defaultLabel: "Empty", notes: 0, folders: [] }] });
  assert.ok(!html.includes("<img"));
  assert.match(html, /value="work" checked/);
  assert.ok(!/value="empty" checked/.test(html));
  assert.ok(/value="empty" checked/.test(z.zonesRender({ defined: true, protected: ["empty"], themes: [{ id: "empty", label: "E", defaultLabel: "E", notes: 0 }] })));
  const input = (id, def, value) => ({ value, getAttribute: (k) => (k === "data-theme" ? id : def) });
  assert.deepStrictEqual(z.zonesCollect([{ checked: true, value: "work" }, { checked: false, value: "x" }], [input("work", "Work", "Work"), input("x", "X", "  Mine  ")]), { protected: ["work"], labels: { x: "Mine" } });
});

test("memglow-mcp: organisation_suggestions is read-only and finds the demo's docker notes", () => {
  const { createRpc, createContext } = require("../mcp-server/memglow-mcp");
  const out = [];
  const handle = createRpc((s) => out.push(JSON.parse(s)));
  const ctx = createContext({ MEMORY_DIR: DEMO, MEMGLOW_DATA_DIR: tmp("memglow-org-mcp-") }, os.tmpdir());
  const before = snapshot(DEMO);
  handle(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "organisation_suggestions", arguments: { limit: 3 } } });
  const res = out.pop().result;
  assert.strictEqual(res.isError, false);
  const data = JSON.parse(res.content[0].text.match(/```json\n([\s\S]*)\n```/)[1]);
  assert.strictEqual(data.suggestions[0].topic, "docker");
  assert.match(data.suggestions[0].copyPrompt, /Show me the plan BEFORE writing anything/);
  handle(ctx, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "organisation_suggestions", arguments: { limit: 99 } } });
  assert.strictEqual(out.pop().result.isError, true, "strict schema");
  handle(ctx, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_health", arguments: {} } });
  assert.match(out.pop().result.content[0].text, /Loaded at every session: ≈\d+ tokens × 5 sessions\/day/);
  assert.deepStrictEqual(snapshot(DEMO), before);
});

test("proxy: index warning (config) on a read of a too-large index note, once per session; off by default", () => {
  const L = require("../lib/proxy-levers");
  const root = tmp("memglow-org-proxy-");
  const notes = path.join(root, "notes"), home = path.join(root, "home");
  fs.mkdirSync(home);
  write(notes, "MEMORY.md", "# Index\n" + "- [[a]] a line of the index\n".repeat(200));
  write(notes, "a.md", "A\n");
  const run = (proxy) => {
    fs.writeFileSync(path.join(home, "memglow.config.json"), JSON.stringify({ memoryDir: notes, indexWarningTokens: 500, proxy }));
    const cfg = L.proxyConfig({ MEMGLOW_HOME: home });
    const engine = L.createLevers({ config: cfg, index: L.createNoteIndex(cfg), savings: L.createSavings({ ...cfg, savingsFile: false, log: false }) });
    const read = (id) => {
      engine.clientMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_note", arguments: { identifier: "MEMORY" } } }, "s");
      return engine.serverMessage({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "index text" }] } }, "s").msg.result.content;
    };
    return [read(1), read(2)];
  };
  const [first, second] = run({ indexWarning: true, suggestions: false });
  assert.match(first[0].text, /^⚠ memglow: the index note "MEMORY" is ≈\d+ tokens \(index threshold 500\) and it is loaded at every session/);
  assert.strictEqual(first[1].text, "index text", "upstream content untouched");
  assert.strictEqual(second.length, 1, "once per session");
  const [off] = run({ suggestions: false });
  assert.deepStrictEqual(off.map((c) => c.text), ["index text"]);
  assert.strictEqual(L.proxyConfig({ MEMGLOW_HOME: path.join(root, "none") }).indexWarning, false);
});
