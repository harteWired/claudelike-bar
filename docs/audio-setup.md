# Audio alerts — setup

Off by default. A fresh config seeds a gentle bundled chime on the `turnDone`
slot, so flipping the switch gives you sound out of the box. No files to
source, nothing to drop in.

## TL;DR

```bash
# One step: flip the switch.
# Cmd+Shift+P → "Claudelike Bar: Toggle Audio"
# (or right-click any tile → "Unmute Audio")
```

That's it. On the next turn Claude finishes, you'll hear the bundled
`turn-done-default.mp3` chime.

Want a different sound? Either swap to the other bundled option or drop
your own clip in `~/.claude/sounds/`.

## Config shape

```jsonc
"audio": {
  "enabled": true,
  "volume": 0.6,
  "sounds": {
    "turnDone":     "turn-done-default.mp3",  // Claude finished a turn
    "midJobPrompt": null                      // Claude needs input mid-job
                                              // (falls back to turnDone)
  }
}
```

`turnDone` — plays when Claude finishes a turn (`Stop` event).
`midJobPrompt` — plays when Claude blocks mid-job on a user prompt
(`Notification` event). When unset, mid-job prompts use the `turnDone`
sound; when set, they get their own distinct chime so you can tell
"turn done" apart from "needs approval" by ear.

### Slot names changed in v0.14

v0.12–v0.13 called these slots `ready` and `permission`. v0.14 reads the
old names as aliases and writes the new names on next save — your config
migrates in place without any manual action.

## Bundled defaults

Two files ship with the extension in `media/sounds/` — referenced by
filename from the config, no need to copy them anywhere:

| Filename | What it is |
| --- | --- |
| `turn-done-default.mp3` | Gentle two-tone notification chime (~2s). Default `turnDone` for fresh configs. |
| `can-crack.mp3` | Soda-can pop (~1s). Alternative — set `turnDone` or `midJobPrompt` to this to hear it. |

Drop a file of the same name in `~/.claude/sounds/` and your version
wins. Licensing + source details in `media/sounds/CREDITS.md`.

## Bring your own

Any MP3 / WAV / OGG works. Open the user sounds folder with
`Cmd+Shift+P → "Claudelike Bar: Open Sounds Folder"` and drop files in.

Sources:

- **Mixkit** — https://mixkit.co/free-sound-effects/notification/
- **Pixabay** — https://pixabay.com/sound-effects/search/notification/
- **Freesound** — https://freesound.org (tick the CC0 filter)

## What plays when

| Event                           | Slot used                                |
| ------------------------------- | ---------------------------------------- |
| Claude finishes a turn (`Stop`) | `turnDone`                               |
| Claude needs approval mid-job   | `midJobPrompt` (falls back to turnDone)  |
| Focused tile becomes ready      | silent — you're already looking at it    |
| SubagentStop / StopFailure      | silent — no user action needed           |

Three tiles finishing at the same instant coalesce into one sound — the
150ms debounce window stops them from stacking.

## Format rules

- MP3, WAV, or OGG — whatever Chromium can decode
- Filenames: letters, digits, dot, dash, underscore only (no spaces, no slashes)
- Keep clips **under 1 second** — longer sounds stack on busy moments
- Max volume is 1.0 — if that's not loud enough, re-encode the file louder

## Troubleshooting

**Nothing plays on the first job after opening VS Code.**
Open the Claudelike Bar sidebar at least once per session. The webview
hosts the audio element; until it's resolved the first time, there's
nothing to play through. Once you open it, subsequent dings work even
when the sidebar is collapsed (we keep the context alive).

**No sound even after opening the sidebar.**
Run `Cmd+Shift+P → "Claudelike Bar: Diagnose"`. The output will tell you
whether the config has a `turnDone` sound configured, whether the file
resolves (user dir OR bundled), and whether audio is enabled.

Still stuck? Turn on debug logging (`"debug": true` in the config) — the
output channel logs every audio decision, including focus-skip and
slot-fallback events.

**Volume is too quiet.**
`volume` maxes out at 1.0. The HTML Audio API won't amplify past 100%.
If you need more, re-encode the file louder (Audacity → Effect → Amplify).

**Only the bundled chime works; my custom file doesn't.**
Filename whitelist is strict: `^[a-zA-Z0-9._-]+$`. Spaces, parentheses,
and special characters are rejected. Rename the file to match.

**Autoplay blocked / silent on a fresh VS Code install.**
Chromium blocks `.play()` without a user gesture in some contexts. VS
Code webviews have historically been exempt. If your dings stop working
after a VS Code update, file an issue — we'll add a CI smoke test that
catches this (in fact, the CI workflow already does).

**I don't want the sidebar eating memory just to play sounds.**
The sidebar webview is retained across collapses so audio survives
session churn. On a modern machine the cost is trivial (a few MB). If
it bothers you, set `audio.enabled: false` and the webview goes quiet.
