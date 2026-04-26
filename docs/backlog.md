# Claudelike Bar — Feature Backlog

## Bugs

### Tile stuck on "Working (N agents)" after subagents finish
**Reported:** 2026-04-19 (Matt) — observed on `web-design-pipeline` tile

The tile reported `Working (12 agents)` long after the parent turn ended. The on-disk status file (`/tmp/claude-dashboard/web-design-pipeline.json`) read `"status":"ready","event":"Notification","notification_type":"idle_prompt"` at the same moment the bar still showed twelve agents working. Only `UserPromptSubmit` recovers — the user has to send a new prompt to reset the counter.

**Root cause (likely):** `pendingSubagents` drifts when `SubagentStop` events go missing (parent process killed mid-task, hook script failure, dropped event). Once the counter is non-zero, the `status === 'ready'` branch in `terminalTracker.ts:494` enters `hasActiveWork === true` and *suppresses* the Stop transition (`terminalTracker.ts:511–528`). The only event that resets `pendingSubagents` to 0 is `UserPromptSubmit` (`terminalTracker.ts:407–421`). A `Stop` arriving with stale counter is silently dropped (logged via `this.log(... "suppressed ready ...")` but not surfaced).

**Debug log evidence** (from `/tmp/claude-dashboard/debug.log`, scoped to `web-design-pipeline` after the most recent `UserPromptSubmit` reset at 18:29:58Z):

```
18:29:58 UserPromptSubmit          → counter=0
18:35:25 SubagentStart             → 1
18:35:34 SubagentStart             → 2
18:35:46 SubagentStart             → 3
18:35:58 SubagentStop              → 2
18:36:01 SubagentStart             → 3
18:36:42 SubagentStop              → 2
18:36:47 SubagentStop              → 1
18:37:09 SubagentStop              → 0
18:38:09 SubagentStart             → 1
18:38:24 SubagentStop              → 0
18:42:04 Stop          status=ready
18:43:04 Notification  status=ready, notif=idle_prompt
```

Counter math from this window alone is balanced (5 Start / 6 Stop → floors at 0), but the bar UI showed `12 agents`, so the in-memory counter held drift from earlier in the session that the visible debug.log no longer covers (log rotated / earlier process). The status JSON file says `ready` but the bar disagrees — definitive evidence of in-memory state drift the file-based recovery can't fix.

**Fix options:**
1. **Trust the on-disk status file** — when `Stop`/`Notification` arrives with `status: ready`, force-reset `pendingSubagents = 0` instead of suppressing. The file is the authoritative end-of-turn signal; if subagent tracking has drifted, prefer the parent's truth over a counter we can't verify.
2. **Watchdog on stale subagent count** — if `pendingSubagents > 0` and no `SubagentStart`/`SubagentStop` in N minutes, decay to 0 and re-emit the suppressed Stop. (Overlaps with the existing "Crash watchdog" deferred item below.)
3. **Context-menu "Force reset"** — a manual escape hatch on the tile (also addresses the existing `teammate_idle` deferred item).

**Recommended:** option 1 — it's the simplest and matches the principle that a parent `Stop` is a stronger signal than a possibly-stale child counter. Option 3 is worth adding regardless as a general escape hatch.

## Feature Requests

### Context menu: "Switch to auto sort"
**Requested:** 2026-04-16 (Matt)

Right-click a tile (or the sidebar header) should offer a "Switch to auto sort" option so users can escape manual sort mode without editing `.claudelike-bar.jsonc`. Currently dragging flips `sortMode` to `"manual"` automatically, but there's no UI path back to `"auto"` — only a config file edit.

**Scope:** add a context menu item (webview right-click) that calls `configManager.setSortMode('auto')`. Could also add "Switch to manual sort" for symmetry, but the real UX gap is auto → manual has a gesture (drag) and manual → auto doesn't.

### Custom color codes (beyond ANSI palette)
**Requested:** 2026-04-16 (Matt)

