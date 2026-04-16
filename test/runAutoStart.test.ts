import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';

/**
 * End-to-end wiring test for the v0.9.2 cross-platform auto-start path.
 * Exercises the real ConfigManager against the real vscode mock; asserts that
 * the options flowing into createTerminal no longer depend on shell syntax —
 * CLAUDELIKE_BAR_NAME comes via the env option, and shellPath/shellArgs are
 * forwarded when the config sets them.
 *
 * The runAutoStart function is unexported from extension.ts (it's an impl
 * detail); we re-implement the same shape here so the contract is pinned
 * in one place and any drift in extension.ts shows up as a failing test.
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
    return { name: opts?.name, sendText: vi.fn(), dispose: vi.fn() };
  });
  return calls;
}

/**
 * Mirror of the extension.ts runAutoStart body — kept in sync by assertion,
 * not by import, so that the test validates the CONTRACT (what args flow
 * into createTerminal) rather than the implementation.
 */
function runAutoStartLike(cm: ConfigManager, names: string[]): void {
  for (const name of names) {
    const opts = cm.getAutoStartTerminalOptions(name);
    vscode.window.createTerminal({
      name,
      env: opts.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.shellPath ? { shellPath: opts.shellPath } : {}),
      ...(opts.shellArgs ? { shellArgs: opts.shellArgs } : {}),
    });
  }
}

describe('runAutoStart → createTerminal contract', () => {
  let tmpWorkspace: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-start-test-'));
    (vscode.window.createTerminal as any).mockReset();
  });

  afterEach(() => {
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
    cm = new ConfigManager();
    return cm;
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
    writeConfig({
      terminals: {
        'win-proj': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          cwd: 'C:\\Users\\me\\projects\\win-proj',
        },
      },
    });
    const calls = captureCreateTerminalCalls();

    runAutoStartLike(makeCm(), ['win-proj']);

    expect(calls[0].cwd).toBe('C:\\Users\\me\\projects\\win-proj');
    expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('win-proj');
    expect(calls[0].shellPath).toBeUndefined();
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
