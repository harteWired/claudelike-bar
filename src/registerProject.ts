import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { TerminalTracker } from './terminalTracker';
import { launchRegisteredProject } from './launchProject';
import { deriveSlug } from './slug';
import { getDefaultColor } from './types';

type LogFn = (msg: string | (() => string)) => void;

const OPEN_NOW_LABEL = 'Open terminal now (default)';
const REGISTER_ONLY_LABEL = "Register only — I'll launch later";

/**
 * "Claudelike Bar: Register Project" — single-folder picker that adds a
 * project entry to the config with a proper `path`, auto-derived slug,
 * auto-assigned color, and `command: "claude"`.
 *
 * v0.13: a final QuickPick lets the user choose whether to open the
 * terminal immediately (the default — preserves muscle memory) or
 * register-only with `autoStart: false` (for "set up the whole list,
 * pick what to open later" workflows). Cancelling the QuickPick is
 * treated as "open now" so a quick Enter-Enter through the flow matches
 * pre-v0.13 behavior exactly.
 */
export async function executeRegisterProjectCommand(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  log: LogFn,
): Promise<void> {
  // 1. Folder picker
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    title: 'Select project folder',
    openLabel: 'Register',
  });
  if (!uris || uris.length === 0) {
    log('register-project: user cancelled folder picker');
    return;
  }
  const projectPath = uris[0].fsPath;

  // 2. Derive slug
  const existingSlugs = new Set(Object.keys(configManager.getAll()));
  const suggestedSlug = deriveSlug(projectPath, existingSlugs);

  // 3. Let user confirm or edit the name
  const slug = await vscode.window.showInputBox({
    prompt: 'Project name (used as the terminal name and config key)',
    value: suggestedSlug,
    validateInput: (value) => {
      if (!value || !value.trim()) return 'Name cannot be empty';
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
        return 'Use lowercase letters, numbers, and hyphens (no leading/trailing/consecutive hyphens)';
      }
      if (existingSlugs.has(value)) return `"${value}" is already in use`;
      return undefined;
    },
  });
  if (!slug) {
    log('register-project: user cancelled name input');
    return;
  }

  // 4. Open-now vs register-only branch. Default-selected item preserves
  //    muscle memory: hit Enter and the terminal opens like it did pre-v0.13.
  //    Treating Escape as "open now" preserves the same behavior for users
  //    who keyboard-quit the dialog.
  const choice = await vscode.window.showQuickPick(
    [OPEN_NOW_LABEL, REGISTER_ONLY_LABEL],
    {
      placeHolder: 'Open the terminal now, or register without launching?',
    },
  );
  const openNow = choice !== REGISTER_ONLY_LABEL;

  // 5. Add to config
  const command = configManager.getAutoStartCommand() ?? 'claude';
  configManager.addProjectEntry(slug, {
    path: projectPath,
    command,
    color: getDefaultColor(slug),
    icon: null,
    nickname: null,
    autoStart: openNow,
  });

  if (!openNow) {
    log(`register-project: added "${slug}" → ${projectPath}, register-only (no terminal)`);
    vscode.window.showInformationMessage(
      `Registered ${slug}. Launch via 'Launch Registered Project' or reload to auto-start next time.`,
    );
    return;
  }

  // 6. Open the terminal — route through the shared helper so the env /
  //    cwd / shell wiring matches the auto-start path exactly. The helper's
  //    "already open" guard is harmless here (we just added the slug, so
  //    nothing is tracked under that name yet) and gives us future-proofing
  //    if this command ever gets invoked on an existing slug.
  launchRegisteredProject(configManager, tracker, slug, log);

  log(`register-project: added "${slug}" → ${projectPath}, terminal opened`);
  vscode.window.showInformationMessage(
    `Claudelike Bar: "${slug}" registered and opened.`,
  );
}
