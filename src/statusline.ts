import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { claudeDir, hooksDir, settingsPath, writeSettingsAtomic, readExtensionVersion } from './claudePaths';

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
const STATUSLINE_DOC_URL = 'https://github.com/harteWired/claudelike-bar/blob/main/docs/HOOKS.md#statusline-optional';
const BACKUP_FILENAME = '.claudelike-bar-statusline-backup.json';

/**
 * Path to the statusline backup file. Lives in `~/.claude/` alongside
 * settings.json so anyone restoring by hand (or Claude, via chat) can find
 * it next to the file it backs up.
 */
export function statuslineBackupPath(): string {
  return path.join(claudeDir(), BACKUP_FILENAME);
}

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
  backupPath?: string; // set when an existing statusLine was backed up
  reason?: string;
}

/** Metadata describing the extension version — injected by callers. */
export interface StatuslineSetupContext {
  extensionVersion: string;
}

/**
 * Write `settings.statusLine` (whatever it is) to a timestamped backup file
 * in `~/.claude/`. Never overwrites an existing backup — appends `.N` until
 * a free path is found. Returns the path written (or null when there's
 * nothing to back up).
 *
 * The format is deliberately verbose and self-describing so that a user
 * whose extension is gone or broken can restore by reading the file with
 * Claude ("restore my previous statusline") — the `note` field walks
 * through the manual restore procedure.
 */
function backupCurrentStatusline(
  currentStatusLine: unknown,
  context: StatuslineSetupContext,
): string | null {
  if (currentStatusLine === undefined || currentStatusLine === null) return null;
  fs.mkdirSync(claudeDir(), { recursive: true });

  const backup = {
    backup_format_version: 1,
    backed_up_at: new Date().toISOString(),
    backed_up_by: 'claudelike-bar',
    backed_up_by_version: context.extensionVersion,
    settings_path: settingsPath(),
    previous_statusLine: currentStatusLine,
    note:
      'This file backs up the "statusLine" value that was previously in ' +
      '~/.claude/settings.json, replaced when Claudelike Bar installed its ' +
      'own statusline. To restore: run the VS Code command "Claudelike Bar: ' +
      'Restore Previous Statusline", or manually copy the `previous_statusLine` ' +
      'object below back into ~/.claude/settings.json under the top-level ' +
      '"statusLine" key. Safe to delete this file once you no longer need ' +
      'the backup.',
  };
  const body = JSON.stringify(backup, null, 2) + '\n';

  // Pick a non-colliding path and commit atomically with O_EXCL so that a
  // racing install (second VS Code window, simultaneous activation) cannot
  // silently clobber a prior backup between existsSync and the final write.
  // Retry with the next suffix when EEXIST surfaces.
  const base = statuslineBackupPath();
  for (let suffix = 0; suffix <= 99; suffix++) {
    const target = suffix === 0 ? base : `${base}.${suffix}`;
    try {
      // `wx` = O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if target exists.
      fs.writeFileSync(target, body, { flag: 'wx' });
      return target;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // Collision — try the next suffix.
    }
  }
  throw new Error(`Too many existing statusline backups at ${base}.* — clean up manually.`);
}

/**
 * Install the statusline. By default, registers it in settings.json only if
 * no `statusLine.command` is currently configured — the user's existing
 * statusline (if any) is preserved untouched.
 *
 * Pass `force: true` to replace an existing statusline. Callers should
 * confirm with the user before doing this. When replacing, the prior
 * `statusLine` value is backed up to `~/.claude/.claudelike-bar-statusline-backup.json`
 * so the user (or Claude, via the Restore command / manual chat) can put it back.
 *
 * The script file is always copied (idempotent), even when the registration
 * step is skipped — this way a user who later decides to switch can do so
 * without re-running install.
 */
