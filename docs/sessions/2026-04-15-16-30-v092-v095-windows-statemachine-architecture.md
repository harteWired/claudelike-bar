---
date: 2026-04-15
project: vscode-enhancement
type: session-log
---

# 2026-04-15 — v0.9.2–v0.9.5: Windows Parity, State Machine, Architecture

## Quick Reference
**Keywords:** claudelike-bar, vscode-extension, windows, powershell, state-machine, permission-prompt, PostToolUse, cwd, auto-start, statusline, backup, restore, gmail-intake, color-taxonomy, project-identity, architecture-plan, open-vsx
**Project:** vscode-enhancement (claude-terminal-dashboard)
**Outcome:** Shipped v0.9.2 through v0.9.5 — fixed Windows auto-start, rewrote state machine for permission/subagent flows, added cwd-based cross-platform terminal launch with auto-migration, designed v0.10/v0.11 architecture for project identity. Filed 7 GitHub issues. Published all versions to Open VSX.

## What Was Done

### v0.9.2 — Windows parity + statusline backup/restore
- Gmail intake: 4 threads from Matt Harte (v0.7.6 field report mostly already fixed; v0.9.1 Windows report with 5 live bugs + audio feature request)
- Fixed auto-start for Windows: replaced `sendText('export CLAUDELIKE_BAR_NAME=...')` with `createTerminal({env})` — cross-platform, no shell syntax
- Added per-terminal `shellPath`/`shellArgs` config for pinning git-bash on Windows
- Statusline as explicit opt-in: install modal previews BOTH current and incoming commands, prior statusline backed up to `~/.claude/.claudelike-bar-statusline-backup.json` with self-describing format
- New `Restore Previous Statusline` palette command with single-read TOCTOU-free flow
- Backup uses O_EXCL atomic writes, validates `backed_up_by` stamp, rejects non-string commands
- Hook statusline gains opt-in debug.log output
- Deleted `src/util.ts` (shSingleQuote) — no longer needed
- 3 review passes (4-agent multi-model): 3 warnings + 1 suggestion in pass 1; 3 more in pass 2 (truncation bypass, non-string command evasion, TOCTOU); all fixed; pass 3 clean

### v0.9.3 — State machine deep-dive + 6 fixes
- Deep-dive mapped every hook sequence across single/multi-agent, permission, tool-failure, compaction, session lifecycle
- Found 6 holes: H1 (permission-approved tile stuck on ready), H2 (stale "Needs permission" label), H3 (approve-and-switch-back marks tile ignored), H4 (Claude crash leaves tile stuck working), H5 (subagent permission invisible), H6 (teammate_idle no recovery)
- F1: Registered PostToolUse → new `tool_end` signal, promotes ready/error/ignored → working
- F2: Gate notification_type/error_type on originating event + hook always writes optional fields (clobbers stale)
- F3: Ready-to-ready label refresh + timer restart on Notification
- F4: Focus-loss narrowed to status === 'waiting' only
- F5: SessionStart(startup|clear) resets any non-done state
- F6: `subagentPermissionPending` flag with configurable label key `subagent_permission`, gated on pendingSubagents > 0
- Centralized `workingLabel(tile)` helper for consistent label cascade
- 3 review passes: pass 1 found 6 issues, pass 2 caught PreToolUse not clearing flag, pass 3 clean

### v0.9.4 + v0.9.5 — Cross-platform cwd + auto-migration
- Added `cwd` as first-class config field, passed through VS Code's `createTerminal({cwd})` API
- Replaces the shell-specific `cd '/path' && claude` pattern that broke on PowerShell 5.1
- Auto-migration on load: parses `cd <path> && <rest>` and `cd <path> ; <rest>` patterns, extracts path to `cwd`, rewrites command to just the rest
- v0.9.5 bump because v0.9.4 was published to Open VSX before migration code was added

### Other work
- Color taxonomy applied: Green=Finance, Blue=People, Yellow=Ops&PM, White=Infrastructure, Magenta=Research
- Filed 7 GitHub issues: custom colors (#1), context-menu auto-sort (#2), audio alerts (#3), pinned terminals (#4), push notifications (#5), project identity bug (#6), registry/display split (#7)
- Created `docs/backlog.md` tracking feature requests
- Designed project identity architecture plan with 3 options (A: path-keyed, B: user-global config, C: registry split). Recommended Option B for v0.11, Option A incrementals for v0.10.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| `createTerminal({env})` over `sendText('export ...')` | Cross-platform: no shell syntax for env vars. The entire shSingleQuote defense was shell-dependent |
| `cwd` as separate config field | Decouples directory from command — `claude` works on every shell without `cd && ` prefix |
| Auto-migrate `cd && claude` commands | Patch issue, not new-user issue. Upgrading users shouldn't hand-edit 15 terminals |
| `subagentPermissionPending` flag over string-concat label | Survives refreshFromConfig, configurable via labels dict, clears correctly across all transitions |
| Focus-loss only on `waiting`, not `ready` | Approve-permission-and-switch-back is legitimate; penalizing it was a false positive |
| Statusline restore: single-read + full command preview (no truncation) | Prevents truncation-based RCE bypass; eliminates TOCTOU between preview and write |
| O_EXCL for backup file creation | Eliminates TOCTOU race in backup filename selection (existsSync + rename was advisory) |
| Hook always writes optional fields (empty string clobbers) | Prevents notification_type/error_type leaking across events via Object.assign read-merge-write |
| Option B (user-global config) for v0.11 | One file at ~/.claude/, works regardless of workspace layout. Option A is incremental fix, Option C is over-engineered |
| Version 0.10/0.11 not 1.0 | Pre-1.0 versioning until user explicitly says otherwise |

## Files Modified
- `src/extension.ts`: rewrote runAutoStart (env, cwd, shellPath); registered restoreStatusline command
- `src/configManager.ts`: added TerminalConfig fields (cwd, shellPath, shellArgs); AutoStartTerminalOptions; getAutoStartTerminalOptions; migrateCdCommands; subagent_permission label
- `src/terminalTracker.ts`: F1-F6 state machine fixes; workingLabel helper; tool_end handler; subagentPermissionPending flag lifecycle
- `src/types.ts`: added tool_end to HookStatusSignal; subagentPermissionPending to TileData
- `src/statusline.ts`: backup/restore with O_EXCL, loadValidatedBackup, prepareStatuslineRestore, executeStatuslineRestoreCommand
- `src/claudePaths.ts`: extracted readExtensionVersion
- `src/onboarding.ts`: uses shared readExtensionVersion
- `src/setup.ts`: registered PostToolUse hook event (14 events total)
- `hooks/dashboard-status.js`: PostToolUse → tool_end signal; always-write optional fields
- `hooks/claudelike-statusline.js`: debugLog function, error-path logging
- `src/util.ts` + `test/util.test.ts`: deleted (shSingleQuote no longer used)
- `test/scenarios.test.ts`: new — 26 scenario-based state machine tests
- `test/configManager.test.ts`: new — cwd/shellPath/migration tests
- `test/runAutoStart.test.ts`: new — createTerminal contract tests
- `test/statusline.test.ts`: backup/restore + security hardening tests
- `test/setup.test.ts`: updated for 14 hook events
- `README.md`: Windows/PowerShell docs, cwd pattern, statusline backup/restore, troubleshooting
- `index.html`: demo page bumped to v0.9, two new feature cards
- `package.json`: v0.9.2 → v0.9.5, restoreStatusline command
- `docs/v0.9.2-plan.md`, `docs/backlog.md`, `docs/project-identity-plan.md`: new planning docs
