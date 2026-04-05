import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ThemeGroup, getDefaultColor } from './types';

export interface TerminalConfig {
  color: ThemeGroup | 'red';
  nickname: string | null;
  autoStart: boolean;
}

export interface ConfigFile {
  $schema?: string;
  description?: string;
  terminals: Record<string, TerminalConfig>;
}

const CONFIG_FILENAME = '.claudelike-bar.json';

export class ConfigManager implements vscode.Disposable {
  private config: ConfigFile = { terminals: {} };
  private configPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  private writeDebounce: ReturnType<typeof setTimeout> | undefined;
  private isSaving = false;

  constructor() {
    // Place config in workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath ?? '/workspace';
    this.configPath = path.join(root, CONFIG_FILENAME);

    this.load();
    this.setupWatcher();
    this.disposables.push(this.onChangeEmitter);
  }

  private load(): void {
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.terminals === 'object') {
        this.config = parsed;
      }
    } catch {
      // File doesn't exist or is malformed — start fresh
    }
  }

  private setupWatcher(): void {
    const dir = path.dirname(this.configPath);
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), CONFIG_FILENAME);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => {
      if (this.isSaving) return; // skip reload from our own write
      this.load();
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

  private scheduleSave(): void {
    // Debounce writes so rapid terminal opens don't thrash the file
    if (this.writeDebounce) clearTimeout(this.writeDebounce);
    this.writeDebounce = setTimeout(() => this.save(), 200);
  }

  private save(): void {
    const output: ConfigFile = {
      description: 'Claudelike Bar configuration. Each key is a terminal name. Edit colors, nicknames, and auto-start directly.',
      terminals: this.config.terminals,
    };

    this.isSaving = true;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error('claudelike-bar: failed to write config', err);
    } finally {
      // Clear the flag after a short delay to outlast the watcher event
      setTimeout(() => { this.isSaving = false; }, 100);
    }
  }

  dispose(): void {
    if (this.writeDebounce) {
      clearTimeout(this.writeDebounce);
      this.save(); // flush pending writes
    }
    for (const d of this.disposables) d.dispose();
  }
}
