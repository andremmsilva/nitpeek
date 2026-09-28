# Evolution plan: real markdown, syntax highlighting, themes

Status: implemented (phases 1-3). Kept as a record of the approach and the
verified offset contract.

## Goal

1. Replace the hand-rolled markdown renderer with a real parser so rendering bugs
   stop recurring (the last one was a single `$`-anchoring bug that shifted every
   fence pair in code samples).
2. Syntax-highlight code blocks.
3. Replace the single dark palette with a small theme system the user actually
   likes, plus a visible theme control (currently the only toggle is
   `Cmd/Ctrl+Shift+L`).

Constraints: local-only UI, no CDN, no build step for the extension itself, keep
the selection→raw-markdown offset mapping working (it is the core feature).

## What the spike established

Spiked in `/tmp/vendor-spike` with `markdown-it@15.0.2` + `highlight.js@11.12.0`
against the exact message that exposed the last bug:

- markdown-it block tokens carry `map: [startLine, endLine)` — enough to recover
  raw character offsets with a line-start table. 18 mapped blocks, all ascending,
  0 broken/empty ranges, 2 code blocks, 0 stray fence markers.
- Edge case found: the file had no trailing newline and `map[1]` ran one line
  past EOF; mapping out-of-range lines to `md.length` fixes it (test it).
