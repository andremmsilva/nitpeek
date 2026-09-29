import MarkdownIt, { type RendererRule, type Token } from "markdown-it";
import hljs from "highlight.js/lib/common";
import latex from "highlight.js/lib/languages/latex";
import { diffWordsWithSpace, structuredPatch } from "diff";
import { mathPlugin } from "./math.js";

hljs.registerLanguage("latex", latex);

/** Markdown is stored and mapped with \n newlines; normalize at read time. */
export function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Block tags whose elements carry selection-mapping offsets. */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "th",
  "td",
  "pre",
  "hr",
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render markdown to HTML for the annotation UI.
 *
 * Every mapped block element gets `class="md-block"` plus
 * `data-offset-start` / `data-offset-end` — character offsets into the raw
 * markdown, which is what the page's selection→source mapping relies on.
 * Offsets are attached to the innermost mapped element (list items, paragraphs
 * inside blockquotes, table rows) so mappings stay as tight as possible.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return '<p class="empty">(empty)</p>';

  // Line number -> character offset. markdown-it token maps are [start, end)
  // line numbers; end can point one past the last line when the document has
  // no trailing newline.
  const lineStarts = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const offsetOf = (line: number) => (line >= lineStarts.length ? markdown.length : lineStarts[line]);

  const mdit = new MarkdownIt({ html: false, linkify: false, breaks: false });
  const renderer = mdit.renderer;

  const mapAttrs = (map: [number, number] | null | undefined): string => {
    if (!map) return "";
    const start = offsetOf(map[0]);
    const end = offsetOf(map[1]);
    if (end <= start) return "";
    return ` class="md-block" data-offset-start="${start}" data-offset-end="${end}"`;
  };
  const offsetAttrs = (token: Token) => mapAttrs(token.map as [number, number] | null);
  mathPlugin(mdit, mapAttrs);

  // Attach offsets to every mapped block element rendered via renderToken.
  const renderToken = renderer.renderToken.bind(renderer);
  renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx];
    if (token.map && token.block && token.nesting !== -1 && BLOCK_TAGS.has(token.tag)) {
      const start = offsetOf(token.map[0]);
      const end = offsetOf(token.map[1]);
      if (end > start) {
        token.attrJoin("class", "md-block");
        token.attrSet("data-offset-start", String(start));
        token.attrSet("data-offset-end", String(end));
      }
    }
    return renderToken(tokens, idx, options);
  };

  // Fenced code: syntax-highlight known languages, escape everything else.
  renderer.rules.fence = function (tokens, idx) {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0] || "";
    const code = token.content.replace(/\n$/, "");
    return codeBlock(code, info && hljs.getLanguage(info) ? info : null, info, offsetAttrs(token));
  };

  // Indented code blocks have no language information.
  renderer.rules.code_block = function (tokens, idx) {
    const token = tokens[idx];
    return codeBlock(token.content.replace(/\n$/, ""), null, "", offsetAttrs(token));
  };

  // Keep links from navigating the annotation window away from the document.
  const fallbackRule: RendererRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  const linkOpen = renderer.rules.link_open ?? fallbackRule;
  renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener");
    return linkOpen(tokens, idx, options, env, self);
  };

  const image = renderer.rules.image ?? fallbackRule;
  renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("loading", "lazy");
    return image(tokens, idx, options, env, self);
  };

  return mdit.render(markdown);
}

/**
 * A numbered code block. Numbers and the wrap button are drawn by CSS and have
 * no text, so the block's text content is exactly the code.
 */
export function codeBlock(code: string, language: string | null, label: string, attrs: string): string {
  const lines = highlightLines(code, language);
  const rows = lines.map((html, i) => `<span class="cl" data-n="${i + 1}">${html}${i < lines.length - 1 ? "\n" : ""}</span>`).join("");
  return `<div class="np-codeblock"${label ? ` data-lang="${escapeHtml(label)}"` : ""}><button type="button" class="np-wrap" title="Wrap lines (w)" aria-label="Wrap lines"></button>`
    + `<pre${attrs}><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${rows}</code></pre></div>\n`;
}

// ── Source code ────────────────────────────────────────────────────────

const LANGUAGES: Record<string, string> = {
  json: "json", jsonl: "json", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", tsx: "typescript", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", scss: "scss", html: "xml", xml: "xml", svg: "xml", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", lua: "lua", tex: "latex", latex: "latex", md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff", dockerfile: "dockerfile", makefile: "makefile", r: "r", scala: "scala",
};

export function languageOf(path: string): string | null {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const language = LANGUAGES[name] ?? LANGUAGES[name.split(".").at(-1) ?? ""];
  return language && hljs.getLanguage(language) ? language : null;
}

