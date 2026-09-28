import { buildDiff, diffStat, highlightLines, languageOf, normalizeMarkdown, renderMarkdown } from "../core/render.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

const F = "```";

interface Block {
  tag: string;
  start: number;
  end: number;
}

function blocks(html: string): Block[] {
  return [...html.matchAll(/<(\w+)[^>]*data-offset-start="(\d+)" data-offset-end="(\d+)"/g)].map((m) => ({
    tag: m[1],
    start: Number(m[2]),
    end: Number(m[3]),
  }));
}

function codeText(html: string, index = 0): string {
  const pres = [...html.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)];
  if (!pres[index]) return "";
  return pres[index][1]
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// ── Offset integrity: the contract the annotation mapping depends on ─────
const matrix = [
  "# Heading One",
  "",
  "Para with **bold** and `code`.",
  "",
  "---",
  "",
  "- item a",
  "  - nested b",
  "- item c",
  "",
  "1. first",
  "2. second",
  "",
  "> quote para",
  ">",
  "> second para",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "    indented code",
  "",
  F + "js",
  "const x = 1;",
  F,
  "",
].join("\n");

{
  const html = renderMarkdown(matrix);
  const bs = blocks(html);
  check("matrix: blocks are mapped", bs.length >= 12, `got ${bs.length}`);
  check("matrix: every range non-empty", bs.every((b) => b.end > b.start));
  check("matrix: every range in bounds", bs.every((b) => b.start >= 0 && b.end <= matrix.length));
  check("matrix: ranges ascend in document order", bs.every((b, i) => i === 0 || b.start >= bs[i - 1].start));
  check("matrix: slices are non-blank", bs.every((b) => matrix.slice(b.start, b.end).trim().length > 0));
  check(
    "matrix: offsets point at the right source",
    matrix.slice(bs[0].start, bs[0].end).trim() === "# Heading One" &&
      matrix.slice(bs[1].start, bs[1].end).trim() === "Para with **bold** and `code`.",
  );
  const li = bs.filter((b) => b.tag === "li");
  check("matrix: nested list item mapped tighter than its parent", li.some((b) => matrix.slice(b.start, b.end).trim() === "- item a\n  - nested b") && li.some((b) => matrix.slice(b.start, b.end).trim() === "- nested b"));
  check("matrix: blockquote paragraphs mapped", bs.filter((b) => b.tag === "p").some((b) => matrix.slice(b.start, b.end).trim() === "> quote para"));
  check("matrix: table rows mapped", bs.some((b) => b.tag === "tr"));
  check("matrix: hr mapped", bs.some((b) => b.tag === "hr"));
  check("matrix: fences mapped", bs.filter((b) => b.tag === "pre").length === 2);
  check("matrix: nested list renders nested", /<li[^>]*>item a[\s\S]*<ul[\s\S]*nested b/.test(html));
  check("matrix: table renders", html.includes("<th") && html.includes("<td"));
}

// ── Regression: the two-fenced-sample message that shifted all fences ────
{
  const md = [
    "**Message mode** — no location line at all:",
    F + "markdown",
    "## Annotation Feedback — last message",
    "",
    "1 annotation (1 comment).",
    "",
    "### 1. [COMMENT]",
    "**Selected text:**",
    "> One choice worth your eye.",
    "",
    "**Comment:** Agreed.",
    F,
    "",
    "**File mode** — line number only:",
    F + "markdown",
    "### 1. [COMMENT] — line 5",
    "**Selected text:**",
    "> 12 delivery tests",
    F,
    "",
    "Tail paragraph.",
  ].join("\n");
  const html = renderMarkdown(md);
  const outside = html.replace(/<pre[\s\S]*?<\/pre>/g, "");
  check("regression: exactly two code blocks", (html.match(/<pre/g) ?? []).length === 2);
  check("regression: first sample intact", codeText(html, 0).includes("## Annotation Feedback — last message"));
  check("regression: second sample intact", codeText(html, 1).includes("### 1. [COMMENT] — line 5"));
  check("regression: no leaked headings", !html.includes("<h2") && !html.includes("<h3"));
  check("regression: no leaked blockquote", !html.includes("<blockquote>"));
  check("regression: no stray fences", !outside.includes(F));
  check("regression: prose preserved", outside.includes("<strong>Message mode</strong>"));
  check("regression: tail paragraph intact", /<p[^>]*>Tail paragraph\.<\/p>/.test(html));
}

// ── Paragraph interruption (the bug class this rewrite removes) ──────────
{
  const out = renderMarkdown(["Intro line:", F + "js", "code();", F, "After."].join("\n"));
  check("fence with language interrupts paragraph", !out.includes("Intro line: " + F) && /<pre[\s>]/.test(out));
  const quote = renderMarkdown(["Intro line", "> quoted text", "After."].join("\n"));
  check("blockquote interrupts paragraph", /<blockquote[^>]*>[\s\S]*?quoted text[\s\S]*?<\/blockquote>/.test(quote) && !/Intro line[^<]*quoted/.test(quote));
  const heading = renderMarkdown(["Intro line", "## Heading", "After."].join("\n"));
  check("heading interrupts paragraph", /<h2[^>]*>Heading<\/h2>/.test(heading));
  // A blank line is required: "Above\n---" is a setext heading in CommonMark.
  const hr = renderMarkdown(["Above", "", "---", "", "Below"].join("\n"));
  check("hr renders between paragraphs", /<hr[\s>]/.test(hr) && /<p[^>]*>Above<\/p>/.test(hr) && /<p[^>]*>Below<\/p>/.test(hr));
  const setext = renderMarkdown(["Above", "---", "Below"].join("\n"));
  check("setext heading follows CommonMark", /<h2[^>]*>Above<\/h2>/.test(setext) && !/<hr/.test(setext));
}

