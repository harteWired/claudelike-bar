import * as os from 'os';
import * as path from 'path';

/**
 * Shared Claude Code filesystem path helpers.
 *
 * Used by `setup.ts` (hooks) and `statusline.ts` (statusline) independently —
 * both modules need the same `~/.claude/` locations but are otherwise unrelated.
 * Resolved lazily so tests can swap HOME/USERPROFILE per-case.
 */

export function claudeDir(): string { return path.join(os.homedir(), '.claude'); }
export function hooksDir(): string { return path.join(claudeDir(), 'hooks'); }
export function settingsPath(): string { return path.join(claudeDir(), 'settings.json'); }
export function globalConfigPath(): string { return path.join(claudeDir(), 'claudelike-bar.jsonc'); }
export function pathIndexPath(): string { return path.join(claudeDir(), 'claudelike-bar-paths.json'); }

/**
 * Write a JSON settings object atomically via temp file + rename.
 * `settings.json` is Claude Code's primary config — corruption here breaks
 * every Claude command, so write-to-temp + rename is essential.
 */
export function writeSettingsAtomic(settings: unknown): void {
  const fs = require('fs') as typeof import('fs');
  fs.mkdirSync(claudeDir(), { recursive: true });
  const finalPath = settingsPath();
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Read the extension's own package.json to get its version string.
 * Used for stamping metadata into backup files. Returns `"unknown"` on
 * any failure — this is cosmetic data, not a correctness input.
 */
export function readExtensionVersion(extensionPath: string): string {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
