"use strict";
// Phone layout (public/app.css COMPACT and DENSITY blocks, public/app.js setupSheet /
// setupLegendFold / setupSearchFold): the open/close logic in a small simulated DOM, the query
// shared by the CSS and the script, the markup of public/index.html, and "nothing changes above
// 640 px" (every phone-only part hidden outside the media queries).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../public/app.js");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ---- a tiny DOM: events, attributes, classes, focus ----
let focused = null;
function el(tag, extra) {
  const listeners = {};
  const classes = new Set();
  const e = {
    tag, attrs: {}, children: [],
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, ev) { (listeners[t] || []).forEach((f) => f(Object.assign({ stopPropagation() { this.stopped = true; } }, ev || {}))); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { focused = this; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelector(sel) { return this.children.find((c) => c.tag === sel) || null; },
  };
  return Object.assign(e, extra || {});
}
// <details>: setting .open fires "toggle" (asynchronous in browsers; synchronous here is enough).
function details() {
  const summary = el("summary");
  let open = false;
  const d = el("details", { children: [summary] });
  Object.defineProperty(d, "open", { get: () => open, set: (v) => { const was = open; open = !!v; if (was !== open) d.fire("toggle"); } });
  return { d, summary };
}

test("mobile: the CSS and the script share one phone query", () => {
  assert.strictEqual(app.COMPACT_QUERY, "(max-width: 640px), (max-height: 500px) and (orientation: landscape)");
  const css = read("public/app.css");
  assert.ok(css.includes("@media " + app.COMPACT_QUERY + " {"), "app.css COMPACT block uses COMPACT_QUERY");
  assert.ok(read("public/app.js").includes("window.matchMedia(COMPACT_QUERY)"));
  assert.ok(!read("public/app.js").includes('matchMedia("(max-width: 640px)")'), "no second, diverging query");
});

test("mobile: nothing changes above 640 px — every phone-only part is hidden outside the media queries", () => {
  const css = read("public/app.css");
  // Top-level rules only (the text outside any @media block).
  let top = "", depth = 0, inMedia = false;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("@media", i) && depth === 0) inMedia = true;
    const ch = css[i];
    if (!inMedia) top += ch;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0 && inMedia) inMedia = false; }
  }
  assert.match(top, /\.mem-legende-dd > summary \{ display: none;/, "Themes chip hidden");
  assert.match(top, /\.mem-icon-btn \{[^}]*display: none;/, "magnifier hidden");
  assert.match(top, /\.mem-options__ic \{ display: none;/, "gear hidden");
  assert.match(top, /\.mem-options__poignee, \.mem-options__fermer, \.mem-options-scrim \{ display: none; \}/, "sheet parts hidden");
  assert.ok(!/\.mem-cherche \{ display: none/.test(top), "search field visible");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.mem-options-scrim \{ animation: none; \}/, "reduced motion: no sheet animation");
});

test("mobile: index.html — chip, magnifier, gear, sheet parts, all labelled and translated", () => {
  const html = read("public/index.html");
  assert.match(html, /<details class="mem-legende-dd" id="mem-legende-dd" open>/, "legend open without JS");
  assert.match(html, /data-i18n="legend.toggle">Themes</);
  assert.match(html, /id="mem-cherche-ouvrir" aria-expanded="false" aria-controls="mem-cherche" data-i18n-attr="aria-label:search.label" aria-label="Find a note"/);
  assert.match(html, /<span class="mem-options__texte" data-i18n="settings.summary">Settings<\/span>/, "Settings label kept for screen readers");
  assert.match(html, /id="mem-options-fermer" data-i18n="settings.close">Close settings</);
  assert.match(html, /id="mem-options-poignee" aria-hidden="true"/);
  assert.match(html, /id="mem-options-scrim" aria-hidden="true"/);
  for (const svg of html.match(/<svg[^>]*>/g)) assert.match(svg, /aria-hidden="true"/, "decorative icons hidden from screen readers");
});

