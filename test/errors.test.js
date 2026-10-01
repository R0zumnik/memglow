"use strict";
// Plus jamais d'échec silencieux: a visible, translated banner (mgBannerKind/mgErrorBanner/
// mgClearBanner, duplicated in app.js/cost.js/zones.js/assistant.js — each an independent
// <script>, not a module) on a lost connection, an unauthorized request or a server error, with a
// "Reload" or "Retry" button depending on the case; and a scan making sure no bare, unexplained
// catch block is left anywhere in those four files.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../public/app.js");
const cost = require("../public/cost.js");
const zones = require("../public/zones.js");
const assistant = require("../public/assistant.js");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const T = (k) => k; // identity translator: makes the chosen i18n key visible in the assertion

// ---- a tiny DOM for the banner: textContent, hidden, onclick ----
function el() {
  return { textContent: "", hidden: true, onclick: null };
}
function banner() {
  return { root: el(), msg: el(), btn: el() };
}

const MODULES = { "app.js": app, "cost.js": cost, "zones.js": zones, "assistant.js": assistant };

// ---- mgBannerKind: classification ----

test("errors: mgBannerKind classifies 401/403 as auth, any other status as server, no status as network — same rule in all four files", () => {
  for (const [name, M] of Object.entries(MODULES)) {
    assert.strictEqual(M.mgBannerKind({ mgStatus: 401 }), "auth", name);
    assert.strictEqual(M.mgBannerKind({ mgStatus: 403 }), "auth", name);
    assert.strictEqual(M.mgBannerKind({ mgStatus: 500 }), "server", name);
    assert.strictEqual(M.mgBannerKind({ mgStatus: 400 }), "server", name);
    assert.strictEqual(M.mgBannerKind(new Error("network down")), "network", name);
    assert.strictEqual(M.mgBannerKind(null), "network", name);
    assert.strictEqual(M.mgBannerKind(undefined), "network", name);
  }
});

// ---- mgErrorBanner / mgClearBanner: DOM behaviour ----

test("errors: mgErrorBanner shows a translated message and a Retry button when a retry is offered", () => {
  for (const [name, M] of Object.entries(MODULES)) {
    const b = banner();
    let retried = 0;
    M.mgErrorBanner(b, "network", T, () => { retried++; });
    assert.strictEqual(b.root.hidden, false, name);
    assert.strictEqual(b.msg.textContent, "error.connectionLost", name);
    assert.strictEqual(b.btn.textContent, "common.retry", name);
    b.btn.onclick();
    assert.strictEqual(retried, 1, name + ": the button re-runs the failed action");

    const b2 = banner();
    M.mgErrorBanner(b2, "server", T, () => { retried++; });
    assert.strictEqual(b2.msg.textContent, "error.serverError", name);
    assert.strictEqual(b2.btn.textContent, "common.retry", name);
  }
});

test("errors: mgErrorBanner always offers Reload for an auth failure, even with a retry given — HTTP Basic has no session to resume, only a fresh request", () => {
  for (const [name, M] of Object.entries(MODULES)) {
    const before = global.window;
    let reloaded = 0;
    global.window = { location: { reload: () => { reloaded++; } } };
    try {
      const b = banner();
      let retried = 0;
      M.mgErrorBanner(b, "auth", T, () => { retried++; });
      assert.strictEqual(b.msg.textContent, "error.unauthorized", name);
      assert.strictEqual(b.btn.textContent, "common.reload", name, "Reload, not Retry, for auth");
      b.btn.onclick();
      assert.strictEqual(retried, 0, name + ": the retry callback is never called for auth");
      assert.strictEqual(reloaded, 1, name + ": the button reloads the page instead");
    } finally {
      if (before === undefined) delete global.window; else global.window = before;
    }
  }
});

test("errors: mgErrorBanner without a retry function falls back to Reload (e.g. a first load, nothing to safely retry in place)", () => {
  for (const [name, M] of Object.entries(MODULES)) {
    const before = global.window;
    let reloaded = 0;
    global.window = { location: { reload: () => { reloaded++; } } };
    try {
      const b = banner();
      M.mgErrorBanner(b, "network", T);
      assert.strictEqual(b.btn.textContent, "common.reload", name);
      b.btn.onclick();
      assert.strictEqual(reloaded, 1, name);
    } finally {
      if (before === undefined) delete global.window; else global.window = before;
    }
  }
});

test("errors: mgErrorBanner is a no-op without the three elements (e.g. index.html not loaded yet); mgClearBanner hides it again", () => {
  for (const [name, M] of Object.entries(MODULES)) {
    assert.doesNotThrow(() => M.mgErrorBanner(null, "network", T), name);
    assert.doesNotThrow(() => M.mgErrorBanner({ root: el() }, "network", T), name, "partial els: still no throw");
    assert.doesNotThrow(() => M.mgClearBanner(null), name);
    const b = banner();
    b.root.hidden = false;
    M.mgClearBanner(b);
    assert.strictEqual(b.root.hidden, true, name);
  }
});

// ---- index.html: the three shared elements exist, once, and every script reuses them ----

test("errors: index.html declares one shared banner (#mg-banner/#mg-banner-msg/#mg-banner-btn), reused by every page script", () => {
  const html = read("public/index.html");
  for (const id of ["mg-banner", "mg-banner-msg", "mg-banner-btn"]) {
    const count = (html.match(new RegExp('id="' + id + '"', "g")) || []).length;
    assert.strictEqual(count, 1, id + " must appear exactly once in index.html");
  }
  for (const file of ["public/app.js", "public/cost.js", "public/zones.js", "public/assistant.js"]) {
    const src = read(file);
    assert.ok(src.includes('getElementById("mg-banner")'), file + " reads the shared banner root");
    assert.ok(src.includes('getElementById("mg-banner-msg")'), file + " reads the shared banner message");
    assert.ok(src.includes('getElementById("mg-banner-btn")'), file + " reads the shared banner button");
  }
});

// ---- no catch block left empty, anywhere that matters ----

/** Every `catch { ... }` or `catch (e) { ... }` body in `src`, brace-matched (handles nested
    blocks — a naive non-greedy regex would stop at the first inner `}`). */
function catchBodies(src) {
  const out = [];
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push({ body: src.slice(start, i - 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("errors: no bare, unexplained catch block remains in the four page scripts", () => {
  for (const file of ["public/app.js", "public/cost.js", "public/zones.js", "public/assistant.js"]) {
    const src = read(file);
    for (const { body, line } of catchBodies(src)) {
      assert.ok(body.trim().length > 0, `${file}:${line} — empty catch block, no statement and no comment explaining why it is silent`);
    }
  }
});
