#!/usr/bin/env node
"use strict";
/**
 * memglow command line.
 *
 *   memglow                       start the viewer (same as `memglow serve`)
 *   memglow init [options]        set memglow up for your notes and your AI tools
 *   memglow uninstall [options]   remove what `init` added
 *   memglow memory-server [opts]  the memglow memory server (preview, read-only) — see
 *                                 memory-server/memglow-memory-server.js
 *
 * Works straight from GitHub while the npm package is not published:
 *   npx github:R0zumnik/memglow init
 */
const os = require("os");
const path = require("path");
const readline = require("readline");

const HELP = `memglow — a live 3D view of your AI assistant's Markdown memory

usage:
  memglow [serve]                start the viewer (http://127.0.0.1:4747 by default)
  memglow init [options]         configure memglow and the hooks of your AI tools
  memglow uninstall [options]    remove the hooks and MCP wrappings added by init
  memglow memory-server [opts]   MCP memory server over your notes (preview, read-only):
                                 --root DIR --listen HOST:PORT | --stdio  (see --help)

init options:
  --yes, -y           non-interactive: accept every proposal
  --dir <folder>      notes folder (default: detected basic-memory project or Obsidian vault)
  --port <n>          viewer port (default 4747)
  --agents <list>     comma-separated: claude-code,codex,gemini,cursor,windsurf,copilot,cline
                      or "all" (default: every detected tool) or "none"
  --clients <list>    the AI tools you use (also chatgpt, other-mcp), saved for the page;
                      asked when interactive
  --wrap-mcp          also wrap Claude Desktop's memory MCP servers with the memglow proxy
  --write-rules       add memglow's built-in memory rules to CLAUDE.md/AGENTS.md/GEMINI.md/…
                      for the tools installed this run that do not go through the MCP proxy
                      (asked, default yes, when interactive; with --yes, only with this flag)
  --docker            also write ~/.memglow/docker-compose.yml and .env
  --home <folder>     home folder to configure (default: yours)

uninstall options:
  --restore-backups   put the original config files back instead of removing only our entries
  --purge             also delete ~/.memglow (token, config)
  --home <folder>
`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--wrap-mcp") o.wrapMcp = true;
    else if (a === "--write-rules") o.writeRules = true;
    else if (a === "--docker") o.docker = true;
    else if (a === "--restore-backups") o.restoreBackups = true;
    else if (a === "--purge") o.purge = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (["--dir", "--port", "--agents", "--home", "--clients"].includes(a)) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

function asker(yes) {
  if (yes || !process.stdin.isTTY) return async () => true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(`${q} [Y/n] `, (a) => r(!/^n/i.test(a.trim()))));
  ask.close = () => rl.close();
  return ask;
}

/**
 * Terminal questions for the first-run choices (same as the page's set-up). `io` = { text(q, def)
 * → answer, hidden(q) → answer typed without echo, yesNo(q, def) → bool, log(line) }. A key is
 * NEVER read with echo: hidden() masks it; with --docker no key is asked at all (it would not reach
 * the container) — the .env gets the variable, commented out, instead.
 */