export async function runStatuslineSetup(
  extensionPath: string,
  force = false,
  context: StatuslineSetupContext = { extensionVersion: 'unknown' },
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

  const existingStatusLine = settings?.statusLine;
  const existingCmd = existingStatusLine?.command;
  const isOurs = typeof existingCmd === 'string' && existingCmd.includes(STATUSLINE_FILENAME);
  // Preserve any non-null/non-undefined existing command that isn't already ours —
  // even if it's an unusual shape (array-form command, partial config). The
  // stated guarantee is "never overwrite without force=true."
  if (!force && existingCmd !== undefined && existingCmd !== null && !isOurs) {
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

  // If we're about to replace a non-empty, non-ours statusLine, back it up.
  // (Skip backup when the existing entry IS ours — nothing the user would miss.)
  let backupPath: string | undefined;
  if (force && existingStatusLine !== undefined && existingStatusLine !== null && !isOurs) {
    const saved = backupCurrentStatusline(existingStatusLine, context);
    if (saved) backupPath = saved;
  }

  // Register (or re-register) our statusline.
  settings.statusLine = {
    type: 'command',
    command: statuslineCommand(),
    padding: 0,
  };

  writeSettingsAtomic(settings);
  return { scriptInstalled: true, settingsUpdated: true, backupPath };
}

export interface StatuslineRestoreResult {
  restored: boolean;
  backupPath?: string;
  archivedTo?: string;
  reason?: string;
}

/**
 * Load and validate a backup file. Returns the parsed `previous_statusLine`
 * object ready to write into settings.json together with the command string
 * extracted for user preview — or throws a targeted error that the caller
 * can surface.
 *
 * Validation guards against:
 *   - malformed / non-JSON content
 *   - missing `previous_statusLine` key
 *   - `previous_statusLine: null` (would produce `statusLine: null` in settings)
 *   - missing / mismatched `backed_up_by` stamp
 *   - a structured `previous_statusLine` whose `command` is not a non-empty
 *     string — the attacker-preview-evasion case. We refuse anything we
 *     can't show to the user. The `backed_up_by` stamp is a speed-bump
 *     (attacker can satisfy it trivially); the real safeguard is the
 *     single-read preview below.
 *
 * Returns { payload, commandForPreview } — callers pass `payload` to the
 * writer and `commandForPreview` to the modal. Same bytes, no second read,
 * no TOCTOU between preview and write.
 */
function loadValidatedBackup(primaryPath: string): { payload: unknown; commandForPreview: string } {
  let backup: any;
  try {
    backup = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
  } catch (err: any) {
    throw new Error(`Failed to parse backup file ${primaryPath}: ${err?.message ?? err}`);
  }
  if (backup?.previous_statusLine === undefined || backup?.previous_statusLine === null) {
    throw new Error(`Backup file ${primaryPath} is missing "previous_statusLine"`);
  }
  if (backup?.backed_up_by !== 'claudelike-bar') {
    throw new Error(
      `Backup file ${primaryPath} does not carry "backed_up_by": "claudelike-bar" — refusing to restore a ` +
      `foreign backup. If you hand-edited the file, add that field and re-run.`,
    );
  }
  const cmd = backup.previous_statusLine?.command;
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw new Error(
      `Backup file ${primaryPath} has a "previous_statusLine" with no string "command" field — refusing ` +
      `to restore an unreviewable shape. If this is intentional, put the previous statusLine back manually ` +
      `by copying the object into ~/.claude/settings.json under the "statusLine" key.`,
    );
  }
  return { payload: backup.previous_statusLine, commandForPreview: cmd };
}

/**
 * Restore a previously-backed-up statusline from
 * `~/.claude/.claudelike-bar-statusline-backup.json` back into settings.json.
 * Moves the backup file to `<path>.restored.json` on success — keeps an
 * audit trail instead of silent deletion.
 *
 * Accepts a pre-validated payload from `prepareStatuslineRestore()` so the
 * file is read exactly once — no TOCTOU between the user's "Restore"
 * confirmation (which was shown a preview) and what actually gets written.
 */
export async function runStatuslineRestore(
  prepared: PreparedRestore,
): Promise<StatuslineRestoreResult> {
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`Failed to parse ${settingsPath()}: ${err?.message ?? err}`);
    }
  }
  settings.statusLine = prepared.payload;
  writeSettingsAtomic(settings);

  // Archive the backup so a subsequent Install → Restore round-trip is
  // unambiguous. Best-effort — settings are already restored either way,
  // but only report `archivedTo` when the rename actually succeeded, so
  // the user's confirmation message doesn't lie.
  const archived = `${prepared.backupPath}.restored.json`;
  let archivedTo: string | undefined;
  try {
    fs.renameSync(prepared.backupPath, archived);
    archivedTo = archived;
  } catch {
    // Best-effort — restore itself succeeded, caller sees archivedTo=undefined.
  }
  return { restored: true, backupPath: prepared.backupPath, archivedTo };
}

/**
 * Single-read backup preparation. Returns everything the caller needs to
 * show a confirm modal AND perform the restore — from one file read, so
 * the preview and the installed bytes are guaranteed identical.
 *
 * Returns `null` when there is no backup file. Throws when the backup
 * exists but fails validation (unparseable, foreign, wrong shape).
 */
export interface PreparedRestore {
  backupPath: string;
  payload: unknown;
  commandForPreview: string;
}
export function prepareStatuslineRestore(): PreparedRestore | null {
  const primary = statuslineBackupPath();
  if (!fs.existsSync(primary)) return null;
  const { payload, commandForPreview } = loadValidatedBackup(primary);
  return { backupPath: primary, payload, commandForPreview };
}

/** Read the raw existing statusline command for display in the confirm prompt. */
function readExistingStatuslineCommand(): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const cmd = s?.statusLine?.command;
    return typeof cmd === 'string' && cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/**
 * Palette command handler — installs the statusline with user-facing
 * prompts for the replace-existing case. When the user confirms a replace,
 * the prior statusline is backed up to
 * `~/.claude/.claudelike-bar-statusline-backup.json` so the user can run
 * "Claudelike Bar: Restore Previous Statusline" to put it back.
 */
