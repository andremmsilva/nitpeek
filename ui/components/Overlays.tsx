import { useEffect, useRef, useState } from "preact/hooks";
import { get, post } from "../api";
import type { Settings } from "../types";

// ── Find (⌘P) ──────────────────────────────────────────────────────────

type Hit = { path: string; label: string; recorded: boolean };
type Exact = { path: string; label: string; kind: "folder" | "file" } | null;

export function Palette({ recent, onOpenFile, onOpenFolder, onClose }: { recent: Hit[]; onOpenFile: (path: string) => void; onOpenFolder: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [exact, setExact] = useState<Exact>(null);
  const [truncated, setTruncated] = useState(false);
  const [cursor, setCursor] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    if (!query.trim()) { setHits([]); setExact(null); setTruncated(false); return; }
    const id = ++sequence.current;
    const timer = setTimeout(async () => {
      try {
        const result = await get("/api/review/search", { q: query });
        if (id !== sequence.current) return;
        setHits(result.results); setExact(result.exact); setTruncated(result.truncated); setCursor(0);
      } catch {}
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);
  const items: { key: string; label: string; detail?: string; group: string; run: () => void }[] = [];
  if (exact) items.push({ key: "exact", label: exact.label, group: "Path", run: () => exact.kind === "folder" ? onOpenFolder(exact.path) : onOpenFile(exact.path) });
  const list = query.trim() ? hits : recent;
  for (const hit of list) {
    const slash = hit.label.lastIndexOf("/");
    items.push({ key: hit.path, label: hit.label.slice(slash + 1), detail: slash >= 0 ? hit.label.slice(0, slash) : "", group: !query.trim() ? "Recent" : hit.recorded ? "In review" : "Files", run: () => onOpenFile(hit.path) });
  }
  const pick = (index: number) => { items[index]?.run(); };
  return (
    <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-label="Find a file">
        <input autoFocus value={query} placeholder="File name, or a path like /tmp/run-42/" aria-label="Find a file"
          onInput={e => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor(c => Math.min(c + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(cursor); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }} />
        <div class="hits" role="listbox">
          {items.map((item, index) => (
            <>
              {(index === 0 || items[index - 1].group !== item.group) && <div class="hit-group">{item.group}</div>}
              <button type="button" role="option" aria-selected={index === cursor} class={"hit" + (index === cursor ? " on" : "")} key={item.key}
                onMouseEnter={() => setCursor(index)} onClick={() => pick(index)}>
                <span class="hit-name">{item.label}</span>{item.detail && <span class="hit-detail">{item.detail}</span>}
              </button>
            </>
          ))}
          {!items.length && <p class="empty pad">{query.trim() ? "No matches in the project or opened folders." : "Type to search the project, or paste a path."}</p>}
          {truncated && <p class="empty pad">Search stopped early — refine the query.</p>}
        </div>
      </div>
    </div>
  );
}

// ── Done ───────────────────────────────────────────────────────────────

export function DoneDialog({ host, general: initial, onClose, onDone }: { host: string; general: string; onClose: () => void; onDone: (message: string) => void }) {
  const [preview, setPreview] = useState<{ feedback: string; deliveryNote: string } | null>(null);
  const [general, setGeneral] = useState(initial);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const saved = useRef(Promise.resolve());
  const load = () => get("/api/review/preview").then(setPreview).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  // The general note is saved as you type, so closing the dialog keeps it.
  useEffect(() => {
    if (general === initial) return;
    const timer = setTimeout(() => { saved.current = post("/api/review/general", { text: general }).then(load).catch(e => setError(e.message)); }, 250);
    return () => clearTimeout(timer);
  }, [general]);
  async function send() {
    setSending(true); setError("");
    try { await post("/api/review/general", { text: general }); await saved.current; const result = await post("/api/review/done"); onDone(result.message); }
    catch (e) { setError((e as Error).message); setSending(false); }
  }
  return (
    <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && preview?.feedback) { e.preventDefault(); send(); }
    }}>
      <div class="dialog done" role="dialog" aria-label="Send notes">
        <h2>Send notes to {host}</h2>
        <p class="muted">{preview?.deliveryNote ?? "Preparing…"}</p>
        <textarea class="general" rows={2} value={general} placeholder="General note (optional) — e.g. “run the tests afterwards”" aria-label="General note"
          onInput={e => setGeneral((e.target as HTMLTextAreaElement).value)} />
        {preview && (preview.feedback ? <pre class="preview">{preview.feedback}</pre> : <p class="empty pad">No notes yet — select text in a reply or file, or write a general note.</p>)}
        {error && <p class="error">{error}</p>}
        <footer>
          <span class="hint">After sending, “Since last Done” starts from here.</span>
          <button type="button" onClick={onClose}>Keep reviewing</button>
          <button type="button" class="primary" autoFocus disabled={(!preview?.feedback && !general.trim()) || sending} onClick={send}>{sending ? "Sending…" : `Send to ${host}`}<kbd>⌘↵</kbd></button>
        </footer>
      </div>
    </div>
  );
}

// ── Settings ───────────────────────────────────────────────────────────

export function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange: (s: Settings) => void; onClose: () => void }) {
  const [error, setError] = useState("");
  async function update(patch: Partial<Settings>) {
    onChange({ ...settings, ...patch });
    try { onChange(await post("/api/settings", patch)); setError(""); } catch (e) { setError((e as Error).message); }
  }
  return (
    <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => e.key === "Escape" && onClose()}>
      <div class="dialog settings" role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <label>Theme
          <select value={settings.theme} onChange={e => update({ theme: (e.target as HTMLSelectElement).value as Settings["theme"] })}>
            <option value="system">Follow system</option><option value="dark">Dark</option><option value="light">Light</option><option value="midnight">Midnight</option>
          </select>
        </label>
        <label>Reading font
          <select value={settings.proseFont} onChange={e => update({ proseFont: (e.target as HTMLSelectElement).value as Settings["proseFont"] })}>
            <option value="serif">Serif</option><option value="sans">Sans</option>
          </select>
        </label>
        <label>Code size <span class="value">{settings.codeFontSize}px</span>
          <input type="range" min={10} max={22} value={settings.codeFontSize} onInput={e => update({ codeFontSize: Number((e.target as HTMLInputElement).value) })} />
        </label>
        <p class="muted">Saved for every session in ~/.nitpeek/settings.json.</p>
        {error && <p class="error">{error}</p>}
        <footer><button type="button" class="primary" autoFocus onClick={onClose}>Close</button></footer>
      </div>
    </div>
  );
}

// ── Shortcuts ──────────────────────────────────────────────────────────

const SHORTCUTS: [string, string][] = [
  ["⌘P", "Find a file or paste a path"],
  ["j / k", "Next / previous item in the list"],
  ["n / N", "Next / previous note"],
  ["d", "Toggle Document / Diff"],
  ["s", "Toggle rendered / source (Markdown, LaTeX)"],
  ["w", "Wrap long code lines on / off"],
  ["1 – 4", "With text selected: Change, Reply, Question, Keep"],
  ["↵", "With text selected: the suggested intent"],
  ["⌘↵", "In a note: save · otherwise: Done"],
  ["[", "Toggle the sidebar"],
  ["?", "This help"],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div class="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => e.key === "Escape" && onClose()}>
      <div class="dialog help" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard</h2>
        <dl>{SHORTCUTS.map(([key, what]) => <><dt><kbd>{key}</kbd></dt><dd>{what}</dd></>)}</dl>
        <footer><button type="button" class="primary" autoFocus onClick={onClose}>Close</button></footer>
      </div>
    </div>
  );
}
