import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../core/store.ts";
import { BlobStore } from "../core/snapshot.ts";
import { TranscriptFeed, mutation } from "../hosts/claude/transcript.ts";

// Synthetic Claude Code transcript: request boundaries, a local command, a
// tool-using turn, an Edit without originalFile, and a final text answer.
const dir = mkdtempSync(join(tmpdir(), "annotate-claude-"));
const project = join(dir, "project");
mkdirSync(project);
const file = join(project, "notes.md");
writeFileSync(file, "alpha\nbeta\n");
const transcript = join(dir, "session.jsonl");
writeFileSync(transcript, "");
const line = (entry: object) => appendFileSync(transcript, JSON.stringify(entry) + "\n");

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
}

const store = new ReviewStore(project, join(dir, "state.json"), "session", new BlobStore(join(dir, "blobs")));
const feed = new TranscriptFeed(store, transcript);

line({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } });
line({ type: "user", message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" } });
feed.poll();
check("local command alone opens no request", store.request.id, 0);

line({ type: "user", message: { role: "user", content: "edit the notes" } });
line({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Editing." }] } });
line({ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } });
line({ type: "user", toolUseResult: { type: "update", filePath: file, content: "alpha\nbeta\ngamma\n", originalFile: "alpha\nbeta\n" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } });
line({ type: "user", message: { role: "user", content: "<task-notification>done</task-notification>" } });
line({ type: "user", toolUseResult: { filePath: file, oldString: "gamma", newString: "delta", originalFile: null, replaceAll: false }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2" }] } });
line({ type: "assistant", uuid: "b1c2d3e4f5", message: { id: "m2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "- first" }] } });
line({ type: "assistant", uuid: "b2", message: { id: "m2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "- second" }] } });
appendFileSync(transcript, '{"type":"user","message":'); // partial line: must wait
feed.poll();
feed.poll(); // quiet poll completes the streamed message

check("user prompt opens request 1; task notification does not", store.request.id, 1);
check("the request keeps its prompt", store.request.prompt, "edit the notes");
const change = store.request.changes[file];
check("first capture keeps the original baseline", store.blobs.get(change.before).text, "alpha\nbeta\n");
check("Edit without originalFile chains from the last known content", store.blobs.get(change.after).text, "alpha\nbeta\ndelta\n");
check("a final answer marks the agent idle", store.state.activity?.state, "idle");
check("tool-using message is not a response", Object.keys(store.state.responses ?? {}), ["message:b1c2d3e4"]);
check("multi-block answer is joined", store.state.responses?.["message:b1c2d3e4"].markdown, "- first\n\n- second");
check("partial line is left for the next poll", feed.tail.offsets[transcript] < readFileSync(transcript).length, true);

check("create has an empty baseline", mutation({ type: "create", filePath: "/x", content: "new", originalFile: null })?.before, { text: null });
appendFileSync(transcript, '{"role":"user","content":"<local-command-stdout>ok</local-command-stdout>"}}\n'); // the partial line completes
line({ type: "user", message: { role: "user", content: "<command-name>/review</command-name>\n<command-args>src</command-args>" } });
line({ type: "assistant", uuid: "c1", message: { id: "m3", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t3", name: "Read", input: {} }] } });
feed.poll();
check("slash-command prompts are shown as typed", store.request.prompt, "/review src");
check("an assistant turn in progress is 'working'", store.state.activity?.state, "working");
line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
feed.poll();
check("an interrupt is not a request and ends the turn", [store.request.id, store.state.activity?.state], [2, "idle"]);
check("MultiEdit applies edits in order", mutation({ filePath: "/x", originalFile: "a b a", edits: [{ old_string: "a", new_string: "c", replace_all: true }, { old_string: "b", new_string: "d" }] })?.after, { text: "c d c" });
check("unrelated tool results are ignored", mutation({ stdout: "hi" }), null);

rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("CLAUDE TRANSCRIPT SUITE PASSED");
