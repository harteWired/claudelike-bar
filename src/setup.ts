import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { claudeDir, hooksDir, settingsPath, writeSettingsAtomic } from './claudePaths';

const HOOK_FILENAME = 'dashboard-status.js';
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',         // v0.9.3: tool completed — the signal that closes
                         //         the gap between permission approval and Stop
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'StopFailure',         // v0.9: API errors (rate limit, auth, billing)
  'SubagentStart',       // v0.9: Task-tool subagent spawned
  'SubagentStop',        // v0.9: Task-tool subagent finished
  'TeammateIdle',        // v0.9: Agent Teams — teammate waiting for peer
  'SessionStart',        // v0.9.1: Claude session begins/resumes
  'SessionEnd',          // v0.9.1: Claude session terminates
  'PostToolUseFailure',  // v0.9.1: tool execution error
  'PreCompact',          // v0.9.1: context compaction starting
  'PostCompact',         // v0.9.1: context compaction finished
];

const HOOKS_DOC_URL = 'https://github.com/harteWired/claudelike-bar/blob/main/docs/HOOKS.md';

function hookCommand(): string {
  const script = path.join(hooksDir(), HOOK_FILENAME);
  // On Windows, prefix with `node` so the command works regardless of
  // shebang interpretation or file association.
  return process.platform === 'win32' ? `node "${script}"` : script;
}

function isDashboardHook(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  return cmd.includes('dashboard-status.js') || cmd.includes('dashboard-status.sh');
}

/**
 * Check if a command string references the *current* (.js) hook — used by
 * `isSetupComplete` so legacy .sh registrations are treated as "needs setup"
 * and trigger the migration path.
 */
function isCurrentDashboardHook(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes('dashboard-status.js');
}

/**
 * Check whether the hook script file exists and all HOOK_EVENTS are registered
 * in settings.json pointing at the CURRENT (.js) hook. Legacy .sh-only
 * registrations return false so the migration path runs on next activation.
 */
export function isSetupComplete(): boolean {
  const scriptPath = path.join(hooksDir(), HOOK_FILENAME);
  if (!fs.existsSync(scriptPath)) return false;

  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return false;
  }

  if (!settings?.hooks) return false;
  for (const event of HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) return false;
    const found = entries.some(
      (e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => isCurrentDashboardHook(h?.command)),
    );
    if (!found) return false;
  }
  return true;
}

/**
 * Copy the hook script from the extension's bundled `hooks/` dir to
 * `~/.claude/hooks/`, then merge all HOOK_EVENTS registrations into
 * `~/.claude/settings.json`. Idempotent — safe to run multiple times.
 * Also migrates any legacy `.sh` references to the new `.js` command.
 */
export async function runSetup(extensionPath: string): Promise<{ added: number; migrated: number }> {
  // 1. Copy hook script
  const source = path.join(extensionPath, 'hooks', HOOK_FILENAME);
  if (!fs.existsSync(source)) {
    throw new Error(`Bundled hook script not found at ${source}`);
  }
  fs.mkdirSync(hooksDir(), { recursive: true });
  const dest = path.join(hooksDir(), HOOK_FILENAME);
  fs.copyFileSync(source, dest);
  try { fs.chmodSync(dest, 0o755); } catch { /* no-op on Windows */ }

  // 2. Merge settings.json
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new Error(`Failed to parse ${settingsPath()}: ${err.message}`);
  }
  if (!settings.hooks) settings.hooks = {};

  const cmd = hookCommand();
  let added = 0;
  let migrated = 0;

  for (const event of HOOK_EVENTS) {
    const existing = settings.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(
        `settings.hooks.${event} is ${typeof existing}, expected array. Refusing to overwrite — ` +
        `please fix ~/.claude/settings.json manually or remove the malformed entry.`,
      );
    }
    if (!Array.isArray(existing)) settings.hooks[event] = [];
    const entries: any[] = settings.hooks[event];

    // Migrate legacy .sh references inside entries, then dedupe.
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h?.command === 'string' && h.command.includes('dashboard-status.sh')) {
          h.command = cmd;
          migrated++;
        }
      }
      // Dedup within the entry
      const seen = new Set<string>();
      entry.hooks = entry.hooks.filter((h: any) => {
        if (!isDashboardHook(h?.command)) return true;
        if (seen.has(h.command)) return false;
        seen.add(h.command);
        return true;
      });
    }

    // Dedup across entries (only single-dashboard-hook entries).
    const seenEntry = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!Array.isArray(entry?.hooks) || entry.hooks.length === 0) continue;
      if (entry.hooks.length === 1 && isDashboardHook(entry.hooks[0].command)) {
        const key = entry.hooks[0].command;
        if (seenEntry.has(key)) {
          entries.splice(i, 1);
          migrated++;
        } else {
          seenEntry.add(key);
        }
      }
    }

    // Add registration if absent.
    const registered = entries.some(
      (e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => isDashboardHook(h?.command)),
    );
    if (!registered) {
      entries.push({ matcher: '', hooks: [{ type: 'command', command: cmd }] });
      added++;
    }
  }

  writeSettingsAtomic(settings);

  return { added, migrated };
}

/**
 * Palette command handler for "Claudelike Bar: Install Hooks" — installs
 * hooks only. Onboarding orchestration (which may also install the
 * statusline) lives in `onboarding.ts`, keeping this module independent.
 */
export async function executeHooksInstallCommand(extensionPath: string, log: (msg: string) => void): Promise<void> {
  try {
    const { added, migrated } = await runSetup(extensionPath);
    log(`setup: added=${added}, migrated=${migrated}`);
    const parts: string[] = [];
    if (added > 0) parts.push(`registered ${added} event(s)`);
    if (migrated > 0) parts.push(`migrated ${migrated} legacy reference(s)`);
    if (parts.length === 0) parts.push('hooks already in place');
    vscode.window.showInformationMessage(`Claudelike Bar: ${parts.join(', ')}. Tiles will update on your next Claude turn.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`setup failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: hook install failed — ${msg}`);
  }
}

export { HOOKS_DOC_URL };
