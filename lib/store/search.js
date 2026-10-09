"use strict";
/**
 * memglow memory server — lexical search over the store. No embeddings: "vector", "semantic" and
 * "hybrid" search types run this same engine (documented; semantic search is not implemented).
 *
 * Ranking: BM25-style over weighted fields (title ≫ permalink/slug, tags > description > headings
 * > other frontmatter values > body), accent folding, English + French stop-words, a light plural
 * stemmer, prefix matching (any term of 3+ characters also matches longer index terms, at a
 * discount; `term*` asks for it explicitly at full weight), a bonus for covering more of the
 * query, for an exact title/slug match and for the words appearing as a phrase. Ties are broken by
 * permalink, so the order is deterministic.
 *
 * Query syntax: words (implicitly OR, ranked), "quoted phrases" (required), `a AND b` (both
 * required), `a OR b`, `NOT a` / `-a` (excluded), `term*`, `tag:name` (tag filter), parentheses
 * ignored.
 */
const { fold, words, terms, stem, STOP_WORDS, globToRegExp, TOKEN_RE, ASCII_TOKEN_RE } = require("./text");
const NON_ASCII = /[^\x00-\x7f]/;
const { parseTimeframe } = require("./timeframe");

const FIELD_WEIGHTS = { title: 8, path: 4, tags: 4, desc: 3, head: 2, meta: 1.5, body: 1 };
const K1 = 1.2, B = 0.75;
const PREFIX_DISCOUNT = 0.6;
const MAX_EXPANSIONS = 60;
const SKIP_META = new Set(["title", "permalink", "description", "tags", "type"]);

