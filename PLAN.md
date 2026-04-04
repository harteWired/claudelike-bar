# Claude Terminal Dashboard -- Implementation Plan

## What We're Building

A purpose-built VS Code extension that replaces the tiny terminal tab bar with a sidebar panel of large, informative tiles for Claude Code sessions. Each tile shows project name, icon, color (from our theme groupings), session status (working/idle/needs input), and last activity time.

---

## Architecture

### Prior Art Studied

| Extension | Approach | What We Borrow |
|---|---|---|
| **Claude Terminal Manager** (jakub-musik) | Unix socket + hook reporter script, TreeView sidebar, Effect library, process tree correlation | Hook-based status detection, session slug resolution from JSONL files |
| **Conductor Dashboard** (Taitopia) | JSONL parsing + hook events, React/Zustand webview, node-pty, xterm.js embedding | State machine concept (working/thinking/waiting/error/done/idle), webview IPC protocol pattern |
| **Better Terminal Logs** | Shell Integration API, vanilla webview | Proof that `onDidStartTerminalShellExecution` works for command tracking |

### What We DON'T Need (Simplification)

- No React/Zustand/Vite -- vanilla HTML/CSS/JS in the webview is sufficient for tiles
- No node-pty / xterm.js -- we're not embedding terminals, just showing status
- No Effect library -- plain TypeScript is fine for our scope
- No multi-window support -- single devcontainer window
- No token counting / cost tracking -- the Claude Code statusline already shows this
- No conversation view -- we just want tiles with status
- No process tree walking -- our terminal profiles have deterministic names

### Data Flow

```
Claude Code hooks (Stop, Notification, PreToolUse, UserPromptSubmit)
    |
    v
Enhanced hook scripts write JSON to /tmp/claude-dashboard/<project>.json
    |
    v
Extension: FileSystemWatcher on /tmp/claude-dashboard/
    |
    v
Extension: Merge with Terminal API lifecycle events (open/close/focus)
    |
    v
Extension: postMessage to WebviewView
    |
    v
Webview: Render tiles with status, icon, color, time
```

### Key Technical Decisions

