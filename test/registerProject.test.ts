import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';
import { executeRegisterProjectCommand } from '../src/registerProject';

vi.mock('vscode', () => import('./__mocks__/vscode'));

const noopLog = () => {};

describe('executeRegisterProjectCommand', () => {
  let tmpWorkspace: string;
  let tmpProjectDir: string;
  let cm: ConfigManager;
  let tracker: TerminalTracker;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-ws-'));
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-proj-'));
    (vscode.window.createTerminal as any).mockReset();
    (vscode.window.showQuickPick as any).mockReset();
    (vscode.window.showInputBox as any).mockReset();
    (vscode.window.showOpenDialog as any).mockReset();
    (vscode.window.showInformationMessage as any).mockReset();
    (vscode.window.terminals as any).length = 0;
  });

  afterEach(() => {
    if (tracker) tracker.dispose();
    if (cm) cm.dispose();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  function makeCm(): ConfigManager {
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, noopLog);
    return cm;
  }

  function stagePicker(slug: string, finalChoice: string | undefined): void {
    (vscode.window.showOpenDialog as any).mockResolvedValueOnce([
      { fsPath: tmpProjectDir },
    ]);
    (vscode.window.showInputBox as any).mockResolvedValueOnce(slug);
    (vscode.window.showQuickPick as any).mockResolvedValueOnce(finalChoice);
  }

  it('register-and-open: creates a terminal and persists autoStart=true (default branch)', async () => {
    makeCm();
    stagePicker('my-proj', 'Open terminal now (default)');
    (vscode.window.createTerminal as any).mockImplementation((opts: any) => ({
      name: opts?.name, sendText: vi.fn(), show: vi.fn(), dispose: vi.fn(),
    }));

    await executeRegisterProjectCommand(cm, tracker, noopLog);

    expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
    const entry = cm.getTerminal('my-proj');
    expect(entry).toBeDefined();
    expect(entry?.autoStart).toBe(true);
    expect(entry?.path).toBe(tmpProjectDir);
  });

  it('register-only: persists autoStart=false and does not create a terminal', async () => {
    makeCm();
    stagePicker('my-proj', "Register only — I'll launch later");
    (vscode.window.createTerminal as any).mockImplementation((opts: any) => ({
      name: opts?.name, sendText: vi.fn(), show: vi.fn(), dispose: vi.fn(),
    }));

    await executeRegisterProjectCommand(cm, tracker, noopLog);

    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    const entry = cm.getTerminal('my-proj');
    expect(entry).toBeDefined();
    expect(entry?.autoStart).toBe(false);
    expect(entry?.path).toBe(tmpProjectDir);

    // Toast text mentions the slug + how to launch later.
    const toast = (vscode.window.showInformationMessage as any).mock.calls[0][0];
    expect(toast).toContain('my-proj');
    expect(toast).toMatch(/Launch Registered Project|launch later/i);
  });

  it('cancel at the open-now QuickPick is treated as "open now" (preserves muscle memory)', async () => {
    makeCm();
    stagePicker('my-proj', undefined); // user pressed Escape on the final QuickPick
    (vscode.window.createTerminal as any).mockImplementation((opts: any) => ({
      name: opts?.name, sendText: vi.fn(), show: vi.fn(), dispose: vi.fn(),
    }));

    await executeRegisterProjectCommand(cm, tracker, noopLog);

    expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
    const entry = cm.getTerminal('my-proj');
    expect(entry?.autoStart).toBe(true);
  });

  it('cancel at the folder picker exits without writing config', async () => {
    makeCm();
    (vscode.window.showOpenDialog as any).mockResolvedValueOnce(undefined);

    await executeRegisterProjectCommand(cm, tracker, noopLog);

    expect(cm.getAll()).toEqual({});
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('cancel at the slug input exits without writing config', async () => {
    makeCm();
    (vscode.window.showOpenDialog as any).mockResolvedValueOnce([
      { fsPath: tmpProjectDir },
    ]);
    (vscode.window.showInputBox as any).mockResolvedValueOnce(undefined);

    await executeRegisterProjectCommand(cm, tracker, noopLog);

    expect(cm.getAll()).toEqual({});
    expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});
