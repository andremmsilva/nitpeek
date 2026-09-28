/**
 * Local HTTP server for the review UI.
 *
 * Binds to 127.0.0.1 on an ephemeral port. Every /api/* route requires the
 * per-server token embedded in the page; non-loopback Host headers are
 * rejected, which makes DNS rebinding useless. Framing is denied.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { SettingsStore } from "./settings.js";

export type Asset = { type: string; body: string | Buffer };

export interface ServerOptions {
  /** Page template; `__NITPEEK_DATA__` is replaced by the bootstrap JSON. */
  html: string;
  assets?: Record<string, Asset>;
  bootstrap?: Record<string, unknown>;
  settings?: SettingsStore;
  /** Authenticated /api/review/* requests. */
  workspace: (route: string, method: string, url: URL, body: unknown) => unknown | Promise<unknown>;
}

export interface ServerHandle { url: string; token: string; stop: () => void }

const MAX_BODY_SIZE = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

/** Only accept requests addressed to a loopback host (anti DNS-rebinding). */
export function isLoopbackHost(host: string | undefined): boolean {
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

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, payload: unknown) => send(res, status, "application/json", JSON.stringify(payload));

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "", size = 0, done = false;
    const timer = setTimeout(() => { done = true; req.destroy(); reject(new HttpError(408, "Request timeout")); }, REQUEST_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { clearTimeout(timer); done = true; req.destroy(); reject(new HttpError(413, "Request body too large")); return; }
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (done) return;
      clearTimeout(timer);
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(new HttpError(400, `Invalid JSON: ${err instanceof Error ? err.message : err}`)); }
    });
    req.on("error", err => { clearTimeout(timer); reject(err); });
  });
}

/** JSON safe to embed in an inline <script type="application/json">. */
export function inlineJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { ok: false, error: "Forbidden" });
      if (url.pathname.startsWith("/api/") && req.headers["x-nitpeek-token"] !== token) return sendJson(res, 403, { ok: false, error: "Forbidden" });

      if (method === "GET" && url.pathname === "/") {
        const data = inlineJson({ token, settings: options.settings?.read() ?? null, ...options.bootstrap });
        return send(res, 200, "text/html; charset=utf-8", options.html.replace("__NITPEEK_DATA__", () => data));
      }
      const asset = method === "GET" ? options.assets?.[url.pathname] : undefined;
      if (asset) return send(res, 200, asset.type, asset.body);

      if (url.pathname === "/api/settings" && options.settings) {
        if (method === "GET") return sendJson(res, 200, options.settings.read());
        if (method === "POST") return sendJson(res, 200, options.settings.update(await parseJsonBody(req)));
        return sendJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/review/")) {
        const body = method === "POST" ? await parseJsonBody(req) : undefined;
        return sendJson(res, 200, await options.workspace(url.pathname, method, url, body));
      }
      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Failed to get server address"));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    stop: () => { server.close(); server.closeAllConnections(); },
  };
}
