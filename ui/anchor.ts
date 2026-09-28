/**
 * Anchoring notes to text.
 *
 * A note stores the exact quote plus offsets into the version of the text it
 * was made on (`ref`). To display it on another version we look for the quote
 * again, nearest to where it was. Line views (code, source, diff) map offsets
 * to rows exactly; rendered Markdown maps them through `.md-block` elements
 * that carry source offsets.
 */

import { locateQuote } from "../core/quote";
import type { Note } from "./types";

export const lineStarts = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/** 1-based line and column-in-line of an offset. */
export function position(starts: number[], offset: number) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: offset - starts[lo] };
}

/** Where a note sits in `text` (whose hash is `ref`), or null if its text is gone. */
export function resolveNote(note: Note, text: string, ref: string | null): [number, number] | null {
  if (note.ref !== null && note.ref === ref && note.end <= text.length) return [note.start, note.end];
  return locateQuote(text, note);
}

// ── DOM marks ──────────────────────────────────────────────────────────

/** Wrap the text range [start, end) of `root` in a <mark>. Returns the mark. */
export function wrapRange(root: Node, start: number, end: number, className: string, attrs: Record<string, string> = {}): HTMLElement | null {
  if (end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null, offset = 0;
  let startNode: Node | null = null, startOffset = 0, endNode: Node | null = null, endOffset = 0;
  while ((node = walker.nextNode())) {
    const length = node.nodeValue!.length;
    if (!startNode && start < offset + length) { startNode = node; startOffset = start - offset; }
    if (startNode && end <= offset + length) { endNode = node; endOffset = end - offset; break; }
    offset += length;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const mark = document.createElement("mark");
    mark.className = className;
    for (const [key, value] of Object.entries(attrs)) mark.setAttribute(key, value);
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    return mark;
  } catch { return null; }
}

export function clearMarks(root: HTMLElement, selector: string) {
  for (const mark of Array.from(root.querySelectorAll(selector))) {
    const parent = mark.parentNode!;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/** Mark a text range across line rows (`[data-<attr>="n"] .src`). */
export function markLines(root: HTMLElement, text: string, range: [number, number], attr: string, className: string, attrs: Record<string, string>): HTMLElement[] {
  const starts = lineStarts(text);
  const from = position(starts, range[0]), to = position(starts, Math.max(range[0], range[1]));
  const marks: HTMLElement[] = [];
  for (let line = from.line; line <= to.line; line++) {
    const src = root.querySelector<HTMLElement>(`[data-${attr}="${line}"] .src`);
    if (!src) continue;
    const length = src.textContent!.length;
    const start = line === from.line ? from.col : 0;
    const end = line === to.line ? to.col : length;
    const mark = wrapRange(src, Math.min(start, length), Math.min(end, length), className, attrs);
    if (mark) marks.push(mark);
  }
  return marks;
}

/** Whitespace-collapsed text with a map back to original offsets. */
function collapse(text: string) {
  let out = "", space = false;
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (space) continue; out += " "; space = true; }
    else { out += ch; space = false; }
    map.push(i);
  }
  map.push(text.length);
  return { out, map };
}

/**
 * Mark a quote inside rendered Markdown. A selection spanning several blocks
 * is matched piecewise: the tail of the first block, whole middle blocks and
 * the head of the last block.
 */
export function markProse(root: HTMLElement, sourceRange: [number, number], quote: string, className: string, attrs: Record<string, string>): HTMLElement[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".md-block")).filter(block => {
    if (block.querySelector(".md-block")) return false; // innermost only
    const start = Number(block.dataset.offsetStart), end = Number(block.dataset.offsetEnd);
    return end > sourceRange[0] && start < Math.max(sourceRange[1], sourceRange[0] + 1);
  });
  const q = collapse(quote.trim()).out;
  if (!q) return [];
  const marks: HTMLElement[] = [];
  let remaining = q;
  for (const block of blocks) {
    const { out, map } = collapse(block.textContent || "");
    let hit: [number, number] | null = null;
    const whole = out.indexOf(remaining);
    if (whole >= 0) hit = [whole, whole + remaining.length];
    else {
      // The block ends inside the quote: find the longest block suffix that starts the quote.
      for (let p = 0; p < out.length && !hit; p++) {
        const tail = out.slice(p).trimEnd();
        if (tail.length >= 2 && remaining.startsWith(tail)) hit = [p, p + tail.length];
      }
    }
    if (!hit) continue;
    const mark = wrapRange(block, map[hit[0]], map[hit[1] - 1] + 1, className, attrs);
    if (mark) marks.push(mark);
    const consumed = out.slice(hit[0], hit[1]);
    remaining = remaining.slice(remaining.indexOf(consumed) + consumed.length).trimStart();
    if (!remaining) break;
  }
  return marks;
}

