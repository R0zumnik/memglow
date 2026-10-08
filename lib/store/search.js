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
const { fold, words, terms, stem, STOP_WORDS, globToRegExp } = require("./text");
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

/** " w1 w2 w3 " — folded words joined by single spaces, for phrase checks. */
const phraseText = (s) => " " + words(s).join(" ") + " ";

function countTerms(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// Per-note index entries, cached on the (immutable) note object: a rescan that changed one file
// rebuilds one entry, not the whole index.
const DOC_CACHE = new WeakMap();
function docOf(n) {
  let d = DOC_CACHE.get(n);
  if (d) return d;
  const fields = {
    title: countTerms([...terms(n.title), ...(fold(n.base) !== fold(n.title) ? terms(n.base) : [])]),
    path: countTerms(terms(n.permalink.replace(/[\/_.-]+/g, " "))),
    tags: countTerms(terms(n.tags.join(" "))),
    desc: countTerms(terms(n.description)),
    head: countTerms(terms(n.sections.map((s) => s.heading).join(" \n "))),
    meta: countTerms(terms(metaText(n.frontmatter))),
    body: countTerms(terms(n.body)),
  };
  let len = 0;
  for (const c of fields.body.values()) len += c;
  const all = new Set();
  for (const f of Object.values(fields)) for (const t of f.keys()) all.add(t);
  d = {
    note: n, fields, len, all,
    titleFold: fold(n.title).trim(), baseFold: fold(n.base).trim(),
    titleSlug: fold(n.title).replace(/[^\p{L}\p{N}]+/gu, "-"),
    titleWords: " " + words(n.title).join(" ") + " ",
    phrase: phraseText(n.title + "\n" + n.description + "\n" + n.tags.join(" ") + "\n" + n.body),
  };
  DOC_CACHE.set(n, d);
  return d;
}

/** The per-version inverted index. */
function buildIndex(notes) {
  const docs = notes.map(docOf);
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.len;
    for (const t of d.all) df.set(t, (df.get(t) || 0) + 1);
  }
  const vocab = [...df.keys()].sort();
  return { docs, df, vocab, N: docs.length, avgLen: docs.length ? totalLen / docs.length || 1 : 1 };
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
// Per-note line terms, computed once per note version (snippets are on the hot path).
const LINE_CACHE = new WeakMap();
function lineTermsOf(note) {
  let lt = LINE_CACHE.get(note);
  if (!lt) {
    lt = note.lines.map((line) => { const l = line.trim(); return !l || /^-{3,}$/.test(l) ? null : new Set(terms(l)); });
    LINE_CACHE.set(note, lt);
  }
  return lt;
}

function snippet(note, qterms) {
  if (!qterms.length) return "";
  const want = [...new Set(qterms)];
  const lt = lineTermsOf(note);
  let best = null, bestHits = 0;
  for (let li = 0; li < note.lines.length; li++) {
    const ts = lt[li];
    if (!ts) continue;
    const l = note.lines[li].trim();
    let hits = 0;
    for (const q of want) { if (ts.has(q)) hits++; else if (q.length >= 3) { for (const t of ts) if (t.startsWith(q)) { hits += 0.6; break; } } }
    if (hits > bestHits) { bestHits = hits; best = l; }
  }
  if (!best) return "";
  let s = best.replace(/\s+/g, " ");
  if (s.length > 200) {
    const f = fold(s);
    let at = -1;
    for (const q of want) { const i = f.indexOf(q); if (i >= 0 && (at < 0 || i < at)) at = i; }
    let start = Math.max(0, Math.min(at - 60, s.length - 200));
    if (start > 0) { const sp = s.indexOf(" ", start); if (sp > 0 && sp < start + 30 && (at < 0 || sp < at)) start = sp + 1; }
    let end = Math.min(s.length, start + 198);
    if (end < s.length) { const sp = s.lastIndexOf(" ", end); if (sp > start + 150) end = sp; }
    s = (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
  }
  return s;
}

// ---- the engine ----

function createSearch(store) {
  let index = null, indexVersion = -1;
  function idx() {
    const v = store.version();
    if (!index || indexVersion !== v) { index = buildIndex(store.notes()); indexVersion = v; }
    return index;
  }

  const idfOf = (I, t) => { const n = I.df.get(t) || 0; return Math.log(1 + (I.N - n + 0.5) / (n + 0.5)); };

  /** Per-doc BM25 contribution of one index term (`idfCap`: never rarer than the query term). */
  function termScore(I, d, t, idfCap = Infinity) {
    let wtf = 0;
    for (const f in FIELD_WEIGHTS) { const c = d.fields[f].get(t); if (c) wtf += FIELD_WEIGHTS[f] * c; }
    if (!wtf) return 0;
    const idf = Math.min(idfOf(I, t), idfCap);
    return idf * (wtf * (K1 + 1)) / (wtf + K1 * (1 - B + B * (d.len / I.avgLen)));
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
      else hits = textHits(I, docs, parsed, query);
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

  // warm(): build the index and the snippet caches now (startup, after a rescan), off the request path.
  return { search, index: idx, warm: () => { for (const d of idx().docs) lineTermsOf(d.note); } };
}

module.exports = { createSearch, parseQuery, noteFilter, buildIndex, snippet };
