import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { TerminalTracker } from './terminalTracker';
import { getThemeColor } from './types';

/**
 * v0.19 — tile-organizer panel. Editor-area webview (not sidebar) that
 * renders four lanes of cards for managing tile visibility and pinning:
 *
 *   1. Auto-sort      — running, status-driven order in the bar
 *   2. Pinned         — fixed-position zone at the bar bottom
 *   3. Closed visible — registered, terminal not running (passive lane,
 *                       drop-disabled — tiles auto-appear here)
 *   4. Hidden         — `hidden: true`, not in the bar at all
 *
 * Lanes 1 and 3 share the same `(pinned: false, hidden: false)` config
 * state — the difference is runtime liveness, derived from TerminalTracker.
 *
 * Drag/drop semantics:
 *   - Drag → Pinned: sets `pinned: true`, position assigns `order`
 *   - Drag → Auto-sort: sets `pinned: false, hidden: false`, no order
 *   - Drag → Hidden: sets `hidden: true`
 *   - Drag → Closed visible: rejected at the webview (passive lane)
 *
 * The webview owns the lane layout and ships the full picture back via a
 * single `applyLayout` message; ConfigManager applies it atomically.
 */
export class OrganizerProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private extensionUri: vscode.Uri;
  private configManager: ConfigManager;
  private tracker: TerminalTracker;
  private subDisposables: vscode.Disposable[] = [];
  // Set briefly after our own `applyOrganizerLayout` write so the
  // configManager.onChange listener (which fires once the debounced disk
  // write completes) doesn't double-post the same state we just echoed.
  // External edits — file changed by hand — still trigger a normal sync.
  private suppressOwnEcho = false;
  private suppressOwnEchoTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(extensionUri: vscode.Uri, configManager: ConfigManager, tracker: TerminalTracker) {
    this.extensionUri = extensionUri;
    this.configManager = configManager;
    this.tracker = tracker;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'claudelikeBar.organizer',
      'Organize Claudelike Tiles',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.svg');
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      for (const d of this.subDisposables) d.dispose();
      this.subDisposables = [];
    });

    this.subDisposables.push(
      this.panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg)),
      this.configManager.onChange(() => {
        if (this.suppressOwnEcho) return;
        this.postState();
      }),
      this.tracker.onChange(() => this.postState()),
    );

    this.postState();
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (typeof m.type !== 'string') return;
    if (m.type === 'organizer:applyLayout') {
      const layout = msg as {
        pinnedOrder?: unknown;
        unpinnedNames?: unknown;
        hiddenNames?: unknown;
      };
      const asNameList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      // Suppress the configManager.onChange-triggered postState that fires
      // ~200ms later (after the debounced save completes) — its payload is
      // identical to the echo below, and re-posting it would redundantly
      // rebuild the webview DOM. 300ms covers the 200ms scheduleSave debounce
      // plus a margin for filesystem-watcher latency.
      this.suppressOwnEcho = true;
      if (this.suppressOwnEchoTimer) clearTimeout(this.suppressOwnEchoTimer);
      this.suppressOwnEchoTimer = setTimeout(() => {
        this.suppressOwnEcho = false;
      }, 300);
      this.configManager.applyOrganizerLayout({
        pinnedOrder: asNameList(layout.pinnedOrder),
        unpinnedNames: asNameList(layout.unpinnedNames),
        hiddenNames: asNameList(layout.hiddenNames),
      });
      // Eager echo: webview gets the new state immediately rather than
      // waiting for the debounced save → onChange round-trip.
      this.postState();
    } else if (m.type === 'organizer:requestState') {
      this.postState();
    } else if (m.type === 'organizer:launchProject') {
      void vscode.commands.executeCommand('claudeDashboard.launchProject');
    } else if (m.type === 'organizer:openConfig') {
      void vscode.commands.executeCommand('claudeDashboard.openConfig');
    } else if (m.type === 'organizer:closeTerminal') {
      const payload = msg as { name?: unknown; displayName?: unknown };
      const name = typeof payload.name === 'string' ? payload.name : undefined;
      const displayName = typeof payload.displayName === 'string'
        ? payload.displayName
        : name;
      if (name) void this.handleCloseTerminal(name, displayName ?? name);
    }
  }

  /**
   * v0.19 (#41) — drop-to-close handler. If the user hasn't opted out of
   * the confirmation modal, show it with three buttons (Close / Cancel /
   * Close — don't ask again). On confirm, dispose the live VS Code
   * terminal; the tile naturally falls back into the "Closed but visible"
   * lane via the runtime-derivation in postState(). All branches are
   * idempotent — if the terminal is already gone (race with another close
   * path), we silently no-op.
   */
  private async handleCloseTerminal(name: string, displayName: string): Promise<void> {
    if (!this.configManager.getConfirmCloseOnDrop()) {
      this.tracker.closeTerminalByName(name);
      return;
    }
    const CLOSE = 'Close terminal';
    const CLOSE_DONT_ASK = 'Close, don\'t ask again';
    const choice = await vscode.window.showWarningMessage(
      `Close the terminal for "${displayName}"? The tile will remain in the bar as a launcher.`,
      { modal: true },
      CLOSE,
      CLOSE_DONT_ASK,
    );
    if (choice === CLOSE_DONT_ASK) {
      this.configManager.setConfirmCloseOnDrop(false);
      this.tracker.closeTerminalByName(name);
    } else if (choice === CLOSE) {
      this.tracker.closeTerminalByName(name);
    }
    // Any other choice (undefined / cancel / Esc) — no-op.
  }

  private postState(): void {
    if (!this.panel) return;
    const all = this.configManager.getAll();
    const liveNames = new Set(
      this.tracker.getTiles()
        .filter((t) => t.status !== 'registered')
        .map((t) => t.name),
    );
    type Card = {
      name: string;
      displayName: string;
      themeColor: string;
      icon: string | null;
      isShell: boolean;
      isLive: boolean;
    };
    const pinned: Array<Card & { order: number }> = [];
    const auto: Card[] = [];
    const closedVisible: Card[] = [];
    const hidden: Card[] = [];

    for (const [name, cfg] of Object.entries(all)) {
      const card: Card = {
        name,
        displayName: cfg.nickname ?? name,
        themeColor: getThemeColor(name, typeof cfg.color === 'string' ? cfg.color : undefined),
        icon: cfg.icon ?? null,
        isShell: cfg.type === 'shell',
        isLive: liveNames.has(name),
      };
      if (cfg.hidden) {
        hidden.push(card);
      } else if (cfg.pinned) {
        pinned.push({
          ...card,
          order: typeof cfg.order === 'number' ? cfg.order : Number.MAX_SAFE_INTEGER,
        });
      } else if (liveNames.has(name)) {
        auto.push(card);
      } else {
        closedVisible.push(card);
      }
    }

    pinned.sort((a, b) => a.order - b.order);
    const cmp = (a: Card, b: Card) => a.displayName.localeCompare(b.displayName);
    auto.sort(cmp);
    closedVisible.sort(cmp);
    hidden.sort(cmp);

    void this.panel.webview.postMessage({
      type: 'organizer:state',
      lanes: {
        pinned: pinned.map(({ order: _o, ...c }) => c),
        auto,
        closedVisible,
        hidden,
      },
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'organizer.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'organizer.js'));
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css'));
    const codiconFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.ttf'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    @font-face {
      font-family: "codicon";
      font-display: block;
      src: url("${codiconFontUri}") format("truetype");
    }
  </style>
  <link href="${codiconCssUri}" rel="stylesheet">
  <link href="${cssUri}" rel="stylesheet">
</head>
<body>
  <header class="organizer-header">
    <h1>Organize Claudelike Tiles</h1>
    <p class="hint">Drag cards between lanes to pin, hide, or unhide tiles. Drop a running tile into "Closed but visible" to close its terminal (with confirmation).</p>
  </header>
  <main class="lanes">
    <section class="lane" data-lane="pinned">
      <header><span class="lane-title">Pinned</span><span class="lane-sub">Fixed at bar bottom — drag to reorder</span></header>
      <div class="cards" data-droppable="true"></div>
    </section>
    <section class="lane" data-lane="auto">
      <header><span class="lane-title">Auto-sort</span><span class="lane-sub">Running tiles, status-driven order</span></header>
      <div class="cards" data-droppable="true"></div>
    </section>
    <section class="lane" data-lane="closedVisible">
      <header><span class="lane-title">Closed but visible</span><span class="lane-sub">Click in the bar to launch — drop a running tile here to close it</span></header>
      <div class="cards" data-droppable="true"></div>
    </section>
    <section class="lane" data-lane="hidden">
      <header><span class="lane-title">Hidden</span><span class="lane-sub">Not shown in the bar — reachable via Launch Project</span></header>
      <div class="cards" data-droppable="true"></div>
    </section>
  </main>
  <footer class="organizer-footer">
    <button type="button" data-action="openConfig">Edit config file…</button>
    <span class="status" id="status"></span>
  </footer>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.suppressOwnEchoTimer) {
      clearTimeout(this.suppressOwnEchoTimer);
      this.suppressOwnEchoTimer = undefined;
    }
    for (const d of this.subDisposables) d.dispose();
    this.subDisposables = [];
    this.panel?.dispose();
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
