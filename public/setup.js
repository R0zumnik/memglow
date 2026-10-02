/*!
 * memglow — first-run set-up and Settings → AI settings. MIT License.
 *
 * First run (nothing finished or skipped yet): a 3-step assistant, every step can be skipped —
 *   1. AI tools        (which tools you use, and exactly how memglow sees each one)
 *   2. Assistant       (optional: off / on, one or several providers, model, address, key, test)
 *   3. Your big themes (the existing "Protected groups" screen, public/zones.js)
 * It can be run again from Settings → "First-run setup"; Settings → "AI settings" holds the same
 * choices permanently, with every provider setting, the assistant's own settings and usage.
 *
 * Saved on the memglow server (PUT /api/setup; secrets only through POST /api/setup/secret), with
 * memglow's header and the page's origin, like the saved view. A key typed here is sent once, then
 * the field is emptied: the server never sends it back (only "key: set / not set").
 * Every text from the server goes through sEsc() before innerHTML.
 */

function sEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---- i18n: same approach as zones.js — an English copy of the keys this file renders, kept in
   sync with public/i18n/en.json by a test, used outside a browser or before the language loads. */
var EN_SETUP = {
  "setup.title": "Set up memglow",
  "setup.stepOf": "Step {n} of {total}",
  "setup.next": "Next", "setup.back": "Back", "setup.skipStep": "Skip this step", "setup.skipAll": "Skip set-up",
  "setup.saving": "Saving…", "setup.saved": "Saved.", "setup.notSaved": "Not saved: {error}",
  "setup.step1": "Your AI tools",
  "setup.step1Intro": "Tick every AI tool you use (several are fine). memglow then shows how it sees each one.",
  "setup.detected": "detected",
  "setup.hookInstalled": "Hook installed by memglow init: restart {name} and its reads and writes light up live.",
  "setup.hookRun": "Run this in a terminal, then restart {name}:",
  "setup.hookDocker": "Hooks run next to {name}, on your computer, not in this container. Run this on that computer, then give the hook this memglow's address and token (MEMGLOW_URL and MEMGLOW_TOKEN, the value in your .env):",
  "setup.noToken": "Live activity is off: memglow has no MEMGLOW_TOKEN. Set one (at least 32 characters) and restart memglow.",
  "setup.chatgptHelp": "ChatGPT has no hooks. memglow still shows the changes it makes to your notes on disk. If ChatGPT reaches your notes through an MCP server, put the memglow MCP proxy in front of that server and point ChatGPT at the proxy:",
  "setup.mcpHelp": "Put the memglow MCP proxy in front of its memory MCP server (in the client's MCP settings, replace the server's command by this one). Or report activity yourself with POST /api/activity (README → Activity API).",
  "setup.step2": "Assistant (optional)",
  "setup.step2Intro": "The assistant can split large notes, regroup scattered ones and archive dormant sections. The AI only proposes; memglow shows every change and writes only what you approve, after a backup.",
  "setup.assistantOff": "Off", "setup.assistantOn": "On",
  "setup.useProvider": "Use", "setup.defaultProvider": "Default",
  "setup.notDetected": "not found here",
  "setup.model": "Model", "setup.modelDefault": "default: {model}", "setup.modelCliDefault": "your Claude Code default",
  "setup.url": "Address (URL)", "setup.preset": "Service", "setup.presetCustom": "Other (address below)",
  "setup.key": "API key", "setup.oauth": "Subscription token",
  "setup.keySet": "key: set", "setup.keyNotSet": "key: not set", "setup.keyNotNeeded": "key: not needed",
  "setup.keyFromEnv": "set by the environment variable {name}", "setup.keyFromPage": "saved from this page", "setup.keyFromFile": "from the file {name}",
  "setup.oauthCli": "no token: uses this computer's Claude Code sign-in (run `claude` once and sign in)",
  "setup.saveKey": "Save key", "setup.removeKey": "Remove key",
  "setup.keyPlaceholder": "paste it here", "setup.keySaved": "Key saved. It will never be shown again.", "setup.keyRemoved": "Key removed.",
  "setup.keyLocked": "A key can be typed here only from this computer (http://127.0.0.1), or when memglow has a password (MEMGLOW_PASSWORD) and the connection is HTTPS. Instead, set {env} in memglow's environment, or put the key alone in the file {file} of memglow's data folder (chmod 600).",
  "setup.keyLockedProxy": "This connection is not HTTPS as far as memglow can tell. Behind an HTTPS reverse proxy, set MEMGLOW_TRUST_PROXY=1 so memglow trusts its X-Forwarded-Proto header.",
  "setup.keyBadValue": "This does not look like a key (no spaces, 8 to 4096 characters).",
  "setup.oauthHelp": "Uses your Claude subscription, no API key. Where Claude Code is installed and signed in, nothing to add. In Docker or on a server: run `claude setup-token` on a computer where you are signed in, then paste the token here or set CLAUDE_CODE_OAUTH_TOKEN. memglow gives it only to the `claude` process it starts.",
  "setup.test": "Test connection", "setup.testing": "Testing…", "setup.testOk": "Connection OK ({ms} ms).", "setup.testFail": "Connection failed: {error}",
  "setup.testModels": "Models found: {list}",
  "setup.privacyLocal": "Local model: nothing leaves your machine.",
  "setup.privacyRemote": "Your notes will be sent to {dest} when you use the assistant.",
  "setup.privacyClaude": "Your notes will be sent to Anthropic, through your Claude subscription, when you use the assistant.",
  "setup.locked": "set by {name}",
  "setup.blockedBodies": "The assistant needs MEMGLOW_SHOW_BODIES on: you must see the changes before anything is written.",
  "setup.blockedData": "The assistant needs a data folder outside your notes (MEMGLOW_DATA_DIR) for its backups.",
  "setup.blockedKey": "memglow.config.json contains an API key field: remove it, keys go in the environment or a mode-600 file.",
  "setup.step3": "Your big themes",
  "setup.finish": "Finish",
  "setup.again": "First-run setup",
  "aiset.title": "AI settings",
  "aiset.intro": "Which AI the assistant uses, and how. Saved on this memglow instance; an environment variable always wins over this page, and this page over memglow.config.json.",
  "aiset.enabled": "Assistant",
  "aiset.default": "Default provider",
  "aiset.add": "Add a provider", "aiset.addBtn": "Add", "aiset.remove": "Remove this provider",
  "aiset.fromConfig": "from memglow.config.json",
  "aiset.maxTokens": "Max output tokens", "aiset.temperature": "Temperature", "aiset.timeout": "Time limit (minutes)",
  "aiset.maxBudget": "Cost cap per request (USD)", "aiset.maxBudgetHelp": "Passed to Claude Code (--max-budget-usd). Empty: no cap.",
  "aiset.confirmRemote": "Always ask before sending a note to this provider",
  "aiset.priceIn": "Price, input (USD / million tokens)", "aiset.priceOut": "Price, output (USD / million tokens)",
  "aiset.capEstimate": "At most ≈ {cost} per request for the answer ({n} output tokens at this price).",
  "aiset.capUnknown": "Set a price to see the maximum cost of an answer.",
  "aiset.tuning": "Assistant settings",
  "aiset.largeNote": "A note is too large above (tokens)", "aiset.chunk": "Size of the parts when splitting (tokens)",
  "aiset.missing": "Lines allowed to go missing in a split", "aiset.missingWarn": "Above 0, a split may drop lines of your note: memglow will still show every change before writing.",
  "aiset.backup": "Backup before writing", "aiset.backupAuto": "Automatic (git if your notes are a repository, else a copy)", "aiset.backupGit": "Git snapshot", "aiset.backupCopy": "Copy in the data folder",
  "aiset.usage": "Usage", "aiset.usageNone": "No request yet.",
  "aiset.usageRow": "{name}: {n7} requests in 7 days, {n30} in 30 days",
  "aiset.usageTokens": "≈ {inTok} tokens sent, {outTok} received (30 days)",
  "aiset.usageCost": "estimated {c7} (7 days), {c30} (30 days)",
  "aiset.usageSub": "included in your subscription", "aiset.usageLocal": "free (on this machine)", "aiset.usageNoPrice": "no price set",
  "aiset.save": "Save", "aiset.close": "Close",
  "aiset.err.secret-field": "a key can only be saved with its own “Save key” button",
  "aiset.err.destination-change-needs-local": "changing the address of a provider that has a key needs this computer, or a password and HTTPS",
  "aiset.err.assistant-busy": "the assistant is working: try again when it is done",
  "aiset.err.other": "memglow refused these values ({field})",
  "settings.aiSettings": "AI settings",
  "common.retry": "Retry", "common.reload": "Reload",
  "error.connectionLost": "Connection lost. Check your network and retry.",
  "error.unauthorized": "Unauthorized. Reload the page to sign in again.",
  "error.serverError": "Server error. Please retry."
};
function resolveTextSetup(dict, key, params) {
  var entry = dict ? dict[key] : undefined;
  if (entry === undefined || entry === null) return key;
  var str = entry;
  if (typeof entry === "object") str = entry.other || entry.one || key;
  if (typeof str !== "string") return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, function (m, name) {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
  });
}
function defaultSetupT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextSetup(EN_SETUP, key, params);
}

