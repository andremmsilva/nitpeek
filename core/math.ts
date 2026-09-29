/**
 * LaTeX math for rendered views.
 *
 * A formula is rendered as an atomic element whose text content is its exact
 * source (delimiters included), so selections, note anchoring and copying all
 * see LaTeX. The KaTeX rendering travels in a <template> and is displayed by
 * the page in a shadow root, outside the text the anchoring code reads.
 */

import katex from "katex";
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

export type Macros = Record<string, string>;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `\label{…}` is meaningless to KaTeX; the renderers number equations themselves. */
export const stripLabels = (tex: string) => tex.replace(/\\label\s*\{[^{}]*\}/g, "");

/**
 * An atomic formula. `source` is the exact text in the document; `tex` is what
 * KaTeX renders (without delimiters, possibly rewritten).
 */
export function mathHtml(source: string, tex: string, display: boolean, macros: Macros = {}): string {
  const rendered = katex.renderToString(stripLabels(tex), {
    displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "html", macros: { ...macros },
  });
  return `<span class="np-math${display ? " display" : ""}"><template>${rendered}</template>${escapeHtml(source)}</span>`;
}

// ── markdown-it ────────────────────────────────────────────────────────

/** Pandoc's rule: `$` opens before a non-space and closes after a non-space not followed by a digit. */
function dollarEnd(src: string, from: number, max: number): number {
  for (let i = from; i < max; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "$") {
      if (/\s/.test(src[i - 1]) || /\d/.test(src[i + 1] ?? "")) continue;
      return i;
    }
  }
  return -1;
}

function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  let open = "", close = "", end = -1;
  if (src.startsWith("\\(", pos)) { open = "\\("; close = "\\)"; end = src.indexOf("\\)", pos + 2); }
  else if (src.startsWith("\\[", pos)) { open = "\\["; close = "\\]"; end = src.indexOf("\\]", pos + 2); }
  else if (src.startsWith("$$", pos)) { open = close = "$$"; end = src.indexOf("$$", pos + 2); }
  else if (src[pos] === "$") {
    if (!src[pos + 1] || /\s/.test(src[pos + 1])) return false;
    open = close = "$"; end = dollarEnd(src, pos + 1, posMax);
  } else return false;
  if (end < 0 || end + close.length > posMax || end === pos + open.length) return false;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = src.slice(pos + open.length, end);
    token.meta = { source: src.slice(pos, end + close.length), display: open !== "$" && open !== "\\(" };
  }
  state.pos = end + close.length;
  return true;
}

/** `$$ … $$` or `\[ … \]` starting a line, possibly spanning several. */
function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const first = state.src.slice(start, state.eMarks[startLine]);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : "";
  if (!open) return false;
  const close = open === "$$" ? "$$" : "\\]";
  let line = startLine, closeAt = -1;
  const rest = first.slice(open.length);
  if (rest.trimEnd().endsWith(close) && rest.trim().length >= close.length) closeAt = start + open.length + rest.trimEnd().length - close.length;
  while (closeAt < 0 && ++line < endLine) {
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd();
    if (text.endsWith(close)) closeAt = state.bMarks[line] + state.tShift[line] + text.length - close.length;
  }
  if (closeAt < 0) return false;
  // Something after the closing delimiter: leave it to the inline rule.
  if (state.src.slice(closeAt + close.length, state.eMarks[line]).trim()) return false;
  if (silent) return true;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = state.src.slice(start + open.length, closeAt);
  token.meta = { source: state.src.slice(start, closeAt + close.length) };
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

/** Adds `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. `blockAttrs` gives offset attributes for a mapped token. */
export function mathPlugin(md: MarkdownIt, blockAttrs: (map: [number, number] | null) => string) {
  md.inline.ruler.before("escape", "math_inline", inlineMath);
  md.block.ruler.before("fence", "math_block", blockMath, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.math_inline = (tokens, idx) => mathHtml(tokens[idx].meta.source, tokens[idx].content, tokens[idx].meta.display);
  md.renderer.rules.math_block = (tokens, idx) => {
    const attrs = blockAttrs(tokens[idx].map as [number, number] | null);
    return `<div${attrs ? attrs.replace('class="md-block"', 'class="md-block np-math-block"') : ' class="np-math-block"'}>${mathHtml(tokens[idx].meta.source, tokens[idx].content, true)}</div>\n`;
  };
}
