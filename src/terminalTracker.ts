import * as vscode from 'vscode';
import { TileData, getThemeColor } from './types';

export class TerminalTracker implements vscode.Disposable {
  private terminals = new Map<number, TileData>();
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;

  constructor() {
    // Track existing terminals
    for (const terminal of vscode.window.terminals) {
      this.addTerminal(terminal);
    }

    this.disposables.push(
      vscode.window.onDidOpenTerminal((t) => {
        this.addTerminal(t);
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidCloseTerminal((t) => {
        this.removeTerminal(t);
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidChangeActiveTerminal(() => {
        this.updateActiveTerminal();
        this.onChangeEmitter.fire();
      }),
      this.onChangeEmitter,
    );
  }

  private addTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    // Skip generic shells that aren't project terminals
    if (name === 'bash' || name === 'zsh' || name === 'sh') return;

    const pid = this.getTerminalId(terminal);
    this.terminals.set(pid, {
      name,
      status: 'idle',
      lastActivity: Date.now(),
      isActive: vscode.window.activeTerminal === terminal,
      themeColor: getThemeColor(name),
    });
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const pid = this.getTerminalId(terminal);
    this.terminals.delete(pid);
  }

  private updateActiveTerminal(): void {
    const activeName = vscode.window.activeTerminal?.name;
    for (const [, tile] of this.terminals) {
      tile.isActive = tile.name === activeName;
    }
  }

  private getTerminalId(terminal: vscode.Terminal): number {
    // Use the terminal's internal index as a stable-ish identifier
    // processId is async, so we use the terminal object's index in the array
    const idx = vscode.window.terminals.indexOf(terminal);
    return idx >= 0 ? idx : Math.random() * 100000;
  }

  updateStatus(projectName: string, status: TileData['status'], event?: string): void {
    for (const [, tile] of this.terminals) {
      if (tile.name === projectName) {
        tile.status = status;
        tile.lastActivity = Date.now();
        tile.event = event;
      }
    }
    this.onChangeEmitter.fire();
  }

  getTiles(): TileData[] {
    const tiles = Array.from(this.terminals.values());

    // Sort: waiting first, then working, then done, then idle. Within same status, by recency.
    const statusOrder: Record<string, number> = { waiting: 0, working: 1, done: 2, idle: 3 };
    tiles.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
      if (orderDiff !== 0) return orderDiff;
      return b.lastActivity - a.lastActivity;
    });

    return tiles;
  }

  getTerminalByName(name: string): vscode.Terminal | undefined {
    return vscode.window.terminals.find((t) => t.name === name);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.terminals.clear();
  }
}
