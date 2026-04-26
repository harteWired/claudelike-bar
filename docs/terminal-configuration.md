# Terminal configuration reference

All settings live in `~/.claude/claudelike-bar.jsonc`. Auto-created when you first open a terminal or run the setup wizard. Edits take effect immediately — no reload needed.

## Terminal options

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `path` | string \| null | *unset* | Absolute path to the project directory. Canonical identity — used for matching hook updates to tiles and deriving collision-free status filenames. Also the default `cwd` when `cwd` is unset. Set automatically by the setup wizard or **Register Project**. |
| `color` | string | auto | Preset: `cyan`, `green`, `blue`, `magenta`, `yellow`, `white`, `red`. Or any CSS color: `#e06c75`, `rgb(224, 108, 117)`, `hsl(355, 65%, 65%)`, `var(--my-color)`. |
| `icon` | string \| null | auto | Any [VS Code codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name. |
| `nickname` | string \| null | `null` | Display name shown on the tile instead of the terminal name. |
| `autoStart` | boolean | `false` | Launch this terminal when VS Code starts. |
| `cwd` | string \| null | *unset* | Working directory for the terminal. Cross-platform — passed through VS Code's `createTerminal({ cwd })` API, not shell syntax. Use this instead of `cd /path &&` in `command`. |
| `command` | string \| null | *inherits `claudeCommand`* | Command sent to the terminal when auto-started. With `cwd` set, this can be a simple `"claude"` — no `cd`, no `&&`, works on every shell. Omit the field to inherit the global default; set to `null` to open the terminal without running anything. |
| `order` | number | *unset* | Manual sort position (set by drag-and-drop). Only used when top-level `sortMode` is `"manual"`. |
| `shellPath` | string \| null | *unset* | Path to a specific shell binary. Use when you need git-bash on Windows for legacy commands: `"C:\\Program Files\\Git\\bin\\bash.exe"`. |
| `hidden` | boolean | `false` | Hide this entry from the offline-tiles zone. The terminal still auto-starts if `autoStart: true`. |
| `type` | `"claude"` \| `"shell"` | `"claude"` | `"shell"` makes this a plain non-Claude tile — gray pill, no animated dot, no state machine, no Claude-specific menu items. Click to focus. Use for ad-hoc shells you want reachable from the bar. Status JSONs that match the slug are ignored (config opt-out is authoritative). |

## Sorting tiles

Two modes, set by the top-level `sortMode` key:

- **`"auto"`** *(default)* — tiles are sorted by status so things needing attention float to the top: `waiting → ignored → ready → working → done → idle`. Most-recent activity wins within a status group.
- **`"manual"`** — tiles use the per-terminal `order` values (assigned by dragging). New/unordered tiles sink to the bottom.

You can drag tiles in either mode — dragging automatically flips `sortMode` to `"manual"`. To go back to status-based sort, set `"sortMode": "auto"` (the `order` values are left in place, harmlessly ignored, and restored if you switch back).

## Cross-platform auto-start

Use `cwd` + `command` instead of baking `cd /path && claude` into the command string. `cwd` goes through VS Code's API — works on every shell, every platform:

```jsonc
"my-project": {
  "autoStart": true,
  "cwd": "C:\\Users\\you\\projects\\foo",
  "command": "claude"
}
```

This is the recommended pattern. `command` is just the thing to run — no `cd`, no `&&`, no shell-specific syntax. Works identically on PowerShell, bash, zsh, cmd, fish.

**Legacy `cd && claude` commands still work** — they're sent via `sendText()` and execute in whatever shell the terminal runs. But `&&` fails on PowerShell 5.1 (Windows default), so new configs should use `cwd` instead.

The `CLAUDELIKE_BAR_NAME` env var is set through VS Code's `createTerminal({ env })` API — no shell syntax, every platform.

## Context % (optional enhancement)

Context % on tiles comes from a Claude Code statusline script that writes `context_percent` into the status file. The extension ships a standalone one — it's completely independent of the rest of the extension and shares only the status-file format.

**If you don't already have a statusline configured:** the extension offers to install ours during first-run onboarding. You can also run it any time: `Cmd+Shift+P` → **Claudelike Bar: Install Statusline**.

**If you already have a statusline:** **Install Statusline** prompts before replacing it. Confirming backs up the prior `statusLine` value to `~/.claude/.claudelike-bar-statusline-backup.json`. To restore, run **Claudelike Bar: Restore Previous Statusline**.

### Writing your own statusline integration

Any script that writes the status file format works. The contract:

- **Location** — `{os.tmpdir()}/claude-dashboard/{project}.json`
- **Project** — `process.env.CLAUDELIKE_BAR_NAME` if set, else `path.basename(cwd)`, sanitized (strip path separators, leading/trailing dots)
- **Required field** — `context_percent: number` (0–100)
- **Atomic write** — tmp file + rename, otherwise the hook's concurrent writes will race with yours and clobber status fields. Pattern used by the shipped scripts:
  ```js
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload) + '\n');
  fs.renameSync(tmp, file);
  ```
- **Merge, don't overwrite** — the hook writes `status`/`event`/`timestamp` into the same file. Read-merge-write so you don't wipe them.

The shipped script at `hooks/claudelike-statusline.js` is the reference implementation. Copy from it rather than inlining — it handles `cwd` fallbacks, sanitization, atomic writes, and debug logging.
