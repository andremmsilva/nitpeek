# Claude Code adapter

The same review panel as the Pi extension (`ReviewStore`, `server.ts`, `form/`),
driven by a Claude Code session instead of Pi's extension API.

| Command | Behavior |
|---------|----------|
| `/annotate` | Open/reuse this session's review panel |
| `/annotate-last` | Same panel, selecting the latest textual response |
| `/annotate <path>` | Same panel, selecting a file or expanding a folder |

**Nothing enters the model's context.** The command files set
`disable-model-invocation: true` (not listed to the model), and a
`UserPromptExpansion` hook blocks the expansion with exit 2 once the panel is
open. The line `UserPromptExpansion operation blocked by hook: annotate · …` is
expected: it is shown only to you.

**Done → Claude draft** pastes the feedback into Claude's prompt as a bracketed
paste, so newlines never submit it. If Claude collapses it into
`[Pasted text #N]`, it is pasted once more to expand it inline for editing.
Only the innermost multiplexer is used: herdr (`HERDR_PANE_ID`), then tmux
(`TMUX_PANE`), then kitty remote control. Otherwise the feedback goes to the clipboard.

## How it works

- `hook.ts`: the hook entry point. On `/annotate` it starts or reuses a detached
  daemon for the session (a Unix socket in `~/.claude/annotate/`), asks it to open
  the browser, then blocks. `SessionEnd` stops the daemon. A changed checkout
  (newer source mtime) restarts the daemon on the next `/annotate`.
- `daemon.ts`: follows the session transcript (JSONL) and its
  `subagents/*.jsonl`, serves the UI and delivers the feedback. It exits when the
  owning `claude` process is gone.
- `transcript.ts`: transcript → `ReviewStore`. Edit/Write results carry
  `originalFile`, so diffs cover the **whole session**, even edits before the
  first `/annotate`. When Claude omits `originalFile` (the file was never fully read),
  the baseline comes from the last recorded content, Claude's file-history
  (rewind) backup, or undoing the edit on disk. Request boundaries are real user
  prompts that get an assistant turn. Local commands (`/model`), task
  notifications and `!` shell input are not boundaries.

Review data lives in `~/.claude/annotate/`. UI settings (theme, code size) are
shared with Pi in `~/.pi/agent/annotate/settings.json`.

## Install

```bash
ln -sf ~/dev/pi-annotate/claude/commands/annotate.md ~/.claude/commands/annotate.md
ln -sf ~/dev/pi-annotate/claude/commands/annotate-last.md ~/.claude/commands/annotate-last.md
```

and in `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptExpansion": [{ "matcher": "annotate|annotate-last", "hooks": [
    { "type": "command", "command": "/Users/andre/.bun/bin/bun /Users/andre/dev/pi-annotate/claude/hook.ts", "timeout": 20 }] }],
  "SessionEnd": [{ "hooks": [
    { "type": "command", "command": "/Users/andre/.bun/bin/bun /Users/andre/dev/pi-annotate/claude/hook.ts", "timeout": 5 }] }]
}
```

Debugging: `~/.claude/annotate/daemon.log`. Start Claude with `ANNOTATE_DEBUG=1` to
save the last hook input to `~/.claude/annotate/last-hook.json`.

## Limits

- Bash-generated files are not attributed, same as in Pi. Open their folder with `/annotate <dir>`.
- Claude's prompt text can't be read, so the feedback is pasted at the cursor
  instead of being appended after your draft.
- `/rewind` doesn't reset captured diffs.
