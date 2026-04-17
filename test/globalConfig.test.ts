import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { __resetMock } from './__mocks__/vscode';
import { ConfigManager } from '../src/configManager';

/**
 * Tests for the v0.10.1 global config: migration from workspace-local,
 * read-merge-write concurrency, and path resolution.
 */

const GLOBAL_ROOT = path.join(os.tmpdir(), 'test-global-config');
const WORKSPACE_ROOT = path.join(os.tmpdir(), 'test-workspace-config');
const GLOBAL_CONFIG = path.join(GLOBAL_ROOT, 'claudelike-bar.jsonc');
const WORKSPACE_JSONC = path.join(WORKSPACE_ROOT, '.claudelike-bar.jsonc');
const WORKSPACE_JSON = path.join(WORKSPACE_ROOT, '.claudelike-bar.json');

function writeGlobal(config: object): void {
  fs.mkdirSync(GLOBAL_ROOT, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(config));
}

function writeWorkspaceJsonc(config: object): void {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.writeFileSync(WORKSPACE_JSONC, JSON.stringify(config));
}

function writeWorkspaceJson(config: object): void {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.writeFileSync(WORKSPACE_JSON, JSON.stringify(config));
}

function clean(): void {
  try { fs.rmSync(GLOBAL_ROOT, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); } catch {}
}

describe('Global config: loading', () => {
  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(WORKSPACE_ROOT), name: 'test', index: 0 },
    ];
    clean();
  });

  afterEach(() => {
    clean();
  });

  it('loads from global path when global config exists', () => {
    writeGlobal({
      terminals: {
        'my-proj': { color: 'cyan', icon: null, nickname: null, autoStart: true },
      },
    });
    const cm = new ConfigManager(GLOBAL_CONFIG);
    expect(cm.getTerminal('my-proj')).toBeDefined();
    expect(cm.getConfigPath()).toBe(GLOBAL_CONFIG);
    cm.dispose();
  });

  it('starts fresh when no config exists anywhere', () => {
    const cm = new ConfigManager(GLOBAL_CONFIG);
    expect(Object.keys(cm.getAll())).toHaveLength(0);
    cm.dispose();
  });
});

describe('Global config: migration from workspace-local', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(WORKSPACE_ROOT), name: 'test', index: 0 },
    ];
    // Point HOME at the test global root so globalConfigPath() resolves there
    originalHome = process.env.HOME;
    process.env.HOME = path.dirname(GLOBAL_ROOT);
    clean();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    clean();
  });

  it('migrates workspace .claudelike-bar.jsonc to global when global does not exist', () => {
    writeWorkspaceJsonc({
      mode: 'passive-aggressive',
      terminals: {
        'old-proj': { color: 'green', icon: null, nickname: null, autoStart: true },
      },
    });
    // ConfigManager without override — uses real globalConfigPath()
    // But we can't easily test without the override since globalConfigPath
    // reads from HOME. We pass the global path explicitly to test the load
    // logic, but the migration requires the workspace folders to find the
    // source. Let's test the load logic at the global path level.

    // Instead, let's directly test that when global config doesn't exist
    // and we construct with the global path, the workspace migration fires
    // by checking the workspace-awareness in the constructor.
    // Since constructor uses globalConfigPath() internally, and we've set
    // HOME, we need to construct without the override for migration to work.
    // But that's tricky in tests. Let's test the explicit-path case instead.

    // Actually: the override path bypasses migration because it goes straight
    // to load(). The migration only runs when using the default constructor.
    // For unit tests of the migration, we need to test it more directly.

    // Test: construct with a global path that doesn't exist — it won't find it,
    // then it checks workspace folders. But configPath is set to the global path
    // while the migration reads from workspace. Let me re-read the code.

    // The load() method checks this.configPath first, then workspace candidates.
    // So if we pass GLOBAL_CONFIG and it doesn't exist, it'll check workspace.
    const cm = new ConfigManager(GLOBAL_CONFIG);
    // After migration, the global config should exist and contain the data.
    expect(fs.existsSync(GLOBAL_CONFIG)).toBe(true);
    expect(cm.getTerminal('old-proj')).toBeDefined();
    expect(cm.getMode()).toBe('passive-aggressive');
    // showInformationMessage should have been called with migration notice.
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    cm.dispose();
  });

  it('migrates legacy .claudelike-bar.json when .jsonc does not exist', () => {
    writeWorkspaceJson({
      terminals: {
        'legacy-proj': { color: 'blue', icon: null, nickname: null, autoStart: false },
      },
    });
    const cm = new ConfigManager(GLOBAL_CONFIG);
    expect(fs.existsSync(GLOBAL_CONFIG)).toBe(true);
    expect(cm.getTerminal('legacy-proj')).toBeDefined();
    cm.dispose();
  });

  it('does NOT migrate when global config already exists', () => {
    writeGlobal({ terminals: { 'global-proj': { color: 'cyan', icon: null, nickname: null, autoStart: true } } });
    writeWorkspaceJsonc({ terminals: { 'workspace-proj': { color: 'green', icon: null, nickname: null, autoStart: true } } });

    const cm = new ConfigManager(GLOBAL_CONFIG);
    // Global wins — workspace data is NOT merged.
    expect(cm.getTerminal('global-proj')).toBeDefined();
    expect(cm.getTerminal('workspace-proj')).toBeUndefined();
    cm.dispose();
  });

  it('applies cd-command migration during workspace→global migration', () => {
    writeWorkspaceJsonc({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: "cd '/home/user/proj' && claude",
        },
      },
    });
    const cm = new ConfigManager(GLOBAL_CONFIG);
    const cfg = cm.getTerminal('proj');
    expect(cfg?.cwd).toBe('/home/user/proj');
    expect(cfg?.command).toBe('claude');
    cm.dispose();
  });
});

describe('Global config: read-merge-write concurrency', () => {
  beforeEach(() => {
    __resetMock();
    clean();
  });

  afterEach(() => {
    clean();
  });

  it('preserves terminals added by another window during save', () => {
    // Window 1 starts with one terminal.
    writeGlobal({
      terminals: {
        'proj-a': { color: 'cyan', icon: null, nickname: null, autoStart: true },
      },
    });
    const cm = new ConfigManager(GLOBAL_CONFIG);
    expect(cm.getTerminal('proj-a')).toBeDefined();

    // Window 2 writes a new terminal to the same file while Window 1 is running.
    const diskConfig = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf-8'));
    diskConfig.terminals['proj-b'] = { color: 'green', icon: null, nickname: null, autoStart: true };
    fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(diskConfig));

    // Window 1 adds its own terminal and saves.
    cm.addProjectEntry('proj-c', {
      color: 'yellow', icon: null, nickname: null, autoStart: true,
    });
    // Force immediate save (bypass debounce for test).
    cm.dispose(); // dispose flushes pending writes

    // Read the final file — all three terminals should be present.
    const final = JSON.parse(
      // The JSONC file has comments; re-parse with jsonc-parser or just check
      // that all keys exist. Since the save uses generateConfigText which
      // outputs JSONC, we need to strip comments for plain JSON.parse.
      fs.readFileSync(GLOBAL_CONFIG, 'utf-8')
        .replace(/\/\/[^\n]*/g, '')
    );
    expect(final.terminals['proj-a']).toBeDefined();
    expect(final.terminals['proj-b']).toBeDefined();
    expect(final.terminals['proj-c']).toBeDefined();
  });
});
