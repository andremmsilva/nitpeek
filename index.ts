/**
 * pi-annotate-local — visual annotation extension for pi.
 *
 * Registers /annotate and /annotate-last, starts a loopback-only annotation
 * server, and opens the review UI (Glimpse on macOS when available, otherwise
 * the default browser). Submitted feedback is delivered to the agent as a
 * follow-up message.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { startAnnotationServer, type Annotation } from "./server.js";
import { DEMO_MARKDOWN, normalizeMarkdown, renderMarkdown } from "./markdown.js";
import { registerReview } from "./review-extension.js";
import { AnnotateSettingsStore } from "./settings.js";

// ── Types ──────────────────────────────────────────────────────────────

interface GlimpseWindow {
  on(event: "closed", handler: () => void): void;
  close(): void;
}

interface AnnotationDecision {
  action: "feedback" | "approve" | "exit";
  feedback?: string;
  annotations?: Annotation[];
}

type AnnotationServer = Awaited<ReturnType<typeof startAnnotationServer>>;

// ── UI preferences ─────────────────────────────────────────────────────

// Shared with the session review extension; unlike browser localStorage these
// settings survive the annotation server's ephemeral port changing.
const UI_SETTINGS = new AnnotateSettingsStore(join(os.homedir(), ".pi", "agent", "annotate", "settings.json"));
const DEFAULT_THEME = "system";

// ── Auto-detect (opt-in) ───────────────────────────────────────────────

// When enabled, the extension auto-opens the annotation UI whenever the
// assistant mentions an existing file under docs/superpowers/{specs,plans}/.
// That layout comes from the third-party "superpowers" skill set and is not
// used here, so the hook is disabled. Flip to true to opt back in.
const AUTO_DETECT_SUPERPOWERS = false;
const SUPERPOWERS_PATH_PATTERN =
  /docs\/superpowers\/(specs|plans)\/[^\s,.;:()!?]+\.md/g;

// ── Feedback delivery ────────────────────────────────────────────────

// "draft" — put the formatted feedback into the pi editor so you can review
//           (and edit) it, then press Enter to send.
// "send"  — deliver it immediately as a follow-up message.
const FEEDBACK_DELIVERY: "draft" | "send" = "draft";

// ── Glimpse integration ────────────────────────────────────────────────

let glimpseOpen:
  | ((html: string, opts: Record<string, unknown>) => GlimpseWindow)
  | null
  | undefined;

function findGlimpseMjs(): string | null {
  // Walk up from this module looking for node_modules/glimpseui/src/glimpse.mjs.
  // createRequire().resolve() is avoided on purpose: some extension loaders
  // hijack createRequire so it only knows registered modules, which breaks
  // filesystem-based package resolution.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(dir, "node_modules", "glimpseui", "src", "glimpse.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // npm global install location.
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const entry = resolve(globalRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // npm root -g failed
  }
  // bun global install location.
  try {
    const bunRoot = resolve(os.homedir(), ".bun", "install", "global", "node_modules");
    const entry = resolve(bunRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // homedir failed
  }
  return null;
}

async function getGlimpseOpen(): Promise<typeof glimpseOpen> {
  if (glimpseOpen !== undefined) return glimpseOpen;
  const resolved = findGlimpseMjs();
  if (resolved) {
    try {
      // Import via an explicit file:// URL for compatibility with different
      // extension loaders.
      glimpseOpen = (await import(pathToFileURL(resolved).href)).open;
      return glimpseOpen;
    } catch {
      // import failed
    }
  }
  glimpseOpen = null;
  return glimpseOpen;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openInGlimpse(
  open: (html: string, opts: Record<string, unknown>) => GlimpseWindow,
  url: string,
  title?: string,
): GlimpseWindow {
  const safeTitle = escapeHtml(title || "Annotate");
  const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${safeTitle}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  return open(shellHTML, { width: 900, height: 750, title: title || "Annotate" });
}

async function openUrl(pi: ExtensionAPI, url: string): Promise<void> {
  const platform = os.platform();
  let result: { code: number; stderr?: string };
  if (platform === "darwin") {
    result = await pi.exec("open", [url]);
  } else if (platform === "win32") {
    result = await pi.exec("cmd", ["/c", "start", "", url]);
  } else {
    result = await pi.exec("xdg-open", [url]);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && "message" in entry) {
      const msg = entry.message;
      if (msg.role === "assistant") {
        const parts = msg.content.filter((c) => c.type === "text");
        const text = parts.map((c) => c.text).join("").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

// ── Feedback formatting ───────────────────────────────────────────────

/** 1-based line number of a character offset. */
function lineNumberAt(markdown: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, markdown.length));
  let line = 1;
  for (let i = 0; i < limit; i++) {
    if (markdown.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Render annotations as markdown for the agent: first the exact selected text,
 * then the comment. File annotations carry a line number (the agent can open
 * the file there); message annotations do not — chat messages have no line
 * numbers the agent can see.
 */
function formatAnnotationFeedback(
  annotations: Annotation[],
  sourceInfo: string,
  markdown: string,
  mode: "annotate" | "annotate-last",
): string {
  if (!annotations || annotations.length === 0) return "";

  const showLines = mode === "annotate";

  const items = annotations
    .map((a, index) => {
      const start = a.range?.startOffset ?? 0;
      const end = a.range?.endOffset ?? start;
      const selected = typeof a.selectedText === "string" ? a.selectedText : markdown ? markdown.slice(start, end) : a.originalText || "";
      const lineFrom = showLines && markdown ? lineNumberAt(markdown, start) : null;
      const lineTo = showLines && markdown ? lineNumberAt(markdown, Math.max(start, end - 1)) : null;

      const location = lineFrom
        ? ` — line ${lineFrom}${lineTo && lineTo !== lineFrom ? `–${lineTo}` : ""}`
        : "";

      return [
        `### ${index + 1}. [${(a.type || "comment").toUpperCase()}]${location}`,
        "**Selected text:**",
        (selected || "(empty)").split("\n").map(line => `> ${line}`).join("\n"),
        "",
        `**Comment:** ${a.text}`,
      ].join("\n");
    })
    .join("\n\n");

  const counts = annotations.reduce<Record<string, number>>((acc, a) => {
    acc[a.type] = (acc[a.type] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`)
    .join(", ");

  const hasIssues = annotations.some((a) => a.type === "issue");
  const hasSuggestions = annotations.some((a) => a.type === "suggestion");
  const ending = hasIssues
    ? "Please address the issues above."
    : hasSuggestions
      ? "Please revise according to the suggestions above."
      : "Please consider the feedback above.";

  return `## Annotation Feedback — ${sourceInfo}\n\n${annotations.length} annotation${
    annotations.length === 1 ? "" : "s"
  } (${summary}).\n\n${items}\n\n${ending}`;
}

export function handleAnnotationDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  decision: AnnotationDecision,
  sourceInfo: string,
  markdown: string,
  mode: "annotate" | "annotate-last",
): void {
  switch (decision.action) {
    case "feedback": {
      // Structured annotations are the source of truth; the plain feedback
      // string is only a fallback for clients that do not send them.
      let feedbackText =
        decision.annotations && decision.annotations.length > 0
          ? formatAnnotationFeedback(decision.annotations, sourceInfo, markdown, mode)
          : decision.feedback;
      if (!feedbackText) {
        feedbackText = `## Annotation Feedback — ${sourceInfo}\n\nPlease revise according to the feedback above.`;
      }

      if (FEEDBACK_DELIVERY === "draft" && ctx.hasUI) {
        // Prefill the editor instead of sending immediately: review the text,
        // optionally edit it, then press Enter to send.
        const existing = ctx.ui.getEditorText();
        if (existing.trim()) {
          ctx.ui.setEditorText(existing.replace(/\s*$/, "") + "\n\n" + feedbackText);
          ctx.ui.notify(
            "Annotation feedback appended in the editor — press Enter to send.",
            "info",
          );
        } else {
          ctx.ui.setEditorText(feedbackText);
          ctx.ui.notify(
            "Annotation feedback loaded in the editor — press Enter to send.",
            "info",
          );
        }
        break;
      }

      pi.sendUserMessage(feedbackText, { deliverAs: "followUp" });
      break;
    }
    case "approve":
      ctx.ui.notify(`${sourceInfo} approved`, "success");
      break;
    case "exit":
      // Closed without a decision; nothing to deliver.
      break;
  }
}

// ── Shared annotation flow ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readAnnotateHtml(): Promise<string> {
  const htmlPath = resolve(__dirname, "form", "annotate.html");
  return readFileSync(htmlPath, "utf-8");
}

