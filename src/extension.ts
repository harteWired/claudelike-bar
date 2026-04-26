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
import { executeLaunchProjectCommand, launchRegisteredProject, cwdExists } from './launchProject';
import { showOnboardingNotification, isSetupComplete } from './onboarding';
import { executeRemoveLegacyHooksCommand, maybePromptLegacyHookCleanup } from './legacyHooks';
import { executeDiagnoseCommand, maybeToastDiagnostics } from './diagnostics';
import { runSetupWizard } from './wizard';
import { readExtensionVersion, soundsDir } from './claudePaths';
import { ensureSoundsDirWithReadme } from './soundsReadme';
import * as path from 'path';

const SETUP_PROMPTED_KEY = 'claudelike-bar.setupPrompted';
const LAST_VERSION_KEY = 'claudelike-bar.lastVersion';
const LEGACY_HOOKS_PROMPTED_KEY = 'claudelike-bar.legacyHooksPrompted';
const DIAGNOSTICS_FINGERPRINT_KEY = 'claudelike-bar.diagnosticsFingerprint';

const STATUS_DIR = getStatusDir();
const DEBUG_FLAG = path.join(STATUS_DIR, '.debug');
const AUTO_START_REVIVE_GRACE_MS = 1200;

type LogFn = (msg: string | (() => string)) => void;

