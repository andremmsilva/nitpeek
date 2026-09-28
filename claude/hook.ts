/**
 * Claude Code hook entry point.
 *
 * UserPromptExpansion (/annotate, /annotate-last): start or reuse this
 * session's review daemon, open the browser, then block the expansion (exit 2)
 * so nothing reaches the model's context. SessionEnd: stop the daemon.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE, socketPath, type DaemonConfig, type OpenRequest, type Target } from "./shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** Newest mtime of the daemon's sources: a changed checkout restarts the daemon. */
function codeStamp(): number {
  const files = [...readdirSync(here).map(f => join(here, f)), ...readdirSync(root).filter(f => f.endsWith(".ts")).map(f => join(root, f)), join(root, "form", "annotate.html"), join(root, "form", "review.js")];
  return Math.max(...files.filter(f => f.endsWith(".ts") || f.endsWith(".html") || f.endsWith(".js")).map(f => statSync(f).mtimeMs));
}

function send(sessionId: string, request: object, timeout = 8000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath(sessionId));
    let output = "";
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error("annotate daemon timed out")); });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => { output += chunk; });
    socket.on("end", () => { try { resolvePromise(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

/** The long-lived `claude` process that owns this hook (hooks run under a shell). */
function claudePid(): number | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    try {
      const [ppid, ...command] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
      if (/(^|\/)claude$/.test(command.join(" "))) return pid;
      pid = Number(ppid);
    } catch { return undefined; }
  }
  return undefined;
}

async function ensureDaemon(input: any, target: Target) {
  const stamp = codeStamp();
  try {
    const ping = await send(input.session_id, { cmd: "ping" }, 1500);
    if (ping.codeStamp === stamp) return;
    await send(input.session_id, { cmd: "stop" }, 1500).catch(() => {});
    await new Promise(r => setTimeout(r, 150));
  } catch { /* not running */ }
  mkdirSync(STORAGE, { recursive: true, mode: 0o700 });
  const config: DaemonConfig = { sessionId: input.session_id, transcriptPath: input.transcript_path, cwd: input.cwd, claudePid: claudePid(), codeStamp: stamp, target };
  const log = openSync(join(STORAGE, "daemon.log"), "a", 0o600);
  spawn(process.execPath, [join(here, "daemon.ts"), JSON.stringify(config)], { detached: true, stdio: ["ignore", log, log], cwd: root }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (existsSync(socketPath(input.session_id))) {
      try { await send(input.session_id, { cmd: "ping" }, 1000); return; } catch {}
    }
  }
  throw new Error(`annotate daemon did not start — see ${join(STORAGE, "daemon.log")}`);
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (process.env.ANNOTATE_DEBUG) writeFileSync(join(STORAGE, "last-hook.json"), raw, { mode: 0o600 });

  if (input.hook_event_name === "SessionEnd") {
    await send(input.session_id, { cmd: "stop" }, 1500).catch(() => {});
    return;
  }
  if (input.hook_event_name !== "UserPromptExpansion") return;
  const command = String(input.command_name ?? "").replace(/^\//, "");
  if (command !== "annotate" && command !== "annotate-last") return;

  const target: Target = {
    herdrPane: process.env.HERDR_PANE_ID, tmuxPane: process.env.TMUX_PANE,
    kittyWindow: process.env.KITTY_WINDOW_ID, kittyListenOn: process.env.KITTY_LISTEN_ON,
  };
  const args = String(input.command_args ?? String(input.prompt ?? "").replace(/^\/\S+/, "")).trim().replace(/^@/, "");
  const request: OpenRequest = { cmd: "open", target };
  if (command === "annotate-last") request.last = true;
  else if (args) {
    const path = resolve(input.cwd, args.startsWith("~/") ? join(process.env.HOME ?? "", args.slice(2)) : args);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    request.file = path;
  }
  await ensureDaemon(input, target);
  const reply = await send(input.session_id, request);
  if (!reply.ok) throw new Error(reply.error);
  // Exit 2 blocks the expansion: the user sees this line; the model sees nothing.
  process.stderr.write(`annotate · ${reply.message}\n`);
  process.exit(2);
}

main().catch(error => {
  process.stderr.write(`annotate · ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
