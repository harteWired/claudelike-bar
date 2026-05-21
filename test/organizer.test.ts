import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';
import { OrganizerProvider } from '../src/organizerProvider';
import { launchRegisteredProject } from '../src/launchProject';
import { __resetMock } from './__mocks__/vscode';

vi.mock('vscode', () => import('./__mocks__/vscode'));

/**
 * v0.19 (#44) — when the user drops a closed (non-live) tile into the
 * Pinned or Auto-sort lane, the organizer panel sends `launchNames` in the
 * applyLayout message. The provider applies the config flips AND launches
 * each named tile via `launchRegisteredProject`. This proves the wiring.
 */
describe('OrganizerProvider — launch-on-drop (#44)', () => {
  let tmpWorkspace: string;
  let cm: ConfigManager;
  let tracker: TerminalTracker;
  let organizer: OrganizerProvider;

  beforeEach(() => {
    __resetMock();
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-test-'));
    (vscode.window.terminals as any).length = 0;
    (vscode.window.createTerminal as any).mockReset();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
  });

  afterEach(() => {
    if (organizer) organizer.dispose();
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

  function build(): void {
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, () => {});
    organizer = new OrganizerProvider(
      (vscode.Uri as any).file(tmpWorkspace),
      cm,
      tracker,
    );
    // Mirror extension.ts: register the launchByName command so the
    // organizer's executeCommand dispatch resolves to a real launch.
    vscode.commands.registerCommand('claudeDashboard.launchByName', (name: unknown) => {
      if (typeof name !== 'string') return;
      if (!cm.hasTerminal(name)) return;
      launchRegisteredProject(cm, tracker, name, () => {});
    });
  }

  function captureCreate(): { calls: any[] } {
    const calls: any[] = [];
    (vscode.window.createTerminal as any).mockImplementation((opts: any) => {
      calls.push(opts);
      const t = { name: opts?.name, sendText: vi.fn(), show: vi.fn(), dispose: vi.fn() };
      (vscode.window.terminals as any).push(t);
      return t;
    });
    return { calls };
  }

  it('launches each name in launchNames after applying the layout', () => {
    writeConfig({
      terminals: {
        'fresh': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const { calls } = captureCreate();
    build();

    organizer.handleMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: ['fresh'],
      unpinnedNames: [],
      hiddenNames: [],
      launchNames: ['fresh'],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('fresh');
    expect(cm.getTerminal('fresh')?.pinned).toBe(true);
  });

  it('applies layout but skips launches when launchNames is empty', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const { calls } = captureCreate();
    build();

    organizer.handleMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: ['a'],
      unpinnedNames: [],
      hiddenNames: [],
      launchNames: [],
    });

    expect(calls).toHaveLength(0);
    expect(cm.getTerminal('a')?.pinned).toBe(true);
  });

  it('tolerates a missing launchNames field (back-compat with older webview state)', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const { calls } = captureCreate();
    build();

    // No launchNames in the payload — should still apply the layout cleanly.
    organizer.handleMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: ['a'],
      unpinnedNames: [],
      hiddenNames: [],
    });

    expect(calls).toHaveLength(0);
    expect(cm.getTerminal('a')?.pinned).toBe(true);
  });

  it('launches multiple names in one drop (batch unhide-and-launch)', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'b': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const { calls } = captureCreate();
    build();

    organizer.handleMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: [],
      unpinnedNames: ['a', 'b'],
      hiddenNames: [],
      launchNames: ['a', 'b'],
    });

    expect(calls.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('filters out non-string entries in launchNames defensively', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const { calls } = captureCreate();
    build();

    organizer.handleMessage({
      type: 'organizer:applyLayout',
      pinnedOrder: ['a'],
      unpinnedNames: [],
      hiddenNames: [],
      launchNames: ['a', null, 42, { foo: 'bar' }, undefined],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('a');
  });
});

// v0.19 — untested element §3 from the 0.19.0 plan: panel disposal +
// reopen lifecycle. d7b003b tracked onDidReceiveMessage in subDisposables
// so re-opening shouldn't accumulate orphan listeners. Prove it.
describe('OrganizerProvider — disposal + reopen lifecycle', () => {
  let tmpWorkspace: string;
  let cm: ConfigManager;
  let tracker: TerminalTracker;
  let organizer: OrganizerProvider;

  beforeEach(() => {
    __resetMock();
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-life-test-'));
    (vscode.window.terminals as any).length = 0;
    (vscode.window.createWebviewPanel as any).mockClear();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
    fs.writeFileSync(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), '{ "terminals": {} }');
  });

  afterEach(() => {
    if (organizer) organizer.dispose();
    if (tracker) tracker.dispose();
    if (cm) cm.dispose();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('disposes subDisposables when the panel closes (re-opening starts clean)', () => {
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, () => {});
    organizer = new OrganizerProvider((vscode.Uri as any).file(tmpWorkspace), cm, tracker);

    // Open #1.
    organizer.show();
    const panel1 = (vscode.window.createWebviewPanel as any).mock.results[0].value;
    const listeners1 = panel1.__testListeners();
    expect(listeners1.onDidReceiveMessage.length).toBe(1);

    // Simulate user closing the panel — fires onDidDispose, which should
    // clear all subDisposables (provider's own listener tracking).
    panel1.dispose();

    // Open #2 — fresh panel, fresh listener count. If subDisposables
    // weren't cleared, the provider would double-subscribe to
    // configManager.onChange / tracker.onChange from the first lifecycle.
    organizer.show();
    const panel2 = (vscode.window.createWebviewPanel as any).mock.results[1].value;
    const listeners2 = panel2.__testListeners();
    expect(listeners2.onDidReceiveMessage.length).toBe(1);
  });

  it('disposing the provider tears down the panel cleanly', () => {
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, () => {});
    organizer = new OrganizerProvider((vscode.Uri as any).file(tmpWorkspace), cm, tracker);

    organizer.show();
    const panel = (vscode.window.createWebviewPanel as any).mock.results[0].value;

    organizer.dispose();
    expect(panel.dispose).toHaveBeenCalled();
  });
});