var SETUP_CLI = "npx github:R0zumnik/memglow init";

/** How memglow sees one AI tool: { text, code } (code = a command to copy, may be ""). */
function setupClientHelp(c, s, origin, T) {
  T = T || defaultSetupT;
  var name = c.label;
  if (c.kind === "hook") {
    if (s.docker) return { text: T("setup.hookDocker", { name: name }), code: SETUP_CLI + " --agents " + c.id + "\nMEMGLOW_URL=" + (origin || "http://127.0.0.1:4747") + "\nMEMGLOW_TOKEN=…" };
    if (c.hook) return { text: T("setup.hookInstalled", { name: name }), code: "" };
    return { text: T("setup.hookRun", { name: name }), code: SETUP_CLI + " --agents " + c.id };
  }
  if (c.id === "chatgpt") return { text: T("setup.chatgptHelp"), code: "memglow-mcp-proxy --upstream <MCP server URL> --listen 127.0.0.1:8765 --name chatgpt" };
  return { text: T("setup.mcpHelp"), code: "memglow-mcp-proxy --name <server name> -- <server command>" };
}

/** Step 1: the tools, ticked from `chosen` (else what memglow init detected), with their help. */
function setupRenderClients(s, chosen, origin, T) {
  T = T || defaultSetupT;
  var list = (s && s.clients && s.clients.list) || [];
  var ticked = chosen || (s.clients.chosen || list.filter(function (c) { return c.detected; }).map(function (c) { return c.id; }));
  var locked = s.clients.locked;
  var html = '<ul class="mg-setup__clients">' + list.map(function (c) {
    var on = ticked.indexOf(c.id) >= 0;
    var help = on ? setupClientHelp(c, s, origin, T) : null;
    return '<li class="mg-setup__client">' +
      '<label class="mg-setup__check"><input type="checkbox" name="client" value="' + sEsc(c.id) + '"' + (on ? " checked" : "") + (locked ? " disabled" : "") + '> ' + sEsc(c.label) +
      (c.detected ? ' <span class="mg-setup__tag">' + sEsc(T("setup.detected")) + '</span>' : "") + '</label>' +
      (help ? '<p class="mg-setup__help">' + sEsc(help.text) + '</p>' + (help.code ? '<pre class="mg-setup__code">' + sEsc(help.code) + '</pre>' : "") : "") +
      '</li>';
  }).join("") + '</ul>';
  if (locked) html += '<p class="mg-setup__note">' + sEsc(T("setup.locked", { name: locked })) + '</p>';
  if (!s.activityToken) html += '<p class="mg-setup__note mg-setup__note--warn">' + sEsc(T("setup.noToken")) + '</p>';
  return html;
}

