import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { hooksDir, settingsPath } from './claudePaths';
import { isSetupComplete } from './setup';
import { detectLegacyHooks } from './legacyHooks';
import { ConfigManager } from './configManager';

/**
 * Health check — one pure function per symptom. `Claudelike Bar: Diagnose`
 * prints every result; activation runs the same set and toasts once if
 * anything is not-ok (gated on a fingerprint so the same state doesn't
 * re-toast across reloads).
 *
 * Every check is read-only. The `fix` hint is text only; it names the
 * palette command the user should run, it doesn't execute anything.
 */

export type CheckSeverity = 'error' | 'warn' | 'info';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  ok: boolean;
  summary: string;
  /** Optional hint — palette command or config key the user should look at. */
  hint?: string;
}

const HOOK_SCRIPT_FILENAME = 'dashboard-status.js';

function checkSettingsJsonParses(): CheckResult {
  const p = settingsPath();
  if (!fs.existsSync(p)) {
    return {
      id: 'settings-file',
      severity: 'error',
      ok: false,
      summary: `~/.claude/settings.json is missing`,
      hint: 'Run `Claudelike Bar: Install Hooks` to create it.',
    };
  }
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return { id: 'settings-file', severity: 'info', ok: true, summary: `~/.claude/settings.json parses cleanly` };
  } catch (err) {
    return {
      id: 'settings-file',
      severity: 'error',
      ok: false,
      summary: `~/.claude/settings.json has a syntax error — ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Fix the JSON by hand; re-run diagnose afterwards.',
    };
  }
}

function checkHookScriptInstalled(): CheckResult {
  const scriptPath = path.join(hooksDir(), HOOK_SCRIPT_FILENAME);
  if (!fs.existsSync(scriptPath)) {
    return {
      id: 'hook-script',
      severity: 'error',
      ok: false,
      summary: `hook script missing at ~/.claude/hooks/${HOOK_SCRIPT_FILENAME}`,
      hint: 'Run `Claudelike Bar: Install Hooks` to copy it from the extension.',
    };
  }
  // Executable bit only matters on POSIX — on Windows the hook is invoked
  // as `node <path>` so the chmod check doesn't apply.
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(scriptPath).mode;
      if ((mode & 0o111) === 0) {
        return {
          id: 'hook-script',
          severity: 'error',
          ok: false,
          summary: `hook script exists but is not executable (${scriptPath})`,
          hint: 'Run `Claudelike Bar: Install Hooks` to reset permissions.',
        };
      }
    } catch {
      // stat failure is rare; if it happens the next check surfaces the error.
    }
  }
  return { id: 'hook-script', severity: 'info', ok: true, summary: `hook script present at ~/.claude/hooks/${HOOK_SCRIPT_FILENAME}` };
}

function checkHooksRegistered(): CheckResult {
  if (isSetupComplete()) {
    return { id: 'hooks-registered', severity: 'info', ok: true, summary: `hooks registered in settings.json for all required events` };
  }
  return {
    id: 'hooks-registered',
    severity: 'error',
    ok: false,
    summary: `one or more hook events are not wired to dashboard-status.js — tiles will stick on "Working"`,
    hint: 'Run `Claudelike Bar: Install Hooks`.',
  };
}

function checkAudio(configManager: ConfigManager, bundledSoundsDir: string | undefined): CheckResult {
  const audio = configManager.getAudioConfig();
  if (!audio.enabled) {
    return { id: 'audio', severity: 'info', ok: true, summary: `audio disabled (set "enabled": true in claudelike-bar.jsonc to turn on)` };
  }
  if (audio.sounds.turnDone) {
    return { id: 'audio', severity: 'info', ok: true, summary: `audio enabled, turnDone → ${audio.sounds.turnDone}` };
  }
  // Audio is on but turnDone is empty. With v0.14 this should be rare —
  // a fresh config auto-seeds the bundled default. Users who explicitly
  // set null land here on purpose, but we still warn so they know why
  // nothing's playing.
  const bundledExists = bundledSoundsDir && fs.existsSync(path.join(bundledSoundsDir, 'turn-done-default.mp3'));
  return {
    id: 'audio',
    severity: 'warn',
    ok: false,
    summary: `audio enabled but turnDone slot is empty — no end-of-turn chime will fire`,
    hint: bundledExists
      ? 'Set "audio.sounds.turnDone" to "turn-done-default.mp3" for the bundled chime, or your own filename in ~/.claude/sounds/.'
      : 'Drop a file in ~/.claude/sounds/ and set audio.sounds.turnDone.',
  };
}

function checkLegacyHooks(): CheckResult {
  const { events, count } = detectLegacyHooks();
  if (count === 0) {
    return { id: 'legacy-hooks', severity: 'info', ok: true, summary: 'no legacy notify*.sh hook entries found' };
  }
  return {
    id: 'legacy-hooks',
    severity: 'warn',
    ok: false,
    summary: `found ${count} legacy notify*.sh hook entr${count === 1 ? 'y' : 'ies'} on ${events.join(', ')} — these fire alongside the bar's own pipeline`,
    hint: 'Run `Claudelike Bar: Remove Legacy Hooks`.',
  };
}

