import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, suite } from "./helpers.ts";

suite("browse: explicit roots, fuzzy search, containment", () => {
  const box = sandbox("browse");
  try {
    const project = join(box.directory, "project"), output = join(box.directory, "generated");
    mkdirSync(project); mkdirSync(output); mkdirSync(join(project, ".git"));
    const script = join(project, "make-results.py"), result = join(output, "results-summary.json");
    writeFileSync(script, 'print("hello")\n');
    writeFileSync(result, '{"score": 42}\n');
    writeFileSync(join(project, ".git", "ignored"), "secret");
    symlinkSync(output, join(project, "escape"));
    const store = box.store(project);
    assert.deepEqual(store.browse(project).entries.map(e => e.name), ["make-results.py"], ".git and symlinks are skipped");
    assert.deepEqual(store.search("rsm").results, []);
    assert.equal(store.search(output + "/").exact?.kind, "folder");
    assert.equal(store.search(result).exact?.kind, "file");
    assert.deepEqual(store.search(output + "/").results, [], "a path is offered, not browsed");
    assert.throws(() => store.browse(output), /Location not opened/);
    assert.throws(() => store.openBrowsableFile(result), /Location not opened/);
    assert.throws(() => store.openBrowsableFile(join(project, "escape", "results-summary.json")), /Location not opened/);
    assert.equal(store.addLocation(output).directory, output);
    assert.equal(store.browse(output).entries[0].name, "results-summary.json");
    assert.ok(store.search(output + "/").results.every(hit => hit.path.startsWith(output + "/")));
    const hit = store.search("rsm").results[0];
    assert.equal(hit.path, result);
    assert.equal(hit.recorded, false);
    assert.equal(store.openBrowsableFile(hit.path), result);
    assert.equal(store.document(result).text, '{"score": 42}\n');
    assert.equal(store.search("rsm").results[0].recorded, true);
    assert.ok(box.store(project).overview().roots.some(r => r.path === output), "locations persist");
    assert.equal(store.addLocation("make-results.py").file, script);
    assert.throws(() => store.addLocation(join(output, "missing")), /Path not found/);
  } finally { box.cleanup(); }
});
