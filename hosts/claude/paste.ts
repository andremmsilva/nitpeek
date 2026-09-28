/** Pasting notes into Claude's prompt without submitting them. */

import { execFile } from "node:child_process";
import type { Target } from "./shared.js";

export function run(command: string, args: string[], input?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout: 5000 }, error => resolve(!error));
    if (input !== undefined) child.stdin?.end(input);
  });
}

export function capture(command: string, args: string[]): Promise<string> {
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
export async function deliver(target: Target, feedback: string): Promise<string> {
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
    const paste = async () => await run("tmux", ["load-buffer", "-b", "nitpeek", "-"], text) && await run("tmux", ["paste-buffer", "-p", "-d", "-b", "nitpeek", "-t", pane]);
    if (await pasteExpanded(() => capture("tmux", ["capture-pane", "-p", "-t", pane]), paste)) return PASTED;
  }
  else if (target.kittyWindow && await run("kitty", ["@", ...(target.kittyListenOn ? ["--to", target.kittyListenOn] : []), "send-text", "--match", "id:" + target.kittyWindow, "--bracketed-paste", "enable", "--stdin"], text))
    return PASTED;
  if (await run("pbcopy", [], text)) return "Couldn’t reach Claude’s terminal — notes copied to the clipboard. Paste them with ⌘V.";
  throw new Error("Couldn’t paste into Claude or copy to the clipboard");
}
