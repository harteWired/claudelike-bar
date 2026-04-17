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
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
};

export class RelativePattern {
  constructor(public base: any, public pattern: string) {}
}

// Reset helper for tests
export function __resetMock() {
  _terminals.length = 0;
  window.activeTerminal = undefined;
  vi.clearAllMocks();
}
