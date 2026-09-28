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

function FileRow({ file, selected, onClick }: { file: FileItem; selected: boolean; onClick: () => void }) {
  const slash = file.label.lastIndexOf("/");
  const directory = slash >= 0 ? file.label.slice(0, slash + 1) : "";
  const name = file.label.slice(slash + 1);
  return (
    <button type="button" class={"row file" + (selected ? " selected" : "")} onClick={onClick} title={file.path} data-path={file.path}>
      <span class="name"><span class="dir">{directory}</span>{name}</span>
      <span class="meta">
        {file.notes > 0 && <span class="count" title={`${file.notes} note${file.notes > 1 ? "s" : ""}`}>{file.notes}</span>}
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

function Items({ view, scope, current, onOpen, empty }: { view: ScopeView; scope: Scope; current: string | null; onOpen: Props["onOpen"]; empty: string }) {
  if (!view.responses.length && !view.files.length) return <p class="empty">{empty}</p>;
  return (
    <div class="items">
      {[...view.responses].reverse().map(r => <ResponseRow key={r.path} response={r} selected={current === r.path} onClick={() => onOpen(r.path, scope)} />)}
      {view.files.map(f => <FileRow key={f.path} file={f} selected={current === f.path} onClick={() => onOpen(f.path, scope)} />)}
    </div>
  );
}

const summary = (view: ScopeView) => {
  const parts = [];
  if (view.responses.length) parts.push(`${view.responses.length} ${view.responses.length === 1 ? "reply" : "replies"}`);
  if (view.files.length) parts.push(`${view.files.length} file${view.files.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "nothing";
};

function RequestGroup({ request, open, working, props }: { request: RequestItem; open: boolean; working: boolean; props: Props }) {
  const scope = `request:${request.id}` as Scope;
  return (
    <div class={"group request" + (open ? " open" : "")}>
      <button type="button" class="group-head" onClick={() => props.onGroup(scope)} aria-expanded={open}>
        <span class="req-id">#{request.id}</span>
        <span class="prompt">{request.prompt || <em>(no prompt text)</em>}</span>
        <span class="when">{working ? <span class="pulse" title="Working" /> : time(request.at)}</span>
      </button>
      {open && <Items view={request} scope={scope} current={props.current} onOpen={props.onOpen} empty="No reply or file changes." />}
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
  const since = overview.checkpoint ? "Since last Done" : "Everything so far";
  const working = overview.activity.state !== "idle";
  return (
    <nav class="sidebar" aria-label="Review">
      <button type="button" class="search" onClick={props.onSearch}>
        <span>Find a file or paste a path…</span><kbd>⌘P</kbd>
      </button>
      <section class="section">
        <div class={"group" + (group === "since" ? " open" : "")}>
          <button type="button" class="group-head scope" onClick={() => props.onGroup("since")} aria-expanded={group === "since"}>
            <span class="title">{since}</span><span class="when">{summary(overview.since)}</span>
          </button>
          {group === "since" && <Items view={overview.since} scope="since" current={props.current} onOpen={props.onOpen} empty={overview.checkpoint ? `Nothing new since Done (${relative(overview.checkpoint.at)}).` : "No replies or file changes yet."} />}
        </div>
        {overview.checkpoint && <div class={"group" + (group === "session" ? " open" : "")}>
          <button type="button" class="group-head scope" onClick={() => props.onGroup("session")} aria-expanded={group === "session"}>
            <span class="title">Whole session</span><span class="when">{summary(overview.session)}</span>
          </button>
          {group === "session" && <Items view={overview.session} scope="session" current={props.current} onOpen={props.onOpen} empty="No replies or file changes yet." />}
        </div>}
      </section>
      {overview.requests.length > 0 && (
        <section class="section">
          <div class="section-head"><span>Requests</span></div>
          {overview.requests.map((request, index) => <RequestGroup key={request.id} request={request} open={group === `request:${request.id}`} working={index === 0 && working} props={props} />)}
        </section>
      )}
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
