/**
 * Formulas in rendered views (see core/math.ts).
 *
 * `.np-math` holds the LaTeX source as its text and the KaTeX rendering in a
 * <template>. The rendering is shown from a shadow root, so the text that
 * selections, notes and copying see is always the source. A formula is atomic:
 * clicking selects it whole, and a selection never ends inside one.
 */

const SHADOW_STYLE = `<link rel="stylesheet" href="/katex.css"><style>
  :host { user-select: none; -webkit-user-select: none; }
  .katex { font-size: 1.1em; }
  .katex-display { margin: 0; }
  .katex-error { color: var(--danger) !important; font: .85em var(--mono); }
</style>`;

export function hydrateMath(root: HTMLElement) {
  for (const host of Array.from(root.querySelectorAll<HTMLElement>(".np-math:not(.np-tikz)"))) {
    if (host.shadowRoot) continue;
    const template = host.querySelector<HTMLTemplateElement>(":scope > template");
    if (!template) continue;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = SHADOW_STYLE;
    shadow.append(template.content.cloneNode(true));
    host.title = host.textContent!.trim().slice(0, 300);
  }
}

/** Grow a range so it never starts or ends inside a formula. */
export function atomize(range: Range): Range {
  const hostOf = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(".np-math") ?? null;
  const start = hostOf(range.startContainer), end = hostOf(range.endContainer);
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
  return range;
}

/** Select a whole formula. */
export function selectMath(host: HTMLElement): Range {
  const range = document.createRange();
  range.selectNode(host);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

const NOTE_CLASSES = ["np-noted", "active", "i-change", "i-reply", "i-question", "i-keep"];

/**
 * Note marks inside a formula wrap invisible source text: show them on the
 * formula instead. Also re-renders formulas a mark had to split.
 */
export function decorateMath(root: HTMLElement) {
  for (const host of Array.from(root.querySelectorAll<HTMLElement>(".np-math"))) {
    host.classList.remove(...NOTE_CLASSES);
    delete host.dataset.note;
  }
  hydrateMath(root);
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>("mark.np-note"))) {
    const hosts = [mark.closest<HTMLElement>(".np-math"), ...Array.from(mark.querySelectorAll<HTMLElement>(".np-math"))];
    for (const host of hosts) {
      if (!host || host.dataset.note) continue;
      host.classList.add("np-noted", ...Array.from(mark.classList).filter(c => NOTE_CLASSES.includes(c)));
      host.dataset.note = mark.dataset.note;
    }
  }
}

/** Formulas covered by the current selection get a selected look (their text is not drawn). */
export function trackMathSelection(root: HTMLElement) {
  const update = () => {
    const selection = getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    for (const host of Array.from(root.querySelectorAll<HTMLElement>(".np-math"))) host.classList.toggle("in-sel", !!range && range.intersectsNode(host));
  };
  document.addEventListener("selectionchange", update);
  return () => document.removeEventListener("selectionchange", update);
}

// ── TikZ figures ───────────────────────────────────────────────────────

export const TIKZ_STYLES = ["card", "adapted", "plain"] as const;
const STYLE_LABEL: Record<string, string> = { card: "card", adapted: "adapted", plain: "as compiled" };

const FIGURE_STYLE = `<style>
  :host { user-select: none; -webkit-user-select: none; }
  .frame { position: relative; display: flex; justify-content: center; min-height: 40px; }
  .fig { max-width: 100%; overflow-x: auto; }
  svg { max-width: 100%; height: auto; display: block; }
  .status { font: 12px -apple-system, system-ui, sans-serif; opacity: .6; padding: 18px; }
  .error { font: 12px ui-monospace, Menlo, monospace; color: #d9534f; white-space: pre-wrap; padding: 8px 12px; text-align: left; }
  .style { position: absolute; top: -6px; right: -6px; opacity: 0; transition: opacity .15s; font: 11px -apple-system, system-ui, sans-serif;
    border: 1px solid rgba(128,128,128,.45); background: rgba(128,128,128,.14); color: inherit; border-radius: 5px; padding: 1px 7px; cursor: pointer; }
  .frame:hover .style { opacity: .9; }
</style>`;

/** SVG from the TeX compiler, without anything active in it. */
function cleanSvg(markup: string): SVGSVGElement | null {
  const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  if (svg.nodeName !== "svg") return null;
  for (const bad of Array.from(svg.querySelectorAll("script, foreignObject, style"))) bad.remove();
  for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
  }
  // TeX points are small on screen: show pictures a bit larger than 1pt = 1px.
  const width = parseFloat(svg.getAttribute("width") ?? "");
  if (width) { svg.style.width = `${Math.round(width * 1.3)}px`; svg.removeAttribute("height"); }
  return document.importNode(svg, true) as unknown as SVGSVGElement;
}

/** Compile (or fetch from cache) and show each TikZ picture. */
export function hydrateTikz(root: HTMLElement, load: (key: string) => Promise<{ svg?: string; error?: string }>) {
  for (const host of Array.from(root.querySelectorAll<HTMLElement>(".np-tikz"))) {
    if (host.shadowRoot) continue;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${FIGURE_STYLE}<div class="frame"><div class="fig"><div class="status">Compiling TikZ…</div></div><button type="button" class="style" title="Figure style: card · adapted to the theme · as compiled"></button></div>`;
    const button = shadow.querySelector<HTMLButtonElement>(".style")!;
    for (const type of ["mousedown", "mouseup"]) button.addEventListener(type, e => e.stopPropagation());
    button.addEventListener("click", e => { e.stopPropagation(); dispatchEvent(new Event("nitpeek-figure-style")); });
    button.textContent = STYLE_LABEL[document.documentElement.dataset.tikz ?? "card"];
    const figure = shadow.querySelector<HTMLElement>(".fig")!;
    load(host.dataset.tikz!).then(result => {
      const svg = result.svg ? cleanSvg(result.svg) : null;
      if (svg) figure.replaceChildren(svg);
      else { const error = document.createElement("div"); error.className = "error"; error.textContent = `TikZ: ${result.error ?? "no output"}`; figure.replaceChildren(error); host.classList.add("failed"); }
    }, error => { figure.innerHTML = ""; figure.textContent = String(error); });
  }
}

/** Keep every figure's style button in sync with the setting. */
export function labelFigures() {
  const label = STYLE_LABEL[document.documentElement.dataset.tikz ?? "card"];
  for (const host of Array.from(document.querySelectorAll<HTMLElement>(".np-tikz"))) {
    const button = host.shadowRoot?.querySelector(".style");
    if (button) button.textContent = label;
  }
}