interface OpenAnnotationOptions {
  markdown: string;
  mode: "annotate" | "annotate-last";
  sourceInfo: string;
}

/**
 * Start the annotation server and open the UI. Resolves once the user submits
 * feedback, approves, or closes the window. Never throws; failures are reported
 * through `onError`.
 */
async function openAnnotationUi(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: OpenAnnotationOptions,
  onError: (message: string) => void,
): Promise<void> {
  let server: AnnotationServer;
  // Normalize once so rendered offsets and the raw markdown the page maps
  // selections against are guaranteed to use the same newlines.
  const markdown = normalizeMarkdown(options.markdown);
  try {
    const htmlContent = await readAnnotateHtml();
    server = await startAnnotationServer({
      markdown,
      renderedHtml: renderMarkdown(markdown),
      demoHtml: renderMarkdown(DEMO_MARKDOWN),
      demoMarkdown: DEMO_MARKDOWN,
      defaultTheme: DEFAULT_THEME,
      settings: UI_SETTINGS,
      htmlContent,
      mode: options.mode,
      sourceInfo: options.sourceInfo,
      gate: false,
    });
  } catch (err) {
    onError(`Annotation server failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    // On macOS, prefer a native Glimpse window and fall back to the browser.
    if (os.platform() === "darwin") {
      const glimpseOpenFn = await getGlimpseOpen();
      if (glimpseOpenFn) {
        try {
          const glimpseWin = openInGlimpse(
            glimpseOpenFn,
            server.url,
            `Annotate: ${options.sourceInfo}`,
          );
          ctx.ui.notify("Annotation window opened. Close it when you are done.", "info");

          // Closing the window resolves the decision directly, without relying
          // on an HTTP fetch from the page.
          let windowClosed = false;
          glimpseWin.on("closed", () => {
            windowClosed = true;
            server.resolveDecision({ action: "exit" });
          });

          const decision = await server.waitForDecision();
          // A window-close-triggered exit is silent.
          if (!(decision.action === "exit" && windowClosed)) {
            handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown, options.mode);
          }
          return;
        } catch (err) {
          ctx.ui.notify(
            `Glimpse failed, falling back to browser: ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
        }
      }
    }

    try {
      await openUrl(pi, server.url);
    } catch (err) {
      onError(
        `Failed to open annotation view: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const decision = await server.waitForDecision();
    handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, markdown, options.mode);
  } finally {
    server.stop();
  }
}

// ── Extension entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const openReview = registerReview(pi);
  // ── Command: /annotate-last ──────────────────────────────────────────

  pi.registerCommand("annotate-last", {
    description: "Annotate the last assistant message in this session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      return openReview(ctx, { last: true });
    },
  });

  // ── Command: /annotate <file> ────────────────────────────────────────

  pi.registerCommand("annotate", {
    description: "Review session changes or open a file or folder",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const filePath = args.trim().replace(/^@/, "");

      if (!filePath) {
        await openReview(ctx);
        return;
      }

      const absolutePath = resolve(ctx.cwd, filePath);

      if (!existsSync(absolutePath)) {
        ctx.ui.notify(`File not found: ${absolutePath}`, "error");
        return;
      }

      return openReview(ctx, { file: absolutePath });
    },
  });

  // ── Hook: auto-detect plan/spec documents (opt-in) ───────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!AUTO_DETECT_SUPERPOWERS) return;

    // Only inspect assistant messages.
    if (event.message.role !== "assistant") return;

    const parts = event.message.content.filter((c) => c.type === "text");
    const text = parts.map((c) => c.text).join("");
    if (!text) return;

    const matches = text.match(SUPERPOWERS_PATH_PATTERN);
    if (!matches || matches.length === 0) return;

    let foundPath: string | null = null;
    for (const match of matches) {
      const absolutePath = resolve(ctx.cwd, match);
      if (existsSync(absolutePath)) {
        foundPath = absolutePath;
        break;
      }
    }

    if (!foundPath) return;

    ctx.ui.notify("New plan document detected. Opening annotation view…", "info");

    await openReview(ctx, { file: foundPath });
  });
}
