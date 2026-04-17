import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager, TerminalConfig } from './configManager';
import { deriveSlug } from './slug';
import { ThemeGroup } from './types';
import { runFullInstall } from './onboarding';
import { isSetupComplete } from './setup';

// ═══════════════════════════════════════════════════════════════
//  Pure functions — testable without VS Code APIs
// ═══════════════════════════════════════════════════════════════

const ALL_COLORS: ThemeGroup[] = ['cyan', 'green', 'blue', 'magenta', 'yellow', 'white'];

/**
 * Scan a directory for child directories up to `depth` levels deep.
 * Returns absolute paths, sorted alphabetically.
 */
export function scanForProjects(parentDir: string, depth = 1): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      results.push(path.join(parentDir, entry.name));
    }
  } catch {
    return [];
  }

  if (depth > 1) {
    const topLevel = results.length;
    for (let i = 0; i < topLevel; i++) {
      results.push(...scanForProjects(results[i], depth - 1));
    }
  }

  return results.sort();
}

/**
 * Derive slug assignments for a set of folder paths. Returns a map
 * of path → slug, ensuring no collisions with each other or with
 * existing config slugs.
 */
export function buildSlugAssignments(
  folderPaths: string[],
  existingSlugs: Set<string>,
): Map<string, string> {
  const assignments = new Map<string, string>();
  const allSlugs = new Set(existingSlugs);

  for (const folderPath of folderPaths) {
    const slug = deriveSlug(folderPath, allSlugs);
    assignments.set(folderPath, slug);
    allSlugs.add(slug);
  }

  return assignments;
}

/**
 * Assign colors round-robin from the palette. Skips colors already
 * in use by existing config entries.
 */
export function assignColors(
  slugs: string[],
  existingColors: Map<string, ThemeGroup | 'red'>,
): Map<string, ThemeGroup> {
  const usedColors = new Set(existingColors.values());
  const available = ALL_COLORS.filter(c => !usedColors.has(c));
  const palette = available.length > 0 ? available : ALL_COLORS;

  const assignments = new Map<string, ThemeGroup>();
  for (let i = 0; i < slugs.length; i++) {
    assignments.set(slugs[i], palette[i % palette.length]);
  }
  return assignments;
}

export interface WizardProjectEntry {
  slug: string;
  path: string;
  color: ThemeGroup;
  command: string | null;
}

/**
 * Build the final config entries from wizard selections.
 * Pure function — no side effects.
 */
export function buildProjectEntries(
  projects: WizardProjectEntry[],
): Record<string, TerminalConfig> {
  const entries: Record<string, TerminalConfig> = {};
  for (const p of projects) {
    entries[p.slug] = {
      path: p.path,
      command: p.command,
      color: p.color,
      icon: null,
      nickname: null,
      autoStart: true,
    };
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════
//  VS Code UI flow — thin wrapper over pure functions
// ═══════════════════════════════════════════════════════════════

interface WizardState {
  folders: string[];
  slugAssignments: Map<string, string>;
  colorAssignments: Map<string, ThemeGroup>;
  command: string | null;
  startFresh: boolean;
}

interface StepPickResult {
  folders: string[];
  startFresh: boolean;
}

/**
 * Step 1: Pick project folders.
 * Returns selected folder paths + whether to clear existing config.
 */
async function stepPickFolders(hasExistingTerminals: boolean): Promise<StepPickResult | undefined> {
  const items = [
    { label: '$(folder-opened) Browse for folders...', value: 'browse' },
    { label: '$(search) Scan workspace folders', value: 'scan', description: 'immediate children of workspace root' },
  ];
  if (hasExistingTerminals) {
    items.push({ label: '$(refresh) Start fresh', value: 'fresh', description: 'clear existing config and re-pick all projects' });
  }

  const source = await vscode.window.showQuickPick(
    items,
    {
      title: 'Set Up Projects (1/5): Choose project folders',
      placeHolder: 'How would you like to add projects?',
    },
  );

  if (!source) return undefined;

  const startFresh = source.value === 'fresh';
  const browseOrFresh = source.value === 'browse' || startFresh;

  if (browseOrFresh) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      title: startFresh ? 'Select ALL project folders (existing config will be replaced)' : 'Select project folders',
      openLabel: startFresh ? 'Replace Config' : 'Add Projects',
    });
    if (!uris || uris.length === 0) return undefined;
    return { folders: uris.map(u => u.fsPath), startFresh };
  }

  // Scan workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('No workspace folders open. Use "Browse for folders" instead.');
    return undefined;
  }

  const candidates: string[] = [];
  for (const wf of workspaceFolders) {
    candidates.push(...scanForProjects(wf.uri.fsPath));
  }

  if (candidates.length === 0) {
    vscode.window.showWarningMessage('No subdirectories found in workspace folders.');
    return undefined;
  }

  const pickItems = candidates.map(p => ({
    label: path.basename(p),
    description: p,
    picked: true,
    value: p,
  }));

  const selected = await vscode.window.showQuickPick(pickItems, {
    title: 'Set Up Projects (1/5): Select projects to add',
    placeHolder: 'Uncheck any you want to skip',
    canPickMany: true,
  });

  if (!selected || selected.length === 0) return undefined;
  return { folders: selected.map(s => s.value), startFresh: false };
}

