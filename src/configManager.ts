import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { ThemeGroup, getDefaultColor, ICON_MAP } from './types';

export interface TerminalConfig {
  color: ThemeGroup | 'red';
  icon: string | null;
  nickname: string | null;
  autoStart: boolean;
  command?: string | null;
  order?: number;
}

export interface ContextThresholds {
  warn: number;
  crit: number;
}

export type SortMode = 'auto' | 'manual';

export interface ConfigFile {
  $schema?: string;
  description?: string;
  mode?: 'chill' | 'passive-aggressive';
  sortMode?: SortMode;
  claudeCommand?: string | null;
  debug?: boolean;
  labels?: Partial<Record<string, string>>;
  contextThresholds?: Partial<ContextThresholds>;
  ignoredTexts?: string[];
  terminals: Record<string, TerminalConfig>;
}

const CONFIG_FILENAME = '.claudelike-bar.jsonc';
const LEGACY_CONFIG_FILENAME = '.claudelike-bar.json';

const DEFAULT_LABELS: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  ready: 'Ready for input',
  waiting: 'Waiting...',
  done: 'Done',
};

const DEFAULT_IGNORED_TEXTS = [
  'Being ignored :(',
  'Hello? Anyone?',
  "I'll just wait here then",
  'This is fine',
  'You have other terminals?',
  'Patiently judging you',
  'Still here btw',
  "I guess I'm not important",
  'Take your time, no rush',
  "It's not like I'm waiting or anything",
];

const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = { warn: 30, crit: 50 };

export class ConfigManager implements vscode.Disposable {
  private config: ConfigFile = { terminals: {} };
  private configPath: string;
  private legacyConfigPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  private writeDebounce: ReturnType<typeof setTimeout> | undefined;
  private isSaving = false;
  private isSavingTimer: ReturnType<typeof setTimeout> | undefined;
  private hasShownWriteError = false;
  private mergedLabels: Record<string, string> = { ...DEFAULT_LABELS };

  constructor() {
    // Place config in workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath ?? '/workspace';
    this.configPath = path.join(root, CONFIG_FILENAME);
    this.legacyConfigPath = path.join(root, LEGACY_CONFIG_FILENAME);

    this.load();
    this.setupWatcher();
    this.disposables.push(this.onChangeEmitter);
  }

  private load(): void {
    // Try new JSONC file first
    if (fs.existsSync(this.configPath)) {
      this.loadFrom(this.configPath);
      return;
    }

    // Migrate legacy JSON file if it exists
    if (fs.existsSync(this.legacyConfigPath)) {
      this.loadFrom(this.legacyConfigPath);
      // Write in new format and remove old file
      this.save();
      try {
        fs.unlinkSync(this.legacyConfigPath);
      } catch {
        // Best-effort cleanup
      }
      return;
    }

    // No config file — start fresh
  }

