import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
process.env.NITPEEK_HOME ||= "/tmp/nitpeek-test-home";
const { default: extension } = await import("../hosts/pi/index.ts");
const { sandbox, suite } = await import("./helpers.ts");

suite("pi host: capture, commands, Done into the editor", async () => {
  const box = sandbox("pi");
  const hooks = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const opened: string[] = [];
  let editor = "my draft";
  const notices: string[] = [];
  const pi = {
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
    exec: async (_: string, args: string[]) => { opened.push(args.at(-1)!); return { code: 0 }; },
  };
  const branch: any[] = [];
  const ctx = {
    cwd: box.directory, mode: "tui",
    sessionManager: { getBranch: () => branch, getSessionId: () => "pi-session", getSessionFile: () => join(box.directory, "s.jsonl") },
    ui: { notify: (text: string) => notices.push(text), getEditorText: () => editor, setEditorText: (text: string) => { editor = text; } },
  };
  extension(pi as any, join(box.directory, "state"));
  assert.ok(commands.has("annotate") && commands.has("annotate-last"));
  await hooks.get("session_start")!({}, ctx);
  const file = join(box.directory, "notes.md");
  writeFileSync(file, "# Old\n");
  await hooks.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: "Rename the title" }] } });
  await hooks.get("agent_start")!({});
  await hooks.get("tool_call")!({ toolName: "edit", toolCallId: "t1", input: { path: "notes.md" } });
  writeFileSync(file, "# New\n");
  await hooks.get("tool_execution_end")!({ toolCallId: "t1", isError: false });
  branch.push({ type: "message", id: "u1", message: { role: "user", content: "Rename the title" } });
  branch.push({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Renamed it." }] } });
  await hooks.get("agent_settled")!({}, ctx);

  await commands.get("annotate-last")!.handler("", ctx);
  const url = opened[0];
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const html = await (await fetch(url)).text();
  const token = JSON.parse(html.match(/type="application\/json">(.*?)<\/script>/)![1]).token;
  const headers = { "X-Nitpeek-Token": token, "Content-Type": "application/json" };
  const overview = await (await fetch(url + "/api/review/overview", { headers })).json();
  assert.equal(overview.requests[0].prompt, "Rename the title");
  assert.equal(overview.requests[0].files[0].path, file);
  assert.equal(overview.target.path, "message:a1");
  assert.equal(overview.activity.state, "idle");
  const doc = await (await fetch(url + "/api/review/document?path=message%3Aa1", { headers })).json();
  await fetch(url + "/api/review/notes", { method: "POST", headers, body: JSON.stringify({ path: "message:a1", notes: [{ id: "n1", intent: "change", text: "Say what the new title is.", quote: "Renamed it.", start: 0, end: 11, view: "document", ref: doc.ref, createdAt: 1 }] }) });
  const preview = await (await fetch(url + "/api/review/preview", { headers })).json();
  assert.match(preview.deliveryNote, /appended after the text already in Pi/);
  await fetch(url + "/api/review/done", { method: "POST", headers, body: "{}" });
  assert.match(editor, /^my draft\n\nReview notes \(1\)/);
  assert.match(editor, /your response to "Rename the title"/);

  // A second /annotate while the tab polls reuses it instead of opening another.
  await commands.get("annotate")!.handler("notes.md", ctx);
  assert.equal(opened.length, 1);
  assert.ok(notices.some(n => /already open/.test(n)));
  await commands.get("annotate")!.handler("missing.md", ctx);
  assert.ok(notices.some(n => /Not found/.test(n)));
  await hooks.get("session_shutdown")!({});
  box.cleanup();
});