/**
 * Step 2: Confirm/edit slug assignments.
 * Shows each path → slug and lets user edit any.
 */
async function stepConfirmSlugs(
  folders: string[],
  existingSlugs: Set<string>,
): Promise<Map<string, string> | undefined> {
  const assignments = buildSlugAssignments(folders, existingSlugs);

  while (true) {
    const items = folders.map(f => ({
      label: `$(edit) ${assignments.get(f)!}`,
      description: f,
      value: f,
    }));

    const editChoice = await vscode.window.showQuickPick(
      [
        { label: '$(check) Accept all names', value: 'accept' },
        ...items,
      ],
      {
        title: 'Set Up Projects (2/5): Confirm project names',
        placeHolder: 'Accept all, or select one to rename',
      },
    );

    if (!editChoice) return undefined;
    if (editChoice.value === 'accept') return assignments;

    const pathToEdit = editChoice.value;
    const currentSlug = assignments.get(pathToEdit)!;
    const otherSlugs = new Set([...existingSlugs, ...assignments.values()]);
    otherSlugs.delete(currentSlug);

    const newSlug = await vscode.window.showInputBox({
      prompt: `Rename "${currentSlug}" (${pathToEdit})`,
      value: currentSlug,
      validateInput: (value) => {
        if (!value || !value.trim()) return 'Name cannot be empty';
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
          return 'Use lowercase letters, numbers, and hyphens';
        }
        if (otherSlugs.has(value)) return `"${value}" is already in use`;
        return undefined;
      },
    });

    if (!newSlug) return undefined;
    assignments.set(pathToEdit, newSlug);
  }
}

/**
 * Step 3: Assign colors (auto round-robin, or let user pick).
 */
async function stepAssignColors(
  slugAssignments: Map<string, string>,
  existingColors: Map<string, ThemeGroup | 'red'>,
): Promise<Map<string, ThemeGroup> | undefined> {
  const slugs = [...slugAssignments.values()];
  const autoColors = assignColors(slugs, existingColors);

  const preview = slugs.map(s => `${s} (${autoColors.get(s)})`).join(', ');

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(paintcan) Auto-assign colors', description: preview, value: 'auto' },
      { label: '$(symbol-color) Pick colors manually...', value: 'manual' },
    ],
    {
      title: 'Set Up Projects (3/5): Assign colors',
      placeHolder: 'Colors can be changed later in the config or by telling Claude',
    },
  );

  if (!choice) return undefined;
  if (choice.value === 'auto') return autoColors;

  // Manual: let user pick color for each project
  const manualColors = new Map<string, ThemeGroup>();
  for (const slug of slugs) {
    const colorItems = ALL_COLORS.map(c => ({
      label: `$(circle-filled) ${c}`,
      value: c,
    }));
    const pick = await vscode.window.showQuickPick(colorItems, {
      title: `Color for "${slug}"`,
      placeHolder: `Pick a color for ${slug}`,
    });
    if (!pick) return undefined;
    manualColors.set(slug, pick.value as ThemeGroup);
  }
  return manualColors;
}

/**
 * Step 4: Choose startup command (applied to all projects).
 */
async function stepChooseCommand(): Promise<{ command: string | null; cancelled: boolean }> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'claude', description: 'default', value: 'claude' },
      { label: 'claude --dangerously-skip-permissions', description: 'auto-approve all tools', value: 'claude --dangerously-skip-permissions' },
      { label: 'Custom command...', value: '__custom__' },
      { label: 'None (just open the terminal)', value: '__none__' },
    ],
    {
      title: 'Set Up Projects (4/5): Startup command',
      placeHolder: 'What command should auto-started terminals run? (can override per-project later)',
    },
  );

  if (!choice) return { command: null, cancelled: true };
  if (choice.value === '__none__') return { command: null, cancelled: false };
  if (choice.value === '__custom__') {
    const custom = await vscode.window.showInputBox({
      prompt: 'Enter the command to run in each terminal',
      placeHolder: 'e.g., claude --model sonnet',
    });
    if (custom === undefined) return { command: null, cancelled: true };
    return { command: custom || null, cancelled: false };
  }
  return { command: choice.value, cancelled: false };
}

