/**
 * One background review server per Claude Code session.
 *
 * Started by hook.ts on the first /annotate. It follows the session transcript
 * into the shared ReviewStore, serves the same review UI as the Pi extension,
 * and on Done pastes the feedback into the Claude prompt (herdr, tmux or kitty,
 * as bracketed paste so nothing is submitted), falling back to the clipboard.
 * Exits on SessionEnd, or when the owning Claude process is gone.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../review.js";
import { reviewHtml, reviewRoute } from "../review-extension.js";
import { startAnnotationServer } from "../server.js";
import { AnnotateSettingsStore } from "../settings.js";
import { STORAGE, sessionKey, socketPath, type DaemonConfig, type OpenRequest, type Target } from "./shared.js";
import { TranscriptFeed, type TailState } from "./transcript.js";

function run(command: string, args: string[], input?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout: 5000 }, error => resolve(!error));
    if (input !== undefined) child.stdin?.end(input);
  });
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : stdout)));
}

/**
 * Claude collapses long pastes into "[Pasted text #N +M lines]"; pasting the
 * same text again expands it inline so it can be edited. Only repeat when a
 * new placeholder appears — a short paste is not collapsed and would duplicate.
 */
const placeholders = (screen: string) => screen.match(/\[Pasted text #\d+[^\]]*\]/g)?.length ?? 0;
async function pasteExpanded(read: () => Promise<string>, paste: () => Promise<boolean>): Promise<boolean> {
  const before = placeholders(await read());
  if (!await paste()) return false;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (placeholders(await read()) > before) { await paste(); break; }
  }
  return true;
}

const PASTED = "Notes pasted into Claude’s prompt (not sent). Review them there, then press Enter.";

/** Paste without submitting. Control characters are stripped so the text cannot end the paste early. */
async function deliver(target: Target, feedback: string): Promise<string> {
  const text = feedback.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd() + "\n\n";
  if (target.herdrPane) {
    const pane = target.herdrPane;
    const paste = () => run("herdr", ["pane", "send-text", pane, "\x1b[200~" + text + "\x1b[201~"]);
    if (await pasteExpanded(() => capture("herdr", ["pane", "read", pane, "--source", "visible", "--lines", "40"]), paste)) return PASTED;
  }
  // Only the innermost multiplexer knows which pane is Claude's; never fall
  // through to an outer terminal, which would paste into whatever is focused.
  else if (target.tmuxPane) {
    const pane = target.tmuxPane;
    const paste = async () => await run("tmux", ["load-buffer", "-b", "pi-annotate", "-"], text) && await run("tmux", ["paste-buffer", "-p", "-d", "-b", "pi-annotate", "-t", pane]);
    if (await pasteExpanded(() => capture("tmux", ["capture-pane", "-p", "-t", pane]), paste)) return PASTED;
  }
  else if (target.kittyWindow && await run("kitty", ["@", ...(target.kittyListenOn ? ["--to", target.kittyListenOn] : []), "send-text", "--match", "id:" + target.kittyWindow, "--bracketed-paste", "enable", "--stdin"], text))
    return PASTED;
  if (await run("pbcopy", [], text)) return "Couldn’t reach Claude’s terminal — notes copied to the clipboard. Paste them with ⌘V.";
  throw new Error("Couldn’t paste into Claude or copy to the clipboard");
}

async function main() {
  const config: DaemonConfig = JSON.parse(process.argv[2]);
  let target = config.target;
  const key = sessionKey(config.sessionId);
  mkdirSync(STORAGE, { recursive: true, mode: 0o700 });
  const tailPath = join(STORAGE, key + ".tail.json");
  const store = new ReviewStore(config.cwd, join(STORAGE, key + ".json"), config.sessionId);
  let tail: TailState | undefined;
  try { tail = JSON.parse(readFileSync(tailPath, "utf8")); } catch {}
  const feed = new TranscriptFeed(store, config.transcriptPath, tail);
  const saveTail = () => {
    writeFileSync(tailPath + ".tmp", JSON.stringify(feed.tail), { mode: 0o600 });
    renameSync(tailPath + ".tmp", tailPath);
  };
  if (feed.poll()) saveTail();
  feed.flush();

  let lastSeen = 0, focus = 0;
  let selected: string | undefined, selectedFolder: string | undefined;
  const pasteNote = () => target.herdrPane || target.tmuxPane || target.kittyWindow
    ? "This feedback will be pasted into Claude’s prompt. Nothing is sent automatically."
    : "This feedback will be copied to the clipboard. Nothing is sent automatically.";
  const server = await startAnnotationServer({
    markdown: "", renderedHtml: "", htmlContent: reviewHtml(), mode: "annotate",
    sourceInfo: `Claude session ${config.sessionId.slice(0, 8)}`,
    settings: new AnnotateSettingsStore(join(homedir(), ".pi", "agent", "annotate", "settings.json")),
    workspace: (route, method, url, body) => reviewRoute(store, route, method, url, body, {
      list: () => { lastSeen = Date.now(); return { ...store.list(), focus, target: selected, targetFolder: selectedFolder, host: "Claude", hostNote: pasteNote() }; },
      closed: () => { lastSeen = 0; return { ok: true }; },
      preview: () => ({ feedback: store.feedback(), editorHasText: false }),
      done: async () => {
        const feedback = store.feedback();
        if (!feedback) return { ok: true };
        const message = await deliver(target, feedback);
        store.clearDrafts();
        return { ok: true, message };
      },
    }),
  });

  async function open(request: OpenRequest) {
    target = request.target ?? target;
    feed.poll(); feed.flush(); saveTail();
    if (request.file) {
      const location = store.addLocation(request.file);
      selected = location.file ?? undefined; selectedFolder = location.directory;
    } else if (request.last) {
      selectedFolder = undefined;
      selected = store.state.latestResponse;
      if (!selected) throw new Error("No assistant response found yet");
    } else { selected = undefined; selectedFolder = undefined; }
    focus++;
    if (Date.now() - lastSeen < 90000) return `Annotate is already open: ${server.url}`;
    lastSeen = Date.now();
    if (await run("open", [server.url])) return `Session review: ${server.url}`;
    lastSeen = 0;
    return `Open session review manually: ${server.url}`;
  }

  const sock = socketPath(config.sessionId);
  rmSync(sock, { force: true });
  const control = createServer((socket: Socket) => {
    let input = "";
    socket.on("data", async chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      const reply = (payload: unknown) => socket.end(JSON.stringify(payload) + "\n");
      try {
        const request = JSON.parse(input);
        if (request.cmd === "ping") return reply({ ok: true, codeStamp: config.codeStamp, url: server.url });
        if (request.cmd === "stop") { reply({ ok: true }); return shutdown(); }
        if (request.cmd === "open") return reply({ ok: true, message: await open(request) });
        reply({ ok: false, error: "Unknown command" });
      } catch (error) { reply({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  });
  control.listen(sock);

  const timer = setInterval(() => {
    try { if (feed.poll()) saveTail(); } catch (error) { console.error("transcript poll failed:", error); }
    if (config.claudePid) { try { process.kill(config.claudePid, 0); } catch { shutdown(); } }
  }, 700);

  function shutdown() {
    clearInterval(timer);
    server.stop();
    control.close();
    rmSync(sock, { force: true });
    setTimeout(() => process.exit(0), 50);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[${new Date().toISOString()}] annotate daemon ${config.sessionId} on ${server.url}`);
}

if (import.meta.main) main().catch(error => { console.error(error); process.exit(1); });
