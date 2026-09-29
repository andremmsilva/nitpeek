import { useEffect, useState } from "preact/hooks";
import { get } from "../api";
import type { FileItem, Overview, RequestItem, ResponseItem, Scope, ScopeView } from "../types";

type Props = {
  overview: Overview;
  group: Scope;
  current: string | null;
  onGroup: (scope: Scope) => void;
  onOpen: (path: string, scope: Scope) => void;
  onOpenBrowsable: (path: string) => void;
  onSearch: () => void;
  expandFolder: { path: string; n: number } | null;
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function relative(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

/** Long names that share a prefix differ at the end: cut in the middle. */
const middle = (text: string, max: number) => text.length <= max ? text : text.slice(0, Math.ceil(max / 2) - 2) + "…" + text.slice(-(Math.floor(max / 2) + 1));

function FileRow({ file, selected, onClick, turn }: { file: FileItem; selected: boolean; onClick: () => void; turn?: boolean }) {
  const slash = file.label.lastIndexOf("/");
  const directory = slash >= 0 ? file.label.slice(0, slash + 1) : "";
  const name = file.label.slice(slash + 1);
  return (
    <button type="button" class={"row file" + (selected ? " selected" : "")} onClick={onClick} title={file.path} data-path={file.path}>
      <span class="name file-name"><span class="base">{middle(name, 26)}</span>{directory && <span class="dir">{"\u200e" + directory.replace(/\/$/, "") + "\u200e"}</span>}</span>
      <span class="meta">
        {file.notes > 0 && <span class="count" title={`${file.notes} note${file.notes > 1 ? "s" : ""}`}>{file.notes}</span>}
        {turn && file.request ? <span class="turn-tag" title={`Last changed in request #${file.request}`}>#{file.request}</span> : null}
        {file.error ? <span class="warn" title={file.error}>!</span>
          : file.created ? <span class="stat add">new</span>
          : file.deleted ? <span class="stat del">deleted</span>
          : file.added !== undefined && <span class="stat"><span class="add">+{file.added}</span> <span class="del">−{file.removed}</span></span>}
      </span>
    </button>
  );
}

function ResponseRow({ response, selected, onClick }: { response: ResponseItem; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" class={"row response" + (selected ? " selected" : "")} onClick={onClick} data-path={response.path}>
      <span class="name"><span class="glyph">❝</span>{response.preview}</span>
      <span class="meta">{response.notes > 0 && <span class="count">{response.notes}</span>}</span>
    </button>
  );
}

const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Every file changed in the scope, newest change first; files outside the project fold away. */
function ChangedFiles({ view, scope, props }: { view: ScopeView; scope: Scope; props: Props }) {
  const [showOutside, setShowOutside] = useState(false);
  const inside = view.files.filter(f => !f.outside), outside = view.files.filter(f => f.outside);
  return (
    <div class="items">
      {inside.map(f => <FileRow key={f.path} file={f} turn selected={props.current === f.path} onClick={() => props.onOpen(f.path, scope)} />)}
      {outside.length > 0 && (
        <>
          <button type="button" class="twisty outside-toggle" onClick={() => setShowOutside(!showOutside)} aria-expanded={showOutside}>
            <span class="chevron">{showOutside ? "▾" : "▸"}</span>Outside the project · {outside.length}
          </button>
          {showOutside && outside.map(f => <FileRow key={f.path} file={f} turn selected={props.current === f.path} onClick={() => props.onOpen(f.path, scope)} />)}
        </>
      )}
    </div>
  );
}

/** One turn: your prompt, then what the agent answered and changed. */
function Turn({ request, open, working, onToggle, props }: { request: RequestItem; open: boolean; working: boolean; onToggle: () => void; props: Props }) {
  const scope = `request:${request.id}` as Scope;
  const parts = [request.responses.length ? count(request.responses.length, "reply", "replies") : "", request.files.length ? count(request.files.length, "file") : ""].filter(Boolean);
  const holdsCurrent = [...request.responses.map(r => r.path), ...request.files.map(f => f.path)].includes(props.current ?? "");
  return (
    <div class={"group request" + (open ? " open" : "") + (holdsCurrent && !open ? " holds" : "")}>
      <button type="button" class="group-head" onClick={onToggle} aria-expanded={open}>
        <span class="req-id">#{request.id}</span>
        <span class="prompt">{request.prompt || <em>(no prompt text)</em>}</span>
        <span class="when">{working ? <span class="pulse" title="Working" /> : open ? time(request.at) : parts.join(" · ") || time(request.at)}</span>
      </button>
      {open && (
        <div class="items">
          {[...request.responses].reverse().map(r => <ResponseRow key={r.path} response={r} selected={props.current === r.path} onClick={() => props.onOpen(r.path, scope)} />)}
          {request.files.map(f => <FileRow key={f.path} file={f} selected={props.current === f.path} onClick={() => props.onOpen(f.path, scope)} />)}
          {!request.responses.length && !request.files.length && <p class="empty">{working ? "Working…" : "No reply or file changes."}</p>}
        </div>
      )}
    </div>
  );
}

// ── Browse ─────────────────────────────────────────────────────────────

type Listing = { entries: { name: string; path: string; directory: boolean }[]; truncated?: boolean; error?: string };

function useFolders() {
  const [folders, setFolders] = useState<Record<string, Listing>>({});
  const load = async (path: string, force = false) => {
    if (!force && folders[path]) return;
    try { const listing = await get("/api/review/browse", { path }); setFolders(f => ({ ...f, [path]: listing })); }
    catch (error) { setFolders(f => ({ ...f, [path]: { entries: [], error: (error as Error).message } })); }
  };
  return { folders, load };
}

function Folder({ path, label, depth, state, props }: { path: string; label: string; depth: number; state: ReturnType<typeof useFolders> & { expanded: Set<string>; toggle: (p: string) => void }; props: Props }) {
  const open = state.expanded.has(path);
  // Compact single-child folder chains (src.main.java), like IntelliJ packages.
  const chain = [{ path, label }];
  if (open) {
    for (;;) {
      const listing = state.folders[chain.at(-1)!.path];
      if (!listing || listing.error || listing.entries.length !== 1 || !listing.entries[0].directory) break;
      const child = listing.entries[0];
      chain.push({ path: child.path, label: child.name });
    }
  }
  const terminal = chain.at(-1)!.path;
  useEffect(() => { if (open) state.load(terminal); }, [open, terminal]);
  const listing = state.folders[terminal];
  return (
    <div class="folder">
      <div class="folder-head" style={{ paddingLeft: 8 + depth * 12 }}>
        <button type="button" class="twisty" onClick={() => state.toggle(path)} aria-expanded={open} title={chain.map(c => c.path).join(" / ")}>
          <span class="chevron">{open ? "▾" : "▸"}</span>{chain.map(c => c.label).join(".")}
        </button>
        {open && <button type="button" class="icon small" title="Refresh folder" onClick={() => chain.forEach(c => state.load(c.path, true))}>↻</button>}
      </div>
      {open && listing && (
        <div class="folder-body">
          {listing.error && <p class="empty" style={{ paddingLeft: 20 + depth * 12 }}>{listing.error}</p>}
          {listing.entries.map(entry => entry.directory
            ? <Folder key={entry.path} path={entry.path} label={entry.name} depth={depth + 1} state={state} props={props} />
            : <button key={entry.path} type="button" class={"row leaf" + (props.current === entry.path ? " selected" : "")} style={{ paddingLeft: 22 + depth * 12 }} onClick={() => props.onOpenBrowsable(entry.path)} title={entry.path} data-path={entry.path}>{entry.name}</button>)}
          {!listing.error && !listing.entries.length && <p class="empty" style={{ paddingLeft: 22 + depth * 12 }}>Empty folder</p>}
          {listing.truncated && <p class="empty">First 500 entries shown.</p>}
        </div>
      )}
    </div>
  );
}

function Browse({ props }: { props: Props }) {
  const folders = useFolders();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [open, setOpen] = useState(false);
  const toggle = (path: string) => setExpanded(set => { const next = new Set(set); next.has(path) ? next.delete(path) : next.add(path); return next; });
  useEffect(() => {
    if (!props.expandFolder) return;
    const path = props.expandFolder.path;
    setOpen(true);
    setExpanded(set => new Set(set).add(path));
    folders.load(path, true);
  }, [props.expandFolder]);
  return (
    <section class="section">
      <button type="button" class="section-head toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Browse</span><span class="chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && props.overview.roots.map(root => <Folder key={root.path} path={root.path} label={root.label} depth={0} state={{ ...folders, expanded, toggle }} props={props} />)}
    </section>
  );
}

export function Sidebar(props: Props) {
  const { overview, group } = props;
  const scope: Scope = group === "session" && overview.checkpoint ? "session" : "since";
  const view = scope === "session" ? overview.session : overview.since;
  const working = overview.activity.state !== "idle";
  const turns = overview.requests.filter(r => scope === "session" || r.since);
  // The newest turn starts open; the others open on click.
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const isOpen = (request: RequestItem, index: number) => toggled[request.id] ?? index === 0;
  return (
    <nav class="sidebar" aria-label="Review">
      <button type="button" class="search" onClick={props.onSearch}>
        <span>Find a file or paste a path…</span><kbd>⌘P</kbd>
      </button>
      {overview.checkpoint && (
        <div class="scope-switch" role="tablist">
          <button type="button" role="tab" aria-selected={scope === "since"} class={scope === "since" ? "on" : ""} onClick={() => props.onGroup("since")} title={`Since your last Done (${relative(overview.checkpoint.at)})`}>Since last Done</button>
          <button type="button" role="tab" aria-selected={scope === "session"} class={scope === "session" ? "on" : ""} onClick={() => props.onGroup("session")}>Whole session</button>
        </div>
      )}
      <section class="section">
        <div class="section-head"><span>Changed files</span><span class="when">{view.files.length || ""}</span></div>
        {view.files.length ? <ChangedFiles view={view} scope={scope} props={props} />
          : <p class="empty pad-side">{overview.checkpoint && scope === "since" ? `No file changes since Done (${relative(overview.checkpoint.at)}).` : "No file changes yet."}</p>}
      </section>
      <section class="section">
        <div class="section-head"><span>Conversation</span><span class="when">{turns.length ? count(turns.length, "turn") : ""}</span></div>
        {turns.map((request, index) => <Turn key={request.id} request={request} open={isOpen(request, index)} working={index === 0 && working && request.id === overview.requests[0]?.id}
          onToggle={() => setToggled(t => ({ ...t, [request.id]: !isOpen(request, index) }))} props={props} />)}
        {!turns.length && <p class="empty pad-side">{scope === "since" && overview.checkpoint ? "Nothing new since Done." : "No requests yet."}</p>}
      </section>
      {overview.opened.length > 0 && (
        <section class="section">
          <div class="section-head"><span>Opened for reading</span></div>
          <div class="items">{overview.opened.map(f => <FileRow key={f.path} file={f} selected={props.current === f.path} onClick={() => props.onOpen(f.path, "session")} />)}</div>
        </section>
      )}
      <Browse props={props} />
    </nav>
  );
}
