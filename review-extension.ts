import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewStore } from "./review.js";
import { startAnnotationServer } from "./server.js";
import { AnnotateSettingsStore } from "./settings.js";
import { createDemoStore } from "./demo.js";

const htmlRoot = dirname(fileURLToPath(import.meta.url));
export function reviewHtml() {
  return readFileSync(join(htmlRoot, "form", "annotate.html"), "utf8")
    .replace("/* __REVIEW_SCRIPT__ */", readFileSync(join(htmlRoot, "form", "review.js"), "utf8"));
}
export function reviewRoute(
  activeStore: ReviewStore, route: string, method: string, url: URL, body: unknown,
  handlers: { list: () => unknown; closed: () => unknown; preview: () => unknown; done: () => unknown },
) {
  if (route === "/api/review/list" && method === "GET") return handlers.list();
  if (route === "/api/review/browse" && method === "GET") return activeStore.browse(url.searchParams.get("path") || "");
  if (route === "/api/review/search" && method === "GET") return activeStore.search(url.searchParams.get("q") || "");
  if (route === "/api/review/location" && method === "POST") return activeStore.addLocation((body as { path?: string })?.path || "");
  if (route === "/api/review/open-file" && method === "POST") return { path: activeStore.openBrowsableFile((body as { path?: string })?.path || "") };
  if (route === "/api/review/document" && method === "GET") return activeStore.document(url.searchParams.get("path") || "", url.searchParams.get("scope") || "request");
  if (route === "/api/review/disk-comparison" && method === "GET") return activeStore.diskComparison(url.searchParams.get("path") || "");
  if (route === "/api/review/draft" && method === "POST") return activeStore.draft(body);
  if (route === "/api/review/preview" && method === "GET") return handlers.preview();
  if (route === "/api/review/closed" && method === "POST") return handlers.closed();
  if (route === "/api/review/done" && method === "POST") return handlers.done();
  throw new Error("Unknown review route");
}
async function openBrowser(pi: ExtensionAPI, url: string) {
  return platform() === "darwin" ? pi.exec("open", [url]) : platform() === "win32" ? pi.exec("cmd", ["/c", "start", "", url]) : pi.exec("xdg-open", [url]);
}

export function registerReview(pi: ExtensionAPI, storageDirectory = join(homedir(), ".pi", "agent", "annotate")) {
  const settings = new AnnotateSettingsStore(join(storageDirectory, "settings.json"));
  let store: ReviewStore | undefined;
  let server: Awaited<ReturnType<typeof startAnnotationServer>> | undefined;
  let context: ExtensionContext | undefined;
  let lastSeen = 0;
  let focus = 0;
  let target: string | undefined;
  let targetFolder: string | undefined;
  function captureResponse(ctx: ExtensionContext) {
    if (!store) return;
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    let newerUser = false;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") { newerUser = true; continue; }
      if (entry.message.role !== "assistant") continue;
      if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
      if (entry.message.content.some(c => c.type === "toolCall")) continue;
      const text = entry.message.content.filter(c => c.type === "text").map(c => c.text).join("\n\n");
      if (text.trim()) return store.response(entry.id, text, newerUser ? store.state.request - 1 : store.state.request);
    }
  }
  let starting: Promise<void> | undefined;
  function initialize(ctx: ExtensionContext, suffix = "") {
    if (ctx.mode !== "tui") return;
    server?.stop(); server = undefined; lastSeen = 0; target = undefined; targetFolder = undefined;
    context = ctx;
    const session = ctx.sessionManager.getSessionId();
    const identity = ctx.sessionManager.getSessionFile() || session;
    const base = createHash("sha256").update(identity).digest("hex");
    const directory = storageDirectory;
    const scopeFile = join(directory, base + ".scope");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (suffix) writeFileSync(scopeFile, suffix, { mode: 0o600 });
    else if (existsSync(scopeFile)) suffix = readFileSync(scopeFile, "utf8");
    const key = createHash("sha256").update(identity + suffix).digest("hex");
    store = new ReviewStore(ctx.cwd, join(directory, key + ".json"), session);
    captureResponse(ctx);
  }
  pi.on("session_start", (_event, ctx) => initialize(ctx));
  pi.on("session_shutdown", () => { server?.stop(); server = undefined; store = undefined; context = undefined; });
  // A branch switch starts a separate review scope rather than mixing histories.
  pi.on("session_tree", (event, ctx) => initialize(ctx, ":branch:" + event.newLeafId));
  pi.on("message_start", (event) => {
    if (event.message.role === "user") store?.nextRequest();
  });
  pi.on("tool_call", (event) => {
    if ((event.toolName === "write" || event.toolName === "edit") && typeof event.input.path === "string") store?.begin(event.toolCallId, event.input.path);
  });
  pi.on("tool_execution_end", (event) => store?.end(event.toolCallId, event.isError));
  pi.on("agent_settled", (_event, ctx) => { captureResponse(ctx); });

  return async function openReview(ctx: ExtensionContext, selection?: { file?: string; last?: boolean }) {
    if (!store) initialize(ctx);
    if (!store || ctx.mode !== "tui") { ctx.ui.notify("Session review requires interactive Pi.", "error"); return; }
    context = ctx;
    if (selection?.file) {
      try {
        const location = store.addLocation(selection.file);
        target = location.file ?? undefined;
        targetFolder = location.directory;
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
    } else if (selection?.last) {
      targetFolder = undefined;
      target = captureResponse(ctx) ?? store.state.latestResponse;
      if (!target) { ctx.ui.notify("No assistant message found", "error"); return; }
    } else { target = undefined; targetFolder = undefined; }
    if (!server) {
      starting ??= (async () => {
        const html = reviewHtml();
        const activeStore = store!;
        server = await startAnnotationServer({
          markdown: "", renderedHtml: "", htmlContent: html, mode: "annotate", sourceInfo: `Session ${activeStore.sessionId.slice(0, 8)}`,
          settings,
          workspace: (route, method, url, body) => {
            if (store !== activeStore || !context) throw new Error("Pi session changed. Reopen /annotate.");
            return reviewRoute(activeStore, route, method, url, body, {
              list: () => { lastSeen = Date.now(); return { ...activeStore.list(), focus, target, targetFolder }; },
              closed: () => { lastSeen = 0; return { ok: true }; },
              preview: () => ({ feedback: activeStore.feedback(), editorHasText: !!context!.ui.getEditorText().trim() }),
              done: () => {
                const feedback = activeStore.feedback();
                if (feedback) {
                  const existing = context!.ui.getEditorText();
                  context!.ui.setEditorText(existing.trim() ? existing.trimEnd() + "\n\n" + feedback : feedback);
                  activeStore.clearDrafts();
                  context!.ui.notify("Review notes appended to your draft — edit or press Enter to send.", "info");
                }
                return { ok: true };
              },
            });
          },
        });
      })();
      try { await starting; } finally { starting = undefined; }
    }
    focus++;
    if (Date.now() - lastSeen < 90000) {
      ctx.ui.notify(`Annotate is already open: ${server!.url}`, "info");
      return;
    }
    const url = server!.url;
    lastSeen = Date.now();
    const result = await openBrowser(pi, url);
    if (result.code !== 0) lastSeen = 0;
    ctx.ui.notify(result.code === 0 ? `Session review: ${url}` : `Open session review manually: ${url}`, "info");
  };
}

