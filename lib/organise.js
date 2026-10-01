"use strict";
/**
 * Organisation suggestions — notes about one subject scattered across several sub-themes of the
 * same big group. READ-ONLY and pure: note metadata and links in, suggestions out. Never looks at
 * note bodies; only ids, titles, descriptions, themes, sub-themes and [[links]].
 *
 * RULES (deterministic: same notes → same suggestions, in the same order)
 *
 *  Keywords of a note: the words of its title, id and description, lower-cased, 4+ characters,
 *  minus a short stop-word list and the usual id prefixes (user, project, reference, feedback…).
 *
 *  Tie between two notes of the SAME theme (index notes and notes without a theme never count):
 *      +2  a [[link]] between them (either direction)
 *      +1  per shared keyword, at most +3
 *  A tie is STRONG when it scores 3 or more (a link plus one shared word, or three shared words).
 *
 *  1. "Scattered" — connected groups of notes joined by strong ties, inside one theme, that span 2
 *     or more sub-themes and hold 3 or more notes. Group bigger than 12: only the 12 notes with the
 *     most strong ties are kept. Target sub-theme = the one holding the most of these notes (then
 *     the larger sub-theme in the theme, then alphabetical; "general" only if nothing else).
 *     Topic = the keyword shared by the most notes of the group (then alphabetical).
 *     Score = sum of the strong ties inside the group.
 *  2. "Alone" — a sub-theme (not "general") holding a single note of its theme, whose strong ties
 *     to ONE other sub-theme of the theme add up to 3 or more, and which is not already part of a
 *     suggestion of rule 1. Target = that sub-theme. Score = that sum.
 *  Suggestions are sorted by score (then id) and capped at 5.
 *
 * A suggestion only ever moves notes between sub-themes of their OWN theme: it never crosses big
 * groups (protected or not).
 */
const crypto = require("crypto");

const MAX_SUGGESTIONS = 5;
const MAX_NOTES = 12;
const MIN_NOTES = 3;
const STRONG = 3;
const LINK_WEIGHT = 2;
const WORDS_MAX = 3;
const STOP = new Set((
  "about after again also always among another anything because been before being below between both " +
  "could does doing done down each even every from have having here into just kept know like made make " +
  "many more most much must need never note notes only other over same shall should some such than that " +
  "their them then there these they thing this those through under until upon very want were what when " +
  "where which while will with within without would your yours user users project projects reference " +
  "feedback knowledge person people client clients general memory short added working assistant purpose"
).split(" "));
const PREFIX_RE = /^(user|feedback|reference|project|knowledge|person|client|doc|note)[-_]/;

