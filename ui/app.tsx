import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { BOOT, get, notifyClosed, post } from "./api";
import { DocView } from "./components/DocView";
import { DoneDialog, Palette, SettingsDialog, Shortcuts } from "./components/Overlays";
import { Sidebar, relative } from "./components/Sidebar";
import type { Doc, Note, Overview, Scope, Settings, View } from "./types";

const DEFAULT_SETTINGS: Settings = { theme: "system", codeFontSize: 14, proseFont: "serif" };

function applySettings(settings: Settings) {
  const root = document.documentElement;
  const theme = settings.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : settings.theme;
  root.dataset.theme = theme;
  root.dataset.prose = settings.proseFont;
  root.style.setProperty("--code-size", settings.codeFontSize + "px");
}

function useNarrow() {
  const query = "(max-width: 1180px)";
  const [narrow, setNarrow] = useState(matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const listener = () => setNarrow(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return narrow;
}

/** Items of the selected sidebar group, in display order (for j/k). */
function groupItems(overview: Overview, group: Scope): string[] {
  const view = group === "since" ? overview.since : group === "session" ? overview.session : overview.requests.find(r => `request:${r.id}` === group);
  return view ? [...[...view.responses].reverse().map(r => r.path), ...view.files.map(f => f.path)] : [];
}

type Toast = { id: number; text: string; action?: { label: string; run: () => void } };

function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [offline, setOffline] = useState("");
  const [settings, setSettings] = useState<Settings>(BOOT.settings ?? DEFAULT_SETTINGS);
  const [group, setGroup] = useState<Scope>("since");
  const [current, setCurrent] = useState<{ path: string; scope: Scope } | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [docError, setDocError] = useState("");
  const [view, setView] = useState<View>("document");
  const [wrap, setWrap] = useState(true);
  const [notes, setNotesState] = useState<Note[]>([]);
  const [save, setSave] = useState<"saved" | "saving" | "error">("saved");
  const [active, setActive] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<null | "find" | "done" | "settings" | "help">(null);
  const [sidebar, setSidebar] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [expandFolder, setExpandFolder] = useState<{ path: string; n: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [menu, setMenu] = useState(false);
  const recent = useRef<{ path: string; label: string; recorded: boolean }[]>([]);
  const seenFocus = useRef(-1);
  const seenResponse = useRef<string | null | undefined>(undefined);
  const writes = useRef(Promise.resolve());
  const narrow = useNarrow();

  useEffect(() => applySettings(settings), [settings]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const listener = () => applySettings(settings);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [settings]);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? 9000 : 5000);
  }, []);

  // ── Loading ──────────────────────────────────────────────────────────

  const open = useCallback(async (path: string, scope: Scope, options: { keepView?: boolean } = {}) => {
    try {
      const next: Doc = await get("/api/review/document", { path, scope });
      setDoc(next); setDocError(""); setNotesState(next.notes); setSave("saved"); setDiskChanged(false); setActive(null);
      setCurrent({ path, scope });
      if (!options.keepView) setView(next.kind === "file" && next.diff && !next.manual ? "diff" : "document");
      if (next.kind === "file") recent.current = [{ path, label: next.label, recorded: !next.manual }, ...recent.current.filter(r => r.path !== path)].slice(0, 8);
    } catch (error) { setDocError((error as Error).message); }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next: Overview = await get("/api/review/overview");
      setOverview(next); setOffline("");
      return next;
    } catch (error) { setOffline((error as Error).message); return null; }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const first = await refresh();
      if (!first || !alive) return;
      seenFocus.current = first.focus;
      seenResponse.current = first.latestResponse;
      if (first.target.folder) setExpandFolder({ path: first.target.folder, n: Date.now() });
      const initial = first.target.path ?? (first.since.responses.at(-1)?.path) ?? first.since.files[0]?.path ?? first.session.responses.at(-1)?.path;
      if (initial) await open(initial, first.since.files.some(f => f.path === initial) || first.since.responses.some(r => r.path === initial) ? "since" : "session");
    })();
    const timer = setInterval(refresh, 2000);
    addEventListener("pagehide", notifyClosed);
    return () => { alive = false; clearInterval(timer); removeEventListener("pagehide", notifyClosed); };
  }, []);

  // /annotate again: jump to its target and bring the tab forward.
  useEffect(() => {
    if (!overview || overview.focus === seenFocus.current) return;
    seenFocus.current = overview.focus;
    window.focus();
    if (overview.target.folder) setExpandFolder({ path: overview.target.folder, n: Date.now() });
    if (overview.target.path && !composing) open(overview.target.path, "session");
  }, [overview?.focus]);

  // A new reply arrives: offer it, never switch away from the current document.
  useEffect(() => {
    if (!overview || seenResponse.current === undefined || overview.latestResponse === seenResponse.current) return;
    seenResponse.current = overview.latestResponse;
    const path = overview.latestResponse;
    if (path) toast(`New reply from ${overview.host}`, { label: "Open", run: () => open(path, "since") });
  }, [overview?.latestResponse]);

  // Changes on disk are offered, not applied under your notes.
  useEffect(() => {
    if (!doc || doc.kind !== "file") return;
    const timer = setInterval(async () => {
      try { const { ref } = await get("/api/review/stat", { path: doc.path }); setDiskChanged(ref !== doc.ref); } catch {}
    }, 2500);
    return () => clearInterval(timer);
  }, [doc]);

  // ── Notes ────────────────────────────────────────────────────────────

  const setNotes = useCallback((next: Note[]) => {
    setNotesState(next);
    if (!doc) return;
    const path = doc.path;
    setSave("saving");
    // Serialized: a slow older write must never overwrite a newer one.
    writes.current = writes.current.catch(() => {}).then(() => post("/api/review/notes", { path, notes: next }))
      .then(() => { setSave("saved"); refresh(); })
      .catch(() => setSave("error"));
  }, [doc]);

  const retrySave = () => setNotes(notes);

  // ── Actions ──────────────────────────────────────────────────────────

  async function openBrowsable(path: string) {
    try { const result = await post("/api/review/open-file", { path }); await refresh(); await open(result.path, "session"); setOverlay(null); }
    catch (error) { toast((error as Error).message); }
  }
  async function openFolder(path: string) {
    try {
      const result = await post("/api/review/location", { path });
      await refresh();
      setExpandFolder({ path: result.directory, n: Date.now() });
      if (result.file) await open(result.file, "session");
      setOverlay(null);
    } catch (error) { toast((error as Error).message); }
  }
  function selectGroup(scope: Scope) {
    setGroup(scope);
    if (current && overview) {
      const items = groupItems(overview, scope);
      if (items.includes(current.path)) open(current.path, scope, { keepView: true });
    }
  }
  function onDone(message: string) {
    setOverlay(null);
    toast(message);
    setGroup("since");
    if (doc) setNotesState([]);
    refresh();
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const typing = (event.target as Element).closest("input, textarea, select, [contenteditable]");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") { event.preventDefault(); setOverlay("find"); return; }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !typing && !overlay && !composing) { event.preventDefault(); setOverlay("done"); return; }
      if (event.key === "Escape" && overlay) { setOverlay(null); return; }
      if (typing || overlay || composing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") { setMenu(false); setActive(null); }
      if (!overview) return;
      if (event.key === "j" || event.key === "k") {
        const items = groupItems(overview, group);
        if (!items.length) return;
        const index = current ? items.indexOf(current.path) : -1;
        const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === "j" ? 1 : -1)))];
        if (next && next !== current?.path) open(next, group);
      } else if (event.key === "n" || event.key === "N") {
        const marks = Array.from(document.querySelectorAll<HTMLElement>("mark.np-note[data-note]"));
        const ids = [...new Set(marks.map(m => m.dataset.note!))];
        if (!ids.length) return;
        const index = active ? ids.indexOf(active) : -1;
        const id = ids[(index + (event.key === "n" ? 1 : -1) + ids.length) % ids.length];
        setActive(id);
        document.querySelector(`mark[data-note="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (event.key === "d" && doc?.diff) setView(v => v === "diff" ? "document" : "diff");
      else if (event.key === "s" && doc?.markdown) setView(v => v === "source" ? "document" : "source");
      else if (event.key === "[") setSidebar(s => !s);
      else if (event.key === "?") setOverlay("help");
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [overview, group, current, doc, active, overlay, composing]);

  // ── Render ───────────────────────────────────────────────────────────

  const host = overview?.host ?? BOOT.host;
  const activity = overview?.activity.state ?? "idle";
  const crumbs = useMemo(() => {
    if (!doc || doc.kind !== "file") return [];
    const absolute = doc.label.startsWith("/");
    const parts = doc.label.split("/").filter(Boolean);
    const base = absolute ? "" : overview?.cwd ?? "";
    return parts.map((part, i) => ({ part, path: (absolute ? "/" : base + "/") + parts.slice(0, i + 1).join("/") }));
  }, [doc?.path, overview?.cwd]);

  if (!overview) return <div class="boot">{offline ? <p>Disconnected — reopen <code>/annotate</code>. <span class="muted">{offline}</span></p> : <p class="muted">Loading…</p>}</div>;

  return (
    <div class={"app" + (sidebar ? "" : " no-sidebar")}>
      <header class="top">
        <button type="button" class="icon" title="Toggle sidebar ([)" onClick={() => setSidebar(!sidebar)}>☰</button>
        <span class="brand">nit<span class="peek">peek</span></span>
        <span class="session" title={overview.cwd}>{host} · {overview.cwd.split("/").pop()}</span>
        <span class={"activity " + activity} title={`Since ${relative(overview.activity.since)}`}>
          {activity === "working" ? `${host} is working` : activity === "blocked" ? `${host} is waiting for you` : "idle"}
        </span>
        {BOOT.demo && <span class="tag">demo</span>}
        {offline && <span class="tag warn">disconnected</span>}
        <span class="spacer" />
        <span class={"save " + save}>{save === "saving" ? "Saving…" : save === "error" ? <>Couldn’t save <button type="button" class="link" onClick={retrySave}>Retry</button></> : overview.notes || overview.general ? "Notes saved · not sent" : ""}</span>
        <button type="button" class="icon" title="Keyboard shortcuts (?)" onClick={() => setOverlay("help")}>?</button>
        <button type="button" class="icon" title="Settings" onClick={() => setOverlay("settings")}>⚙</button>
        <button type="button" class="primary done-button" onClick={() => setOverlay("done")} title="Review and send your notes (⌘↵)">
          Done{overview.notes || overview.general ? <span class="badge">{overview.notes + (overview.general ? 1 : 0)}</span> : null}
        </button>
      </header>

      {sidebar && <Sidebar overview={overview} group={group} current={current?.path ?? null} onGroup={selectGroup} onOpen={(path, scope) => { setGroup(scope); open(path, scope); }}
        onOpenBrowsable={openBrowsable} onSearch={() => setOverlay("find")} expandFolder={expandFolder} />}

      <main class="main">
        {!doc && !docError && (
          <div class="welcome">
            <h1>Nothing to review yet</h1>
            <p>Replies and files changed by {host} appear on the left as they happen. You can also <button type="button" class="link" onClick={() => setOverlay("find")}>open any file</button>.</p>
          </div>
        )}
        {docError && <div class="welcome"><p class="error">{docError}</p></div>}
        {doc && (
          <>
            <div class="doc-head">
              <div class="title-row">
                {doc.kind === "response" ? (
                  <div class="title">
                    <span class="kind">Reply</span>
                    {doc.prompt ? <span class="prompt" title={doc.prompt}>to #{doc.request} “{doc.prompt}”</span> : <span class="prompt">#{doc.request}</span>}
                  </div>
                ) : (
                  <div class="crumbs" title={doc.path}>
                    {doc.label.startsWith("/") && <span class="sep">/</span>}
                    {crumbs.map((c, i) => i < crumbs.length - 1
                      ? <><button type="button" class="crumb" title={`Open ${c.path} in Browse`} onClick={() => openFolder(c.path)}>{c.part}</button><span class="sep">/</span></>
                      : <strong class="file">{c.part}</strong>)}
                  </div>
                )}
                <span class="spacer" />
                <div class="tabs" role="tablist">
                  {doc.kind === "file" && (
                    <button type="button" role="tab" aria-selected={view === "diff"} class={view === "diff" ? "on" : ""} disabled={!doc.diff} title={doc.diff ? "Recorded changes (d)" : doc.diffNote ?? ""} onClick={() => setView("diff")}>
                      Diff{doc.diff && <span class="stat"><span class="add">+{doc.diff.added}</span><span class="del">−{doc.diff.removed}</span></span>}
                    </button>
                  )}
                  <button type="button" role="tab" aria-selected={view === "document"} class={view === "document" ? "on" : ""} onClick={() => setView("document")}>{doc.markdown ? "Rendered" : "File"}</button>
                  {doc.markdown && <button type="button" role="tab" aria-selected={view === "source"} class={view === "source" ? "on" : ""} onClick={() => setView("source")} title="Markdown source (s)">Source</button>}
                </div>
                <div class="menu-wrap">
                  <button type="button" class="icon" aria-haspopup="menu" aria-expanded={menu} title="More" onClick={() => setMenu(!menu)}>⋯</button>
                  {menu && (
                    <div class="menu" role="menu" onClick={() => setMenu(false)}>
                      {doc.kind === "file" && <button type="button" role="menuitem" onClick={() => navigator.clipboard.writeText(doc.path).then(() => toast("Path copied"))}>Copy path</button>}
                      {doc.kind === "file" && <button type="button" role="menuitem" onClick={() => openFolder(doc.path.slice(0, doc.path.lastIndexOf("/")) || "/")}>Show folder in Browse</button>}
                      {doc.kind === "response" && <button type="button" role="menuitem" onClick={() => navigator.clipboard.writeText(doc.text).then(() => toast("Reply copied as Markdown"))}>Copy reply as Markdown</button>}
                      {(view !== "document" || !doc.markdown) && <button type="button" role="menuitem" onClick={() => setWrap(!wrap)}>{wrap ? "Don’t wrap lines" : "Wrap lines"}</button>}
                      {doc.kind === "file" && <button type="button" role="menuitem" onClick={() => current && open(current.path, current.scope, { keepView: true })}>Reload from disk</button>}
                    </div>
                  )}
                </div>
                {narrow && <button type="button" class={"notes-toggle" + (notesOpen ? " on" : "")} onClick={() => setNotesOpen(!notesOpen)}>Notes{notes.length ? ` · ${notes.length}` : ""}</button>}
              </div>
              {(doc.warning || diskChanged || (view === "diff" && current?.scope !== "session" && doc.diff)) && (
                <div class="notices">
                  {diskChanged && <span class="notice live">Changed on disk <button type="button" class="link" onClick={() => current && open(current.path, current.scope, { keepView: true })}>Reload</button>{notes.length ? " — notes follow their quotes" : ""}</span>}
                  {doc.warning && !diskChanged && <span class="notice" title={doc.warning}>{doc.warning}</span>}
                  {view === "diff" && doc.diff && current && current.scope !== "session" && <span class="notice scope">{current.scope === "since" ? (overview.checkpoint ? "Changes since your last Done" : "All recorded changes") : `Changes made in request #${current.scope.slice(8)}`}</span>}
                </div>
              )}
            </div>
            <DocView key={doc.path + ":" + doc.ref} doc={doc} view={view} wrap={wrap} notes={notes} setNotes={setNotes} active={active} setActive={setActive}
              narrow={narrow} notesOpen={notesOpen} onBusy={setComposing} />
          </>
        )}
      </main>

      {overlay === "find" && <Palette recent={recent.current} onOpenFile={openBrowsable} onOpenFolder={openFolder} onClose={() => setOverlay(null)} />}
      {overlay === "done" && <DoneDialog host={host} general={overview.general} onClose={() => { setOverlay(null); refresh(); }} onDone={onDone} />}
      {overlay === "settings" && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setOverlay(null)} />}
      {overlay === "help" && <Shortcuts onClose={() => setOverlay(null)} />}

      <div class="toasts" aria-live="polite">
        {toasts.map(t => <div class="toast" key={t.id}>{t.text}{t.action && <button type="button" class="link" onClick={() => { t.action!.run(); setToasts(x => x.filter(y => y.id !== t.id)); }}>{t.action.label}</button>}</div>)}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
