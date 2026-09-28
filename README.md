# pi-annotate-local

Private local Pi extension: one persistent browser review tab per session, with
Markdown rendering, a changed-file tree, on-demand file browsing, fuzzy finding,
diffs, and annotations on files **and assistant responses**. In normal review,
notes become an editable Pi draft — never automatically submitted.

## Commands

| Command | Behavior |
|---------|----------|
| `/annotate` | Open/reuse the session review panel |
| `/annotate-last` | Same panel, selecting the latest textual assistant response |
| `/annotate <path>` | Same panel, selecting a file or expanding a folder, even if Pi hasn't edited it |

Run `/reload` after updating the extension. Reopen `/annotate` after a reload;
previous server URLs stop working. These commands no longer open separate,
one-document annotation windows.

Also works in **Claude Code** with the same panel and notes format. See
[`claude/README.md`](claude/README.md).

## Workflow

1. Select **Last request** or **Whole session**.
2. **Agent response** appears above the file tree when a completed textual
   response is available. Select it to annotate the rendered Markdown.
3. **Files in review** groups captured and manually opened files together by
   directory (● captured, ◦ opened). Expand **Browse locations** to explore the
   project or a folder you deliberately opened; single-child package/folder
   chains compact into dotted paths (e.g. `src.main.java`) up to the next branch.
   Find files with ⌘P/Ctrl+P;
   results are grouped into recent, captured, and browsable files. Typing
   `/tmp/` suggests **Open folder · /tmp/** but does not browse it until selected.
   `/annotate /tmp/run-42/script.py` also opens an explicit path.
4. Click a parent in the document breadcrumb to open that folder, or use **Copy
   path**, **Reveal in tree**, or **Pin folder**. The full path is available on
   hover. **Document / Diff** distinguishes recorded changes from files merely
   found on disk: an unavailable Diff explains why. Markdown also has a
   **Source / Rendered** toggle. Source files (`.tex`, `.java`, `.py`, etc.)
   show line numbers and a **Wrap: on/off** button; wrapped visual rows keep
   their original source-line number. Rendered Markdown code blocks now get the
   same numbered, wrappable treatment (inline code and prose stay unchanged).
   **Settings** in the bottom toolbar controls the theme and code font size.
   System theme follows the OS; code size defaults to 14px. Preferences persist
   in `~/.pi/agent/annotate/settings.json`. The first open migrates legacy
   settings from that browser origin. Markdown Source uses the same controls.
5. Select text to annotate. Notes and document markers link in both directions;
   keyboard focus works on them. Notes save per source and survive reopening.
   If the disk version changes while notes exist, the reviewed snapshot stays
   frozen; **Compare with disk** shows an explicitly untracked comparison.
6. **Done → Pi draft** previews all pending feedback first, including notes
   outside the selected scope. Confirm to append it to the current editor text;
   add your instructions and press Enter yourself. Nothing auto-sends.

The file tree updates automatically. Expanded folders are rescanned about
once every 8 seconds; each folder has a contextual ↻ refresh button. No
filesystem watcher scans all of `/tmp`. The open document/response does **not**
get replaced as new content arrives. Refreshing a file is explicit. Unsent annotations
freeze the reviewed source; feedback includes its exact quote.
File feedback also carries the original line and warns when the disk has changed.
Response feedback identifies the session message, without fictional file paths or
line numbers.

On session start/reload, the latest usable response can be recovered from Pi's
active branch. New responses become available on `agent_settled`; thinking,
tool results, tool-calling messages and aborted/error messages are not shown.
Last-request scope uses user-message boundaries, not internal model/tool turns.
Whole-session scope shows only the newest response plus earlier pending notes.

Repeated commands reuse an active tab. `/annotate-last` and `/annotate <path>`
select their target there; browser focus is best-effort. Finish editing an open
annotation before switching documents or sending notes.

## File capture and limits

- Successful `write` and `edit` calls are captured even with the tab closed,
  beginning when the extension loads. Earlier overwritten file contents cannot
  be reconstructed. Shell scripts, formatters and other agents are not tracked.
- Whole-session diff: before the first captured mutation vs after the last.
  Last-request diff: before the first mutation in that request vs after its last.
- **Files in review** groups captured and manually opened files by their parent
  folders, including paths outside Pi's cwd (no misleading “external” tag).
  **Browse locations** lists the project and explicitly opened folders. Search
  covers those roots plus recorded files; `.git`, `node_modules` and symlinks
  are skipped. Directory
  listings show at most 500 entries, and fuzzy search is capped for speed.
- Shell-generated outputs are not automatically attributed to the agent. Open
  their folder (e.g. `/tmp/run-42/`); newly created files then appear there.
  A manually opened file has no fabricated diff. Its first subsequent captured
  edit establishes the actual baseline.
- Text files up to 512 KiB. Markdown is rendered; other text is shown as source.
  LaTeX is syntax-highlighted source, not a compiled paper preview. Line numbers
  are omitted above 20,000 lines to keep the browser responsive; wrapping still
  works. Binary/oversize files are listed but not rendered. Expensive diffs abort.
- Detected uncaptured changes are flagged, but this is not a perfect attribution
  system, especially with concurrent agents editing the same file.
- `/tree` navigation starts a separate review scope and does not reconstruct
  historical files. Forked sessions start their own capture.
- Snapshots, response text, drafts and UI settings persist in
  `~/.pi/agent/annotate/`, with private local file permissions. There is no
  automatic retention cleanup for review data yet.
- Review never modifies project files or Git state. One live Pi process per
  session is assumed; simultaneous browser clients are not supported.

## Rendering and security

`markdown-it` renders Markdown server-side; `highlight.js` highlights code and
`diff` computes bounded unified diffs. Source offsets map DOM selections back to
Markdown. Raw HTML is escaped. Three themes: Slate, Paper, Midnight.

The HTTP server binds only to `127.0.0.1`, requires a per-server token on API
routes, validates loopback Host headers, disables framing, and limits request
bodies to 5 MiB. Browsing APIs restrict navigation to the project and directories explicitly
opened in the UI. A file discovered there must be registered before its
content can be requested. The existing `/annotate <path>` command can also
register an explicit file.

## Try each change

Run `/reload`, close the stale annotate tab, then `/annotate`. For the LaTeX
example, open `/annotate /Users/andre/meic/thesis/microservices-simulator/.local/overleaf-paper-section2-draft-2026-09-28.tex`
(or paste its full path into ⌘P). Flip **Wrap: on/off** and check that the
line numbers remain attached to logical lines, including wrapped paragraphs.
Select some source to verify that feedback quotes the text and original line,
not the gutter numbers. Open an output
folder such as `/tmp/my-run/` through ⌘P or use `/annotate /tmp/my-run/script.py`.
A new text result appears in the expanded folder within ~8 seconds (or press
its ↻). Select it, check the breadcrumb and disabled Diff, annotate text, then
use **Done → Pi draft**. Review the feedback preview; only after confirmation
will it land in Pi's editor. Test the source toggle on Markdown, navigation
between a note and its highlight, scope switching without losing the open file,
and collapsing either rail.

For a reproducible developer-only browser fixture (no Pi slash command), run:

```bash
cd /Users/andre/dev/pi-annotate
bun run tests/visual-preview.ts
```

Open the printed local URL; Ctrl+C stops the server and removes its temporary
files. Its preview never touches Pi's editor. Automated fixture coverage:
`bun run tests/demo.test.ts`.

If something doesn't appear, report the path, how it was created (`write`/`edit`,
`bash`, or another process), and whether its parent folder was opened.

The image in `design/annotate-ui-concept.png` is an exploratory reference, not
an exact screenshot. Some visual details (e.g. syntax colors and card chips)
are not part of the shipped UI.

## Development

Installed as a local path package at `/Users/andre/dev/pi-annotate`.

```bash
cd /Users/andre/dev/pi-annotate
bun install
./tests/run.sh
```

Tests cover rendering, selection offsets, server authorization, browsing,
fuzzy finding, explicit-root containment, the isolated demo, feedback, snapshot
scopes, manually opened files, response identity and persistence,
frozen drafts, lifecycle capture and delivery without replacing editor text.
Browser smoke tests also cover selecting/commenting a response, switching to a
file and back, hiding response diffs, and Done into a pre-existing draft.