function keywords(n) {
  const text = [String(n.id || "").replace(PREFIX_RE, ""), n.label, n.description].filter(Boolean).join(" ").toLowerCase();
  const out = new Set();
  for (const w of text.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * suggest({ notes, links, themeName, subthemeName, max })
 *   notes : [{ id, label, description, theme, subtheme, folder }]
 *   links : [{ source, target }] (the graph's de-duplicated links)
 * → [{ id, kind: "scattered"|"alone", theme, topic, target, subthemes, notes: [{ id, label, subtheme, folder }],
 *      move: [ids], score, reasons: [text], message }]
 */
function suggest({ notes = [], links = [], themeName = (t) => t, subthemeName = (s) => s, max = MAX_SUGGESTIONS } = {}) {
  const usable = notes.filter((n) => n && n.id && n.theme && n.theme !== "index" && n.theme !== "other");
  const note = new Map(usable.map((n) => [n.id, n]));
  const kw = new Map(usable.map((n) => [n.id, keywords(n)]));
  const linked = new Set();
  for (const l of links || []) {
    if (!note.has(l.source) || !note.has(l.target) || l.source === l.target) continue;
    linked.add(l.source < l.target ? l.source + "\n" + l.target : l.target + "\n" + l.source);
  }

  // Strong ties, theme by theme (pairs are only ever compared inside one theme).
  const ties = new Map(); // id → Map(otherId → { score, words })
  const addTie = (a, b, t) => {
    if (!ties.has(a)) ties.set(a, new Map());
    ties.get(a).set(b, t);
  };
  const themes = [...new Set(usable.map((n) => n.theme))].sort(byId);
  for (const theme of themes) {
    const ids = usable.filter((n) => n.theme === theme).map((n) => n.id).sort(byId);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const words = [...kw.get(a)].filter((w) => kw.get(b).has(w)).sort(byId);
        const link = linked.has(a + "\n" + b);
        const score = (link ? LINK_WEIGHT : 0) + Math.min(WORDS_MAX, words.length);
        if (score < STRONG) continue;
        const t = { score, words, link };
        addTie(a, b, t);
        addTie(b, a, t);
      }
    }
  }

  const sizeOf = new Map(); // theme\nsubtheme → notes
  for (const n of usable) { const k = n.theme + "\n" + n.subtheme; sizeOf.set(k, (sizeOf.get(k) || 0) + 1); }

  const out = [];
  const used = new Set();
  // Rule 1: scattered groups.
  const seen = new Set();
  for (const id of [...note.keys()].sort(byId)) {
    if (seen.has(id) || !ties.has(id)) continue;
    const comp = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const x = stack.pop();
      comp.push(x);
      for (const y of [...ties.get(x).keys()].sort(byId)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    let members = comp.sort(byId);
    if (members.length > MAX_NOTES) {
      const deg = (x) => [...ties.get(x).keys()].filter((y) => members.includes(y)).length;
      members = members.slice().sort((a, b) => deg(b) - deg(a) || byId(a, b)).slice(0, MAX_NOTES).sort(byId);
    }
    const subs = [...new Set(members.map((x) => note.get(x).subtheme))].sort(byId);
    if (members.length < MIN_NOTES || subs.length < 2) continue;
    const theme = note.get(members[0]).theme;
    const count = (s) => members.filter((x) => note.get(x).subtheme === s).length;
    const target = subs.slice().sort((a, b) =>
      (a === "general") - (b === "general") || count(b) - count(a) || (sizeOf.get(theme + "\n" + b) || 0) - (sizeOf.get(theme + "\n" + a) || 0) || byId(a, b))[0];
    // Topic: the keyword found in the most notes of the group.
    const freq = new Map();
    for (const x of members) for (const w of kw.get(x)) freq.set(w, (freq.get(w) || 0) + 1);
    const topWord = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))[0];
    const hub = members.slice().sort((a, b) => ties.get(b).size - ties.get(a).size || byId(a, b))[0];
    const topic = topWord ? topWord[0] : note.get(hub).label;
    let score = 0, linksIn = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const t = ties.get(members[i]).get(members[j]);
        if (t) { score += t.score; if (t.link) linksIn++; }
      }
    }
    const move = members.filter((x) => note.get(x).subtheme !== target);
    if (!move.length) continue;
    members.forEach((x) => used.add(x));
    out.push(make("scattered", theme, topic, target, subs, members, move, score, [
      `${members.length} notes of the group "${themeName(theme)}" share the word "${topic}"${linksIn ? ` and ${linksIn} link(s) between them` : ""}`,
      `they sit in ${subs.length} sub-themes: ${subs.map((s) => subthemeName(s)).join(", ")}`,
      `"${subthemeName(target)}" already holds ${count(target)} of them`,
    ]));
  }

  // Rule 2: a note alone in its sub-theme, strongly tied to another sub-theme.
  for (const n of [...usable].sort((a, b) => byId(a.id, b.id))) {
    if (used.has(n.id) || !n.subtheme || n.subtheme === "general" || sizeOf.get(n.theme + "\n" + n.subtheme) !== 1 || !ties.has(n.id)) continue;
    const per = new Map();
    for (const [o, t] of ties.get(n.id)) {
      const s = note.get(o).subtheme;
      if (s === n.subtheme) continue;
      per.set(s, (per.get(s) || { score: 0, notes: [] }));
      per.get(s).score += t.score;
      per.get(s).notes.push(o);
    }
    const best = [...per.entries()].sort((a, b) => b[1].score - a[1].score || byId(a[0], b[0]))[0];
    if (!best || best[1].score < STRONG) continue;
    const [target, info] = best;
    const members = [n.id, ...info.notes.sort(byId)].slice(0, MAX_NOTES);
    const words = new Set();
    for (const o of info.notes) for (const w of ties.get(n.id).get(o).words) words.add(w);
    const topic = [...words].sort(byId)[0] || n.label;
    used.add(n.id);
    out.push(make("alone", n.theme, topic, target, [n.subtheme, target].sort(byId), members, [n.id], info.score, [
      `"${n.label}" is the only note of the sub-theme "${subthemeName(n.subtheme)}"`,
      `it is tied to ${info.notes.length} note(s) of "${subthemeName(target)}" (${[...words].length ? "shared words: " + [...words].sort(byId).join(", ") : "links"})`,
    ]));
  }

  return out.sort((a, b) => b.score - a.score || byId(a.id, b.id)).slice(0, Math.max(0, max));

  function make(kind, theme, topic, target, subs, members, move, score, reasons) {
    const id = "rg-" + crypto.createHash("sha1").update([kind, theme, target, ...members].join("\n")).digest("hex").slice(0, 12);
    const items = members.map((x) => { const m = note.get(x); return { id: m.id, label: m.label, subtheme: m.subtheme, folder: m.folder || "" }; });
    const message = kind === "scattered"
      ? `${members.length} notes about “${topic}” are spread across ${subs.length} sub-themes of ${themeName(theme)} — group them under “${subthemeName(target)}”?`
      : `“${note.get(move[0]).label}” is alone in the sub-theme “${subthemeName(note.get(move[0]).subtheme)}” — move it to “${subthemeName(target)}”?`;
    return { id, kind, theme, topic, target, subthemes: subs, notes: items, move, score, reasons, message };
  }
}

