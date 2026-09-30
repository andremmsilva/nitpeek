// ── Table width ────────────────────────────────────────────────────────
// Tables either fit the reading width, wrapping inside their cells, or keep their lines and scroll sideways.

export const TABLE_WIDTHS = ["fit", "scroll"] as const;
const LABEL: Record<string, string> = { fit: "fit to width", scroll: "scroll" };

const BUTTON_STYLE = `<style>
  :host { position: absolute; top: -8px; right: -6px; z-index: 1; user-select: none; -webkit-user-select: none; }
  button { opacity: 0; transition: opacity .15s; font: 11px -apple-system, system-ui, sans-serif; border: 1px solid rgba(128,128,128,.45);
    background: rgba(128,128,128,.14); color: inherit; border-radius: 5px; padding: 1px 7px; cursor: pointer; }
</style>`;

const label = () => LABEL[document.documentElement.dataset.tables ?? "fit"];

/** Whether the table's lines fit the room it has; if so, fitting and scrolling look the same and the button hides. */
function fits(frame: HTMLElement, table: HTMLTableElement) {
  const room = frame.parentElement;
  if (!room) return true;
  const style = getComputedStyle(room);
  const width = room.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  table.style.width = "max-content";
  const needed = table.offsetWidth;
  table.style.width = "";
  return needed <= width + 1;
}

/**
 * Put each table in a scroll box with a width button; the button's text lives in a shadow root, outside the quotable text.
 * Returns a cleanup that stops following the page's width.
 */
export function hydrateTables(root: HTMLElement): () => void {
  const frames: [HTMLElement, HTMLTableElement][] = [];
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>("table"))) {
    if (table.parentElement?.classList.contains("np-table-scroll")) { frames.push([table.parentElement.parentElement!, table]); continue; }
    const frame = document.createElement("div"), scroll = document.createElement("div"), host = document.createElement("span");
    frame.className = "np-table";
    scroll.className = "np-table-scroll";
    host.className = "np-table-width";
    table.replaceWith(frame);
    scroll.append(table);
    frame.append(scroll, host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${BUTTON_STYLE}<button type="button" part="button" title="Tables: fit to width · scroll sideways"></button>`;
    const button = shadow.querySelector("button")!;
    for (const type of ["mousedown", "mouseup"]) button.addEventListener(type, e => e.stopPropagation());
    button.addEventListener("click", e => { e.stopPropagation(); dispatchEvent(new Event("nitpeek-table-width")); });
    button.textContent = label();
    frames.push([frame, table]);
  }
  const update = () => { for (const [frame, table] of frames) frame.classList.toggle("fits", fits(frame, table)); };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(root);
  for (const [frame] of frames) if (frame.parentElement && frame.parentElement !== root) observer.observe(frame.parentElement);
  return () => observer.disconnect();
}

/** Keep every table's width button in sync with the setting. */
export function labelTables() {
  for (const host of Array.from(document.querySelectorAll<HTMLElement>(".np-table-width"))) {
    const button = host.shadowRoot?.querySelector("button");
    if (button) button.textContent = label();
  }
}