export function activate(context: vscode.ExtensionContext) {
  // v0.14 — wire the bundled-sounds dir so `turn-done-default.mp3` and
  // `can-crack.mp3` resolve without the user copying them into
  // ~/.claude/sounds/. Path is fine to join synchronously — it's only
  // validated lazily on each getAudioConfig() call.
  const configManager = new ConfigManager(
    undefined,
    path.join(context.extensionPath, 'media', 'sounds'),
  );

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
  const removeLegacyHooksCmd = vscode.commands.registerCommand(
    'claudeDashboard.removeLegacyHooks',
    () => executeRemoveLegacyHooksCommand((m) => log(m)),
  );
  const bundledSoundsDir = path.join(context.extensionPath, 'media', 'sounds');
  const diagnoseCmd = vscode.commands.registerCommand(
    'claudeDashboard.diagnose',
    () => executeDiagnoseCommand(configManager, bundledSoundsDir, output),
  );

  // Refresh tiles on terminal changes. Declared early so audio commands
  // below can call it. The audioEnabled flag rides along so the webview
  // context menu can label the toggle "Mute" vs "Unmute" without a separate
  // round-trip.
  const refreshTiles = () => {
    const tiles = tracker.getTiles();
    provider.updateTiles(tiles, configManager.isAudioEnabled(), configManager.getSortMode(), configManager.getShowLastPrompt());
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

  // v0.16.5 (#18) — focus a tile by its position in the current sort
  // (1-indexed slots, 9 max — VS Code keybinding chords commonly use
  // ctrl+alt+1..9). Skips registered tiles since they have no underlying
  // VS Code terminal to focus. Soft no-op + toast when the slot is empty.
  function focusTileBySlot(slot: number): void {
    const live = tracker.getTiles().filter((t) => t.status !== 'registered');
    const tile = live[slot - 1];
    if (!tile) {
      vscode.window.showInformationMessage(
        `Claudelike Bar: no tile in slot ${slot} (${live.length} tile${live.length === 1 ? '' : 's'} currently in the bar).`,
      );
      log(`focusSlot${slot}: no tile (live count=${live.length})`);
      return;
    }
    const term = tracker.getTerminalById(tile.id);
    if (!term) {
      log(`focusSlot${slot}: tracked tile "${tile.name}" but no live VS Code terminal`);
      return;
    }
    term.show();
    log(`focusSlot${slot}: focused "${tile.name}"`);
  }
  const focusSlotCmds = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
    vscode.commands.registerCommand(`claudeDashboard.focusSlot${n}`, () => focusTileBySlot(n)),
  );

  // v0.16.5 (#18) — focus a specific named tile. Bind via keybindings.json
  // with an `args` string: { "command": "claudeDashboard.focusByName",
  // "args": "api", "key": "ctrl+alt+a" }. Matches against displayName
  // first (what the user sees on the tile), then raw terminal.name, then
  // projectName alias — same priority order as the status-routing matcher
  // so name resolution feels consistent across features.
  const focusByNameCmd = vscode.commands.registerCommand(
    'claudeDashboard.focusByName',
    (name?: string) => {
      if (typeof name !== 'string' || name.length === 0) {
        vscode.window.showWarningMessage(
          'Claudelike Bar: focusByName requires a name argument. Bind it via keybindings.json with `"args": "<tile-name>"`.',
        );
        return;
      }
      const live = tracker.getTiles().filter((t) => t.status !== 'registered');
      const tile = live.find((t) => t.displayName === name)
        ?? live.find((t) => t.name === name)
        ?? live.find((t) => configManager.getTerminal(t.name)?.projectName === name);
      if (!tile) {
        vscode.window.showInformationMessage(
          `Claudelike Bar: no live tile named "${name}". Open the terminal first or check the spelling.`,
        );
        log(`focusByName("${name}"): no match`);
        return;
      }
      const term = tracker.getTerminalById(tile.id);
      if (term) {
        term.show();
        log(`focusByName("${name}"): focused "${tile.name}"`);
      }
    },
  );

  // v0.12 — private test hook. Fires a play for `filename` and resolves
  // with the webview's ack: 'played' (audio.play resolved), 'error' (it
  // rejected — autoplay blocked or decode failed), or 'timeout'. Used only
  // by the CI autoplay smoke test. Underscore prefix + not listed in
  // package.json contributes signals "do not use."
  interface FirePlayResult { status: 'played' | 'error' | 'timeout'; reason?: string }
  const firePlayForTestCmd = vscode.commands.registerCommand(
    'claudeDashboard.__firePlayForTest',
    (filename: string, volume = 0, timeoutMs = 5000): Promise<FirePlayResult> => {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: FirePlayResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sub.dispose();
          resolve(result);
        };
        const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);
        const sub = provider.onAudioAck((ack) => {
          // Match by filename so an unrelated in-flight play doesn't
          // resolve this call (test runs in isolation so this is belt-
          // and-braces, but cheap).
          if (!ack.url.endsWith(`/${filename}`)) return;
          settle({
            status: ack.type === 'played' ? 'played' : 'error',
            reason: ack.reason,
          });
        });
        provider.postPlay(filename, volume);
      });
    },
  );

  // v0.14 — one-shot check for pre-bar notify*.sh hook entries left over
  // from custom setups. Offers cleanup if any are found. Gated on a
  // dedicated globalState key so 'Don't ask again' persists across reloads.
  // Fire-and-forget — never blocks activation.
  maybePromptLegacyHookCleanup(context, LEGACY_HOOKS_PROMPTED_KEY, (m) => log(m))
    .catch((err) => log(`legacy-hooks prompt failed: ${err instanceof Error ? err.message : err}`));

  // v0.14 — activation-time health check. Toasts once when diagnostic state
  // changes; stays silent when the same issues as last session are still
  // present (avoids reload-spam). Runs on a short delay so it doesn't
  // compete with the onboarding notification.
  setTimeout(() => {
    maybeToastDiagnostics(context, configManager, bundledSoundsDir, DIAGNOSTICS_FINGERPRINT_KEY, output)
      .catch((err) => log(`diagnostics toast failed: ${err instanceof Error ? err.message : err}`));
  }, 1500);

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

      case 'setSortMode':
        configManager.setSortMode(message.mode);
        refreshTiles();
        break;

      case 'setPinned':
        tracker.setPinned(message.id, message.pinned);
        break;

      case 'renameTile': {
        // v0.16.3 (#11) — show an InputBox prefilled with the current
        // displayName. Empty/cancel = no change. Whitespace-trimmed result
        // is persisted as nickname (display) + projectName (status routing)
        // on the matching config entry. The tile updates immediately via
        // the onChange fire inside setRenameOverride.
        const tile = tracker.getTiles().find((t) => t.id === message.id);
        if (!tile) break;
        const current = tile.displayName || tile.name;
        vscode.window.showInputBox({
          prompt: `Rename "${tile.name}"`,
          value: current,
          placeHolder: 'New display name (or empty to revert to terminal name)',
          validateInput: (value) => {
            // Reject only inputs that would round-trip into a different
            // tile's slug — that would silently steal status updates.
            const trimmed = value.trim();
            if (trimmed === current.trim() || trimmed === tile.name) return null;
            const conflict = tracker.getTiles().find((t) =>
              t.id !== tile.id && (t.name === trimmed || t.displayName === trimmed),
            );
            if (conflict) {
              return `Another tile already uses "${trimmed}" — pick a different name.`;
            }
            return null;
          },
        }).then((result) => {
          // undefined = user pressed Esc / closed without confirming.
          if (result === undefined) return;
          tracker.setRenameOverride(message.id, result);
          log(`renameTile ${tile.name}: → "${result}"`);
        });
        break;
      }

      case 'showLastPrompt': {
        // v0.16.4 (#19) — full-text last-prompt readout. Tooltip on the
        // tile shows a truncated version; this command surfaces the
        // complete string (up to the hook's 300-char cap) in a copyable
        // info message. No-op when the tile has no prompt yet.
        const tile = tracker.getTiles().find((t) => t.id === message.id);
        if (!tile?.lastPrompt) {
          vscode.window.showInformationMessage(
            `Claudelike Bar: no recorded prompt for "${tile?.displayName ?? '?'}". Submit a prompt in that terminal to capture one.`,
          );
          break;
        }
        const when = tile.lastPromptAt
          ? new Date(tile.lastPromptAt * 1000).toLocaleTimeString()
          : 'unknown';
        vscode.window.showInformationMessage(
          `${tile.displayName} — last prompt at ${when}:\n\n${tile.lastPrompt}`,
          { modal: true },
        );
        break;
      }

      case 'launchByName':
        // v0.13.4 (#15) — click on a registered (offline) tile launches
        // the project. Routes through the same shared helper as the
        // QuickPick launcher and runAutoStart.
        launchRegisteredProject(configManager, tracker, message.name, log);
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
    // v0.16.4 (#19) — last user prompt is independent of state-machine
    // transitions. The hook only writes last_prompt on UserPromptSubmit
    // (it survives across other events via the read-merge-write), so the
    // tracker only needs to update it when the field is actually present.
    if (data.last_prompt && data.last_prompt_at) {
      tracker.updateLastPrompt(data.project, data.last_prompt, data.last_prompt_at);
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
    removeLegacyHooksCmd,
    diagnoseCmd,
    toggleAudioCmd,
    openSoundsFolderCmd,
    ...focusSlotCmds,
    focusByNameCmd,
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

  // v0.13.1 (#13) — pre-check cwds so we can surface ONE friendly toast
  // rather than N modal VS Code errors if the user has stale entries
  // (moved/renamed/deleted project dirs). The helper re-checks as a safety
  // net for any direct callers.
  const skippedForMissingCwd: string[] = [];
  for (const name of autoStartNames) {
    const opts = configManager.getAutoStartTerminalOptions(name);
    if (opts.cwd && !cwdExists(opts.cwd)) skippedForMissingCwd.push(name);
  }

  // Delegate per-name to the shared helper so auto-start and the
  // "Launch Registered Project" command can't drift in their createTerminal
  // wiring. The helper logs the "already open" and "missing cwd" cases
  // itself; nothing else belongs in this loop.
  for (const name of autoStartNames) {
    launchRegisteredProject(configManager, tracker, name, log);
  }

  if (skippedForMissingCwd.length > 0) {
    const list = skippedForMissingCwd.map((n) => `"${n}"`).join(', ');
    vscode.window
      .showWarningMessage(
        `Claudelike Bar skipped ${skippedForMissingCwd.length} auto-start terminal(s) with missing paths: ${list}. Edit the config to fix or remove them.`,
        'Open Config',
      )
      .then((pick) => {
        if (pick === 'Open Config') {
          vscode.commands.executeCommand('claudeDashboard.openConfig');
        }
      });
  }
}

export function deactivate() {
  // Cleanup handled by disposables
}
