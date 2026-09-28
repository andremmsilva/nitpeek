/**
 * nitpeek for Pi: /annotate opens the session review panel; Done puts the
 * notes in Pi's editor, never sending them.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewStore } from "../../core/store.js";
import { NITPEEK_HOME, blobStore, startWorkspace, type Target, type Workspace } from "../../core/workspace.js";

const promptText = (content: unknown) =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";

export default function (pi: ExtensionAPI, storage = join(NITPEEK_HOME, "pi")) {
  let store: ReviewStore | undefined;
  let workspace: Workspace | undefined;
  let starting: Promise<Workspace> | undefined;
  let context: ExtensionContext | undefined;

  /** The latest completed textual answer (no tool calls, not aborted). */
  function captureResponse(ctx: ExtensionContext) {
    if (!store) return;
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    let newerUser = false;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry: any = branch[i];
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") { newerUser = true; continue; }
      if (entry.message.role !== "assistant") continue;
      if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
      if (entry.message.content.some((c: any) => c.type === "toolCall")) continue;
      const text = entry.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n\n");
      if (text.trim()) return store.response(entry.id, text, newerUser ? store.request.id - 1 : store.request.id);
    }
  }

  function stop() { workspace?.stop(); workspace = undefined; starting = undefined; }

  function initialize(ctx: ExtensionContext, suffix = "") {
    if (ctx.mode !== "tui") return;
    stop();
    context = ctx;
    const session = ctx.sessionManager.getSessionId();
    const identity = ctx.sessionManager.getSessionFile() || session;
    const base = createHash("sha256").update(identity).digest("hex");
    const scopeFile = join(storage, base + ".scope");
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    if (suffix) writeFileSync(scopeFile, suffix, { mode: 0o600 });
    else if (existsSync(scopeFile)) suffix = readFileSync(scopeFile, "utf8");
    const key = createHash("sha256").update(identity + suffix).digest("hex");
    store = new ReviewStore(ctx.cwd, join(storage, key + ".json"), session, blobStore());
    captureResponse(ctx);
  }

  pi.on("session_start", (_event, ctx) => initialize(ctx));
  pi.on("session_shutdown", () => { stop(); store = undefined; context = undefined; });
  // A branch switch starts a separate review rather than mixing histories.
  pi.on("session_tree", (event, ctx) => initialize(ctx, ":branch:" + event.newLeafId));
  pi.on("message_start", event => { if (event.message.role === "user") store?.nextRequest(promptText((event.message as any).content)); });
  pi.on("agent_start", () => store?.setActivity("working"));
  pi.on("tool_call", event => {
    if ((event.toolName === "write" || event.toolName === "edit") && typeof (event.input as any).path === "string") store?.begin(event.toolCallId, (event.input as any).path);
  });
  pi.on("tool_execution_end", event => store?.end(event.toolCallId, event.isError));
  pi.on("agent_settled", (_event, ctx) => { captureResponse(ctx); store?.setActivity("idle"); });

  const host = {
    name: "Pi",
    deliveryNote: () => context?.ui.getEditorText().trim()
      ? "The notes will be appended after the text already in Pi’s editor. Nothing is sent."
      : "The notes will be placed in Pi’s editor. Nothing is sent.",
    async deliver(feedback: string) {
      if (!context) throw new Error("Pi session changed. Reopen /annotate.");
      const existing = context.ui.getEditorText();
      context.ui.setEditorText(existing.trim() ? existing.trimEnd() + "\n\n" + feedback : feedback);
      context.ui.notify("Review notes are in your editor — edit them or press Enter to send.", "info");
      return "Notes are in Pi’s editor. Review them there, then press Enter.";
    },
  };

  async function open(ctx: ExtensionContext, target?: Target & { last?: boolean }) {
    if (!store) initialize(ctx);
    if (!store || ctx.mode !== "tui") { ctx.ui.notify("nitpeek needs interactive Pi.", "error"); return; }
    context = ctx;
    const focus: Target = {};
    if (target?.path) {
      try { const location = store.addLocation(target.path); focus.path = location.file ?? undefined; focus.folder = location.directory; }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
    } else if (target?.last) {
      focus.path = captureResponse(ctx) ?? store.state.latestResponse;
      if (!focus.path) { ctx.ui.notify("No assistant response yet", "error"); return; }
    }
    if (!workspace) {
      const active = store;
      starting ??= startWorkspace(active, host);
      try { workspace = await starting; } catch (error) { starting = undefined; ctx.ui.notify(`nitpeek failed to start: ${error instanceof Error ? error.message : error}`, "error"); return; }
    }
    workspace.focus(focus);
    if (workspace.isOpen()) { ctx.ui.notify(`nitpeek is already open: ${workspace.url}`, "info"); return; }
    const command = platform() === "darwin" ? ["open", [workspace.url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", workspace.url]] : ["xdg-open", [workspace.url]];
    const result = await pi.exec(command[0] as string, command[1] as string[]);
    ctx.ui.notify(result.code === 0 ? `nitpeek: ${workspace.url}` : `Open nitpeek manually: ${workspace.url}`, "info");
  }

  pi.registerCommand("annotate", {
    description: "Review this session's responses and changes (nitpeek); optionally open a file or folder",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const path = args.trim().replace(/^@/, "");
      if (path && !existsSync(resolve(ctx.cwd, path))) { ctx.ui.notify(`Not found: ${resolve(ctx.cwd, path)}`, "error"); return; }
      return open(ctx, path ? { path: resolve(ctx.cwd, path) } : undefined);
    },
  });
  pi.registerCommand("annotate-last", {
    description: "Annotate the latest assistant response (nitpeek)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => open(ctx, { last: true }),
  });
}