async function askChoices(io, { detected, docker }) {
  const { CLIENTS } = require("../lib/clients");
  io.log("\nWhich AI tools do you use? (several are fine; memglow shows how it sees each one)");
  CLIENTS.forEach((c, i) => io.log(`  ${i + 1}. ${c.label}${detected.includes(c.id) ? " (detected)" : ""}`));
  const def = CLIENTS.map((c, i) => (detected.includes(c.id) ? i + 1 : 0)).filter(Boolean).join(",");
  const pick = (answer, list) => String(answer || "").split(/[\s,]+/).filter(Boolean)
    .map((x) => (/^\d+$/.test(x) ? list[Number(x) - 1] : list.find((c) => c.id === x)))
    .filter(Boolean).map((c) => c.id);
  const ans = await io.text("Numbers or names, comma-separated", def || "none");
  const clients = /^none$/i.test(String(ans).trim()) ? [] : [...new Set(pick(ans, CLIENTS))];

  if (!(await io.yesNo("\nTurn on the optional assistant (the AI proposes, memglow shows the diff and writes what you approve)?", false))) {
    return { clients, assistant: { enabled: false }, secrets: {} };
  }
  const setup = require("../lib/setup");
  const claude = require("../lib/assistant/providers/claude-code").detect({}).detected;
  const PROV = [
    { id: "claude-code", label: "Claude Code subscription (no API key)" + (claude ? " (detected)" : "") },
    { id: "anthropic", label: "Anthropic API (your API key)" },
    { id: "openai-compatible", label: "OpenAI-compatible API (OpenAI, Mistral, OpenRouter; your API key)" },
    { id: "ollama", label: "Ollama on this machine (nothing leaves it)" },
    { id: "lmstudio", label: "LM Studio on this machine (nothing leaves it)" },
  ];
  io.log("Providers (one or several; the first is the default):");
  PROV.forEach((x, i) => io.log(`  ${i + 1}. ${x.label}`));
  const chosen = [...new Set(pick(await io.text("Numbers or names, comma-separated", claude ? "1" : "4"), PROV))];
  const providers = {}, secrets = {};
  for (const id of chosen) {
    const fields = {};
    const defModel = id === "anthropic" ? "claude-sonnet-5-5" : id === "claude-code" ? "" : id === "ollama" ? "llama3.1" : "";
    for (;;) {
      const m = String(await io.text(`${id}: model${id === "claude-code" ? " (opus, sonnet, haiku, fable… or a full id; empty = your Claude Code default)" : ""}`, defModel)).trim();
      if (!m || setup.validModel(id, m)) { if (m) fields.model = m; break; }
      io.log("  not a valid model name for this provider, try again");
    }
    if (id === "openai-compatible") {
      const preset = String(await io.text("openai-compatible: service (openai, mistral, openrouter) or an https:// address", "openai")).trim();
      if (/^https?:\/\//.test(preset)) fields.baseUrl = preset; else fields.preset = preset || "openai";
    }
    const v = setup.validateProvider(id, fields);
    if (!v.ok) { io.log(`  ${id}: ${v.error} (${v.field}) — skipped, set it later in the page`); continue; }
    providers[id] = v.value;
    const secretName = setup.secretFile(id);
    if (!secretName) continue;
    const envName = id === "claude-code" ? "CLAUDE_CODE_OAUTH_TOKEN" : require("../lib/assistant/providers/http").providerKeyEnv(id);
    if (docker) { io.log(`  ${id}: put the ${id === "claude-code" ? "token from \`claude setup-token\`" : "API key"} in ~/.memglow/.env (${envName}, written commented out), or type it in the page from http://127.0.0.1.`); continue; }
    if (id === "claude-code") { io.log("  claude-code: uses this computer's Claude Code sign-in; nothing to type here."); continue; }
    const key = String(await io.hidden(`  ${id}: API key (hidden; Enter to skip and set ${envName} or use the page later): `) || "").trim();
    if (!key) continue;
    if (!setup.validSecret(key)) { io.log("  that does not look like a key (no spaces, 8 to 4096 characters): skipped"); continue; }
    secrets[id] = key;
  }
  const ids = Object.keys(providers);
  return { clients, assistant: { enabled: ids.length > 0, provider: ids[0] || "", providers }, secrets };
}

/** Real terminal questions: readline, and a no-echo reader for keys. */
function terminalIo() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
  // While a key is typed, nothing it contains is echoed (not even as stars).
  if (write) rl._writeToOutput = (str) => { if (!muted || /^\r?\n$/.test(str)) write(str); };
  return {
    text: (q, def) => new Promise((r) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => r(a.trim() || def || ""))),
    yesNo: (q, def) => new Promise((r) => rl.question(`${q} [${def ? "Y/n" : "y/N"}] `, (a) => r(a.trim() ? /^y/i.test(a.trim()) : !!def))),
    hidden: (q) => new Promise((r) => {
      if (!write) return r(""); // cannot mask: never read a key with echo
      process.stdout.write(q);
      muted = true;
      rl.question("", (a) => { muted = false; process.stdout.write("\n"); r(a); });
    }),
    log: (line) => console.log(line),
    close: () => rl.close(),
  };
}

