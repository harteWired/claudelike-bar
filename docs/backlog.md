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

### User-configurable focus hotkeys per tile
**Requested:** 2026-05-09 (Matt)

The `claudeDashboard.focusByName` and `claudeDashboard.focusSlot1..9` commands already exist (#18, shipped v0.16.5) and work — but binding them requires hand-editing `~/.config/Code/User/keybindings.json`, which most users won't do. Want a discoverable path: per-tile hotkey assignment from the config file or a right-click "Set hotkey…" action, plus default bindings out of the box for the slot variants.

**Scope.**

What already exists:
- `claudeDashboard.focusSlot1..9` — focuses the Nth live tile in current sort order (`extension.ts:196–222`)
- `claudeDashboard.focusByName` — focuses a tile by displayName / name / projectName, takes a string `args` value (`extension.ts:224–250`)
- Both commands resolve the underlying `vscode.Terminal` via `tracker.getTerminalById` and call `term.show()`. No UI surface.

What's needed:

1. **Default keybindings for the slot commands.** Ship a `contributes.keybindings` block in `package.json` that binds `Ctrl+Alt+1..9` (Linux/Windows) / `Cmd+Alt+1..9` (macOS) to `focusSlot1..9`. These combos are mostly free — VS Code uses `Ctrl+1..9` for editor groups and `Ctrl+\`+1..9` for terminal switching, but `Ctrl+Alt+1..9` is unclaimed in default bindings as of 1.93. Users can override in their own keybindings.json if they conflict with another extension.
2. **Per-tile hotkey config field.** Add an optional `hotkey: string` field to `TerminalConfig` (e.g. `"hotkey": "ctrl+alt+a"`). On config load, dynamically register a keybinding via `vscode.commands.executeCommand` + the `setContext` pattern, OR (simpler) maintain a generated keybindings.json snippet the user can copy. Discoverability beats elegance — even a "Copy hotkey JSON" action in the right-click menu is a win.
3. **Right-click "Set hotkey…" action.** InputBox prompts for a key combo, validates against a small allowlist of safe modifier patterns (see below), writes to the tile's `hotkey` field. Activation reads all `hotkey` fields and registers them. On conflict (same hotkey on two tiles, or hotkey claimed by VS Code), surface a warning toast pointing the user to keybindings.json.
4. **F-key option.** Plain `F1..F12` in VS Code are mostly reserved (F1=palette, F2=rename, F5=debug, F8=problems, etc.). Modifier+F-key is much safer: `Ctrl+F1..F12`, `Alt+F1..F12`, `Ctrl+Shift+F1..F12` are largely free. Document these as the recommended option for users with >9 tiles or who want non-numeric mnemonic mappings (e.g. F1=api, F2=belfry).

**Modifier collision map** (VS Code 1.93 defaults):

| Combo | Status |
|---|---|
| `Ctrl+1..9` | TAKEN — switch editor group |
| `` Ctrl+`+1..9 `` | TAKEN — switch active terminal |
| `Ctrl+Alt+1..9` | FREE on Linux/Win; some Mac debug bindings — recommended default |
| `Ctrl+Shift+1..9` | mostly FREE |
| `Alt+1..9` | FREE on Linux/Win; menu mnemonics on some platforms |
| `F1..F12` (plain) | mostly TAKEN |
| `Ctrl+F1..F12` | mostly FREE |
| `Alt+F1..F12` | mostly FREE |
| `Ctrl+Shift+F1..F12` | mostly FREE |

**What's *not* in scope:**
- Cross-window hotkey routing — focus stays within the current VS Code window. Multi-window users are on their own.
- Chord shortcuts (e.g. `Ctrl+K Ctrl+1`) — interesting later but the per-tile UX gets harder to validate.
- Hotkey for non-focus actions (kill, mark-done, etc.) — keep this scoped to the focus use case.

**Effort estimate:** 30–60 minutes for v1.
- Default `Ctrl+Alt+1..9` keybindings block in package.json: ~5 min
- Per-tile `hotkey` field + dynamic registration on activation: ~20 min
- "Set hotkey…" right-click action with validation: ~20 min
- Docs + collision-map note in README: ~10 min

Risk areas:
- Dynamic keybinding registration in VS Code: there's no first-class API for this. Workarounds include shipping `when` clauses gated on a context key + maintaining a generated keybindings.json fragment, or simply emitting a "Paste this into your keybindings.json" toast. Pick the cheaper one for v1.
- Hotkey conflicts that only manifest in specific workspaces (other extensions). Resolution path: document the override pattern (`-claudeDashboard.focusSlot1` to disable) rather than try to detect.

**Open question:** validate `hotkey` strings against VS Code's accelerator grammar at write-time, or accept anything and let the keybinding registration fail silently? The latter is simpler but harder to debug. Lean validation — we already have a small allowlist of safe modifier patterns from the collision map above.

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

### Tile icons accept SVG file paths, not just codicon names
**Requested:** 2026-05-09 (Matt)

The `icon` field on a terminal entry currently only accepts codicon names (`types.ts:41` — `icon: string | null` documented as "codicon name"). The webview renders them via `codicon codicon-${name}` (`webview.js:195`). This means CLB's own activity-bar icon (`media/dashboard.svg`) can't be reused on the `claudelike-bar` *tile* — same extension, two icon systems.

Want: support an SVG file path alternative so any extension-bundled or user-supplied SVG can be used as a tile icon. Detect by extension (`.svg`) or by leading `/` / `media/` prefix and route to a different render path.

**Scope.**

1. Type change: `icon: string | null` → `icon: string | null` with documented dual-meaning, OR a tagged shape like `icon: { codicon: string } | { svg: string }`. Lean on the first (string-with-detection) for back-compat — every existing config keeps working.
2. Render path: in `webview.js`, when `tile.icon` ends in `.svg` or starts with `/`, render `<img src=${webview.asWebviewUri(file)}>` instead of the codicon span. Need to pipe the SVG file through `webview.asWebviewUri()` — the dashboard provider already has the webview reference, so resolution happens extension-side and the URI is sent to the webview pre-resolved.
3. Security: only allow paths within `extensionPath/media/` and `~/.claude/icons/` (a new convention dir). Reject anything else to avoid accidentally exposing arbitrary filesystem reads via the webview.
4. Color tinting: codicons inherit `currentColor`, so the existing per-tile color theming "just works." For SVG `<img>`, color doesn't bleed through. Either (a) require tile-icon SVGs to use `currentColor` and inline them as `<svg>` tags rather than `<img>` (small fetch-and-inline pass), or (b) accept that user-supplied SVGs render at their own colors and document it. Option (a) is more work but preserves the visual consistency — every other tile gets its color from the per-tile `color` field.

**Effort estimate:** 30–45 min for the simple `<img>` version, +15 min for inline-SVG tinting. Tests: one for each new resolution path (codicon-name, .svg path, invalid path).

**Concrete trigger:** the `claudelike-bar` tile in Matt's bar — it currently uses codicon `extensions` (puzzle piece) because the activity-bar icon at `media/dashboard.svg` isn't reusable. Closing the gap lets the tile match the activity-bar icon.

### Audio enabled by default for fresh installs
**Requested:** 2026-05-09 (Matt)

Today, a fresh install ships with `audio.enabled: false` — users have to discover and flip it on to hear anything. Most users want a chime when Claude finishes a turn (it's the bar's whole differentiator over the built-in terminal). Flip the default so new installs come up with audio on, using the bundled `can-crack.mp3` for `turnDone`.

**Current behavior:**
- Runtime check at `configManager.ts:480`: `return this.config.audio?.enabled === true;` → `undefined` reads as `false`.
- Config writer at `configManager.ts:892`: `enabled: rawAudio.enabled === true` → fresh writes `enabled: false`.
- `freshAudioBlock` flag at `configManager.ts:886` already detects "user has never touched the audio block" — re-use this signal.

**Proposed change:**
- Define `DEFAULT_AUDIO_ENABLED = true` constant alongside `DEFAULT_TURN_DONE_SOUND` in `claudePaths.ts`.
- `isAudioEnabled()` (line 480) → return `this.config.audio?.enabled !== false` (default true unless explicitly disabled).
- `generateConfigText()` (line 892) → write `enabled: rawAudio.enabled !== false` for fresh blocks; honor explicit `false` when user has set it.
- Existing users who've never touched `audio.enabled` will hear sound on next start. That's arguably the desired behavior (the chime is the feature) but worth a release note + minor version bump.

**Effort estimate:** 5–10 min code change + 5 min release note. Tests: assert fresh-config audio is on; assert explicit `enabled: false` is honored.

**Caveats:**
- Behavior change for existing users — covered by release notes. Flipping a default ON is gentler than OFF; users who don't want audio just flip it back.
- `can-crack.mp3` resolves from the bundled extension directory if absent in `~/.claude/sounds/`, so no missing-file edge case.
- Volume default `DEFAULT_AUDIO_VOLUME = 0.6` and debounce `DEFAULT_AUDIO_DEBOUNCE_MS = 150` already sensible — no change needed.

### Project-organizer panel — drag/drop tiles between visibility lanes
**Requested:** 2026-05-09 (Matt)

The bar accumulates tiles fast (currently 28 entries in `.claudelike-bar.jsonc`). Today, getting a project out of the bar means right-click → "Hide from bar"; getting it back means the command palette; pinning is a context menu toggle; reordering is drag-within-bar. Four interactions, three locations. Want a single management panel — a "kanban" view of all known tiles, sorted into lanes by their current `(pinned, hidden)` flag combo, with drag/drop to move between lanes and reorder within them.

**Lanes** (mapping to existing flags — no new data primitives needed):

| Lane | `pinned` | `hidden` | Today's behavior |
|---|---|---|---|
| Auto-sort | false | false | Status-driven order in bar (current default) |
| Pinned | true | false | Fixed-order zone at bar bottom, drag-reorderable |
| Closed but visible | false | false + project terminal not running | Same as Auto-sort lane today — tile shown, click to launch |
| Closed and not visible | — | true | Hidden from bar; reachable via command palette only |

Caveat: lanes 1 and 3 collapse to the same `(pinned: false, hidden: false)` config state — the difference between them is runtime (terminal alive vs not), not config. **Decision (2026-05-09, Matt):** treat "Closed but visible" as a *passive* lane — tiles auto-appear there when their terminal exits, and you can't drag *into* it. Dragging *out of* it to Pinned or Closed-and-not-visible flips a flag; dragging to Auto-sort launches the project. This avoids the "kill-by-drag" footgun where dragging would terminate a running terminal. Lane membership for `(false, false)` tiles is derived from `dashboardProvider` runtime state, not a new config field.

**Scope.**

What already exists in the codebase:

- `pinned: boolean` flag (`configManager.ts:59`), `setPinned()` method (`configManager.ts:633`).
- `hidden: boolean` flag (`configManager.ts:68`), `setHidden()` method (`configManager.ts:647`).
- `order: number` field + `setOrder(orderedNames: string[])` for drag-reorder (`configManager.ts:661`).
- "Hide from bar" right-click action (`webview.js:518`) and pin toggle (`webview.js:548`).
- Drag-and-drop within the bar that flips `sortMode` to manual.

What's needed:

1. **New webview panel** — separate from the sidebar bar (sidebar is too narrow for 4 columns). Open via gear menu or command "Claudelike Bar: Organize Projects". Renders 4 vertical columns of tile-shaped cards.
2. **Drop handler** that translates `(srcLane, dstLane, position)` into the right combination of `setPinned` / `setHidden` / `setOrder` calls atomically. ~30 lines in `configManager.ts`.
3. **HTML5 native DnD or a tiny lib** (e.g. SortableJS, ~12 KB) for cross-column drag with drop placeholders. Native DnD works but the cross-column-with-position UX is finicky; SortableJS pays for itself here.
4. **Live re-sync** — panel listens to the same config-file watcher the bar uses; if you tweak the JSONC by hand, the panel updates. Reuse `dashboardProvider`'s update mechanism.

What's *not* in scope (worth deferring):

- Bulk operations (multi-select drag) — start with single-tile DnD, add multi-select if the v1 doesn't feel fast enough.
- Search/filter within the panel — at 28 tiles this is fine; revisit at 50+.
- Editing tile color/icon/nickname inline — keep that in the existing right-click menu / config file. Panel is purely about lane membership and order.

**Effort estimate:** 60-90 minutes of Claude time for v1.
- Backend (`configManager` lane-move method + extension command + panel registration): ~20 min
- Webview panel HTML/CSS skeleton: ~15 min
- DnD wiring (SortableJS or native + drop targets): ~25 min
- Live re-sync via existing config-watcher: ~10 min
- Tests (lane-move atomicity, DnD message round-trip via `webview-syntax.test.ts` style): ~15 min

Risk areas:
- Atomic flag flips when crossing lanes — easy to leave a tile in a half-state if the user drags fast and the messages reorder. Mitigation: single `moveTile(name, lane, position)` API that does all flag changes inside one config write, not three separate `setPinned`/`setHidden`/`setOrder` round-trips.
- Distinguishing "auto-sort" vs "closed but visible" if going with option 1 above — needs the panel to read live tile state from `dashboardProvider`, not just config. Minor coupling but worth it to avoid the schema bump.
- VS Code webview reload on theme change wiping local DnD state — known annoyance in other panels; standard fix is to persist the panel state in `webview.state` API.

**Open question:** sidebar webview vs editor-area webview panel? Editor-area has more room for a 4-column kanban; sidebar can host a vertical-stack version (2 columns × 2 stacks). Lean editor-area for a real kanban feel.

## Deferred Design Work

### Crash watchdog
Tile stuck on `working` with no events for >N minutes → "stalled" label. Needs careful threshold or user-configurable setting. Identified in v0.9.3 deep-dive (H3) but not implemented — SessionStart(startup) now resets on restart, which covers the common case. Watchdog would cover "Claude hung but didn't crash" edge case.

### teammate_idle timeout
If a teammate never responds after TeammateIdle, tile sits on "Working (teammate idle)" forever. Only `UserPromptSubmit` recovers it. Low-impact but worth a timeout or a "force reset" context menu option.
