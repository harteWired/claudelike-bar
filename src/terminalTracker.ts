import * as vscode from 'vscode';
import { TileData, SessionStatus, getThemeColor } from './types';
import { ConfigManager } from './configManager';

const IGNORED_TEXTS = [
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

export class TerminalTracker implements vscode.Disposable {
  private terminals = new Map<number, TileData>();
  private terminalRefs = new Map<number, vscode.Terminal>();
  private terminalIdMap = new WeakMap<vscode.Terminal, number>();
  private nextId = 0;
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  private nameRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private nameRefreshIdleCycles = 0;
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    // Track existing terminals
    for (const terminal of vscode.window.terminals) {
      this.addTerminal(terminal);
    }

    this.disposables.push(
      vscode.window.onDidOpenTerminal((t) => {
        this.addTerminal(t);
        this.startNameRefresh(); // restart polling on new terminal
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidCloseTerminal((t) => {
        this.removeTerminal(t);
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidChangeActiveTerminal((active) => {
        this.handleActiveTerminalChange(active);
        this.onChangeEmitter.fire();
      }),
      this.onChangeEmitter,
    );

    // Periodically refresh terminal names — catches late profile name assignment
    this.startNameRefresh();
  }

  private addTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    if (name === 'bash' || name === 'zsh' || name === 'sh') return;

    // Auto-populate config file entry
    this.configManager.ensureEntry(name);
    const cfg = this.configManager.getTerminal(name);

    const id = this.assignId(terminal);
    this.terminalRefs.set(id, terminal);
    this.terminals.set(id, {
      id,
      name,
      displayName: cfg?.nickname || name,
      status: 'idle',
      lastActivity: Date.now(),
      isActive: vscode.window.activeTerminal === terminal,
      themeColor: getThemeColor(name, cfg?.color),
    });
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const id = this.terminalIdMap.get(terminal);
    if (id !== undefined) {
      this.terminals.delete(id);
      this.terminalRefs.delete(id);
    }
  }

  private handleActiveTerminalChange(active: vscode.Terminal | undefined): void {
    const activeId = active ? this.terminalIdMap.get(active) : undefined;

    for (const [id, tile] of this.terminals) {
      tile.isActive = id === activeId;

      if (id === activeId) {
        // User focused this terminal — clear waiting/ignored
        if (tile.status === 'waiting' || tile.status === 'ignored') {
          tile.status = 'idle';
          tile.ignoredText = undefined;
        }
      } else {
        // User focused a DIFFERENT terminal — waiting becomes ignored
        if (tile.status === 'waiting') {
          tile.status = 'ignored';
          tile.ignoredText = IGNORED_TEXTS[Math.floor(Math.random() * IGNORED_TEXTS.length)];
        }
      }
    }
  }

  private assignId(terminal: vscode.Terminal): number {
    let id = this.terminalIdMap.get(terminal);
    if (id === undefined) {
      id = this.nextId++;
      this.terminalIdMap.set(terminal, id);
    }
    return id;
  }

  private startNameRefresh(): void {
    this.nameRefreshIdleCycles = 0;
    if (this.nameRefreshTimer) return; // already running
    this.nameRefreshTimer = setInterval(() => this.refreshNames(), 2000);
  }

  private stopNameRefresh(): void {
    if (this.nameRefreshTimer) {
      clearInterval(this.nameRefreshTimer);
      this.nameRefreshTimer = undefined;
    }
  }

  /**
   * Re-check terminal names — picks up profile names assigned after onDidOpenTerminal,
   * and adds terminals that were initially filtered as "zsh" but since got renamed.
   * Stops itself after 3 consecutive no-change cycles to avoid wasted work.
   */
  private refreshNames(): void {
    let changed = false;

    for (const terminal of vscode.window.terminals) {
      const name = terminal.name;
      const id = this.terminalIdMap.get(terminal);

      if (id !== undefined) {
        // Already tracked — update name if it changed
        const tile = this.terminals.get(id);
        if (tile && tile.name !== name) {
          if (name === 'bash' || name === 'zsh' || name === 'sh') {
            // Name regressed to shell — remove it
            this.terminals.delete(id);
            this.terminalRefs.delete(id);
          } else {
            this.configManager.ensureEntry(name);
            const cfg = this.configManager.getTerminal(name);
            tile.name = name;
            tile.displayName = cfg?.nickname || name;
            tile.themeColor = getThemeColor(name, cfg?.color);
          }
          changed = true;
        }
      } else if (name !== 'bash' && name !== 'zsh' && name !== 'sh') {
        // Not tracked yet — was likely "zsh" at open time, now has a real name
        this.addTerminal(terminal);
        changed = true;
      }
    }

    if (changed) {
      this.nameRefreshIdleCycles = 0;
      this.onChangeEmitter.fire();
    } else {
      this.nameRefreshIdleCycles++;
      if (this.nameRefreshIdleCycles >= 3) {
        this.stopNameRefresh();
      }
    }
  }

  /** Re-apply config (colors, nicknames) to all tracked tiles. */
  refreshFromConfig(): void {
    for (const [, tile] of this.terminals) {
      const cfg = this.configManager.getTerminal(tile.name);
      tile.displayName = cfg?.nickname || tile.name;
      tile.themeColor = getThemeColor(tile.name, cfg?.color);
    }
    this.onChangeEmitter.fire();
  }

  updateStatus(projectName: string, status: SessionStatus, event?: string, contextPercent?: number): void {
    for (const [, tile] of this.terminals) {
      if (tile.name === projectName) {
        // Don't let hook events override waiting/ignored — only the user focusing the terminal clears those
        if ((tile.status === 'waiting' || tile.status === 'ignored') && status === 'working') {
          // A new prompt was submitted — user is interacting, clear the sticky state
          if (event === 'UserPromptSubmit') {
            tile.status = status;
            tile.ignoredText = undefined;
          }
          // Otherwise ignore — keep waiting/ignored until user focuses
        } else {
          tile.status = status;
          tile.ignoredText = undefined;
        }
        tile.lastActivity = Date.now();
        tile.event = event;
        if (contextPercent !== undefined) {
          tile.contextPercent = contextPercent;
        }
      }
    }
    this.onChangeEmitter.fire();
  }

  setColor(id: number, color: string | undefined): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    // Persist to config file — single source of truth
    this.configManager.setColor(tile.name, color as any);
    const cfg = this.configManager.getTerminal(tile.name);
    tile.themeColor = getThemeColor(tile.name, cfg?.color);
    this.onChangeEmitter.fire();
  }

  updateContext(projectName: string, contextPercent: number): void {
    let changed = false;
    for (const [, tile] of this.terminals) {
      if (tile.name === projectName) {
        tile.contextPercent = contextPercent;
        changed = true;
      }
    }
    if (changed) this.onChangeEmitter.fire();
  }

  getTiles(): TileData[] {
    const tiles = Array.from(this.terminals.values());

    const statusOrder: Record<string, number> = { waiting: 0, ignored: 1, working: 2, done: 3, idle: 4 };
    tiles.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
      if (orderDiff !== 0) return orderDiff;
      return b.lastActivity - a.lastActivity;
    });

    return tiles;
  }

  getTerminalById(id: number): vscode.Terminal | undefined {
    return this.terminalRefs.get(id);
  }

  getTerminalByName(name: string): vscode.Terminal | undefined {
    for (const [id, tile] of this.terminals) {
      if (tile.name === name) {
        return this.terminalRefs.get(id);
      }
    }
    return undefined;
  }

  dispose(): void {
    this.stopNameRefresh();
    for (const d of this.disposables) d.dispose();
    this.terminals.clear();
    this.terminalRefs.clear();
  }
}
