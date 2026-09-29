/**
 * TikZ pictures, compiled to SVG by a WebAssembly TeX (node-tikzjax).
 *
 * Rendering a document only registers each picture and emits an atomic
 * element whose text is the picture's source (like formulas, see math.ts).
 * The page then asks for the SVG. Compilation runs in a separate process, one
 * at a time, with a timeout, and results (errors too) are cached on disk.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashText } from "./snapshot.js";

export type TikzResult = { svg?: string; error?: string };

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "tikz-worker.mjs");
const TIMEOUT = 30_000;
export const tikzCache = () => join(process.env.NITPEEK_HOME || join(homedir(), ".nitpeek"), "tikz");

/** Pictures seen by this process, by key: compiled on demand. */
const jobs = new Map<string, { source: string; preamble: string }>();
const inflight = new Map<string, Promise<TikzResult>>();
let queue: Promise<unknown> = Promise.resolve();

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The atomic element for a picture. `source` is its exact text in the document;
 * `document` is the standalone TeX body to compile (with \begin{document}).
 */
export function tikzHtml(source: string, preamble: string, document = `\\begin{document}\n${source}\n\\end{document}`): string {
  const key = hashText(preamble + "\n\u0000\n" + document);
  jobs.set(key, { source: document, preamble });
  return `<span class="np-math display np-tikz" data-tikz="${key}">${escapeHtml(source)}</span>`;
}

/** A Markdown ```tikz block: a bare picture, or a small document with its own preamble. */
export function tikzFence(code: string): string {
  const begin = code.indexOf("\\begin{document}");
  if (begin >= 0) return tikzHtml(code, code.slice(0, begin), code.slice(begin));
  return tikzHtml(code, "", /\\begin\{/.test(code) ? `\\begin{document}\n${code}\n\\end{document}` : `\\begin{document}\n\\begin{tikzpicture}\n${code}\n\\end{tikzpicture}\n\\end{document}`);
}

export function tikzSvg(key: string): Promise<TikzResult> {
  if (!/^[0-9a-f]{32}$/.test(key)) return Promise.resolve({ error: "Unknown picture" });
  const file = join(tikzCache(), key + ".json");
  if (existsSync(file)) {
    try {
      const now = new Date();
      utimesSync(file, now, now); // keeps it from the retention sweep
      return Promise.resolve(JSON.parse(readFileSync(file, "utf8")));
    } catch {}
  }
  const job = jobs.get(key);
  if (!job) return Promise.resolve({ error: "Reload the document to compile this picture" });
  let running = inflight.get(key);
  if (!running) {
    // node-tikzjax must not run concurrently: one compile at a time.
    running = queue.then(() => compile(job)).then(result => {
      mkdirSync(tikzCache(), { recursive: true, mode: 0o700 });
      writeFileSync(file + ".tmp", JSON.stringify(result), { mode: 0o600 });
      renameSync(file + ".tmp", file);
      return result;
    }, error => ({ error: String(error?.message ?? error) }));
    queue = running.catch(() => {});
    inflight.set(key, running);
    running.finally(() => inflight.delete(key));
  }
  return running;
}

function compile(job: { source: string; preamble: string }): Promise<TikzResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ error: "TikZ compilation took longer than 30 s" }); }, TIMEOUT);
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", error => { clearTimeout(timer); resolve({ error: error.message }); });
    child.on("close", () => {
      clearTimeout(timer);
      const at = out.lastIndexOf("@@nitpeek@@");
      try { resolve(at >= 0 ? JSON.parse(out.slice(at + 11)) : { error: "TikZ compiler crashed" }); }
      catch { resolve({ error: "TikZ compiler returned garbage" }); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}
