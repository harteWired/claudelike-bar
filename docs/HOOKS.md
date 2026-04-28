# How Claudelike Bar Uses Claude Code Hooks

Everything the extension writes outside your workspace, shown in full. If you don't trust it, don't install it — but read this first so you know what you're looking at.

## What the extension installs

Two things, both under `~/.claude/`:

1. **A hook script** at `~/.claude/hooks/dashboard-status.js` (Node.js, ~140 lines, zero dependencies)
2. **Thirteen hook registrations** added to `~/.claude/settings.json` so Claude Code invokes the script on state-relevant events

That's it. No daemon, no background process, no network activity.

## Why hooks?

Claude Code fires [hook events](https://code.claude.com/docs/en/hooks) at specific moments in its lifecycle. The extension needs to know when Claude is working, waiting, erroring, or coordinating with a subagent/teammate. As of v0.9.1 it registers for these thirteen:

| Event | When it fires | Status signal |
|-------|---------------|----------------------|
| `PreToolUse` | Before Claude runs any tool (file edit, bash command, etc.) | `working` |
| `UserPromptSubmit` | When you submit a prompt | `working` (universal reset) |
| `Stop` | When Claude finishes its turn | `ready` (or held if subagent/teammate in flight) |
| `Notification` | When Claude needs input (permission, clarification, MCP) | `ready` with refined label by matcher |
| `StopFailure` | API error (rate limit, auth, billing, server) | `error` — sticky, cleared on retry |
| `SubagentStart` | A Task-tool subagent was spawned | increments pending-subagent counter |
| `SubagentStop` | A Task-tool subagent finished | decrements pending-subagent counter |
| `TeammateIdle` | An Agent Teams teammate is waiting on a peer | sets teammate-idle flag |
| `SessionStart` | A Claude session begins or resumes | restores an `offline` tile to `idle` |
| `SessionEnd` | A Claude session terminates (logout/exit/etc.) | transitions to `offline` — dimmed tile |
| `PostToolUseFailure` | A tool execution fails | transient `tool_error` flag, cleared on next success |
| `PreCompact` | Context compaction is starting | overrides label to "Compacting context…" |
| `PostCompact` | Context compaction finished | clears the compacting override |

Each event triggers `dashboard-status.js`, which writes a small JSON file that the sidebar watches. The extension's state machine interprets the raw signal — for example, a `Stop` event is suppressed when the pending-subagent counter is non-zero, so the tile doesn't falsely transition to "ready" while a Task subagent is still running.

## The hook script (in full)

Located at `~/.claude/hooks/dashboard-status.js`. This is the entire file — nothing hidden:

See [`hooks/dashboard-status.js`](https://github.com/harteWired/claudelike-bar/blob/main/hooks/dashboard-status.js) on GitHub for the current source — it's the same file the extension ships. The script is ~130 lines, zero dependencies, Node.js built-ins only.

**What it does:**
- Reads the Claude Code hook JSON payload from stdin
- Extracts `hook_event_name`, `cwd`, and (when present) `tool_name`, `agent_type`, `error_type`, `notification_type`
- Maps the event to a raw status signal (`working`, `ready`, `error`, `subagent_start`, `subagent_stop`, or `teammate_idle`)
- Derives the project name from `$CLAUDELIKE_BAR_NAME` env var or `basename(cwd)`
- Sanitizes the project name (strips POSIX path separators and Windows-reserved chars)
- Read-merge-writes the status file so the statusline's `context_percent` survives
- Writes atomically via `rename` — no partial-JSON reads by the extension's watcher
- Never throws — a failing hook must never fail Claude's execution
- Optional debug trace log when `<STATUS_DIR>/.debug` file is present

## The status file

Example contents (`~/Library/Caches/.../claude-dashboard/my-project.json` on macOS, `/tmp/claude-dashboard/my-project.json` on Linux, `%TEMP%\claude-dashboard\my-project.json` on Windows):

```json
{
  "project": "my-project",
  "status": "working",
  "timestamp": 1776125339,
  "event": "PreToolUse",
  "tool_name": "Bash",              // optional, from PreToolUse/PostToolUse
  "agent_type": "Explore",          // optional, from SubagentStart/SubagentStop
  "error_type": "rate_limit",       // optional, from StopFailure matchers
  "notification_type": "permission_prompt", // optional, from Notification matchers
  "source": "startup",              // optional, from SessionStart matchers (v0.9.1)
  "reason": "logout",               // optional, from SessionEnd matchers (v0.9.1)
  "compaction_trigger": "auto",     // optional, from PreCompact/PostCompact (v0.9.1)
  "context_percent": 42             // optional, written by the statusline (not the hook)
}
```

Only `project`, `status`, `timestamp`, and `event` are always present. The rest are written opportunistically based on what the specific hook event carried. No session content, no prompt text, no tool inputs — just the state machine input for the sidebar.

## The settings.json entries

Added to `~/.claude/settings.json` under the `hooks` key. One entry per registered event (13 as of v0.9.1):

```json
{
  "hooks": {
    "PreToolUse":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "UserPromptSubmit":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Stop":               [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Notification":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "StopFailure":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "SubagentStart":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "SubagentStop":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "TeammateIdle":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "SessionStart":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "SessionEnd":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "PostToolUseFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "PreCompact":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "PostCompact":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }]
  }
}
```

On Windows, the command is prefixed with `node` — `node "C:/Users/you/.claude/hooks/dashboard-status.js"` — so it works regardless of shebang interpretation.

The extension's merge logic is idempotent: if you re-run the setup command, it detects existing entries and does nothing. It also handles upgrades — if you had the older `.sh` hook registered, it rewrites those references to `.js` and deduplicates.

## What does NOT get collected

- No telemetry, no phone-home, no analytics
- No network requests — the hook writes a local file, the extension reads it
- No prompt text, session content, tool inputs, or file contents
- No user identity, no credentials, nothing from `~/.claude/auth`

The extension uses VS Code's standard file-watcher API to detect when a status file changes, reads the JSON, and updates a tile in the sidebar. That's the entire data flow.

## Removing it

Uninstall the extension from VS Code, then:

```bash
rm ~/.claude/hooks/dashboard-status.js
```

Remove all dashboard-status entries from `~/.claude/settings.json` manually (or via the "Claudelike Bar: Uninstall Hooks" command if we ship one in a future version).

## Statusline (optional)

**What it is:** a separate, optional script that feeds **context window usage** (`ctx %` on each tile) into the sidebar. Hook events don't carry context info, so without a statusline you won't see the `ctx %` badge.

**Is it required?** No. Without it, everything else works — tiles transition between working/ready/waiting correctly. You just don't see a context % number.

**What it installs:** one file and one settings entry.

### The statusline script (in full)

Located at `~/.claude/hooks/claudelike-statusline.js` after install:

```javascript
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function sanitizeProject(name) {
  return (name || '')
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
}

function main() {
  const statusDir = process.env.CLAUDELIKE_STATUS_DIR
    || path.join(os.tmpdir(), 'claude-dashboard');
  fs.mkdirSync(statusDir, { recursive: true });

  let input = '';
  try {
    if (!process.stdin.isTTY) input = fs.readFileSync(0, 'utf8');
  } catch {}

  let data = {};
  if (input) { try { data = JSON.parse(input); } catch {} }

  const model = data.model?.display_name || '';
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();
  const ctxRaw = data.context_window?.used_percentage || 0;
  const ctxPct = Math.max(0, Math.min(100, Math.floor(ctxRaw)));
  const project = sanitizeProject(process.env.CLAUDELIKE_BAR_NAME || path.basename(cwd)) || 'unknown';

  // Merge context_percent into existing status file (preserves hook state).
  const statusFile = path.join(statusDir, `${project}.json`);
  let payload = { project, timestamp: Math.floor(Date.now() / 1000) };
  try {
    const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    payload = Object.assign({}, existing, payload);
  } catch {}
  payload.context_percent = ctxPct;

  const tmpPath = `${statusFile}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n');
    fs.renameSync(tmpPath, statusFile);
  } catch { try { fs.unlinkSync(tmpPath); } catch {} }

  // Minimal status line display.
  const parts = [];
  if (model) parts.push(model);
  if (project && project !== 'unknown') parts.push(project);
  parts.push(`ctx ${ctxPct}%`);
  process.stdout.write(parts.join(' │ '));
}

