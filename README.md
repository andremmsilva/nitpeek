# nitpeek

Review what your coding agent did: read its replies, see what it changed,
highlight the parts that matter, and hand your notes back as a draft prompt.
Nothing is sent until you press Enter.

Works with **Pi** (extension) and **Claude Code** (hook). Both use the same
review panel, notes format and settings.

```
/annotate              open this session's review panel
/annotate-last         …on the latest reply
/annotate <path>       …on a file or folder, even one the agent never touched
```

## Reviewing

- **Since last Done** is where you start: every reply and file change you
  haven't reviewed yet. After you press Done, it starts again from zero. Before
  the first Done it shows everything.
- **Requests** is the timeline. Each of your prompts shows the replies and
  file changes it produced (`+12 −3`), with a diff of that request alone.
- **Diff / File / Rendered / Source**: file changes open as a diff with syntax
  highlighting and word-level changes. Markdown and LaTeX (`.tex`) can be read
  rendered or as source (`s`). Code blocks are numbered; `w` wraps long lines.
- **Math**: `$…$`, `$$…$$`, `\(…\)` and `\[…\]` render with KaTeX in replies and
  Markdown. A `.tex` file gets a light reading view (sections, lists, numbered
  equations, theorems, tables, `\ref`/`\cite`, preamble macros); anything it
  does not know stays visible as dimmed source. A formula is one unit: click it
  to select it, and notes always quote its LaTeX source.
- **Opened for reading** and **Browse**: files you opened yourself, and the
  project plus any folder you open with ⌘P or `/annotate <dir>`. Nothing
  outside those is browsable.

## Notes

Select text (or click a line number). Then pick what you want the agent to do:

| Intent | Key | The agent… |
|--------|-----|------------|
| **Change** | 1 | changes it as you describe, or to your **exact text** (optional, shown as `-`/`+`) |
| **Reply** | 2 | treats it as your answer to something it asked or offered (“yes, go ahead”, “option B”) and acts on it |
| **Question** | 3 | only answers; no edits for it |
| **Keep** | 4 | leaves it as it is |

The toolbar suggests an intent, and `↵` takes the suggestion. Selecting a
question or an offer in a reply (“Want me to…?”, “Queres que…”) suggests
**Reply**. Everything else suggests **Change**.

A **general note** (in the Done dialog) is for instructions that don't belong
to any quote, such as “run the tests afterwards”.

Notes sit in the margin next to their highlight. They follow their quote when
the file changes: a note made in the Diff also shows in the File view, and the
other way round.

**Done** previews the notes and puts them in the agent's prompt. The agent reads:

```
Review notes (3) — reply to each by its number.
reply = my answer to what you asked or offered — act on it · -/+ = apply exactly that replacement

General: Run the tests afterwards.

[1] reply · your response to "The threshold should be 0.75 and results must…"
> Want me to add the validation now?
Yes, go ahead.

[2] change · README.md:13
- A threshold below `0.5` is rejected.
+ Thresholds below 0.5 are rejected with an error.

[3] change · src/runner.py:6
>     threshold = config.get("threshold", 0.75)
Reject values below 0.5.
```

The locations point at the file **as it is on disk now**. When the file changed
after you reviewed it, the quote is found again using the text around it. If
it's gone, the note says so instead of giving a wrong line.

Keyboard: `⌘P` find · `1–4` / `↵` intent · `j/k` items · `n/N` notes · `d` diff · `s` source ·
`⌘↵` Done · `[` sidebar · `?` help.

## Install

```bash
cd ~/dev/nitpeek && bun install && bun run build
```

**Pi**: add the package to `~/.pi/agent/settings.json`, then `/reload`:

```json
"packages": ["../../dev/nitpeek"]
```

**Claude Code**: link the commands and the hook wrapper:

```bash
ln -sf ~/dev/nitpeek/hosts/claude/commands/annotate.md ~/.claude/commands/annotate.md
ln -sf ~/dev/nitpeek/hosts/claude/commands/annotate-last.md ~/.claude/commands/annotate-last.md
ln -sf ~/dev/nitpeek/bin/nitpeek-hook ~/.local/bin/nitpeek-hook
```

Then add the hooks to `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptExpansion": [{ "matcher": "annotate|annotate-last", "hooks": [{ "type": "command", "command": "nitpeek-hook", "timeout": 20 }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "nitpeek-hook", "timeout": 5 }] }]
}
```

### How the Claude Code side works

- **Nothing enters the model's context.** The commands are hidden from the
  model (`disable-model-invocation`), and the hook blocks the command before it
  expands. Claude then prints `UserPromptExpansion operation blocked by hook:
  [nitpeek-hook]: nitpeek: http://…`. Only you see that line, and it is the expected result.
- **The session is read from Claude's transcript**, including edits made before
  the first `/annotate` and edits made by subagents. When Claude didn't record a
  file's original contents, the baseline comes from the last known version,
  Claude's rewind backups, or by undoing the edit on disk.
- **Done pastes into Claude's prompt** as a bracketed paste, so newlines never
  submit it. Claude collapses long pastes into `[Pasted text #N]`, so nitpeek
  pastes once more to expand the text for editing. It uses herdr, tmux or kitty,
  whichever runs Claude. Otherwise the notes go to the clipboard.
- **Working / waiting for approval** status comes from herdr when available,
  otherwise from the transcript.
- One background server per session, never more: concurrent `/annotate`
  calls share it. It stops at SessionEnd (`/exit`, `/clear`…) or within a
  second of Claude exiting, even after `kill -9`. It restarts on the next
  `/annotate` after a code change. With no tab open it only watches the
  transcript.

## Data and security

- In Pi the server lives inside the Pi process and closes on quit, `/reload`,
  `/new`, `/resume` and fork.
- Everything lives in `~/.nitpeek/` with private permissions: `pi/` and `claude/`
  session state, `blobs/` (content-addressed file versions, shared), and
  `settings.json` (theme, fonts, wrap). Theme and code size carry over from pi-annotate. Once a
  day, sessions untouched for 30 days are removed, together with file versions
  no session references anymore.
- The server binds to `127.0.0.1` on a random port. It requires a per-server token
  for API calls, rejects non-loopback `Host` headers and denies framing.
- Text files up to 512 KiB are shown; binaries and larger files are listed only.
- Files written by shell commands aren't attributed to the agent. Open their
  folder to review them. The panel flags when a file on disk differs from the
  last recorded change.

## Development

```bash
bun run demo       # a demo session at a local URL; Done prints the notes
bun run build      # ui/ → dist/ (commit dist: Pi loads the extension without a build step)
bun run test       # every suite, including a headless-Chrome UI test (skipped without Chrome)
```

`core/` holds the store, feedback format, rendering and server. `ui/` is a
Preact app. `hosts/pi` and `hosts/claude` connect them to each agent.

nitpeek started as a fork of a Pi annotation extension and has since been rewritten.
