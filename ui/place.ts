/**
 * Where the reader is in a document, as a source line that every view can
 * find again: rows carry line numbers, rendered blocks carry source offsets.
 * `line` is fractional (a point partway down a row or block) and 1-based.
 */
export type PlaceKind = "prose" | "lines" | "diff";
export type Place = { line: number };

let cached: { text: string; starts: number[] } | null = null;
function lineStarts(text: string) {
  if (cached?.text === text) return cached.starts;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  cached = { text, starts };
  return starts;
}

/** 1-based line of a character offset. */
function lineOf(text: string, offset: number) {
  const starts = lineStarts(text);
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

type Span = { el: HTMLElement; from: number; to: number };

/** Every positioned piece of the view with the source lines it covers, in order. */
function spans(root: HTMLElement, kind: PlaceKind, text: string): Span[] {
  if (kind === "prose") {
    return Array.from(root.querySelectorAll<HTMLElement>(".md-block"))
      .filter(block => !block.querySelector(".md-block"))
      .map(el => {
        const from = lineOf(text, Number(el.dataset.offsetStart));
        const end = Number(el.dataset.offsetEnd);
        // The end offset is exclusive and usually just past a newline.
        return { el, from, to: Math.max(from + 1, lineOf(text, Math.max(0, end - 1)) + 1) };
      });
  }
  const attr = kind === "diff" ? "new" : "line";
  const out: Span[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-row]"))) {
    const n = Number(el.dataset[attr]);
    if (n) out.push({ el, from: n, to: n + 1 });
  }
  return out;
}

export function capturePlace(scroller: HTMLElement, root: HTMLElement, kind: PlaceKind, text: string): Place | null {
  if (scroller.scrollTop < 4) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const span of spans(root, kind, text)) {
    const rect = span.el.getBoundingClientRect();
    if (!rect.height || rect.bottom <= top) continue;
    const within = Math.max(0, Math.min(1, (top - rect.top) / rect.height));
    return { line: span.from + within * (span.to - span.from) };
  }
  return null;
}

/** Scrolls so that the place's line is back at the top of the view. */
export function restorePlace(scroller: HTMLElement, root: HTMLElement, kind: PlaceKind, text: string, place: Place | null) {
  if (!place) { scroller.scrollTop = 0; return; }
  let best: Span | null = null, distance = Infinity;
  for (const span of spans(root, kind, text)) {
    if (!span.el.getBoundingClientRect().height) continue;
    const d = place.line < span.from ? span.from - place.line : place.line >= span.to ? place.line - span.to + 1 : 0;
    if (d < distance) { best = span; distance = d; }
    if (d === 0) break;
  }
  if (!best) return;
  const rect = best.el.getBoundingClientRect();
  const within = Math.max(0, Math.min(1, (place.line - best.from) / (best.to - best.from)));
  scroller.scrollTop += rect.top + within * rect.height - scroller.getBoundingClientRect().top;
}

/**
 * New-side lines the recorded changes touched: added lines, plus the line
 * after a pure removal. Only when the diff's "after" is the text on show.
 */
export function changedLines(diff: { newText: string; hunks: { lines: { kind: string; new?: number }[] }[] } | null, text: string): Set<number> | null {
  if (!diff || diff.newText !== text) return null;
  const lines = new Set<number>();
  for (const hunk of diff.hunks) {
    let next = 0;
    for (const line of hunk.lines) {
      if (line.new !== undefined) { next = line.new + 1; if (line.kind === "+") lines.add(line.new); }
      else if (line.kind === "-") lines.add(next || 1);
    }
  }
  return lines.size ? lines : null;
}

/** Positions are relative to the top of the content element. */
export type DocMap = {
  headings: { top: number; level: number; text: string }[];
  changes: { top: number; height: number }[];
  /** Content top within the scroller's scrolled area, and that area's height. */
  offset: number; total: number;
};

export const HEADINGS = ".prose h1, .prose h2, .prose h3, .prose h4";

export function measureMap(scroller: HTMLElement, root: HTMLElement, kind: PlaceKind, text: string, changed: Set<number> | null): DocMap {
  const base = root.getBoundingClientRect().top;
  const headings = kind !== "prose" ? [] : Array.from(root.querySelectorAll<HTMLElement>(HEADINGS)).map(h => {
    const number = h.querySelector(".tex-num")?.textContent ?? "";
    const title = (h.textContent ?? "").slice(number.length).trim();
    return { top: h.getBoundingClientRect().top - base, level: Number(h.tagName[1]), text: number ? `${number} ${title}` : title };
  });
  const changes: DocMap["changes"] = [];
  if (changed && kind !== "diff") {
    for (const span of spans(root, kind, text)) {
      let hit = false;
      for (let line = span.from; line < span.to && !hit; line++) hit = changed.has(line);
      if (!hit) continue;
      const rect = span.el.getBoundingClientRect();
      if (!rect.height) continue;
      const top = rect.top - base, last = changes.at(-1);
      // Neighbouring changed blocks read as one bar.
      if (last && top - (last.top + last.height) < 14) last.height = Math.max(last.height, top + rect.height - last.top);
      else changes.push({ top, height: rect.height });
    }
  }
  return { headings, changes, offset: base - scroller.getBoundingClientRect().top + scroller.scrollTop, total: scroller.scrollHeight };
}