try { main(); } catch {}
process.exit(0);
```

### The settings entry

Added to `~/.claude/settings.json` under the top-level `statusLine` key:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/claudelike-statusline.js",
    "padding": 0
  }
}
```

### If you already have a statusline

The extension **will not overwrite it.** Claude Code only supports one `statusLine.command`, and yours takes precedence. Two options:

1. **Keep your statusline, feed context % yourself.** Add these lines to your existing script — it's just a merge of `context_percent` into the per-project status file:
   ```bash
   DIR=$(basename "$(echo "$input" | jq -r '.workspace.current_dir // "?"')")
   PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
   FILE="/tmp/claude-dashboard/${DIR}.json"
   mkdir -p /tmp/claude-dashboard
   if [ -f "$FILE" ]; then
     jq -c --argjson cp "$PCT" '.context_percent = $cp' "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
   else
     echo "{\"project\":\"$DIR\",\"timestamp\":$(date +%s),\"context_percent\":$PCT}" > "$FILE"
   fi
   ```
   Adjust the path for your OS — Linux uses `/tmp`, macOS uses `$TMPDIR`, Windows uses `%TEMP%`.

2. **Switch to Claudelike Bar's statusline.** Run `Claudelike Bar: Install Statusline` from the command palette. It'll prompt before replacing your existing one.

### Separation of concerns

The hook script and the statusline script are **completely independent modules** at the code level. Neither imports the other. They share only the status file format — a documented, stable interface:

```json
{ "project": "...", "status": "...", "timestamp": 1234, "event": "...", "context_percent": 42 }
```

Either component can run without the other. Hooks without statusline: state transitions work, no context %. Statusline without hooks: context % works, but no state (tiles stay idle). Most users want both.

## Source

Everything here is generated from the actual source files:

- Hook script: [`hooks/dashboard-status.js`](https://github.com/harteWired/claudelike-bar/blob/main/hooks/dashboard-status.js)
- Statusline script: [`hooks/claudelike-statusline.js`](https://github.com/harteWired/claudelike-bar/blob/main/hooks/claudelike-statusline.js)
- Hook install: [`src/setup.ts`](https://github.com/harteWired/claudelike-bar/blob/main/src/setup.ts)
- Statusline install: [`src/statusline.ts`](https://github.com/harteWired/claudelike-bar/blob/main/src/statusline.ts)

If anything here diverges from the source, the source wins — file an issue.
