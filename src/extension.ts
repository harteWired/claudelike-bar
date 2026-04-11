import * as vscode from 'vscode';
import * as fs from 'fs';
import { DashboardProvider } from './dashboardProvider';
import { TerminalTracker } from './terminalTracker';
import { StatusWatcher } from './statusWatcher';
import { ConfigManager } from './configManager';

const STATUS_DIR = '/tmp/claude-dashboard';
const DEBUG_FLAG = `${STATUS_DIR}/.debug`;

export function activate(context: vscode.ExtensionContext) {
  const configManager = new ConfigManager();

  // Debug output channel — always created, only written to when debug is on
  const output = vscode.window.createOutputChannel('Claudelike Bar');
  const log = (msg: string) => {
    if (!configManager.isDebugEnabled()) return;
    const ts = new Date().toISOString().slice(11, 19);
    output.appendLine(`[${ts}] ${msg}`);
  };

  // Sync the hook's debug flag file with the config setting
  const syncDebugFlag = () => {
    try {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      if (configManager.isDebugEnabled()) {
        fs.writeFileSync(DEBUG_FLAG, '');
      } else if (fs.existsSync(DEBUG_FLAG)) {
        fs.unlinkSync(DEBUG_FLAG);
      }
    } catch (err) {
      output.appendLine(`[debug-flag] ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  syncDebugFlag();

  const tracker = new TerminalTracker(configManager, log);
  const watcher = new StatusWatcher();
  const provider = new DashboardProvider(context.extensionUri);

  // Register the webview provider
  const registration = vscode.window.registerWebviewViewProvider(
    'claudeDashboard.mainView',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // Register gear icon command — opens config file in editor
  const openConfigCmd = vscode.commands.registerCommand(
    'claudeDashboard.openConfig',
    () => {
      const configPath = configManager.getConfigPath();
      vscode.window.showTextDocument(vscode.Uri.file(configPath));
    },
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

      case 'markDone':
        tracker.markDone(message.id);
        break;

      case 'reorderTiles':
        tracker.reorderTiles(message.orderedIds);
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
    log(`status-file project=${data.project} status=${data.status ?? '-'} event=${data.event ?? '-'} ctx=${data.context_percent ?? '-'}`);
    if (data.status) {
      tracker.updateStatus(data.project, data.status, data.event, data.context_percent);
    } else if (data.context_percent !== undefined) {
      tracker.updateContext(data.project, data.context_percent);
    }
  });

  // Refresh tiles when config file changes (color/nickname/mode edits)
  const configSub = configManager.onChange(() => {
    syncDebugFlag();
    tracker.refreshFromConfig();
  });

  // Auto-start terminals marked in config.
  // Delayed so VS Code's persistent-session revival (enablePersistentSessions)
  // has time to restore terminals from the previous window. If a revived
  // terminal with a given name shows up before the timeout fires, we skip it
  // instead of creating a duplicate.
  const autoStartNames = configManager.getAutoStartTerminals();
  log(`auto-starting ${autoStartNames.length} terminal(s) after revive grace period: ${autoStartNames.join(', ')}`);
  const autoStartTimer = setTimeout(() => {
    for (const name of autoStartNames) {
      if (tracker.getTerminalByName(name)) {
        log(`  ${name} → revived (skip)`);
        continue;
      }
      const terminal = vscode.window.createTerminal({ name });
      // Export CLAUDELIKE_BAR_NAME so the hook script knows which tile to update,
      // even from subdirectories or non-standard cwd (e.g. Vault Direct).
      terminal.sendText(`export CLAUDELIKE_BAR_NAME=${JSON.stringify(name)}`);
      const command = configManager.getAutoStartCommand(name);
      if (command) {
        log(`  ${name} → ${command}`);
        terminal.sendText(command);
      } else {
        log(`  ${name} → (no command)`);
      }
    }
  }, 1200);

  // Periodic refresh for relative time display (every 30s)
  const interval = setInterval(refreshTiles, 30_000);

  context.subscriptions.push(registration, openConfigCmd, tracker, watcher, configManager, configSub, output, {
    dispose: () => {
      clearTimeout(autoStartTimer);
      clearInterval(interval);
    },
  });
}

export function deactivate() {
  // Cleanup handled by disposables
}
