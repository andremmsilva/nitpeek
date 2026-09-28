/**
 * Session review state: a timeline of user requests, the file changes and
 * responses each produced, the user's notes, and the "last Done" checkpoint.
 *
 * File versions live in a content-addressed BlobStore; this state only keeps
 * references, so per-request history stays cheap.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { buildDiff, diffStat, highlightLines, isMarkdownPath, languageOf, renderMarkdown, type Diff } from "./render.js";
import { BlobStore, hashText, normalize, readSnapshot, sameRef, type SnapRef, type Snapshot } from "./snapshot.js";
import { formatFeedback, type FeedbackItem } from "./feedback.js";

export type Intent = "change" | "ask" | "keep" | "replace";
export const INTENTS: Intent[] = ["change", "ask", "keep", "replace"];

export type Note = {
  id: string;
  intent: Intent;
  text: string;
  /** Replacement text for `replace` notes. */
  replacement?: string;
  /** The selected text exactly as displayed. */
  quote: string;
  /** Raw source slice, when the rendered selection mapped onto source verbatim. */
  source?: string;
  /** A little text before and after the quote, to find it again after edits. */
  prefix?: string;
  suffix?: string;
  /** Offsets into the annotated version's text (approximate for rendered Markdown). */
  start: number;
  end: number;
  view: "document" | "diff";
  side?: "old" | "new";
  /** Hash of the exact text version the note was made on. */
  ref: string | null;
  createdAt: number;
};

type Change = { before: SnapRef; after: SnapRef; added: number; removed: number };
type RequestRecord = { id: number; prompt: string; at: number; changes: Record<string, Change> };
type ResponseRecord = { path: string; entryId: string; markdown: string; request: number; at: number };
type FileRecord = { path: string; manual?: boolean; external?: boolean };
type Checkpoint = { at: number; request: number; versions: Record<string, SnapRef>; responses: string[] };
type State = {
  schema: 2;
  requests: RequestRecord[];
  files: Record<string, FileRecord>;
  responses: Record<string, ResponseRecord>;
  latestResponse?: string;
  drafts: Record<string, Note[]>;
  locations?: string[];
  checkpoint?: Checkpoint;
  activity?: { state: Activity; since: number };
};

export type Activity = "working" | "idle" | "blocked";
export type Scope = "since" | "session" | `request:${number}`;

const OMIT = new Set([".git", "node_modules", ".DS_Store"]);
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_SEARCH_ENTRIES = 12000;
const MAX_NOTES = 500;

export class ReviewAccessError extends Error { statusCode = 403; }
export class ValidationError extends Error { statusCode = 400; }

