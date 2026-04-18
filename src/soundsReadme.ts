import * as fs from 'fs';
import * as path from 'path';
import { soundsDir } from './claudePaths';

/**
 * v0.12 — Template body for `~/.claude/sounds/README.md`. Written once, on
 * first `Toggle Audio` or `Open Sounds Folder` invocation when the folder
 * is empty (or missing). The body is the spec's exact template.
 */
export const SOUNDS_README_BODY = `# Claudelike Bar — Sounds

Drop short audio clips here (MP3, WAV, or OGG), then reference them by
filename in \`~/.claude/claudelike-bar.jsonc\`:

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
`;

/**
 * Create `~/.claude/sounds/` if missing and write a README if the folder is
 * empty (or README is missing). Returns the resolved sounds dir path.
 * Intentionally safe to call on every toggle / open — idempotent.
 */
export function ensureSoundsDirWithReadme(dirOverride?: string): string {
  const dir = dirOverride ?? soundsDir();
  fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  const entries = fs.readdirSync(dir).filter((n) => n !== '.' && n !== '..');
  // Write the README only when the folder is empty, OR when it's effectively
  // empty (just the README already) but the file is missing. If the user
  // has already dropped sound files in, respect their setup — don't clutter.
  const hasNonReadme = entries.some((n) => n !== 'README.md');
  if (!hasNonReadme && !fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, SOUNDS_README_BODY, 'utf-8');
  }
  return dir;
}
