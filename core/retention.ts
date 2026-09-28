/**
 * Keeps ~/.nitpeek from growing forever. At most once a day: session states
 * untouched for 30 days are removed, then stored file versions that no
 * remaining session references. Fresh blobs are kept, as a session may have
 * written one it has not referenced in its state yet.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;
const BLOB_GRACE = DAY;

function files(directory: string) {
  try { return readdirSync(directory).map(name => join(directory, name)); } catch { return []; }
}

export function sweep(home: string, now = Date.now(), force = false) {
  const marker = join(home, ".last-sweep");
  try { if (!force && now - statSync(marker).mtimeMs < DAY) return { skipped: true }; } catch {}
  if (!existsSync(home)) return { skipped: true };
  writeFileSync(marker, String(now), { mode: 0o600 });

  let sessions = 0, blobs = 0;
  const referenced = new Set<string>();
  for (const host of ["pi", "claude"]) {
    for (const path of files(join(home, host))) {
      if (!/\.(json|scope)$/.test(path)) continue;
      if (now - statSync(path).mtimeMs > SESSION_TTL) { rmSync(path, { force: true }); if (/(?<!\.tail)\.json$/.test(path)) sessions++; continue; }
      if (!path.endsWith(".json") || path.endsWith(".tail.json")) continue;
      try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        for (const request of state.requests ?? []) for (const change of Object.values<any>(request.changes ?? {})) { referenced.add(change.before?.hash); referenced.add(change.after?.hash); }
        for (const notes of Object.values<any>(state.drafts ?? {})) for (const note of notes) referenced.add(note.ref);
        for (const ref of Object.values<any>(state.checkpoint?.versions ?? {})) referenced.add(ref?.hash);
      } catch { /* unreadable state: keep everything it might reference */ return { sessions, blobs, skipped: true }; }
    }
  }
  for (const bucket of files(join(home, "blobs"))) {
    for (const blob of files(bucket)) {
      const hash = blob.split("/").at(-1)!;
      if (!referenced.has(hash) && now - statSync(blob).mtimeMs > BLOB_GRACE) { rmSync(blob, { force: true }); blobs++; }
    }
  }
  return { sessions, blobs };
}
