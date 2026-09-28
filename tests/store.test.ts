import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashText } from "../core/snapshot.ts";
import { note, sandbox, suite } from "./helpers.ts";

suite("store: timeline, scopes, checkpoint, notes", () => {
  const box = sandbox("store");
  try {
    const store = box.store();
    const path = join(box.directory, "doc.md");
    const capture = (id: string, content: string) => { store.begin(id, path); writeFileSync(path, content); store.end(id, false); };

    writeFileSync(path, "# Before\n");
    store.nextRequest("first");
    capture("a", "# After\n");
    store.response("r1", "Changed the title.");
    store.nextRequest("second");
    capture("b", "# After\n\nMore.\n");
    capture("c", "# After\n\nMore text.\n");

    const overview = store.overview();
    assert.deepEqual(overview.requests.map(r => r.id), [2, 1]);
    assert.equal(overview.requests[0].prompt, "second");
    assert.deepEqual(overview.requests[0].files.map(f => [f.added, f.removed]), [[2, 0]], "request 2 spans both of its edits");
    assert.deepEqual(overview.requests[1].responses.map(r => r.path), ["message:r1"]);
    assert.equal(overview.session.files[0].removed, 1);

    assert.match(JSON.stringify(store.document(path, "request:1").diff), /# Before/);
    assert.doesNotMatch(JSON.stringify(store.document(path, "request:2").diff!.hunks), /# Before/);
    assert.equal(store.document(path, "session").diff!.added, 3);

    // Failed tool calls and no-op writes record nothing.
    store.begin("failed", path); store.end("failed", true);
    capture("same", "# After\n\nMore text.\n");
    assert.equal(store.pending.size, 0);
    assert.equal(Object.keys(store.request.changes).length, 1);

    // Uncaptured changes between recorded ones are flagged.
    writeFileSync(path, "# Edited by hand\n");
    assert.match(store.document(path).warning!, /Disk differs/);
    capture("d", "# Agent again\n");
    assert.equal(store.overview().session.files[0].external, true);

    // Checkpoint: "since" empties, then shows only what happens next.
    store.checkpoint();
    assert.equal(store.overview().since.files.length, 0);
    assert.equal(store.overview().since.responses.length, 0);
    store.nextRequest("third");
    capture("e", "# Agent again\n\nNew.\n");
    store.response("r2", "Added a line.");
    const since = store.overview().since;
    assert.equal(since.files[0].added, 2);
    assert.equal(since.files[0].removed, 0);
    assert.deepEqual(since.responses.map(r => r.path), ["message:r2"]);

    // Notes: validation, persistence, feedback, clearing.
    const doc = store.document(path);
    assert.equal(doc.ref, hashText(doc.text));
    assert.throws(() => store.saveNotes(path, [{ id: "bad id!" }]), /Invalid note/);
    assert.throws(() => store.saveNotes("/not/in/review", []), /Unknown document/);
    store.saveNotes(path, [note({ quote: "New.", start: doc.text.indexOf("New."), end: doc.text.indexOf("New.") + 4, ref: doc.ref })]);
    const reopened = box.store();
    assert.equal(reopened.state.drafts[path].length, 1);
    assert.match(reopened.feedback(), /\[1\] change · doc\.md:3/);
    reopened.setGeneral("Also update the changelog.");
    assert.match(reopened.feedback(), /General: Also update the changelog\./);
    assert.equal(reopened.overview().general, "Also update the changelog.");
    assert.throws(() => reopened.setGeneral(42), /Invalid general note/);
    reopened.clearDrafts();
    assert.equal(reopened.feedback(), "");
    assert.equal(reopened.overview().general, "");

    // Notes saved with the old intents are migrated, on load and on save.
    reopened.saveNotes(path, [note({ quote: "New.", start: 0, end: 4, ref: null, intent: "ask" as any }), note({ quote: "New.", start: 0, end: 4, ref: null, intent: "replace" as any, replacement: "Newer." })]);
    assert.deepEqual(reopened.state.drafts[path].map(n => [n.intent, n.replacement]), [["question", undefined], ["change", "Newer."]]);
    const legacy = JSON.parse(JSON.stringify(reopened.state));
    legacy.drafts[path][0].intent = "ask";
    writeFileSync(reopened.statePath, JSON.stringify(legacy));
    assert.equal(box.store().state.drafts[path][0].intent, "question");
    reopened.clearDrafts();

    // Manual files have no diff until an agent edits them.
    const manual = join(box.directory, "read.txt");
    writeFileSync(manual, "hello\n");
    store.addFile(manual);
    assert.equal(store.document(manual).diff, null);
    assert.match(store.document(manual).diffNote!, /Opened for reading/);
    assert.equal(store.overview().opened[0].label, "read.txt");

    // New files, deletions and binaries.
    const created = join(box.directory, "new.txt");
    store.begin("new", created); writeFileSync(created, "x\n"); store.end("new", false);
    assert.equal(store.overview().session.files.find(f => f.path === created)!.created, true);
    const binary = join(box.directory, "bin");
    store.begin("bin", binary); writeFileSync(binary, Buffer.from([0, 1])); store.end("bin", false);
    assert.equal(store.overview().session.files.find(f => f.path === binary)!.error, "Binary file");
    assert.match(store.document(binary).diffNote!, /Diff unavailable/);

    // Activity and responses are persisted; responses are immutable.
    store.setActivity("working");
    assert.equal(box.store().overview().activity.state, "working");
    store.response("r2", "different text");
    assert.equal(store.state.responses["message:r2"].markdown, "Added a line.");
    assert.equal(store.overview().since.responses[0].preview, "Added a line.");
    assert.equal(store.latestText(path), "# Agent again\n\nNew.\n");
  } finally { box.cleanup(); }
});