  private loadFrom(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseJsonc(content);
      if (parsed && typeof parsed.terminals === 'object') {
        this.config = parsed;
        this.mergedLabels = { ...DEFAULT_LABELS, ...this.config.labels };
      }
    } catch {
      // File is malformed — start fresh
    }
  }

  private setupWatcher(): void {
    const dir = path.dirname(this.configPath);
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), CONFIG_FILENAME);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => {
      if (this.isSaving) return; // skip reload from our own write
      this.loadFrom(this.configPath);
      this.mergedLabels = { ...DEFAULT_LABELS, ...this.config.labels };
      this.onChangeEmitter.fire();
    };

    this.disposables.push(
      this.watcher.onDidChange(reload),
      this.watcher.onDidCreate(reload),
      this.watcher.onDidDelete(() => {
        if (this.isSaving) return;
        this.config = { terminals: {} };
        this.onChangeEmitter.fire();
      }),
      this.watcher,
    );
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getMode(): 'chill' | 'passive-aggressive' {
    return this.config.mode === 'passive-aggressive' ? 'passive-aggressive' : 'chill';
  }

  getLabel(status: string): string {
    return this.mergedLabels[status] ?? status;
  }

  getIgnoredTexts(): string[] {
    if (this.config.ignoredTexts && this.config.ignoredTexts.length > 0) {
      return this.config.ignoredTexts;
    }
    return DEFAULT_IGNORED_TEXTS;
  }

  getContextThresholds(): ContextThresholds {
    return {
      warn: this.config.contextThresholds?.warn ?? DEFAULT_CONTEXT_THRESHOLDS.warn,
      crit: this.config.contextThresholds?.crit ?? DEFAULT_CONTEXT_THRESHOLDS.crit,
    };
  }

  /** Whether debug logging is enabled. */
  isDebugEnabled(): boolean {
    return this.config.debug === true;
  }

  /**
   * Get the command to run in an auto-started terminal.
   * Per-terminal `command` overrides the global `claudeCommand`.
   * Null/empty means don't run anything.
   */
  getAutoStartCommand(terminalName?: string): string | null {
    if (terminalName) {
      const override = this.config.terminals[terminalName]?.command;
      if (override !== undefined) {
        return override === null || override === '' ? null : override;
      }
    }
    const cmd = this.config.claudeCommand;
    if (cmd == null || cmd === '') return null;
    return cmd;
  }

  /** Get config for a terminal, or undefined if not in the file. */
  getTerminal(name: string): TerminalConfig | undefined {
    return this.config.terminals[name];
  }

  /** Get all terminal configs (shallow copy). */
  getAll(): Record<string, TerminalConfig> {
    return { ...this.config.terminals };
  }

  /** Get terminals marked for auto-start. */
  getAutoStartTerminals(): string[] {
    return Object.entries(this.config.terminals)
      .filter(([, cfg]) => cfg.autoStart)
      .map(([name]) => name);
  }

  /**
   * Ensure a terminal has an entry in the config file.
   * If it already exists, does nothing. If new, appends with defaults and writes.
   */
  ensureEntry(name: string): void {
    if (this.config.terminals[name]) return;

    this.config.terminals[name] = {
      color: getDefaultColor(name),
      icon: ICON_MAP[name] ?? null,
      nickname: null,
      autoStart: false,
    };

    this.scheduleSave();
  }

  /** Update the color for a terminal in the config file. */
  setColor(name: string, color: ThemeGroup | 'red' | undefined): void {
    const entry = this.config.terminals[name];
    if (!entry) return;
    entry.color = color ?? getDefaultColor(name);
    this.scheduleSave();
  }

  /**
   * Assign sequential `order` values to terminals by name. Names not in the
   * list are left with whatever order they already had. Used by drag-and-drop
   * reordering in the webview.
   */
  setOrder(orderedNames: string[]): void {
    orderedNames.forEach((name, index) => {
      const entry = this.config.terminals[name];
      if (entry) entry.order = index;
    });
    this.scheduleSave();
  }

  /**
   * Atomic drag-reorder: clear stale `order` values on every terminal entry,
   * assign sequential orders to the provided names, and flip `sortMode` to
   * `"manual"`. Called by the tracker when the user drags a tile. Keeps the
   * "dragging implies manual sort" policy in one place.
   */
  applyDragOrder(orderedNames: string[]): void {
    if (orderedNames.length === 0) return;
    // Wipe all orders first — avoids collisions with entries for terminals
    // that aren't currently open but still have a stale `order` field.
    for (const cfg of Object.values(this.config.terminals)) {
      delete cfg.order;
    }
    orderedNames.forEach((name, index) => {
      const entry = this.config.terminals[name];
      if (entry) entry.order = index;
    });
    this.config.sortMode = 'manual';
    this.scheduleSave();
  }

  /** True if any terminal has an explicit `order` set. */
  hasExplicitOrder(): boolean {
    for (const cfg of Object.values(this.config.terminals)) {
      if (typeof cfg.order === 'number') return true;
    }
    return false;
  }

  /** Resolve the sort mode. Defaults to 'auto' when unset. */
  getSortMode(): SortMode {
    return this.config.sortMode === 'manual' ? 'manual' : 'auto';
  }

  /** Force the sort mode (used when the user drags a tile). */
  setSortMode(mode: SortMode): void {
    if (this.config.sortMode === mode) return;
    this.config.sortMode = mode;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    // Debounce writes so rapid terminal opens don't thrash the file
    if (this.writeDebounce) clearTimeout(this.writeDebounce);
    this.writeDebounce = setTimeout(() => this.save(), 200);
  }

  private save(): void {
    const output = this.generateConfigText();

    this.isSaving = true;
    if (this.isSavingTimer) clearTimeout(this.isSavingTimer);
    try {
      fs.writeFileSync(this.configPath, output, 'utf-8');
      this.hasShownWriteError = false;
    } catch (err) {
      console.error('claudelike-bar: failed to write config', err);
      if (!this.hasShownWriteError) {
        this.hasShownWriteError = true;
        vscode.window.showErrorMessage(`Claudelike Bar: failed to save config — ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      // Clear the flag after a short delay to outlast the watcher event
      this.isSavingTimer = setTimeout(() => { this.isSaving = false; this.isSavingTimer = undefined; }, 100);
    }
  }

  /**
   * Build the full JSONC config string with section headers and inline comments.
   * Comments are regenerated on every save — they're part of the format, not user content.
   */
  private generateConfigText(): string {
    const mode = this.getMode();
    const sortMode = this.getSortMode();
    const claudeCommand = this.config.claudeCommand ?? null;
    const debug = this.config.debug === true;
    const labels = { ...DEFAULT_LABELS, ...this.config.labels };
    const thresholds = this.getContextThresholds();
    const ignoredTexts = this.getIgnoredTexts();
    const terminals = this.config.terminals;

    const indent = (json: string, spaces: number): string =>
      json.replace(/\n/g, '\n' + ' '.repeat(spaces));

    const lines: string[] = [
      '// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      '//  CLAUDELIKE BAR CONFIGURATION',
      '// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      '//  Edit this file directly \u2014 changes are picked up live.',
      '//  Open from VS Code: click the \u2699 gear in the Claudelike Bar.',
      '{',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  BIG KNOBS                                      \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '',
      '  // Personality mode \u2014 how the bar reacts when you ignore a terminal:',
      '  //   "chill"              \u2014 terminals quietly fade to "Done"',
      '  //   "passive-aggressive" \u2014 guilt-trips you with snarky messages',
      `  "mode": ${JSON.stringify(mode)},`,
      '',
      '  // How tiles are ordered in the sidebar:',
      '  //   "auto"   — sort by status (waiting → ready → working → done → idle)',
      '  //   "manual" — respect the drag-and-drop order from `terminals[].order`.',
      '  // Dragging a tile automatically flips this to "manual".',
      `  "sortMode": ${JSON.stringify(sortMode)},`,
      '',
      '  // Command to send to auto-started terminals after they open.',
      '  // null / empty = just open the terminal, don\'t run anything.',
      '  // Example: "claude --dangerously-skip-permissions"',
      `  "claudeCommand": ${JSON.stringify(claudeCommand)},`,
      '',
      '  // Debug logging — when true, the extension logs to the "Claudelike Bar"',
      '  // output channel AND the hook script writes /tmp/claude-dashboard/debug.log.',
      '  // Use this to diagnose stuck tiles or missing status events.',
      `  "debug": ${JSON.stringify(debug)},`,
      '',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  FINE TUNING                                    \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '',
      '  // Status labels \u2014 customize the text shown for each terminal state.',
      '  // Keys: idle, working, ready, waiting, done',
      `  "labels": ${indent(JSON.stringify(labels, null, 4), 2)},`,
      '',
      '  // Context window usage thresholds (percentage of Claude\'s context used).',
      '  //   warn \u2014 tile turns yellow     crit \u2014 tile turns red',
      `  "contextThresholds": ${indent(JSON.stringify(thresholds, null, 4), 2)},`,
      '',
      '  // Passive-aggressive mode messages. Shown when you glance at a waiting',
      '  // terminal and switch away without acting. Only used in "passive-aggressive" mode.',
      '  // Add, remove, or edit these \u2014 one is picked at random each time.',
      `  "ignoredTexts": ${indent(JSON.stringify(ignoredTexts, null, 4), 2)},`,
      '',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  TERMINALS \u2014 per-project overrides              \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '  // New terminals are auto-added here when first opened.',
      '  //',
      '  // color:     cyan | green | blue | magenta | yellow | white | red',
      '  // icon:      any VS Code codicon (calendar, server, notebook, lock, etc.)',
      '  // nickname:  display name override (null = use terminal name)',
      '  // autoStart: true = open this terminal when VS Code starts',
      '  // command:   override the global claudeCommand for this terminal (omit to inherit)',
      `  "terminals": ${indent(JSON.stringify(terminals, null, 4), 2)}`,
      '}',
      '',
    ];

    return lines.join('\n');
  }

  dispose(): void {
    if (this.writeDebounce) {
      clearTimeout(this.writeDebounce);
      this.save(); // flush pending writes
    }
    if (this.isSavingTimer) {
      clearTimeout(this.isSavingTimer);
      this.isSavingTimer = undefined;
    }
    for (const d of this.disposables) d.dispose();
  }
}
