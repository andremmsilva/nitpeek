import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { normalizeMarkdown, renderMarkdown } from "./markdown.js";
import { createTwoFilesPatch } from "diff";
import hljs from "highlight.js/lib/common";
import latex from "highlight.js/lib/languages/latex";

hljs.registerLanguage("latex", latex);
import type { Annotation } from "./server.js";

const MAX_FILE = 512 * 1024;
export type Snapshot = { text: string | null; error?: string };
type FileRecord = { path: string; before: Snapshot; after: Snapshot; requestBefore: Snapshot; request: number; external: boolean; manual?: boolean };
type Draft = { path: string; markdown: string; version: string; annotations: Annotation[] };
type ResponseRecord = { path: string; entryId: string; markdown: string; request: number };
type State = { request: number; files: Record<string, FileRecord>; drafts: Record<string, Draft>; responses?: Record<string, ResponseRecord>; latestResponse?: string; locations?: string[] };
const OMIT = new Set([".git", "node_modules", ".DS_Store"]);
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_SEARCH_ENTRIES = 12000;
class ReviewAccessError extends Error { statusCode = 403; }
function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
function fuzzyScore(query: string, value: string): number {
  query = query.toLowerCase(); value = value.toLowerCase();
  let at = 0, score = 0, previous = -2;
  for (const char of query) {
    const found = value.indexOf(char, at);
    if (found < 0) return -1;
    score += 1 + (found === previous + 1 ? 4 : 0) + (found === 0 || /[\/_. -]/.test(value[found - 1]) ? 5 : 0);
    previous = found; at = found + 1;
  }
  return score + (value.includes(query) ? 15 : 0) - value.length / 100;
}
export function snapshot(path: string): Snapshot {
  try {
    if (!existsSync(path)) return { text: null };
    if (!statSync(path).isFile() || statSync(path).size > MAX_FILE) return { text: null, error: "Not a regular text file, or exceeds 512 KiB" };
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return { text: null, error: "Binary file" };
    return { text: normalizeMarkdown(buffer.toString("utf8")) };
  } catch { return { text: null, error: "Unable to read file" }; }
}
function equal(a: Snapshot, b: Snapshot) { return a.text === b.text && a.error === b.error; }
function version(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 16); }
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export class ReviewStore {
  state: State = { request: 0, files: {}, drafts: {} };
  pending = new Map<string, { path: string; before: Snapshot; request: number }>();
  constructor(public cwd: string, public statePath: string, public sessionId: string) {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      if (parsed.schema === 1) this.state = parsed.state;
    }
  }
  save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = this.statePath + ".tmp";
    writeFileSync(temporary, JSON.stringify({ schema: 1, state: this.state }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
  nextRequest() { this.state.request++; this.save(); }
  private projectRoot() { return realpathSync(this.cwd); }
  private canonical(path: string) {
    const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(this.cwd, path);
    return realpathSync(expanded);
  }
  private roots() { return [this.projectRoot(), ...(this.state.locations ?? []).filter(existsSync)]; }
  private display(path: string) {
    // /tmp may resolve to /private/tmp on macOS. Normalize for display even
    // when a recorded file has since been deleted (its parent may still exist).
    let canonical = path;
    try { canonical = realpathSync(path); }
    catch { try { canonical = resolve(realpathSync(dirname(path)), basename(path)); } catch {} }
    return within(this.projectRoot(), canonical) ? relative(this.projectRoot(), canonical) || "." : canonical;
  }
  /** Explicit user action: remember a directory, or a file's parent and open that file. */
  addLocation(input: string) {
    if (typeof input !== "string" || !input.trim()) throw new Error("Enter a file or folder path");
    let path: string;
    try { path = this.canonical(input.trim()); }
    catch { throw new Error("Path not found or not readable: " + input); }
    const stat = statSync(path);
    const folder = stat.isDirectory() ? path : dirname(path);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("Not a regular file or directory");
    if (folder !== this.projectRoot()) {
      this.state.locations = [folder, ...(this.state.locations ?? []).filter(p => p !== folder)].slice(0, 12);
      this.save();
    }
    return { directory: folder, file: stat.isFile() ? this.addFile(path) : null };
  }
  /** Paths from browser requests must stay in a deliberately selected root. */
  private allowed(path: string) {
    let canonical: string;
    try { canonical = this.canonical(path); }
    catch { throw new Error("Path not found or not readable"); }
    if (!this.roots().some(root => within(root, canonical))) throw new ReviewAccessError("Location not opened in this session");
    return canonical;
  }
  browse(input: string) {
    const directory = this.allowed(input || this.projectRoot());
    if (!statSync(directory).isDirectory()) throw new Error("Not a directory");
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(e => !OMIT.has(e.name) && (e.isDirectory() || e.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { directory, entries: entries.slice(0, MAX_DIRECTORY_ENTRIES).map(e => ({ name: e.name, path: resolve(directory, e.name), directory: e.isDirectory() })), truncated: entries.length > MAX_DIRECTORY_ENTRIES };
  }
  search(query: string) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) return { results: [], exact: null, truncated: false };
    query = query.trim();
    // A path is an explicit navigation request, not a fuzzy filename query.
    // Probing the literal path does not add it to the browsable roots; only a
    // subsequent click/Enter on the suggestion does that.
    let exact: { path: string; label: string; kind: "folder" | "file" } | null = null;
    if (query.startsWith("/") || query.startsWith("~/") || query.startsWith("./") || query.includes("/")) {
      try {
        const path = this.canonical(query);
        const stat = statSync(path);
        if (stat.isDirectory() || stat.isFile()) exact = { path, label: `${stat.isDirectory() ? "Open folder" : "Open file"} · ${query}`, kind: stat.isDirectory() ? "folder" : "file" };
      } catch { /* An incomplete path can still be a fuzzy query. */ }
    }
    // Absolute paths are navigational prefixes, not subsequence patterns
    // spanning unrelated directories ("/tmp/" should not match "/tmpish/").
    let absolutePrefix: string | null = null;
    if (query.startsWith("/")) {
      try { absolutePrefix = this.canonical(query); }
      catch {
        try { absolutePrefix = resolve(this.canonical(dirname(query)), basename(query)); }
        catch { absolutePrefix = resolve(query); }
      }
    }
    const results: { path: string; label: string; score: number; registered: boolean }[] = [];
    const seen = new Set<string>();
    const consider = (path: string, registered = false) => {
      if (seen.has(path)) return;
      seen.add(path);
      const label = this.display(path);
      if (absolutePrefix) {
        let canonical: string;
        try { canonical = this.canonical(path); } catch { return; }
        if (query.endsWith("/") ? !within(absolutePrefix, canonical) : !canonical.startsWith(absolutePrefix)) return;
      }
      const nameScore = fuzzyScore(query, basename(path));
      const pathScore = fuzzyScore(query, label);
      const score = absolutePrefix ? 20 - label.length / 100 : Math.max(nameScore < 0 ? -1 : nameScore + 25, pathScore);
      if (score >= 0) results.push({ path, label, score: score + (registered ? 20 : 0), registered });
    };
    for (const file of Object.keys(this.state.files)) if (existsSync(file)) consider(file, true);
    const stack = absolutePrefix ? this.roots().filter(root => within(root, absolutePrefix) || within(absolutePrefix, root)) : [...this.roots()];
    const visited = new Set<string>();
    let scanned = 0;
    const deadline = Date.now() + 350;
    while (stack.length && scanned < MAX_SEARCH_ENTRIES && Date.now() < deadline) {
      const directory = stack.pop()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (scanned++ >= MAX_SEARCH_ENTRIES) break;
        if (OMIT.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) consider(path, !!this.state.files[path]);
      }
    }
    results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    return { results: results.slice(0, 50).map(({ score, ...item }) => item), exact, truncated: !!stack.length || scanned >= MAX_SEARCH_ENTRIES };
  }
  openBrowsableFile(path: string) {
    // Previously recorded files outside the project are already trusted sources.
    const canonical = this.state.files[path] ? this.canonical(path) : this.allowed(path);
    if (!statSync(canonical).isFile()) throw new Error("Not a file");
    return this.addFile(canonical);
  }
  addFile(path: string) {
    path = resolve(this.cwd, path.replace(/^@/, ""));
    if (!this.state.files[path]) {
      const content = snapshot(path);
      if (content.error || content.text === null) throw new Error(content.error || "File not found: " + path);
      this.state.files[path] = { path, before: content, after: content, requestBefore: content, request: this.state.request, external: false, manual: true };
      this.save();
    }
    return path;
  }
  response(entryId: string, text: string, request = this.state.request) {
    if (!text.trim()) return;
    const path = "message:" + entryId;
    this.state.responses ??= {};
    this.state.responses[path] ??= { path, entryId, markdown: normalizeMarkdown(text), request };
    this.state.latestResponse = path;
    // Keep immutable snapshots: an older response may still be open in the UI.
    this.save();
    return path;
  }
  begin(id: string, path: string) {
    path = resolve(this.cwd, path.replace(/^@/, ""));
    this.pending.set(id, { path, before: snapshot(path), request: this.state.request });
  }
  end(id: string, failed: boolean) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || failed) return;
    this.record(pending.path, pending.before, snapshot(pending.path), pending.request);
  }
  /** Record one completed mutation whose before/after contents are already known. */
  record(path: string, before: Snapshot, after: Snapshot, request = this.state.request) {
    path = resolve(this.cwd, path.replace(/^@/, ""));
    if (equal(before, after)) return;
    const previous = this.state.files[path]?.manual ? undefined : this.state.files[path];
    this.state.files[path] = {
      path, before: previous?.before ?? before, after,
      requestBefore: previous?.request === request ? previous.requestBefore : before,
      request,
      // Parallel sibling calls may share a preflight snapshot. Only flag an
      // external mismatch when it differs from both known request baselines.
      external: !!previous?.external || (!!previous && !equal(previous.after, before) && !(previous.request === request && equal(previous.requestBefore, before))),
    };
    this.save();
  }
  list() {
    return { sessionId: this.sessionId, request: this.state.request,
      roots: [{ path: this.projectRoot(), label: `Project · ${basename(this.projectRoot())}` }, ...(this.state.locations ?? []).filter(p => existsSync(p) && p !== this.projectRoot()).map(p => ({ path: p, label: `Folder · ${basename(dirname(p))}/${basename(p)}` }))],
      responses: Object.values(this.state.responses ?? {}).filter(r => r.path === this.state.latestResponse || this.state.drafts[r.path]?.annotations.length).map(r => ({ path: r.path, label: r.path === this.state.latestResponse ? "💬 Agent response" : "💬 Earlier response · pending notes", latest: r.request === this.state.request, newest: r.path === this.state.latestResponse, notes: this.state.drafts[r.path]?.annotations.length ?? 0 })),
      files: Object.values(this.state.files).map(f => ({
      path: f.path, label: this.display(f.path), latest: f.request === this.state.request,
      external: f.external, error: f.after.error, manual: !!f.manual,
      notes: this.state.drafts[f.path]?.annotations.length ?? 0,
    })) };
  }
  document(path: string, scope: string) {
    const response = this.state.responses?.[path];
    if (response) {
      const draft = this.state.drafts[path];
      const markdown = response.markdown;
      return { kind: "response", plan: markdown, planHtml: renderMarkdown(markdown), isMarkdown: true, recorded: false, stale: false, sourceInfo: "Agent response · " + response.entryId, path, version: version(markdown), annotations: draft?.annotations ?? [], patch: null, warning: path !== this.state.latestResponse ? "Earlier response — preserved for your notes." : null };
    }
    const file = this.state.files[path];
    if (!file) throw new Error("File is not registered in this session");
    const live = snapshot(path);
    const draft = this.state.drafts[path];
    const markdown = draft?.annotations.length ? draft.markdown : live.text ?? "";
    const stale = !!draft?.annotations.length && markdown !== live.text;
    const before = scope === "request" ? file.requestBefore : file.before;
    const isMarkdown = /\.(md|markdown|mdown)$/i.test(path);
    const language = ({ json: "json", jsonl: "json", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", bash: "bash", css: "css", html: "xml", xml: "xml", yaml: "yaml", yml: "yaml", sql: "sql", go: "go", rs: "rust", java: "java", tex: "latex", latex: "latex" } as Record<string, string>)[path.split(".").at(-1)?.toLowerCase() ?? ""];
    const code = language && markdown.length <= 65536 && hljs.getLanguage(language) ? hljs.highlight(markdown, { language, ignoreIllegals: true }).value : escape(markdown);
    const planHtml = isMarkdown ? renderMarkdown(markdown) : `<pre class="md-block" data-offset-start="0" data-offset-end="${markdown.length}"><code class="hljs">${code}</code></pre>`;
    const patch = file.manual ? null : before.error || file.after.error ? "Diff unavailable for unsupported files." : createTwoFilesPatch(path, path, before.text ?? "", file.after.text ?? "", before.text === null ? "created" : "before", "after", { context: 4, timeout: 200, maxEditLength: 20000 }) ?? "Diff too large to compute safely.";
    return { kind: "file", plan: markdown, planHtml, isMarkdown, recorded: !file.manual, stale, sourceInfo: this.display(path), path, version: version(markdown), annotations: draft?.annotations ?? [], patch,
      warning: live.error || (stale ? "New version available. These notes refer to the frozen version below; send or remove them before refreshing." : !equal(live, file.after) ? "The file changed outside the recorded operations. Document shows disk content; diff shows recorded operations." : file.external ? "Uncaptured changes were detected between recorded operations." : null),
    };
  }
  diskComparison(path: string) {
    if (!this.state.files[path]) throw new Error("File is not registered in this session");
    const draft = this.state.drafts[path];
    if (!draft?.annotations.length) throw new Error("No frozen annotated version to compare");
    const live = snapshot(path);
    if (live.error || live.text === null) return { patch: null, error: live.error || "File no longer exists on disk" };
    return { patch: createTwoFilesPatch(path, path, draft.markdown, live.text, "annotated snapshot", "disk now", { context: 4, timeout: 200, maxEditLength: 20000 }) ?? "Comparison too large to compute safely.", error: null };
  }
  draft(payload: any) {
    const { path, markdown, annotations } = payload ?? {};
    if (typeof path !== "string" || (!this.state.files[path] && !this.state.responses?.[path]) || typeof markdown !== "string" || Buffer.byteLength(markdown) > MAX_FILE || !Array.isArray(annotations) || annotations.length > 500) throw new Error("Invalid draft");
    if (this.state.responses?.[path] && markdown !== this.state.responses[path].markdown) throw new Error("Response snapshot mismatch");
    for (const a of annotations) {
      if (a?.selectedText !== undefined && typeof a.selectedText !== "string") throw new Error("Invalid selected text");
      if (!a || typeof a.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(a.id) || !["comment", "suggestion", "issue", "praise"].includes(a.type) || typeof a.text !== "string" || typeof a.originalText !== "string" || !Number.isInteger(a.range?.startOffset) || !Number.isInteger(a.range?.endOffset) || a.range.startOffset < 0 || a.range.endOffset < a.range.startOffset || a.range.endOffset > markdown.length) throw new Error("Invalid annotation");
    }
    if (annotations.length) this.state.drafts[path] = { path, markdown, version: version(markdown), annotations };
    else delete this.state.drafts[path];
    this.save();
    return { ok: true };
  }
  feedback() {
    const drafts = Object.values(this.state.drafts).filter(d => d.annotations.length);
    if (!drafts.length) return "";
    return "## Annotation feedback\n\n" + drafts.map(d => {
      const response = this.state.responses?.[d.path];
      const stale = !response && snapshot(d.path).text !== d.markdown;
      const title = response ? `About your response (message ${response.entryId})` : this.display(d.path);
      return `### ${title}\n\n${stale ? "The file has changed since the annotated version; locate the quoted text before editing.\n\n" : ""}` + d.annotations.map((a, i) => {
        const line = d.markdown.slice(0, a.range.startOffset).split("\n").length;
        const selected = typeof a.selectedText === "string" ? a.selectedText : d.markdown.slice(a.range.startOffset, a.range.endOffset);
        const quote = selected.split("\n").map(l => "> " + l).join("\n");
        return `${i + 1}. [${a.type.toUpperCase()}]${response ? "" : ` Line ${line} in reviewed snapshot`}\n\n${quote}\n\n${a.text}`;
      }).join("\n\n");
    }).join("\n\n") + "\n\nPlease address the feedback above.";
  }
  clearDrafts() { this.state.drafts = {}; this.save(); }
}
