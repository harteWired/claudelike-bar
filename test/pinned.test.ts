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
