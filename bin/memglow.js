#!/usr/bin/env node
"use strict";
/**
 * memglow command line.
 *
 *   memglow                       start the viewer (same as `memglow serve`)
 *   memglow init [options]        set memglow up for your notes and your AI tools
 *   memglow uninstall [options]   remove what `init` added
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

init options:
  --yes, -y           non-interactive: accept every proposal
  --dir <folder>      notes folder (default: detected basic-memory project or Obsidian vault)
  --port <n>          viewer port (default 4747)
  --agents <list>     comma-separated: claude-code,codex,gemini,cursor,windsurf,copilot,cline
                      or "all" (default: every detected tool) or "none"
  --wrap-mcp          also wrap Claude Desktop's memory MCP servers with the memglow proxy
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
    else if (a === "--docker") o.docker = true;
    else if (a === "--restore-backups") o.restoreBackups = true;
    else if (a === "--purge") o.purge = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (["--dir", "--port", "--agents", "--home"].includes(a)) o[a.slice(2)] = argv[++i];
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

async function cmdInit(o) {
  const installer = require("../lib/installer");
  const home = path.resolve(o.home || os.homedir());
  const confirm = asker(o.yes);
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
  if (!wrapMcp && !o.yes && process.stdin.isTTY) wrapMcp = true; // interactive: it will be asked
  try {
    const r = await installer.init({ home, dir, port: o.port, agents, wrapMcp, docker: o.docker, confirm });
    console.log(`\nmemglow is set up for ${r.notes}`);
    console.log(`  config and token: ${path.join(home, ".memglow")}`);
    for (const a of r.agents) console.log(`  ✓ ${a.id}: ${a.file}`);
    for (const s of r.skipped) console.log(`  – ${s.id}: ${s.why}`);
    for (const m of r.mcp) console.log(`  ✓ MCP proxy in front of ${m}`);
    if (!r.agents.length && !r.skipped.length) console.log("  no AI tool detected: file changes are still picked up live (see README).");
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

module.exports = { run, parse };
