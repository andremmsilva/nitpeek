import { handleAnnotationDecision } from "../index.ts";
import type { Annotation } from "../server.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

const sent: string[] = [];
const notifications: string[] = [];

function makePi() {
  return { sendUserMessage: (msg: string) => sent.push(msg) };
}

function makeCtx(editorText = "", hasUI = true) {
  let editor = editorText;
  return {
    hasUI,
    ui: {
      notify: (msg: string, level?: string) => notifications.push(`${level ?? "info"}:${msg}`),
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
    },
    get editor() { return editor; },
  };
}

const md = [
  "# Spec",
  "",
  "Intro text.",
  "",
  "## Retry logic",
  "",
  "The system will fail. The system will fail.",
  "",
  "## Testing",
  "",
  "- Ran 12 delivery tests and all passed.",
  "",
].join("\n");

const dupSecond = md.indexOf("The system will fail.", md.indexOf("The system will fail.") + 1);
const testsStart = md.indexOf("12 delivery tests");
const lineOf = (offset: number) => md.slice(0, offset).split("\n").length;

const annotations: Annotation[] = [
  {
    id: "a1",
    type: "comment",
    text: "Why is this stated twice?",
    originalText: "The system will fail.",
    range: { startOffset: dupSecond, endOffset: dupSecond + "The system will fail.".length, textPreview: "The system will fail." },
    createdAt: 0,
  },
  {
    id: "a2",
    type: "issue",
    text: "Was there test coverage upstream?",
    originalText: "12 delivery tests",
    range: { startOffset: testsStart, endOffset: testsStart + "12 delivery tests".length, textPreview: "12 delivery tests" },
    createdAt: 0,
  },
];

// 1. File mode: line numbers, exact selection, comment last, no extras
{
  sent.length = 0;
  notifications.length = 0;
  const ctx = makeCtx("", true);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "feedback", annotations } as never, "spec.md", md, "annotate");
  const text = ctx.editor;

  check("header names the source", text.includes("## Annotation Feedback — spec.md"));
  check("summary counts types", text.includes("2 annotations (1 comment, 1 issue)."));
  check("file mode shows line number", text.includes(`### 1. [COMMENT] — line ${lineOf(dupSecond)}`));
  check("multi-line/duplicate selection uses the annotated occurrence", text.includes(`> The system will fail.`));
  check("no Section lines", !text.includes("Section:"));
  check("no Context lines", !text.includes("**Context:**"));
  check("no truncated duplicates", !text.includes("Ran 12 delivery tests"));
  check("comment comes AFTER the selected text", text.indexOf("**Selected text:**") < text.indexOf("**Comment:**"));
  check("items are ordered by position", text.indexOf("[COMMENT]") < text.indexOf("[ISSUE]"));
  check("no legacy 'Original text:' format", !text.includes("Original text:"));
  check("no CJK in feedback", !/[\u4e00-\u9fff]/.test(text));
  check("issue ending wins", text.includes("Please address the issues above."));
  check("draft does not auto-send", sent.length === 0);
}

// 2. Message mode: no line numbers (agent cannot see them), same quote+comment shape
{
  const ctx = makeCtx("", true);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "feedback", annotations } as never, "last message", md, "annotate-last");
  const text = ctx.editor;
  check("message mode omits line numbers", !/— line \d/.test(text));
  check("message mode keeps exact selection", text.includes("> The system will fail."));
  check("message mode keeps comment", text.includes("**Comment:** Why is this stated twice?"));
}

// 3. Draft mode appends to existing editor text
{
  const ctx = makeCtx("my own draft", true);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "feedback", annotations } as never, "spec.md", md, "annotate");
  check("draft preserves existing text", ctx.editor.startsWith("my own draft\n\n## Annotation Feedback"));
}

// 4. No UI falls back to sending
{
  sent.length = 0;
  const ctx = makeCtx("", false);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "feedback", annotations } as never, "spec.md", md, "annotate");
  check("no-UI sends immediately", sent.length === 1 && sent[0].includes("## Annotation Feedback — spec.md"));
}

// 5. Plain feedback string still works when no structured annotations arrive
{
  const ctx = makeCtx("", true);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "feedback", feedback: "PLAIN FALLBACK" } as never, "spec.md", md, "annotate");
  check("plain feedback fallback kept", ctx.editor === "PLAIN FALLBACK");
}

// 6. Approve notification is English
{
  notifications.length = 0;
  const ctx = makeCtx("", true);
  handleAnnotationDecision(makePi() as never, ctx as never, { action: "approve" } as never, "spec.md", md, "annotate");
  check("approve notifies in English", notifications.some((n) => n === "success:spec.md approved"));
}

console.log(failures === 0 ? "\nFEEDBACK SUITE PASSED" : `\n${failures} FEEDBACK TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