function setupKeyLine(p, T) {
  if (p.key === "not needed" && p.secret === "oauth") return T("setup.oauthCli");
  if (p.key === "not needed") return T("setup.keyNotNeeded");
  if (p.key !== "set") return T("setup.keyNotSet");
  var from = p.keySource === "env" ? T("setup.keyFromEnv", { name: p.keyName }) : p.keySource === "page" ? T("setup.keyFromPage") : T("setup.keyFromFile", { name: p.keyName });
  return T("setup.keySet") + " · " + from;
}
function setupPrivacy(p, T) {
  if (p.local) return { cls: "mg-setup__privacy mg-setup__privacy--local", text: T("setup.privacyLocal") };
  if (p.id === "claude-code") return { cls: "mg-setup__privacy", text: T("setup.privacyClaude") };
  return { cls: "mg-setup__privacy", text: T("setup.privacyRemote", { dest: p.destination || "?" }) };
}
function setupNum(v) { return typeof v === "number" && isFinite(v) ? String(v) : ""; }
function setupMoney(x) {
  if (typeof x !== "number" || !isFinite(x)) return "";
  return "$" + (x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2));
}

/**
 * One provider's card. `vals` = what the form holds for it (settings), `full` = AI settings (every
 * field) rather than the first-run step. `entry` = s.secretEntry.
 */