// ── Selections ─────────────────────────────────────────────────────────

/** Text length from the start of `container` up to a DOM boundary point. */
function textOffset(container: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  try { range.setEnd(node, offset); } catch { return 0; }
  return range.toString().length;
}

export type Anchor = { quote: string; source?: string; start: number; end: number; side?: "old" | "new"; rect: DOMRect };

/** A selection over line rows: exact offsets into `text` for the chosen side. */
export function selectLines(range: Range, root: HTMLElement, sides: { attr: string; text: string; side?: "old" | "new" }[]): Anchor | null {
  const rowOf = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>("[data-row]") ?? null;
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-row]")).filter(row => range.intersectsNode(row));
  if (!rows.length) return null;
  const startRow = rowOf(range.startContainer), endRow = rowOf(range.endContainer);
  // Diff: a selection of removed lines only annotates the old version.
  const choice = sides.length > 1 && rows.every(row => row.dataset.kind === "-") ? sides.find(s => s.side === "old")! : sides.find(s => s.side !== "old")!;
  const usable = rows.filter(row => row.dataset[choice.attr] !== undefined);
  if (!usable.length) return null;
  const starts = lineStarts(choice.text);
  const first = usable[0], last = usable.at(-1)!;
  const firstLine = Number(first.dataset[choice.attr]), lastLine = Number(last.dataset[choice.attr]);
  const firstSrc = first.querySelector(".src")!, lastSrc = last.querySelector(".src")!;
  let startCol = 0, endCol = lastSrc.textContent!.length;
  if (first === startRow && firstSrc.contains(range.startContainer)) startCol = textOffset(firstSrc, range.startContainer, range.startOffset);
  if (last === endRow && lastSrc.contains(range.endContainer)) endCol = textOffset(lastSrc, range.endContainer, range.endOffset);
  const start = (starts[firstLine - 1] ?? 0) + startCol;
  const end = (starts[lastLine - 1] ?? 0) + endCol;
  if (end <= start) return null;
  const quote = choice.text.slice(start, end);
  if (!quote.trim()) return null;
  return { quote, source: quote, start, end, side: choice.side, rect: range.getBoundingClientRect() };
}

function findInRange(md: string, text: string, lo: number, hi: number, prefer: number) {
  let best = -1, distance = Infinity;
  const slice = md.slice(lo, hi);
  for (let at = slice.indexOf(text); at >= 0; at = slice.indexOf(text, at + 1)) {
    const d = Math.abs(lo + at - prefer);
    if (d < distance) { distance = d; best = lo + at; }
  }
  return best;
}

/** A selection over rendered Markdown mapped back onto its source. */
export function selectProse(range: Range, root: HTMLElement, markdown: string): Anchor | null {
  const blockOf = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(".md-block") ?? null;
  const startBlock = blockOf(range.startContainer), endBlock = blockOf(range.endContainer);
  if (!startBlock && !endBlock) return null;
  if ((startBlock && !root.contains(startBlock)) || (endBlock && !root.contains(endBlock))) return null;
  const quote = range.toString().trim();
  if (!quote) return null;
  const lo = startBlock ? Number(startBlock.dataset.offsetStart) : 0;
  const hi = endBlock ? Number(endBlock.dataset.offsetEnd) : markdown.length;
  const prefer = lo + (startBlock ? textOffset(startBlock, range.startContainer, range.startOffset) : 0);
  const at = findInRange(markdown, quote, lo, hi, prefer);
  // Rendered text can differ from the source (markers, entities): the block
  // range is then only a location hint and the quote stays authoritative.
  return at >= 0
    ? { quote, source: quote, start: at, end: at + quote.length, rect: range.getBoundingClientRect() }
    : { quote, start: lo, end: Math.max(lo, hi), rect: range.getBoundingClientRect() };
}
