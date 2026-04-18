# claudelike-bar

[![Open VSX Version](https://img.shields.io/open-vsx/v/aes87/claudelike-bar?label=Open%20VSX&color=1e1e2e)](https://open-vsx.org/extension/aes87/claudelike-bar)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**What would you do for a Claudelike Bar?**

Probably open six terminals, lose track of which one needs input, miss the notification, and mass-`Ctrl+Tab` through all of them like a feral raccoon.

This fixes that.

<div align="center">

### [LIVE PREVIEW — See it in action →](https://aes87.github.io/claudelike-bar/)

*Interactive demo with animated status dots, theme colors, and all five states*

</div>

---

## What It Is

A VS Code sidebar that shows you — at a glance — what every Claude Code terminal is doing. Colored tiles, animated status dots, zero guesswork.

## How to Install

### Prerequisites

- **VS Code** >= 1.93
- **Claude Code** — the CLI, installed and working
- **Node.js** — bundled with Claude Code, no separate install needed

That's it. No `jq`, no bash, no special tools.

### The fast path

1. Install from [Open VSX](https://open-vsx.org/extension/aes87/claudelike-bar) — or any VS Code-compatible marketplace
2. Open VS Code, you'll see a notification: **"Claudelike Bar needs hooks to track terminal status. Set up your projects now?"**
3. Click **Set Up Projects** to run the wizard, or **Install Hooks Only** for a minimal start.

The extension writes a hook script to `~/.claude/hooks/dashboard-status.js` and registers event handlers in `~/.claude/settings.json`. Config lives at `~/.claude/claudelike-bar.jsonc` — a single file across all workspaces. Tiles start updating on your next Claude turn.

You can also run install manually: `Cmd+Shift+P` → **Claudelike Bar: Install Hooks**.

### Prefer the command line?

Clone the repo and run:

```bash
./setup.sh
```

Builds the extension, installs the VSIX, copies the hook script, and merges settings.json entries. Idempotent.

### Manual setup

If you prefer to understand each step:

**1. Build and install the extension**

```bash
npm install
npm run package
code --install-extension claudelike-bar-*.vsix --force
```

**2. Copy the hook script**

```bash
cp hooks/dashboard-status.js ~/.claude/hooks/
chmod +x ~/.claude/hooks/dashboard-status.js
```

**3. Register hooks**

Add these to `~/.claude/settings.json` under the `"hooks"` key. If you already have hooks for these events, add the dashboard entry alongside your existing ones — don't replace them.

On Windows, prefix the command with `node` so it doesn't depend on shebang interpretation: `"node \"C:/Users/you/.claude/hooks/dashboard-status.js\""`. The `setup.sh` / `merge-hooks.js` flow handles this automatically.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }]
  }
}
```

**4. Reload VS Code** — `Cmd+Shift+P` → "Reload Window"

### After install: set up your projects

**Option A — Setup Wizard** (recommended for new users):

`Cmd+Shift+P` → "Claudelike Bar: Set Up Projects"

The wizard walks you through 5 steps: pick your project folders, confirm names, assign colors, choose a startup command, and review. Your projects auto-start on the next VS Code launch.

**Option B — Let Claude do it:**

Open a Claude Code terminal and say:

> *"Walk me through configuring the Claudelike Bar."*

Claude will read `~/.claude/claudelike-bar.jsonc`, ask what projects you care about, set up auto-start commands, pick a personality mode, assign colors, and nudge you to drag the tiles into order.

**Option C — Edit the config directly:**

`Cmd+Shift+P` → "Claudelike Bar: Open Config" — the JSONC file is documented with inline comments.

## Features

- **Setup wizard** — 5-step guided onboarding: pick folders, name projects, assign colors, choose command, review *(v0.11)*
- **Global config** — single `~/.claude/claudelike-bar.jsonc` across all workspaces, auto-migrated from workspace-local *(v0.10)*
- **Path-based identity** — projects keyed by absolute path, collision-resistant slugs, no more basename conflicts *(v0.10)*
- **Live status tiles** for every open Claude Code session
- **Animated dots** — green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Sort modes** — `auto` (status-based: waiting floats to top) or `manual` (drag to arrange)
- **Drag and drop reordering** — grab any tile, drop it where you want; order persists
- **Mark as done** — right-click → "Mark as done" parks a session: sinks to bottom, goes quiet, ignores background events
- **Two personality modes** — chill (quiet) or passive-aggressive (guilt trips)
- **Context window %** — each tile shows how full the session's context is
- **Color-coded borders** — per-terminal theme colors
- **Nicknames** — custom display names for terminals
- **Auto-start** — mark terminals to launch on VS Code open, each with its own startup command and working directory
- **First-run walkthrough** — VS Code's native walkthrough API guides new users *(v0.11)*
- **Sidebar Add Project button** — one-click project registration from the empty state *(v0.11)*
- **Keyboard nav** — arrow keys / j/k, Enter to switch
- **Debug log** — toggle on to trace every hook event and state transition
- **Cross-platform** — Windows, macOS, Linux; PowerShell, bash, zsh, fish
- **Audio alerts** — optional chime when Claude finishes, optional second sound for permission prompts; bring your own clips *(v0.12)*

## Audio

Optional sound when Claude is waiting on you. Off by default; drop your own
MP3/WAV/OGG files into `~/.claude/sounds/` and point the config at them.
Two slots — one for end-of-turn, one (optional) for mid-job permission
prompts — so you can tell "done" apart from "blocked on approval" by ear.

Quick setup:

1. `Cmd+Shift+P` → **Claudelike Bar: Open Sounds Folder** (creates the
   folder and drops a README in if it's empty).
2. Put one or two short clips in — Mixkit, Pixabay, and Freesound all have
   CC0 options. Filenames: letters, digits, dot, dash, underscore only.
3. Edit `~/.claude/claudelike-bar.jsonc`:
   ```jsonc
   "audio": {
     "enabled": true,
     "volume": 0.6,
     "sounds": { "ready": "chime.mp3", "permission": "ping.mp3" }
   }
   ```
4. Or flip the switch without editing: `Cmd+Shift+P` → **Claudelike Bar:
   Toggle Audio**, or right-click any tile → **Unmute Audio**.

Focused tiles don't ding — you're already looking at them. Simultaneous
finishes on multiple tiles coalesce into one sound. See
[`docs/audio-setup.md`](docs/audio-setup.md) for the full guide.

## How It Works

```
Claude Code hooks fire on events
         ↓
dashboard-status.js derives slug (env var → path index → basename)
         ↓
Writes JSON → {os.tmpdir()}/claude-dashboard/{slug}.json
         ↓
VS Code FileSystemWatcher picks it up
         ↓
Sidebar tiles update in real time
```

### Statuses

| Status | Trigger | Visual |
|--------|---------|--------|
| **Working** | Claude is running tools | Green pulsing dot |
| **Ready** | Claude finished, needs input | Amber blinking dot |
| **Waiting** | Ready for 60+ seconds | Amber, floats to top |
| **Ignored** | You looked at it and switched away | Red dot + snarky message |
| **Done** | Quietly finished | Cyan static dot |
| **Idle** | No activity | Dim, no dot |

The "ignored" state only activates in passive-aggressive mode. Messages include gems like "Patiently judging you" and "I'll just wait here then."

## Commands

All commands are available from the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), prefixed with **Claudelike Bar:**.

| Command | What It Does |
|---------|-------------|
| **Set Up Projects** | 5-step setup wizard — pick folders, name projects, assign colors, choose command, review. Best for first-time setup or reconfiguring after an upgrade. |
| **Register Project** | Add a project and open it immediately — folder picker, slug assignment, terminal opens with Claude running. Also the "+" button in the sidebar header. |
| **Open Config** | Opens `~/.claude/claudelike-bar.jsonc` in the editor. Also available as the gear icon in the sidebar header. |
| **Install Hooks** | Copies the hook script to `~/.claude/hooks/` and registers event handlers in `~/.claude/settings.json`. Idempotent. |
| **Install Statusline** | Installs the optional context % statusline script. Prompts before replacing an existing statusline. |
| **Restore Previous Statusline** | Puts back the statusline that was replaced by "Install Statusline", from the backup file. |
| **Show Me the Hooks** | Opens the hooks documentation in your browser — see exactly what gets written before installing. |
| **Toggle Audio** | Flips `audio.enabled` in the config. Also wired to the tile context menu as "Mute Audio" / "Unmute Audio". |
| **Open Sounds Folder** | Opens `~/.claude/sounds/` in your OS file manager. Creates the folder and a README on first call if it's empty. |

## How to Configure

**The easiest way: just tell Claude Code what you want.** The config file is designed to be read and edited by Claude natively. Try:

- *"Switch to passive-aggressive mode"*
- *"Change the api terminal color to red"*
- *"Auto-start world-domination when VS Code opens"*
- *"Give the yeet-to-prod terminal a nickname"*

Claude will read `~/.claude/claudelike-bar.jsonc`, make the change, and the extension picks it up immediately. No restart needed.

### Manual configuration

All settings live in `~/.claude/claudelike-bar.jsonc` — a single global file next to your Claude Code hooks and settings. Auto-created when you first open a terminal or run the setup wizard.

The file supports comments and is organized into sections:

```jsonc
{
  // ┌─────────────────────────────────────────────┐
  // │  BIG KNOBS                                  │
  // └─────────────────────────────────────────────┘

  // "chill"              — terminals quietly fade to "Done"
  // "passive-aggressive" — guilt-trips you with snarky messages
  "mode": "chill",

  // "auto"   — sort tiles by status (waiting → ready → working → done → idle)
  // "manual" — respect drag-and-drop order from terminals[].order
  // Dragging a tile auto-flips this to "manual".
  "sortMode": "auto",

  // Global command sent into auto-started terminals. Null to disable.
  // Per-terminal `command` below overrides this.
  "claudeCommand": null,

  // Turn on to trace hook events and state transitions to the
  // "Claudelike Bar" output channel + {os.tmpdir()}/claude-dashboard/debug.log
  "debug": false,

  // ┌─────────────────────────────────────────────┐
  // │  FINE TUNING                                │
  // └─────────────────────────────────────────────┘

  "labels": { "idle": "Idle", "working": "Working", ... },
  "contextThresholds": { "warn": 30, "crit": 50 },
  "ignoredTexts": [ "Being ignored :(", ... ],

  // ┌─────────────────────────────────────────────┐
  // │  TERMINALS                                  │
  // └─────────────────────────────────────────────┘

  "terminals": {
    "world-domination": {
      "path": "/home/you/projects/world-domination",
      "color": "cyan",
      "icon": "calendar",
      "autoStart": true,
      "command": "claude"
    },
    "yeet-to-prod": {
      "path": "/home/you/projects/yeet-to-prod",
      "color": "yellow",
      "icon": "server",
      "nickname": "deploy",
      "autoStart": true,
      "command": "claude"
    }
  }
}
```

### Terminal options

| Field | Type | Default | What It Does |
|-------|------|---------|--------------|
| `path` | string \| null | *unset* | Absolute path to the project directory. Canonical identity — used for matching hook updates to tiles and deriving collision-free status filenames. Also the default `cwd` when `cwd` is unset. Set automatically by the setup wizard or "Register Project" command. |
| `color` | string | auto | Preset: `cyan`, `green`, `blue`, `magenta`, `yellow`, `white`, `red`. Or any CSS color: `#e06c75`, `rgb(224, 108, 117)`, `hsl(355, 65%, 65%)`, `var(--my-color)`. |
| `icon` | string \| null | auto | Any [VS Code codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name |
| `nickname` | string \| null | `null` | Display name shown on tile instead of terminal name |
| `autoStart` | boolean | `false` | Launch this terminal when VS Code starts |
| `cwd` | string \| null | *unset* | Working directory for the terminal. Cross-platform — passed through VS Code's `createTerminal({ cwd })` API, not shell syntax. Use this instead of `cd /path &&` in `command`. |
| `command` | string \| null | *inherits `claudeCommand`* | Command sent to the terminal when auto-started. With `cwd` set, this can be a simple `"claude"` — no `cd`, no `&&`, works on every shell. Omit the field to inherit the global default; set to `null` to open the terminal without running anything. |
| `order` | number | *unset* | Manual sort position (set by drag-and-drop). Only used when top-level `sortMode` is `"manual"`. |

Edit the file directly — changes take effect immediately. Claude Code can also read and modify it natively.

### Sorting tiles

Two modes, set by the top-level `sortMode` key:

- **`"auto"`** *(default)* — tiles are sorted by status so things needing attention float to the top: `waiting → ignored → ready → working → done → idle`. Most-recent activity wins within a status group.
- **`"manual"`** — tiles use the per-terminal `order` values (assigned by dragging). New/unordered tiles sink to the bottom.

You can drag tiles in either mode — dragging automatically flips `sortMode` to `"manual"`. To go back to status-based sort, set `"sortMode": "auto"` (the `order` values are left in place, harmlessly ignored, and restored if you switch back).

### Cross-platform auto-start (Windows, macOS, Linux)

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

**If you need a specific shell** (e.g., git-bash for legacy commands): set `shellPath` per terminal:
```jsonc
"shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
```

The `CLAUDELIKE_BAR_NAME` env var is set through VS Code's `createTerminal({ env })` API — no shell syntax, every platform.

### Context % (Optional Enhancement)

Context % on tiles comes from a Claude Code statusline script that writes `context_percent` into the status file. The extension ships a standalone one — it's completely independent of the rest of the extension and shares only the status-file format.

**If you don't already have a statusline configured:** the extension offers to install ours during first-run onboarding. You can also run it any time: `Cmd+Shift+P` → **Claudelike Bar: Install Statusline**.

**If you already have a statusline:** running **Install Statusline** will prompt before replacing it — confirming backs up the prior `statusLine` value to `~/.claude/.claudelike-bar-statusline-backup.json`. To restore, run **Claudelike Bar: Restore Previous Statusline** (see Troubleshooting).

**Writing your own statusline integration** — any script that writes the status file format works. The contract:

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

The shipped script at `hooks/claudelike-statusline.js` is the reference implementation; copy from it rather than inlining — it handles cwd fallbacks, sanitization, atomic writes, and debug logging.

## Troubleshooting

**Extension crashes on activation (`Cannot find module './impl/format'`)**
- This happens when the esbuild bundle didn't properly inline `jsonc-parser`'s internal modules. Rebuild:
  ```bash
  npm run build && npm run package
  code --install-extension claudelike-bar-*.vsix --force
  ```
  Then reload VS Code. The build script uses `--main-fields=module,main` to resolve the ESM build of jsonc-parser, which bundles correctly.
- To check activation status: `grep -A2 "claudelike-bar" ~/.vscode-server/data/logs/*/exthost*/remoteexthost.log`

**Sidebar shows "No terminals open"**
- Reload VS Code after installing
- Open at least one named terminal — plain shell terminals named "bash"/"zsh"/"sh" are filtered out. Use a VS Code terminal profile or rename the terminal
- If the extension failed to activate (check the log above), no terminals will ever appear — fix the activation error first

**Debugging with the trace log**
- Set `"debug": true` in `~/.claude/claudelike-bar.jsonc`. The extension logs every hook event and state transition to the **Claudelike Bar** output channel (`Ctrl+Shift+U`), the hook script writes a trace to `{os.tmpdir()}/claude-dashboard/debug.log`, and the statusline script appends its own failures to the same file.

**Put my old statusline back**
- Run `Cmd+Shift+P` → **Claudelike Bar: Restore Previous Statusline**. It reads `~/.claude/.claudelike-bar-statusline-backup.json`, writes `previous_statusLine` back into `~/.claude/settings.json`, and archives the backup to `…-backup.json.restored.json`.
- If the command fails or the extension isn't installed, open `~/.claude/.claudelike-bar-statusline-backup.json` and copy `previous_statusLine` back into `~/.claude/settings.json` under `"statusLine"`. The backup file includes a `note` field walking through this. You can also ask Claude Code in any terminal — *"restore my old Claude statusline from the backup"* — and it'll do it for you.

**Tiles stuck on "Working" — never show "Ready for input"**
- The `dashboard-status.js` hook must be registered on **all 4 events**: `PreToolUse`, `UserPromptSubmit`, `Stop`, and `Notification`. If Stop/Notification are missing, the bar never sees the "finished" signal
- Re-run `./setup.sh` or `node scripts/merge-hooks.js` to add any missing events — both are idempotent
- Verify: `grep dashboard-status ~/.claude/settings.json` should show the hook under all 4 events

**Tiles appear but never update status**
- Check hooks are registered: `grep dashboard-status ~/.claude/settings.json`
- Check the hook script exists and is executable: `ls -la ~/.claude/hooks/dashboard-status.js`
- Check status files are being written: `ls "$(node -e 'console.log(require(\"os\").tmpdir())')/claude-dashboard/"`
- If nothing there, the hooks aren't firing — verify Claude Code is running

**Extension not showing in activity bar**
- Make sure you installed the `.vsix`, not just cloned the repo
- Check Extensions panel for "Claudelike Bar" — it should be listed and enabled

**Broke after container rebuild / VS Code update**
- The extension is reinstalled from the VSIX on container start, but the VS Code server (and its Node.js runtime) may have changed. If the extension was built with an older esbuild config, the bundle may not work with the new runtime
- Rebuild from source: `npm run build && npm run package && code --install-extension claudelike-bar-*.vsix --force`
- Check activation logs for the specific error

## Upgrading

```bash
cd claudelike-bar
git pull
./setup.sh
```

The setup script is idempotent — it won't duplicate hooks or break existing config.

## License

MIT — do whatever you want. We're not Klondike.