export function runDiagnostics(configManager: ConfigManager, bundledSoundsDir?: string): CheckResult[] {
  return [
    checkSettingsJsonParses(),
    checkHookScriptInstalled(),
    checkHooksRegistered(),
    checkAudio(configManager, bundledSoundsDir),
    checkLegacyHooks(),
  ];
}

/** Join-separator-friendly summary for the output channel. */
export function formatDiagnosticsReport(results: CheckResult[]): string {
  const lines: string[] = ['Claudelike Bar — diagnostics', '─'.repeat(40)];
  for (const r of results) {
    const mark = r.ok ? '✓' : r.severity === 'error' ? '✗' : '!';
    lines.push(`  ${mark}  [${r.id}] ${r.summary}`);
    if (!r.ok && r.hint) lines.push(`     → ${r.hint}`);
  }
  const bad = results.filter((r) => !r.ok);
  lines.push('─'.repeat(40));
  lines.push(bad.length === 0
    ? 'All checks passed.'
    : `${bad.length} issue${bad.length === 1 ? '' : 's'} to review.`);
  return lines.join('\n');
}

/**
 * Short fingerprint of the ok/severity pattern. Used to gate the
 * activation-time toast so we only prompt when state changes. "Same three
 * warnings as last session" shouldn't re-fire every reload.
 */
export function fingerprintDiagnostics(results: CheckResult[]): string {
  return results.map((r) => `${r.id}:${r.ok ? 'ok' : r.severity}`).join('|');
}

/** Palette command: print the full report to the output channel + toast. */
export async function executeDiagnoseCommand(
  configManager: ConfigManager,
  bundledSoundsDir: string | undefined,
  output: vscode.OutputChannel,
): Promise<void> {
  const results = runDiagnostics(configManager, bundledSoundsDir);
  const report = formatDiagnosticsReport(results);
  output.clear();
  output.appendLine(report);
  output.show(true);
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) {
    vscode.window.showInformationMessage('Claudelike Bar: diagnostics clean — all checks passed.');
  } else {
    const errors = bad.filter((r) => r.severity === 'error').length;
    const warns = bad.filter((r) => r.severity === 'warn').length;
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (warns > 0) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
    vscode.window.showWarningMessage(`Claudelike Bar: diagnostics found ${parts.join(' + ')}. See the Claudelike Bar output channel.`);
  }
}

/**
 * Activation-time diagnostics. Fire-and-forget. Toasts only when a check
 * fails AND the fingerprint differs from the last stored one. No toast
 * when only infos are present; no toast when the pattern is unchanged
 * from the prior session (so "the same warning every reload" doesn't
 * turn into notification fatigue).
 */
export async function maybeToastDiagnostics(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  bundledSoundsDir: string | undefined,
  fingerprintKey: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const results = runDiagnostics(configManager, bundledSoundsDir);
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) return;
  const fingerprint = fingerprintDiagnostics(results);
  const last = context.globalState.get<string>(fingerprintKey);
  if (last === fingerprint) return;
  // Always log the full report to the output channel — future debugging
  // is easier if there's an activation-time record of what tripped.
  output.appendLine(formatDiagnosticsReport(results));
  const errors = bad.filter((r) => r.severity === 'error').length;
  const msg = errors > 0
    ? `Claudelike Bar: ${bad.length} setup issue${bad.length === 1 ? '' : 's'} detected (${errors} error${errors === 1 ? '' : 's'}). Run "Claudelike Bar: Diagnose" for details.`
    : `Claudelike Bar: ${bad.length} advisory — see the Claudelike Bar output channel or run "Claudelike Bar: Diagnose".`;
  const pick = await vscode.window.showWarningMessage(msg, 'Diagnose', 'Dismiss');
  if (pick === 'Diagnose') {
    await vscode.commands.executeCommand('claudeDashboard.diagnose');
  }
  await context.globalState.update(fingerprintKey, fingerprint);
}
