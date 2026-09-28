/**
 * Local annotation HTTP server.
 *
 * Binds to 127.0.0.1 on an ephemeral port and requires a per-session token on
 * every /api/* route. Non-loopback Host headers are rejected to make DNS
 * rebinding useless.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AnnotateSettingsStore, DEFAULT_ANNOTATE_SETTINGS } from "./settings.js";

export interface Annotation {
  id: string;
  type: "comment" | "suggestion" | "issue" | "praise";
  text: string;
  originalText: string;
  /** Full browser selection, independent of approximate source-location offsets. */
  selectedText?: string;
  range: {
    startOffset: number;
    endOffset: number;
    textPreview: string;
  };
  createdAt: number;
}

interface AnnotationServerOptions {
  markdown: string;
  /** Pre-rendered HTML for `markdown`, including selection-mapping offsets. */
  renderedHtml: string;
  /** Pre-rendered HTML for the demo document. */
  demoHtml?: string;
  /** Raw demo markdown, kept so demo-mode selections still map to source. */
  demoMarkdown?: string;
  /** Fallback theme choice; "system" follows the browser's OS color preference. */
  defaultTheme?: string;
  htmlContent: string;
  mode: "annotate" | "annotate-last";
  sourceInfo?: string;
  gate?: boolean;
  /** Persistent user preferences, independent of this server's ephemeral port. */
  settings?: AnnotateSettingsStore;
  /** Persistent session workspace. Only authenticated /api/review/* requests reach it. */
  workspace?: (route: string, method: string, url: URL, body: unknown) => unknown | Promise<unknown>;
}

