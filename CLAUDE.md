# Claudelike Bar

VS Code sidebar extension that shows live status tiles for Claude Code terminal sessions.

## Setup

Run `./setup.sh` — it handles everything (hook script, settings.json merge, build, install). Idempotent and safe to re-run.

## Architecture

```
Claude Code hooks (14 events: PreToolUse, UserPromptSubmit, Stop, Notification, ...)
    → ~/.claude/hooks/dashboard-status.js  (Node.js, zero deps)
    → derives project slug: $CLAUDELIKE_BAR_NAME → path index → basename(cwd)
    → writes JSON to {os.tmpdir()}/claude-dashboard/{slug}.json
    → VS Code FileSystemWatcher picks it up
    → TerminalTracker matches project to tile (4-tier: exact slug / path / projectName alias / normalized)
    → sidebar tiles update
```

Tiles come from **VS Code terminal objects** (`vscode.window.terminals`), not from status files. Status files only update the status/context of already-tracked terminals. Terminals named `bash`, `zsh`, or `sh` are filtered out — use named terminal profiles or the terminal's rename feature.

### Source layout

```
src/
  extension.ts          — activation, wiring
  configManager.ts      — reads/writes .claudelike-bar.jsonc (JSONC format)
  terminalTracker.ts    — terminal lifecycle + status state machine
  statusWatcher.ts      — watches {os.tmpdir()}/claude-dashboard/*.json
  statusDir.ts          — cross-platform status dir resolution (used by hook + extension)
  dashboardProvider.ts  — webview sidebar
  wizard.ts             — setup wizard (5-step QuickPick flow)
  registerProject.ts    — single-project registration command
  slug.ts               — collision-resistant slug derivation
  claudePaths.ts        — cross-platform ~/.claude/ path helpers
  onboarding.ts         — first-run orchestration
  types.ts              — shared types, theme/icon maps
media/
  webview.js            — tile rendering (vanilla JS, DOM diffing)
  webview.css           — styles using VS Code CSS variables
  codicon.css/ttf       — icon font
  dashboard.svg         — activity bar icon
hooks/
  dashboard-status.js       — Node.js hook script (copied to ~/.claude/hooks/ by setup)
  dashboard-status.sh.legacy — retired bash hook, kept for reference
  settings-snippet.json     — hook config for manual merge
scripts/
  merge-hooks.js        — idempotent settings.json hook merger (ESM, no deps)
```

### Config file

`~/.claude/claudelike-bar.jsonc` — user-global, single file across all workspaces. JSONC (JSON with comments). Auto-created on first terminal open or via the setup wizard. Template-based write preserves section headers. Workspace-local files are auto-migrated on first load.

A companion path index (`~/.claude/claudelike-bar-paths.json`) maps `path → slug` for the hook script to resolve manual terminals without CLAUDELIKE_BAR_NAME.

Key settings:
- `mode`: `"chill"` or `"passive-aggressive"` — personality mode
- `labels`: custom status text
- `contextThresholds`: warn/crit percentages for context window
- `ignoredTexts`: passive-aggressive mode messages
- `terminals`: per-project `path`, `cwd`, `command`, `color`, `icon`, `nickname`, `autoStart`

### Build

```bash
npm install
npm run build      # esbuild → dist/extension.js
npm run package    # build + vsce → .vsix
```

**Critical: the `--main-fields=module,main` esbuild flag is required.** Without it, esbuild resolves `jsonc-parser` to its UMD build (`lib/umd/main.js`), which uses `require2("./impl/format")` — a variable alias for `require` that esbuild can't statically analyze. The internal sub-modules don't get bundled, and the extension crashes on activation with `Cannot find module './impl/format'`. The `--main-fields=module,main` flag forces esbuild to use the ESM build instead, which bundles correctly.

### Status state machine

```
idle → working (UserPromptSubmit/PreToolUse)
working → ready (Stop/Notification)
ready → waiting (60s timeout)
waiting/ready → ignored (user focused then switched away, passive-aggressive mode)
waiting/ready → done (user focused then switched away, chill mode)
* → working (UserPromptSubmit resets everything)
```

### Hook requirements

All 4 Claude Code hook events must be registered for full functionality:
- **PreToolUse** — transitions tiles to "working"
- **UserPromptSubmit** — resets tiles to "working" (universal reset)
- **Stop** — transitions tiles to "ready" (Claude finished)
- **Notification** — transitions tiles to "ready" (Claude needs input)

If Stop/Notification hooks are missing, tiles get stuck on "working" and never show the amber "ready for input" state. The `setup.sh` script and `scripts/merge-hooks.js` handle all 4 events. If hooks were added manually before the script existed, re-run `./setup.sh` or `node scripts/merge-hooks.js` to fill in any missing events.

### Container rebuild / devcontainer notes

The extension is installed via `postStartCommand` in `.devcontainer/devcontainer.json`:
```
code --install-extension .../claudelike-bar-X.Y.Z.vsix --force
```

After a container rebuild:
- The VSIX gets reinstalled automatically (from the workspace-mounted file)
- `~/.claude/settings.json` lives on a Docker volume — hooks persist across rebuilds
- `~/.claude/hooks/dashboard-status.js` also lives on the volume — persists
- `.claudelike-bar.jsonc` is in the workspace root — persists

If the bar breaks after a rebuild, check activation errors first (see Verify section).

## Verify installation

```bash
# Extension activated without errors?
# Look for "harteWired.claudelike-bar" — should say "activated" not "failed"
grep -A2 "claudelike-bar" ~/.vscode-server/data/logs/*/exthost*/remoteexthost.log

# Hooks registered for all 4 events?
grep dashboard-status ~/.claude/settings.json

# Hook script in place?
ls -la ~/.claude/hooks/dashboard-status.js

# Status files being written? (cross-platform temp dir)
ls "$(node -e 'console.log(require(\"os\").tmpdir())')/claude-dashboard/"
```

If the extension host log shows `Cannot find module './impl/format'`, rebuild with `npm run build && npm run package` and reinstall — the `--main-fields` flag fixes it.
