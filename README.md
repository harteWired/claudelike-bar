# claudelike-bar

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/aes87.claudelike-bar?label=Marketplace&color=1e1e2e)](https://marketplace.visualstudio.com/items?itemName=aes87.claudelike-bar)
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

## Install

Pick whichever gallery your editor uses:

- **[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aes87.claudelike-bar)** — vanilla VS Code (`ext install aes87.claudelike-bar` or the Extensions sidebar).
- **[Open VSX](https://open-vsx.org/extension/aes87/claudelike-bar)** — VSCodium, Cursor, and most Dev Containers / Codespaces setups.

After install:

1. VS Code prompts: **"Claudelike Bar needs hooks to track terminal status. Set up your projects now?"** Click **Set Up Projects** to run the wizard, or **Install Hooks Only** for a minimal start.
2. Tiles start updating on your next Claude turn.

Prerequisites: **VS Code** ≥ 1.93, **Claude Code** CLI installed and working. No `jq`, no bash, no special tools.

In a **Dev Container or Codespace**? See the [Dev Containers section](docs/install.md#dev-containers--codespaces) for a self-healing `postAttachCommand` snippet.

Prefer the command line or want to see every step? See **[the full install guide](docs/install.md)** for CLI and manual setup.

## Core Features

- **Live status tiles** for every open Claude Code session — colored borders, animated dots, click to switch
- **Smart sort** — `auto` floats sessions needing attention to the top; drag any tile to flip into `manual` mode
- **Auto-start projects** — each terminal has its own startup command and working directory; opens on VS Code launch
- **Context window %** — every tile shows how full the session's context is
- **Two personality modes** — `chill` (quiet) or `passive-aggressive` (guilt-trips you with messages like "Patiently judging you")
- **Audio alerts** — optional chime when Claude finishes (`turnDone`) and optional second sound for mid-job prompts (`midJobPrompt`). Ships with a gentle default chime + a soda-can pop alternative; drop your own clips in `~/.claude/sounds/` to override
- **Setup wizard + walkthrough** — 5-step guided onboarding; VS Code's native walkthrough API for first-run

<details>
<summary><b>More features</b> — drag-drop, pinning, offline tiles, remote dev, keyboard nav, mark-as-done, custom colors, nicknames, debug tracing</summary>

- **Drag and drop reordering** — grab any tile, drop it where you want; order persists
- **Mark as done** — right-click → "Mark as done" parks a session: sinks to bottom, goes quiet, ignores background events
- **Pinned tiles** — right-click → **Pin tile** to fix a terminal in a stable bottom zone regardless of `sortMode`. Useful for monitoring/infra tiles you want at known coordinates while urgent project tiles float to the top *(v0.13.4)*
- **Offline tiles for registered projects** — every entry in your config that isn't currently running shows as a dim/dashed tile in its own zone at the bottom. Click to launch. Per-entry `hidden: true` opt-out, or `showRegisteredProjects: false` to disable globally *(v0.13.4)*
- **Launch registered projects on demand** — palette command + sidebar rocket button + tile right-click. Pairs with the *Register only* option in **Register Project** for building a registry without spawning terminals *(v0.13)*
- **Remote development** — runs on the workspace side in WSL2, SSH Remote, Dev Containers, and Codespaces, so hooks/config/status files all line up with where Claude Code actually lives *(v0.13.3)*
- **Custom colors** — per-terminal theme colors. Right-click a tile → swatch row + custom color picker (any CSS color) *(picker added v0.13.2)*
- **Nicknames** — custom display names for terminals
- **Keyboard nav** — arrow keys / j/k, Enter to switch
- **Auto-start safety** — entries with missing `cwd` are skipped with a single summary toast instead of N modal errors *(v0.13.1)*
- **"Switch to auto sort"** — when in manual mode, right-click any tile to flip back to status-based sort *(v0.13.1)*
- **Path-based identity** — projects keyed by absolute path, collision-resistant slugs, no more basename conflicts *(v0.10)*
- **Global config** — single `~/.claude/claudelike-bar.jsonc` across all workspaces, auto-migrated from workspace-local *(v0.10)*
- **Sidebar Add Project button** — one-click project registration from the empty state *(v0.11)*
- **Debug log** — toggle on to trace every hook event and state transition
- **Cross-platform** — Windows, macOS, Linux; PowerShell, bash, zsh, fish

</details>

## How It Works

![Hook-to-tile pipeline — Claude Code event hooks (PreToolUse, Stop, UserPromptSubmit, Notification) fire dashboard-status.js, which derives a collision-free slug (env var → path index → basename), then writes an atomic JSON file to {tmpdir}/claude-dashboard/{slug}.json. On the VS Code side, a FileSystemWatcher observes that directory and the sidebar re-renders each tile with its colored border and animated status dot. Amber borders mark the entry point and the JSON-file bridge; teal marks the VS Code extension side.](./docs/images/pipeline.png)

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
| **Set Up Projects** | 5-step setup wizard — pick folders, name projects, assign colors, choose command, review. Best for first-time setup. |
| **Register Project** | Add a project — folder picker, slug assignment, asks whether to open the terminal now or just register it for later. Also the "+" button in the sidebar header. |
| **Open Config** | Opens `~/.claude/claudelike-bar.jsonc` in the editor. Also available as the gear icon in the sidebar header. |

<details>
<summary><b>All commands</b> — install hooks, statusline, audio, launch, restore</summary>

| Command | What It Does |
|---------|-------------|
| **Launch Registered Project** | Open any registered project that isn't already running. QuickPick of your config entries; routes through the same launch path as auto-start. Also the rocket icon in the sidebar header and "Launch another project…" in the tile context menu. |
| **Install Hooks** | Copies the hook script to `~/.claude/hooks/` and registers event handlers in `~/.claude/settings.json`. Idempotent. |
| **Install Statusline** | Installs the optional context % statusline script. Prompts before replacing an existing statusline. |
| **Restore Previous Statusline** | Puts back the statusline that was replaced by **Install Statusline**, from the backup file. |
| **Show Me the Hooks** | Opens the hooks documentation in your browser — see exactly what gets written before installing. |
| **Toggle Audio** | Flips `audio.enabled` in the config. Also wired to the tile context menu as **Mute Audio** / **Unmute Audio**. |
| **Open Sounds Folder** | Opens `~/.claude/sounds/` in your OS file manager. Creates the folder and a README on first call if it's empty. |

</details>

## Configure

All settings live in `~/.claude/claudelike-bar.jsonc` — a single global file next to your Claude Code hooks and settings. `Cmd+Shift+P` → **Claudelike Bar: Open Config** to open it. Auto-created when you first open a terminal or run the setup wizard. Edits take effect immediately — no reload.

```jsonc
{
  // "chill"              — terminals quietly fade to "Done"
  // "passive-aggressive" — guilt-trips you with snarky messages
  "mode": "chill",

  // "auto"   — sort tiles by status (waiting → ready → working → done → idle)
  // "manual" — respect drag-and-drop order from terminals[].order
  "sortMode": "auto",

  // Global command sent into auto-started terminals. Null to disable.
  // Per-terminal `command` below overrides this.
  "claudeCommand": null,

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

Full field reference, sorting rules, cross-platform auto-start, and context % integration: **[terminal configuration guide](docs/terminal-configuration.md)**.

> [!TIP]
> **Or just ask Claude.** Open a Claude Code terminal and say *"switch to passive-aggressive mode"*, *"change the api terminal color to red"*, *"auto-start world-domination when VS Code opens"*. Claude reads the JSONC, makes the change, and the extension picks it up immediately.

## Audio

Optional sound when Claude is waiting on you. Off by default. Drop your own MP3/WAV/OGG files into `~/.claude/sounds/` and point the config at them. Two slots — one for end-of-turn, one (optional) for mid-job permission prompts — so you can tell "done" apart from "blocked on approval" by ear.

Quick setup:

1. `Cmd+Shift+P` → **Claudelike Bar: Open Sounds Folder** (creates the folder and drops a README in if it's empty).
2. Put one or two short clips in — Mixkit, Pixabay, and Freesound all have CC0 options.
3. Edit `~/.claude/claudelike-bar.jsonc`:
   ```jsonc
   "audio": {
     "enabled": true,
     "volume": 0.6,
     "sounds": { "ready": "chime.mp3", "permission": "ping.mp3" }
   }
   ```
4. Or flip the switch without editing: `Cmd+Shift+P` → **Claudelike Bar: Toggle Audio**, or right-click any tile → **Unmute Audio**.

Focused tiles don't ding — you're already looking at them. Simultaneous finishes on multiple tiles coalesce into one sound. Full guide: [audio setup](docs/audio-setup.md).

<details>
<summary><b>Troubleshooting</b> — activation errors, stuck tiles, missing hooks, statusline restore</summary>

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

</details>

## License

MIT — do whatever you want. We're not Klondike.