function metaText(fm) {
  const out = [];
  const visit = (v, depth) => {
    if (depth > 3 || v == null) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (typeof v === "object") Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  for (const [k, v] of Object.entries(fm || {})) if (!SKIP_META.has(k)) visit(v, 0);
  return out.join(" ");
}

// Per-note line term sets (snippets), filled by docOf's one tokenising pass (or lineTermsOf).
const LINE_CACHE = new WeakMap();

/** " w1 w2 w3 " — folded words joined by single spaces, for phrase checks. */
const phraseText = (s) => " " + words(s).join(" ") + " ";

function countTerms(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/**
 * 0.4.10.2: a note body is tokenised ONCE — line by line (tokens never span a line break, so the
 * concatenation is exactly what tokenising the whole body gives) — and the body's index terms,
 * its phrase text and the per-line snippet terms are all derived from that one pass. Returns the
 * per-line term sets (cached, see lineTermsOf) and, transiently, the body words and terms.
 */
function tokeniseBody(note) {
  const lineSets = new Array(note.lines.length);
  const bodyWords = [], bodyTerms = [];
  // The body is folded in ONE call; fold() never creates or removes a line break, so its lines
  // line up with note.lines (= body.split(/\r?\n/)).
  const flines = fold(note.body).split(/\r?\n/);
  const aligned = flines.length === note.lines.length;
  for (let li = 0; li < note.lines.length; li++) {
    const line = note.lines[li];
    const fl = aligned ? flines[li] : fold(line);
    const ws = fl.match(NON_ASCII.test(fl) ? TOKEN_RE : ASCII_TOKEN_RE) || [];
    const ts = [];
    for (const w of ws) { bodyWords.push(w); if (!STOP_WORDS.has(w)) { const t = stem(w); ts.push(t); bodyTerms.push(t); } }
    const l = line.trim();
    lineSets[li] = !l || /^-{3,}$/.test(l) ? null : new Set(ts);
  }
  return { lineSets, bodyWords, bodyTerms };
}

// Per-note index entries, cached on the (immutable) note object: a rescan that changed one file
// rebuilds one entry, not the whole index.
const DOC_CACHE = new WeakMap();
function docOf(n) {
  let d = DOC_CACHE.get(n);
  if (d) return d;
  const tok = tokeniseBody(n);
  if (!LINE_CACHE.has(n)) LINE_CACHE.set(n, tok.lineSets);
  const fields = {
    title: countTerms([...terms(n.title), ...(fold(n.base) !== fold(n.title) ? terms(n.base) : [])]),
    path: countTerms(terms(n.permalink.replace(/[\/_.-]+/g, " "))),
    tags: countTerms(terms(n.tags.join(" "))),
    desc: countTerms(terms(n.description)),
    head: countTerms(terms(n.sections.map((s) => s.heading).join(" \n "))),
    meta: countTerms(terms(metaText(n.frontmatter))),
    body: countTerms(tok.bodyTerms),
  };
  let len = 0;
  for (const c of fields.body.values()) len += c;
  const all = new Set();
  for (const f of Object.values(fields)) for (const t of f.keys()) all.add(t);
  // 0.4.10.5: each term's field-weighted frequency, summed once here in FIELD_WEIGHTS order (the
  // exact sum termScore used to make on every query: weights × counts are multiples of 0.5).
  const wtf = new Map();
  for (const f in FIELD_WEIGHTS) for (const [t, c] of fields[f]) if (c) wtf.set(t, (wtf.get(t) || 0) + FIELD_WEIGHTS[f] * c);
  d = {
    note: n, fields, len, all, wtf, normAvg: NaN, norm: 0,
    titleFold: fold(n.title).trim(), baseFold: fold(n.base).trim(),
    titleSlug: fold(n.title).replace(/[^\p{L}\p{N}]+/gu, "-"),
    titleWords: " " + words(n.title).join(" ") + " ",
    // = phraseText(title + "\n" + description + "\n" + tags + "\n" + body), from the body's one pass.
    phrase: " " + words(n.title).concat(words(n.description), words(n.tags.join(" ")), tok.bodyWords).join(" ") + " ",
  };
  DOC_CACHE.set(n, d);
  return d;
}

/**
 * 0.4.10.3: the index for a new store version, updated from the previous one when only a few
 * notes changed (a write): df counts adjusted for the docs that left and arrived, the sorted
 * vocabulary merged instead of re-sorted, the total length adjusted. Exactly what buildIndex()
 * gives (same docs order, same df, same vocab, same avgLen); falls back to it for big changes.
 */
function updateIndex(prev, notes) {
  const docs = notes.map(docOf);
  const before = new Set(prev.docs), now = new Set(docs);
  const added = docs.filter((d) => !before.has(d)), removed = prev.docs.filter((d) => !now.has(d));
  if (added.length + removed.length > Math.max(32, docs.length >> 2)) return buildIndex(notes);
  const df = prev.df, postings = prev.postings;
  let totalLen = prev.totalLen;
  const gone = new Set(), fresh = new Set();
  for (const d of removed) {
    totalLen -= d.len;
    for (const t of d.all) {
      const n = df.get(t) - 1;
      if (n > 0) { df.set(t, n); postings.get(t).delete(d); } else { df.delete(t); postings.delete(t); gone.add(t); }
    }
  }
  for (const d of added) {
    totalLen += d.len;
    for (const t of d.all) {
      const n = df.get(t) || 0;
      df.set(t, n + 1);
      const p = postings.get(t);
      if (p) p.add(d); else postings.set(t, new Set([d]));
      if (!n) { if (gone.has(t)) gone.delete(t); else fresh.add(t); }
    }
  }
  let vocab = prev.vocab;
  if (gone.size || fresh.size) {
    const add = [...fresh].sort();
    const out = [];
    let i = 0, j = 0;
    while (i < vocab.length || j < add.length) {
      if (j >= add.length || (i < vocab.length && vocab[i] < add[j])) { const t = vocab[i++]; if (!gone.has(t)) out.push(t); }
      else out.push(add[j++]);
    }
    vocab = out;
  }
  return { docs, df, vocab, postings, pos: positions(docs), idf: new Map(), N: docs.length, totalLen, avgLen: docs.length ? totalLen / docs.length || 1 : 1 };
}

const positions = (docs) => { const m = new Map(); docs.forEach((d, i) => m.set(d, i)); return m; };

/** The per-version inverted index. */
function buildIndex(notes) {
  const docs = notes.map(docOf);
  const df = new Map();
  // 0.4.10.5: posting lists — every index term → the docs that have it (in any field), so a
  // text search only scores the docs that can match instead of every doc.
  const postings = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.len;
    for (const t of d.all) {
      df.set(t, (df.get(t) || 0) + 1);
      const p = postings.get(t);
      if (p) p.add(d); else postings.set(t, new Set([d]));
    }
  }
  const vocab = [...df.keys()].sort();
  return { docs, df, vocab, postings, pos: positions(docs), idf: new Map(), N: docs.length, totalLen, avgLen: docs.length ? totalLen / docs.length || 1 : 1 };
}

/** Index terms starting with `p` (binary search in the sorted vocabulary). */
function expand(index, p) {
  const v = index.vocab;
  let lo = 0, hi = v.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (v[mid] < p) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < v.length && v[i].startsWith(p) && out.length < MAX_EXPANSIONS; i++) out.push(v[i]);
  return out;
}