function setupProviderFields(p, vals, entry, full, T) {
  T = T || defaultSetupT;
  vals = vals || {};
  var id = sEsc(p.id);
  var f = function (name) { return p.fields.indexOf(name) >= 0; };
  var lock = function (name) { return p.locked && p.locked[name] ? p.locked[name] : ""; };
  var input = function (name, type, extra) {
    var v = vals[name] != null ? vals[name] : "";
    var l = lock(name);
    return '<input class="mg-setup__input" type="' + type + '" data-p="' + id + '" data-f="' + name + '" value="' + sEsc(v) + '"' + (l ? " disabled" : "") + (extra || "") + '>' +
      (l ? '<span class="mg-setup__lock">' + sEsc(T("setup.locked", { name: l })) + '</span>' : "");
  };
  var out = "";
  // Model: known names offered, any valid name accepted.
  var listId = "mg-models-" + id;
  var def = p.defaults && p.defaults.model ? T("setup.modelDefault", { model: p.defaults.model }) : (p.id === "claude-code" ? T("setup.modelCliDefault") : "");
  out += '<label class="mg-setup__field"><span>' + sEsc(T("setup.model")) + '</span>' + input("model", "text", ' list="' + listId + '" maxlength="128" autocomplete="off" spellcheck="false" placeholder="' + sEsc(def) + '"') + '</label>' +
    '<datalist id="' + listId + '">' + (p.models || []).map(function (m) { return '<option value="' + sEsc(m) + '"></option>'; }).join("") + '</datalist>';
  if (f("preset")) {
    var cur = vals.baseUrl ? "" : (vals.preset || "openai");
    out += '<label class="mg-setup__field"><span>' + sEsc(T("setup.preset")) + '</span><select class="mg-setup__input" data-p="' + id + '" data-f="preset"' + (lock("preset") ? " disabled" : "") + '>' +
      p.presets.map(function (x) { return '<option value="' + sEsc(x.id) + '"' + (x.id === cur ? " selected" : "") + '>' + sEsc(x.id) + ' — ' + sEsc(x.url) + '</option>'; }).join("") +
      '<option value=""' + (cur === "" ? " selected" : "") + '>' + sEsc(T("setup.presetCustom")) + '</option></select></label>';
  }
  if (f("baseUrl")) {
    out += '<label class="mg-setup__field"><span>' + sEsc(T("setup.url")) + '</span>' + input("baseUrl", "url", ' maxlength="500" autocomplete="off" spellcheck="false" placeholder="' + sEsc(p.defaults.baseUrl || "https://…") + '"') + '</label>';
  }
  if (full) {
    if (f("maxTokens")) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.maxTokens")) + '</span>' + input("maxTokens", "number", ' min="1" max="1000000" step="1" inputmode="numeric" placeholder="' + sEsc(setupNum(p.defaults.maxTokens)) + '"') + '</label>';
    if (f("temperature") && p.temperatureSupported) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.temperature")) + '</span>' + input("temperature", "number", ' min="0" max="' + p.temperatureMax + '" step="0.1" inputmode="decimal"') + '</label>';
    if (f("timeoutMinutes")) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.timeout")) + '</span>' + input("timeoutMinutes", "number", ' min="1" max="60" step="1" inputmode="numeric" placeholder="10"') + '</label>';
    if (f("maxBudgetUsd")) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.maxBudget")) + '</span>' + input("maxBudgetUsd", "number", ' min="0.01" max="100" step="0.01" inputmode="decimal"') + '<span class="mg-setup__hint">' + sEsc(T("aiset.maxBudgetHelp")) + '</span></label>';
    if (f("priceIn")) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.priceIn")) + '</span>' + input("priceIn", "number", ' min="0" max="1000" step="0.01" inputmode="decimal" placeholder="' + sEsc(p.price ? p.price[0] : "") + '"') + '</label>';
    if (f("priceOut")) out += '<label class="mg-setup__field"><span>' + sEsc(T("aiset.priceOut")) + '</span>' + input("priceOut", "number", ' min="0" max="1000" step="0.01" inputmode="decimal" placeholder="' + sEsc(p.price ? p.price[1] : "") + '"') + '</label>';
    if (f("maxTokens") && f("priceOut")) {
      var price = typeof vals.priceOut === "number" ? vals.priceOut : p.price ? p.price[1] : null;
      var n = typeof vals.maxTokens === "number" ? vals.maxTokens : p.defaults.maxTokens;
      out += '<p class="mg-setup__hint">' + sEsc(price != null && n ? T("aiset.capEstimate", { cost: setupMoney(n * price / 1e6), n: n }) : T("aiset.capUnknown")) + '</p>';
    }
    if (f("confirmRemote")) out += '<label class="mg-setup__check"><input type="checkbox" data-p="' + id + '" data-f="confirmRemote"' + (vals.confirmRemote !== false ? " checked" : "") + '> ' + sEsc(T("aiset.confirmRemote")) + '</label>';
  }
  // Secret: typed only when allowed, never shown, saved by its own button.
  if (p.secret) {
    var label = p.secret === "oauth" ? T("setup.oauth") : T("setup.key");
    var file = p.secret === "oauth" ? "claude-code-oauth-token" : "assistant-api-key-" + p.id;
    out += '<div class="mg-setup__key">';
    if (p.secret === "oauth") out += '<p class="mg-setup__hint">' + sEsc(T("setup.oauthHelp")) + '</p>';
    out += '<p class="mg-setup__keystate" data-keystate="' + id + '">' + sEsc(setupKeyLine(p, T)) + '</p>';
    if (entry && entry.allowed) {
      out += '<label class="mg-setup__field"><span>' + sEsc(label) + '</span><input class="mg-setup__input" type="password" data-secret="' + id + '" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="' + sEsc(T("setup.keyPlaceholder")) + '"></label>' +
        '<div class="mg-setup__btns"><button type="button" class="bn-btn" data-act="save-key" data-p="' + id + '">' + sEsc(T("setup.saveKey")) + '</button>';
    } else {
      out += '<label class="mg-setup__field"><span>' + sEsc(label) + '</span><input class="mg-setup__input" type="password" disabled></label>' +
        '<p class="mg-setup__hint">' + sEsc(T("setup.keyLocked", { env: p.keyEnv, file: file })) + (entry && /not-https/.test(entry.reason || "") ? " " + sEsc(T("setup.keyLockedProxy")) : "") + '</p>' +
        '<div class="mg-setup__btns">';
    }
    if (p.key === "set" && p.keySource === "page") out += '<button type="button" class="bn-btn" data-act="remove-key" data-p="' + id + '">' + sEsc(T("setup.removeKey")) + '</button>';
    out += '</div></div>';
  }
  var pr = setupPrivacy(p, T);
  out += '<p class="' + pr.cls + '">' + sEsc(pr.text) + '</p>' +
    '<div class="mg-setup__btns"><button type="button" class="bn-btn" data-act="test" data-p="' + id + '">' + sEsc(T("setup.test")) + '</button></div>' +
    '<p class="mg-setup__status" role="status" data-test="' + id + '"></p>';
  return out;
}

/**
 * The providers block. `state` = { enabled, provider, chosen: { id: values } }. Wizard: every
 * provider can be ticked; AI settings: the configured ones, plus "Add a provider".
 */
