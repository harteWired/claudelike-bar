import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';
import { launchRegisteredProject } from '../src/launchProject';

vi.mock('vscode', () => import('./__mocks__/vscode'));

/**
 * End-to-end wiring test for the v0.9.2 cross-platform auto-start path —
 * v0.13: now exercises the extracted `launchRegisteredProject` helper that
 * both `runAutoStart` and the new "Launch Registered Project" command call
 * through. The contract being pinned: the options flowing into
 * createTerminal don't depend on shell syntax — CLAUDELIKE_BAR_NAME comes
 * via the env option, and shellPath/shellArgs are forwarded when the config
 * sets them. Calling the real helper means any drift in extension.ts will
 * surface here without any test-side mirror to maintain.
 */

interface CreateTerminalOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
}

function captureCreateTerminalCalls(): CreateTerminalOptions[] {
  const calls: CreateTerminalOptions[] = [];
  (vscode.window.createTerminal as any).mockImplementation((opts: any) => {
    calls.push(opts);
    return { name: opts?.name, sendText: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  });
  return calls;
}

const noopLog = () => {};

describe('runAutoStart → createTerminal contract (via launchRegisteredProject)', () => {
  let tmpWorkspace: string;
  let cm: ConfigManager;
  let tracker: TerminalTracker;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-start-test-'));
    (vscode.window.createTerminal as any).mockReset();
    (vscode.window.terminals as any).length = 0;
  });

  afterEach(() => {
    if (tracker) tracker.dispose();
    if (cm) cm.dispose();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function writeConfig(config: object): void {
    fs.writeFileSync(
      path.join(tmpWorkspace, '.claudelike-bar.jsonc'),
      JSON.stringify(config),
    );
  }

  function makeCm(): ConfigManager {
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, noopLog);
    return cm;
  }

  function runAutoStartLike(cm: ConfigManager, names: string[]): void {
    for (const name of names) {
      launchRegisteredProject(cm, tracker, name, noopLog);
    }
  }

  it('passes CLAUDELIKE_BAR_NAME env through createTerminal (not sendText)', () => {
    writeConfig({
      terminals: {
        'my-terminal': { color: 'cyan', icon: null, nickname: null, autoStart: true },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['my-terminal']);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('my-terminal');
    expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('my-terminal');
    // Critical — no shellPath/shellArgs unless the config asked for them.
    expect(calls[0].shellPath).toBeUndefined();
    expect(calls[0].shellArgs).toBeUndefined();
  });

  it('forwards shellPath when the terminal config sets one (Windows git-bash case)', () => {
    writeConfig({
      terminals: {
        'my-win-proj': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['my-win-proj']);

    expect(calls[0].shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('my-win-proj');
  });

  it('forwards shellArgs alongside shellPath', () => {
    writeConfig({
      terminals: {
        'pwsh-clean': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: 'pwsh.exe',
          shellArgs: ['-NoProfile'],
        },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['pwsh-clean']);

    expect(calls[0].shellPath).toBe('pwsh.exe');
    expect(calls[0].shellArgs).toEqual(['-NoProfile']);
  });

  it('forwards cwd through createTerminal API (cross-platform, no cd && needed)', () => {
    // v0.13.1 (#13): cwd must exist on disk for the pre-flight check. Uses
    // the real tmpWorkspace so the forwarding assertion (the actual
    // contract under test) fires regardless of the platform running CI.
    writeConfig({
      terminals: {
        'win-proj': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          cwd: tmpWorkspace,
        },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['win-proj']);

    expect(calls[0].cwd).toBe(tmpWorkspace);
    expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('win-proj');
    expect(calls[0].shellPath).toBeUndefined();
  });

  it('(#13) skips entries whose cwd does not exist on disk — no createTerminal call', () => {
    writeConfig({
      terminals: {
        'moved-proj': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          cwd: path.join(tmpWorkspace, 'does-not-exist-ever'),
        },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['moved-proj']);

    // Pre-flight killed it before VS Code would've thrown its modal error.
    expect(calls).toHaveLength(0);
  });

  it('handles names with special shell-meta characters safely', () => {
    // The pre-v0.9.2 bug: terminal.sendText(`export CLAUDELIKE_BAR_NAME=${name}`)
    // required shell quoting. Now the name goes through the createTerminal API
    // as-is and there's no quoting to get wrong. This test nails that down.
    writeConfig({
      terminals: {
        "Matt's $HOME": { color: 'cyan', icon: null, nickname: null, autoStart: true },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ["Matt's $HOME"]);

    expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe("Matt's $HOME");
    expect(calls[0].name).toBe("Matt's $HOME");
  });
});