// ---- query parsing ----

/**
 * parseQuery("memglow \"memory server\" -draft AND x tag:infra") →
 * { clauses: [{ mode: "should"|"must"|"not", terms: [...], prefix: bool, phrase: string|null }], tags: [] }
 */
function parseQuery(q) {
  const raw = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  const s = String(q || "").replace(/[()]/g, " ");
  while ((m = re.exec(s))) raw.push(m[1] != null ? { phrase: m[1] } : { word: m[2] });
  const clauses = [];
  const tags = [];
  let negateNext = false, andNext = false;
  for (const tok of raw) {
    if (tok.word === "AND" || tok.word === "&&") { andNext = true; if (clauses.length) { const last = clauses[clauses.length - 1]; if (last.mode === "should") last.mode = "must"; } continue; }
    if (tok.word === "OR" || tok.word === "||") continue;
    if (tok.word === "NOT") { negateNext = true; continue; }
    let neg = negateNext;
    negateNext = false;
    let w = tok.word;
    if (w != null) {
      if (w.length > 1 && w.startsWith("-")) { neg = true; w = w.slice(1); }
      else if (w.length > 1 && w.startsWith("+")) { andNext = true; w = w.slice(1); }
      const tg = /^(?:tag|tags):(.+)$/i.exec(w);
      if (tg) { tags.push(...tg[1].split(",").map((x) => x.trim()).filter(Boolean)); andNext = false; continue; }
      const prefix = /\*$/.test(w);
      const ws = words(w.replace(/\*+$/, ""));
      let ts = ws.filter((x) => !STOP_WORDS.has(x)).map(stem);
      if (!ts.length) { andNext = false; continue; }
      const clause = { mode: neg ? "not" : andNext ? "must" : "should", terms: ts, prefix, phrase: ws.length > 1 ? phraseText(ws.join(" ")) : null, strictPhrase: false, raw: w };
      clauses.push(clause);
    } else {
      const ws = words(tok.phrase);
      if (!ws.length) { andNext = false; continue; }
      let ts = ws.filter((x) => !STOP_WORDS.has(x)).map(stem);
      if (!ts.length) ts = ws.map(stem);
      clauses.push({ mode: neg ? "not" : "must", terms: ts, prefix: false, phrase: phraseText(ws.join(" ")), strictPhrase: true, raw: tok.phrase });
    }
    andNext = false;
  }
  // A query made only of stop-words ("the", "les") still searches for them.
  if (!clauses.length && !tags.length) {
    const ws = words(s);
    if (ws.length) clauses.push({ mode: "should", terms: ws.map(stem), prefix: false, phrase: ws.length > 1 ? phraseText(ws.join(" ")) : null, strictPhrase: false, raw: s });
  }
  return { clauses, tags };
}

// ---- filters ----

function lc(v) { return fold(String(v)).trim(); }

function getPath(obj, key) {
  if (obj == null) return undefined;
  if (key in obj) return obj[key];
  let cur = obj;
  for (const part of String(key).split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[part]; }
  return cur;
}