export function within(root: string, path: string) {
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

const emptyState = (): State => ({ schema: 2, requests: [{ id: 0, prompt: "", at: Date.now(), changes: {} }], files: {}, responses: {}, drafts: {} });

export class ReviewStore {
  state: State = emptyState();
  /** Pi-style capture: before-snapshots of in-flight tool calls. */
  pending = new Map<string, { path: string; before: Snapshot }>();
  private statCache = new Map<string, { added: number; removed: number }>();

  constructor(public cwd: string, public statePath: string, public sessionId: string, public blobs: BlobStore) {
    if (existsSync(statePath)) {
      try {
        const saved = JSON.parse(readFileSync(statePath, "utf8"));
        if (saved?.schema === 2) this.state = saved;
      } catch { /* unreadable state starts fresh */ }
    }
  }

  save() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.statePath + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.statePath + ".tmp", this.statePath);
  }

  get request() { return this.state.requests.at(-1)!; }

  // ── Capture ──────────────────────────────────────────────────────────

  nextRequest(prompt = "") {
    this.state.requests.push({ id: this.request.id + 1, prompt: prompt.trim().slice(0, 2000), at: Date.now(), changes: {} });
    this.save();
  }

  setActivity(state: Activity) {
    if (this.state.activity?.state === state) return;
    this.state.activity = { state, since: Date.now() };
    this.save();
  }

  begin(id: string, path: string) {
    path = this.resolvePath(path);
    this.pending.set(id, { path, before: readSnapshot(path) });
  }

  end(id: string, failed: boolean) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending && !failed) this.record(pending.path, pending.before, readSnapshot(pending.path));
  }

  /** Latest recorded version of a path, before the current capture. */
  private lastAfter(path: string): SnapRef | undefined {
    for (let i = this.state.requests.length - 1; i >= 0; i--) {
      const change = this.state.requests[i].changes[path];
      if (change) return change.after;
    }
  }

  /** Record one completed mutation whose before/after contents are known. */
  record(path: string, before: Snapshot, after: Snapshot) {
    path = this.resolvePath(path);
    if (before.text === after.text && before.error === after.error) return;
    const beforeRef = this.blobs.put(before), afterRef = this.blobs.put(after);
    const previous = this.lastAfter(path);
    const change = this.request.changes[path];
    // Parallel calls in one request may share a preflight snapshot; only flag
    // an uncaptured change when `before` matches no known version.
    const external = !!previous && !sameRef(previous, beforeRef) && !(change && sameRef(change.before, beforeRef));
    if (change) change.after = afterRef;
    else this.request.changes[path] = { before: beforeRef, after: afterRef, added: 0, removed: 0 };
    const current = this.request.changes[path];
    Object.assign(current, this.stat(current.before, current.after));
    this.state.files[path] = { path, ...(this.state.files[path]?.external || external ? { external: true } : {}) };
    this.save();
  }

  /** Latest recorded text of a path, if it was ever captured. */
  latestText(path: string): string | null | undefined {
    const ref = this.lastAfter(this.resolvePath(path));
    return ref ? this.blobs.get(ref).text : undefined;
  }

  response(entryId: string, text: string, request = this.request.id) {
    if (!text.trim()) return;
    const path = "message:" + entryId;
    // Immutable: an older response may still be open with notes.
    this.state.responses[path] ??= { path, entryId, markdown: normalize(text), request, at: Date.now() };
    this.state.latestResponse = path;
    this.save();
    return path;
  }

  // ── Paths, browsing and search ───────────────────────────────────────

  private resolvePath(path: string) { return resolve(this.cwd, path.replace(/^@/, "")); }
  private projectRoot() { try { return realpathSync(this.cwd); } catch { return this.cwd; } }
  private canonical(path: string) {
    const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(this.cwd, path);
    return realpathSync(expanded);
  }
  private roots() { return [this.projectRoot(), ...(this.state.locations ?? []).filter(existsSync)]; }

  /** Project-relative label, or the absolute path outside the project. */
  display(path: string) {
    let canonical = path;
    try { canonical = realpathSync(path); }
    catch { try { canonical = resolve(realpathSync(dirname(path)), basename(path)); } catch {} }
    return within(this.projectRoot(), canonical) ? relative(this.projectRoot(), canonical) || "." : canonical;
  }

  /** Explicit user action: remember a directory, or a file's parent and open that file. */
  addLocation(input: string) {
    if (typeof input !== "string" || !input.trim()) throw new ValidationError("Enter a file or folder path");
    let path: string;
    try { path = this.canonical(input.trim()); }
    catch { throw new ValidationError("Path not found or not readable: " + input); }
    const stat = statSync(path);
    if (!stat.isDirectory() && !stat.isFile()) throw new ValidationError("Not a regular file or directory");
    const folder = stat.isDirectory() ? path : dirname(path);
    if (folder !== this.projectRoot()) {
      this.state.locations = [folder, ...(this.state.locations ?? []).filter(p => p !== folder)].slice(0, 12);
      this.save();
    }
    return { directory: folder, file: stat.isFile() ? this.addFile(path) : null };
  }

  /** Paths from browser requests must stay inside a deliberately opened root. */
  private allowed(path: string) {
    let canonical: string;
    try { canonical = this.canonical(path); }
    catch { throw new ValidationError("Path not found or not readable"); }
    if (!this.roots().some(root => within(root, canonical))) throw new ReviewAccessError("Location not opened in this session");
    return canonical;
  }

  browse(input: string) {
    const directory = this.allowed(input || this.projectRoot());
    if (!statSync(directory).isDirectory()) throw new ValidationError("Not a directory");
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(e => !OMIT.has(e.name) && (e.isDirectory() || e.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return {
      directory,
      entries: entries.slice(0, MAX_DIRECTORY_ENTRIES).map(e => ({ name: e.name, path: resolve(directory, e.name), directory: e.isDirectory() })),
      truncated: entries.length > MAX_DIRECTORY_ENTRIES,
    };
  }

  search(query: string) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) return { results: [], exact: null, truncated: false };
    query = query.trim();
    // A path is navigation, not a fuzzy query; probing it does not open it.
    let exact: { path: string; label: string; kind: "folder" | "file" } | null = null;
    if (query.includes("/")) {
      try {
        const path = this.canonical(query);
        const stat = statSync(path);
        if (stat.isDirectory() || stat.isFile()) exact = { path, label: `${stat.isDirectory() ? "Open folder" : "Open file"} · ${query}`, kind: stat.isDirectory() ? "folder" : "file" };
      } catch { /* an incomplete path can still be a fuzzy query */ }
    }
    let absolutePrefix: string | null = null;
    if (query.startsWith("/")) {
      try { absolutePrefix = this.canonical(query); }
      catch {
        try { absolutePrefix = resolve(this.canonical(dirname(query)), basename(query)); }
        catch { absolutePrefix = resolve(query); }
      }
    }
    const results: { path: string; label: string; score: number; recorded: boolean }[] = [];
    const seen = new Set<string>();
    const consider = (path: string, recorded = false) => {
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
      if (score >= 0) results.push({ path, label, score: score + (recorded ? 20 : 0), recorded });
    };
    for (const file of Object.keys(this.state.files)) if (existsSync(file)) consider(file, true);
    const stack = absolutePrefix ? this.roots().filter(root => within(root, absolutePrefix!) || within(absolutePrefix!, root)) : [...this.roots()];
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
    const canonical = this.state.files[path] ? this.canonical(path) : this.allowed(path);
    if (!statSync(canonical).isFile()) throw new ValidationError("Not a file");
    return this.addFile(canonical);
  }

  /** Open a file for reading; it has no diff until an agent changes it. */
  addFile(path: string) {
    path = this.resolvePath(path);
    if (!this.state.files[path]) {
      const content = readSnapshot(path);
      if (content.text === null) throw new ValidationError(content.error || "File not found: " + path);
      this.state.files[path] = { path, manual: true };
      this.save();
    }
    return path;
  }

  // ── Scopes ───────────────────────────────────────────────────────────

  private stat(before: SnapRef, after: SnapRef) {
    const key = `${before.hash}:${after.hash}`;
    let stat = this.statCache.get(key);
    if (!stat) {
      stat = diffStat(this.blobs.get(before).text, this.blobs.get(after).text);
      this.statCache.set(key, stat);
    }
    return stat;
  }

  /** Base and head versions of each changed path within a scope. */
  private range(scope: Scope): Map<string, { before: SnapRef; after: SnapRef }> {
    const result = new Map<string, { before: SnapRef; after: SnapRef }>();
    if (scope.startsWith("request:")) {
      const record = this.state.requests.find(r => r.id === Number(scope.slice(8)));
      for (const [path, change] of Object.entries(record?.changes ?? {})) result.set(path, { before: change.before, after: change.after });
      return result;
    }
    for (const record of this.state.requests) {
      for (const [path, change] of Object.entries(record.changes)) {
        const existing = result.get(path);
        result.set(path, { before: existing?.before ?? change.before, after: change.after });
      }
    }
    if (scope === "since" && this.state.checkpoint) {
      const versions = this.state.checkpoint.versions;
      for (const [path, entry] of result) {
        if (versions[path]) entry.before = versions[path];
        if (sameRef(entry.before, entry.after)) result.delete(path);
      }
    }
    return result;
  }

  private responsesIn(scope: Scope) {
    const all = Object.values(this.state.responses).sort((a, b) => a.at - b.at);
    if (scope.startsWith("request:")) return all.filter(r => r.request === Number(scope.slice(8)));
    if (scope === "since" && this.state.checkpoint) {
      const reviewed = new Set(this.state.checkpoint.responses);
      return all.filter(r => !reviewed.has(r.path));
    }
    return all;
  }

  private fileItem(path: string, change?: { before: SnapRef; after: SnapRef }) {
    const stat = change ? this.stat(change.before, change.after) : undefined;
    return {
      path, label: this.display(path), notes: this.state.drafts[path]?.length ?? 0,
      ...(stat ? { added: stat.added, removed: stat.removed, created: change!.before.hash === null && !change!.before.error, deleted: change!.after.hash === null && !change!.after.error } : {}),
      ...(change?.after.error ? { error: change.after.error } : {}),
      ...(this.state.files[path]?.external ? { external: true } : {}),
    };
  }

  private responseItem(response: ResponseRecord) {
    const preview = response.markdown.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#~]|\[|\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    return { path: response.path, request: response.request, at: response.at, preview: preview.slice(0, 140), notes: this.state.drafts[response.path]?.length ?? 0, latest: response.path === this.state.latestResponse };
  }

  /** Everything the sidebar needs, cheap enough to poll. */
  overview() {
    const scopeView = (scope: Scope) => ({
      responses: this.responsesIn(scope).map(r => this.responseItem(r)),
      files: [...this.range(scope)].map(([path, change]) => this.fileItem(path, change)).sort((a, b) => a.label.localeCompare(b.label)),
    });
    const requests = this.state.requests
      .filter(r => r.prompt || Object.keys(r.changes).length || this.responsesIn(`request:${r.id}`).length)
      .map(r => ({ id: r.id, prompt: r.prompt, at: r.at, ...scopeView(`request:${r.id}`) }))
      .reverse();
    const notes = Object.values(this.state.drafts).reduce((sum, list) => sum + list.length, 0);
    return {
      sessionId: this.sessionId,
      cwd: this.projectRoot(),
      activity: this.state.activity ?? { state: "idle", since: 0 },
      checkpoint: this.state.checkpoint ? { at: this.state.checkpoint.at } : null,
      since: scopeView("since"),
      session: scopeView("session"),
      requests,
      opened: Object.values(this.state.files).filter(f => f.manual).map(f => this.fileItem(f.path)).sort((a, b) => a.label.localeCompare(b.label)),
      roots: [
        { path: this.projectRoot(), label: basename(this.projectRoot()) },
        ...(this.state.locations ?? []).filter(p => existsSync(p) && p !== this.projectRoot()).map(p => ({ path: p, label: `${basename(dirname(p))}/${basename(p)}` })),
      ],
      notes,
      latestResponse: this.state.latestResponse ?? null,
    };
  }

  // ── Documents ────────────────────────────────────────────────────────

  document(path: string, scope: Scope = "session") {
    const response = this.state.responses[path];
    if (response) {
      const request = this.state.requests.find(r => r.id === response.request);
      return {
        kind: "response" as const, path, label: "Response", text: response.markdown, ref: hashText(response.markdown),
        html: renderMarkdown(response.markdown), markdown: true, lines: highlightLines(response.markdown, "markdown"), notes: this.state.drafts[path] ?? [],
        prompt: request?.prompt ?? "", request: response.request, latest: path === this.state.latestResponse, diff: null, diffNote: null, warning: null,
      };
    }
    const file = this.state.files[path];
    if (!file) throw new ValidationError("File is not part of this review");
    const live = readSnapshot(path);
    const liveRef = this.blobs.put(live);
    const text = live.text ?? "";
    const language = languageOf(path);
    const markdown = isMarkdownPath(path);
    const change = this.range(scope).get(path) ?? this.range("session").get(path);
    let diff: (Diff & { oldRef: string | null; newRef: string | null; oldText: string; newText: string }) | null = null;
    let diffNote: string | null = null;
    if (!change) diffNote = file.manual ? "Opened for reading — no recorded change to compare." : "No change in this scope.";
    else {
      const before = this.blobs.get(change.before), after = this.blobs.get(change.after);
      if (before.error || after.error) diffNote = `Diff unavailable: ${before.error || after.error}.`;
      else diff = { ...buildDiff(before.text ?? "", after.text ?? "", language), oldRef: change.before.hash, newRef: change.after.hash, oldText: before.text ?? "", newText: after.text ?? "" };
    }
    const head = this.lastAfter(path);
    const warning = live.error ? live.error
      : live.text === null ? "The file no longer exists on disk."
      : head && !sameRef(head, liveRef) ? "Disk differs from the last recorded change (edited by a shell command, formatter or you)."
      : file.external ? "Some changes to this file happened outside recorded edits." : null;
    return {
      kind: "file" as const, path, label: this.display(path), text, ref: liveRef.hash,
      html: markdown ? renderMarkdown(text) : null, markdown, lines: highlightLines(text, language),
      notes: this.state.drafts[path] ?? [], diff, diffNote, warning, manual: !!file.manual,
      prompt: null, request: null, latest: null,
    };
  }

  /** Hash of a file's current contents, to notice changes on disk cheaply. */
  liveRef(path: string) {
    if (!this.state.files[path]) throw new ValidationError("File is not part of this review");
    const live = readSnapshot(path);
    return { ref: live.text === null ? null : hashText(live.text) };
  }

  /** Replace all notes of one document. */
  saveNotes(path: string, input: unknown) {
    if (typeof path !== "string" || (!this.state.files[path] && !this.state.responses[path])) throw new ValidationError("Unknown document");
    if (!Array.isArray(input) || input.length > MAX_NOTES) throw new ValidationError("Invalid notes");
    const notes = input.map((n: any): Note => {
      const valid = n && typeof n.id === "string" && /^[\w-]{1,64}$/.test(n.id) && INTENTS.includes(n.intent)
        && typeof n.text === "string" && n.text.length <= 20000 && typeof n.quote === "string" && n.quote.length <= 100000
        && (n.replacement === undefined || typeof n.replacement === "string") && (n.source === undefined || typeof n.source === "string")
        && [n.prefix, n.suffix].every(c => c === undefined || (typeof c === "string" && c.length <= 200))
        && Number.isInteger(n.start) && Number.isInteger(n.end) && n.start >= 0 && n.end >= n.start
        && (n.view === "document" || n.view === "diff") && (n.side === undefined || n.side === "old" || n.side === "new")
        && (n.ref === null || typeof n.ref === "string");
      if (!valid) throw new ValidationError("Invalid note");
      return { id: n.id, intent: n.intent, text: n.text, quote: n.quote, start: n.start, end: n.end, view: n.view, ref: n.ref, createdAt: Number(n.createdAt) || Date.now(),
        ...(n.replacement !== undefined ? { replacement: n.replacement } : {}), ...(n.source !== undefined ? { source: n.source } : {}),
        ...(n.prefix !== undefined ? { prefix: n.prefix } : {}), ...(n.suffix !== undefined ? { suffix: n.suffix } : {}), ...(n.side ? { side: n.side } : {}) };
    });
    if (notes.length) this.state.drafts[path] = notes; else delete this.state.drafts[path];
    this.save();
    return { ok: true, notes: notes.length };
  }

  // ── Feedback ─────────────────────────────────────────────────────────

  feedback(): string {
    const items: FeedbackItem[] = [];
    const responses = Object.values(this.state.responses).sort((a, b) => a.at - b.at);
    for (const response of responses) {
      const notes = this.state.drafts[response.path];
      if (!notes?.length) continue;
      const prompt = this.state.requests.find(r => r.id === response.request)?.prompt ?? "";
      items.push({ kind: "response", prompt, latest: response.path === this.state.latestResponse, text: response.markdown, notes });
    }
    const files = Object.keys(this.state.drafts).filter(p => !this.state.responses[p]).sort((a, b) => this.display(a).localeCompare(this.display(b)));
    for (const path of files) {
      const live = readSnapshot(path);
      items.push({ kind: "file", label: this.display(path), live: live.text, notes: this.state.drafts[path], version: ref => ref ? this.blobs.get({ hash: ref }).text : null });
    }
    return formatFeedback(items);
  }

  clearDrafts() { this.state.drafts = {}; this.save(); }

  /** Everything seen so far becomes the baseline of "Since last Done". */
  checkpoint() {
    const versions: Record<string, SnapRef> = {};
    for (const [path, change] of this.range("session")) versions[path] = change.after;
    this.state.checkpoint = { at: Date.now(), request: this.request.id, versions, responses: Object.keys(this.state.responses) };
    this.save();
  }
}
