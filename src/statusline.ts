import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { hooksDir, settingsPath, writeSettingsAtomic } from './claudePaths';

/**
 * Statusline module — COMPLETELY INDEPENDENT of setup.ts (hooks).
 *
 * Context % in Claudelike Bar tiles comes from a Claude Code statusline
 * script that writes `context_percent` into the per-project status file.
 * Hook events don't carry context window data, so this is the only way.
 *
 * This module ships a minimal standalone statusline so users who don't
 * already have one get context % out of the box. If the user already has
 * a `statusLine.command` configured, we leave it alone — their statusline
 * is their own business, and they can feed context % into the status file
 * however they like (see README → "Context % (Optional Enhancement)").
 *
 * The two modules share only the status file format, which is a documented
 * stable interface. Neither imports the other.
 */

const STATUSLINE_FILENAME = 'claudelike-statusline.js';
const STATUSLINE_DOC_URL = 'https://github.com/aes87/claudelike-bar/blob/main/docs/HOOKS.md#statusline-optional';

function statuslineCommand(): string {
  const script = path.join(hooksDir(), STATUSLINE_FILENAME);
  // On Windows, prefix with `node` so the command works regardless of
  // shebang interpretation or file association.
  return process.platform === 'win32' ? `node "${script}"` : script;
}

/** Does the user have ANY statusline command configured? */
export function isStatuslineConfigured(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return typeof s?.statusLine?.command === 'string' && s.statusLine.command.length > 0;
  } catch {
    return false;
  }
}

/** Is the active statusline specifically Claudelike Bar's? */
export function isClaudelikeStatuslineActive(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const cmd = s?.statusLine?.command;
    return typeof cmd === 'string' && cmd.includes(STATUSLINE_FILENAME);
  } catch {
    return false;
  }
}

export interface StatuslineSetupResult {
  scriptInstalled: boolean;
  settingsUpdated: boolean;
  reason?: string;
}

/**
 * Install the statusline. By default, registers it in settings.json only if
 * no `statusLine.command` is currently configured — the user's existing
 * statusline (if any) is preserved untouched.
 *
 * Pass `force: true` to replace an existing statusline. Callers should
 * confirm with the user before doing this.
 *
 * The script file is always copied (idempotent), even when the registration
 * step is skipped — this way a user who later decides to switch can do so
 * without re-running install.
 */
export async function runStatuslineSetup(
  extensionPath: string,
  force = false,
): Promise<StatuslineSetupResult> {
  // 1. Copy the statusline script to ~/.claude/hooks/
  const source = path.join(extensionPath, 'hooks', STATUSLINE_FILENAME);
  if (!fs.existsSync(source)) {
    throw new Error(`Bundled statusline script not found at ${source}`);
  }
  fs.mkdirSync(hooksDir(), { recursive: true });
  const dest = path.join(hooksDir(), STATUSLINE_FILENAME);
  fs.copyFileSync(source, dest);
  try { fs.chmodSync(dest, 0o755); } catch { /* no-op on Windows */ }

  // 2. Read settings and decide whether to register
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${settingsPath()}: ${err.message}`);
    }
  }

  const existing = settings?.statusLine?.command;
  const isOurs = typeof existing === 'string' && existing.includes(STATUSLINE_FILENAME);
  // Preserve any non-null/non-undefined existing command that isn't already ours —
  // even if it's an unusual shape (array-form command, partial config). The
  // stated guarantee is "never overwrite without force=true."
  if (!force && existing !== undefined && existing !== null && !isOurs) {
    return {
      scriptInstalled: true,
      settingsUpdated: false,
      reason: `existing statusLine.command preserved`,
    };
  }
  // If existing is already ours, skip the re-write to avoid re-registering
  // the same value (keeps the onboarding message truthful).
  if (!force && isOurs) {
    return {
      scriptInstalled: true,
      settingsUpdated: false,
      reason: `Claudelike Bar statusline already configured`,
    };
  }

  // Register (or re-register) our statusline.
  settings.statusLine = {
    type: 'command',
    command: statuslineCommand(),
    padding: 0,
  };

  writeSettingsAtomic(settings);
  return { scriptInstalled: true, settingsUpdated: true };
}

/**
 * Palette command handler — installs the statusline with user-facing
 * prompts for the replace-existing case.
 */
export async function executeStatuslineInstallCommand(
  extensionPath: string,
  log: (m: string) => void,
): Promise<void> {
  const hasExisting = isStatuslineConfigured() && !isClaudelikeStatuslineActive();
  if (hasExisting) {
    const pick = await vscode.window.showWarningMessage(
      'A different statusline is already configured in ~/.claude/settings.json. ' +
      'Installing Claudelike Bar\'s statusline will replace it. Your existing statusline will stop running.',
      { modal: true },
      'Replace',
      'Keep existing',
    );
    if (pick !== 'Replace') {
      log('statusline install: user kept existing statusline');
      vscode.window.showInformationMessage(
        'Claudelike Bar: kept existing statusline. Context % tiles will only update if that statusline writes context_percent to the status file.',
      );
      return;
    }
  }

  try {
    const result = await runStatuslineSetup(extensionPath, true);
    log(`statusline: scriptInstalled=${result.scriptInstalled}, settingsUpdated=${result.settingsUpdated}`);
    const msg = result.settingsUpdated
      ? 'Claudelike Bar: statusline installed. Context % will update on your next Claude turn.'
      : `Claudelike Bar: statusline script copied (${result.reason ?? 'no changes to settings'}).`;
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`statusline setup failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: statusline install failed — ${msg}`);
  }
}

export { STATUSLINE_DOC_URL, STATUSLINE_FILENAME };
