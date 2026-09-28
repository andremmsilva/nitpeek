import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_FILE = 512 * 1024;

/** File contents at one moment. `text: null` means absent or unreadable (see `error`). */
export type Snapshot = { text: string | null; error?: string };
/** A stored snapshot: `hash` points into the blob store, `null` means the file did not exist. */
export type SnapRef = { hash: string | null; error?: string };

export const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

export function fromText(text: string | null | undefined): Snapshot {
  if (text === null || text === undefined) return { text: null };
  if (Buffer.byteLength(text) > MAX_FILE) return { text: null, error: "Larger than 512 KiB" };
  if (text.includes("\0")) return { text: null, error: "Binary file" };
  return { text: normalize(text) };
}

export function readSnapshot(path: string): Snapshot {
  try {
    if (!existsSync(path)) return { text: null };
    const stat = statSync(path);
    if (!stat.isFile()) return { text: null, error: "Not a regular file" };
    if (stat.size > MAX_FILE) return { text: null, error: "Larger than 512 KiB" };
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return { text: null, error: "Binary file" };
    return { text: normalize(buffer.toString("utf8")) };
  } catch { return { text: null, error: "Unable to read file" }; }
}

export const sameRef = (a?: SnapRef, b?: SnapRef) => !!a && !!b && a.hash === b.hash && a.error === b.error;

/** Content-addressed, write-once snapshot storage shared by every session. */
export class BlobStore {
  constructor(public directory: string) {}
  put(snapshot: Snapshot): SnapRef {
    if (snapshot.text === null) return snapshot.error ? { hash: null, error: snapshot.error } : { hash: null };
    const hash = hashText(snapshot.text);
    const path = join(this.directory, hash.slice(0, 2), hash);
    if (!existsSync(path)) {
      mkdirSync(join(this.directory, hash.slice(0, 2)), { recursive: true, mode: 0o700 });
      writeFileSync(path + ".tmp", snapshot.text, { mode: 0o600 });
      renameSync(path + ".tmp", path);
    }
    return { hash };
  }
  get(ref: SnapRef | undefined): Snapshot {
    if (!ref) return { text: null, error: "Unknown version" };
    if (ref.hash === null) return ref.error ? { text: null, error: ref.error } : { text: null };
    try { return { text: readFileSync(join(this.directory, ref.hash.slice(0, 2), ref.hash), "utf8") }; }
    catch { return { text: null, error: "Stored version is missing" }; }
  }
}
