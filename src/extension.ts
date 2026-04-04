import * as vscode from 'vscode';
import { DashboardProvider } from './dashboardProvider';
import { TerminalTracker } from './terminalTracker';
import { StatusWatcher } from './statusWatcher';

export function activate(context: vscode.ExtensionContext) {
  const tracker = new TerminalTracker();
  const watcher = new StatusWatcher();
  const provider = new DashboardProvider(context.extensionUri);

  // Register the webview provider
  const registration = vscode.window.registerWebviewViewProvider(
    'claudeDashboard.mainView',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // Handle tile clicks — switch to terminal
  provider.onSwitchTerminal = (name: string) => {
    const terminal = tracker.getTerminalByName(name);
    if (terminal) {
      terminal.show();
    }
  };

  // Refresh tiles on terminal changes
  const refreshTiles = () => provider.updateTiles(tracker.getTiles());

  tracker.onChange(refreshTiles);

  // Refresh tiles on status file changes
  watcher.onStatusChange((data) => {
    tracker.updateStatus(data.project, data.status, data.event);
  });

  // Periodic refresh for relative time display (every 30s)
  const interval = setInterval(refreshTiles, 30_000);

  context.subscriptions.push(registration, tracker, watcher, {
    dispose: () => clearInterval(interval),
  });
}

export function deactivate() {
  // Cleanup handled by disposables
}
