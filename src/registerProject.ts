import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './configManager';
import { deriveSlug } from './slug';
import { getDefaultColor } from './types';

/**
 * "Claudelike Bar: Register Project" — single-folder picker that adds a
 * project entry to the config with a proper `path`, auto-derived slug,
 * auto-assigned color, and `command: "claude"`.
 *
 * This is the v0.10 incremental: one project at a time. The multi-folder
 * setup wizard is v0.11.
 */
export async function executeRegisterProjectCommand(
  configManager: ConfigManager,
  log: (msg: string) => void,
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

  // 4. Add to config
  configManager.addProjectEntry(slug, {
    path: projectPath,
    command: 'claude',
    color: getDefaultColor(slug),
    icon: null,
    nickname: null,
    autoStart: false,
  });

  log(`register-project: added "${slug}" → ${projectPath}`);
  vscode.window.showInformationMessage(
    `Claudelike Bar: registered "${slug}" at ${projectPath}. Set "autoStart": true in the config to launch it on VS Code open.`,
  );
}