export async function executeStatuslineInstallCommand(
  extensionPath: string,
  log: (m: string) => void,
): Promise<void> {
  const hasExisting = isStatuslineConfigured() && !isClaudelikeStatuslineActive();
  if (hasExisting) {
    const existingCmd = readExistingStatuslineCommand();
    const preview = existingCmd
      ? `\n\nCurrent statusline.command:\n  ${existingCmd.length > 120 ? existingCmd.slice(0, 117) + '…' : existingCmd}`
      : '';
    const pick = await vscode.window.showWarningMessage(
      'Claudelike Bar wants to install its own statusline in ~/.claude/settings.json. ' +
      'This will replace the statusline you have configured.' +
      '\n\nA backup will be saved to ~/.claude/.claudelike-bar-statusline-backup.json — ' +
      'run "Claudelike Bar: Restore Previous Statusline" any time to put it back.' +
      preview,
      { modal: true },
      'Replace and back up',
      'Keep existing',
    );
    if (pick !== 'Replace and back up') {
      log('statusline install: user kept existing statusline');
      vscode.window.showInformationMessage(
        'Claudelike Bar: kept existing statusline. Context % tiles will only update if that statusline writes context_percent to the status file.',
      );
      return;
    }
  }

  try {
    const result = await runStatuslineSetup(extensionPath, true, {
      extensionVersion: readExtensionVersion(extensionPath),
    });
    log(
      `statusline: scriptInstalled=${result.scriptInstalled}, settingsUpdated=${result.settingsUpdated}` +
      (result.backupPath ? `, backupPath=${result.backupPath}` : ''),
    );
    if (result.settingsUpdated) {
      const tail = result.backupPath
        ? ` Previous statusline backed up to ${result.backupPath}.`
        : '';
      vscode.window.showInformationMessage(
        `Claudelike Bar: statusline installed. Context % will update on your next Claude turn.${tail}`,
      );
    } else {
      vscode.window.showInformationMessage(
        `Claudelike Bar: statusline script copied (${result.reason ?? 'no changes to settings'}).`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`statusline setup failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: statusline install failed — ${msg}`);
  }
}

/**
 * Palette command handler — restore the previously-backed-up statusline
 * from the sibling JSON file. Confirms with the user before overwriting
 * the current (potentially Claudelike-Bar) statusline. Archives the
 * backup file to `.restored.json` on success.
 */
export async function executeStatuslineRestoreCommand(
  log: (m: string) => void,
): Promise<void> {
  // Single read of the backup — same bytes the writer will use, so the
  // preview below and the eventual settings.statusLine value are
  // guaranteed identical (no TOCTOU window).
  let prepared: PreparedRestore | null;
  try {
    prepared = prepareStatuslineRestore();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`statusline restore validation failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: statusline restore failed — ${msg}`);
    return;
  }
  if (!prepared) {
    vscode.window.showWarningMessage(
      `Claudelike Bar: no statusline backup found at ${statuslineBackupPath()}. Nothing to restore.`,
    );
    log('statusline restore: no backup file');
    return;
  }

  // Show the FULL commands in the modal — both what's being replaced and
  // what's being installed — so a padded-prefix truncation attack cannot
  // hide the tail of a malicious backup behind an ellipsis.
  const currentCmd = readExistingStatuslineCommand();
  const parts: string[] = [];
  if (currentCmd) parts.push(`\n\nCurrent statusline.command (will be overwritten):\n  ${currentCmd}`);
  parts.push(`\n\nIncoming statusline.command (from backup, will be installed):\n  ${prepared.commandForPreview}`);

  const pick = await vscode.window.showWarningMessage(
    'Claudelike Bar: restore the previously-backed-up statusline? This will overwrite the current statusLine in ~/.claude/settings.json.' +
    parts.join(''),
    { modal: true },
    'Restore',
    'Cancel',
  );
  if (pick !== 'Restore') {
    log('statusline restore: user cancelled');
    return;
  }

  try {
    const result = await runStatuslineRestore(prepared);
    log(
      `statusline restore: restored=${result.restored}, backupPath=${result.backupPath ?? '-'}, archivedTo=${result.archivedTo ?? '-'}, reason=${result.reason ?? '-'}`,
    );
    if (result.restored) {
      const tail = result.archivedTo
        ? ` Backup archived to ${result.archivedTo}.`
        : ` (Could not move the backup file aside — it may still be at ${result.backupPath}; you can delete it manually.)`;
      vscode.window.showInformationMessage(
        `Claudelike Bar: previous statusline restored.${tail}`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Claudelike Bar: could not restore (${result.reason ?? 'unknown reason'}).`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`statusline restore failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: statusline restore failed — ${msg}`);
  }
}

export { STATUSLINE_DOC_URL, STATUSLINE_FILENAME, BACKUP_FILENAME };