/**
 * Ready-to-paste English prompt asking an AI assistant to regroup the notes of one suggestion with
 * its own memory tool. `protectedNames` = display names of the protected groups.
 */
function regroupPrompt(s, { themeName = (t) => t, subthemeName = (x) => x, protectedNames = [] } = {}) {
  const lines = [];
  lines.push("Please regroup a few notes of my AI memory under one sub-theme. Show me the plan BEFORE writing anything.");
  lines.push("");
  lines.push(`Group: ${themeName(s.theme)}. Topic: ${s.topic}. Suggested sub-theme: ${s.target} (${subthemeName(s.target)}).`);
  lines.push("Notes (id — title — current sub-theme — folder):");
  for (const n of s.notes) lines.push(`- ${n.id} — ${n.label} — ${n.subtheme || "general"} — ${n.folder || "(root)"}`);
  lines.push("");
  lines.push("Why memglow suggests it: " + s.reasons.join("; ") + ".");
  lines.push("");
  lines.push("Rules:");
  lines.push(`- Only change the \`subtheme\` (or \`sous_theme\`) frontmatter key of the notes that should move, to "${s.target}" (or a better name you propose to me first).`);
  lines.push(`- Every note stays in the group ${themeName(s.theme)}: never change its \`theme\` key, never move it to a folder of another group.`);
  if (protectedNames.length) lines.push("- Protected groups — never move notes across these groups: " + protectedNames.join(", ") + ".");
  lines.push("- Do not rename, merge, split or delete any note, and keep every note's text and [[links]] as they are.");
  lines.push("- Use only your memory tool (the one you normally use to read and write these notes).");
  lines.push("- First show me the plan (which notes change sub-theme, from what to what), then wait for my OK before writing.");
  return lines.join("\n");
}

module.exports = { suggest, regroupPrompt, keywords, STRONG, MAX_SUGGESTIONS, MAX_NOTES };
