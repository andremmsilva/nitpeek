import MarkdownIt, { type RendererRule, type Token } from "markdown-it";
import hljs from "highlight.js/lib/common";

/**
 * Canned document shown by the page when the local annotation server is
 * unreachable (demo/offline mode). Rendered by the server at startup and
 * inlined into the page together with its raw markdown.
 */
export const DEMO_MARKDOWN = `# Demo Plan

This is a demonstration of the annotation UI. The server was not reachable, so
demo content is shown.

## Section 1

Select any text to create an annotation. Annotations appear in the right panel
with different types:

- **Comment** (blue) - General feedback
- **Suggestion** (green) - Improvement ideas
- **Issue** (red) - Problems to fix
- **Praise** (yellow) - Positive feedback

## Section 2

Code block example:

\`\`\`javascript
function hello() {
  console.log("Hello, World!");
}
\`\`\`

> Blockquote: This is a quoted text for annotation testing.

### Nested Lists

1. First item
2. Second item
   - Sublist A
   - Sublist B
3. Third item

Use the **Send Feedback** button at the bottom to submit your annotations to the
server. Or use **Exit** to close without submitting.
`;

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
  if (!markdown) return '<p style="color:var(--text-muted)">(empty content)</p>';

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

  const offsetAttrs = (token: Token): string => {
    if (!token.map) return "";
    const start = offsetOf(token.map[0]);
    const end = offsetOf(token.map[1]);
    if (end <= start) return "";
    return ` class="md-block" data-offset-start="${start}" data-offset-end="${end}"`;
  };

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
    const highlighted =
      info && hljs.getLanguage(info)
        ? hljs.highlight(code, { language: info, ignoreIllegals: true }).value
        : escapeHtml(code);
    return `<pre${offsetAttrs(token)}><code class="hljs${info ? ` language-${escapeHtml(info)}` : ""}">${highlighted}</code></pre>\n`;
  };

  // Indented code blocks have no language information.
  renderer.rules.code_block = function (tokens, idx) {
    const token = tokens[idx];
    return `<pre${offsetAttrs(token)}><code class="hljs">${escapeHtml(token.content.replace(/\n$/, ""))}</code></pre>\n`;
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