| Decision | Rationale |
|---|---|
| **WebviewView** (sidebar), not TreeView | TreeView can't render colored tiles, status badges, or custom layouts |
| **File-based status** (not Unix socket) | Simpler than CTM's socket approach. Our hooks already write to `/tmp`. FileSystemWatcher is stable API for watching `/tmp` via RelativePattern |
| **Hook-driven status** (not JSONL parsing) | Hooks give real-time status with zero latency. JSONL parsing (Conductor's approach) adds complexity and 1s polling. We already have hooks configured |
| **Terminal name matching** (not process tree walk) | Our terminal profiles have unique names matching project names. No need for PID walking since we control the naming convention |
| **Vanilla webview** (not React) | ~10 tiles don't need a framework. Keeps the extension tiny and dependency-free |
| **`--vscode-*` CSS variables** for theming | Webview UI Toolkit was sunsetted Jan 2025. CSS variables are the supported path forward |

---

## Extension Structure

```
claude-terminal-dashboard/
  package.json              # Extension manifest + contributes
  src/
    extension.ts            # activate/deactivate, orchestration
    dashboardProvider.ts    # WebviewViewProvider -- renders sidebar panel
    terminalTracker.ts      # Terminal lifecycle tracking via VS Code API
    statusWatcher.ts        # FileSystemWatcher on /tmp/claude-dashboard/
    types.ts                # Shared types (SessionStatus, TileData, etc.)
  media/
    dashboard.svg           # Activity bar icon
    webview.css             # Tile styles using --vscode-* variables
    webview.js              # Tile rendering + message handling
  tsconfig.json
  esbuild.config.js         # Bundle for extension + webview
```

---

## Status Model

```
┌─────────┐  UserPromptSubmit   ┌─────────┐
│  idle    │ ────────────────>   │ working  │
└─────────┘                     └─────────┘
     ^                               |
     |          Stop                 |  PreToolUse(AskUserQuestion)
     |  ┌─────────────┐             |
     └──│    done      │ <───────   |
        └─────────────┘      |      v
              (fades          |  ┌─────────┐
               after 30s     └──│ waiting  │  (needs user input)
               to idle)         └─────────┘
```

| Status | Trigger | Visual |
|---|---|---|
| `idle` | Terminal open, no activity or done faded | Dim tile, no indicator |
| `working` | `UserPromptSubmit` or `PreToolUse` (non-blocking) | Green pulsing dot |
| `waiting` | `Stop` or `Notification` or `PreToolUse(AskUserQuestion)` | Amber blinking dot |
| `done` | `Stop` after work completed | Cyan static dot, fades to idle after 30s |

### Status JSON format (written by hooks)

```json
{
  "project": "life-planner",
  "status": "waiting",
  "timestamp": 1712188800,
  "event": "Stop"
}
```

---

## Hook Changes

Enhance existing hooks to write structured JSON. Add two new hook events.

**Current hooks:**
- `Stop` -> `notify-silent.sh` (bell + file write)
- `Notification` -> `notify.sh` (bell + file write + sound)

**New hooks to add:**
- `PreToolUse` -> `dashboard-status.sh` (writes "working" or "waiting" if AskUserQuestion)
- `UserPromptSubmit` -> `dashboard-status.sh` (writes "working")

**Enhanced Stop/Notification hooks:** In addition to existing bell + sound behavior, also write structured JSON to `/tmp/claude-dashboard/${PROJECT}.json`.

The dashboard-status.sh script:
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
  else
    STATUS="working"
  fi
fi

mkdir -p /tmp/claude-dashboard
echo "{\"project\":\"$PROJECT\",\"status\":\"$STATUS\",\"timestamp\":$(date +%s),\"event\":\"$EVENT\"}" \
  > "/tmp/claude-dashboard/${PROJECT}.json"
```

---

## Webview Tile Design

Each tile is a clickable card in the sidebar:

```
┌──────────────────────────────┐
│  ● life-planner         2m   │  <- status dot + name + relative time
│    Waiting for input         │  <- status text
└──────────────────────────────┘
┌──────────────────────────────┐
│  ● api                  now  │
│    Working                   │
└──────────────────────────────┘
┌──────────────────────────────┐
│    ha-tools                  │
│    Idle                      │
└──────────────────────────────┘
```

- Left border color: theme color (cyan/green/blue/magenta/yellow)
- Status dot: animated (pulse for working, blink for waiting)
- Click: switches to that terminal (`terminal.show()`)
- Active terminal tile gets highlight background
- Sort order: waiting first, then working, then done, then idle
- Only show tiles for open terminals

### CSS approach

Use `--vscode-*` CSS variables for native theme matching:
```css
.tile {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-left: 3px solid var(--tile-color);
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
}
.tile:hover { background: var(--vscode-list-hoverBackground); }
.tile.active { background: var(--vscode-list-activeSelectionBackground); }
.dot.working { background: var(--vscode-terminal-ansiGreen); animation: pulse 1.5s infinite; }
.dot.waiting { background: var(--vscode-terminal-ansiYellow); animation: blink 1.5s infinite; }
.dot.done { background: var(--vscode-terminal-ansiCyan); }
```

---

## VS Code APIs Used

| API | Purpose |
|---|---|
| `window.registerWebviewViewProvider` | Sidebar panel with tiles |
| `window.terminals` | Enumerate open terminals |
| `window.onDidOpenTerminal` | Track new terminals |
| `window.onDidCloseTerminal` | Remove closed terminals |
| `window.onDidChangeActiveTerminal` | Highlight active tile |
| `workspace.createFileSystemWatcher` | Watch `/tmp/claude-dashboard/*.json` with RelativePattern |
| `Terminal.show()` | Switch to terminal on tile click |
| `Terminal.name` | Match terminal to project name |

---

## Terminal-to-Project Matching

Since we control terminal naming (via devcontainer.json profiles), matching is trivial:
- Terminal `name` IS the project name (e.g., terminal named "life-planner" = project "life-planner")
- No process tree walking needed
- Edge case: user renames a terminal manually -- fall back to default theme color

---

## Theme Color Mapping

Static map derived from devcontainer.json profile colors:

| Theme | Color | Projects |
|---|---|---|
| Life & finance | cyan | life-planner, financial-planner, travel-planner, health-dash, mortgage-viz |
| Home & IoT | green | ha-tools, automated-martha-tek, garden-assist, 3d-printing |
| Knowledge & research | blue | obsidian-vault, git-publishing, research-workflows, prompt-master, media-recs |
| Web & design | magenta | web-design-pipeline, web-hosting, web-auto, strudel-noodle |
| Dev infrastructure | yellow | api, secrets-manager, container-backup, scripts, vscode-enhancement |
| Root | white | workspace |

Could be made dynamic later by reading devcontainer.json or a config file.

---

## Implementation Phases

### Phase 1: Scaffold + Static Tiles (MVP)
- Extension scaffold (package.json, tsconfig, esbuild)
- WebviewViewProvider with tiles from terminal lifecycle
- Terminal lifecycle tracking (open/close/focus)
- Click-to-switch functionality
- Activity bar icon
- Theme colors from static map
- **Test:** Open 3 terminals, see 3 tiles, click to switch

### Phase 2: Live Status via Hooks
- Write `dashboard-status.sh` hook script
- Register PreToolUse + UserPromptSubmit hooks in settings.json
- Enhance Stop/Notification hooks to also write dashboard JSON
- FileSystemWatcher reads `/tmp/claude-dashboard/*.json`
- Status dot rendering (working/waiting/done/idle)
- Relative time display ("2m ago", "just now")
- Auto-sort: waiting first, then by recency
- **Test:** Start Claude session, see status changes in real time

### Phase 3: Polish
- Animated status dots (pulse/blink CSS)
- Smooth tile add/remove transitions
- "No terminals open" empty state
- Done -> idle fade after 30s
- Keyboard navigation (up/down/enter to switch)

### Phase 4: Package + Deploy
- Package with vsce
- Add to devcontainer.json extensions list
- Persist across container rebuilds (either sideload or publish to marketplace)
- Update SETUP_BRIEF.md

---

## package.json (Extension Manifest)

```json
{
  "name": "claude-terminal-dashboard",
  "displayName": "Claude Terminal Dashboard",
  "description": "Sidebar dashboard with live status tiles for Claude Code terminal sessions",
  "version": "0.1.0",
  "publisher": "aes87",
  "engines": { "vscode": "^1.93.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "claude-dashboard",
        "title": "Claude Dashboard",
        "icon": "media/dashboard.svg"
      }]
    },
    "views": {
      "claude-dashboard": [{
        "type": "webview",
        "id": "claudeDashboard.mainView",
        "name": "Terminals"
      }]
    }
  },
  "scripts": {
    "build": "esbuild src/extension.ts --bundle --outfile=dist/extension.js --platform=node --external:vscode --format=cjs",
    "watch": "npm run build -- --watch",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.93.0",
    "esbuild": "^0.20.0",
    "typescript": "^5.4.0",
    "@vscode/vsce": "^2.24.0"
  }
}
```

---

## Risks / Open Questions

1. **FileSystemWatcher on `/tmp`**: Should work since `/tmp` is native container filesystem (not a bind mount). Verify early in Phase 2.

2. **Hook frequency**: PreToolUse fires before EVERY tool call. In a busy session this could mean dozens of writes/second. Mitigation: only write when status actually changes (track last-written status in the hook script).

3. **Multiple terminals per project**: If user opens two terminals for the same project, tiles would collide on name. Mitigation: append terminal index, or use terminal PID as key.

4. **Extension packaging**: This is a workspace extension (reads `/tmp` inside container). Must be installed in the container, not on the host. Sideloading via `.vsix` in the Dockerfile or `postCreateCommand` is the path.

5. **Webview state on sidebar collapse**: Use `retainContextWhenHidden: true` to keep tile state alive when user switches sidebar panels.