- Construct matrix verified: `hr` (nesting 0, so don't filter on `nesting === 1`),
  `tr` (mapped), `td` (not mapped), `li` + nested `li` (tighter maps per item),
  paragraphs inside blockquotes (mapped, so innermost element wins).
- highlight.js: `lib/common` resolves aliases (`js`, `ts`, `sh`, `bash`, `py`,
  `md`, `yml` all known), 11 token spans for the sample, code text unchanged.
- Cost: import ~19 ms, first render ~3 ms. Disk: markdown-it 1.9 MB,
  highlight.js 9.2 MB (only `lib/common`'s ~35 languages load at runtime).

## Decision: render in the extension, not the browser

`index.ts` renders markdown once (at UI open) and serves finished HTML; the page
keeps only the raw markdown string for offset lookups.

Why not a client-side parser bundle:
- No new HTTP route, no CSP change, no vendor blob, no "build the vendored file"
  step. The server injects `planHtml` into the existing `/api/plan` payload.
- The renderer becomes importable TypeScript, so `tests/render.test.ts` stops
  extracting functions out of `annotate.html`.
- highlight.js runs in Node; the browser gets plain HTML with token spans.

Cost: the extension gains two runtime dependencies (`markdown-it`,
`highlight.js`, both MIT). Pi resolves `node_modules/` next to the extension
(docs: extensions.md, "npm dependencies"), so this needs a one-time
`bun install` in the fork directory. If that ever becomes annoying, the fallback
is `bun build`-ing both libs into one committed ESM bundle — same API, no deps.

### The offset contract (do not break this)

- `data-offset-start` / `data-offset-end` = raw markdown character offsets,
  `\n`-normalized, attached to the innermost mapped block element
  (`p`, `h1..h6`, `li`, `blockquote`, `blockquote > p`, `tr`, `pre`, `hr`,
  `table`), together with `class="md-block"`.
- Page JS (`findTextInBlockRange`, `findNearestOccurrence`, `wrapTextRange`,
  block shading) keeps using `closest('.md-block')`; no mapping rewrite.
- Normalize `\r\n` → `\n` in `index.ts` where content is read, so the offsets the
  server renders and the raw string the page maps against always agree.

## Phase 1 — real markdown parser

New `markdown.ts`:
- module-level markdown-it instance (`html: false`, `linkify: false`,
  `breaks: false` — parity with today's escaping behavior);
- `renderMarkdown(markdown)` → HTML with the offset attributes above, injected by
  wrapping `renderer.renderToken` (for mapped block tags) plus explicit `fence`
  and `code_block` rules;
- `export const DEMO_MARKDOWN` (moved from the page).

`index.ts`:
- normalize newlines where markdown is read (annotate command, auto-detect, last
  message);
- `renderedHtml = renderMarkdown(content)`, `demoHtml = renderMarkdown(DEMO_MARKDOWN)`;
- pass both into `startAnnotationServer`.

`server.ts`:
- options gain `renderedHtml`, `demoHtml`, optional `defaultTheme`;
- `/api/plan` returns `{ plan, planHtml, mode, sourceInfo, gate }`;
- `__ANNOTATE_DATA__` gains `demoHtml` (+ `defaultTheme` when set).

`form/annotate.html`:
- delete `renderMarkdown`, `lineToCells`, `renderInline` (lines ~1163–1447);
  keep `escapeHtml` (annotation cards use it);
- render via `planData.planHtml`; demo mode uses `ANNOTATE_DATA.demoHtml`;
- delete the client-side `demoPlan` string.

Acceptance: construct matrix renders correctly; every mapped block's
`md.slice(start, end)` is non-empty and contains its source text; the two-fenced-
sample regression passes; browser selection test (including a table row and a
nested list item) still produces correct offsets.

## Phase 2 — syntax highlighting

- `fence` rule: `highlight.js` when the info string names a known language
  (aliases work), `ignoreIllegals: true`; unknown or unlabeled fences render as
  escaped plain code (decision pending: optionally `highlightAuto` with a size
  cap).
- Page CSS: `--syntax-*` variables per theme + ~30 selectors mapping
  `.hljs-keyword`, `.hljs-string`, `.hljs-comment`, `.hljs-number`,
  `.hljs-title`/`.hljs-function`, `.hljs-type`/`.hljs-built_in`, `.hljs-tag`/
  `.hljs-name`, `.hljs-attr`, `.hljs-meta`, `.hljs-addition`/`.hljs-deletion`,
  punctuation, etc.
- Tests: known language emits token spans; `textContent` of the `<pre>` equals
  the original code (highlighting must not alter characters, or the selection
  mapping breaks); unknown language stays plain.

## Phase 3 — themes

- Replace the `.light-mode` override block with explicit
  `[data-theme="..."]` variable blocks. Keep the existing `--bg-*`, `--text-*`,
  `--border*`, `--accent*`, `--success/danger/warning`, `--type-*` variable
  names, add `--syntax-*`.
- Ship 2–3 palettes (candidates below), default chosen by `prefers-color-scheme`,
  overridable by an optional `DEFAULT_THEME` constant in `index.ts`.
- Visible control in the footer (next to the existing `⌘ Shift L Theme` hint),
  persisted under the existing `pi-annotate-theme` key; migrate old
  `"dark"`/`"light"` values. Keep the hotkey.
- Tests: browser screenshots per theme; no unit tests for CSS.

Candidate palettes (pick one accent direction, or hand over hex values):

| Role | Slate (dark, default) | Paper (light) |
|------|----------------------|---------------|
| bg | `#16181d` / `#1e2128` / `#262a33` | `#fbfbfa` / `#f4f4f2` / `#e9e9e6` |
| text | `#e6e8ec` / `#9aa3b2` / `#6b7280` | `#1f2328` / `#57606a` / `#8b949e` |
| border | `#2a2f3a` / `#3a4150` | `#d8d8d4` / `#e6e6e2` |
| accent | `#4c8dff` | `#3d6fd6` |
| success/danger/warning | `#3fb27f` / `#e5534b` / `#d29922` | `#2d9f6e` / `#d44a4a` / `#cc8a30` |

Current "midnight" purple palette is kept only if wanted as a third option.

## Test plan

- Unit (bun): `tests/render.test.ts` rewritten against `markdown.ts` — construct
  matrix, offset integrity (non-empty, ascending, round-trips to source),
  regression case, trailing-newline case, `\r\n` case, highlight output.
  Existing `server`, `feedback`, `range`, `extension` suites unchanged.
- Browser (agent-browser): extend the highlight test with a highlighted code
  block, a table cell, a nested list item, and a blockquote; assert the POSTed
  annotation ranges match the raw markdown.
- Visual: screenshots for each theme.

## Risks

- Dependencies: first runtime deps in the fork; README needs a `bun install`
  note. Mitigation/fallback: prebuilt committed bundle.
- Offset drift from newline normalization: handled by normalizing at read time
  and testing `\r\n`.
- `.md-block` now lives on native elements (`li`, `pre`, `tr`): CSS is only
  `position/transition/border-radius`, so safe; block shading keeps the same
  padding/border behavior as today.
- Unknown fence languages must not throw (`ignoreIllegals`).

## Explicit non-goals

No CDN/client-side parser, no theme editor or external theme files, no Shiki or
VS Code grammars, no selection-mapping rewrite, no live re-render, no publishing
work.

## Open questions

1. Palette/accent direction: Slate + Paper as proposed, or specific colors?
2. Keep the current purple "midnight" as a third theme, or drop it?
3. Unlabeled fences: plain text, or auto-detect language?
4. Demo mode (server unreachable): keep via server-rendered `demoHtml`, or drop?