export const isMarkdownPath = (path: string) => /\.(md|markdown|mdown|mdx)$/i.test(path);

/**
 * Highlight `text` and split the HTML into one fragment per source line.
 * Spans that cross a newline are closed at the line end and reopened on the
 * next line, so every fragment is well-formed and its textContent equals the
 * source line exactly — which makes selection offsets exact.
 */
export function highlightLines(text: string, language: string | null): string[] {
  const html = language && text.length <= 256 * 1024
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text);
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const token of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!token) continue;
    if (token === "\n") { line += "</span>".repeat(open.length); lines.push(line); line = open.join(""); }
    else if (token.startsWith("<span")) { open.push(token); line += token; }
    else if (token === "</span>") { open.pop(); line += token; }
    else line += token;
  }
  lines.push(line + "</span>".repeat(open.length));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

// ── Diff ───────────────────────────────────────────────────────────────

export type DiffLine = { kind: " " | "+" | "-"; old?: number; new?: number; html: string; text: string; words?: [number, number][] };
export type DiffHunk = { oldStart: number; newStart: number; lines: DiffLine[] };
export type Diff = { hunks: DiffHunk[]; added: number; removed: number; truncated?: boolean };

const MAX_DIFF_LINES = 6000;

/** Changed character ranges between a removed and an added line. */
function wordRanges(before: string, after: string): { old: [number, number][]; new: [number, number][] } | null {
  if (before.length + after.length > 2000) return null;
  const parts = diffWordsWithSpace(before, after);
  const old: [number, number][] = [], neu: [number, number][] = [];
  let o = 0, n = 0, common = 0;
  for (const part of parts) {
    const length = part.value.length;
    if (part.added) { neu.push([n, n + length]); n += length; }
    else if (part.removed) { old.push([o, o + length]); o += length; }
    else { o += length; n += length; common += length; }
  }
  // Mostly-rewritten lines read better without confetti.
  if (common < Math.min(before.length, after.length) * 0.4) return null;
  return { old, new: neu };
}

/**
 * Structured line diff with syntax highlighting (each side highlighted as a
 * whole, then split into lines) and word-level change ranges for paired lines.
 */
export function buildDiff(before: string, after: string, language: string | null, context = 3): Diff {
  const patch = structuredPatch("a", "b", before, after, "", "", { context });
  const oldLines = highlightLines(before, language), newLines = highlightLines(after, language);
  const oldText = before.split("\n"), newText = after.split("\n");
  let added = 0, removed = 0, total = 0, truncated = false;
  const hunks: DiffHunk[] = [];
  for (const hunk of patch.hunks) {
    if (total > MAX_DIFF_LINES) { truncated = true; break; }
    const lines: DiffLine[] = [];
    let o = hunk.oldStart, n = hunk.newStart;
    for (const raw of hunk.lines) {
      const kind = raw[0];
      if (kind === "\\") continue;
      if (kind === "-") { lines.push({ kind: "-", old: o, html: oldLines[o - 1] ?? "", text: oldText[o - 1] ?? "" }); o++; removed++; }
      else if (kind === "+") { lines.push({ kind: "+", new: n, html: newLines[n - 1] ?? "", text: newText[n - 1] ?? "" }); n++; added++; }
      else { lines.push({ kind: " ", old: o, new: n, html: newLines[n - 1] ?? "", text: newText[n - 1] ?? "" }); o++; n++; }
    }
    // Pair each run of removals with the following run of additions.
    for (let i = 0; i < lines.length;) {
      if (lines[i].kind !== "-") { i++; continue; }
      let r = i; while (r < lines.length && lines[r].kind === "-") r++;
      let a = r; while (a < lines.length && lines[a].kind === "+") a++;
      for (let k = 0; k < Math.min(r - i, a - r); k++) {
        const ranges = wordRanges(lines[i + k].text, lines[r + k].text);
        if (ranges) { lines[i + k].words = ranges.old; lines[r + k].words = ranges.new; }
      }
      i = a;
    }
    total += lines.length;
    hunks.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines });
  }
  return { hunks, added, removed, ...(truncated ? { truncated } : {}) };
}

/** Added/removed line counts, cheap enough to compute on every capture. */
export function diffStat(before: string | null, after: string | null): { added: number; removed: number } {
  const patch = structuredPatch("a", "b", before ?? "", after ?? "", "", "", { context: 0 });
  let added = 0, removed = 0;
  for (const hunk of patch.hunks) for (const line of hunk.lines) { if (line[0] === "+") added++; else if (line[0] === "-") removed++; }
  return { added, removed };
}
