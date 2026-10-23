"use strict";
/**
 * Per-project core loading (memory-server's `memory_core` tool) — a session started in a given
 * working folder / repo should load only the matching project hub(s) plus an ultra-short global
 * index, instead of the WHOLE index note at every session start (see lib/always-loaded.js for
 * what that whole-index cost actually is).
 *
 * This module is pure text/object logic: no fs beyond the one optional, best-effort read of
 * memglow's own accounting files (topReadHubs, via lib/counters.js's activity-counts.json,
 * already read-only there; accountingSummary, via lib/levers/accounting.js's
 * proxy-savings.json, falling back to the same activity-counts.json) and
 * the one optional read of memglow.config.json for `readCoreMap` (lib/defaults.js, same
 * `allowCwd: false` trust boundary every other memory-server-side config reader uses — a notes
 * folder can itself be an untrusted, cloned repository, and its own ./memglow.config.json must
 * never set this). Matching itself takes plain data in, decides in, and never touches a file.
 *
 * MATCHING ORDER (matchHub, first non-empty tier wins):
 *   1. `coreMap`      explicit {"<path-or-repo-glob>": "<hub-slug>"} from config — trusted outright.
 *   2. frontmatter     a candidate note's `project_paths:` (glob(s)) or `repo:` (name/URL hint).
 *   3. word match      significant words of the cwd's last two path segments / project hints vs.
 *                      each candidate's id, title, description and index hook.
 *   4. (caller's job)  no match at all → the caller (buildMemoryCore) falls back to the top-3
 *                      most-read hubs (topReadHubs), when accounting data is available.
 * `entries` is always the FLAT list of the index's own linked notes (hub-or-standalone, exactly
 * what lib/index-tree.js's groups carry) — never every note in the memory: matching only ever
 * resolves to something the index itself already lists.
 */
const path = require("path");
const os = require("os");
const { globToRegExp, words } = require("./store/text");
const { estimateTokens } = require("./cost");
const defaultsLib = require("./defaults");
const { renderLevel } = require("./index-tree");

const CORE_MAP_MAX_ENTRIES = 200;
const CORE_MAP_KEY_MAX = 300;
const CORE_MAP_VALUE_MAX = 200;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/;

/** A validated copy of a `coreMap` value: plain object, short string keys → short slug values. */
function sanitizeCoreMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= CORE_MAP_MAX_ENTRIES) break;
    if (typeof k !== "string" || !k.trim() || k.length > CORE_MAP_KEY_MAX) continue;
    if (typeof v !== "string" || !v.trim() || v.length > CORE_MAP_VALUE_MAX || !SLUG_RE.test(v.trim())) continue;
    out[k.trim()] = v.trim();
    n++;
  }
  return out;
}

/**
 * `coreMap` from the environment (MEMGLOW_MEMORY_CORE_MAP, a JSON object string — handy for tests
 * and one-off overrides) else memglow.config.json's own "coreMap" key, read the same
 * trust-boundary-respecting way every other memory-server-side config reader does (`allowCwd:
 * false`: an explicit MEMGLOW_CONFIG or ~/.memglow/memglow.config.json only, never a
 * ./memglow.config.json inside the notes folder itself). Never throws; "" / unreadable → {}.
 */
function readCoreMap(env = process.env, cwd = process.cwd()) {
  if (env.MEMGLOW_MEMORY_CORE_MAP) {
    try { return sanitizeCoreMap(JSON.parse(env.MEMGLOW_MEMORY_CORE_MAP)); } catch { /* fall through to the file */ }
  }
  try {
    const home = env.MEMGLOW_HOME || path.join(os.homedir(), ".memglow");
    const { config } = defaultsLib.resolveConfigFiles({ env, cwd, home, allowCwd: false });
    return sanitizeCoreMap(config && config.coreMap);
  } catch { return {}; }
}

