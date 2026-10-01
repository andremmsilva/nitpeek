/**
 * The agent's last reply, for the Ctrl+G editor (bin/nitpeek-editor): finds
 * the Claude session this editor was opened from, writes its last textual
 * answer to a file and prints the file's path. Prints nothing when unsure.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** The session of the nearest `claude` process above this one. */
function sessionId(): string | null {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  let pid = process.ppid;
  for (let hops = 0; pid > 1 && hops < 12; hops++) {
    try { return JSON.parse(readFileSync(join(CLAUDE, "sessions", `${pid}.json`), "utf8")).sessionId ?? null; } catch {}
    try { pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch { return null; }
  }
  return null;
}

function transcriptOf(id: string): string | null {
  const projects = join(CLAUDE, "projects");
  try {
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, `${id}.jsonl`);
      if (existsSync(path)) return path;
    }
  } catch {}
  return null;
}

/** Like the review panel: the last assistant message with text and no tool call. */
export function lastReply(transcript: string): string | null {
  const lines = transcript.split("\n");
  let id: string | undefined, text: string[] = [], tool = false;
  const done = () => (!tool && text.join("").trim() ? text.join("\n\n") : null);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let entry: any;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const message = entry.message ?? {};
    const messageId = message.id ?? entry.uuid;
    if (messageId !== id) {
      const found = done();
      if (found) return found;
      id = messageId; text = []; tool = false;
    }
    // Reading backwards: earlier blocks of the same message go in front.
    const blocks = Array.isArray(message.content) ? message.content : [];
    text.unshift(...blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text));
    if (blocks.some((b: any) => b?.type === "tool_use")) tool = true;
  }
  return done();
}

if (import.meta.main) {
  const id = sessionId();
  const path = id && transcriptOf(id);
  const reply = path ? lastReply(readFileSync(path, "utf8")) : null;
  if (id && reply) {
    const dir = join(process.env.NITPEEK_HOME || join(homedir(), ".nitpeek"), "editor");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${id}.md`);
    writeFileSync(file, `# Last reply\n\n${reply.trim()}\n`, { mode: 0o600 });
    process.stdout.write(file);
  }
}
