# Audio alerts — setup

Off by default. Takes three steps: drop sound files in, point the config at
them, flip the switch.

## TL;DR

```bash
# 1. Open the sounds folder (creates ~/.claude/sounds/ with a README)
# In VS Code: Cmd+Shift+P → "Claudelike Bar: Open Sounds Folder"

# 2. Drop one or two short clips in — e.g. chime.mp3 and ping.mp3

# 3. Flip the switch
# Cmd+Shift+P → "Claudelike Bar: Toggle Audio"
# (or right-click any tile → "Unmute Audio")
```

Then edit `~/.claude/claudelike-bar.jsonc`:

```jsonc
"audio": {
  "enabled": true,
  "volume": 0.6,
  "sounds": {
    "ready":      "chime.mp3",
    "permission": "ping.mp3"
  }
}
```

## What plays when

| Event                           | Slot used                          |
| ------------------------------- | ---------------------------------- |
| Claude finishes a turn (`Stop`) | `ready`                            |
| Claude needs approval mid-job   | `permission` (falls back to ready) |
| Focused tile becomes ready      | silent — you're already looking at it |
| SubagentStop / StopFailure      | silent — no user action needed     |

Three tiles finishing at the same instant coalesce into one sound — the
150ms debounce window stops them from stacking.

## Where to get sounds

All three are royalty-free. Pick short clips (under a second is ideal —
long sounds pile up in busy windows).

- **Mixkit** — https://mixkit.co/free-sound-effects/notification/
- **Pixabay** — https://pixabay.com/sound-effects/search/notification/
- **Freesound** — https://freesound.org (tick the CC0 filter)

## Format rules

- MP3, WAV, or OGG — whatever Chromium can decode
- Filenames: letters, digits, dot, dash, underscore only (no spaces, no slashes)
- Keep clips **under 1 second**
- Max volume is 1.0 — if that's not loud enough, re-encode the file louder

## Troubleshooting

**Nothing plays on the first job after opening VS Code.**
Open the Claudelike Bar sidebar at least once per session. The webview hosts
the audio element; until it's resolved the first time, there's nothing to
play through. Once you open it, subsequent dings work even when the sidebar
is collapsed (we keep the context alive).

**No sound even after opening the sidebar.**
1. Check the config is loaded:
   `Cmd+Shift+P → "Claudelike Bar: Open Config"`. The `audio` block should
   show `"enabled": true` and your filenames under `sounds`.
2. Check the files actually exist:
   `Cmd+Shift+P → "Claudelike Bar: Open Sounds Folder"`.
3. Turn on debug logging (`"debug": true` in the config) — the output
   channel will tell you whether the file was found, whether the tile was
   filtered for focus, or whether the slot fell back.

**Volume is too quiet.**
`volume` maxes out at 1.0. The HTML Audio API won't amplify past 100%. If
you need more, re-encode the file louder (Audacity → Effect → Amplify).

**The permission sound plays when Claude finishes a turn.**
Make sure you have both `ready` and `permission` configured. When `permission`
is unset, every user-blocking transition uses `ready` — which is the simpler
setup and fine for most people.

**Autoplay blocked / silent on a fresh VS Code install.**
Chromium blocks `.play()` without a user gesture in some contexts. VS Code
webviews have historically been exempt. If your dings stop working after
a VS Code update, file an issue — we'll add a CI smoke test that catches
this (in fact, the CI workflow already does).

**I don't want the sidebar eating memory just to play sounds.**
The sidebar webview is retained across collapses so audio survives session
churn. On a modern machine the cost is trivial (a few MB). If it bothers
you, set `audio.enabled: false` and the webview goes quiet.
