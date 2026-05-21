// Minimal vscode mock for unit testing outside the extension host.
// Only stubs what the source files actually call.

import { vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const TEST_WORKSPACE = path.join(os.tmpdir(), 'test-workspace');

export class EventEmitter {
  private listeners: Function[] = [];
  event = (listener: Function) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data?: any) { for (const l of this.listeners) l(data); }
  dispose() { this.listeners = []; }
}

class MockUri {
  constructor(public readonly fsPath: string) {}
  static file(p: string) { return new MockUri(p); }
  static joinPath(base: MockUri, ...segs: string[]) {
    return new MockUri([base.fsPath, ...segs].join('/'));
  }
}

export const Uri = MockUri;

export const workspace = {
  workspaceFolders: [{ uri: MockUri.file(TEST_WORKSPACE), name: 'test', index: 0 }],
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
};

const _terminals: any[] = [];

export const window = {
  terminals: _terminals,
  activeTerminal: undefined as any,
  onDidOpenTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  createTerminal: vi.fn((opts: any) => {
    const t = { name: opts?.name ?? 'zsh', sendText: vi.fn(), dispose: vi.fn() };
    _terminals.push(t);
    return t;
  }),
  // v0.19 — minimal WebviewPanel mock for organizer/panel lifecycle tests.
  // Records every onDidReceiveMessage/onDidDispose listener so tests can
  // count subscriptions across show/dispose/reopen cycles.
  createWebviewPanel: vi.fn(() => {
    const onDidDisposeListeners: Function[] = [];
    const onDidReceiveMessageListeners: Function[] = [];
    const panel = {
      reveal: vi.fn(),
      dispose: vi.fn(() => {
        for (const l of onDidDisposeListeners) l();
      }),
      iconPath: undefined as any,
      webview: {
        html: '',
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: any) => uri,
        postMessage: vi.fn(() => Promise.resolve(true)),
        onDidReceiveMessage: vi.fn((listener: Function) => {
          onDidReceiveMessageListeners.push(listener);
          return { dispose: () => {
            const i = onDidReceiveMessageListeners.indexOf(listener);
            if (i >= 0) onDidReceiveMessageListeners.splice(i, 1);
          }};
        }),
      },
      onDidDispose: vi.fn((listener: Function) => {
        onDidDisposeListeners.push(listener);
        return { dispose: () => {
          const i = onDidDisposeListeners.indexOf(listener);
          if (i >= 0) onDidDisposeListeners.splice(i, 1);
        }};
      }),
      // Expose internal listener lists for tests to inspect.
      __testListeners: () => ({
        onDidDispose: onDidDisposeListeners,
        onDidReceiveMessage: onDidReceiveMessageListeners,
      }),
    };
    return panel;
  }),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
};

export enum ViewColumn { Active = -1, Beside = -2, One = 1 }

// v0.19 — registerCommand stores the callback so executeCommand can
// dispatch through it. The prior pure-spy versions broke tests that
// exercise the command-dispatch path (e.g. organizer launchByName → launch
// helper). Tests that don't care about dispatch still see the mocks as
// vi.fn() with their existing call assertions intact.
const _commandHandlers = new Map<string, Function>();
export const commands = {
  registerCommand: vi.fn((cmd: string, cb: Function) => {
    _commandHandlers.set(cmd, cb);
    return { dispose: () => _commandHandlers.delete(cmd) };
  }),
  executeCommand: vi.fn((cmd: string, ...args: unknown[]) => {
    const cb = _commandHandlers.get(cmd);
    return cb ? Promise.resolve(cb(...args)) : Promise.resolve(undefined);
  }),
};

export const env = {
  openExternal: vi.fn(),
};

export class RelativePattern {
  constructor(public base: any, public pattern: string) {}
}

// Reset helper for tests
export function __resetMock() {
  _terminals.length = 0;
  window.activeTerminal = undefined;
  _commandHandlers.clear();
  vi.clearAllMocks();
}
