# claudelike-bar

**What would you do for a Claudelike Bar?**

Probably open six terminals, lose track of which one needs input, miss the notification, and mass-`Ctrl+Tab` through all of them like a feral raccoon.

This fixes that.

## What It Is

A VS Code sidebar that shows you — at a glance — what every Claude Code terminal is doing. Colored tiles, animated status dots, zero guesswork.

## Features

- **Live status tiles** for every open Claude Code session
- **Animated dots**: green pulse (working), amber blink (waiting for you), cyan glow (done)
- **Click to switch** — stops the raccoon behavior
- **Auto-sorted** — "waiting for input" floats to top, because that's the one you keep ignoring
- **Color-coded** by project domain — cyan for life stuff, green for IoT, magenta for web, yellow for dev infra, blue for knowledge hoarding
- **Keyboard nav** — arrow keys / j/k, Enter to switch. For the mouse-averse
- **Done → idle fade** — 30 seconds of smugness, then the dot quietly disappears
- **8 KB packaged** — smaller than most READMEs

## How It Works

```
Claude Code hooks write JSON → /tmp/claude-dashboard/project.json
                                         ↓
              VS Code FileSystemWatcher picks it up
                                         ↓
                    Sidebar tiles update in real time
```

Four statuses:
| Status | Trigger | You Should |
|--------|---------|------------|
| **Working** | Claude is doing things | Wait |
| **Waiting** | Claude needs you | Stop ignoring it |
| **Done** | Claude finished | Feel briefly productive |
| **Idle** | Nothing happening | Question your choices |

## Install

```bash
cd claude-terminal-dashboard
npm install && npm run build
npx vsce package --allow-missing-repository
code --install-extension claude-terminal-dashboard-0.1.0.vsix --force
```

Then reload VS Code. New icon appears in the activity bar. Click it. Marvel.

## Hook Setup

The extension reads status from hook-written JSON files. Add these to your Claude Code `settings.json` hooks:

- **PreToolUse** / **UserPromptSubmit** → `dashboard-status.sh` (writes working/waiting)
- **Stop** → writes done
- **Notification** → writes waiting

See `PLAN.md` for the full hook script and configuration.

## Requirements

- VS Code ≥ 1.93
- Claude Code with hooks configured
- The emotional maturity to stop ignoring amber dots

## License

MIT — do whatever you want. We're not Klondike.
