/**
 * v0.18.2 (#32) — duplicate-install detection.
 *
 * The extension ships under two publisher.name IDs:
 *   harteWired.claudelike-bar  (Open VSX, hyphenated, canonical)
 *   harteWired.claudelikebar   (MS Marketplace, no-hyphen workaround)
 *
 * Both IDs exist because Microsoft permanently reserves deleted extension
 * names (and their displayName) post-unpublish — the rebrand fumble forced
 * the no-hyphen variant into existence on Marketplace while Open VSX keeps
 * the canonical hyphenated name.
 *
 * When both IDs are installed concurrently, every view/title button doubles,
 * the hook fires twice per Claude event, status JSONs get double-written,
 * and any race-class bug (#16, #30) silently amplifies. This module detects
 * the state at activation and offers a one-click resolution.
 *
 * Both installed extensions activate independently and would each detect
 * the other. To avoid double-prompting the user, the lexicographically
 * smaller ID is the prompter; the other stands down. Deterministic, no
 * shared state, survives reinstalls.
 */

const KNOWN_IDS = ['harteWired.claudelike-bar', 'harteWired.claudelikebar'];

export interface DuplicateDetectDeps {
  /** This extension's id, e.g. context.extension.id. */
  ownId: string;
  /** Returns a truthy value when the named extension is installed. */
  getPeerExtension: (id: string) => unknown | undefined;
  /** vscode.window.showInformationMessage (or compatible). */
  showInformationMessage: (msg: string, ...actions: string[]) => Thenable<string | undefined>;
  /** Run `workbench.extensions.uninstallExtension <id>`. */
  uninstall: (id: string) => Thenable<unknown>;
  /** Run `workbench.action.reloadWindow`. */
  reload: () => void;
  /** Optional hook for log lines (silent in production by default). */
  log?: (msg: string) => void;
}

/**
 * Run the duplicate-install check. Returns the action taken (for tests).
 * Errors are swallowed — a busted detector should never block activation.
 */
export async function checkForDuplicateInstall(
  deps: DuplicateDetectDeps,
): Promise<'no-peer' | 'follower' | 'dismissed' | 'kept-self' | 'kept-peer' | 'errored'> {
  const log = deps.log ?? (() => {});
  try {
    const ownLower = deps.ownId.toLowerCase();
    const peerId = KNOWN_IDS.find((id) => id.toLowerCase() !== ownLower);
    if (!peerId) {
      log(`duplicate-detect: own id ${deps.ownId} not in KNOWN_IDS, skipping`);
      return 'no-peer';
    }
    if (!deps.getPeerExtension(peerId)) {
      return 'no-peer';
    }

    // Lexicographic prompter election: only the smaller id prompts.
    // Compare normalized (lowercased) ids so casing differences between
    // VS Code's runtime form and the constants in KNOWN_IDS don't flip
    // the election.
    const peerLower = peerId.toLowerCase();
    const prompterLower = [ownLower, peerLower].sort()[0];
    if (prompterLower !== ownLower) {
      log(`duplicate-detect: peer ${peerId} present but ${peerId} is the prompter; standing down`);
      return 'follower';
    }

    const message
      = `Two copies of Claudelike Bar are installed (${deps.ownId} and ${peerId}). `
      + `Running both doubles toolbar buttons, hook firings, and status JSON writes. Pick one to keep.`;
    const keepSelf = `Keep ${deps.ownId}`;
    const keepPeer = `Keep ${peerId}`;
    const pick = await deps.showInformationMessage(message, keepSelf, keepPeer);

    if (pick === keepSelf) {
      log(`duplicate-detect: user kept ${deps.ownId}; uninstalling ${peerId}`);
      await deps.uninstall(peerId);
      const reload = await deps.showInformationMessage(
        `Uninstalled ${peerId}. Reload window to complete the cleanup.`,
        'Reload Now',
      );
      if (reload === 'Reload Now') deps.reload();
      return 'kept-self';
    }
    if (pick === keepPeer) {
      log(`duplicate-detect: user kept ${peerId}; uninstalling ${deps.ownId}`);
      await deps.uninstall(deps.ownId);
      const reload = await deps.showInformationMessage(
        `Uninstalled ${deps.ownId}. Reload window to complete the cleanup.`,
        'Reload Now',
      );
      if (reload === 'Reload Now') deps.reload();
      return 'kept-peer';
    }
    log('duplicate-detect: user dismissed prompt');
    return 'dismissed';
  } catch (err) {
    log(`duplicate-detect: errored — ${(err as Error).message}`);
    return 'errored';
  }
}

/** Exposed for tests. */
export const _internals = { KNOWN_IDS };
