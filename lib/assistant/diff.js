"use strict";
/**
 * Line diff for the assistant's proposals: common prefix/suffix, then a longest-common-subsequence
 * on the middle (bounded), grouped in hunks with `context` lines around each change.
 *   diffLines(before, after) → { added, removed, hunks: [{ lines: [{ t: " " | "+" | "-", s }] }] }
 * `before` null = a new file (every line added). Pure, no I/O.
 */
const MAX_CELLS = 4e6; // LCS table size limit; above it the middle is shown as removed + added

function split(s) {
  if (s == null) return [];
  const a = String(s).replace(/\r\n/g, "\n").split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  return a;
}

function middle(a, b) {
  const n = a.length, m = b.length;
  if (!n) return b.map((s) => ({ t: "+", s }));
  if (!m) return a.map((s) => ({ t: "-", s }));
  if (n * m > MAX_CELLS) return a.map((s) => ({ t: "-", s })).concat(b.map((s) => ({ t: "+", s })));
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push({ t: "-", s: a[i++] });
    else out.push({ t: "+", s: b[j++] });
  }
  while (i < n) out.push({ t: "-", s: a[i++] });
  while (j < m) out.push({ t: "+", s: b[j++] });
  return out;
}

function diffLines(before, after, { context = 3 } = {}) {
  const a = split(before), b = split(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const all = a.slice(0, p).map((x) => ({ t: " ", s: x }))
    .concat(middle(a.slice(p, a.length - s), b.slice(p, b.length - s)))
    .concat(a.slice(a.length - s).map((x) => ({ t: " ", s: x })));
  let added = 0, removed = 0;
  const keep = new Uint8Array(all.length);
  all.forEach((l, k) => {
    if (l.t === " ") return;
    if (l.t === "+") added++; else removed++;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = 1;
  });
  const hunks = [];
  let cur = null;
  for (let k = 0; k < all.length; k++) {
    if (!keep[k]) { cur = null; continue; }
    if (!cur) { cur = { lines: [] }; hunks.push(cur); }
    cur.lines.push(all[k]);
  }
  return { added, removed, hunks };
}

module.exports = { diffLines, splitLines: split };
