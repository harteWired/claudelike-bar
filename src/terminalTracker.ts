import * as vscode from 'vscode';
import { TileData, SessionStatus, ICON_MAP, getThemeColor } from './types';
import { ConfigManager } from './configManager';

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
  private log: (msg: string | (() => string)) => void;

  // State machine timers: ready → waiting after 60s
  private readyTimers = new Map<number, NodeJS.Timeout>();

  // Focus tracking: which tile was focused while in "waiting" state
  private focusedWaitingTile: number | null = null;

  constructor(configManager: ConfigManager, log?: (msg: string | (() => string)) => void) {
    this.configManager = configManager;
    this.log = log ?? (() => {});
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
    const thresholds = this.configManager.getContextThresholds();

    const id = this.assignId(terminal);
    this.terminalRefs.set(id, terminal);
    this.terminals.set(id, {
      id,
      name,
      displayName: cfg?.nickname || name,
      status: 'idle',
      statusLabel: this.configManager.getLabel('idle'),
      lastActivity: Date.now(),
      isActive: vscode.window.activeTerminal === terminal,
      themeColor: getThemeColor(name, cfg?.color),
      icon: cfg?.icon ?? ICON_MAP[name] ?? null,
      contextWarn: thresholds.warn,
      contextCrit: thresholds.crit,
    });
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const id = this.terminalIdMap.get(terminal);
    if (id !== undefined) {
      this.terminals.delete(id);
      this.terminalRefs.delete(id);
      this.clearReadyTimer(id);
      if (this.focusedWaitingTile === id) {
        this.focusedWaitingTile = null;
      }
    }
  }

  private handleActiveTerminalChange(active: vscode.Terminal | undefined): void {
    const activeId = active ? this.terminalIdMap.get(active) : undefined;

    // Check if we're leaving a tile that was focused while waiting
    if (this.focusedWaitingTile !== null && this.focusedWaitingTile !== activeId) {
      const tile = this.terminals.get(this.focusedWaitingTile);
      if (tile && (tile.status === 'waiting' || tile.status === 'ready')) {
        // User looked and left without acting — mode-dependent transition
        const mode = this.configManager.getMode();
        if (mode === 'passive-aggressive') {
          const texts = this.configManager.getIgnoredTexts();
          tile.status = 'ignored';
          tile.ignoredText = texts[Math.floor(Math.random() * texts.length)];
          tile.statusLabel = tile.ignoredText;
        } else {
          tile.status = 'done';
          tile.statusLabel = this.configManager.getLabel('done');
          tile.ignoredText = undefined;
        }
        this.clearReadyTimer(tile.id);
      }
      this.focusedWaitingTile = null;
    }

    for (const [id, tile] of this.terminals) {
      tile.isActive = id === activeId;

      // If focusing a tile that's waiting or ready, start tracking it
      if (id === activeId && (tile.status === 'waiting' || tile.status === 'ready')) {
        this.focusedWaitingTile = id;
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
            tile.icon = cfg?.icon ?? ICON_MAP[name] ?? null;
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

  /** Re-apply config (colors, nicknames, icons, thresholds) to all tracked tiles. */
  refreshFromConfig(): void {
    const thresholds = this.configManager.getContextThresholds();
    for (const [, tile] of this.terminals) {
      const cfg = this.configManager.getTerminal(tile.name);
      tile.displayName = cfg?.nickname || tile.name;
      tile.themeColor = getThemeColor(tile.name, cfg?.color);
      tile.icon = cfg?.icon ?? ICON_MAP[tile.name] ?? null;
      tile.contextWarn = thresholds.warn;
      tile.contextCrit = thresholds.crit;
      // Refresh status label (except ignored which uses custom text)
      if (tile.status !== 'ignored') {
        tile.statusLabel = this.configManager.getLabel(tile.status);
      }
    }
    this.onChangeEmitter.fire();
  }

  updateStatus(projectName: string, status: SessionStatus, event?: string, contextPercent?: number): void {
    let matched = false;
    for (const [, tile] of this.terminals) {
      if (tile.name !== projectName) continue;
      matched = true;

      const prev = tile.status;
      let changed = false;

      // UserPromptSubmit is the universal reset — always goes to working
      if (event === 'UserPromptSubmit') {
        tile.status = 'working';
        tile.statusLabel = this.configManager.getLabel('working');
        tile.ignoredText = undefined;
        this.clearReadyTimer(tile.id);
        if (this.focusedWaitingTile === tile.id) {
          this.focusedWaitingTile = null;
        }
        changed = true;
      } else if (status === 'ready') {
        // Stop/Notification → ready, then 60s timer → waiting.
        // `done` and `ignored` are sticky end states the user has explicitly
        // parked — a background Stop/Notification must NOT un-park them,
        // otherwise Mark-as-done is defeated the next time that session's
        // Claude finishes anything. Only UserPromptSubmit (above) un-parks.
        if (tile.status !== 'ready' && tile.status !== 'done' && tile.status !== 'ignored') {
          tile.status = 'ready';
          tile.statusLabel = this.configManager.getLabel('ready');
          tile.ignoredText = undefined;
          this.startReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'working') {
        // PreToolUse → working (only if not in a sticky end state without user action)
        if (tile.status !== 'done' && tile.status !== 'ignored') {
          tile.status = 'working';
          tile.statusLabel = this.configManager.getLabel('working');
          tile.ignoredText = undefined;
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      }

      if (changed) {
        tile.lastActivity = Date.now();
        tile.event = event;
        this.log(() => `transition ${tile.name}: ${prev} → ${tile.status} (event=${event ?? '-'})`);
      } else {
        this.log(() => `no-op ${tile.name}: stayed ${prev} (event=${event ?? '-'}, incoming=${status})`);
      }
      if (contextPercent !== undefined) {
        tile.contextPercent = contextPercent;
      }
      break; // terminal names are unique
    }
    if (!matched) {
      // Lazy — the join() only runs when debug is actually on.
      this.log(() => {
        const names = Array.from(this.terminals.values()).map((t) => t.name).join(', ');
        return `unmatched status for "${projectName}" (tracked: [${names}])`;
      });
      // Don't fire onChange for unmatched events — no tile changed, a repaint
      // would be pure waste. Mirrors the `updateContext` pattern.
      return;
    }
    this.onChangeEmitter.fire();
  }

  private startReadyTimer(id: number): void {
    this.clearReadyTimer(id);
    const timer = setTimeout(() => {
      this.readyTimers.delete(id);
      const tile = this.terminals.get(id);
      if (tile && tile.status === 'ready') {
        tile.status = 'waiting';
        tile.statusLabel = this.configManager.getLabel('waiting');
        // If this tile is currently focused, start tracking it
        if (tile.isActive) {
          this.focusedWaitingTile = id;
        }
        this.onChangeEmitter.fire();
      }
    }, 60_000);
    this.readyTimers.set(id, timer);
  }

  private clearReadyTimer(id: number): void {
    const existing = this.readyTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.readyTimers.delete(id);
    }
  }

  /**
   * Manually mark a tile as "done" — silences passive-aggressive judgement
   * when the user knows they're not actively using it. A subsequent
   * UserPromptSubmit will reset it back to "working".
   */
  markDone(id: number): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    const prev = tile.status;
    tile.status = 'done';
    tile.statusLabel = this.configManager.getLabel('done');
    tile.ignoredText = undefined;
    tile.lastActivity = Date.now();
    this.clearReadyTimer(id);
    if (this.focusedWaitingTile === id) {
      this.focusedWaitingTile = null;
    }
    this.log(`manual mark-done ${tile.name}: ${prev} → done`);
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

    if (this.configManager.getSortMode() === 'manual') {
      tiles.sort((a, b) => {
        const ao = this.configManager.getTerminal(a.name)?.order;
        const bo = this.configManager.getTerminal(b.name)?.order;
        // Unordered tiles sink to the bottom, most-recent first.
        if (ao === undefined && bo === undefined) return b.lastActivity - a.lastActivity;
        if (ao === undefined) return 1;
        if (bo === undefined) return -1;
        return ao - bo;
      });
      return tiles;
    }

    // Auto mode: status-based with lastActivity tiebreak.
    const statusOrder: Record<string, number> = { waiting: 0, ignored: 1, ready: 2, working: 3, done: 4, idle: 5 };
    tiles.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
      if (orderDiff !== 0) return orderDiff;
      return b.lastActivity - a.lastActivity;
    });

    return tiles;
  }

  /**
   * Apply a new manual ordering by tile IDs. Persists to the config file so
   * the order survives window reloads and container rebuilds.
   */
  reorderTiles(orderedIds: number[]): void {
    const orderedNames: string[] = [];
    for (const id of orderedIds) {
      const tile = this.terminals.get(id);
      if (tile) orderedNames.push(tile.name);
    }
    if (orderedNames.length === 0) return;
    // Single atomic call — ConfigManager owns both the order write and the
    // sortMode flip, so policy lives in one place.
    this.configManager.applyDragOrder(orderedNames);
    this.log(`reorder: ${orderedNames.join(', ')}`);
    this.onChangeEmitter.fire();
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
    for (const timer of this.readyTimers.values()) {
      clearTimeout(timer);
    }
    this.readyTimers.clear();
    for (const d of this.disposables) d.dispose();
    this.terminals.clear();
    this.terminalRefs.clear();
  }
}
