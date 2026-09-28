/** Constants and types shared by the hook (kept import-light) and the daemon. */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type Target = { herdrPane?: string; tmuxPane?: string; kittyWindow?: string; kittyListenOn?: string };
export type DaemonConfig = { sessionId: string; transcriptPath: string; cwd: string; claudePid?: number; codeStamp: number; target: Target };
export type OpenRequest = { cmd: "open"; target: Target; file?: string; last?: boolean };

export const STORAGE = join(process.env.NITPEEK_HOME || join(homedir(), ".nitpeek"), "claude");
export const sessionKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");
export const socketPath = (sessionId: string) => join(STORAGE, sessionKey(sessionId).slice(0, 16) + ".sock");
