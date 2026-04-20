import * as vscode from 'vscode';
import * as fs from 'fs';
import { settingsPath, writeSettingsAtomic } from './claudePaths';

/**
 * Legacy Claude Code hook scripts that predate the v0.12 webview-audio
 * pipeline. Their jobs (terminal bell, per-project status JSON, shell-out
 * audio via paplay) are all handled by dashboard-status.js + AudioPlayer
 * now — but the old hook entries linger in users' ~/.claude/settings.json
 * and keep firing on every Stop / Notification event.
 *
 * The bell char inside notify-silent.sh was the specific trigger that
 * caused VS Code's built-in terminal chime to fire alongside the bar's
 * webview audio (observed 2026-04-19, documented in
 * vault/projects/vscode-enhancement/claudelike-bar-onboarding-proposal.md).
 *
 * This module only touches entries whose command string references one of
 * these script filenames. It never deletes files from ~/.claude/hooks/ —
 * the user keeps full control of the script source if they want to port
 * anything custom to a new hook.
 */

const LEGACY_SCRIPTS = ['notify.sh', 'notify-silent.sh'];

function referencesLegacyScript(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  // Accept either path separator so Windows-format commands
  // (`C:\Users\…\hooks\notify.sh`) match the same as POSIX.
  return LEGACY_SCRIPTS.some((name) =>
    cmd.includes(`/hooks/${name}`) || cmd.includes(`\\hooks\\${name}`),
  );
}

export interface LegacyHookDetection {
  /** Hook event names (e.g. `Stop`, `Notification`) that have legacy entries. */
  events: string[];
  /** Total number of legacy entries across all events. */
  count: number;
}

/** Scan settings.json for legacy hook registrations. Empty result when none. */
export function detectLegacyHooks(): LegacyHookDetection {
  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { events: [], count: 0 };
  }
  if (!settings?.hooks || typeof settings.hooks !== 'object') {
    return { events: [], count: 0 };
  }
  const events: string[] = [];
  let count = 0;
  for (const [event, entries] of Object.entries(settings.hooks) as [string, unknown][]) {
    if (!Array.isArray(entries)) continue;
    let eventHasLegacy = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const hooks = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (h && typeof h === 'object' && referencesLegacyScript((h as { command?: unknown }).command)) {
          count++;
          eventHasLegacy = true;
        }
      }
    }
    if (eventHasLegacy) events.push(event);
  }
  return { events, count };
}

/**
 * Surgically remove legacy hook entries from settings.json. Preserves every
 * other hook (including the canonical dashboard-status.js entry). Returns
 * the number of legacy entries removed. Atomic write via writeSettingsAtomic.
 */
export function removeLegacyHooks(): { removed: number } {
  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { removed: 0 };
  }
  if (!settings?.hooks || typeof settings.hooks !== 'object') {
    return { removed: 0 };
  }
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h: any) => !referencesLegacyScript(h?.command));
      removed += before - entry.hooks.length;
      // Drop the entry entirely if all its hooks were legacy — don't leave
      // empty `{ matcher: '', hooks: [] }` orphans.
      if (entry.hooks.length === 0) entries.splice(i, 1);
    }
  }
  if (removed > 0) writeSettingsAtomic(settings);
  return { removed };
}

/**
 * Palette command handler: "Claudelike Bar: Remove Legacy Hooks".
 * Always safe to run — no-op when nothing matches.
 */
export async function executeRemoveLegacyHooksCommand(log: (msg: string) => void): Promise<void> {
  try {
    const { removed } = removeLegacyHooks();
    log(`legacy-hooks: removed=${removed}`);
    const msg = removed > 0
      ? `Claudelike Bar: removed ${removed} legacy hook entr${removed === 1 ? 'y' : 'ies'} (notify.sh / notify-silent.sh). The script files in ~/.claude/hooks/ were left in place.`
      : 'Claudelike Bar: no legacy hooks found — nothing to remove.';
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`legacy-hooks removal failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: legacy-hook cleanup failed — ${msg}`);
  }
}

/**
 * First-activation check for legacy hooks. If any are registered and we
 * haven't prompted the user yet (per-globalState flag), show a one-shot
 * toast offering removal. Never blocks activation — fire-and-forget.
 */
export async function maybePromptLegacyHookCleanup(
  context: vscode.ExtensionContext,
  promptedKey: string,
  log: (msg: string) => void,
): Promise<void> {
  if (context.globalState.get<boolean>(promptedKey)) return;
  const { events, count } = detectLegacyHooks();
  if (count === 0) return;
  log(`legacy-hooks detected: ${count} entries across events ${events.join(', ')}`);
  const eventList = events.length <= 3 ? events.join(', ') : `${events.slice(0, 3).join(', ')}, …`;
  const pick = await vscode.window.showInformationMessage(
    `Claudelike Bar: found ${count} legacy notify.sh / notify-silent.sh hook entr${count === 1 ? 'y' : 'ies'} (on ${eventList}). These predate the bar's webview audio and are safe to remove — the script files stay in ~/.claude/hooks/.`,
    'Remove',
    'Keep',
    "Don't ask again",
  );
  if (pick === 'Remove') {
    await executeRemoveLegacyHooksCommand(log);
    await context.globalState.update(promptedKey, true);
  } else if (pick === "Don't ask again") {
    await context.globalState.update(promptedKey, true);
  }
  // 'Keep' or dismissed — we'll re-offer next activation.
}
