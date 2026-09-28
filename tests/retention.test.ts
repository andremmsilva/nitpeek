import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sweep } from "../core/retention.ts";
import { BlobStore } from "../core/snapshot.ts";
import { sandbox, suite } from "./helpers.ts";

suite("retention: old sessions and unreferenced versions", () => {
  const box = sandbox("retention");
  try {
    const home = box.directory, day = 24 * 60 * 60 * 1000, now = Date.now();
    const blobs = new BlobStore(join(home, "blobs"));
    const kept = blobs.put({ text: "kept" }).hash!, orphan = blobs.put({ text: "orphan" }).hash!, fresh = blobs.put({ text: "fresh" }).hash!, old = blobs.put({ text: "old session" }).hash!;
    const age = (path: string, days: number) => utimesSync(path, (now - days * day) / 1000, (now - days * day) / 1000);
    for (const hash of [kept, orphan, old]) age(join(home, "blobs", hash.slice(0, 2), hash), 3);
    mkdirSync(join(home, "claude")); mkdirSync(join(home, "pi"));
    const state = (hash: string) => JSON.stringify({ schema: 2, requests: [{ id: 1, changes: { "/a": { before: { hash: null }, after: { hash } } } }], drafts: {} });
    writeFileSync(join(home, "claude", "live.json"), state(kept));
    writeFileSync(join(home, "pi", "stale.json"), state(old));
    writeFileSync(join(home, "pi", "stale.scope"), "");
    age(join(home, "pi", "stale.json"), 40); age(join(home, "pi", "stale.scope"), 40);

    assert.deepEqual(sweep(home, now), { sessions: 1, blobs: 2 });
    assert.ok(existsSync(join(home, "claude", "live.json")));
    assert.ok(!existsSync(join(home, "pi", "stale.json")) && !existsSync(join(home, "pi", "stale.scope")));
    assert.equal(blobs.get({ hash: kept }).text, "kept");
    assert.equal(blobs.get({ hash: fresh }).text, "fresh", "young blobs are kept");
    assert.match(blobs.get({ hash: orphan }).error!, /missing/);
    assert.match(blobs.get({ hash: old }).error!, /missing/, "versions of removed sessions go too");
    assert.deepEqual(sweep(home, now + 1000), { skipped: true }, "at most once a day");
  } finally { box.cleanup(); }
});
