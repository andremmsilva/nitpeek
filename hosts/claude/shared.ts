/** Constants and types shared by the hook (kept import-light) and the daemon. */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Target = { herdrPane?: string; tmuxPane?: string; kittyWindow?: string; kittyListenOn?: string };
export type DaemonConfig = { sessionId: string; transcriptPath: string; cwd: string; claudePid?: number; codeStamp: number; target: Target };
export type OpenRequest = { cmd: "open"; target: Target; file?: string; last?: boolean };

export const STORAGE = join(process.env.NITPEEK_HOME || join(homedir(), ".nitpeek"), "claude");
export const sessionKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");
export const socketPath = (sessionId: string) => join(STORAGE, sessionKey(sessionId).slice(0, 16) + ".sock");

/**
 * The project the session was started in. The hook's `cwd` follows the
 * agent's `cd`s, so it can be any subfolder by the time /annotate runs.
 */
export function projectDir(input: { cwd: string; transcript_path?: string }): string {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const fd = openSync(String(input.transcript_path), "r");
    const buffer = Buffer.alloc(256 * 1024);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    closeSync(fd);
    const first = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, size).toString("utf8"));
    if (first) { const cwd = JSON.parse(`"${first[1]}"`); if (existsSync(cwd)) return cwd; }
  } catch {}
  return input.cwd;
}
