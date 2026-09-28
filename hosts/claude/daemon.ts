/**
 * One background review server per Claude Code session.
 *
 * Started by hook.ts on the first /annotate. It follows the session transcript
 * into a ReviewStore, serves the nitpeek UI, and on Done pastes the notes into
 * Claude's prompt without submitting them. Exits on SessionEnd, or when the
 * owning Claude process is gone.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ReviewStore } from "../../core/store.js";
import { NITPEEK_HOME, blobStore, startWorkspace, type Target as Focus } from "../../core/workspace.js";
import { sweep } from "../../core/retention.js";
import { capture, deliver, run } from "./paste.js";
import { STORAGE, sessionKey, socketPath, type DaemonConfig, type OpenRequest, type Target } from "./shared.js";
import { TranscriptFeed, type TailState } from "./transcript.js";

async function main() {
  const config: DaemonConfig = JSON.parse(process.argv[2]);
  let target: Target = config.target;
  const key = sessionKey(config.sessionId);
  mkdirSync(STORAGE, { recursive: true, mode: 0o700 });
  const tailPath = join(STORAGE, key + ".tail.json");
  try { sweep(NITPEEK_HOME); } catch (error) { console.error("sweep failed:", error); }
  const store = new ReviewStore(config.cwd, join(STORAGE, key + ".json"), config.sessionId, blobStore());
  let tail: TailState | undefined;
  try { tail = JSON.parse(readFileSync(tailPath, "utf8")); } catch {}
  const feed = new TranscriptFeed(store, config.transcriptPath, tail);
  const saveTail = () => {
    writeFileSync(tailPath + ".tmp", JSON.stringify(feed.tail), { mode: 0o600 });
    renameSync(tailPath + ".tmp", tailPath);
  };
  const poll = () => { if (feed.poll()) saveTail(); };
  poll();
  feed.flush();

  const workspace = await startWorkspace(store, {
    name: "Claude",
    deliveryNote: () => target.herdrPane || target.tmuxPane || target.kittyWindow
      ? "The notes will be pasted into Claude’s prompt at the cursor. Nothing is sent."
      : "The notes will be copied to the clipboard. Nothing is sent.",
    deliver: feedback => deliver(target, feedback),
  });

  async function open(request: OpenRequest) {
    target = request.target ?? target;
    poll(); feed.flush();
    const focus: Focus = {};
    if (request.file) {
      const location = store.addLocation(request.file);
      focus.path = location.file ?? undefined; focus.folder = location.directory;
    } else if (request.last) {
      focus.path = store.state.latestResponse;
      if (!focus.path) throw new Error("No assistant response yet");
    }
    workspace.focus(focus);
    if (workspace.isOpen()) return `nitpeek is already open: ${workspace.url}`;
    if (process.env.NITPEEK_NO_BROWSER) return `nitpeek: ${workspace.url}`;
    return await run("open", [workspace.url]) ? `nitpeek: ${workspace.url}` : `Open nitpeek manually: ${workspace.url}`;
  }

  const sock = socketPath(config.sessionId);
  // Never take the socket from a live daemon of the same version.
  if (existsSync(sock)) {
    const alive = await new Promise<boolean>(resolve => {
      const probe = connect(sock);
      probe.setTimeout(800, () => { probe.destroy(); resolve(false); });
      probe.on("connect", () => probe.write(JSON.stringify({ cmd: "ping" }) + "\n"));
      probe.on("data", chunk => { probe.destroy(); try { resolve(JSON.parse(String(chunk)).codeStamp === config.codeStamp); } catch { resolve(false); } });
      probe.on("error", () => resolve(false));
    });
    if (alive) { workspace.stop(); console.error("nitpeek daemon already running for", config.sessionId); process.exit(0); }
  }
  rmSync(sock, { force: true });
  const control = createServer((socket: Socket) => {
    let input = "";
    socket.on("data", async chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      const reply = (payload: unknown) => socket.end(JSON.stringify(payload) + "\n");
      try {
        const request = JSON.parse(input);
        if (request.cmd === "ping") return reply({ ok: true, codeStamp: config.codeStamp, url: workspace.url });
        if (request.cmd === "stop") { reply({ ok: true }); return shutdown(); }
        if (request.cmd === "open") return reply({ ok: true, message: await open(request) });
        reply({ ok: false, error: "Unknown command" });
      } catch (error) { reply({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  });
  control.listen(sock);

  // herdr knows whether the agent in the pane is working or waiting for
  // approval; without it, the transcript's turn boundaries are the signal.
  let checkingPane = false;
  async function paneActivity() {
    if (!target.herdrPane || checkingPane) return;
    checkingPane = true;
    try {
      const status = JSON.parse(await capture("herdr", ["pane", "get", target.herdrPane]) || "{}")?.result?.pane?.agent_status;
      if (status === "working") store.setActivity("working");
      else if (status === "blocked") store.setActivity("blocked");
      else if (status === "idle" || status === "done") store.setActivity("idle");
    } catch {} finally { checkingPane = false; }
  }

  // Normally the daemon ends with its Claude process (or at SessionEnd). If
  // that process could not be identified, a long quiet spell ends it instead.
  const QUIET_LIMIT = 12 * 60 * 60 * 1000;
  let ticks = 0, lastActivity = Date.now();
  const timer = setInterval(() => {
    try { if (feed.poll()) { saveTail(); lastActivity = Date.now(); } } catch (error) { console.error("transcript poll failed:", error); }
    const open = workspace.isOpen();
    if (open) lastActivity = Date.now();
    // Asking herdr spawns a process: only worth it while someone is looking.
    if (open && ++ticks % 3 === 0) paneActivity();
    if (config.claudePid) { try { process.kill(config.claudePid, 0); } catch { shutdown(); } }
    else if (Date.now() - lastActivity > QUIET_LIMIT) shutdown();
  }, 700);

  function shutdown() {
    clearInterval(timer);
    workspace.stop();
    control.close();
    rmSync(sock, { force: true });
    setTimeout(() => process.exit(0), 50);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[${new Date().toISOString()}] nitpeek daemon ${config.sessionId} on ${workspace.url}`);
}

if (import.meta.main) main().catch(error => { console.error(error); process.exit(1); });
