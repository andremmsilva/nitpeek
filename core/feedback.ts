/**
 * The review notes as the agent reads them.
 *
 * Each note carries an intent that tells the agent what to do (change, ask,
 * keep, replace), a location it can open (`path:line` on the file as it is on
 * disk *now*), and the exact quote. Notes are numbered so the agent can answer
 * them one by one.
 */

import { contextOf, locateQuote } from "./quote.js";
import type { Note } from "./store.js";

export type FeedbackItem =
  | { kind: "response"; prompt: string; latest: boolean; text: string; notes: Note[] }
  | { kind: "file"; label: string; live: string | null; notes: Note[]; version: (ref: string | null) => string | null };

const MAX_QUOTE_LINES = 10;

const lineAt = (text: string, offset: number) => {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

const lines = (from: number, to: number) => (to > from ? `${from}-${to}` : `${from}`);

/** Where a file note's text is now: exact lines on disk, or an honest approximation. */
function locate(item: Extract<FeedbackItem, { kind: "file" }>, note: Note): string {
  const base = item.version(note.ref) ?? item.live ?? "";
  const from = lineAt(base, note.start), to = lineAt(base, Math.max(note.start, note.end - 1));
  if (note.side === "old") return `${item.label} (removed lines, were ${lines(from, to)})`;
  if (item.live === null) return `${item.label} (file no longer exists; was line ${lines(from, to)})`;
  if (item.live === base) return `${item.label}:${lines(from, to)}`;
  // Context comes from the reviewed version itself when it is known.
  const context = item.version(note.ref) !== null && note.source ? contextOf(base, note.start, note.end) : {};
  const hit = locateQuote(item.live, { ...note, ...context });
  if (hit) return `${item.label}:${lines(lineAt(item.live, hit[0]), lineAt(item.live, Math.max(hit[0], hit[1] - 1)))}`;
  return `${item.label} (changed since you reviewed it; was around line ${from})`;
}

function quoteBlock(text: string, prefix = "> "): string {
  let rows = text.replace(/\s+$/, "").split("\n");
  if (rows.length > MAX_QUOTE_LINES) rows = [...rows.slice(0, 6), "…", ...rows.slice(-2)];
  return rows.map(row => (prefix + row).trimEnd()).join("\n");
}

function shorten(text: string, max = 70) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

export function formatFeedback(items: FeedbackItem[]): string {
  const entries: string[] = [];
  const used = new Set<string>();
  for (const item of items) {
    const notes = [...item.notes].sort((a, b) => (a.side === "old" ? 1 : 0) - (b.side === "old" ? 1 : 0) || a.start - b.start);
    for (const [index, note] of notes.entries()) {
      used.add(note.intent);
      const where = item.kind === "response"
        ? (index > 0 ? "same response" : item.prompt ? `your response to "${shorten(item.prompt)}"` : "your response")
        : locate(item, note);
      const body = note.intent === "replace"
        ? [quoteBlock(note.quote, "- "), quoteBlock(note.replacement ?? "", "+ ")].join("\n")
        : quoteBlock(note.quote);
      const text = note.text.trim();
      entries.push(`[${entries.length + 1}] ${note.intent} · ${where}\n${body}${text ? "\n" + text : ""}`);
    }
  }
  if (!entries.length) return "";
  const legend = [
    used.has("ask") && "ask = just answer, don't edit for it",
    used.has("keep") && "keep = leave it as it is",
    used.has("replace") && "replace = apply exactly that replacement",
  ].filter(Boolean).join(" · ");
  return `Review notes (${entries.length}) — reply to each by its number.${legend ? "\n" + legend : ""}\n\n${entries.join("\n\n")}`;
}
