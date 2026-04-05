import * as vscode from 'vscode';
import { DashboardProvider } from './dashboardProvider';
import { TerminalTracker } from './terminalTracker';
import { StatusWatcher } from './statusWatcher';
import { ConfigManager } from './configManager';

export function activate(context: vscode.ExtensionContext) {
  const configManager = new ConfigManager();
  const tracker = new TerminalTracker(configManager);
  const watcher = new StatusWatcher();
  const provider = new DashboardProvider(context.extensionUri);

  // Register the webview provider
  const registration = vscode.window.registerWebviewViewProvider(
    'claudeDashboard.mainView',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // Handle webview messages
  provider.onMessage = (message) => {
    const terminal = tracker.getTerminalById(message.id);

    switch (message.type) {
      case 'switchTerminal':
        terminal?.show();
        break;

      case 'cloneTerminal':
        if (terminal) {
          const opts = terminal.creationOptions;
          if (!opts || 'pty' in opts) break; // can't clone PTY-based terminals
          vscode.window.createTerminal({
            name: `${opts.name || terminal.name} (copy)`,
            cwd: opts.cwd,
            shellPath: opts.shellPath,
            shellArgs: opts.shellArgs,
          });
        }
        break;

      case 'killTerminal':
        terminal?.dispose();
        break;

      case 'setColor':
        tracker.setColor(message.id, message.color ?? undefined);
        break;
    }
  };

  // Refresh tiles on terminal changes
  const refreshTiles = () => provider.updateTiles(tracker.getTiles());

  tracker.onChange(refreshTiles);

  // Refresh tiles on status file changes
  watcher.onStatusChange((data) => {
    if (data.status) {
      tracker.updateStatus(data.project, data.status, data.event, data.context_percent);
    } else if (data.context_percent !== undefined) {
      tracker.updateContext(data.project, data.context_percent);
    }
  });

  // Refresh tiles when config file changes (color/nickname edits)
  const configSub = configManager.onChange(tracker.refreshFromConfig.bind(tracker));

  // Auto-start terminals marked in config
  const autoStartNames = configManager.getAutoStartTerminals();
  for (const name of autoStartNames) {
    if (!tracker.getTerminalByName(name)) {
      vscode.window.createTerminal({ name });
    }
  }

  // Periodic refresh for relative time display (every 30s)
  const interval = setInterval(refreshTiles, 30_000);

  context.subscriptions.push(registration, tracker, watcher, configManager, configSub, {
    dispose: () => clearInterval(interval),
  });
}

export function deactivate() {
  // Cleanup handled by disposables
}
