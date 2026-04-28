# Audio Alerts — Design Spec

Status: proposed
Issue: [#3](https://github.com/harteWired/claudelike-bar/issues/3)
Target: v0.12

## Summary

Play a sound whenever Claude is waiting on the user — whether the turn is done or a mid-job permission prompt is blocking. Two optional slots: one for work-done (`Stop` event), one for permission-needed (`Notification` event). Users supply their own sound files; nothing is bundled. Audio is off by default; the user drops files into `~/.claude/sounds/` and flips `audio.enabled: true` (or uses a tile context-menu toggle).

## Goals

- Audible cue whenever a tile transitions into `ready` status — Claude is waiting for the user.
- Optional second sound for permission prompts so the user can tell "done" apart from "blocked on approval" by ear.
- No audio for subagent lifecycle, tool errors, or internal state churn.
- User brings their own `.mp3` / `.wav` / `.ogg` files; extension ships with zero audio assets.
- Works on all platforms without shell-outs, native deps, or codec bundles.
- One-click mute without opening the config.

## Non-goals (v1)

- Sounds for other states (`error`, `waiting`, `ignored`, `subagent_permission`). Config shape leaves room; only the two user-blocking states are wired in v1.
- Priority/de-duplication across distinct states firing in the same window.
- VS Code `accessibility.signals.*` integration — that's for VS Code's own a11y cues, different layer.
- Scheduled quiet hours or meeting detection.

## Architecture

```
TerminalTracker (existing)
   │   emits: stateChanged(tile, from, to, event)
   ▼
AudioPlayer (new)
   • filter: to === 'ready' && from !== 'ready'   (transition, not refresh)
   • pick:   event === 'Notification' && sounds.permission → permission
             else                                          → ready
   • filter: !config.audio.enabled → drop
   • filter: tile is currently focused → drop
   • filter: chosen sound file missing/unset → drop + one-shot warning
   • debounce: 150ms per sound key (simultaneous permission dings coalesce)
   │
   ▼
DashboardProvider.postPlay(filename)
   • resolves ~/.claude/sounds/<filename> → webview URI
   • posts { type: 'play', url, volume } to webview
   ▼
webview.js
   • new Audio(url); audio.volume = volume; audio.play();
```

### Why webview audio

VS Code's extension host has no audio API. The three options are (a) shell out to `afplay`/`aplay`/`powershell`, (b) spawn a native helper, (c) play through a webview. The sidebar webview already exists, HTML5 `<audio>` plays anything Chromium can decode (MP3/WAV/OGG/AAC), and it's zero platform branching. Pick (c).

### Why `~/.claude/sounds/` (convention, not config paths)

Accepting arbitrary absolute paths means either expanding the webview's `localResourceRoots` per-sound (fragile) or broadening it to the whole filesystem (security hole). Pinning to `~/.claude/sounds/` gives us:

- One `localResourceRoots` entry, set at webview creation.
- Filename-only references — can whitelist to `[a-zA-Z0-9._-]+` with no path separators. No `..` traversal, no CSP escape surface.
- Same mental model as `~/.claude/hooks/` and `~/.claude/claudelike-bar.jsonc`.

### Filter: "Claude is waiting for the user"

Audio fires on the transition **into** `ready` — the state that means *"Claude has stopped and the user is blocking progress."* Both the main-turn-done case (`Stop` event) and the mid-job-prompt case (`Notification` event — permission requests, file-write approvals, etc.) produce this status, and both should chime. Other finish-adjacent events are filtered by status, not event:

| Event → Status | Plays sound? | Why |
|---|---|---|
| `Stop` → `ready` | ✅ (ready slot) | Main agent turn finished — user's turn to respond |
| `Notification` → `ready` | ✅ (permission slot, falls back to ready) | Mid-job permission/input prompt — Claude is blocked on the user |
| `SubagentStop` → `subagent_stop` | ❌ | Internal subagent lifecycle, user isn't blocked |
| `StopFailure` → `error` | ❌ | Error state — reserved for a separate v2 sound slot |
| `ready` → `waiting` (60s timer) | ❌ | Escalation of the same user-is-blocked state; don't double-ding |

The filter is simply `to === 'ready' && from !== 'ready'`. SubagentStop and StopFailure never hit `ready`, so they're filtered for free. The `from !== 'ready'` guard prevents label-refresh transitions (e.g., a follow-up Notification that updates the label while already ready) from firing a second chime.

**Sound-slot selection** once the filter passes:

- `event === 'Notification'` and `sounds.permission` is set → play `permission`
- otherwise → play `sounds.ready`

This makes `permission` an optional *override* for mid-job prompts. If the user only configures `ready`, every user-blocking transition uses it — zero behavior change from the simpler v1. If the user configures both, they hear one sound for "turn finished" and another for "Claude needs approval" without having to look at the sidebar.

Focus check: if the tile is the active terminal when `ready` fires, skip — the user is already looking at it. No need to ding themselves.

## Config

Additive to existing `claudelike-bar.jsonc`:

```jsonc
"audio": {
  // Master switch. Default false — user opts in after dropping sounds in.
  // Toggled by tile context menu "Mute Audio" / "Unmute Audio" or the
  // "Claudelike Bar: Toggle Audio" palette command.
  "enabled": false,

  // 0.0 (silent) – 1.0 (max). HTML5 Audio cannot amplify past 1.0;
  // re-encode the source file louder if you need more.
  "volume": 0.6,

  // Debounce window in ms — multiple tiles finishing simultaneously
  // play one sound, not N.
  "debounceMs": 150,

  // Filenames in ~/.claude/sounds/. null / omitted = silent for that slot.
  //   ready      — plays when Claude finishes a turn (Stop event)
  //   permission — optional; plays when Claude needs input mid-job
  //                (Notification event). Falls back to `ready` if unset.
  // v1 wires these two slots. Shape reserved for future states.
  "sounds": {
    "ready": "chime.mp3",
    "permission": "ping.mp3"
  }
}
```

Validation at config load:

- Each filename matches `^[a-zA-Z0-9._-]+$` — else skip that slot with warning
- Referenced file exists at `~/.claude/sounds/<name>` — else skip that slot with warning
- A missing/invalid `permission` does not disable `ready` — slots fail independently
- Unknown `audio.*` keys are preserved through read-merge-write (same as other unknown fields)

## Commands

| Command | Behavior |
|---|---|
| `Claudelike Bar: Toggle Audio` | Flips `audio.enabled` in the config. Shows toast: "Audio alerts enabled — sound on job completion" / "Audio alerts muted". |
| `Claudelike Bar: Open Sounds Folder` | Opens `~/.claude/sounds/` in the OS file manager (`vscode.env.openExternal`). Creates the folder + writes `README.md` on first call if missing. |

### Tile context menu

Right-click on any tile → **Mute Audio** / **Unmute Audio** (label flips based on current state). Same behavior as `Toggle Audio` command.

## Webview changes

`src/dashboardProvider.ts`:

```typescript
webviewView.webview.options = {
  enableScripts: true,
  localResourceRoots: [
    vscode.Uri.joinPath(this.extensionUri, 'media'),
    vscode.Uri.file(path.join(os.homedir(), '.claude', 'sounds')), // new
  ],
};
```

CSP header: add `media-src ${webview.cspSource}` so `<audio>` loads the webview URI.

Also set `retainContextWhenHidden: true` on the `WebviewViewProvider` options so collapsing the sidebar doesn't kill the JS context and silence subsequent dings. (First-session exception: until the user opens the sidebar at least once, the webview isn't resolved and audio can't play. Document this.)

`media/webview.js` — add message handler:

```javascript
case 'play': {
  const audio = new Audio(message.url);
  audio.volume = message.volume;
  audio.play().catch(() => { /* autoplay blocked or decode error */ });
  break;
}
```

## `~/.claude/sounds/README.md` (auto-written)

Created on first `Open Sounds Folder` or `Toggle Audio` invocation if the folder is empty. Body:

```markdown
# Claudelike Bar — Sounds

Drop short audio clips here (MP3, WAV, or OGG), then reference them by
filename in `~/.claude/claudelike-bar.jsonc`:

    "audio": {
      "enabled": true,
      "volume": 0.6,
      "sounds": {
        "ready":      "chime.mp3",   // when Claude finishes a turn
        "permission": "ping.mp3"     // optional — Claude needs approval
                                     // mid-job. Falls back to "ready".
      }
    }

## Tips

- Keep clips under 1 second — long sounds stack on each other
- Filenames: letters, digits, dot, dash, underscore only
- Re-encode if you need louder than volume 1.0 (the HTML max)

## Free sources

- Mixkit  → https://mixkit.co/free-sound-effects/notification/
- Pixabay → https://pixabay.com/sound-effects/search/notification/
- Freesound → https://freesound.org  (CC0 filter recommended)

All three offer royalty-free clips. Pick a short bell, chime, or ping.
```

## Files touched

| File | Change |
|---|---|
| `src/types.ts` | `AudioConfig` interface, `AudioPlayMessage` webview type |
| `src/configManager.ts` | Parse + validate `audio` section; filename whitelist; `setAudioEnabled(b)` helper |
| `src/audio.ts` *(new)* | `AudioPlayer` class: subscribe, filter, debounce, post |
| `src/terminalTracker.ts` | Expose `event` on `stateChanged` emission (may already carry it — check `onChange` event shape) |
| `src/extension.ts` | Instantiate AudioPlayer; wire to tracker + dashboardProvider; register Toggle + Open Sounds commands |
| `src/dashboardProvider.ts` | `retainContextWhenHidden`, sounds dir in `localResourceRoots`, `media-src` CSP, `postPlay()` method |
| `src/claudePaths.ts` | `soundsDir()` helper |
| `src/soundsReadme.ts` *(new)* | Embedded README template + `writeIfMissing()` |
| `media/webview.js` | `case 'play'` handler |
| `package.json` | 2 new commands + tile context menu entry |
| `README.md` | Audio section pointing at setup |
| `docs/audio-setup.md` *(new)* | User-facing setup guide |

Tests:

- `test/audio.test.ts` — debounce, focus-skip, slot selection (Stop→ready, Notification→permission with fallback to ready when `permission` unset), from-ready-to-ready refresh doesn't fire, missing-file warning per slot, filename whitelist rejection, `enabled: false` short-circuit
- `test/scenarios.test.ts` — 4 new scenarios: Stop→ready plays `ready`, Notification→ready plays `permission` when set, Notification→ready falls back to `ready` when `permission` unset, simultaneous Stops on 3 tiles play one sound
- `test/configManager.test.ts` — audio section parse + validation + preserve-unknown-keys + independent slot failure

## Open questions / deferred

- **Per-state sounds beyond `ready`/`permission`** — structure supports it; v2 could add `error`, `subagent_permission`, etc. Not wired in v1 per user scope.
- **Autoplay policy testing** — Chromium typically blocks audio without user gesture. VS Code webviews have historically been exempt, but smoke-test on clean install before cutting the release.
- **`ignored` sound in passive-aggressive mode** — deferred. User declined.
- **Sound pack / "Get Sounds" command** — empty-folder notification could link to a curated gist of CC0 URLs. Nice-to-have, not in v1.

## Risks

1. **First-session cold webview** — until the user opens the sidebar view in a session, audio can't fire. Minor; document in README and surface in the `Toggle Audio` confirmation toast: *"Open the Claudelike Bar sidebar at least once per session for audio."*
2. **Autoplay blocked on VS Code update** — if Chromium ever tightens webview autoplay, first `play()` in a session might fail silently. Caught by the `.catch()` handler; fallback = log to debug channel.
3. **Filename abuse** — mitigated by whitelist regex + single `localResourceRoots` entry.

## Rollout

v0.12.0:
- Ship the feature with `audio.enabled: false` by default
- Existing configs gain the `audio` block on next save via read-merge-write (or on first Toggle Audio invocation)
- No migration required; no breaking changes

Release notes call out: *"Sounds when Claude finishes. Drop clips in `~/.claude/sounds/`, run 'Claudelike Bar: Toggle Audio'."*
