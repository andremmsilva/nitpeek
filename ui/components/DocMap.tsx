import type { Ref } from "preact";
import type { DocMap } from "../place";
import type { Intent, Note } from "../types";

type Placed = { note: Note; top: number };

/** Headings of a rendered document, with each section's notes and changes. */
export function Outline({ map, notes, section, height, onJump }: { map: DocMap; notes: Placed[]; section: number; height: number; onJump: (index: number) => void }) {
  const { headings } = map;
  const shallowest = Math.min(...headings.map(h => h.level));
  const within = (top: number, i: number) => top >= headings[i].top - 4 && (i === headings.length - 1 || top < headings[i + 1].top - 4);
  return (
    <nav class="outline" aria-label="Contents" style={{ maxHeight: Math.max(120, height - 24) + "px" }}>
      <div class="outline-title">Contents</div>
      {headings.map((heading, i) => {
        const intents: Intent[] = notes.filter(p => within(p.top, i)).map(p => p.note.intent);
        const changed = map.changes.some(c => within(c.top, i) || (c.top < heading.top && c.top + c.height > heading.top));
        return (
          <button type="button" key={i} class={"ol" + (i === section ? " on" : "")} style={{ paddingLeft: 8 + (heading.level - shallowest) * 12 + "px" }}
            title={heading.text} onClick={() => onJump(i)}>
            <span class="ol-text">{heading.text}</span>
            {intents.map((intent, k) => <i key={k} class={`ol-dot i-${intent}`} />)}
            {changed && <i class="ol-changed" title="Changed" />}
          </button>
        );
      })}
    </nav>
  );
}

/** The whole document at scrollbar scale: headings, changes and notes, and what is on screen. */
export function Strip({ map, notes, height, viewBox, onSeek, onNote }: {
  map: DocMap; notes: Placed[]; height: number; viewBox: Ref<HTMLDivElement>;
  onSeek: (fraction: number) => void; onNote: (id: string) => void;
}) {
  const at = (top: number) => ((map.offset + top) / map.total) * 100 + "%";
  return (
    <div class="strip-anchor">
      <div class="strip" style={{ height: height + "px" }} onClick={e => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onSeek((e.clientY - rect.top) / rect.height);
      }}>
        <div class="strip-view" ref={viewBox} />
        {map.headings.filter(h => h.level <= 2).map((h, i) => <i key={"h" + i} class="tick heading" style={{ top: at(h.top) }} title={h.text} />)}
        {map.changes.map((c, i) => <i key={"c" + i} class="tick change" style={{ top: at(c.top), height: Math.max(2, (c.height / map.total) * height) + "px" }} />)}
        {notes.map(({ note, top }) => (
          <i key={note.id} class={`tick note i-${note.intent}`} style={{ top: at(top) }} title={note.text || note.quote}
            onClick={e => { e.stopPropagation(); onNote(note.id); }} />
        ))}
      </div>
    </div>
  );
}
