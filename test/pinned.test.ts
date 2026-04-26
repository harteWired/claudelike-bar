import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMock } from './__mocks__/vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';

/**
 * v0.13.4 (#4) — pinned tile zone tests. Pinned tiles live in a fixed-
 * position zone at the bottom of the bar regardless of `sortMode`. The
 * tracker splits tiles into pinned + unpinned, sorts each group, and
 * concats unpinned-first.
 */

let TEST_ROOT: string;
let CONFIG_PATH: string;

function writeConfig(config: Record<string, any>) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

function addMockTerminal(name: string) {
  const t = { name, sendText: vi.fn(), dispose: vi.fn() };
  (vscode.window.terminals as any[]).push(t);
  return t;
}

beforeEach(() => {
  __resetMock();
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-test-'));
  CONFIG_PATH = path.join(TEST_ROOT, '.claudelike-bar.jsonc');
  (vscode.workspace as any).workspaceFolders = [
    { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
  ];
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('ConfigManager.setPinned', () => {
  it('writes pinned: true when set', () => {
    writeConfig({ terminals: { 'a': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    const cm = new ConfigManager(CONFIG_PATH);
    cm.setPinned('a', true);
    expect(cm.getTerminal('a')?.pinned).toBe(true);
    cm.dispose();
  });

  it('deletes pinned key when set false (cleaner config)', () => {
    writeConfig({ terminals: { 'a': { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true } } });
    const cm = new ConfigManager(CONFIG_PATH);
    cm.setPinned('a', false);
    expect(cm.getTerminal('a')?.pinned).toBeUndefined();
    cm.dispose();
  });

  it('no-ops on unknown terminal', () => {
    writeConfig({ terminals: {} });
    const cm = new ConfigManager(CONFIG_PATH);
    expect(() => cm.setPinned('nope', true)).not.toThrow();
    cm.dispose();
  });
});

describe('TerminalTracker.getTiles — pinned zone', () => {
  it('places pinned tiles at the bottom in auto sort mode, regardless of urgency', () => {
    writeConfig({
      sortMode: 'auto',
      terminals: {
        'urgent':    { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'pinned-1':  { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 0 },
        'idle-tile': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('urgent');
    addMockTerminal('pinned-1');
    addMockTerminal('idle-tile');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    // Force urgent to "waiting" — would normally float to top in auto.
    tracker.updateStatus('urgent', 'ready', 'Stop');

    const order = tracker.getTiles().map((t) => t.name);
    // pinned-1 lives at the bottom even though urgent is more important.
    expect(order[order.length - 1]).toBe('pinned-1');
    // urgent floats above idle-tile per status sort.
    expect(order.indexOf('urgent')).toBeLessThan(order.indexOf('idle-tile'));

    tracker.dispose();
    cm.dispose();
  });

  it('sorts multiple pinned tiles by their `order` value', () => {
    writeConfig({
      terminals: {
        'p2': { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 2 },
        'p0': { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 0 },
        'p1': { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 1 },
      },
    });
    addMockTerminal('p2');
    addMockTerminal('p0');
    addMockTerminal('p1');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(tracker.getTiles().map((t) => t.name)).toEqual(['p0', 'p1', 'p2']);

    tracker.dispose();
    cm.dispose();
  });

  it('pinned tiles still sort by `order` in manual mode', () => {
    writeConfig({
      sortMode: 'manual',
      terminals: {
        'unpinned-a': { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 1 },
        'unpinned-b': { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 0 },
        'pinned-z':   { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 0 },
      },
    });
    addMockTerminal('unpinned-a');
    addMockTerminal('unpinned-b');
    addMockTerminal('pinned-z');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    // Unpinned by order, then pinned at bottom.
    expect(tracker.getTiles().map((t) => t.name)).toEqual(['unpinned-b', 'unpinned-a', 'pinned-z']);

    tracker.dispose();
    cm.dispose();
  });

  it('zero pinned tiles → behaviour identical to today', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'b': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('a');
    addMockTerminal('b');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(tracker.getTiles()).toHaveLength(2);
    expect(tracker.getTiles().every((t) => t.pinned !== true)).toBe(true);

    tracker.dispose();
    cm.dispose();
  });
});

describe('TerminalTracker.getTiles — registered (offline) tiles (#15)', () => {
  it('synthesizes a registered tile for each config entry not currently running', () => {
    writeConfig({
      terminals: {
        'live':    { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'offline': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('live'); // only "live" has a real terminal
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const tiles = tracker.getTiles();
    expect(tiles).toHaveLength(2);
    const reg = tiles.find((t) => t.name === 'offline');
    expect(reg?.status).toBe('registered');
    expect(reg?.id).toBeLessThan(0); // synthetic ids are negative

    tracker.dispose();
    cm.dispose();
  });

  it('hides config entries with hidden: true', () => {
    writeConfig({
      terminals: {
        'visible':  { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'archived': { color: 'cyan', icon: null, nickname: null, autoStart: false, hidden: true },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const names = tracker.getTiles().map((t) => t.name);
    expect(names).toContain('visible');
    expect(names).not.toContain('archived');

    tracker.dispose();
    cm.dispose();
  });

  it('respects showRegisteredProjects: false (no synthesized tiles)', () => {
    writeConfig({
      showRegisteredProjects: false,
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(tracker.getTiles()).toHaveLength(0);

    tracker.dispose();
    cm.dispose();
  });

  it('places registered tiles at the very bottom (after pinned)', () => {
    writeConfig({
      terminals: {
        'live':       { color: 'cyan', icon: null, nickname: null, autoStart: false },
        'pinned-one': { color: 'cyan', icon: null, nickname: null, autoStart: false, pinned: true, order: 0 },
        'reg-one':    { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('live');
    addMockTerminal('pinned-one');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const order = tracker.getTiles().map((t) => t.name);
    // live first (unpinned), pinned next, registered last
    expect(order).toEqual(['live', 'pinned-one', 'reg-one']);

    tracker.dispose();
    cm.dispose();
  });

  it('synthetic ids are stable across getTiles() calls (webview diff stability)', () => {
    writeConfig({
      terminals: {
        'a': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const id1 = tracker.getTiles()[0].id;
    const id2 = tracker.getTiles()[0].id;
    expect(id1).toBe(id2);

    tracker.dispose();
    cm.dispose();
  });
});

describe('TerminalTracker.synthesizeRegisteredTiles — status freshness (#20)', () => {
  let STATUS_DIR: string;

  beforeEach(() => {
    STATUS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'status-dir-'));
  });

  afterEach(() => {
    fs.rmSync(STATUS_DIR, { recursive: true, force: true });
  });

  function writeStatus(slug: string, status: string, ageMs = 0) {
    const file = path.join(STATUS_DIR, `${slug}.json`);
    fs.writeFileSync(file, JSON.stringify({ project: slug, status, timestamp: Date.now() }));
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(file, t, t);
    }
  }

  it('suppresses registered tile when status file is fresh and working', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    writeStatus('api', 'working');
    // No VS Code terminal named 'api' — would normally synthesize a registered tile.
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    const tiles = tracker.getTiles();
    expect(tiles.find((t) => t.name === 'api')).toBeUndefined();

    tracker.dispose();
    cm.dispose();
  });

  it('still synthesizes when status file is absent', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    expect(tracker.getTiles().find((t) => t.name === 'api')?.status).toBe('registered');

    tracker.dispose();
    cm.dispose();
  });

  it('still synthesizes when status is idle (not actively live)', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    writeStatus('api', 'idle');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    expect(tracker.getTiles().find((t) => t.name === 'api')?.status).toBe('registered');

    tracker.dispose();
    cm.dispose();
  });

  it('still synthesizes when status is offline', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    writeStatus('api', 'offline');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    expect(tracker.getTiles().find((t) => t.name === 'api')?.status).toBe('registered');

    tracker.dispose();
    cm.dispose();
  });

  it('still synthesizes when status file is stale (>60s old)', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    writeStatus('api', 'working', 120_000);
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    expect(tracker.getTiles().find((t) => t.name === 'api')?.status).toBe('registered');

    tracker.dispose();
    cm.dispose();
  });

  it('gracefully handles malformed status JSON (fall through to synthesis)', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    fs.writeFileSync(path.join(STATUS_DIR, 'api.json'), '{ not valid json');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm, undefined, STATUS_DIR);

    expect(tracker.getTiles().find((t) => t.name === 'api')?.status).toBe('registered');

    tracker.dispose();
    cm.dispose();
  });
});

describe('TerminalTracker.addTerminal — clone suffix (#17)', () => {
  it('does NOT write a config entry for cloned terminals', () => {
    writeConfig({ terminals: { 'api': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    addMockTerminal('api');
    addMockTerminal('api (copy)');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    // Clone exists as a tile in memory...
    const tiles = tracker.getTiles();
    expect(tiles.find((t) => t.name === 'api (copy)')).toBeDefined();
    // ...but no config entry was created.
    expect(cm.getTerminal('api (copy)')).toBeUndefined();

    tracker.dispose();
    cm.dispose();
  });

  it('skips config write for double-cloned names too ("x (copy) (copy)")', () => {
    writeConfig({ terminals: {} });
    addMockTerminal('x (copy) (copy)');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(cm.getTerminal('x (copy) (copy)')).toBeUndefined();

    tracker.dispose();
    cm.dispose();
  });

  it('still writes a config entry for a normal non-clone name', () => {
    writeConfig({ terminals: {} });
    addMockTerminal('mortgage-viz');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(cm.getTerminal('mortgage-viz')).toBeDefined();

    tracker.dispose();
    cm.dispose();
  });

  it('does not flag a name that just contains "(copy)" mid-string', () => {
    // Only the ` (copy)` suffix pattern is excluded; mid-string occurrences
    // don't count (unlikely but possible user-chosen name).
    writeConfig({ terminals: {} });
    addMockTerminal('(copy) weirdproject');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(cm.getTerminal('(copy) weirdproject')).toBeDefined();

    tracker.dispose();
    cm.dispose();
  });
});

describe('TerminalTracker — shell tiles (#25)', () => {
  it('renders shell config entries with status="shell" instead of "idle"', () => {
    writeConfig({
      terminals: {
        'my-shell': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any },
        'my-claude': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('my-shell');
    addMockTerminal('my-claude');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const tiles = tracker.getTiles();
    expect(tiles.find((t) => t.name === 'my-shell')?.status).toBe('shell');
    expect(tiles.find((t) => t.name === 'my-shell')?.type).toBe('shell');
    expect(tiles.find((t) => t.name === 'my-claude')?.status).toBe('idle');
    expect(tiles.find((t) => t.name === 'my-claude')?.type).toBe('claude');

    tracker.dispose();
    cm.dispose();
  });

  it('updateStatus is a no-op for shell tiles (config opt-out is authoritative)', () => {
    writeConfig({
      terminals: {
        'my-shell': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any },
      },
    });
    addMockTerminal('my-shell');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    // Status JSON arriving for a shell tile (e.g. user accidentally set
    // CLAUDELIKE_BAR_NAME) must not flip it to working — config opt-out wins.
    tracker.updateStatus('my-shell', 'working', 'PreToolUse');
    tracker.updateStatus('my-shell', 'ready', 'Stop');

    expect(tracker.getTiles().find((t) => t.name === 'my-shell')?.status).toBe('shell');

    tracker.dispose();
    cm.dispose();
  });

  it('shell tiles sort below idle Claude tiles in auto mode', () => {
    writeConfig({
      sortMode: 'auto',
      terminals: {
        'shell-a': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any },
        'idle-claude': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('shell-a');
    addMockTerminal('idle-claude');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const order = tracker.getTiles().map((t) => t.name);
    expect(order.indexOf('idle-claude')).toBeLessThan(order.indexOf('shell-a'));

    tracker.dispose();
    cm.dispose();
  });

  it('shell tiles get a click-to-launch tile when their terminal is closed (v0.16.1)', () => {
    writeConfig({
      terminals: {
        'absent-shell': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any },
        'absent-claude': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    // Neither terminal is open — synthesis produces a launch tile for both,
    // with the shell entry tagged so the webview renders gray-dot chrome.
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const tiles = tracker.getTiles();
    const shellTile = tiles.find((t) => t.name === 'absent-shell');
    const claudeTile = tiles.find((t) => t.name === 'absent-claude');

    expect(shellTile?.status).toBe('registered');
    expect(shellTile?.type).toBe('shell');
    expect(claudeTile?.status).toBe('registered');
    expect(claudeTile?.type).toBe('claude');

    tracker.dispose();
    cm.dispose();
  });

  it('hidden: true still suppresses shell entries from the launch zone', () => {
    writeConfig({
      terminals: {
        'archived-shell': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any, hidden: true },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(tracker.getTiles()).toHaveLength(0);

    tracker.dispose();
    cm.dispose();
  });

  it('getAutoStartCommand does NOT fall back to global claudeCommand for shell entries (#25)', () => {
    writeConfig({
      claudeCommand: 'claude --auto',
      terminals: {
        'shell-no-cmd': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any },
        'shell-with-cmd': { color: 'white', icon: null, nickname: null, autoStart: false, type: 'shell' as any, command: 'fish' },
        'claude-no-cmd': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);

    // Shell with no per-terminal command → null. NOT the global claudeCommand.
    expect(cm.getAutoStartCommand('shell-no-cmd')).toBeNull();
    // Shell with explicit command → that command.
    expect(cm.getAutoStartCommand('shell-with-cmd')).toBe('fish');
    // Claude with no per-terminal command → falls back to global as before.
    expect(cm.getAutoStartCommand('claude-no-cmd')).toBe('claude --auto');

    cm.dispose();
  });

  it('refreshFromConfig flips shell ↔ claude live (config edit + reload)', () => {
    writeConfig({
      terminals: {
        'flippy': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('flippy');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    expect(tracker.getTiles().find((t) => t.name === 'flippy')?.status).toBe('idle');

    // User edits config: claude → shell.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      terminals: {
        'flippy': { color: 'cyan', icon: null, nickname: null, autoStart: false, type: 'shell' },
      },
    }));
    cm.reload();
    tracker.refreshFromConfig();
    expect(tracker.getTiles().find((t) => t.name === 'flippy')?.status).toBe('shell');
    expect(tracker.getTiles().find((t) => t.name === 'flippy')?.type).toBe('shell');

    // And back: shell → claude.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      terminals: {
        'flippy': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    }));
    cm.reload();
    tracker.refreshFromConfig();
    expect(tracker.getTiles().find((t) => t.name === 'flippy')?.status).toBe('idle');
    expect(tracker.getTiles().find((t) => t.name === 'flippy')?.type).toBe('claude');

    tracker.dispose();
    cm.dispose();
  });
});

describe('Rename tile (#11)', () => {
  it('ConfigManager.setRenameOverride writes nickname + projectName', () => {
    writeConfig({
      terminals: {
        'powershell': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);

    cm.setRenameOverride('powershell', 'my-api');
    const cfg = cm.getTerminal('powershell');
    expect(cfg?.nickname).toBe('my-api');
    expect(cfg?.projectName).toBe('my-api');

    cm.dispose();
  });

  it('ConfigManager.setRenameOverride trims whitespace', () => {
    writeConfig({ terminals: { 'p': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    const cm = new ConfigManager(CONFIG_PATH);

    cm.setRenameOverride('p', '   spaced   ');
    expect(cm.getTerminal('p')?.nickname).toBe('spaced');

    cm.dispose();
  });

  it('ConfigManager.setRenameOverride empty/equal-to-name reverts both fields', () => {
    writeConfig({
      terminals: {
        'p': { color: 'cyan', icon: null, nickname: 'old-nickname', autoStart: false, projectName: 'old-project' },
      },
    });
    const cm = new ConfigManager(CONFIG_PATH);

    cm.setRenameOverride('p', '');
    expect(cm.getTerminal('p')?.nickname).toBeNull();
    expect(cm.getTerminal('p')?.projectName).toBeUndefined();

    cm.setRenameOverride('p', 'reapplied');
    expect(cm.getTerminal('p')?.nickname).toBe('reapplied');

    cm.setRenameOverride('p', 'p'); // same as terminal.name → revert
    expect(cm.getTerminal('p')?.nickname).toBeNull();
    expect(cm.getTerminal('p')?.projectName).toBeUndefined();

    cm.dispose();
  });

  it('TerminalTracker.setRenameOverride updates displayName immediately', () => {
    writeConfig({
      terminals: {
        'powershell': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('powershell');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const before = tracker.getTiles().find((t) => t.name === 'powershell')!;
    expect(before.displayName).toBe('powershell');

    tracker.setRenameOverride(before.id, 'my-api');
    const after = tracker.getTiles().find((t) => t.name === 'powershell')!;
    expect(after.displayName).toBe('my-api');

    tracker.dispose();
    cm.dispose();
  });

  it('renamed tile picks up status updates routed under the new projectName', () => {
    writeConfig({
      terminals: {
        'powershell': { color: 'cyan', icon: null, nickname: null, autoStart: false },
      },
    });
    addMockTerminal('powershell');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const tile = tracker.getTiles().find((t) => t.name === 'powershell')!;
    tracker.setRenameOverride(tile.id, 'my-api');

    // Hook fires for project=my-api — should match the renamed tile via projectName alias.
    tracker.updateStatus('my-api', 'working', 'PreToolUse');
    expect(tracker.getTiles().find((t) => t.name === 'powershell')?.status).toBe('working');

    tracker.dispose();
    cm.dispose();
  });
});

describe('TerminalTracker.setPinned', () => {
  it('flips the tile flag and persists to config', () => {
    writeConfig({ terminals: { 'a': { color: 'cyan', icon: null, nickname: null, autoStart: false } } });
    addMockTerminal('a');
    const cm = new ConfigManager(CONFIG_PATH);
    const tracker = new TerminalTracker(cm);

    const tile = tracker.getTiles().find((t) => t.name === 'a')!;
    expect(tile.pinned).toBe(false);

    tracker.setPinned(tile.id, true);
    expect(tracker.getTiles().find((t) => t.name === 'a')?.pinned).toBe(true);
    expect(cm.getTerminal('a')?.pinned).toBe(true);

    tracker.setPinned(tile.id, false);
    expect(tracker.getTiles().find((t) => t.name === 'a')?.pinned).toBe(false);
    expect(cm.getTerminal('a')?.pinned).toBeUndefined();

    tracker.dispose();
    cm.dispose();
  });
});
