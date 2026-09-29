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
  for (const host of Array.from(root.querySelectorAll<HTMLElement>(".np-math"))) {
    if (host.shadowRoot) continue;
    const template = host.querySelector<HTMLTemplateElement>(":scope > template");
    if (!template) continue;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = SHADOW_STYLE;
    shadow.append(template.content.cloneNode(true));
    host.title = host.textContent!.trim();
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