// ── Offset edge cases ────────────────────────────────────────────────────
{
  const noNewline = "First para.\n\nLast para without trailing newline";
  const bs = blocks(renderMarkdown(noNewline));
  const last = bs[bs.length - 1];
  check("no trailing newline: last block has a range", last.end > last.start, `${last.start}..${last.end}`);
  check("no trailing newline: range covers the text", noNewline.slice(last.start, last.end).trim() === "Last para without trailing newline");
}
{
  const crlf = normalizeMarkdown("First\r\n\r\nSecond\r\nThird");
  check("normalizeMarkdown collapses CRLF", crlf === "First\n\nSecond\nThird");
  const bs = blocks(renderMarkdown(crlf));
  check("CRLF: ranges valid after normalization", bs.every((b) => b.end > b.start && crlf.slice(b.start, b.end).trim().length > 0));
}

// ── Syntax highlighting ──────────────────────────────────────────────────
{
  const html = renderMarkdown(F + "javascript\nconst answer = 42; // yes\n" + F);
  check("highlight: known language emits token spans", html.includes("hljs-keyword") && html.includes("hljs-comment"));
  check("highlight: code text unchanged", codeText(html) === "const answer = 42; // yes", JSON.stringify(codeText(html)));
  check("highlight: language class kept", html.includes('class="hljs language-javascript"'));
}
{
  const html = renderMarkdown(F + "notalanguage\nconst answer = 42;\n" + F);
  check("highlight: unknown language stays plain", !html.includes("hljs-keyword"));
  check("highlight: unknown language text preserved", codeText(html) === "const answer = 42;");
}
{
  const html = renderMarkdown(F + "\nplain fence\n" + F);
  check("highlight: unlabeled fence stays plain", !html.includes("hljs-keyword") && codeText(html) === "plain fence");
}
{
  const html = renderMarkdown(F + "markdown\n## Section\n\n> quote\n\n**bold**\n" + F);
  check("highlight: markdown fences highlighted", html.includes("hljs-section") && html.includes("hljs-strong"));
}

{
  const html = renderMarkdown("| a | b |\n| :--- | ---: |\n| 1 | 2 |");
  check("table alignment kept", html.includes("text-align:left") && html.includes("text-align:right"));
}

// ── Safety and parity details ────────────────────────────────────────────
{
  const html = renderMarkdown("Inline <script>alert(1)</script> stays text.");
  check("raw HTML escaped", !html.includes("<script>") && html.includes("&lt;script&gt;"));
}
{
  const html = renderMarkdown("A [link](https://example.com) here.");
  check("links open in a new tab", html.includes('target="_blank"') && html.includes('rel="noopener"'));
}
{
  check("empty markdown renders a placeholder", renderMarkdown("").includes("(empty)"));
}

// ── Source lines ─────────────────────────────────────────────────────────
{
  const source = "/**\n * doc\n */\nconst s = `a\nb`;\nlet x = 1;\n";
  const lines = highlightLines(source, "typescript");
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  check("one fragment per source line", lines.length === 6);
  check("fragments keep the exact line text", lines.map(text).join("\n") + "\n" === source);
  check("spans crossing lines are closed and reopened", lines.every(l => (l.match(/<span/g) ?? []).length === (l.match(/<\/span>/g) ?? []).length) && lines[1].startsWith('<span class="hljs-comment">'));
  check("plain text is escaped", highlightLines("<script>&", null)[0] === "&lt;script&gt;&amp;");
  check("language detection", languageOf("/a/b/Main.java") === "java" && languageOf("x.tex") === "latex" && languageOf("Makefile") === "makefile" && languageOf("x.unknown") === null);
}

// ── Diff ─────────────────────────────────────────────────────────────────
{
  const diff = buildDiff("a\nconst value = 1;\nc\n", "a\nconst value = 2;\nc\nd\n", "typescript");
  const lines = diff.hunks[0].lines;
  check("diff counts", diff.added === 2 && diff.removed === 1);
  check("line numbers per side", lines[1].kind === "-" && lines[1].old === 2 && lines[2].kind === "+" && lines[2].new === 2 && lines[4].new === 4);
  check("word-level ranges for paired lines", JSON.stringify(lines[1].words) === "[[14,15]]" && JSON.stringify(lines[2].words) === "[[14,15]]");
  check("rewritten lines skip word ranges", buildDiff("alpha beta\n", "zzz yyy xxx\n", null).hunks[0].lines.every(l => !l.words));
  check("diff lines are syntax highlighted", lines[1].html.includes("hljs-keyword"));
  check("created file diff", buildDiff("", "x\ny\n", null).added === 2);
  const stat = diffStat(null, "a\nb\n");
  check("diffStat of a new file", stat.added === 2 && stat.removed === 0);
}

console.log(failures === 0 ? "\nRENDER SUITE PASSED" : `\n${failures} RENDER TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
