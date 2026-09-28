/**
 * Claude Code transcript → ReviewStore.
 *
 * Claude Code appends every conversation entry to a JSONL transcript. Edit and
 * Write results carry `originalFile` plus enough information to rebuild the
 * written content, so captured diffs need no tool hooks and even cover edits
 * made before /annotate was first opened. Subagent transcripts (in
 * `<session>/subagents/`) contribute file edits only.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ReviewStore } from "../../core/store.js";
import { fromText as textSnapshot, type Snapshot } from "../../core/snapshot.js";

const MAX_FILE = 512 * 1024;

function contentText(entry: any): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";
}

/** Slash-command prompts are stored as tags; show them as typed. */
function promptLabel(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (!name) return text;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? "";
  return `${name} ${args}`.trim();
}/** Harness-injected user entries that are not a new user request. */
const NOT_A_PROMPT = /^\s*(<(local-command-(stdout|stderr|caveat)|task-notification|bash-(input|stdout|stderr)|system-reminder)|\[Request interrupted)/;
const INTERRUPTED = /^\s*\[Request interrupted/;

/** `pendingPrompt`: text of a user prompt whose assistant turn has not started yet. */
export type TailState = { offsets: Record<string, number>; pendingPrompt: string | false };

function replace(text: string, oldString: string, newString: string, all: boolean) {
  return all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

/**
 * Before/after contents of a successful Write/Edit/MultiEdit result, or null.
 * Claude omits `originalFile` when it never read the whole file; `known`
 * then supplies the last content we know for that path.
 */
export function mutation(result: any, known?: (path: string) => string | null | undefined): { path: string; before: Snapshot; after: Snapshot } | null {
  if (!result || typeof result !== "object" || typeof result.filePath !== "string" || !("originalFile" in result)) return null;
  let original: string | null = typeof result.originalFile === "string" ? result.originalFile : null;
  if (original === null && result.type !== "create" && typeof result.content !== "string") original = known?.(result.filePath) ?? null;
  let after: string | null = null;
  if (typeof result.content === "string") after = result.content;
  else if (original !== null && typeof result.oldString === "string" && typeof result.newString === "string") {
    after = replace(original, result.oldString, result.newString, !!result.replaceAll);
  } else if (original !== null && Array.isArray(result.edits)) {
    after = result.edits.reduce((text: string, e: any) => replace(text, e.old_string ?? e.oldString, e.new_string ?? e.newString, !!(e.replace_all ?? e.replaceAll)), original);
  }
  if (after === null) return null;
  return { path: result.filePath, before: textSnapshot(original), after: textSnapshot(after) };
}

/** Last resort: undo a single Edit against the current disk contents. */
function reverted(path: string, result: any): string | undefined {
  if (typeof result.oldString !== "string" || typeof result.newString !== "string" || !result.newString) return undefined;
  try {
    const disk = readFileSync(path, "utf8");
    return disk.includes(result.newString) ? replace(disk, result.newString, result.oldString, !!result.replaceAll) : undefined;
  } catch { return undefined; }
}

function isPrompt(entry: any): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return !NOT_A_PROMPT.test(content);
  if (!Array.isArray(content) || content.some((c: any) => c?.type === "tool_result")) return false;
  return !NOT_A_PROMPT.test(contentText(entry));
}

export class TranscriptFeed {
  /** Latest known content per path: our last recorded write, or a newer file-history backup. */
  private known = new Map<string, string | null>();
  /** Text of the assistant message currently being streamed, keyed by message id. */
  private group: { id: string; entryId: string; text: string[]; toolUse: boolean; final: boolean } | undefined;

  constructor(private store: ReviewStore, public transcriptPath: string, public tail: TailState = { offsets: {}, pendingPrompt: false }) {
    if (typeof tail.pendingPrompt !== "string") tail.pendingPrompt = false;
  }

  private subagentFiles(): string[] {
    const directory = join(dirname(this.transcriptPath), basename(this.transcriptPath, ".jsonl"), "subagents");
    try { return readdirSync(directory).filter(f => f.endsWith(".jsonl")).map(f => join(directory, f)); }
    catch { return []; }
  }

  /** Read newly appended complete lines. Returns true when anything was consumed. */
  poll(): boolean {
    let consumed = false;
    for (const file of [this.transcriptPath, ...this.subagentFiles()]) {
      const main = file === this.transcriptPath;
      for (const line of this.readLines(file)) {
        consumed = true;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        this.apply(entry, main);
      }
    }
    // A quiet transcript means the streamed message is complete.
    if (!consumed) this.flush();
    return consumed;
  }

  private readLines(file: string): string[] {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    let offset = this.tail.offsets[file] ?? 0;
    if (size < offset) offset = 0; // truncated or replaced
    if (size === offset) return [];
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, "r");
    try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
    const end = buffer.lastIndexOf(10);
    if (end < 0) return []; // wait for a complete line
    this.tail.offsets[file] = offset + end + 1;
    return buffer.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
  }

  /** Claude's rewind backup: the file as it was before this turn's first edit. */
  private backup(path: string, name: string | null) {
    if (name === null) { this.known.set(path, null); return; }
    const file = join(homedir(), ".claude", "file-history", basename(this.transcriptPath, ".jsonl"), name);
    try { if (statSync(file).size <= MAX_FILE) this.known.set(path, readFileSync(file, "utf8")); } catch {}
  }

  private lastKnown(path: string): string | null | undefined {
    if (this.known.has(path)) return this.known.get(path);
    return this.store.latestText(path) ?? undefined;
  }

  apply(entry: any, main = true) {
    if (entry.type === "user" && entry.toolUseResult) {
      const result = entry.toolUseResult;
      const change = mutation(result, path => this.lastKnown(path) ?? reverted(path, result));
      if (change) { this.store.record(change.path, change.before, change.after); this.known.set(change.path, change.after.text); }
      return;
    }
    if (entry.type === "file-history-delta" && typeof entry.trackingPath === "string" && entry.backup) {
      this.backup(entry.trackingPath, entry.backup.backupFileName ?? null);
      return;
    }
    if (entry.type === "file-history-snapshot") {
      for (const [path, backup] of Object.entries<any>(entry.snapshot?.trackedFileBackups ?? {})) this.backup(path, backup?.backupFileName ?? null);
      return;
    }
    if (!main) return;
    if (entry.type === "user" && !entry.isSidechain && INTERRUPTED.test(contentText(entry))) { this.flush(); this.store.setActivity("idle"); return; }
    if (isPrompt(entry)) { this.flush(); this.tail.pendingPrompt = promptLabel(contentText(entry)); return; }
    if (entry.type !== "assistant" || entry.isSidechain || entry.isApiErrorMessage) return;
    // Local slash commands (e.g. /model) never reach the model; only a real
    // assistant turn opens the next request, like Pi's user-message boundary.
    if (this.tail.pendingPrompt !== false) {
      this.flush();
      this.store.nextRequest(this.tail.pendingPrompt);
      this.tail.pendingPrompt = false;
      this.store.setActivity("working");
    }
    const message = entry.message ?? {};
    const id = message.id ?? entry.uuid;
    if (this.group?.id !== id) { this.flush(); this.group = { id, entryId: String(entry.uuid ?? id).slice(0, 8), text: [], toolUse: false, final: false }; }
    for (const block of message.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") this.group.text.push(block.text);
      if (block?.type === "tool_use") this.group.toolUse = true;
    }
    if (message.stop_reason && message.stop_reason !== "tool_use") this.group.final = true;
  }

  /** Publish the pending assistant message if it was a completed textual answer. */
  flush() {
    const group = this.group;
    this.group = undefined;
    if (!group || group.toolUse || !group.final) return;
    const text = group.text.join("\n\n");
    if (text.trim()) this.store.response(group.entryId, text);
    this.store.setActivity("idle");
  }
}