function cmp(a, b) {
  const na = Number(a), nb = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const sa = lc(a), sb = lc(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** One metadata filter value against a note's frontmatter value. */
function matchValue(actual, want) {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    return Object.entries(want).every(([op, v]) => {
      const vals = Array.isArray(actual) ? actual : [actual];
      switch (op) {
        case "$in": return (Array.isArray(v) ? v : [v]).some((x) => vals.some((a) => a != null && lc(a) === lc(x)));
        case "$nin": return !(Array.isArray(v) ? v : [v]).some((x) => vals.some((a) => a != null && lc(a) === lc(x)));
        case "$eq": return vals.some((a) => a != null && lc(a) === lc(v));
        case "$ne": return !vals.some((a) => a != null && lc(a) === lc(v));
        case "$contains": return vals.some((a) => a != null && lc(a).includes(lc(v)));
        case "$gt": return actual != null && cmp(actual, v) > 0;
        case "$gte": return actual != null && cmp(actual, v) >= 0;
        case "$lt": return actual != null && cmp(actual, v) < 0;
        case "$lte": return actual != null && cmp(actual, v) <= 0;
        case "$between": return Array.isArray(v) && v.length === 2 && actual != null && cmp(actual, v[0]) >= 0 && cmp(actual, v[1]) <= 0;
        case "$exists": return (actual !== undefined && actual !== null) === !!v;
        default: return false;
      }
    });
  }
  if (actual == null) return false;
  if (Array.isArray(want)) return want.some((w) => matchValue(actual, w));
  if (Array.isArray(actual)) return actual.some((a) => a != null && typeof a !== "object" && lc(a) === lc(want));
  if (typeof actual === "object") return false;
  return lc(actual) === lc(want);
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);

/** A predicate over notes from the search arguments, or null when there is no filter. */
function noteFilter(args, now = Date.now()) {
  const preds = [];
  const types = asArray(args.note_types).map(lc);
  if (types.length) preds.push((n) => types.includes(lc(n.type)));
  const tags = asArray(args.tags).concat(args._queryTags || []).map(lc);
  if (tags.length) preds.push((n) => { const have = new Set(n.tags.map(lc)); return tags.every((t) => have.has(t)); });
  if (args.status != null && String(args.status).trim()) { const st = lc(args.status); preds.push((n) => n.status != null && lc(n.status) === st); }
  const mf = args.metadata_filters && typeof args.metadata_filters === "object" && !Array.isArray(args.metadata_filters) ? args.metadata_filters : null;
  if (mf) {
    for (const [k0, v] of Object.entries(mf)) {
      const k = k0 === "note_type" ? "type" : k0;
      if (k === "tags") { const want = asArray(Array.isArray(v) || typeof v === "string" ? v : []).map(lc); if (want.length) preds.push((n) => { const have = new Set(n.tags.map(lc)); return want.every((t) => have.has(t)); }); else preds.push((n) => matchValue(n.tags, v)); continue; }
      preds.push((n) => matchValue(k === "type" ? n.type : getPath(n.frontmatter, k), v));
    }
  }
  if (args.after_date != null && String(args.after_date).trim()) {
    const since = parseTimeframe(args.after_date, now);
    if (since != null) preds.push((n) => n.mtimeMs >= since);
  }
  return preds.length ? (n) => preds.every((p) => p(n)) : null;
}

// ---- snippets ----

/** The body line that best matches the query terms, trimmed to ~200 characters, one line. */
// Per-note line terms, computed once per note version (snippets are on the hot path) — by the
// same one pass that builds the note's index entry (docOf → tokeniseBody).
function lineTermsOf(note) {
  let lt = LINE_CACHE.get(note);
  if (!lt) {
    lt = tokeniseBody(note).lineSets;
    LINE_CACHE.set(note, lt);
  }
  return lt;
}

// 0.4.10.5: per note, every term → the lines holding it (built once, from the line term sets), so
// a snippet visits only the lines that hold a query term (or a longer word starting with it)
// instead of testing every line against every query term.
const LINE_INDEX = new WeakMap();
function lineIndexOf(note) {
  let x = LINE_INDEX.get(note);
  if (!x) {
    const lt = lineTermsOf(note);
    const lines = new Map();
    lt.forEach((ts, li) => { if (ts) for (const t of ts) { const a = lines.get(t); if (a) a.push(li); else lines.set(t, [li]); } });
    x = { lines, terms: [...lines.keys()].sort() };
    LINE_INDEX.set(note, x);
  }
  return x;
}

function snippet(note, qterms) {
  if (!qterms.length) return "";
  const want = [...new Set(qterms)];
  const { lines, terms: noteTerms } = lineIndexOf(note);
  // Same arithmetic as testing each line in turn: +1 for a query term the line has, else +0.6
  // when the line has a longer word starting with it (3+ characters) — added in `want` order.
  const hitsAt = new Map();
  for (const q of want) {
    const exact = lines.get(q);
    const exactSet = exact ? new Set(exact) : null;
    if (exact) for (const li of exact) hitsAt.set(li, (hitsAt.get(li) || 0) + 1);
    if (q.length >= 3) {
      const seen = new Set();
      let lo = 0, hi = noteTerms.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (noteTerms[mid] < q) lo = mid + 1; else hi = mid; }
      for (let k = lo; k < noteTerms.length && noteTerms[k].startsWith(q); k++) {
        const t = noteTerms[k];
        if (t === q) continue;
        for (const li of lines.get(t)) {
          if (seen.has(li) || (exactSet && exactSet.has(li))) continue;
          seen.add(li);
          hitsAt.set(li, (hitsAt.get(li) || 0) + 0.6);
        }
      }
    }
  }
  let best = null, bestHits = 0, bestLine = Infinity;
  for (const [li, hits] of hitsAt) if (hits > bestHits || (hits === bestHits && li < bestLine)) { bestHits = hits; bestLine = li; }
  if (bestLine !== Infinity) best = note.lines[bestLine].trim();
  if (!best) return "";
  return clip(best.replace(/\s+/g, " "), want, 200);
}

