"use strict";
/**
 * Shared plumbing of the command-line providers: find a binary on PATH, run it WITHOUT a shell
 * (arguments as an array, the prompt on stdin), stream its output through a parser, stop it
 * cleanly (SIGTERM to its process group, SIGKILL 5 s later) on timeout or cancel.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/** Absolute path of an executable named `name` on PATH (or `name` itself if it is a path), or null. */
function which(name, env = process.env) {
  if (!name || typeof name !== "string") return null;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  const ok = (f) => {
    try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
  };
  if (name.includes("/") || name.includes("\\")) return ok(path.resolve(name)) ? path.resolve(name) : null;
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const f = path.join(dir, name + e);
      if (ok(f)) return f;
    }
  }
  return null;
}

/** Environment for a child: the user's, minus memglow's own secrets. */
function childEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^MEMGLOW_(TOKEN|PASSWORD)$/.test(k)) delete out[k];
  return out;
}

const live = new Set();
process.once("exit", () => { for (const p of live) killTree(p, "SIGKILL"); });
function killTree(p, sig) {
  try {
    if (process.platform !== "win32" && p.pid) process.kill(-p.pid, sig);
    else p.kill(sig);
  } catch { try { p.kill(sig); } catch { /* already gone */ } }
}

/**
 * Runs `bin args` with `stdin` as input. `parser` = { push(chunk) → events, end() → events }, events
 * { type: "text", text } | { type: "tool", name } | { type: "result", ok, text, error }.
 * Resolves { ok, text, error, code, tools } — `text` is the final answer (result event, else the
 * streamed text). Never rejects.
 */
function runCli({ bin, args, cwd, env, stdin, parser, onText, timeoutMs, signal, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, { cwd, env: childEnv(env || process.env), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: "could not start: " + e.code });
      return;
    }
    live.add(p);
    let streamed = "", result = null, error = "", size = 0, done = false;
    const tools = [];
    let killTimer = null;
    const stop = (why) => {
      if (done) return;
      if (!error) error = why;
      killTree(p, "SIGTERM");
      killTimer = setTimeout(() => killTree(p, "SIGKILL"), 5000);
      if (killTimer.unref) killTimer.unref();
    };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    const onAbort = () => stop("cancelled");
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    const handle = (events) => {
      for (const e of events) {
        if (e.type === "text") {
          streamed += e.text;
          if (onText) onText(e.text);
        } else if (e.type === "tool") {
          tools.push(e.name);
        } else if (e.type === "result") {
          result = e;
        }
      }
    };
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      size += Buffer.byteLength(d);
      if (size > maxBytes) { stop("answer too large"); return; }
      handle(parser.push(d));
    });
    let stderr = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.on("error", (e) => { if (!error) error = "could not start: " + (e.code || "error"); });
    p.stdin.on("error", () => { /* the child may exit before reading everything */ });
    p.stdin.end(stdin || "");
    p.on("close", (code) => {
      done = true;
      live.delete(p);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      handle(parser.end());
      if (!error && tools.length) error = "the AI tried to use a tool (" + tools[0] + "); memglow gives it none";
      if (!error && result && !result.ok) error = result.error || "error";
      if (!error && code !== 0) error = "exited with code " + code;
      const text = result && result.text ? result.text : streamed;
      resolve({ ok: !error, text, error, code, tools, stderrTail: error ? stderr.slice(-300) : "" });
    });
  });
}

module.exports = { which, runCli, childEnv };