Keep the 7 ANSI presets (`cyan`, `green`, `blue`, `magenta`, `yellow`, `white`, `red`) as named shortcuts, but also accept arbitrary CSS color values (`#hex`, `rgb()`, `hsl()`) in the `color` field so users can match their VS Code theme exactly. The current `COLOR_OVERRIDE_CSS` map in `types.ts` and `getThemeColor()` would need a fallback path: if the value isn't a known preset name, treat it as a raw CSS color string. Validation: reject obviously malformed values to avoid breaking the webview.

### Audio alerts on state changes
**Requested:** 2026-04-15 (Matt, via Gmail)

Configurable audio cues per state transition — primarily `ready` and `waiting`. When running 10-15 concurrent terminals, visual indicators alone aren't enough. Design considerations: per-state granularity, debounce/batching when multiple tiles transition together, custom sound files, personality-mode integration (passive-aggressive escalation for `ignored`), VS Code accessibility sound APIs. See `docs/v0.9.2-plan.md` → Deferred → Section A for full spec notes.

### In-extension "Diagnose" command
**From:** v0.7.6 field report (2026-04-13)

Palette command that checks: hooks registration, status dir exists, status files have valid schemas (non-empty `event` field), terminal names match status file project names. Surfaces actionable warnings. Replaces the manual "verify installation" checklist in CLAUDE.md.

### Unified Telegram driver across multiple terminals
**Requested:** 2026-04-26 (Matt, via Telegram)

**Scope flag (from the requester):** may or may not fit within claudelike-bar's scope — flagging up front so a triage decision can land before any design work.

Surface actions needed from multiple active Claude Code terminals into a unified Telegram integration so the user can drive several terminals from their phone. Each Telegram message must carry enough context for the user to respond *without remembering* what that particular terminal was doing — context comes in the message, not from session memory.

Per-message context (every nudge from a terminal must include):

1. **Last action given to the terminal** — the most recent prompt or instruction the user sent.
2. **What the terminal has responded with** — the latest output, question, or blocker the agent is paused on.
3. **The overall effort the terminal is working on** — project name plus a one-line goal so the user can re-orient quickly.

Hard constraint: readable on a mobile Telegram client. Short lines, minimal nesting, no ASCII art, no wide tables. Optimize density before completeness — the user should be able to triage at a glance and reply with a one-liner.

Open scope questions for triage:

1. Does claudelike-bar already track all three context bits? Last action and effort yes (via `UserPromptSubmit` + project name / configured goal). The response side may need a new hook tap — `Notification` body text or the last assistant message at `Stop`.
2. Is the Telegram fanout claudelike-bar's responsibility, or does it belong in a separate project (e.g. the existing `telegram-channel` project) that consumes the same `/tmp/claude-dashboard/{slug}.json` files? If the latter, claudelike-bar's job is just to expose richer per-terminal state; the relay lives elsewhere.
3. What triggers a Telegram nudge? Every `Notification` `idle_prompt`? Only when the user is away from VS Code (idle detection)? Per-tile opt-in via `.claudelike-bar.jsonc`?

### Extended hook events
**From:** v0.7.6 field report + v0.9.0/v0.9.1 partial implementation

Leverage more of Claude Code's 27 hook event types. Partially done (v0.9.0 added multi-agent + error matchers, v0.9.1 added compaction + lifecycle, v0.9.3 added PostToolUse). Remaining opportunities: TaskCreated/TaskCompleted (show task progress count on tile).

## Deferred Design Work

### Crash watchdog
Tile stuck on `working` with no events for >N minutes → "stalled" label. Needs careful threshold or user-configurable setting. Identified in v0.9.3 deep-dive (H3) but not implemented — SessionStart(startup) now resets on restart, which covers the common case. Watchdog would cover "Claude hung but didn't crash" edge case.

### teammate_idle timeout
If a teammate never responds after TeammateIdle, tile sits on "Working (teammate idle)" forever. Only `UserPromptSubmit` recovers it. Low-impact but worth a timeout or a "force reset" context menu option.
