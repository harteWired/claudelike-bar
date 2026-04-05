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

## Features

- **Live status tiles** for every open Claude Code session
- **Animated dots** — green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Auto-sorted** — "waiting for input" floats to top, because that's the one you keep ignoring
- **Sticky waiting** — stays "waiting" until you actually look at it. If you look at a different terminal instead, it gets passive-aggressive
- **Context window %** — each tile shows how full the session's context is, color-coded so you know when to panic
- **Color-coded borders** — per-terminal colors via config file. Thick enough to see without squinting
- **Nicknames** — give terminals display names that make sense to you
- **Auto-start** — mark terminals to launch automatically when VS Code opens
- **Config file** — plain JSON, auto-populated, Claude Code can read and edit it natively
- **Keyboard nav** — arrow keys / j/k, Enter to switch. For the mouse-averse
- **DOM diffing** — no flicker, no missed clicks, no full redraws. Patches only what changed

## How It Works

```
Claude Code hooks write JSON → /tmp/claude-dashboard/project.json
         statusline.sh adds → context_percent
                                      ↓
           VS Code FileSystemWatcher picks it up
                                      ↓
                 Sidebar tiles update in real time
```

Five statuses:
| Status | Trigger | You Should |
|--------|---------|------------|
| **Working** | Claude is doing things | Wait |
| **Waiting** | Claude needs you | Stop ignoring it |
| **Ignored** | You focused a different terminal while one was waiting | Feel bad |
| **Done** | Claude finished | Feel briefly productive |
| **Idle** | Nothing happening | Question your choices |

The "ignored" state rotates through helpful messages like "Patiently judging you" and "I'll just wait here then." You earned them.

## Install

```bash
git clone https://github.com/aes87/claudelike-bar.git
cd claudelike-bar
npm install
npm run package
code --install-extension claudelike-bar-*.vsix --force
```

Then reload VS Code. New icon appears in the activity bar. Click it. Marvel.

## Hook Setup

The extension reads status from hook-written JSON files. A ready-to-use hook script is included in the repo at `hooks/dashboard-status.sh`.

### 1. Copy the hook script

```bash
cp hooks/dashboard-status.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/dashboard-status.sh
```

Make sure `jq` is installed — the hook uses it to parse tool names.

### 2. Register hooks

Merge the contents of `hooks/settings-snippet.json` into your `~/.claude/settings.json`. Or paste this under the `"hooks"` key:

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

### 3. Verify it works

Open a Claude Code session, do something, then check:

```bash
cat /tmp/claude-dashboard/*.json
```

You should see JSON with `project`, `status`, `timestamp`, and `event` fields.

### 4. Context % (Optional)

Add this to your statusline script to feed context window usage into the tiles:

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

## Configuration

All settings live in `.claudelike-bar.json` in your workspace root. **You don't need to create this file** — the extension auto-populates it as you open terminals.

Example:

```json
{
  "description": "Claudelike Bar configuration. Each key is a terminal name. Edit colors, nicknames, and auto-start directly.",
  "terminals": {
    "life-planner": {
      "color": "cyan",
      "nickname": null,
      "autoStart": false
    },
    "api": {
      "color": "yellow",
      "nickname": "backend",
      "autoStart": true
    }
  }
}
```

| Field | Type | Default | What It Does |
|-------|------|---------|--------------|
| `color` | string | `white` | Tile border color: `cyan`, `green`, `blue`, `magenta`, `yellow`, `white`, `red` |
| `nickname` | string or null | `null` | Display name shown on the tile instead of the terminal name |
| `autoStart` | boolean | `false` | Launch this terminal automatically when VS Code starts |

Edit the file directly — changes take effect immediately. Claude Code can read and modify this file natively, so you can ask it to change colors or nicknames for you.

## Requirements

- VS Code >= 1.93
- Claude Code with hooks configured
- `jq` installed
- The emotional maturity to stop ignoring amber dots

## License

MIT — do whatever you want. We're not Klondike.
