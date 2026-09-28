import { readFileSync } from "node:fs";

// The selection/raw-markdown mapping helpers live inside the page's IIFE, so
// extract them from annotate.html and exercise them directly.
const html = readFileSync(new URL("../form/annotate.html", import.meta.url), "utf-8");
const start = html.indexOf("  function findTextInBlockRange");
const end = html.indexOf("/* ===== Text Selection", start);
if (start < 0 || end < 0) {
  console.error("could not extract range helpers from annotate.html");
  process.exit(1);
}
const { findTextInBlockRange, findNearestOccurrence } = new Function(
  html.slice(start, end) + "\nreturn { findTextInBlockRange, findNearestOccurrence };",
)() as {
  findTextInBlockRange: (md: string, text: string, from: number, to: number, prefer?: number) => number;
  findNearestOccurrence: (md: string, text: string, anchor: number) => number;
};

const md = "First duplicate here.\n\nSome other line.\n\nSecond duplicate here.\n";
const someStart = md.indexOf("Some other line.");
const secondStart = md.indexOf("Second duplicate here.");

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got}, want ${want}`);
  if (!ok) failures++;
}

check("duplicate resolves inside its own block", findTextInBlockRange(md, "duplicate here", secondStart, secondStart + 25, secondStart + 9), md.indexOf("duplicate here", secondStart));
check("preferStart without range picks nearest", findTextInBlockRange(md, "duplicate here", 0, md.length, secondStart + 9), md.indexOf("duplicate here", secondStart));
check("no preferStart falls back to first match", findTextInBlockRange(md, "duplicate here", 0, md.length), md.indexOf("duplicate here"));
check("out-of-range returns -1", findTextInBlockRange(md, "Second duplicate here.", 0, someStart), -1);
check("nearest picks following occurrence", findNearestOccurrence(md, "duplicate here", secondStart - 5), md.indexOf("duplicate here", secondStart - 5));
check("nearest picks preceding occurrence", findNearestOccurrence(md, "First duplicate here.", secondStart), 0);
check("nearest returns -1 when absent", findNearestOccurrence(md, "nope nope", 10), -1);

console.log(failures === 0 ? "\nRANGE SUITE PASSED" : `\n${failures} RANGE TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