function setupRenderProviders(s, state, full, T) {
  T = T || defaultSetupT;
  var a = s.assistant || { providers: [] };
  var out = "";
  var lockedOn = a.locked && a.locked.enabled;
  out += '<fieldset class="mg-setup__onoff"><legend>' + sEsc(full ? T("aiset.enabled") : T("setup.step2")) + '</legend>' +
    '<label class="mg-setup__check"><input type="radio" name="mg-ai-on" value="0"' + (!state.enabled ? " checked" : "") + (lockedOn ? " disabled" : "") + '> ' + sEsc(T("setup.assistantOff")) + '</label>' +
    '<label class="mg-setup__check"><input type="radio" name="mg-ai-on" value="1"' + (state.enabled ? " checked" : "") + (lockedOn ? " disabled" : "") + '> ' + sEsc(T("setup.assistantOn")) + '</label>' +
    (lockedOn ? '<span class="mg-setup__lock">' + sEsc(T("setup.locked", { name: lockedOn })) + '</span>' : "") + '</fieldset>';
  if (a.blocked) out += '<p class="mg-setup__note mg-setup__note--warn">' + sEsc(T(a.blocked === "no-bodies" ? "setup.blockedBodies" : a.blocked === "no-data-dir" ? "setup.blockedData" : "setup.blockedKey")) + '</p>';
  if (!state.enabled) return out;
  var shown = a.providers.filter(function (p) { return !full || state.chosen[p.id]; });
  out += '<ul class="mg-setup__providers">' + shown.map(function (p) {
    var on = !!state.chosen[p.id];
    var head = '<div class="mg-setup__phead">' +
      (full ? '<strong>' + sEsc(p.label) + '</strong>'
        : '<label class="mg-setup__check"><input type="checkbox" data-act="use" data-p="' + sEsc(p.id) + '"' + (on ? " checked" : "") + '> <strong>' + sEsc(p.label) + '</strong></label>') +
      (p.id === "claude-code" && !p.detected ? ' <span class="mg-setup__tag mg-setup__tag--off">' + sEsc(T("setup.notDetected")) + '</span>' : "") +
      (on ? '<label class="mg-setup__check mg-setup__default"><input type="radio" name="mg-ai-default" value="' + sEsc(p.id) + '"' + (state.provider === p.id ? " checked" : "") + (a.locked && a.locked.provider ? " disabled" : "") + '> ' + sEsc(T("setup.defaultProvider")) + '</label>' : "") +
      (full && p.source === "config" ? ' <span class="mg-setup__tag">' + sEsc(T("aiset.fromConfig")) + '</span>' : "") +
      (full && p.source !== "config" ? '<button type="button" class="bn-btn bn-btn--quiet mg-setup__remove" data-act="drop" data-p="' + sEsc(p.id) + '">' + sEsc(T("aiset.remove")) + '</button>' : "") +
      '</div>';
    var reason = on && !p.available && p.reason ? '<p class="mg-setup__note mg-setup__note--warn">' + sEsc(p.reason) + '</p>' : "";
    return '<li class="mg-setup__provider" data-provider="' + sEsc(p.id) + '">' + head + reason + (on ? setupProviderFields(p, state.chosen[p.id], s.secretEntry, full, T) : "") + '</li>';
  }).join("") + '</ul>';
  if (full) {
    var rest = a.providers.filter(function (p) { return !state.chosen[p.id]; });
    if (rest.length) {
      out += '<div class="mg-setup__add"><label class="mg-setup__field"><span>' + sEsc(T("aiset.add")) + '</span><select class="mg-setup__input" id="mg-llmset-add">' +
        rest.map(function (p) { return '<option value="' + sEsc(p.id) + '">' + sEsc(p.label) + '</option>'; }).join("") +
        '</select></label><button type="button" class="bn-btn" data-act="add">' + sEsc(T("aiset.addBtn")) + '</button></div>';
    }
  }
  return out;
}

/** Assistant settings (AI settings only). */
function setupRenderTuning(s, vals, T) {
  T = T || defaultSetupT;
  var t = s.tuning || {};
  vals = vals || t;
  var lock = t.locked && t.locked.largeNoteTokens;
  var num = function (name, min, max) {
    var dis = name === "largeNoteTokens" && lock;
    return '<input class="mg-setup__input" type="number" data-t="' + name + '" min="' + min + '" max="' + max + '" step="1" inputmode="numeric" value="' + sEsc(setupNum(vals[name])) + '"' + (dis ? " disabled" : "") + '>' +
      (dis ? '<span class="mg-setup__lock">' + sEsc(T("setup.locked", { name: lock })) + '</span>' : "");
  };
  var b = vals.backup || "auto";
  return '<fieldset class="mg-setup__tuning"><legend>' + sEsc(T("aiset.tuning")) + '</legend>' +
    '<label class="mg-setup__field"><span>' + sEsc(T("aiset.largeNote")) + '</span>' + num("largeNoteTokens", 200, 1000000) + '</label>' +
    '<label class="mg-setup__field"><span>' + sEsc(T("aiset.chunk")) + '</span>' + num("splitChunkTokens", 100, 1000000) + '</label>' +
    '<label class="mg-setup__field"><span>' + sEsc(T("aiset.missing")) + '</span>' + num("allowMissingLines", 0, 50) + '</label>' +
    (vals.allowMissingLines > 0 ? '<p class="mg-setup__note mg-setup__note--warn">' + sEsc(T("aiset.missingWarn")) + '</p>' : "") +
    '<label class="mg-setup__field"><span>' + sEsc(T("aiset.backup")) + '</span><select class="mg-setup__input" data-t="backup">' +
    [["auto", "aiset.backupAuto"], ["git", "aiset.backupGit"], ["copy", "aiset.backupCopy"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === b ? " selected" : "") + '>' + sEsc(T(o[1])) + '</option>';
    }).join("") + '</select></label></fieldset>';
}

/** Usage box: requests and estimated cost per provider (from memglow's own counts). */
function setupRenderUsage(s, T) {
  T = T || defaultSetupT;
  var u = s.usage || {};
  var labels = {};
  ((s.assistant && s.assistant.providers) || []).forEach(function (p) { labels[p.id] = p.label; });
  var ids = Object.keys(u);
  var body = ids.length ? '<ul class="mg-setup__usage">' + ids.map(function (id) {
    var r = u[id];
    var cost = r.billing === "subscription" ? T("aiset.usageSub") : r.billing === "local" ? T("aiset.usageLocal")
      : r.d7.cost == null ? T("aiset.usageNoPrice") : T("aiset.usageCost", { c7: setupMoney(r.d7.cost), c30: setupMoney(r.d30.cost) });
    return '<li>' + sEsc(T("aiset.usageRow", { name: labels[id] || id, n7: r.d7.n, n30: r.d30.n })) + ' · ' +
      sEsc(T("aiset.usageTokens", { inTok: r.d30.inTokens, outTok: r.d30.outTokens })) + ' · ' + sEsc(cost) + '</li>';
  }).join("") + '</ul>' : '<p class="mg-setup__hint">' + sEsc(T("aiset.usageNone")) + '</p>';
  return '<fieldset class="mg-setup__tuning"><legend>' + sEsc(T("aiset.usage")) + '</legend>' + body + '</fieldset>';
}