/**
 * Step 5: Review and confirm.
 */
async function stepReview(state: WizardState): Promise<boolean> {
  const lines: string[] = [];
  for (const folderPath of state.folders) {
    const slug = state.slugAssignments.get(folderPath)!;
    const color = state.colorAssignments.get(slug) ?? 'white';
    lines.push(`  ${slug} (${color}) — ${folderPath}`);
  }

  const summaryParts = [
    `Ready to configure ${state.folders.length} project(s):`,
    '',
    ...lines,
    '',
    `Command: ${state.command ?? '(none)'}`,
    `Config: ~/.claude/claudelike-bar.jsonc`,
  ];
  if (state.startFresh) {
    summaryParts.push('(existing terminal entries will be replaced)');
  }
  const summary = summaryParts.join('\n');

  const confirm = await vscode.window.showQuickPick(
    [
      { label: '$(check) Confirm', value: 'confirm' },
      { label: '$(close) Cancel', value: 'cancel' },
    ],
    {
      title: `Set Up Projects (5/5): Review`,
      placeHolder: summary,
    },
  );

  return confirm?.value === 'confirm';
}

/**
 * Run the full setup wizard. Orchestrates the 5-step QuickPick flow
 * and writes results to the global config via ConfigManager.
 */
export async function runSetupWizard(
  configManager: ConfigManager,
  extensionPath: string,
  log: (msg: string) => void,
): Promise<void> {
  // Step 1: Pick folders
  const hasExisting = Object.keys(configManager.getAll()).length > 0;
  const pickResult = await stepPickFolders(hasExisting);
  if (!pickResult) {
    log('wizard: cancelled at step 1 (folder selection)');
    return;
  }
  const { folders, startFresh } = pickResult;

  // Step 2: Confirm slugs — start-fresh ignores existing slugs
  const existingSlugs = startFresh ? new Set<string>() : new Set(Object.keys(configManager.getAll()));
  const slugAssignments = await stepConfirmSlugs(folders, existingSlugs);
  if (!slugAssignments) {
    log('wizard: cancelled at step 2 (slug assignment)');
    return;
  }

  // Step 3: Assign colors — start-fresh ignores existing colors
  const existingColors = new Map<string, ThemeGroup | 'red'>();
  if (!startFresh) {
    for (const [name, cfg] of Object.entries(configManager.getAll())) {
      existingColors.set(name, cfg.color);
    }
  }
  const colorAssignments = await stepAssignColors(slugAssignments, existingColors);
  if (!colorAssignments) {
    log('wizard: cancelled at step 3 (color assignment)');
    return;
  }

  // Step 4: Choose command
  const { command, cancelled } = await stepChooseCommand();
  if (cancelled) {
    log('wizard: cancelled at step 4 (command selection)');
    return;
  }

  // Step 5: Review
  const state: WizardState = { folders, slugAssignments, colorAssignments, command, startFresh };
  const confirmed = await stepReview(state);
  if (!confirmed) {
    log('wizard: cancelled at step 5 (review)');
    return;
  }

  // Clear existing terminals if starting fresh
  if (startFresh) {
    configManager.clearTerminals();
    log('wizard: cleared existing terminal entries (start fresh)');
  }

  // Build entries and write to config
  const projects: WizardProjectEntry[] = folders.map(f => ({
    slug: slugAssignments.get(f)!,
    path: f,
    color: colorAssignments.get(slugAssignments.get(f)!) ?? 'white',
    command,
  }));

  const entries = buildProjectEntries(projects);
  let added = 0;
  for (const [slug, entry] of Object.entries(entries)) {
    if (configManager.addProjectEntry(slug, entry)) {
      added++;
    }
  }

  // Install hooks if not already done
  if (!isSetupComplete()) {
    await runFullInstall(extensionPath, log);
  }

  log(`wizard: added ${added} project(s)`);
  vscode.window.showInformationMessage(
    `Claudelike Bar: configured ${added} project(s). ` +
    `${added > 0 ? 'Terminals will auto-start on next VS Code launch.' : 'All projects were already configured.'}`,
  );
}
