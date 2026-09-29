import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../core/store.ts";
import { BlobStore } from "../core/snapshot.ts";
import { TranscriptFeed, mutation } from "../hosts/claude/transcript.ts";
import { shellPaths } from "../core/shell.ts";
import { projectDir } from "../hosts/claude/shared.ts";

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

// ── Files changed by shell commands ──
{
  mkdirSync(join(project, "docs"));
  const doc = join(project, "docs", "a.md"), created = join(project, "docs", "new.txt"), bystander = join(project, "docs", "other.txt");
  writeFileSync(doc, "one\ntwo\n"); writeFileSync(bystander, "x\n");
  const iso = (t: number) => new Date(t).toISOString();
  line({ type: "user", timestamp: iso(Date.now()), message: { role: "user", content: "tidy the docs" } });
  line({ type: "assistant", uuid: "r1", timestamp: iso(Date.now()), message: { id: "m4", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t4", name: "Read", input: {} }] } });
  line({ type: "user", timestamp: iso(Date.now()), toolUseResult: { type: "text", file: { filePath: doc, content: "one\ntwo\n", numLines: 2, startLine: 1, totalLines: 2 } }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t4" }] } });
  feed.poll();
  const start = Date.now() - 50;
  // Written after the (long-ago) Read, by "python" in a subfolder, plus a new file, a temp file and a bystander.
  const command = "cd docs && python3 - <<'EOF'\np='a.md'\nopen(p,'w').write('one\\nTWO\\n')\nopen('new.txt','w').write('hi')\nopen('/tmp/scratch.txt','w')\nEOF";
  line({ type: "assistant", uuid: "s1", cwd: project, timestamp: iso(start), message: { id: "m5", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t5", name: "Bash", input: { command } }] } });
  writeFileSync(doc, "one\nTWO\n"); writeFileSync(created, "hi\n");
  line({ type: "user", timestamp: iso(Date.now() + 50), toolUseResult: { stdout: "", stderr: "" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t5" }] } });
  feed.poll();
  const changes = store.request.changes;
  check("a shell edit is recorded with the version its last full Read saw", [store.blobs.get(changes[doc]?.before).text, store.blobs.get(changes[doc]?.after).text], ["one\ntwo\n", "one\nTWO\n"]);
  check("a file the command created is new", changes[created]?.before, { hash: null });
  check("files the command does not name are left alone", changes[bystander], undefined);
  const paths = shellPaths("cd src && sed -i '' 's/a/b/' main.py > ../out.txt; curl https://x.io/a.json -o -", "/p");
  check("shell paths follow cd and skip flags and URLs", [paths.includes("/p/src/main.py"), paths.includes("/p/out.txt"), paths.some(p => p.includes("x.io") || p.endsWith("/-o"))], [true, true, false]);
}

// ── Subagent edits land in the request they happened in, even when read all at once ──
{
  const session = join(dir, "replay.jsonl"), sub = join(dir, "replay", "subagents");
  mkdirSync(sub, { recursive: true });
  const target = join(project, "sub.md");
  writeFileSync(target, "v1\n");
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  writeFileSync(session, [
    { type: "user", timestamp: at(1), cwd: project, message: { role: "user", content: "first" } },
    { type: "assistant", uuid: "x1", timestamp: at(2), message: { id: "x1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "k1", name: "Task", input: {} }] } },
    { type: "user", timestamp: at(9), message: { role: "user", content: "second" } },
    { type: "assistant", uuid: "x2", timestamp: at(10), message: { id: "x2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(sub, "agent-1.jsonl"), JSON.stringify({ type: "user", timestamp: at(5), toolUseResult: { type: "update", filePath: target, content: "v2\n", originalFile: "v1\n" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "z" }] } }) + "\n");
  const replay = new ReviewStore(project, join(dir, "replay-state.json"), "replay", new BlobStore(join(dir, "blobs")));
  new TranscriptFeed(replay, session).poll();
  check("subagent edit is attributed by time", replay.state.requests.map(r => Object.keys(r.changes).length), [0, 1, 0]);
  delete process.env.CLAUDE_PROJECT_DIR;
  check("the project is where the session started, not the last cd", projectDir({ cwd: join(project, "docs"), transcript_path: session }), project);
}

rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("CLAUDE TRANSCRIPT SUITE PASSED");