/** Form state from GET /api/setup: what is configured now (wizard: Claude Code ticked if found). */
function setupStateFrom(s, wizard) {
  var a = (s && s.assistant) || { providers: [] };
  var chosen = {};
  a.providers.forEach(function (p) {
    if (!p.configured) return;
    var v = {};
    p.fields.forEach(function (k) { if (p.settings && p.settings[k] != null) v[k] = p.settings[k]; });
    chosen[p.id] = v;
  });
  if (wizard && !Object.keys(chosen).length) {
    var cc = a.providers.filter(function (p) { return p.id === "claude-code" && p.detected; })[0];
    if (cc) chosen["claude-code"] = {};
  }
  var provider = a.provider && chosen[a.provider] ? a.provider : Object.keys(chosen)[0] || "";
  return { enabled: !!a.enabled, provider: provider, chosen: chosen };
}

/**
 * What the form holds → the body of PUT /api/setup (assistant part). `inputs` = elements with
 * data-p / data-f. Empty number = default (null), never a guess.
 */
function setupCollectProviders(state, inputs) {
  var chosen = {};
  Object.keys(state.chosen).forEach(function (id) { chosen[id] = {}; });
  Array.prototype.forEach.call(inputs || [], function (el) {
    var id = el.getAttribute("data-p"), f = el.getAttribute("data-f");
    if (!id || !f || !chosen[id] || el.disabled) return;
    if (f === "confirmRemote") { chosen[id].confirmRemote = !!el.checked; return; }
    var raw = String(el.value == null ? "" : el.value).trim();
    if (f === "model" || f === "baseUrl") { chosen[id][f] = raw || null; return; }
    if (f === "preset") { chosen[id].preset = raw || null; return; }
    if (raw === "") { chosen[id][f] = null; return; }
    var n = Number(raw);
    chosen[id][f] = isFinite(n) ? n : raw; // a bad value goes to the server, which refuses it plainly
  });
  Object.keys(chosen).forEach(function (id) {
    if (chosen[id].preset === null && !chosen[id].baseUrl) delete chosen[id].preset;
    if (chosen[id].preset && chosen[id].baseUrl === null) delete chosen[id].baseUrl;
  });
  return { enabled: !!state.enabled, provider: state.provider && chosen[state.provider] ? state.provider : (Object.keys(chosen)[0] || ""), providers: chosen };
}
function setupCollectTuning(inputs) {
  var out = {};
  Array.prototype.forEach.call(inputs || [], function (el) {
    var k = el.getAttribute("data-t");
    if (!k || el.disabled) return;
    var raw = String(el.value == null ? "" : el.value).trim();
    if (k === "backup") { out.backup = raw || "auto"; return; }
    out[k] = raw === "" ? null : Number(raw);
  });
  return out;
}
/** A refused save, in words (the error code only, never a value). */
function setupErrorText(err, T) {
  T = T || defaultSetupT;
  var code = err && err.error ? String(err.error) : "";
  var key = "aiset.err." + code;
  if (Object.prototype.hasOwnProperty.call(EN_SETUP, key)) return T(key);
  return T("aiset.err.other", { field: (err && err.field) || code || "?" });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sEsc: sEsc, EN_SETUP: EN_SETUP, resolveTextSetup: resolveTextSetup, defaultSetupT: defaultSetupT,
    setupClientHelp: setupClientHelp, setupRenderClients: setupRenderClients, setupProviderFields: setupProviderFields,
    setupRenderProviders: setupRenderProviders, setupRenderTuning: setupRenderTuning, setupRenderUsage: setupRenderUsage,
    setupStateFrom: setupStateFrom, setupCollectProviders: setupCollectProviders, setupCollectTuning: setupCollectTuning,
    setupErrorText: setupErrorText, setupKeyLine: setupKeyLine, setupPrivacy: setupPrivacy,
  };
}

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  var wiz = document.getElementById("mg-setup");
  var tile = document.getElementById("mg-llmset");
  if (!wiz || !tile) return;
  var api = wiz.getAttribute("data-api");
  var T = defaultSetupT;
  var cfg = {};
  try { cfg = JSON.parse(document.getElementById("memglow-config").textContent); } catch (e) { cfg = {}; }
  var origin = window.location ? window.location.origin : "";
  var banner = { root: document.getElementById("mg-banner"), msg: document.getElementById("mg-banner-msg"), btn: document.getElementById("mg-banner-btn") };
  var s = null;              // last GET /api/setup
  var step = 1;              // wizard step
  var clientsTicked = null;  // wizard step 1
  var wState = null, aState = null; // provider forms: wizard, AI settings
  var tuning = null;
  var reloadAfter = false;   // the assistant was turned on or off: the page must be reloaded

  var el = function (id) { return document.getElementById(id); };
  function req(method, url, body) {
    return fetch(url, {
      method: method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json", "X-Memglow": "1" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(String(r.status)); e.mgStatus = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }
  function fail(statusEl, err) {
    if (err && (err.mgStatus === 401 || err.mgStatus === 403) && !(err.body && err.body.error && err.body.error !== "forbidden")) {
      if (typeof mgErrorBanner === "function") mgErrorBanner(banner, "auth", T);
    }
    if (statusEl) {
      statusEl.textContent = T("setup.notSaved", { error: err && err.body && err.body.error ? setupErrorText(err.body, T) : (err && err.mgStatus ? "HTTP " + err.mgStatus : T("error.connectionLost")) });
      statusEl.className = statusEl.className.replace(/ ?mg-setup__status--bad/g, "") + " mg-setup__status--bad";
    }
  }
  function say(statusEl, text) { if (statusEl) { statusEl.textContent = text; statusEl.className = statusEl.className.replace(/ ?mg-setup__status--bad/g, ""); } }

  // ---- wizard ----
  function renderWizard() {
    el("mg-setup-step").textContent = T("setup.stepOf", { n: step, total: 3 });
    el("mg-setup-steptitle").textContent = T(step === 1 ? "setup.step1" : "setup.step2");
    el("mg-setup-intro").textContent = T(step === 1 ? "setup.step1Intro" : "setup.step2Intro");
    el("mg-setup-body").innerHTML = step === 1 ? setupRenderClients(s, clientsTicked, origin, T) : setupRenderProviders(s, wState, false, T);
    el("mg-setup-back").hidden = step === 1;
    el("mg-setup-next").textContent = T(step === 2 ? "setup.finish" : "setup.next");
  }
  function wizardClients() {
    var out = [];
    Array.prototype.forEach.call(el("mg-setup-body").querySelectorAll('input[name="client"]'), function (b) { if (b.checked) out.push(b.value); });
    return out;
  }
  function saveWizardStep() {
    if (step === 1) {
      clientsTicked = wizardClients();
      if (s.clients.locked) return Promise.resolve();
      return req("PUT", api, { clients: clientsTicked }).then(function (j) { s = j; });
    }
    var wasOn = !!s.assistant.enabled;
    var body = setupCollectProviders(wState, el("mg-setup-body").querySelectorAll("[data-p][data-f]"));
    return req("PUT", api, { assistant: body }).then(function (j) {
      if (!!j.assistant.enabled !== wasOn) reloadAfter = true;
      s = j;
    });
  }
  function finishWizard() {
    return req("PUT", api, { wizardDone: true }).then(function () {
      wiz.hidden = true;
      // Step 3: the existing "What are your big themes?" screen (public/zones.js).
      document.dispatchEvent(new CustomEvent("memglow:zones-open", { detail: { step: 3 } }));
    });
  }
  el("mg-setup-next").addEventListener("click", function () {
    var st = el("mg-setup-status");
    say(st, T("setup.saving"));
    saveWizardStep().then(function () {
      say(st, "");
      if (step === 1) { step = 2; renderWizard(); return; }
      return finishWizard();
    }).catch(function (e) { fail(st, e); });
  });
  el("mg-setup-skip").addEventListener("click", function () {
    if (step === 1) { step = 2; renderWizard(); return; }
    finishWizard().catch(function (e) { fail(el("mg-setup-status"), e); });
  });
  el("mg-setup-back").addEventListener("click", function () { step = 1; renderWizard(); });
  el("mg-setup-skipall").addEventListener("click", function () {
    req("PUT", api, { wizardDone: true }).then(function () { wiz.hidden = true; }).catch(function (e) { fail(el("mg-setup-status"), e); });
  });
  el("mg-setup-body").addEventListener("change", function (e) {
    var t = e.target;
    if (!t) return;
    if (t.name === "client") { clientsTicked = wizardClients(); renderWizard(); return; }
    if (handleProviderChange(t, wState, "mg-setup-body")) renderWizard();
  });
  el("mg-setup-body").addEventListener("click", function (e) { handleProviderClick(e, wState, "mg-setup-body", true); });

  // ---- shared provider handlers ----
  function keepTyped(state, bodyId) {
    // What was typed in the cards, before a redraw.
    var cur = setupCollectProviders(state, el(bodyId).querySelectorAll("[data-p][data-f]"));
    Object.keys(cur.providers).forEach(function (id) {
      var v = cur.providers[id];
      Object.keys(v).forEach(function (k) { if (v[k] == null) delete v[k]; });
      state.chosen[id] = v;
    });
  }
  function handleProviderChange(t, state, bodyId) {
    if (t.name === "mg-ai-on") { keepTyped(state, bodyId); state.enabled = t.value === "1"; return true; }
    if (t.name === "mg-ai-default") { state.provider = t.value; return false; }
    var act = t.getAttribute && t.getAttribute("data-act");
    if (act === "use") {
      keepTyped(state, bodyId);
      var id = t.getAttribute("data-p");
      if (t.checked) state.chosen[id] = state.chosen[id] || {};
      else delete state.chosen[id];
      if (!state.chosen[state.provider]) state.provider = Object.keys(state.chosen)[0] || "";
      return true;
    }
    if (t.getAttribute && t.getAttribute("data-f") === "preset") { keepTyped(state, bodyId); return true; }
    return false;
  }
  function handleProviderClick(e, state, bodyId, wizard) {
    var b = e.target && e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!b) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-p");
    var st = el(bodyId).querySelector('[data-test="' + id + '"]');
    if (act === "save-key") {
      var input = el(bodyId).querySelector('input[data-secret="' + id + '"]');
      var v = input ? String(input.value || "").trim() : "";
      if (v.length < 8 || /\s/.test(v)) { say(st, T("setup.keyBadValue")); return; }
      say(st, T("setup.saving"));
      req("POST", api + "/secret", { provider: id, secret: v }).then(function (j) {
        input.value = ""; v = "";
        say(st, T("setup.keySaved"));
        var line = el(bodyId).querySelector('[data-keystate="' + id + '"]');
        var row = s.assistant.providers.filter(function (p) { return p.id === id; })[0];
        if (row) { row.key = j.key; row.keySource = j.keySource; row.keyName = j.keyName; if (line) line.textContent = setupKeyLine(row, T); }
      }).catch(function (err) { if (input) input.value = ""; fail(st, err); });
    } else if (act === "remove-key") {
      req("POST", api + "/secret", { provider: id, remove: true }).then(function (j) {
        say(st, T("setup.keyRemoved"));
        var row = s.assistant.providers.filter(function (p) { return p.id === id; })[0];
        if (row) { row.key = j.key; row.keySource = j.keySource; row.keyName = j.keyName; }
        var line = el(bodyId).querySelector('[data-keystate="' + id + '"]');
        if (line && row) line.textContent = setupKeyLine(row, T);
        b.hidden = true;
      }).catch(function (err) { fail(st, err); });
    } else if (act === "test") {
      // The test uses the settings in effect: save the form first.
      say(st, T("setup.testing"));
      var body = setupCollectProviders(state, el(bodyId).querySelectorAll("[data-p][data-f]"));
      body.enabled = state.enabled;
      req("PUT", api, { assistant: body }).then(function (j) {
        if (!!j.assistant.enabled !== !!s.assistant.enabled) reloadAfter = true;
        s = j;
        return req("POST", api + "/test", { provider: id });
      }).then(function (r) {
        var text = r.ok ? T("setup.testOk", { ms: r.ms }) : T("setup.testFail", { error: r.error || "?" });
        if (r.models && r.models.length) text += " " + T("setup.testModels", { list: r.models.slice(0, 12).join(", ") });
        say(st, text);
        if (!r.ok) st.className += " mg-setup__status--bad";
      }).catch(function (err) { fail(st, err); });
    } else if (act === "drop") {
      keepTyped(state, bodyId);
      delete state.chosen[id];
      if (state.provider === id) state.provider = Object.keys(state.chosen)[0] || "";
      renderAiset();
    } else if (act === "add") {
      keepTyped(state, bodyId);
      var sel = el("mg-llmset-add");
      if (sel && sel.value) { state.chosen[sel.value] = {}; if (!state.provider) state.provider = sel.value; }
      renderAiset();
    }
  }

  // ---- AI settings ----
  function renderAiset() {
    el("mg-llmset-body").innerHTML = setupRenderProviders(s, aState, true, T) + setupRenderTuning(s, tuning, T) + setupRenderUsage(s, T);
  }
  el("mg-llmset-body").addEventListener("change", function (e) {
    var t = e.target;
    if (!t) return;
    if (t.getAttribute && t.getAttribute("data-t")) {
      if (t.getAttribute("data-t") === "allowMissingLines") { tuning = Object.assign({}, tuning, setupCollectTuning(el("mg-llmset-body").querySelectorAll("[data-t]"))); keepTyped(aState, "mg-llmset-body"); renderAiset(); }
      return;
    }
    if (handleProviderChange(t, aState, "mg-llmset-body")) renderAiset();
  });
  el("mg-llmset-body").addEventListener("click", function (e) { handleProviderClick(e, aState, "mg-llmset-body", false); });
  el("mg-llmset-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var st = el("mg-llmset-status");
    say(st, T("setup.saving"));
    var wasOn = !!s.assistant.enabled;
    var body = { assistant: setupCollectProviders(aState, el("mg-llmset-body").querySelectorAll("[data-p][data-f]")), tuning: setupCollectTuning(el("mg-llmset-body").querySelectorAll("[data-t]")) };
    req("PUT", api, body).then(function (j) {
      s = j;
      aState = setupStateFrom(s, false);
      tuning = null;
      renderAiset();
      say(st, T("setup.saved"));
      if (!!j.assistant.enabled !== wasOn || reloadAfter) setTimeout(function () { window.location.reload(); }, 600);
    }).catch(function (err) { fail(st, err); });
  });
  el("mg-llmset-close").addEventListener("click", function () {
    tile.hidden = true;
    if (reloadAfter) window.location.reload();
  });

  function load() {
    return req("GET", api).then(function (j) { s = j; if (typeof mgClearBanner === "function") mgClearBanner(banner); return j; });
  }
  function openWizard() {
    load().then(function () {
      step = 1; clientsTicked = null; wState = setupStateFrom(s, true);
      wiz.hidden = false;
      renderWizard();
      if (wiz.scrollIntoView) wiz.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) { fail(null, e); });
  }
  function openAiset() {
    load().then(function () {
      aState = setupStateFrom(s, false); tuning = null;
      tile.hidden = false;
      renderAiset();
      say(el("mg-llmset-status"), "");
      if (tile.scrollIntoView) tile.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) { fail(el("mg-llmset-status"), e); });
  }
  var again = el("mem-setup-again"), open = el("mem-llmset");
  // Opened from Settings: close the options (a bottom sheet on a phone) so the tile is in view.
  var closeOptions = function () { var o = el("mem-options"); if (o && o.open) o.open = false; };
  if (again) again.addEventListener("click", function () { closeOptions(); openWizard(); });
  if (open) open.addEventListener("click", function () { closeOptions(); openAiset(); });
  // The zones screen of step 3 was saved or closed: reload if the assistant was turned on or off.
  document.addEventListener("memglow:zones-done", function () { if (reloadAfter) window.location.reload(); });
  document.addEventListener("memglow:language", function () {
    if (!s) return;
    if (!wiz.hidden) { if (step === 1) clientsTicked = wizardClients(); else keepTyped(wState, "mg-setup-body"); renderWizard(); }
    if (!tile.hidden) { keepTyped(aState, "mg-llmset-body"); tuning = Object.assign({}, tuning, setupCollectTuning(el("mg-llmset-body").querySelectorAll("[data-t]"))); renderAiset(); }
  });
  if (cfg.setupPending) openWizard();
})();
