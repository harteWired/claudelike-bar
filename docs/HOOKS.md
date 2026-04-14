# How Claudelike Bar Uses Claude Code Hooks

Everything the extension writes outside your workspace, shown in full. If you don't trust it, don't install it — but read this first so you know what you're looking at.

## What the extension installs

Two things, both under `~/.claude/`:

1. **A hook script** at `~/.claude/hooks/dashboard-status.js` (Node.js, ~100 lines, zero dependencies)
2. **Four hook registrations** added to `~/.claude/settings.json` so Claude Code invokes the script on events

That's it. No daemon, no background process, no network activity.

## Why hooks?

Claude Code fires [hook events](https://docs.anthropic.com/en/docs/claude-code/hooks) at specific moments in its lifecycle. The extension needs to know when Claude is working vs waiting for input, so it registers for these four:

| Event | When it fires | What the hook writes |
|-------|---------------|----------------------|
| `PreToolUse` | Before Claude runs any tool (file edit, bash command, etc.) | `status: "working"` |
| `UserPromptSubmit` | When you submit a prompt | `status: "working"` |
| `Stop` | When Claude finishes its turn | `status: "ready"` |
| `Notification` | When Claude needs input (permission, clarification) | `status: "ready"` |

Each event triggers `dashboard-status.js`, which writes a small JSON file that the sidebar watches.

## The hook script (in full)

Located at `~/.claude/hooks/dashboard-status.js`. This is the entire file — nothing hidden:

```javascript
#!/usr/bin/env node
/**
 * Claudelike Bar — Claude Code hook script (Node.js).
 *
 * Reads the hook payload from stdin (JSON), derives the project name, and
 * writes a status file that the VS Code extension watches.
 *
 * Handles all 4 hook events: PreToolUse, UserPromptSubmit, Stop, Notification.
 *   Stop/Notification → "ready"
 *   PreToolUse/UserPromptSubmit → "working"
 *
 * Zero npm dependencies — uses only Node.js built-ins.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function main() {
  const statusDir = process.env.CLAUDELIKE_STATUS_DIR
    || path.join(os.tmpdir(), 'claude-dashboard');

  fs.mkdirSync(statusDir, { recursive: true });

  // Read stdin — Claude Code pipes JSON. If stdin is a TTY, skip parsing.
  let input = '';
  try {
    if (!process.stdin.isTTY) {
      input = fs.readFileSync(0, 'utf8');
    }
  } catch {
    // No stdin available — proceed with empty input, will fall back.
  }

  let event = '';
  let cwd = '';
  if (input) {
    try {
      const parsed = JSON.parse(input);
      event = typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '';
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
    } catch {
      // Malformed JSON — leave event/cwd empty, fall back below.
    }
  }

  if (!cwd) cwd = process.cwd();

  // Derive project name
  let project = process.env.CLAUDELIKE_BAR_NAME || '';
  if (!project) {
    project = path.basename(cwd);
  }

  // Sanitize project name — strip anything that could break the filename.
  project = project
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) project = 'unknown';

  const status = (event === 'Stop' || event === 'Notification') ? 'ready' : 'working';
  const timestamp = Math.floor(Date.now() / 1000);

  const payload = { project, status, timestamp, event };
  const outPath = path.join(statusDir, `${project}.json`);
  const tmpPath = `${outPath}.tmp.${process.pid}`;

  // Atomic write via rename — prevents partial-JSON reads by the watcher.
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n');
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

try {
  main();
} catch {
  // Any uncaught error is swallowed — the hook must never fail Claude's execution.
}

process.exit(0);
```

**Reading this:**
- Reads JSON from stdin (Claude Code pipes the hook payload in)
- Writes a small file like `{os.tmpdir()}/claude-dashboard/my-project.json`
- Uses atomic write (rename from temp file) to avoid partial reads
- Never throws — a failing hook must never fail Claude

## The status file

Example contents (`~/Library/Caches/.../claude-dashboard/my-project.json` on macOS, `/tmp/claude-dashboard/my-project.json` on Linux, `%TEMP%\claude-dashboard\my-project.json` on Windows):

```json
{
  "project": "my-project",
  "status": "working",
  "timestamp": 1776125339,
  "event": "PreToolUse"
}
```

Four fields. No session content, no prompt text, no tool inputs — just the state machine input for the sidebar.

## The settings.json entries

Added to `~/.claude/settings.json` under the `hooks` key. Four entries, one per event:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }
        ]
      }
    ]
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

The extension uses VS Code's standard file-watcher API to detect when a status file changes, reads the 4-field JSON, and updates a tile in the sidebar. That's the entire data flow.

## Removing it

Uninstall the extension from VS Code, then:

```bash
rm ~/.claude/hooks/dashboard-status.js
```

Remove the 4 dashboard-status entries from `~/.claude/settings.json` manually (or via the "Claudelike Bar: Uninstall Hooks" command if we ship one in a future version).

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

- Hook script: [`hooks/dashboard-status.js`](https://github.com/aes87/claudelike-bar/blob/main/hooks/dashboard-status.js)
- Statusline script: [`hooks/claudelike-statusline.js`](https://github.com/aes87/claudelike-bar/blob/main/hooks/claudelike-statusline.js)
- Hook install: [`src/setup.ts`](https://github.com/aes87/claudelike-bar/blob/main/src/setup.ts)
- Statusline install: [`src/statusline.ts`](https://github.com/aes87/claudelike-bar/blob/main/src/statusline.ts)

If anything here diverges from the source, the source wins — file an issue.
