/**
 * One review workspace: a ReviewStore served to the browser UI, plus the host
 * (Pi, Claude Code…) that receives the finished notes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type ServerHandle } from "./server.js";
import { SettingsStore } from "./settings.js";
import { BlobStore } from "./snapshot.js";
import type { ReviewStore, Scope } from "./store.js";

export const NITPEEK_HOME = process.env.NITPEEK_HOME || join(homedir(), ".nitpeek");
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const settingsStore = () => new SettingsStore(join(NITPEEK_HOME, "settings.json"), join(homedir(), ".pi", "agent", "annotate", "settings.json"));
export const blobStore = () => new BlobStore(join(NITPEEK_HOME, "blobs"));

export interface Host {
  /** "Pi", "Claude"… */
  name: string;
  /** Where the notes go, shown before confirming Done. */
  deliveryNote(): string;
  /** Put the notes in the agent's prompt without sending; returns a status line. */
  deliver(feedback: string): Promise<string>;
}

export type Target = { path?: string; folder?: string };

export interface Workspace {
  url: string;
  stop(): void;
  /** Ask the open tab to show a document or folder. */
  focus(target?: Target): void;
  /** True while a browser tab polled recently. */
  isOpen(): boolean;
}

function assets() {
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  return {
    html: read("ui/index.html"),
    assets: {
      "/app.js": { type: "text/javascript; charset=utf-8", body: read("dist/app.js") },
      "/app.css": { type: "text/css; charset=utf-8", body: read("dist/app.css") },
    },
  };
}

const scopeOf = (value: string | null): Scope => value === "since" || value === "session" || /^request:\d+$/.test(value ?? "") ? value as Scope : "session";

export async function startWorkspace(store: ReviewStore, host: Host, options: { demo?: boolean } = {}): Promise<Workspace> {
  let focus = 0, target: Target = {}, lastSeen = 0;
  let server: ServerHandle | undefined = undefined;
  const { html, assets: files } = assets();
  server = await startServer({
    html, assets: files, settings: settingsStore(),
    bootstrap: { host: host.name, demo: !!options.demo },
    workspace: async (route, method, url, body: any) => {
      const q = (name: string) => url.searchParams.get(name) ?? "";
      if (method === "GET" && route === "/api/review/overview") {
        lastSeen = Date.now();
        return { ...store.overview(), host: host.name, demo: !!options.demo, focus, target };
      }
      if (method === "GET" && route === "/api/review/document") return store.document(q("path"), scopeOf(q("scope")));
      if (method === "GET" && route === "/api/review/stat") return store.liveRef(q("path"));
      if (method === "POST" && route === "/api/review/general") return store.setGeneral(body?.text);
      if (method === "POST" && route === "/api/review/notes") return store.saveNotes(body?.path, body?.notes);
      if (method === "GET" && route === "/api/review/browse") return store.browse(q("path"));
      if (method === "GET" && route === "/api/review/search") return store.search(q("q"));
      if (method === "POST" && route === "/api/review/location") return store.addLocation(body?.path);
      if (method === "POST" && route === "/api/review/open-file") return { path: store.openBrowsableFile(body?.path) };
      if (method === "GET" && route === "/api/review/preview") return { feedback: store.feedback(), deliveryNote: host.deliveryNote() };
      if (method === "POST" && route === "/api/review/done") {
        const feedback = store.feedback();
        if (!feedback) return { ok: true, message: "No notes to send." };
        const message = await host.deliver(feedback);
        store.clearDrafts();
        store.checkpoint();
        return { ok: true, message };
      }
      if (method === "POST" && route === "/api/review/closed") { lastSeen = 0; return { ok: true }; }
      throw Object.assign(new Error("Unknown review route"), { statusCode: 404 });
    },
  });
  return {
    url: server.url,
    stop: () => server?.stop(),
    focus: next => { focus++; target = next ?? {}; },
    isOpen: () => Date.now() - lastSeen < 15000,
  };
}
