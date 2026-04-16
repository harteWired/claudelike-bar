# Claudelike Bar — Feature Backlog

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

### Extended hook events
**From:** v0.7.6 field report + v0.9.0/v0.9.1 partial implementation

Leverage more of Claude Code's 27 hook event types. Partially done (v0.9.0 added multi-agent + error matchers, v0.9.1 added compaction + lifecycle, v0.9.3 added PostToolUse). Remaining opportunities: TaskCreated/TaskCompleted (show task progress count on tile).

## Deferred Design Work

### Crash watchdog
Tile stuck on `working` with no events for >N minutes → "stalled" label. Needs careful threshold or user-configurable setting. Identified in v0.9.3 deep-dive (H3) but not implemented — SessionStart(startup) now resets on restart, which covers the common case. Watchdog would cover "Claude hung but didn't crash" edge case.

### teammate_idle timeout
If a teammate never responds after TeammateIdle, tile sits on "Working (teammate idle)" forever. Only `UserPromptSubmit` recovers it. Low-impact but worth a timeout or a "force reset" context menu option.
