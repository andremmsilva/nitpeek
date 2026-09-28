import assert from "node:assert/strict";
import { lineStarts, position, resolveNote } from "../ui/anchor.ts";
import { note, suite } from "./helpers.ts";

suite("ui anchors: positions and re-anchoring", () => {
  const text = "alpha\nbeta gamma\n\ndelta beta\n";
  const starts = lineStarts(text);
  assert.deepEqual(position(starts, 0), { line: 1, col: 0 });
  assert.deepEqual(position(starts, 8), { line: 2, col: 2 });
  assert.deepEqual(position(starts, 18), { line: 4, col: 0 });
  const second = text.lastIndexOf("beta");
  const n = note({ quote: "beta", start: second, end: second + 4, ref: "v1", prefix: text.slice(second - 6, second), suffix: text.slice(second + 4) });
  assert.deepEqual(resolveNote(n, text, "v1"), [second, second + 4], "same version: stored offsets");
  const edited = "new first line\n" + text;
  assert.deepEqual(resolveNote(n, edited, "v2"), [edited.lastIndexOf("beta"), edited.lastIndexOf("beta") + 4], "nearest occurrence after an edit");
  assert.equal(resolveNote(n, "nothing here", "v3"), null);
  const bare = note({ quote: "beta", start: 6, end: 10, ref: "v1" });
  assert.deepEqual(resolveNote(bare, edited, "v2"), [21, 25], "without context, the nearest occurrence");
  const spaced = note({ quote: "beta   gamma", start: 6, end: 16, ref: "old" });
  assert.deepEqual(resolveNote(spaced, text, "v1"), [6, 16], "whitespace-insensitive fallback");
});