interface AnnotationServerHandle {
  url: string;
  stop: () => void;
  waitForDecision: () => Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>;
  resolveDecision: (result: {
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }) => void;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30000;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

class BodyTooLargeError extends Error {
  statusCode = 413;
}

class RequestTimeoutError extends Error {
  statusCode = 408;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

/** Only accept requests addressed to a loopback host (anti DNS-rebinding). */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    hostname = end >= 0 ? hostname.slice(0, end + 1) : hostname;
  } else {
    const colon = hostname.lastIndexOf(":");
    if (colon >= 0) hostname = hostname.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(hostname);
}

function requestToken(req: IncomingMessage): string {
  const value = req.headers["x-annotation-token"];
  return typeof value === "string" ? value : "";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new RequestTimeoutError("Request timeout"));
    }, REQUEST_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy();
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      body += chunk.toString("utf-8");
    });

    req.on("end", () => {
      if (timedOut) return;
      clearTimeout(timer);
      if (body.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Invalid JSON: ${message}`));
      }
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * JSON for embedding inside the page's `JSON.parse('...')` call.
 *
 * The value is escaped for the surrounding JS string literal first (backslashes
 * and quotes must survive as JSON escapes — otherwise a JSON `\n` becomes a
 * real newline and JSON.parse fails), then `<`, `>`, `&` are escaped so the
 * payload cannot break out of the script tag.
 */
function safeInlineJSON(data: unknown): string {
  return JSON.stringify(data)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export async function startAnnotationServer(
  options: AnnotationServerOptions
): Promise<AnnotationServerHandle> {
  const { markdown, renderedHtml, demoHtml, demoMarkdown, defaultTheme, htmlContent, mode, sourceInfo, gate } =
    options;
  const sessionToken = randomUUID();

  let resolved = false;
  let resolveDecision!: (result: {
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }) => void;
  const decisionPromise = new Promise<{
    action: "feedback" | "approve" | "exit";
    feedback?: string;
    annotations?: Annotation[];
  }>((resolve) => {
    resolveDecision = resolve;
  });

  const resolveOnce = (
    result: {
      action: "feedback" | "approve" | "exit";
      feedback?: string;
      annotations?: Annotation[];
    }
  ): void => {
    if (resolved) return;
    resolved = true;
    resolveDecision(result);
  };

  let lastActivity = Date.now();

  const server = createServer(async (req, res) => {
    lastActivity = Date.now();
    try {
      const method = req.method ?? "GET";
      const url = requestUrl(req);

      if (!isLoopbackHost(req)) {
        sendJson(res, 403, { ok: false, error: "Forbidden" });
        return;
      }

      if (url.pathname.startsWith("/api/") && requestToken(req) !== sessionToken) {
        sendJson(res, 403, { ok: false, error: "Forbidden" });
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        const inlineData = safeInlineJSON({
          sessionToken,
          workspace: !!options.workspace,
          mode,
          sourceInfo: sourceInfo ?? null,
          gate: gate ?? false,
          startedAt: Date.now(),
          defaultTheme: defaultTheme ?? "system",
          settings: options.settings?.read() ?? { ...DEFAULT_ANNOTATE_SETTINGS },
          settingsInitialized: options.settings?.isInitialized() ?? true,
          demoMarkdown: demoMarkdown ?? "",
          demoHtml: demoHtml ?? "",
        });
        const html = htmlContent.replace("__ANNOTATE_DATA__", inlineData);
        sendHtml(res, html);
        return;
      }

      if (url.pathname === "/api/settings") {
        if (!options.settings) {
          sendJson(res, 503, { ok: false, error: "Settings storage unavailable" });
          return;
        }
        if (method === "GET") {
          sendJson(res, 200, options.settings.read());
          return;
        }
        if (method === "POST") {
          const body = await parseJsonBody(req);
          sendJson(res, 200, options.settings.update(body));
          return;
        }
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (options.workspace && url.pathname.startsWith("/api/review/")) {
        const body = method === "POST" ? await parseJsonBody(req) : undefined;
        const result = await options.workspace(url.pathname, method, url, body);
        sendJson(res, 200, result);
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/api/plan") {
        sendJson(res, 200, {
          plan: markdown,
          planHtml: renderedHtml,
          mode,
          sourceInfo: sourceInfo ?? null,
          gate: gate ?? false,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/feedback") {
        let body: unknown;
        try {
          body = await parseJsonBody(req);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, 413, { ok: false, error: "Request body too large" });
            return;
          }
          if (err instanceof RequestTimeoutError) {
            sendJson(res, 408, { ok: false, error: "Request timeout" });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { ok: false, error: message });
          return;
        }

        const payload = body as Record<string, unknown>;
        const feedback = typeof payload.feedback === "string" ? payload.feedback : "";
        const annotations = Array.isArray(payload.annotations) ? payload.annotations as Annotation[] : [];

        resolveOnce({
          action: "feedback",
          feedback,
          annotations,
        });

        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/approve") {
        // Body is ignored for approve
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "approve" });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/exit") {
        // Body is ignored for exit
        try {
          await parseJsonBody(req);
        } catch {
          // Ignore parse errors — body is optional
        }

        resolveOnce({ action: "exit" });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      sendJson(res, status, { ok: false, error: message });
    }
  });

  let port = 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      server.removeAllListeners("error");
      port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resolve(address.port);
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  const url = `http://127.0.0.1:${port}`;

  // Stale timeout: auto-exit when idle for too long
  const staleTimer = setInterval(() => {
    if (resolved) {
      clearInterval(staleTimer);
      return;
    }
    if (!options.workspace && Date.now() - lastActivity > STALE_TIMEOUT_MS) {
      resolveOnce({ action: "exit" });
      clearInterval(staleTimer);
    }
  }, 30000);

  const activeConnections = new Set<IncomingMessage>();
  server.on("connection", (socket) => {
    const req = socket as unknown as IncomingMessage;
    activeConnections.add(req);
    socket.on("close", () => {
      activeConnections.delete(req);
    });
  });

  const handle: AnnotationServerHandle = {
    url,
    stop: () => {
      clearInterval(staleTimer);
      server.close();
      server.closeAllConnections();
    },
    waitForDecision: () => decisionPromise,
    resolveDecision: resolveOnce,
  };

  return handle;
}