/**
 * A one-line excerpt cut to about `max` characters around the first query term it holds
 * (`want`: folded query terms), on word boundaries, "…" marking a cut. With max = 200 this is
 * exactly the snippet's own cut; search_notes' text output uses 120 since 0.4.10.6.
 */
function clip(s, want, max) {
  if (s.length <= max) return s;
  const f = fold(s);
  let at = -1;
  for (const q of want || []) { const i = f.indexOf(q); if (i >= 0 && (at < 0 || i < at)) at = i; }
  let start = Math.max(0, Math.min(at - Math.round(max * 0.3), s.length - max));
  if (start > 0) { const sp = s.indexOf(" ", start); if (sp > 0 && sp < start + 30 && (at < 0 || sp < at)) start = sp + 1; }
  let end = Math.min(s.length, start + max - 2);
  if (end < s.length) { const sp = s.lastIndexOf(" ", end); if (sp > start + Math.round(max * 0.75)) end = sp; }
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}

// ---- the engine ----

function createSearch(store) {
  let index = null, indexVersion = -1;
  function idx() {
    const v = store.version();
    if (!index || indexVersion !== v) { index = index ? updateIndex(index, store.notes()) : buildIndex(store.notes()); indexVersion = v; }
    return index;
  }

  const idfOf = (I, t) => {
    let v = I.idf.get(t);
    if (v === undefined) { const n = I.df.get(t) || 0; v = Math.log(1 + (I.N - n + 0.5) / (n + 0.5)); I.idf.set(t, v); }
    return v;
  };

  /** Per-doc BM25 contribution of one index term (`idfCap`: never rarer than the query term). */
  function termScore(I, d, t, idfCap = Infinity) {
    const wtf = d.wtf.get(t);
    if (!wtf) return 0;
    const idf = Math.min(idfOf(I, t), idfCap);
    // The length normalisation, computed once per doc and index (same expression, same value).
    if (d.normAvg !== I.avgLen) { d.norm = K1 * (1 - B + B * (d.len / I.avgLen)); d.normAvg = I.avgLen; }
    return idf * (wtf * (K1 + 1)) / (wtf + d.norm);
  }

  /** Best score of one query term in a doc (exact, else the best prefix expansion), 0 when absent. */
  function queryTermScore(I, d, qt, explicitPrefix, cache) {
    let s = d.all.has(qt) ? termScore(I, d, qt) : 0;
    if (qt.length >= 3 || explicitPrefix) {
      let exp = cache.get(qt);
      if (!exp) { exp = expand(I, qt).filter((t) => t !== qt); cache.set(qt, exp); }
      const factor = explicitPrefix ? 1 : PREFIX_DISCOUNT;
      // A longer word found by prefix never scores as a rarer (more specific) word than the one typed.
      const cap = I.df.has(qt) ? idfOf(I, qt) : Infinity;
      for (const t of exp) if (d.all.has(t)) { const v = termScore(I, d, t, cap) * factor; if (v > s) s = v; }
    }
    return s;
  }

  /**
   * search(args) → { results: [{ note, score, match, kind }], total, page, page_size, has_more }.
   * args: query, search_type, page, page_size, note_types, entity_types, categories, tags, status,
   * metadata_filters, after_date.
   */
  function search(args = {}, now = Date.now()) {
    const I = idx();
    const page = Math.max(1, parseInt(args.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(1000, parseInt(args.page_size, 10) || 10));
    let query = typeof args.query === "string" ? args.query.trim() : "";
    let type = String(args.search_type || "text").toLowerCase();
    if (/^memory:\/\//i.test(query)) { type = "permalink"; query = query.replace(/^memory:\/\//i, ""); }
    const entityTypes = asArray(args.entity_types).map(lc);
    const categories = asArray(args.categories).map(lc);
    const parsed = type === "permalink" || type === "title" ? { clauses: [], tags: [] } : parseQuery(query);
    const filter = noteFilter({ ...args, _queryTags: parsed.tags }, now);
    const docs = filter ? I.docs.filter((d) => filter(d.note)) : I.docs;
    let hits = [];

    const wantObs = entityTypes.includes("observation") || (categories.length && !entityTypes.length);
    const wantRel = entityTypes.includes("relation");
    const wantEnt = !entityTypes.length ? !categories.length : entityTypes.includes("entity");

    if (wantEnt) {
      if (type === "permalink") hits = permalinkHits(docs, query);
      else if (type === "title") hits = titleHits(docs, query);
      else {
        const cand = candidates(I, parsed);
        hits = textHits(I, cand ? (filter ? cand.filter((d) => filter(d.note)) : cand) : docs, parsed, query);
      }
    }
    if (wantObs) hits = hits.concat(observationHits(docs, parsed, categories, type === "title" || type === "permalink" ? query : null));
    if (wantRel) hits = hits.concat(relationHits(docs, parsed));
    hits.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const total = hits.length;
    const start = (page - 1) * pageSize;
    const results = hits.slice(start, start + pageSize);
    // Snippets only for the page actually returned.
    for (const h of results) if (h.qterms) h.match = snippet(h.note, h.qterms) || h.note.title;
    return { results, total, page, page_size: pageSize, has_more: start + pageSize < total };
  }

  /**
   * 0.4.10.5: the docs a text query can match, in index order — the union of the posting lists of
   * its positive terms and of their prefix expansions (exactly the terms queryTermScore looks at),
   * or null to scan every doc: no positive clause (filter-only / NOT-only queries), or a quoted
   * phrase made of words the index does not keep (stop-words: a doc can hold the phrase without
   * any indexed term). Scoring and order are unchanged: a doc outside this set scores nothing.
   */
  function candidates(I, parsed) {
    const positive = parsed.clauses.filter((c) => c.mode !== "not");
    if (!positive.length) return null;
    if (positive.some((c) => c.strictPhrase && c.terms.some((t) => !I.df.has(t)))) {
      // A required phrase with an unindexed word: still safe when another of its words is indexed?
      // Not guaranteed (a stop-word-only phrase) — scan everything, as before.
      if (positive.some((c) => c.strictPhrase && c.terms.every((t) => !I.df.has(t)))) return null;
    }
    const set = new Set();
    const addAll = (t) => { const p = I.postings.get(t); if (p) for (const d of p) set.add(d); };
    for (const c of positive) {
      for (const t of c.terms) {
        addAll(t);
        if (t.length >= 3 || c.prefix) for (const e of expand(I, t)) addAll(e);
      }
    }
    if (set.size === I.docs.length) return I.docs;
    return [...set].sort((a, b) => I.pos.get(a) - I.pos.get(b));
  }

  function textHits(I, docs, parsed, query) {
    const { clauses } = parsed;
    const out = [];
    if (!clauses.length) {
      // Filter-only search: most recently updated first.
      for (const d of docs) out.push({ kind: "entity", note: d.note, score: d.note.mtimeMs / 1e13, key: d.note.permalink, match: "" });
      return out;
    }
    const cache = new Map();
    const should = clauses.filter((c) => c.mode === "should");
    const must = clauses.filter((c) => c.mode === "must");
    const not = clauses.filter((c) => c.mode === "not");
    const positive = should.concat(must);
    const allTerms = [...new Set(positive.flatMap((c) => c.terms))];
    const qFold = fold(query).replace(/["*]/g, "").trim();
    const qSlug = qFold.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    for (const d of docs) {
      let excluded = false;
      for (const c of not) {
        const present = c.phrase ? d.phrase.includes(c.phrase) : c.terms.every((t) => d.all.has(t) || (c.prefix && queryTermScore(I, d, t, true, cache) > 0));
        if (present) { excluded = true; break; }
      }
      if (excluded) continue;
      const termScores = new Map();
      const scoreOf = (t, prefix) => {
        const k = t + (prefix ? "*" : "");
        if (!termScores.has(k)) termScores.set(k, queryTermScore(I, d, t, prefix, cache));
        return termScores.get(k);
      };
      let ok = true;
      for (const c of must) {
        if (c.strictPhrase) { if (!d.phrase.includes(c.phrase)) { ok = false; break; } }
        else if (!c.terms.every((t) => scoreOf(t, c.prefix) > 0)) { ok = false; break; }
      }
      if (!ok) continue;
      if (!must.length && !should.some((c) => c.terms.some((t) => scoreOf(t, c.prefix) > 0))) continue;
      let score = 0, matched = 0;
      for (const c of positive) for (const t of c.terms) { const s = scoreOf(t, c.prefix); if (s > 0) { score += s; } }
      for (const t of allTerms) if (positive.some((c) => c.terms.includes(t) && scoreOf(t, c.prefix) > 0)) matched++;
      const coverage = allTerms.length ? matched / allTerms.length : 1;
      score *= 0.35 + 0.65 * coverage * coverage;
      // Exact title / slug match: the note the query names.
      if (qFold && (d.titleFold === qFold || d.baseFold === qFold || d.baseFold === qSlug || d.titleSlug === qSlug)) score = score * 1.5 + 5;
      else {
        // Query words in the title (the strongest sign of what a note is about).
        const inTitle = allTerms.filter((t) => d.fields.title.has(t)).length;
        if (inTitle && inTitle === allTerms.length) score *= 1.5;
        else if (inTitle) score *= 1 + 0.2 * (inTitle / allTerms.length);
      }
      // The words together, as written.
      for (const c of positive) if (c.phrase && !c.strictPhrase && d.phrase.includes(c.phrase)) score *= 1.3;
      out.push({ kind: "entity", note: d.note, score, key: d.note.permalink, match: "", qterms: allTerms });
    }
    return out;
  }

  function titleHits(docs, query) {
    const q = fold(query).trim();
    const qw = words(query);
    if (!q) return [];
    const out = [];
    for (const d of docs) {
      const t = d.titleFold, b = d.baseFold;
      let score = 0;
      if (t === q || b === q) score = 3;
      else if (t.startsWith(q) || b.startsWith(q)) score = 2 + q.length / Math.max(t.length, 1);
      else if (t.includes(q) || b.includes(q)) score = 1.5 + q.length / Math.max(t.length, 1);
      else if (qw.length && qw.every((w, i) => (i === qw.length - 1 ? new RegExp("(^|[^\\p{L}\\p{N}])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u").test(t + " " + b) : d.titleWords.includes(" " + w + " ") || (" " + words(b).join(" ") + " ").includes(" " + w + " ")))) score = 1;
      if (score > 0) out.push({ kind: "entity", note: d.note, score, key: d.note.permalink, match: "" });
    }
    return out;
  }

  function permalinkHits(docs, query) {
    const q = String(query || "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!q) return [];
    const prefix = store.project + "/";
    const variants = (n) => {
      const p = n.permalink.toLowerCase();
      return [p, p.startsWith(prefix) ? p.slice(prefix.length) : prefix + p, n.rel.toLowerCase().replace(/\.md$/, "")];
    };
    const out = [];
    if (q.includes("*")) {
      const re = globToRegExp(q);
      for (const d of docs) if (variants(d.note).some((v) => re.test(v))) out.push({ kind: "entity", note: d.note, score: 1, key: d.note.permalink, match: "" });
      return out;
    }
    for (const d of docs) {
      const vs = variants(d.note);
      if (vs.includes(q)) out.push({ kind: "entity", note: d.note, score: 1, key: d.note.permalink, match: "" });
      else if (vs.some((v) => v.startsWith(q + "/") || v.startsWith(q))) out.push({ kind: "entity", note: d.note, score: 0.5, key: d.note.permalink, match: "" });
    }
    return out;
  }

  function observationHits(docs, parsed, categories, rawQuery) {
    const qterms = [...new Set(parsed.clauses.filter((c) => c.mode !== "not").flatMap((c) => c.terms))];
    const nots = parsed.clauses.filter((c) => c.mode === "not").flatMap((c) => c.terms);
    const rq = rawQuery ? fold(rawQuery) : null;
    const out = [];
    for (const d of docs) {
      d.note.observations.forEach((o, i) => {
        if (categories.length && !categories.includes(lc(o.category))) return;
        const ts = new Set(terms(o.category + " " + o.content));
        if (nots.some((t) => ts.has(t))) return;
        let score;
        if (rq != null) { if (!fold(o.content).includes(rq) && !fold(o.category).includes(rq)) return; score = 1; }
        else if (qterms.length) {
          let hit = 0;
          for (const t of qterms) { if (ts.has(t)) hit++; else if (t.length >= 3 && [...ts].some((x) => x.startsWith(t))) hit += PREFIX_DISCOUNT; }
          if (!hit) return;
          score = hit / qterms.length + (d.fields.title.size && qterms.some((t) => d.fields.title.has(t)) ? 0.1 : 0);
        } else score = d.note.mtimeMs / 1e13;
        out.push({ kind: "observation", note: d.note, observation: o, score, key: d.note.permalink + "#" + String(i).padStart(5, "0"), match: o.content });
      });
    }
    return out;
  }

  function relationHits(docs, parsed) {
    const qterms = [...new Set(parsed.clauses.filter((c) => c.mode !== "not").flatMap((c) => c.terms))];
    const out = [];
    for (const d of docs) {
      d.note.relations.forEach((r, i) => {
        const ts = new Set(terms(r.type.replace(/_/g, " ") + " " + r.target));
        let score;
        if (qterms.length) { const hit = qterms.filter((t) => ts.has(t)).length; if (!hit) return; score = hit / qterms.length; }
        else score = d.note.mtimeMs / 1e13;
        out.push({ kind: "relation", note: d.note, relation: r, score, key: d.note.permalink + "@" + String(i).padStart(5, "0"), match: `${r.type} [[${r.target}]]` });
      });
    }
    return out;
  }

  /**
   * warmAsync(): the same, in setImmediate chunks (0.4.10.2: startup never blocks the event loop
   * for the whole build) — each chunk builds the index entries of a few notes (cached on the
   * notes, so a search arriving meanwhile reuses them), the last step assembles the index.
   * Resolves when the index for the store's current version is built. Never rejects.
   */
  async function warmAsync({ chunk = 16 } = {}) {
    try {
      for (let pass = 0; pass < 3; pass++) {
        const v = store.version();
        const notes = store.notes();
        for (let i = 0; i < notes.length; i += chunk) {
          for (let j = i; j < Math.min(notes.length, i + chunk); j++) docOf(notes[j]);
          await new Promise((ok) => setImmediate(ok));
        }
        if (store.version() !== v) continue; // changed meanwhile: the new entries next pass
        idx();
        return;
      }
      idx();
    } catch { /* the next search builds it */ }
  }

  // warm(): build the index and the snippet caches now (startup, after a rescan), off the request path.
  return { search, index: idx, warm: () => { for (const d of idx().docs) lineTermsOf(d.note); }, warmAsync };
}

module.exports = { createSearch, parseQuery, noteFilter, buildIndex, updateIndex, snippet, clip };