test("mobile: Settings sheet — focus in, close by button, background, swipe, close(); focus back to the gear", () => {
  const { d, summary } = details();
  const closeButton = el("button"), scrim = el("div"), handle = el("div");
  let phone = true;
  const sheet = app.setupSheet({ details: d, closeButton, scrim, handle, compact: () => phone });
  d.open = true;
  assert.strictEqual(focused, closeButton, "opened on a phone: focus on Close settings");
  closeButton.fire("click");
  assert.strictEqual(d.open, false);
  assert.strictEqual(focused, summary, "focus back to the gear");
  d.open = true; scrim.fire("click");
  assert.strictEqual(d.open, false, "tap on the dimmed background closes");
  d.open = true;
  handle.fire("touchstart", { touches: [{ clientY: 100 }] });
  handle.fire("touchend", { changedTouches: [{ clientY: 130 }] });
  assert.strictEqual(d.open, true, "a 30 px swipe is not enough");
  handle.fire("touchstart", { touches: [{ clientY: 100 }] });
  handle.fire("touchend", { changedTouches: [{ clientY: 170 }] });
  assert.strictEqual(d.open, false, "a 70 px swipe down closes");
  d.open = true;
  assert.ok(sheet.isOpen());
  sheet.close();
  assert.ok(!sheet.isOpen(), "close() (Escape) closes");
  // Above 640 px: a plain menu, the focus is not moved on open.
  phone = false; focused = null;
  d.open = true;
  assert.strictEqual(focused, null);
  handle.fire("touchstart", { touches: [{ clientY: 100 }] });
  handle.fire("touchend", { changedTouches: [{ clientY: 300 }] });
  assert.strictEqual(d.open, true, "no swipe outside the phone layout");
  assert.strictEqual(app.setupSheet({ details: null }), null);
});

test("mobile: legend chip — open on a computer, folded the first time on a phone, then remembered", () => {
  const store = {};
  const { d } = details();
  let phone = false;
  const apply = app.setupLegendFold({ details: d, compact: () => phone, read: (k) => store[k] || null, write: (k, v) => { store[k] = v; } });
  assert.strictEqual(d.open, true, "computer: always unfolded");
  phone = true; apply();
  assert.strictEqual(d.open, false, "phone, first time: folded");
  d.open = true;
  assert.strictEqual(store["memglow.legendOpen"], "1", "viewer's choice saved in this browser");
  apply();
  assert.strictEqual(d.open, true, "resize on the phone: the choice is kept");
  phone = false; apply();
  assert.strictEqual(d.open, true);
  d.open = false; apply();
  assert.strictEqual(d.open, true, "back on a computer: unfolded again, whatever happened on the phone");
  // A new page on the phone: the saved choice wins over "folded".
  const again = details();
  phone = true;
  app.setupLegendFold({ details: again.d, compact: () => phone, read: (k) => store[k] || null, write() {} });
  assert.strictEqual(again.d.open, true);
});

test("mobile: search behind the magnifier — opens with focus, folds on second tap, Escape, or leaving the field", () => {
  const button = el("button"), form = el("form"), field = el("input");
  let timers = [];
  const fold = app.setupSearchFold({
    button, form, field, compact: () => true,
    later: (fn) => timers.push(fn), active: () => focused,
  });
  button.fire("click");
  assert.ok(form.classList.contains("mem-cherche--ouverte"));
  assert.strictEqual(button.getAttribute("aria-expanded"), "true");
  assert.strictEqual(focused, field, "focus in the field");
  button.fire("click");
  assert.ok(!fold.isOpen(), "second tap folds");
  assert.strictEqual(button.getAttribute("aria-expanded"), "false");
  assert.strictEqual(focused, button);
  fold.open();
  field.fire("keydown", { key: "Escape" });
  assert.ok(!fold.isOpen(), "Escape folds");
  assert.strictEqual(focused, button, "focus back to the magnifier");
  fold.open();
  field.fire("blur");
  focused = field; timers.forEach((f) => f()); timers = [];
  assert.ok(fold.isOpen(), "a datalist pick (focus back in the field) keeps it open");
  field.fire("blur");
  focused = null; timers.forEach((f) => f()); timers = [];
  assert.ok(!fold.isOpen(), "leaving the field folds");
});

test("mobile: first-run set-up and AI settings — one column, full-width fields, 16 px inputs under 640 px", () => {
  const css = read("public/app.css");
  const i = css.lastIndexOf("@media (max-width: 640px) {");
  const block = css.slice(i, css.indexOf("\n}", i));
  assert.ok(i > css.indexOf(".mg-setup__field {"), "after the base rules, so it wins");
  assert.match(block, /\.mg-setup__field \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(block, /\.mg-setup__input \{[^}]*font-size: 16px/);
  assert.match(block, /\.mg-setup__btns \.bn-btn[^{]*\{[^}]*flex: 1 1 auto/);
  assert.match(css, /\.mg-setup__code \{[^}]*overflow-wrap: anywhere/, "long commands wrap, no sideways scroll");
  const html = read("public/index.html");
  assert.match(html, /id="mem-llmset" data-i18n="settings.aiSettings"/);
  assert.match(read("public/setup.js"), /closeOptions\(\); openLlmset|closeOptions\(\); open/, "the settings sheet closes when a tile opens");
});
