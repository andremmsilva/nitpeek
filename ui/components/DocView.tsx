import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { clearMarks, markLines, markProse, resolveNote, selectLines, selectProse, wrapRange, type Anchor } from "../anchor";
import { contextOf } from "../../core/quote";
import { atomize, decorateMath, hydrateMath, hydrateTikz, selectMath, trackMathSelection } from "../math";
import { get } from "../api";
import { capturePlace, changedLines, HEADINGS, measureMap, restorePlace, type DocMap, type Place } from "../place";
import { Outline, Strip } from "./DocMap";
import { INTENTS, type Doc, type Intent, type Note, type View } from "../types";

type Props = {
  doc: Doc;
  view: View;
  wrap: boolean;
  onToggleWrap: () => void;
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

/** Where a note's highlight is drawn: a formula shows the marks inside it. */
export const visibleMark = (mark: HTMLElement | null) => mark?.closest<HTMLElement>(".np-math") ?? mark;

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
  const [offscreen, setOffscreen] = useState({ above: 0, below: 0, height: 0 });
  const kind = view === "diff" ? "diff" : view === "source" || (doc.kind === "file" && !doc.rendered) ? "lines" : "prose";

  useEffect(() => { props.onBusy(!!draft); }, [draft]);

  // Where the reader is, kept up to date so a view switch can return there:
  // the focused note if it is on screen, else the source line at the top.
  const reading = useRef<Place | null>(null);
  const notePlace = useRef<{ id: string; y: number } | null>(null);
  const placeText = () => kind === "diff" ? doc.diff!.newText : doc.text;
  function capture() {
    const el = scroller.current, root = content.current;
    if (!el || !root) return;
    reading.current = capturePlace(el, root, kind, placeText());
    const mark = active ? visibleMark(root.querySelector<HTMLElement>(`mark[data-note="${active}"]`)) : null;
    const box = el.getBoundingClientRect(), rect = mark?.getBoundingClientRect();
    notePlace.current = rect && rect.bottom > box.top && rect.top < box.bottom ? { id: active!, y: rect.top - box.top } : null;
  }
  useEffect(capture, [active]);

  // The document at a glance: headings, what the agent changed, where notes are.
  const grid = useRef<HTMLDivElement>(null);
  const stripView = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<DocMap | null>(null);
  const [section, setSection] = useState(-1);
  const created = !!doc.diff && doc.diff.removed === 0 && doc.diff.hunks[0]?.oldStart === 0;
  const changed = useMemo(() => kind === "diff" || created ? null : changedLines(doc.diff, doc.text), [doc, kind]);
  useLayoutEffect(() => {
    const el = scroller.current, root = content.current;
    if (!el || !root) return;
    const update = () => setMap(measureMap(el, root, kind, doc.text, changed));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    if (grid.current) observer.observe(grid.current);
    return () => observer.disconnect();
  }, [doc, kind, changed]);

  /** Moves the strip's viewport box and the outline's current section with the scroll. */
  function track() {
    const el = scroller.current;
    if (!el || !map) return;
    if (stripView.current) {
      stripView.current.style.top = (el.scrollTop / el.scrollHeight) * 100 + "%";
      stripView.current.style.height = (el.clientHeight / el.scrollHeight) * 100 + "%";
    }
    const y = el.scrollTop - map.offset + 80;
    setSection(map.headings.reduce((current, h, i) => (h.top <= y ? i : current), -1));
  }
  useLayoutEffect(track, [map, offscreen.height]);

  function jumpToHeading(index: number) {
    const heading = content.current?.querySelectorAll<HTMLElement>(HEADINGS)[index], el = scroller.current;
    if (heading && el) el.scrollTo({ top: el.scrollTop + heading.getBoundingClientRect().top - el.getBoundingClientRect().top - 16, behavior: "smooth" });
  }

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

  // Formulas render once per document; the selection look follows them.
  useLayoutEffect(() => {
    if (!content.current || kind !== "prose") return;
    hydrateMath(content.current);
    hydrateTikz(content.current, key => get("/api/review/tikz", { key }));
    return trackMathSelection(content.current);
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
    if (kind === "prose") { decorateMath(root); hydrateTikz(root, key => get("/api/review/tikz", { key })); }
    setUnanchored(missing);
    const base = root.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const [id, mark] of Object.entries(firstMark)) next[id] = visibleMark(mark)!.getBoundingClientRect().top - base;
    setTops(next);
  }, [doc, view, notes, active, kind, props.wrap]);

  // A new document remounts this component; switching views keeps it, so reset
  // here and scroll back to the same place (after the note marks are drawn).
  const firstView = useRef(true);
  useLayoutEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    setToolbar(null); setDraft(null);
    const el = scroller.current!, root = content.current!, note = notePlace.current;
    const mark = note ? visibleMark(root.querySelector<HTMLElement>(`mark[data-note="${note.id}"]`)) : null;
    if (mark) el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top - note!.y;
    else restorePlace(el, root, kind, placeText(), reading.current);
    capture();
  }, [view]);

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
    measureOffscreen();
  });

  /** How many margin cards sit wholly above or below what is on screen. */
  function offscreenCards() {
    const column = margin.current, box = scroller.current?.getBoundingClientRect();
    const above: HTMLElement[] = [], below: HTMLElement[] = [];
    if (!column || !box || props.narrow) return { above, below };
    // From the laid-out tops, not the rects: cards slide to their places.
    const origin = column.getBoundingClientRect().top;
    for (const card of Array.from(column.querySelectorAll<HTMLElement>(".card[data-id]"))) {
      const top = origin + parseFloat(card.style.top || "0");
      if (top + card.offsetHeight <= box.top) above.push(card);
      else if (top >= box.bottom) below.push(card);
    }
    return { above, below };
  }

  function measureOffscreen() {
    const { above, below } = offscreenCards();
    const height = scroller.current?.clientHeight ?? 0;
    setOffscreen(o => o.above === above.length && o.below === below.length && o.height === height ? o : { above: above.length, below: below.length, height });
  }

  const onScroll = useRef(() => {});
  onScroll.current = () => { measureOffscreen(); capture(); track(); };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => onScroll.current()); };
    el.addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); el.removeEventListener("scroll", schedule); removeEventListener("resize", schedule); };
  }, []);

  /** Focuses a note and brings its highlight (or, without one, its card) into view. */
  function reveal(id: string) {
    setActive(id);
    const target = visibleMark(content.current?.querySelector<HTMLElement>(`mark[data-note="${id}"]`) ?? null)
      ?? margin.current?.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** The nearest off-screen note in a direction. */
  function revealNext(direction: "above" | "below") {
    const cards = offscreenCards()[direction];
    const card = direction === "above" ? cards.reduce<HTMLElement | undefined>((a, c) => !a || parseFloat(c.style.top) > parseFloat(a.style.top) ? c : a, undefined)
      : cards.reduce<HTMLElement | undefined>((a, c) => !a || parseFloat(c.style.top) < parseFloat(a.style.top) ? c : a, undefined);
    if (card) reveal(card.dataset.id!);
  }

  function onMouseUp(event: MouseEvent) {
    if ((event.target as Element).closest(".card, .composer, .toolbar, .np-wrap, .more-notes, .strip, .outline")) return;
    const math = kind === "prose" ? (event.target as Element).closest<HTMLElement>(".np-math") : null;
    requestAnimationFrame(() => {
      const selection = getSelection();
      // Clicking a formula selects it whole (a noted one focuses its note instead).
      if (math && selection?.isCollapsed && !math.dataset.note) selectMath(math);
      if (!selection || selection.isCollapsed || !content.current) { setToolbar(null); return; }
      const range = kind === "prose" ? atomize(selection.getRangeAt(0)) : selection.getRangeAt(0);
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
    const mark = visibleMark(content.current?.querySelector<HTMLElement>(`mark[data-note="${note.id}"]`) ?? null);
    const rect = mark?.getBoundingClientRect() ?? content.current!.getBoundingClientRect();
    setDraft({ anchor: { quote: note.quote, start: note.start, end: note.end, side: note.side, rect }, view: note.view, intent: note.intent, text: note.text, exact: note.replacement ?? null, editing: note.id });
  }

  // Clicking a highlight focuses its note, and vice versa.
  function onClick(event: MouseEvent) {
    if ((event.target as Element).closest(".np-wrap")) { props.onToggleWrap(); return; }
    const mark = (event.target as Element).closest<HTMLElement>("mark.np-note, .np-math[data-note]");
    if (mark && getSelection()?.isCollapsed) setActive(mark.dataset.note!);
  }

  const place = (rect: DOMRect) => {
    const box = scroller.current!.getBoundingClientRect();
    return { top: rect.bottom - box.top + scroller.current!.scrollTop + 8, left: Math.max(12, Math.min(rect.left - box.left, box.width - 440)) };
  };

  const suggested = toolbar ? suggestIntent(doc, toolbar.anchor.quote) : "change";
  const ordered = useMemo(() => [...notes].sort((a, b) => (tops[a.id] ?? -1) - (tops[b.id] ?? -1)), [notes, tops]);
  const showMargin = !props.narrow || props.notesOpen;
  const placed = ordered.filter(n => tops[n.id] !== undefined && !unanchored.includes(n.id)).map(note => ({ note, top: tops[note.id] }));
  const outlined = kind === "prose" && !props.narrow && (map?.headings.length ?? 0) >= 2;
  const strip = map && offscreen.height > 0 && map.total > offscreen.height * 1.5;

  return (
    <div class={"doc-scroll" + (props.narrow ? " narrow" : "")} ref={scroller} onMouseUp={onMouseUp} onClick={onClick}>
      {strip && <Strip map={map!} notes={placed} height={offscreen.height} viewBox={stripView} onNote={reveal}
        onSeek={f => scroller.current!.scrollTo({ top: f * map!.total - offscreen.height / 2, behavior: "smooth" })} />}
      <div class={"doc-grid" + (kind === "prose" ? " reading" : "") + (outlined ? " outlined" : "")} ref={grid}>
        {outlined && <Outline map={map!} notes={placed} section={section} height={offscreen.height} onJump={jumpToHeading} />}
        <div class={`content ${kind}` + (props.wrap ? " wrap" : "")} ref={content} onClick={onGutter as any}>
          {map?.changes.map((c, i) => <i key={"chg" + i} class="changed-bar" style={{ top: c.top + "px", height: c.height + "px" }} title="Changed" />)}
          {kind === "prose" && <div class="prose" dangerouslySetInnerHTML={{ __html: doc.html || "" }} />}
          {kind === "lines" && <div class="code"><Rows lines={doc.lines ?? []} attr="line" /></div>}
          {kind === "diff" && <div class={"code diff" + (doc.diff!.removed === 0 && doc.diff!.hunks[0]?.oldStart === 0 ? " created" : "")}><DiffRows doc={doc} /></div>}
        </div>
        {showMargin && (
          <aside class={"margin" + (props.narrow ? " drawer" : "")} ref={margin} aria-label="Notes">
            {!props.narrow && (offscreen.above > 0 || offscreen.below > 0) && (
              <div class="margin-nav">
                <div class="margin-nav-frame" style={{ height: offscreen.height + "px" }}>
                  {offscreen.above > 0 && <button type="button" class="more-notes up" title="Go to the previous note" onClick={() => revealNext("above")}>↑ {offscreen.above} more {offscreen.above === 1 ? "note" : "notes"}</button>}
                  {offscreen.below > 0 && <button type="button" class="more-notes down" title="Go to the next note" onClick={() => revealNext("below")}>↓ {offscreen.below} more {offscreen.below === 1 ? "note" : "notes"}</button>}
                </div>
              </div>
            )}
            {!notes.length && <p class="empty margin-empty">Select text to add a note.<br /><span>Or click a line number.</span></p>}
            {ordered.map(note => (
              <div key={note.id} data-id={note.id} class={`card i-${note.intent}` + (note.id === active ? " active" : "") + (unanchored.includes(note.id) ? " lost" : "")}
                onMouseEnter={() => setActive(note.id)} onClick={() => reveal(note.id)}>
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