/** Folded, de-duplicated words of 3+ characters — the same bar lib/learned-aliases.js uses. */
function significant(text) {
  const seen = new Set();
  const out = [];
  for (const w of words(text)) {
    const f = w.toLowerCase();
    if (f.length < 3 || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

// 0.5.1.4: generic path/project words — common enough in a folder name (an "app", a "src", a
// "dev" checkout…) that sharing one with an unrelated note's title/id proves nothing. A cold
// review caught `/home/florent/dev/app` matching an unrelated "App review" note on "app" alone.
// Stripped from the CWD/project-hint side only (never from a note's own text): a note that
// happens to mention "app" legitimately is fine, it simply never contributes a shared word.
const GENERIC_WORDS = new Set([
  "app", "apps", "api", "apis", "web", "www", "src", "lib", "libs", "core", "docs", "doc",
  "test", "tests", "spec", "specs", "home", "node", "workspace", "workspaces", "dev", "code",
  "project", "projects", "users", "user", "documents", "document", "tmp", "temp", "data",
  "main", "master", "repo", "repos", "git", "github", "gitlab", "server", "servers", "client",
  "clients", "service", "services", "common", "shared", "utils", "util", "config", "configs",
  "build", "dist", "public", "private", "folder", "folders", "files", "file", "root", "bin",
  "etc", "assets", "static", "scripts", "script", "packages", "package", "modules", "module",
  "examples", "example", "demo", "demos", "sample", "samples", "output", "out", "logs", "log",
  "cache", "vendor", "backend", "frontend", "source", "sources", "new", "old", "base",
]);
/** significant(), with the generic stop-list removed — only the CWD/project-hint side ever uses this. */
function significantSpecific(text) {
  return significant(text).filter((w) => !GENERIC_WORDS.has(w));
}
// Tier 3's gate (see matchHub below): fuzzy score alone needs this many DISTINCT shared
// significant words; below it, only an exact whole-path-segment match (to the hub's own id or
// title) is trusted. A clear winner (strictly ahead of the runner-up) is required either way.
const WORD_MATCH_MIN_SCORE = 2;
// An exact match outranks any fuzzy score when picking the single winner (added to its score so
// it always sorts first, yet several exact matches can still tie and correctly produce "none").
const EXACT_MATCH_BONUS = 1000;

/** "~" / "~/…" resolved to the home folder — the same shorthand lib/always-loaded.js's
 * `resolveEntry` accepts for `alwaysLoaded` entries, honoured here for `coreMap` keys and a
 * note's own `project_paths:` globs (both are filesystem-path patterns, unlike a `repo:` hint). */
function expandHome(p, home = os.homedir()) {
  const s = String(p || "");
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(home, s.slice(2));
  return s;
}

function pathGlobTest(pattern, absCwd) {
  if (!absCwd) return false;
  try { return globToRegExp(expandHome(pattern), { slashStar: true }).test(absCwd); } catch { return false; }
}

function asPathList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * matchHub({ cwd, projectHints, entries, coreMap, notesById, hubIds }) → { hubIds: [id,…], matchedBy }
 * `entries`    [{ id, hook }], the index's own flat entry list (lib/index-tree.js groups, flattened).
 * `notesById`  Map<id, note> for entries that resolve to a real note (frontmatter, title,
 *              description) — an id with no entry here is matched on its bare link text only.
 * `hubIds`     optional Set<id> of lib/hub-spoke.js-confirmed hubs. Tier 3 (word match) only
 *              ever proposes one of THESE — "never arbitrary notes" — when the set is known;
 *              omitted (hub/part status unknown), it falls back to every index entry.
 * `matchedBy`  "coreMap" | "frontmatter" | "words" | "none".
 */
function matchHub({ cwd = "", projectHints = [], entries = [], coreMap = {}, notesById = new Map(), hubIds = null } = {}) {
  const absCwd = cwd ? path.resolve(String(cwd)) : "";
  const hints = (projectHints || []).map(String).filter(Boolean);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const resolveSlug = (slug) => {
    if (byId.has(slug)) return slug;
    const low = slug.toLowerCase();
    for (const e of entries) if (e.id.toLowerCase() === low) return e.id;
    return slug; // kept as given: the caller (memory_core) reports it as "not in the index" itself
  };

  // 1. coreMap: an explicit path/repo glob → hub slug, checked in the order the config lists them.
  for (const [pattern, hubSlug] of Object.entries(coreMap || {})) {
    let reRaw;
    try { reRaw = globToRegExp(pattern, { slashStar: true }); } catch { reRaw = null; }
    if (pathGlobTest(pattern, absCwd) || (reRaw && hints.some((h) => reRaw.test(h)))) {
      return { hubIds: [resolveSlug(hubSlug)], matchedBy: "coreMap" };
    }
  }

  // 2. frontmatter project_paths: / repo: on a candidate entry's own note.
  const fmMatches = [];
  for (const e of entries) {
    const note = notesById.get(e.id);
    const fm = note && note.frontmatter;
    if (!fm || typeof fm !== "object") continue;
    const paths = asPathList(fm.project_paths);
    if (paths.some((p) => pathGlobTest(p, absCwd))) { fmMatches.push(e.id); continue; }
    const repo = typeof fm.repo === "string" ? fm.repo.trim().toLowerCase() : "";
    if (repo && hints.some((h) => { const hl = h.toLowerCase(); return hl.includes(repo) || repo.includes(hl); })) fmMatches.push(e.id);
  }
  if (fmMatches.length) return { hubIds: [...new Set(fmMatches)], matchedBy: "frontmatter" };

  // 3. word match — HARDENED (0.5.1.4, cold-review NO-GO fix): a single shared generic word
  // ("app", "src", "dev"…) proved nothing (`/home/florent/dev/app` matched an unrelated "App
  // review" note). Candidates are restricted to CONFIRMED HUBS when known (never an arbitrary
  // note); a candidate is accepted only with >= WORD_MATCH_MIN_SCORE distinct non-generic shared
  // words, OR an exact whole-path-segment match to its own id/title; and only when there is a
  // CLEAR winner (strictly ahead of the runner-up) — a tie, generic or not, is "no match".
  const segs = absCwd ? absCwd.split(/[\\/]+/).filter(Boolean).slice(-2) : [];
  const segsFolded = segs.map((s) => s.toLowerCase());
  const hintsFolded = hints.map((h) => h.toLowerCase());
  const cwdWords = new Set();
  for (const seg of segs) for (const w of significantSpecific(seg)) cwdWords.add(w);
  for (const h of hints) for (const w of significantSpecific(h)) cwdWords.add(w);
  const candidates = hubIds ? entries.filter((e) => hubIds.has(e.id)) : entries;
  if (cwdWords.size || segsFolded.length || hintsFolded.length) {
    const scored = candidates.map((e) => {
      const note = notesById.get(e.id);
      const title = (note && note.title) || "";
      const hay = significant([e.id, title, note && note.description, e.hook].filter(Boolean).join(" "));
      const score = hay.filter((w) => cwdWords.has(w)).length;
      const idF = e.id.toLowerCase(), titleF = title.toLowerCase();
      const exact = segsFolded.some((s) => s === idF || (titleF && s === titleF)) || hintsFolded.some((h) => h === idF || (titleF && h === titleF));
      return { id: e.id, score, exact, rank: (exact ? EXACT_MATCH_BONUS : 0) + score };
    }).filter((x) => x.exact || x.score >= WORD_MATCH_MIN_SCORE).sort((a, b) => b.rank - a.rank);
    if (scored.length && (scored.length === 1 || scored[0].rank > scored[1].rank)) {
      return { hubIds: [scored[0].id], matchedBy: "words" };
    }
  }
  return { hubIds: [], matchedBy: "none" };
}

/**
 * Best-effort "top-3 most read" fallback, from memglow's OWN accounting file
 * (<dataDir>/activity-counts.json, lib/counters.js — never a note's content). `dataDir` is
 * optional: without it (or with no overlapping id ever counted) this simply returns []  — the
 * memory server does not always have access to the viewer's data folder, and that is fine, this
 * tier is explicitly "if available". Only ids the index itself lists (`entries`) are ever
 * returned: an id the counters know but the index does not list is not something memory_core can
 * expand with read_note as a hub anyway.
 */
function topReadHubs({ entries = [], dataDir = null, limit = 3 } = {}) {
  if (!dataDir || !entries.length) return [];
  let counters;
  try { counters = require("./counters").createCounters({ dir: dataDir }); } catch { return []; }
  const totals = new Map();
  for (const day of Object.values(counters.days() || {})) {
    for (const [id, c] of Object.entries((day && day.notes) || {})) {
      const r = (c.read || 0) + (c.search || 0);
      if (r) totals.set(id, (totals.get(id) || 0) + r);
    }
  }
  if (!totals.size) return [];
  const idSet = new Set(entries.map((e) => e.id));
  return [...totals.entries()].filter(([id]) => idSet.has(id)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

/**
 * 0.5.3 — a one-line accounting summary, for the "no project hub matched" fallback below:
 * before this, that branch said "no accounting data is available yet" even when `dataDir`
 * plainly HAD accounting data — just not of the per-note kind topReadHubs() looks at
 * (activity-counts.json, the viewer's own read/search/write journal, lib/counters.js). A
 * deployment that only ever runs the MCP proxy / all-in-one levers (never the separate viewer
 * journal) writes `proxy-savings.json` instead (lib/levers/accounting.js's createSavings) and
 * NEVER writes activity-counts.json — topReadHubs() then always returns [], and the old message
 * was simply false. Preferred source: `proxy-savings.json`, last 7 days (`readClientSavings`,
 * the SAME reader the Memory cost panel and Settings → Control already use for this file, so the
 * numbers shown here can never drift from those). Falls back to the OLD file
 * (activity-counts.json) when the new one has nothing — a deployment that predates the proxy
 * levers, or never ran them, may still have that journal. Returns null when NEITHER file has
 * anything for the window (the "no accounting data is available yet" wording is then still
 * true). Never throws: a malformed or unreadable file is the same as an absent one.
 */
function accountingSummary({ dataDir, now = Date.now() } = {}) {
  if (!dataDir) return null;
  try {
    const { readClientSavings } = require("./levers/accounting");
    const s = readClientSavings(dataDir, { now, windowDays: 7 });
    if (s) {
      const leverEntries = Object.entries(s.byLever).filter(([, v]) => v.tokens > 0).sort((a, b) => b[1].tokens - a[1].tokens);
      const clientTokens = Object.values(s.byClient).reduce((a, v) => a + (v.tokens || 0), 0);
      const clientCount = Object.keys(s.byClient).length;
      if (leverEntries.length || clientTokens > 0) {
        const leverText = leverEntries.length
          ? leverEntries.map(([k, v]) => `${k} ≈${v.tokens}t/${v.calls}`).join(", ")
          : "no per-lever savings yet";
        const clientText = clientTokens > 0 ? ` (≈${clientTokens} tokens relayed to ${clientCount} client(s))` : "";
        return `memglow: proxy accounting, last 7 days — ${leverText}${clientText}.`;
      }
    }
  } catch { /* fall through to the old file */ }
  try {
    const { createCounters } = require("./counters");
    const { dayOf } = require("./cost");
    const counters = createCounters({ dir: dataDir });
    const from = dayOf(now - 6 * 86400000), today = dayOf(now);
    let total = 0;
    for (const [day, v] of Object.entries(counters.days() || {})) {
      if (day < from || day > today || !v || typeof v.notes !== "object") continue;
      for (const c of Object.values(v.notes || {})) total += (c.read || 0) + (c.search || 0) + (c.write || 0);
    }
    if (total > 0) return `memglow: ${total} read/search/write event(s) recorded in the last 7 days (no proxy-savings.json yet).`;
  } catch { /* neither file: truly nothing */ }
  return null;
}

// A fenced code block's delimiter line — same toggle convention as lib/hub-spoke.js's FENCE_RE /
// lib/store/note.js's codeMask (3+ backticks or tildes, any leading indent): good enough to know
// whether the lines kept so far leave a fence OPEN, without needing the opening/closing marker
// to be the exact same character or length.
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;
/** True when the lines kept so far would leave an UNTERMINATED ``` (or ~~~) fence. */
function fenceOpenAfter(lines) {
  let open = false;
  for (const l of lines) if (FENCE_LINE_RE.test(l)) open = !open;
  return open;
}

/**
 * Cuts whole lines off the END of `text` until it fits `budgetTokens` (keeps at least the first
 * line — an unavoidably long one still wins over an empty answer). 0.5.1.4 (cold-review NO-GO
 * fix): two guarantees that were missing before —
 *   - `keepSuffix` (e.g. buildMemoryCore's "Expand: read_note / memory_index_level…" escape
 *     hatch) is appended AFTER truncation, untouched, as plain text, and its own token cost is
 *     reserved from the very first check — so cutting a huge body never costs the reader the one
 *     line that tells them how to get the rest. Pass "" when there is nothing that must survive.
 *   - the cut is never left truncated INSIDE a fenced code block: if stopping here would leave
 *     an unterminated ``` / ~~~ fence, lines keep being cut (never a fabricated closer, which
 *     could land anywhere relative to the fence's own language tag or indentation) until the
 *     fence is closed or removed outright — "close it, or cut before it", this always picks the
 *     latter, the one choice that can never mismatch what came before it.
 * The returned `text` (notice and `keepSuffix` both included) fits `budgetTokens` whenever that
 * is mathematically possible; when even the single first line plus `keepSuffix` does not, the
 * result is still the smallest this function could produce — never silently over by more than
 * that one unavoidable line.
 */
function truncateToBudget(text, budgetTokens, { tokenize = estimateTokens, keepSuffix = "" } = {}) {
  const whole = String(text == null ? "" : text);
  const suffix = String(keepSuffix || "");
  if (!(Number(budgetTokens) > 0) || tokenize(whole + suffix) <= budgetTokens) {
    return { text: whole + suffix, cut: false, cutLines: 0 };
  }
  const lines = whole.split("\n");
  let cutLines = 0;
  const noticeFor = (n) => `\n\n[memglow: cut ${n} line(s) to fit the ${budgetTokens}-token budget — expand with read_note or memory_index_level.]`;
  // The notice's own size is part of EVERY check below (reserved from the first iteration on),
  // so the loop only ever stops once the FINAL assembled text (notice + keepSuffix) truly fits.
  const fits = () => !fenceOpenAfter(lines) && tokenize(lines.join("\n") + noticeFor(cutLines) + suffix) <= budgetTokens;
  while (lines.length > 1 && !fits()) { lines.pop(); cutLines++; }
  return { text: lines.join("\n") + noticeFor(cutLines) + suffix, cut: true, cutLines };
}

/**
 * buildMemoryCore({ cwd, projectHints, tree, entries, notesById, coreMap, budgetTokens,
 *   hubIds, dataDir, tokenize }) → { text, meta }
 *   tree       lib/index-tree.js's parseIndexTree(indexText) result.
 *   entries    the SAME flat list `tree.groups` carries (passed once, computed once by the caller).
 *   hubIds     optional Set<id> of lib/hub-spoke.js-confirmed hubs, forwarded to level 0's render
 *              (see lib/index-tree.js: omitted → every entry counts, the honest fallback).
 *   dataDir    optional, for the top-3-most-read fallback (topReadHubs above).
 * `meta.matchedBy` is "coreMap" | "frontmatter" | "words" | "none"; `meta.usedTopRead` is true
 * when nothing matched and the top-3-most-read fallback is what is shown instead.
 */
function buildMemoryCore({ cwd = "", projectHints = [], tree, entries = [], notesById = new Map(), coreMap = {}, budgetTokens = 1500, hubIds = null, dataDir = null, tokenize = estimateTokens } = {}) {
  const titleOf = (id) => { const n = notesById.get(id); return (n && n.title) || id; };
  const globalIndex = renderLevel(tree, 0, { titleOf, hubIds });
  const match = matchHub({ cwd, projectHints, entries, coreMap, notesById, hubIds });
  let shownIds = match.hubIds;
  let usedTopRead = false;
  if (!shownIds.length) { shownIds = topReadHubs({ entries, dataDir }); usedTopRead = shownIds.length > 0; }

  const lines = [`# Memory core${cwd ? ` (${cwd})` : ""}`, "", "## Index", globalIndex || "(the index has no entries)", ""];
  if (shownIds.length) {
    lines.push(usedTopRead ? "## No project hub matched — most-read notes instead" : "## Matched hub(s)", "");
    for (const id of shownIds) {
      const note = notesById.get(id);
      lines.push(note ? note.raw.trim() : `(note not found in this memory: ${id})`, "");
    }
  } else {
    let tail;
    if (!dataDir) {
      tail = " (no coreMap/frontmatter/word match, and no accounting data configured).";
    } else {
      const summary = accountingSummary({ dataDir });
      tail = summary ? `, and no hub stands out yet by read count — ${summary}` : ", and no accounting data is available yet.";
    }
    lines.push("## No project hub matched for this folder" + tail, "");
  }
  // The escape hatch: plain text, never inside a fence, and — via truncateToBudget's
  // `keepSuffix` — never one of the lines a tight budget could cut away (0.5.1.4).
  const footer = "\n\n---\n" + 'Expand: read_note("<hub>") for one note in full; memory_index_level(level=1) for every group\'s hub titles; memory_index_level(level=2) for the full index with hooks.';

  const budget = truncateToBudget(lines.join("\n"), budgetTokens, { tokenize, keepSuffix: footer });
  return {
    text: budget.text,
    meta: {
      cwd: cwd || null, matchedBy: match.matchedBy, hubIds: shownIds, usedTopRead,
      budgetTokens, tokensUsed: tokenize(budget.text), truncated: budget.cut, cutLines: budget.cutLines,
    },
  };
}

module.exports = {
  sanitizeCoreMap, readCoreMap, matchHub, topReadHubs, accountingSummary, truncateToBudget, buildMemoryCore,
  CORE_MAP_MAX_ENTRIES, CORE_MAP_KEY_MAX, CORE_MAP_VALUE_MAX,
};
