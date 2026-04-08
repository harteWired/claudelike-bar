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

## Features

- **Live status tiles** for every open Claude Code session
- **Animated dots** — green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Auto-sorted** — "waiting for input" floats to top
- **Two personality modes** — chill (quiet) or passive-aggressive (guilt trips)
- **Context window %** — each tile shows how full the session's context is
- **Color-coded borders** — per-terminal theme colors
- **Nicknames** — custom display names for terminals
- **Auto-start** — mark terminals to launch on VS Code open
- **Keyboard nav** — arrow keys / j/k, Enter to switch
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
- *"Auto-start life-planner when VS Code opens"*
- *"Give the backend terminal a nickname"*

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
    "my-project": {
      "color": "cyan",
      "icon": "calendar",
      "nickname": null,
      "autoStart": false
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

Edit the file directly — changes take effect immediately. Claude Code can also read and modify it natively.

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

**Sidebar shows "No terminals open"**
- Reload VS Code after installing
- Open at least one terminal (plain shell terminals named "bash"/"zsh" are filtered out — use Claude Code or named terminals)

**Tiles appear but never update status**
- Check hooks are registered: `grep dashboard-status ~/.claude/settings.json`
- Check the hook script exists and is executable: `ls -la ~/.claude/hooks/dashboard-status.sh`
- Check status files are being written: `cat /tmp/claude-dashboard/*.json`
- If nothing in `/tmp/claude-dashboard/`, the hooks aren't firing — verify Claude Code is running

**Extension not showing in activity bar**
- Make sure you installed the `.vsix`, not just cloned the repo
- Check Extensions panel for "Claudelike Bar" — it should be listed and enabled

## Upgrading

```bash
cd claudelike-bar
git pull
./setup.sh
```

The setup script is idempotent — it won't duplicate hooks or break existing config.

## License

MIT — do whatever you want. We're not Klondike.