async function cmdInit(o, io) {
  const installer = require("../lib/installer");
  const home = path.resolve(o.home || os.homedir());
  const interactive = !!io || (!o.yes && process.stdin.isTTY);
  // One readline for every question when interactive (yes/no ones included).
  if (interactive && !io) io = terminalIo();
  const confirm = interactive ? Object.assign((q) => io.yesNo(q, true), { close: () => io.close && io.close() }) : asker(o.yes);
  let dir = o.dir;
  if (!dir) {
    const found = installer.detectNotes(home);
    if (found.length) {
      dir = found[0].dir;
      console.log(`notes folder: ${dir} (${found[0].from})`);
      if (!(await confirm("Use this folder?"))) { console.log("Pass the right one with --dir <folder>."); confirm.close && confirm.close(); return 1; }
    }
  }
  const agents = !o.agents || o.agents === "all" ? "all" : o.agents === "none" ? "none" : o.agents.split(",").map((s) => s.trim());
  let wrapMcp = !!o.wrapMcp;
  if (!wrapMcp && interactive) wrapMcp = true; // interactive: it will be asked
  let writeRules = !!o.writeRules;
  if (!writeRules && interactive) writeRules = true; // interactive: it will be asked (default yes)
  try {
    // The first-run choices (also offered by the page): asked when interactive; --clients sets the
    // tools without asking; --yes keeps the previous behaviour (nothing asked, nothing written).
    let choices = {};
    if (o.clients) choices.clients = o.clients === "none" ? [] : o.clients.split(",").map((x) => x.trim());
    else if (interactive) choices = await askChoices(io, { detected: installer.detectAgents(home).map((a) => a.id), docker: !!o.docker });
    const r = await installer.init({ home, dir, port: o.port, agents, wrapMcp, writeRules, docker: o.docker, confirm, clients: choices.clients, assistant: choices.assistant, secrets: choices.secrets });
    console.log(`\nmemglow is set up for ${r.notes}`);
    console.log(`  config and token: ${path.join(home, ".memglow")}`);
    for (const a of r.agents) console.log(`  ✓ ${a.id}: ${a.file}`);
    for (const s of r.skipped) console.log(`  – ${s.id}: ${s.why}`);
    for (const m of r.mcp) console.log(`  ✓ MCP proxy in front of ${m}`);
    for (const rr of r.rules) console.log(`  ✓ memory rules added to ${rr.file}`);
    if (!r.agents.length && !r.skipped.length) console.log("  no AI tool detected: file changes are still picked up live (see README).");
    if (r.clients) console.log(`  AI tools: ${r.clients.join(", ") || "none"} (change them in the page: Settings → First-run setup)`);
    if (r.assistant) console.log(`  assistant: ${r.assistant.enabled ? "on, " + Object.keys(r.assistant.providers).join(", ") : "off"} (Settings → AI settings)`);
    for (const id of r.secrets) console.log(`  key for ${id}: saved in ${path.join(home, ".memglow")} (mode 600), never shown again`);
    if (r.docker) console.log(`  docker: docker compose -f ${path.join(home, ".memglow", "docker-compose.yml")} up -d`);
    console.log("\nStart the viewer with `memglow` (or `npx github:R0zumnik/memglow`), then restart your AI tools.");
    console.log("Undo everything with `memglow uninstall`.");
    return 0;
  } catch (e) {
    console.error(`memglow init: ${e.message}`);
    return 1;
  } finally { confirm.close && confirm.close(); }
}

function cmdUninstall(o) {
  const home = path.resolve(o.home || os.homedir());
  const r = require("../lib/installer").uninstall({ home, restoreBackups: o.restoreBackups, purge: o.purge });
  for (const f of r.cleaned) console.log(`  removed memglow from ${f}`);
  for (const f of r.restored) console.log(`  restored ${f} from its backup`);
  for (const m of r.mcp) console.log(`  unwrapped MCP server ${m}`);
  if (!r.cleaned.length && !r.restored.length && !r.mcp.length) console.log("nothing to remove.");
  return 0;
}

async function run(argv = process.argv.slice(2)) {
  // Its own options (--root, --listen, --stdio…): handed over untouched.
  if (argv[0] === "memory-server") return require("../memory-server/memglow-memory-server").main(argv.slice(1));
  const o = parse(argv);
  const cmd = o._[0] || "serve";
  if (o.help || cmd === "help") { process.stdout.write(HELP); return 0; }
  if (cmd === "serve") { require("../server").main(); return null; }
  if (cmd === "init") return cmdInit(o);
  if (cmd === "uninstall") return cmdUninstall(o);
  process.stderr.write(`memglow: unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

if (require.main === module) run().then((code) => { if (code != null) process.exitCode = code; });

module.exports = { run, parse, cmdInit, askChoices };
