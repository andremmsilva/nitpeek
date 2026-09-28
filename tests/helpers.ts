import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../core/snapshot.ts";
import { ReviewStore, type Note } from "../core/store.ts";

export function sandbox(name: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `nitpeek-${name}-`)));
  const blobs = new BlobStore(join(directory, "blobs"));
  return {
    directory, blobs,
    store: (cwd = directory, state = join(directory, "state.json")) => new ReviewStore(cwd, state, "test-session", blobs),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function note(partial: Partial<Note> & Pick<Note, "quote" | "start" | "end" | "ref">): Note {
  return { id: "n" + Math.random().toString(36).slice(2, 8), intent: "change", text: "fix", view: "document", createdAt: Date.now(), ...partial };
}

export function suite(name: string, run: () => void | Promise<void>) {
  Promise.resolve().then(run).then(() => console.log(`PASS ${name}`), error => { console.error(`FAIL ${name}\n`, error); process.exit(1); });
}
