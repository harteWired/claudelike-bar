import * as vscode from 'vscode';
import * as fs from 'fs';
import { DashboardProvider } from './dashboardProvider';
import { TerminalTracker } from './terminalTracker';
import { StatusWatcher } from './statusWatcher';
import { ConfigManager } from './configManager';
import { getStatusDir } from './statusDir';
import { executeHooksInstallCommand, HOOKS_DOC_URL } from './setup';
import {
  executeStatuslineInstallCommand,
  executeStatuslineRestoreCommand,
} from './statusline';
import { executeRegisterProjectCommand } from './registerProject';
import { showOnboardingNotification, isSetupComplete } from './onboarding';
import { runSetupWizard } from './wizard';
import { readExtensionVersion } from './claudePaths';
import * as path from 'path';

const SETUP_PROMPTED_KEY = 'claudelike-bar.setupPrompted';
const LAST_VERSION_KEY = 'claudelike-bar.lastVersion';

const STATUS_DIR = getStatusDir();
const DEBUG_FLAG = path.join(STATUS_DIR, '.debug');
const AUTO_START_REVIVE_GRACE_MS = 1200;

type LogFn = (msg: string | (() => string)) => void;

export function activate(context: vscode.ExtensionContext) {
  const configManager = new ConfigManager();

  // Debug output channel — always created, only written to when debug is on.
  // Accepts a thunk so callers can defer expensive string building.
  const output = vscode.window.createOutputChannel('Claudelike Bar');
  const log: LogFn = (msg) => {
    if (!configManager.isDebugEnabled()) return;
    const ts = new Date().toISOString().slice(11, 19);
    const text = typeof msg === 'function' ? msg() : msg;
    output.appendLine(`[${ts}] ${text}`);
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

  // Setup commands — install hooks, install statusline, view docs
  const installHooksCmd = vscode.commands.registerCommand(
    'claudeDashboard.installHooks',
    () => executeHooksInstallCommand(context.extensionPath, (m) => log(m)),
  );
  const installStatuslineCmd = vscode.commands.registerCommand(
    'claudeDashboard.installStatusline',
    () => executeStatuslineInstallCommand(context.extensionPath, (m) => log(m)),
  );
  const restoreStatuslineCmd = vscode.commands.registerCommand(
    'claudeDashboard.restoreStatusline',
    () => executeStatuslineRestoreCommand((m) => log(m)),
  );
  const registerProjectCmd = vscode.commands.registerCommand(
    'claudeDashboard.registerProject',
    () => executeRegisterProjectCommand(configManager, (m) => log(m)),
  );
  const setupProjectsCmd = vscode.commands.registerCommand(
    'claudeDashboard.setupProjects',
    () => runSetupWizard(configManager, context.extensionPath, (m) => log(m)),
  );
  const showHooksCmd = vscode.commands.registerCommand(
    'claudeDashboard.showHooks',
    () => vscode.env.openExternal(vscode.Uri.parse(HOOKS_DOC_URL)),
  );

  // First-activation onboarding: if hooks aren't installed AND we haven't
  // prompted before, show the install notification. Gate on globalState so
  // users who dismissed once aren't nagged on every reload. Set the flag
  // only AFTER the notification promise resolves — if the notification
  // fails to display (e.g., window unavailable), we want to try again next
  // activation rather than silently silencing it forever.
  if (!isSetupComplete() && !context.globalState.get<boolean>(SETUP_PROMPTED_KEY)) {
    showOnboardingNotification(
      context.extensionPath,
      (m) => log(m),
      () => runSetupWizard(configManager, context.extensionPath, (m) => log(m)),
    ).then(
      () => context.globalState.update(SETUP_PROMPTED_KEY, true),
      (err) => log(`onboarding notification failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  // Version-upgrade notification: if the extension version changed since last
  // activation, offer to re-run the setup wizard. Covers users who upgraded
  // and have stale terminal entries from an older config format.
  const currentVersion = readExtensionVersion(context.extensionPath);
  const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);
  if (lastVersion && lastVersion !== currentVersion && isSetupComplete()) {
    vscode.window.showInformationMessage(
      `Claudelike Bar updated to v${currentVersion}. Re-configure your projects?`,
      'Set Up Projects',
      'Dismiss',
    ).then((pick) => {
      if (pick === 'Set Up Projects') {
        runSetupWizard(configManager, context.extensionPath, (m) => log(m));
      }
    });
  }
  context.globalState.update(LAST_VERSION_KEY, currentVersion);

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

      case 'addProject':
        vscode.commands.executeCommand('claudeDashboard.registerProject');
        break;
    }
  };

  // Refresh tiles on terminal changes
  const refreshTiles = () => provider.updateTiles(tracker.getTiles());

  tracker.onChange(refreshTiles);

  // Refresh tiles on status file changes
  watcher.onStatusChange((data) => {
    log(() => `status-file project=${data.project} status=${data.status ?? '-'} event=${data.event ?? '-'} ctx=${data.context_percent ?? '-'}`);
    if (data.status) {
      tracker.updateStatus(data.project, data.status, data.event, data.context_percent, data);
    } else if (data.context_percent !== undefined) {
      tracker.updateContext(data.project, data.context_percent);
    }
  });

  // Refresh tiles when config file changes (color/nickname/mode edits)
  const configSub = configManager.onChange(() => {
    syncDebugFlag();
    tracker.refreshFromConfig();
  });

  // Periodic refresh for relative time display (every 30s)
  const interval = setInterval(refreshTiles, 30_000);

  // Auto-start timer disposable — created before the timer itself so the
  // disposable is pushed onto context.subscriptions atomically with the
  // timer's creation. A setTimeout that fires after deactivation would hit
  // a disposed tracker.
  let autoStartTimer: ReturnType<typeof setTimeout> | undefined;
  const timerDisposable: vscode.Disposable = {
    dispose: () => {
      if (autoStartTimer) clearTimeout(autoStartTimer);
      clearInterval(interval);
    },
  };

  context.subscriptions.push(
    registration,
    openConfigCmd,
    installHooksCmd,
    installStatuslineCmd,
    restoreStatuslineCmd,
    registerProjectCmd,
    setupProjectsCmd,
    showHooksCmd,
    tracker,
    watcher,
    configManager,
    configSub,
    output,
    timerDisposable,
  );

  // Auto-start is shell-command execution driven by a workspace-local config
  // file — in untrusted workspaces it's a remote-code-execution vector, so
  // it's gated behind workspace trust. The `capabilities.untrustedWorkspaces`
  // declaration in package.json tells VS Code to run the extension in
  // limited mode in untrusted workspaces; this block is the runtime side
  // of that contract.
  if (!vscode.workspace.isTrusted) {
    log('workspace is untrusted — auto-start disabled');
  } else {
    autoStartTimer = setTimeout(
      () => runAutoStart(configManager, tracker, log),
      AUTO_START_REVIVE_GRACE_MS,
    );
  }
}

/**
 * Create terminals marked `autoStart: true` in the config. All options
 * flow through the VS Code `createTerminal` API — cross-platform, no
 * shell-syntax quoting. The recommended config pattern is:
 *
 *     "cwd": "/path/to/project",
 *     "command": "claude"
 *
 * `cwd` sets the working directory via the API; `command` is sent into the
 * terminal via `sendText` and should be a simple executable invocation (no
 * `cd`, no `&&`). Legacy `cd /path && claude` commands still work but are
 * shell-specific and won't run on PowerShell.
 *
 * Runs after a grace period so VS Code's persistent-session revival can
 * restore terminals from the previous window first — revived terminals
 * get a `revived (skip)` log entry and are left alone.
 */
function runAutoStart(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  log: LogFn,
): void {
  const autoStartNames = configManager.getAutoStartTerminals();
  log(`auto-starting ${autoStartNames.length} terminal(s): ${autoStartNames.join(', ')}`);

  for (const name of autoStartNames) {
    if (tracker.getTerminalByName(name)) {
      log(`  ${name} → revived (skip)`);
      continue;
    }
    const opts = configManager.getAutoStartTerminalOptions(name);
    const terminal = vscode.window.createTerminal({
      name,
      env: opts.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.shellPath ? { shellPath: opts.shellPath } : {}),
      ...(opts.shellArgs ? { shellArgs: opts.shellArgs } : {}),
    });
    const command = configManager.getAutoStartCommand(name);
    if (command) {
      log(`  ${name} → ${command}${opts.cwd ? ` [cwd: ${opts.cwd}]` : ''}${opts.shellPath ? ` [shell: ${opts.shellPath}]` : ''}`);
      terminal.sendText(command);
    } else {
      log(`  ${name} → (no command)${opts.cwd ? ` [cwd: ${opts.cwd}]` : ''}${opts.shellPath ? ` [shell: ${opts.shellPath}]` : ''}`);
    }
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
