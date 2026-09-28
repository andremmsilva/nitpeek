import assert from "node:assert/strict";
import { formatFeedback } from "../core/feedback.ts";
import { note, suite } from "./helpers.ts";

suite("feedback: intents, locations, relocation", () => {
  const reviewed = "line one\nline two\nconst x = 1;\nline four\n";
  const version = (ref: string | null) => ref === "v1" ? reviewed : null;
  const at = (q: string) => ({ quote: q, start: reviewed.indexOf(q), end: reviewed.indexOf(q) + q.length, ref: "v1" });

  // Unchanged file: exact lines.
  let text = formatFeedback([{ kind: "file", label: "src/a.ts", live: reviewed, version, notes: [note({ ...at("const x = 1;"), text: "Use let." })] }]);
  assert.match(text, /^Review notes \(1\) — reply to each by its number\.\n\n\[1\] change · src\/a\.ts:3\n> const x = 1;\nUse let\.$/);

  // The file moved on: the quote is found again, nearest to where it was.
  const moved = "header\n" + reviewed;
  text = formatFeedback([{ kind: "file", label: "a.ts", live: moved, version, notes: [note(at("const x = 1;"))] }]);
  assert.match(text, /a\.ts:4\n/);

  // Gone from the file: honest approximation instead of a wrong line.
  text = formatFeedback([{ kind: "file", label: "a.ts", live: "rewritten\n", version, notes: [note(at("const x = 1;"))] }]);
  assert.match(text, /a\.ts \(changed since you reviewed it; was around line 3\)/);
  text = formatFeedback([{ kind: "file", label: "a.ts", live: null, version, notes: [note(at("line two"))] }]);
  assert.match(text, /file no longer exists; was line 2/);

  // Multi-line ranges, removed text, exact replacement, legend for the intents used.
  text = formatFeedback([{ kind: "file", label: "a.ts", live: reviewed, version, notes: [
    note({ ...at("line two\nconst"), intent: "question", text: "Why?" }),
    note({ ...at("line four"), side: "old", intent: "keep", text: "" }),
    note({ ...at("line one"), intent: "change", replacement: "first line\nsecond", text: "" }),
  ] }], "Run the tests afterwards.");
  assert.match(text, /\nquestion = just answer, don't edit for it · keep = leave it as it is · -\/\+ = apply exactly that replacement\n\nGeneral: Run the tests afterwards\.\n\n\[1\]/);
  assert.doesNotMatch(text, /reply =/);
  assert.match(text, /\[1\] change · a\.ts:1\n- line one\n\+ first line\n\+ second/);
  assert.match(text, /\[2\] question · a\.ts:2-3\n> line two\n> const\nWhy\?/);
  assert.match(text, /\[3\] keep · a\.ts \(removed lines, were 4\)\n> line four$/);

  // Responses: prompt as reference once, then "same response"; long quotes are trimmed.
  const long = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
  text = formatFeedback([{ kind: "response", prompt: "Please   refactor the parser so that it handles every edge case we discussed yesterday", latest: true, text: long, notes: [
    note({ quote: long, start: 0, end: long.length, ref: null, text: "Too long." }),
    note({ quote: "row 3", start: 100, end: 105, ref: null, intent: "keep", text: "" }),
  ] }]);
  assert.match(text, /\[1\] change · your response to "Please refactor the parser so that it handles every edge case we disc…"/);
  assert.match(text, /> row 5\n> …\n> row 18\n> row 19/);
  assert.match(text, /\[2\] keep · same response\n> row 3$/);

  assert.equal(formatFeedback([]), "");
  assert.equal(formatFeedback([], "Just run the tests."), "Review note:\nJust run the tests.");
  text = formatFeedback([{ kind: "response", prompt: "p", latest: true, text: "", notes: [note({ quote: "Want me to delete them?", start: 0, end: 5, ref: null, intent: "reply", text: "yes, go ahead" })] }]);
  assert.match(text, /reply = my answer to what you asked or offered — act on it\n\n\[1\] reply · your response to "p"\n> Want me to delete them\?\nyes, go ahead/);
});

suite("feedback: context picks the right repeated quote", () => {
  const reviewed = "a = 1\nvalue = x\nb = 2\nvalue = x\n";
  const second = reviewed.lastIndexOf("value = x");
  const n = note({ quote: "value = x", source: "value = x", start: second, end: second + 9, ref: "v1" });
  const live = "a = 1\nvalue = x\ninserted\ninserted\ninserted\nb = 2\nvalue = x\n";
  const text = formatFeedback([{ kind: "file", label: "f.py", live, version: ref => ref === "v1" ? reviewed : null, notes: [n] }]);
  assert.match(text, /f\.py:7\n/);
});
