import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { clearMarks, markLines, markProse, resolveNote, selectLines, selectProse, wrapRange, type Anchor } from "../anchor";
import { contextOf } from "../../core/quote";
import { INTENTS, type Doc, type Intent, type Note, type View } from "../types";

type Props = {
  doc: Doc;
  view: View;
  wrap: boolean;
  notes: Note[];
  setNotes: (notes: Note[]) => void;
  active: string | null;
  setActive: (id: string | null) => void;
  narrow: boolean;
  notesOpen: boolean;
  onBusy: (busy: boolean) => void;
};

/** `exact`: replacement text for a change, or null when the note has none. */
type Draft = { anchor: Anchor; view: "document" | "diff"; intent: Intent; text: string; exact: string | null; editing?: string };

/** A selection in a reply that asks or offers something is most likely answered, not changed. */
const OFFER = /\?\s*["”»)]?\s*$|\b(queres|quer que|posso|podes|se quiseres|diz[- ]me|preferes|want me to|should i|shall i|do you want|would you like|let me know|if you want|prefer)\b/i;
export const suggestIntent = (doc: Doc, quote: string): Intent => doc.kind === "response" && OFFER.test(quote.trim()) ? "reply" : "change";

const newId = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const intentOf = (id: Intent) => INTENTS.find(i => i.id === id)!;

/** Which text a note is displayed against in the current view. */
function targetsFor(doc: Doc, view: View) {
  if (view === "diff" && doc.diff) return { old: { text: doc.diff.oldText, ref: doc.diff.oldRef }, new: { text: doc.diff.newText, ref: doc.diff.newRef } };
  return { new: { text: doc.text, ref: doc.ref } } as { old?: { text: string; ref: string | null }; new: { text: string; ref: string | null } };
}

function Rows({ lines, attr }: { lines: string[]; attr: string }) {
  return <>{lines.map((html, i) => (
    <div key={i} class="ln" data-row="" {...{ [`data-${attr}`]: i + 1 }}>
      <span class="gutter" data-n={i + 1} />
      <span class="src" dangerouslySetInnerHTML={{ __html: html || "" }} />
    </div>
  ))}</>;
}

function DiffRows({ doc }: { doc: Doc }) {
  const diff = doc.diff!;
  if (!diff.hunks.length) return <p class="empty pad">No textual difference in this scope.</p>;
  const out: any[] = [];
  let previousOldEnd = 1;
  diff.hunks.forEach((hunk, h) => {
    const skipped = hunk.oldStart - previousOldEnd;
    if (skipped > 0) out.push(<div class="hunk-gap" key={"g" + h}>⋯ {skipped} unchanged line{skipped === 1 ? "" : "s"}</div>);
    for (const [i, line] of hunk.lines.entries()) {
      const attrs: Record<string, string | number> = { "data-kind": line.kind };
      if (line.old !== undefined) attrs["data-old"] = line.old;
      if (line.new !== undefined) attrs["data-new"] = line.new;
      out.push(
        <div key={h + ":" + i} class={"ln d" + (line.kind === "+" ? " add" : line.kind === "-" ? " del" : "")} data-row="" {...attrs} data-words={line.words ? JSON.stringify(line.words) : undefined}>
          <span class="gutter" data-n={line.old ?? ""} />
          <span class="gutter" data-n={line.new ?? ""} />
          <span class="sign">{line.kind === " " ? "" : line.kind === "+" ? "+" : "−"}</span>
          <span class="src" dangerouslySetInnerHTML={{ __html: line.html || "" }} />
        </div>,
      );
    }
    const last = [...hunk.lines].reverse().find(l => l.old !== undefined);
    previousOldEnd = (last?.old ?? hunk.oldStart) + 1;
  });
  if (diff.truncated) out.push(<div class="hunk-gap" key="t">Diff truncated — too large to show in full.</div>);
  return <>{out}</>;
}

export function DocView(props: Props) {
  const { doc, view, notes, setNotes, active, setActive } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const margin = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  const [unanchored, setUnanchored] = useState<string[]>([]);
  const [toolbar, setToolbar] = useState<{ anchor: Anchor; view: "document" | "diff" } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [undo, setUndo] = useState<Note[] | null>(null);
  const kind = view === "diff" ? "diff" : view === "source" || (doc.kind === "file" && !doc.markdown) ? "lines" : "prose";

  useEffect(() => { props.onBusy(!!draft); }, [draft]);
  // A new document remounts this component; switching views keeps it, so reset here.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    setToolbar(null); setDraft(null); scroller.current?.scrollTo(0, 0);
  }, [view]);

  // Word-level diff emphasis, applied once per render of the rows.
  useLayoutEffect(() => {
    const root = content.current;
    if (!root || kind !== "diff") return;
    for (const row of Array.from(root.querySelectorAll<HTMLElement>("[data-words]"))) {
      const src = row.querySelector(".src")!;
      const ranges: [number, number][] = JSON.parse(row.dataset.words!);
      for (const [s, e] of [...ranges].reverse()) wrapRange(src, s, e, "np-word");
      delete row.dataset.words;
    }
  }, [doc, kind]);

  // Note highlights, then margin positions.
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    clearMarks(root, "mark.np-note");
    const targets = targetsFor(doc, view);
    const missing: string[] = [];
    const firstMark: Record<string, HTMLElement> = {};
    for (const note of notes) {
      const side = note.side === "old" ? targets.old : targets.new;
      if (!side) { if (note.side === "old") continue; missing.push(note.id); continue; }
      const range = resolveNote(note, side.text, side.ref);
      if (!range) { missing.push(note.id); continue; }
      const attrs = { "data-note": note.id, tabindex: "0" };
      const className = `np-note i-${note.intent}` + (note.id === active ? " active" : "");
      const marks = kind === "diff" ? markLines(root, side.text, range, note.side === "old" ? "old" : "new", className, attrs)
        : kind === "lines" ? markLines(root, side.text, range, "line", className, attrs)
        : markProse(root, range, note.quote, className, attrs);
      if (marks.length) firstMark[note.id] = marks[0]; else missing.push(note.id);
    }
    setUnanchored(missing);
    const base = root.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const [id, mark] of Object.entries(firstMark)) next[id] = mark.getBoundingClientRect().top - base;
    setTops(next);
  }, [doc, view, notes, active, kind, props.wrap]);

  // Stack margin cards at their anchors without overlapping.
  useLayoutEffect(() => {
    const column = margin.current;
    if (!column || props.narrow) return;
    let floor = 0;
    const cards = Array.from(column.querySelectorAll<HTMLElement>(".card[data-id]"));
    const ordered = cards.map(card => ({ card, want: tops[card.dataset.id!] ?? -1 })).sort((a, b) => a.want - b.want);
    for (const { card, want } of ordered) {
      const top = Math.max(want < 0 ? floor : want - 6, floor);
      card.style.top = top + "px";
      floor = top + card.offsetHeight + 8;
    }
    column.style.minHeight = floor + "px";
  });

  function onMouseUp(event: MouseEvent) {
    if ((event.target as Element).closest(".card, .composer, .toolbar")) return;
    requestAnimationFrame(() => {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !content.current) { setToolbar(null); return; }
      const range = selection.getRangeAt(0);
      if (!content.current.contains(range.commonAncestorContainer)) return;
      let anchor: Anchor | null = null;
      if (kind === "diff") anchor = selectLines(range, content.current, [{ attr: "new", text: doc.diff!.newText, side: "new" }, { attr: "old", text: doc.diff!.oldText, side: "old" }]);
      else if (kind === "lines") anchor = selectLines(range, content.current, [{ attr: "line", text: doc.text }]);
      else anchor = selectProse(range, content.current, doc.text);
      setToolbar(anchor ? { anchor, view: kind === "diff" ? "diff" : "document" } : null);
    });
  }

  /** Clicking a line number annotates that whole line. */
  function onGutter(event: MouseEvent) {
    const gutter = (event.target as Element).closest(".gutter");
    if (!gutter || !content.current) return;
    const row = gutter.closest<HTMLElement>("[data-row]")!;
    const range = document.createRange();
    range.selectNodeContents(row.querySelector(".src")!);
    const sides = kind === "diff"
      ? [{ attr: row.dataset.kind === "-" ? "old" : "new", text: row.dataset.kind === "-" ? doc.diff!.oldText : doc.diff!.newText, side: (row.dataset.kind === "-" ? "old" : "new") as "old" | "new" }]
      : [{ attr: "line", text: doc.text }];
    const anchor = selectLines(range, content.current, sides);
    if (anchor) openComposer({ anchor, view: kind === "diff" ? "diff" : "document" }, "change");
  }

  function openComposer(target: { anchor: Anchor; view: "document" | "diff" }, intent: Intent) {
    setToolbar(null);
    getSelection()?.removeAllRanges();
    setDraft({ ...target, intent, text: "", exact: null });
  }

  const hasExact = (d: Draft) => d.intent === "change" && d.exact !== null && d.exact !== d.anchor.quote;
  const canSave = (d: Draft) => d.intent === "keep" || !!d.text.trim() || hasExact(d);

  function save() {
    if (!draft || !canSave(draft)) return;
    if (draft.editing) {
      setNotes(notes.map(n => n.id === draft.editing ? { ...n, intent: draft.intent, text: draft.text, replacement: hasExact(draft) ? draft.exact! : undefined } : n));
    } else {
      const targets = targetsFor(doc, view);
      const side = draft.anchor.side === "old" ? targets.old! : targets.new;
      const note: Note = {
        id: newId(), intent: draft.intent, text: draft.text, quote: draft.anchor.quote, start: draft.anchor.start, end: draft.anchor.end,
        view: draft.view, ref: side.ref, createdAt: Date.now(),
        ...(draft.anchor.source ? { source: draft.anchor.source, ...contextOf(side.text, draft.anchor.start, draft.anchor.end) } : {}),
        ...(draft.anchor.side ? { side: draft.anchor.side } : {}),
        ...(hasExact(draft) ? { replacement: draft.exact! } : {}),
      };
      setNotes([...notes, note]);
      setActive(note.id);
    }
    setDraft(null);
  }

  function remove(id: string) {
    setUndo(notes);
    setNotes(notes.filter(n => n.id !== id));
    setTimeout(() => setUndo(u => (u ? null : u)), 6000);
  }

  function edit(note: Note) {
    const mark = content.current?.querySelector<HTMLElement>(`mark[data-note="${note.id}"]`);
    const rect = mark?.getBoundingClientRect() ?? content.current!.getBoundingClientRect();
    setDraft({ anchor: { quote: note.quote, start: note.start, end: note.end, side: note.side, rect }, view: note.view, intent: note.intent, text: note.text, exact: note.replacement ?? null, editing: note.id });
  }

  // Clicking a highlight focuses its note, and vice versa.
  function onClick(event: MouseEvent) {
    const mark = (event.target as Element).closest<HTMLElement>("mark.np-note");
    if (mark && getSelection()?.isCollapsed) setActive(mark.dataset.note!);
  }

  const place = (rect: DOMRect) => {
    const box = scroller.current!.getBoundingClientRect();
    return { top: rect.bottom - box.top + scroller.current!.scrollTop + 8, left: Math.max(12, Math.min(rect.left - box.left, box.width - 440)) };
  };

  const suggested = toolbar ? suggestIntent(doc, toolbar.anchor.quote) : "change";
  const ordered = useMemo(() => [...notes].sort((a, b) => (tops[a.id] ?? -1) - (tops[b.id] ?? -1)), [notes, tops]);
  const showMargin = !props.narrow || props.notesOpen;

  return (
    <div class={"doc-scroll" + (props.narrow ? " narrow" : "")} ref={scroller} onMouseUp={onMouseUp} onClick={onClick}>
      <div class={"doc-grid" + (kind === "prose" ? " reading" : "")}>
        <div class={`content ${kind}` + (props.wrap ? " wrap" : "")} ref={content} onClick={onGutter as any}>
          {kind === "prose" && <div class="prose" dangerouslySetInnerHTML={{ __html: doc.html || "" }} />}
          {kind === "lines" && <div class="code"><Rows lines={doc.lines ?? []} attr="line" /></div>}
          {kind === "diff" && <div class={"code diff" + (doc.diff!.removed === 0 && doc.diff!.hunks[0]?.oldStart === 0 ? " created" : "")}><DiffRows doc={doc} /></div>}
        </div>
        {showMargin && (
          <aside class={"margin" + (props.narrow ? " drawer" : "")} ref={margin} aria-label="Notes">
            {!notes.length && <p class="empty margin-empty">Select text to add a note.<br /><span>Or click a line number.</span></p>}
            {ordered.map(note => (
              <div key={note.id} data-id={note.id} class={`card i-${note.intent}` + (note.id === active ? " active" : "") + (unanchored.includes(note.id) ? " lost" : "")}
                onMouseEnter={() => setActive(note.id)} onClick={() => {
                  setActive(note.id);
                  content.current?.querySelector(`mark[data-note="${note.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                }}>
                <div class="card-head">
                  <span class={`chip i-${note.intent}`}>{intentOf(note.intent).label}</span>
                  {note.side === "old" && <span class="tag">removed text</span>}
                  {unanchored.includes(note.id) && <span class="tag" title="The quoted text is not in this version">{note.side === "old" ? "only in Diff" : "not found here"}</span>}
                  <span class="spacer" />
                  <button type="button" class="icon small" title="Edit" onClick={e => { e.stopPropagation(); edit(note); }}>✎</button>
                  <button type="button" class="icon small" title="Delete" onClick={e => { e.stopPropagation(); remove(note.id); }}>✕</button>
                </div>
                <blockquote>{note.quote.length > 160 ? note.quote.slice(0, 160) + "…" : note.quote}</blockquote>
                {note.replacement !== undefined && <pre class="replacement">{note.replacement}</pre>}
                {note.text && <p class="text">{note.text}</p>}
              </div>
            ))}
          </aside>
        )}
      </div>

      {toolbar && (
        <div class="toolbar" style={place(toolbar.anchor.rect)} role="toolbar" aria-label="Add a note">
          {INTENTS.map(intent => (
            <button type="button" class={`chip i-${intent.id}` + (intent.id === suggested ? " on" : "")} title={`${intent.hint} (${intent.key}${intent.id === suggested ? " or ↵" : ""})`} onMouseDown={e => e.preventDefault()} onClick={() => openComposer(toolbar, intent.id)}>
              {intent.label}<kbd>{intent.key}</kbd>
            </button>
          ))}
        </div>
      )}
      {toolbar && <ToolbarKeys suggested={suggested} onPick={intent => openComposer(toolbar, intent)} onClose={() => setToolbar(null)} />}

      {draft && (
        <div class={`composer i-${draft.intent}`} style={place(draft.anchor.rect)} onMouseUp={e => e.stopPropagation()}>
          <div class="intents" role="radiogroup" aria-label="Intent">
            {INTENTS.map(intent => (
              <button type="button" role="radio" aria-checked={draft.intent === intent.id} class={`chip i-${intent.id}` + (draft.intent === intent.id ? " on" : "")} title={intent.hint}
                onClick={() => setDraft({ ...draft, intent: intent.id })}>{intent.label}</button>
            ))}
          </div>
          <p class="intent-hint">{intentOf(draft.intent).hint}</p>
          <blockquote>{draft.anchor.quote.length > 200 ? draft.anchor.quote.slice(0, 200) + "…" : draft.anchor.quote}</blockquote>
          {draft.intent === "change" && (draft.exact === null
            ? <button type="button" class="link exact-toggle" onClick={() => setDraft({ ...draft, exact: draft.anchor.quote })}>+ Exact replacement text</button>
            : <div class="exact">
                <textarea class="replacement" rows={Math.min(8, draft.exact.split("\n").length + 1)} value={draft.exact} aria-label="Exact replacement text"
                  onInput={e => setDraft({ ...draft, exact: (e.target as HTMLTextAreaElement).value })} onKeyDown={e => composerKeys(e, save, () => setDraft(null))} />
                <button type="button" class="link exact-toggle" onClick={() => setDraft({ ...draft, exact: null })}>Remove exact text</button>
              </div>)}
          <textarea ref={el => el && !el.dataset.focused && (el.dataset.focused = "1", el.focus())} rows={3} value={draft.text}
            placeholder={{ change: draft.exact !== null ? "Why? (optional)" : "What should change?", reply: "Your answer — e.g. “yes, go ahead”", question: "Your question…", keep: "Why keep it? (optional)" }[draft.intent]}
            onInput={e => setDraft({ ...draft, text: (e.target as HTMLTextAreaElement).value })} onKeyDown={e => composerKeys(e, save, () => setDraft(null))} />
          <div class="composer-foot">
            <span class="hint">⌘↵ save · Esc cancel</span>
            <button type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" class="primary" onClick={save} disabled={!canSave(draft)}>{draft.editing ? "Update" : "Add note"}</button>
          </div>
        </div>
      )}

      {undo && (
        <div class="undo">Note deleted <button type="button" onClick={() => { setNotes(undo); setUndo(null); }}>Undo</button></div>
      )}
    </div>
  );
}

function composerKeys(event: KeyboardEvent, save: () => void, cancel: () => void) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
}

function ToolbarKeys({ suggested, onPick, onClose }: { suggested: Intent; onPick: (intent: Intent) => void; onClose: () => void }) {
  // Layout effect: the keys work as soon as the toolbar is visible.
  useLayoutEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const intent = INTENTS.find(i => i.key === event.key);
      if (intent) { event.preventDefault(); event.stopPropagation(); onPick(intent.id); }
      else if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onPick(suggested); }
      else if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", handler, true);
    return () => removeEventListener("keydown", handler, true);
  }, [onPick]);
  return null;
}
