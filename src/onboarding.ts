import * as vscode from 'vscode';
import { runSetup, HOOKS_DOC_URL, isSetupComplete } from './setup';
import { runStatuslineSetup, isStatuslineConfigured, isClaudelikeStatuslineActive } from './statusline';

/**
 * Onboarding orchestration — coordinates the otherwise-independent
 * `setup.ts` (hooks) and `statusline.ts` (context %) modules.
 *
 * This file is the ONLY place where both modules meet. Neither setup.ts
 * nor statusline.ts knows about the other; this keeps them true separate
 * concerns that can be exercised or extended independently.
 */

/**
 * First-activation notification. Offers to install hooks (+ statusline if
 * nothing is already registered). Returns after the user dismisses or picks
 * an action.
 */
export async function showOnboardingNotification(
  extensionPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    'Claudelike Bar needs to install a Claude Code hook so tiles reflect live status. ' +
    'Nothing is written outside ~/.claude/.',
    { modal: false },
    'Install',
    'Show me the hooks',
    'Later',
  );

  if (pick === 'Install') {
    await runFullInstall(extensionPath, log);
  } else if (pick === 'Show me the hooks') {
    await vscode.env.openExternal(vscode.Uri.parse(HOOKS_DOC_URL));
  }
  // 'Later' or dismissed — user can run commands from the palette any time.
}

/**
 * Install hooks, then install the statusline only if no statusline is
 * currently configured. The existing statusline (if any) is NEVER replaced
 * during onboarding — users who want to switch must run
 * "Claudelike Bar: Install Statusline" explicitly.
 */
export async function runFullInstall(extensionPath: string, log: (msg: string) => void): Promise<void> {
  const messages: string[] = [];

  // 1. Hooks — always runs, idempotent.
  try {
    const { added, migrated } = await runSetup(extensionPath);
    log(`hooks: added=${added}, migrated=${migrated}`);
    if (added > 0) messages.push(`registered ${added} hook event(s)`);
    else if (migrated > 0) messages.push(`migrated ${migrated} legacy reference(s)`);
    else messages.push('hooks already in place');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`hooks setup failed: ${msg}`);
    vscode.window.showErrorMessage(`Claudelike Bar: hook install failed — ${msg}`);
    return;
  }

  // 2. Statusline — only if no statusline is configured, or ours is active.
  // Never replaces a user's existing statusline during onboarding.
  const hasOtherStatusline = isStatuslineConfigured() && !isClaudelikeStatuslineActive();
  if (hasOtherStatusline) {
    log('statusline: existing configured — not touching');
    messages.push('kept your existing statusline (context % comes from it if it writes to the status file)');
  } else {
    try {
      const result = await runStatuslineSetup(extensionPath, false);
      log(`statusline: scriptInstalled=${result.scriptInstalled}, settingsUpdated=${result.settingsUpdated}, reason=${result.reason ?? '-'}`);
      if (result.settingsUpdated) {
        messages.push('installed statusline (for context %)');
      } else {
        messages.push('statusline already configured');
      }
    } catch (err) {
      // Statusline failure is non-fatal — hooks still work.
      const msg = err instanceof Error ? err.message : String(err);
      log(`statusline setup failed: ${msg}`);
      messages.push(`statusline install failed: ${msg}`);
    }
  }

  vscode.window.showInformationMessage(
    `Claudelike Bar: ${messages.join(', ')}. Tiles will update on your next Claude turn.`,
  );
}

export { isSetupComplete };
