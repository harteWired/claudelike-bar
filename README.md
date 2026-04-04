# claudelike-bar

**What would you do for a Claudelike Bar?**

Probably open six terminals, lose track of which one needs input, miss the notification, and mass-`Ctrl+Tab` through all of them like a feral raccoon.

This fixes that.

**[Live Preview →](https://aes87.github.io/claudelike-bar/)**

## What It Is

A VS Code sidebar that shows you — at a glance — what every Claude Code terminal is doing. Colored tiles, animated status dots, zero guesswork.

## Features

- **Live status tiles** for every open Claude Code session
- **Animated dots** — green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Auto-sorted** — "waiting for input" floats to top, because that's the one you keep ignoring
- **Sticky waiting** — stays "waiting" until you actually look at it. If you look at a different terminal instead, it gets passive-aggressive
- **Context window %** — each tile shows how full the session's context is, color-coded so you know when to panic
- **Color-coded borders** — matched to your terminal tab colors by project domain. Thick enough to see without squinting
- **Keyboard nav** — arrow keys / j/k, Enter to switch. For the mouse-averse
- **DOM diffing** — no flicker, no missed clicks, no full redraws. Patches only what changed
- **14 KB packaged** — still smaller than most READMEs

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

## Theme Colors

Tile borders match your VS Code terminal ANSI colors by project category:

| Category | Color | You Know the Type |
|----------|-------|-------------------|
| Life & finance | Cyan | The ones that make you feel responsible |
| Home & IoT | Green | The ones that control physical objects |
| Knowledge | Blue | The ones you open to "organize later" |
| Web & design | Magenta | The pretty ones |
| Dev infra | Yellow | The ones that make the other ones work |

## Install

```bash
git clone https://github.com/aes87/claudelike-bar.git
cd claudelike-bar
npm install && npm run build
npx vsce package --allow-missing-repository
code --install-extension claude-terminal-dashboard-*.vsix --force
```

Then reload VS Code. New icon appears in the activity bar. Click it. Marvel.

## Hook Setup

The extension reads status from hook-written JSON files. You need two things:

### 1. Hook Script

Save as `~/.claude/hooks/dashboard-status.sh`:

```bash
#!/bin/bash
PROJECT=$(basename "$PWD")
EVENT="$CLAUDE_HOOK_EVENT_NAME"
INPUT=$(cat)

STATUS="working"
if [ "$EVENT" = "Stop" ]; then
  STATUS="done"
elif [ "$EVENT" = "Notification" ]; then
  STATUS="waiting"
elif [ "$EVENT" = "PreToolUse" ]; then
  TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
  if [ "$TOOL" = "AskUserQuestion" ] || [ "$TOOL" = "ExitPlanMode" ]; then
    STATUS="waiting"
  fi
fi

mkdir -p /tmp/claude-dashboard
echo "{\"project\":\"$PROJECT\",\"status\":\"$STATUS\",\"timestamp\":$(date +%s),\"event\":\"$EVENT\"}" \
  > "/tmp/claude-dashboard/${PROJECT}.json"
```

### 2. Register Hooks

Add to your `~/.claude/settings.json`:

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

### 3. Context % (Optional)

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

See `PLAN.md` for the full architecture and design decisions.

## Requirements

- VS Code ≥ 1.93
- Claude Code with hooks configured
- `jq` installed
- The emotional maturity to stop ignoring amber dots

## License

MIT — do whatever you want. We're not Klondike.