/** Demo has its own ephemeral store/server; it never captures the real session. */
export function registerDemo(pi: ExtensionAPI) {
  let fixture: ReturnType<typeof createDemoStore> | undefined;
  let server: Awaited<ReturnType<typeof startAnnotationServer>> | undefined;
  let starting: Promise<void> | undefined;
  let lastSeen = 0, focus = 0;
  const settings = new AnnotateSettingsStore(join(homedir(), ".pi", "agent", "annotate", "settings.json"));
  const stop = () => {
    server?.stop(); server = undefined; lastSeen = 0;
    if (fixture) rmSync(fixture.directory, { recursive: true, force: true });
    fixture = undefined;
  };
  pi.on("session_shutdown", stop);
  pi.on("session_tree", stop);
  return async function openDemo(ctx: ExtensionContext, reset = false) {
    if (ctx.mode !== "tui") { ctx.ui.notify("Annotate demo requires interactive Pi.", "error"); return; }
    if (reset) stop();
    if (!fixture) fixture = createDemoStore();
    if (!server) {
      starting ??= (async () => {
        const active = fixture!;
        server = await startAnnotationServer({
          markdown: "", renderedHtml: "", htmlContent: reviewHtml(), mode: "annotate",
          sourceInfo: "Demo review — temporary files",
          settings,
          workspace: (route, method, url, body) => {
            if (fixture !== active) throw new Error("Demo reset. Reopen /annotate-demo.");
            return reviewRoute(active.store, route, method, url, body, {
              list: () => { lastSeen = Date.now(); return { ...active.store.list(), demo: true, focus, target: active.script, targetFolder: active.workspace }; },
              closed: () => { lastSeen = 0; return { ok: true }; },
              preview: () => ({ feedback: active.store.feedback(), editorHasText: false }),
              // Preview only: demo notes never touch Pi's editor or the real
              // session store. They survive until reset or session shutdown.
              done: () => ({ ok: true, demo: true, feedback: active.store.feedback() }),
            });
          },
        });
      })();
      try { await starting; } catch (error) {
        stop(); ctx.ui.notify(`Demo failed: ${error instanceof Error ? error.message : String(error)}`, "error"); return;
      } finally { starting = undefined; }
    }
    focus++;
    if (Date.now() - lastSeen < 90000) { ctx.ui.notify(`Annotate demo is already open: ${server!.url}`, "info"); return; }
    const url = server!.url;
    lastSeen = Date.now();
    const result = await openBrowser(pi, url);
    if (result.code !== 0) lastSeen = 0;
    ctx.ui.notify(result.code === 0 ? `Annotate demo: ${url}` : `Open annotate demo manually: ${url}`, "info");
  };
}
