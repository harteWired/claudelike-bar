import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConfigManager, TerminalConfig } from './configManager';
import { TerminalTracker } from './terminalTracker';

type LogFn = (msg: string | (() => string)) => void;

/**
 * v0.13 — canonical launch path. Both the auto-start loop and the new
 * "Launch Registered Project" command call through this so there's one
 * source of truth for how a registered terminal gets created.
 *
 * Behavior:
 *   - If a terminal with this name is already tracked, focus it (`.show()`)
 *     and return undefined — never create a duplicate.
 *   - Otherwise, build createTerminal options from
 *     `getAutoStartTerminalOptions` + `getAutoStartCommand` (same path the
 *     pre-v0.13 inline `runAutoStart` body used) and spawn it.
 *
 * The cwd-existence pre-flight (#13) belongs in this one function so both
 * call sites benefit from it.
 */
export function launchRegisteredProject(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  name: string,
  log: LogFn,
): vscode.Terminal | undefined {
  const existing = tracker.getTerminalByName(name);
  if (existing) {
    log(`launch: ${name} already open, focusing`);
    existing.show();
    return undefined;
  }

  const opts = configManager.getAutoStartTerminalOptions(name);
  const terminal = vscode.window.createTerminal({
    name,
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.shellPath ? { shellPath: opts.shellPath } : {}),
    ...(opts.shellArgs ? { shellArgs: opts.shellArgs } : {}),
  });

  const command = configManager.getAutoStartCommand(name);
  if (command) {
    log(() => `launch: ${name} → ${command}${opts.cwd ? ` [cwd: ${opts.cwd}]` : ''}${opts.shellPath ? ` [shell: ${opts.shellPath}]` : ''}`);
    terminal.sendText(command);
  } else {
    log(() => `launch: ${name} → (no command)${opts.cwd ? ` [cwd: ${opts.cwd}]` : ''}${opts.shellPath ? ` [shell: ${opts.shellPath}]` : ''}`);
  }
  terminal.show();
  return terminal;
}

interface LaunchCandidate {
  slug: string;
  cfg: TerminalConfig;
}

/**
 * Sort candidates per `sortMode`:
 *   - manual: ascending `order`, unordered entries last (then by slug).
 *   - auto:   alphabetical by slug.
 *
 * Pulled out so tests can pin the rule without driving the QuickPick.
 */
function sortCandidates(
  candidates: LaunchCandidate[],
  mode: 'auto' | 'manual',
): LaunchCandidate[] {
  const sorted = [...candidates];
  if (mode === 'manual') {
    sorted.sort((a, b) => {
      const ao = a.cfg.order;
      const bo = b.cfg.order;
      if (ao === undefined && bo === undefined) return a.slug.localeCompare(b.slug);
      if (ao === undefined) return 1;
      if (bo === undefined) return -1;
      if (ao !== bo) return ao - bo;
      return a.slug.localeCompare(b.slug);
    });
  } else {
    sorted.sort((a, b) => a.slug.localeCompare(b.slug));
  }
  return sorted;
}

/**
 * Filter + sort the registered projects to those eligible for the
 * "Launch Registered Project" QuickPick:
 *   - skip entries whose slug matches a currently-tracked terminal
 *   - skip entries whose `path` is set but doesn't exist on disk
 *
 * Pure (apart from the fs.existsSync probe) so it's directly testable.
 */
export function buildLaunchCandidates(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  pathExists: (p: string) => boolean = (p) => {
    try { return fs.existsSync(p); } catch { return false; }
  },
): LaunchCandidate[] {
  const all = configManager.getAll();
  const openNames = new Set(tracker.getTiles().map((t) => t.name));
  const open: LaunchCandidate[] = [];
  for (const [slug, cfg] of Object.entries(all)) {
    if (openNames.has(slug)) continue;
    if (cfg.path && !pathExists(cfg.path)) continue;
    open.push({ slug, cfg });
  }
  return sortCandidates(open, configManager.getSortMode());
}

interface LaunchQuickPickItem extends vscode.QuickPickItem {
  slug: string;
}

/**
 * Build a QuickPick item for a candidate. Label = nickname || slug.
 * Description echoes the slug only when it differs from the label
 * (so the QuickPick row stays clean when the user hasn't set a nickname).
 * Detail is "{path} · {command}" — mirrors the layout other VS Code
 * launchers use.
 */
function toQuickPickItem(
  candidate: LaunchCandidate,
  configManager: ConfigManager,
): LaunchQuickPickItem {
  const { slug, cfg } = candidate;
  const label = cfg.nickname || slug;
  const description = label === slug ? undefined : slug;
  const command = configManager.getAutoStartCommand(slug);
  const pathPart = cfg.path ?? '(no path)';
  const cmdPart = command ?? '(no command)';
  const detail = `${pathPart} · ${cmdPart}`;
  return { label, description, detail, slug };
}

/**
 * Command implementation for `claudeDashboard.launchProject`. Enumerates
 * the registered projects, filters out everything already-open or with a
 * dead path, surfaces a QuickPick, and routes the chosen slug through
 * `launchRegisteredProject`.
 */
export async function executeLaunchProjectCommand(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  log: LogFn,
): Promise<void> {
  const candidates = buildLaunchCandidates(configManager, tracker);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      'Claudelike Bar: no registered projects to launch — everything in your config is already open.',
    );
    return;
  }

  const items = candidates.map((c) => toQuickPickItem(c, configManager));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Launch which project?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    log('launch-project: user cancelled QuickPick');
    return;
  }

  // Route by slug, NOT label — a nickname-as-key would not match the
  // config entry and would skip the already-open guard.
  launchRegisteredProject(configManager, tracker, picked.slug, log);
}
