# claudelike-bar

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
- **Node.js** — for building the extension (any recent version)

That's it. No `jq`, no special tools.

### Point Claude at it

> *"Install this extension: https://github.com/aes87/claudelike-bar"*

That's it. Claude clones the repo, reads the setup instructions, and handles everything. Reload VS Code when it's done.

### One-command setup

Or run it yourself:

```bash
./setup.sh
```

The setup script copies the hook script, registers hooks in `~/.claude/settings.json` (idempotent — safe to run twice), builds and installs the extension. Reload VS Code after setup — the octopus icon appears in the activity bar.

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
cp hooks/dashboard-status.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/dashboard-status.sh
```

**3. Register hooks**

Add these to `~/.claude/settings.json` under the `"hooks"` key. If you already have hooks for these events, add the dashboard entry alongside your existing ones — don't replace them.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.sh" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.sh" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.sh" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.sh" }] }]
  }
}
```

**4. Reload VS Code** — `Cmd+Shift+P` → "Reload Window"

### After install: let Claude walk you through setup

Once the extension is running, the fastest way to get it feeling *yours* is to open a Claude Code terminal and say:

> *"Walk me through configuring the Claudelike Bar."*

Claude will read `.claudelike-bar.jsonc`, ask what projects you care about, set up auto-start commands, pick a personality mode, assign colors, decide between auto-sort and manual-sort, and nudge you to drag the tiles into whatever order you want. It's the same config file documented below — but you don't have to read it.

## Features

- **Live status tiles** for every open Claude Code session
- **Animated dots** — green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Sort modes** — `auto` (status-based: waiting floats to top) or `manual` (drag to arrange)
- **Drag and drop reordering** — grab any tile, drop it where you want; order persists
- **Mark as done** — right-click → "Mark as done" parks a session: sinks to bottom of auto-sort, goes quiet, ignores background hook events. Un-parks only when you submit a new prompt in that terminal.
- **Two personality modes** — chill (quiet) or passive-aggressive (guilt trips)
- **Context window %** — each tile shows how full the session's context is
- **Color-coded borders** — per-terminal theme colors
- **Nicknames** — custom display names for terminals
- **Auto-start** — mark terminals to launch on VS Code open, each with its own startup command
- **Keyboard nav** — arrow keys / j/k, Enter to switch
- **Debug log** — toggle on to trace every hook event and state transition
- **DOM diffing** — no flicker, patches only what changed

## How It Works

```
Claude Code hooks fire on events
         ↓
dashboard-status.sh writes JSON → /tmp/claude-dashboard/{project}.json
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

## How to Configure

**The easiest way: just tell Claude Code what you want.** The config file is designed to be read and edited by Claude natively. Try:

- *"Switch to passive-aggressive mode"*
- *"Change the api terminal color to red"*
- *"Auto-start world-domination when VS Code opens"*
- *"Give the yeet-to-prod terminal a nickname"*

Claude will read `.claudelike-bar.jsonc`, make the change, and the extension picks it up immediately. No restart needed.

### Manual configuration

All settings live in `.claudelike-bar.jsonc` in your workspace root. The file is auto-created when you first open a terminal — you don't need to create it manually.

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
  // "Claudelike Bar" output channel + /tmp/claude-dashboard/debug.log
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
      "color": "cyan",
      "icon": "calendar",
      "autoStart": true,
      "command": "cd ~/projects/world-domination && claude --dangerously-skip-permissions"
    },
    "yeet-to-prod": {
      "color": "yellow",
      "icon": "server",
      "nickname": "deploy",
      "autoStart": true,
      "command": "cd ~/projects/yeet-to-prod && claude --dangerously-skip-permissions"
    }
  }
}
```

### Terminal options

| Field | Type | Default | What It Does |
|-------|------|---------|--------------|
| `color` | string | auto | `cyan`, `green`, `blue`, `magenta`, `yellow`, `white`, `red` |
| `icon` | string \| null | auto | Any [VS Code codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name |
| `nickname` | string \| null | `null` | Display name shown on tile instead of terminal name |
| `autoStart` | boolean | `false` | Launch this terminal when VS Code starts |
| `command` | string \| null | *inherits `claudeCommand`* | Command sent to the terminal when auto-started. Use `"cd /path/to/project && claude"` to set the working directory. Omit the field to inherit the global default; set to `null` to open the terminal without running anything. |
| `order` | number | *unset* | Manual sort position (set by drag-and-drop). Only used when top-level `sortMode` is `"manual"`. |

Edit the file directly — changes take effect immediately. Claude Code can also read and modify it natively.

### Sorting tiles

Two modes, set by the top-level `sortMode` key:

- **`"auto"`** *(default)* — tiles are sorted by status so things needing attention float to the top: `waiting → ignored → ready → working → done → idle`. Most-recent activity wins within a status group.
- **`"manual"`** — tiles use the per-terminal `order` values (assigned by dragging). New/unordered tiles sink to the bottom.

You can drag tiles in either mode — dragging automatically flips `sortMode` to `"manual"`. To go back to status-based sort, set `"sortMode": "auto"` (the `order` values are left in place, harmlessly ignored, and restored if you switch back).

### Context % (Optional Enhancement)

If you use a Claude Code statusline script, add this to feed context window usage into the tiles:

```bash
DIR=$(echo "$input" | jq -r '.workspace.current_dir // "?"' | xargs basename)
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

mkdir -p /tmp/claude-dashboard
DASH_FILE="/tmp/claude-dashboard/${DIR}.json"
if [ -f "$DASH_FILE" ]; then
  echo "$(jq -c --argjson cp "$PCT" '.context_percent = $cp' "$DASH_FILE")" > "$DASH_FILE"
else
  echo "{\"project\":\"$DIR\",\"timestamp\":$(date +%s),\"context_percent\":$PCT}" > "$DASH_FILE"
fi
```

This requires `jq`. The base extension does not.

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

**Tiles stuck on "Working" — never show "Ready for input"**
- The `dashboard-status.sh` hook must be registered on **all 4 events**: `PreToolUse`, `UserPromptSubmit`, `Stop`, and `Notification`. If Stop/Notification are missing, the bar never sees the "finished" signal
- Re-run `./setup.sh` or `node scripts/merge-hooks.js` to add any missing events — both are idempotent
- Verify: `grep dashboard-status ~/.claude/settings.json` should show the hook under all 4 events

**Tiles appear but never update status**
- Check hooks are registered: `grep dashboard-status ~/.claude/settings.json`
- Check the hook script exists and is executable: `ls -la ~/.claude/hooks/dashboard-status.sh`
- Check status files are being written: `cat /tmp/claude-dashboard/*.json`
- If nothing in `/tmp/claude-dashboard/`, the hooks aren't firing — verify Claude Code is running

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
