# Bundled sound credits

Claudelike Bar ships two short audio files for the `turnDone` and
`midJobPrompt` slots. Reference them by filename in
`~/.claude/claudelike-bar.jsonc` — resolution falls back from
`~/.claude/sounds/` to these bundled files, so dropping a same-named
file in the user sounds dir wins.

| File | Source | License | Notes |
|------|--------|---------|-------|
| `turn-done-default.mp3` | [Mixkit — sound effect 1084](https://mixkit.co/free-sound-effects/notification/) | [Mixkit Sound Effects Free License](https://mixkit.co/license/#sfxFree) | Gentle two-tone notification chime. ~2 seconds. Ships as the default `turnDone` for fresh configs. |
| `can-crack.mp3` | [Pixabay audio 380748](https://pixabay.com/sound-effects/search/?id=380748) by oxidvideos | [Pixabay Content License](https://pixabay.com/service/license-summary/) | Soda-can pop. ~1 second. Alternative `turnDone` / `midJobPrompt` — set explicitly if you want it. |

## License summary

Both licenses permit bundling the audio in commercial + non-commercial
projects with no attribution required. This file exists for transparency
and to make replacing the sounds easier if either license ever changes.

## Replacing or adding sounds

Drop any new file into `~/.claude/sounds/` and set `audio.sounds.turnDone`
(or `midJobPrompt`) to its filename. Files there always win over the
bundled defaults with the same name.

The config validator only allows `[a-zA-Z0-9._-]+` filenames — no path
separators, no traversal.
