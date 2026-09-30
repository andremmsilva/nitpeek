export type Intent = "change" | "reply" | "question" | "keep";
export const INTENTS: { id: Intent; label: string; hint: string; key: string }[] = [
  { id: "change", label: "Change", hint: "The agent changes this — optionally to your exact text", key: "1" },
  { id: "reply", label: "Reply", hint: "Your answer to what the agent asked or offered — it acts on it", key: "2" },
  { id: "question", label: "Question", hint: "The agent only answers — no edits for it", key: "3" },
  { id: "keep", label: "Keep", hint: "The agent leaves this as it is", key: "4" },
];

export type Note = {
  id: string; intent: Intent; text: string; replacement?: string;
  quote: string; source?: string; prefix?: string; suffix?: string; start: number; end: number;
  view: "document" | "diff"; side?: "old" | "new"; ref: string | null; createdAt: number;
};

export type Activity = { state: "working" | "idle" | "blocked"; since: number };
export type FileItem = { path: string; label: string; notes: number; added?: number; removed?: number; created?: boolean; deleted?: boolean; error?: string; external?: boolean; request?: number; outside?: boolean };
export type ResponseItem = { path: string; request: number; at: number; preview: string; notes: number; latest: boolean };
export type ScopeView = { responses: ResponseItem[]; files: FileItem[] };
export type RequestItem = ScopeView & { id: number; prompt: string; at: number; since: boolean };
export type Scope = "since" | "session" | `request:${number}`;

export type Overview = {
  sessionId: string; cwd: string; host: string; demo: boolean;
  activity: Activity; checkpoint: { at: number } | null;
  since: ScopeView; session: ScopeView; requests: RequestItem[]; opened: FileItem[];
  roots: { path: string; label: string }[]; notes: number; general: string; latestResponse: string | null;
  focus: number; target: { path?: string; folder?: string };
};

export type DiffLine = { kind: " " | "+" | "-"; old?: number; new?: number; html: string; text: string; words?: [number, number][] };
export type Diff = { hunks: { oldStart: number; newStart: number; lines: DiffLine[] }[]; added: number; removed: number; truncated?: boolean; oldRef: string | null; newRef: string | null; oldText: string; newText: string };

export type Doc = {
  kind: "response" | "file"; path: string; label: string; text: string; ref: string | null;
  /** `rendered`: has a Rendered view (Markdown, LaTeX) besides the source. */
  html: string | null; rendered: boolean; lines: string[] | null; notes: Note[];
  diff: Diff | null; diffNote: string | null; warning: string | null; manual?: boolean;
  prompt: string | null; request: number | null; latest: boolean | null;
};

export type Settings = { theme: "system" | "dark" | "light" | "midnight"; codeFontSize: number; proseFont: "serif" | "sans"; wrap: boolean; tikz: "card" | "adapted" | "plain"; tables: "fit" | "scroll" };
export type View = "document" | "source" | "diff";
