import * as vscode from 'vscode';
import * as fs from 'fs';
import { DashboardProvider } from './dashboardProvider';
import { TerminalTracker } from './terminalTracker';
import { StatusWatcher } from './statusWatcher';
import { ConfigManager } from './configManager';
import { AudioPlayer } from './audio';
import { getStatusDir } from './statusDir';
import { executeHooksInstallCommand, HOOKS_DOC_URL } from './setup';
import {
  executeStatuslineInstallCommand,
  executeStatuslineRestoreCommand,
} from './statusline';
import { executeRegisterProjectCommand } from './registerProject';
import { executeLaunchProjectCommand, launchRegisteredProject } from './launchProject';
import { showOnboardingNotification, isSetupComplete } from './onboarding';
import { runSetupWizard } from './wizard';
import { readExtensionVersion, soundsDir } from './claudePaths';
import { ensureSoundsDirWithReadme } from './soundsReadme';
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
    () => executeRegisterProjectCommand(configManager, tracker, (m) => log(m)),
  );
  const launchProjectCmd = vscode.commands.registerCommand(
    'claudeDashboard.launchProject',
    () => executeLaunchProjectCommand(configManager, tracker, (m) => log(m)),
  );
  const setupProjectsCmd = vscode.commands.registerCommand(
    'claudeDashboard.setupProjects',
    () => runSetupWizard(configManager, context.extensionPath, (m) => log(m)),
  );
  const showHooksCmd = vscode.commands.registerCommand(
    'claudeDashboard.showHooks',
    () => vscode.env.openExternal(vscode.Uri.parse(HOOKS_DOC_URL)),
  );

  // Refresh tiles on terminal changes. Declared early so audio commands
  // below can call it. The audioEnabled flag rides along so the webview
  // context menu can label the toggle "Mute" vs "Unmute" without a separate
  // round-trip.
  const refreshTiles = () => {
    const tiles = tracker.getTiles();
    provider.updateTiles(tiles, configManager.isAudioEnabled());
  };

  // v0.12 — audio commands.
  const toggleAudioCmd = vscode.commands.registerCommand(
    'claudeDashboard.toggleAudio',
    () => {
      // Write the README first so the toast text can mention it confidently.
      try {
        ensureSoundsDirWithReadme();
      } catch (err) {
        log(() => `toggle-audio: ensureSoundsDirWithReadme failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      const next = !configManager.isAudioEnabled();
      configManager.setAudioEnabled(next);
      refreshTiles(); // push new audioEnabled state to the webview menu label
      if (next) {
        vscode.window.showInformationMessage(
          'Audio alerts enabled — sound on job completion. Open the Claudelike Bar sidebar at least once per session for audio.',
        );
      } else {
        vscode.window.showInformationMessage('Audio alerts muted');
      }
    },
  );
  const openSoundsFolderCmd = vscode.commands.registerCommand(
    'claudeDashboard.openSoundsFolder',
    async () => {
      try {
        ensureSoundsDirWithReadme();
      } catch (err) {
        vscode.window.showErrorMessage(`Claudelike Bar: couldn't create sounds folder — ${err instanceof Error ? err.message : err}`);
        return;
      }
      await vscode.env.openExternal(vscode.Uri.file(soundsDir()));
    },
  );

  // v0.12 — private test hook. Fires a play for `filename` and resolves
  // with the webview's ack: 'played' (audio.play resolved), 'error' (it
  // rejected — autoplay blocked or decode failed), or 'timeout'. Used only
  // by the CI autoplay smoke test. Underscore prefix + not listed in
  // package.json contributes signals "do not use."
  const firePlayForTestCmd = vscode.commands.registerCommand(
    'claudeDashboard.__firePlayForTest',
    (filename: string, volume = 0, timeoutMs = 5000): Promise<'played' | 'error' | 'timeout'> => {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: 'played' | 'error' | 'timeout') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sub.dispose();
          resolve(result);
        };
        const timer = setTimeout(() => settle('timeout'), timeoutMs);
        const sub = provider.onAudioAck((ack) => {
          // Match by filename so an unrelated in-flight play doesn't
          // resolve this call (test runs in isolation so this is belt-
          // and-braces, but cheap).
          if (!ack.url.endsWith(`/${filename}`)) return;
          settle(ack.type === 'played' ? 'played' : 'error');
        });
        provider.postPlay(filename, volume);
      });
    },
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

      case 'setupProjects':
        runSetupWizard(configManager, context.extensionPath, (m) => log(m));
        break;

      case 'toggleAudio':
        vscode.commands.executeCommand('claudeDashboard.toggleAudio');
        break;

      case 'launchProject':
        vscode.commands.executeCommand('claudeDashboard.launchProject');
        break;
    }
  };

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

  // v0.12 — audio alert player. Subscribes to tracker state transitions,
  // posts play messages to the dashboard webview. Created before configSub
  // so its resetWarnings() can be called from the config-change callback.
  const audioPlayer = new AudioPlayer(tracker, configManager, provider, log);

  // Refresh tiles when config file changes (color/nickname/mode edits).
  // The AudioPlayer's warn-once memory is also cleared so a file the user
  // just dropped in gets a fresh chance to be picked up.
  const configSub = configManager.onChange(() => {
    syncDebugFlag();
    tracker.refreshFromConfig();
    audioPlayer.resetWarnings();
    provider.clearSoundUriCache();
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
    launchProjectCmd,
    setupProjectsCmd,
    showHooksCmd,
    toggleAudioCmd,
    openSoundsFolderCmd,
    firePlayForTestCmd,
    tracker,
    watcher,
    configManager,
    configSub,
    audioPlayer,
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

  // Delegate per-name to the shared helper so auto-start and the
  // "Launch Registered Project" command can't drift in their createTerminal
  // wiring. The helper logs the "already open" case itself; nothing else
  // belongs in this loop.
  for (const name of autoStartNames) {
    launchRegisteredProject(configManager, tracker, name, log);
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
