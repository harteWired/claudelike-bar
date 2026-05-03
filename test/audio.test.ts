import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMock } from './__mocks__/vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';
import { AudioPlayer } from '../src/audio';

/**
 * v0.12 audio-alert tests. Each block sets up a ConfigManager + TerminalTracker
 * against a per-test temp dir (real filesystem, no mocks of Node builtins per
 * project convention) plus a dedicated sounds dir so the filename validator
 * hits real files.
 *
 * The AudioPlayer is wired with a stub `postTarget` that records every call.
 * Tests drive state transitions through the tracker and inspect what the
 * player decided to emit.
 */

interface RecordedPlay { filename: string; volume: number; ts: number }

function makePostTarget(): { target: { postPlay: (filename: string, volume: number) => void }; plays: RecordedPlay[] } {
  const plays: RecordedPlay[] = [];
  return {
    target: {
      postPlay(filename: string, volume: number) {
        plays.push({ filename, volume, ts: Date.now() });
      },
    },
    plays,
  };
}

function setupEnv() {
  __resetMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-test-'));
  const configPath = path.join(root, 'claudelike-bar.jsonc');
  const sounds = path.join(root, 'sounds');
  fs.mkdirSync(sounds, { recursive: true });
  (vscode.workspace as any).workspaceFolders = [
    { uri: (vscode.Uri as any).file(root), name: 'test', index: 0 },
  ];
  return { root, configPath, sounds };
}

function writeConfig(configPath: string, cfg: Record<string, unknown>) {
  fs.writeFileSync(configPath, JSON.stringify({ terminals: {}, ...cfg }));
}

function dropSound(soundsDir: string, name: string) {
  // Real file, non-empty. AudioPlayer only checks existence.
  fs.writeFileSync(path.join(soundsDir, name), 'fake-audio-bytes');
}

function addTerminal(name: string) {
  const t = { name, sendText: vi.fn(), dispose: vi.fn() };
  (vscode.window.terminals as any[]).push(t);
  return t;
}

// AudioPlayer accepts a `soundsDirOverride` constructor arg — tests pass
// their per-test temp dir in and the real ConfigManager routes it through
// to `validateSlot` for us. No monkey-patching required.

describe('AudioPlayer filter: transition into ready', () => {
  let configPath: string, sounds: string, root: string;
  let cm: ConfigManager, tracker: TerminalTracker, player: AudioPlayer;
  let plays: RecordedPlay[];

  beforeEach(() => {
    ({ root, configPath, sounds } = setupEnv());
    dropSound(sounds, 'chime.mp3');
    writeConfig(configPath, {
      audio: { enabled: true, volume: 0.6, debounceMs: 0, sounds: { ready: 'chime.mp3' } },
    });
    addTerminal('proj');
    cm = new ConfigManager(configPath);
    tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    plays = rec.plays;
    player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);
  });

  afterEach(() => {
    player.dispose();
    tracker.dispose();
    cm.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('Stop → ready plays the ready sound', async () => {
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.map((p) => p.filename)).toEqual(['chime.mp3']);
    expect(plays[0].volume).toBe(0.6);
  });

  it('refresh (ready → ready from late Notification) does NOT fire', async () => {
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(1);

    // A late Notification refreshes the label but stays in ready → ready.
    // AudioPlayer must not fire a second chime.
    tracker.updateStatus('proj', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(1);
  });

  it('SubagentStop (never lands on ready) is silent', async () => {
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('proj', 'subagent_stop', 'SubagentStop');
    await new Promise((r) => setTimeout(r, 5));
    // Note: SubagentStop with pendingSubagents = 0 and no teammate_idle
    // *does* promote the tile to ready in the tracker's event-ordering
    // fallback — that is a legitimate user-blocking transition and the
    // audio should fire. Regression-guard the fallback promotion.
    expect(plays.length).toBe(1);
  });

  it('StopFailure → error is silent (no ready transition)', async () => {
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'error', 'StopFailure', undefined, {
      error_type: 'rate_limit',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(0);
  });
});

describe('AudioPlayer slot selection', () => {
  let configPath: string, sounds: string, root: string;
  let cm: ConfigManager, tracker: TerminalTracker, player: AudioPlayer;
  let plays: RecordedPlay[];

  function setup(audioCfg: Record<string, unknown>) {
    ({ root, configPath, sounds } = setupEnv());
    dropSound(sounds, 'chime.mp3');
    dropSound(sounds, 'ping.mp3');
    writeConfig(configPath, { audio: { enabled: true, debounceMs: 0, ...audioCfg } });
    addTerminal('proj');
    cm = new ConfigManager(configPath);
    tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    plays = rec.plays;
    player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);
  }

  afterEach(() => {
    player?.dispose();
    tracker?.dispose();
    cm?.dispose();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('Notification → ready plays permission when set', async () => {
    setup({ sounds: { ready: 'chime.mp3', permission: 'ping.mp3' } });
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.map((p) => p.filename)).toEqual(['ping.mp3']);
  });

  it('Notification → ready falls back to ready slot when permission unset', async () => {
    setup({ sounds: { ready: 'chime.mp3' } });
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.map((p) => p.filename)).toEqual(['chime.mp3']);
  });

  it('Stop → ready always plays ready slot (ignores permission)', async () => {
    setup({ sounds: { ready: 'chime.mp3', permission: 'ping.mp3' } });
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.map((p) => p.filename)).toEqual(['chime.mp3']);
  });
});

describe('AudioPlayer focus skip', () => {
  let root: string, configPath: string, sounds: string;
  let cm: ConfigManager, tracker: TerminalTracker, player: AudioPlayer;
  let plays: RecordedPlay[];
  let term: any;

  function setup(audioOverrides: Record<string, unknown> = {}) {
    ({ root, configPath, sounds } = setupEnv());
    dropSound(sounds, 'chime.mp3');
    writeConfig(configPath, {
      audio: {
        enabled: true,
        debounceMs: 0,
        sounds: { ready: 'chime.mp3' },
        ...audioOverrides,
      },
    });
    term = addTerminal('proj');
    cm = new ConfigManager(configPath);
    tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    plays = rec.plays;
    player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);
  }

  function focusTerm() {
    (vscode.window as any).activeTerminal = term;
    const onChange = (vscode.window.onDidChangeActiveTerminal as any).mock.calls[0][0];
    onChange(term);
  }

  afterEach(() => {
    player.dispose();
    tracker.dispose();
    cm.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tile that is the active terminal DOES play by default (#28 v0.18.0 flip)', async () => {
    // v0.18.0 (#28): default flipped — chimes fire on the focused tile too
    // so users with eyes on the editor pane don't miss turn-done cues.
    setup();
    focusTerm();
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(1);
  });

  it('suppressOnFocusedTile=true restores legacy skip behavior (#28 opt-in)', async () => {
    // Users who prefer the pre-v0.18 silence-on-focused setting flip the
    // explicit flag and the focused tile is skipped again.
    setup({ suppressOnFocusedTile: true });
    focusTerm();
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(0);
  });

  it('suppressOnFocusedTile=true does NOT skip when tile is unfocused (#28 control)', async () => {
    // The flag only acts when the destination tile is the focused terminal.
    // An unfocused tile still chimes, regardless of the flag's value.
    setup({ suppressOnFocusedTile: true });
    // No focusTerm() call — terminal is unfocused.
    tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
    tracker.updateStatus('proj', 'ready', 'Stop');
    await new Promise((r) => setTimeout(r, 5));
    expect(plays.length).toBe(1);
  });
});

describe('AudioPlayer debounce', () => {
  let root: string, configPath: string, sounds: string;
  let cm: ConfigManager, tracker: TerminalTracker, player: AudioPlayer;
  let plays: RecordedPlay[];

  beforeEach(() => {
    ({ root, configPath, sounds } = setupEnv());
    dropSound(sounds, 'chime.mp3');
    writeConfig(configPath, {
      audio: { enabled: true, debounceMs: 50, sounds: { ready: 'chime.mp3' } },
    });
    addTerminal('a');
    addTerminal('b');
    addTerminal('c');
    cm = new ConfigManager(configPath);
    tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    plays = rec.plays;
    player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);
  });

  afterEach(() => {
    player.dispose();
    tracker.dispose();
    cm.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('three tiles flipping to ready inside the debounce window coalesce into one play', async () => {
    for (const n of ['a', 'b', 'c']) {
      tracker.updateStatus(n, 'working', 'UserPromptSubmit');
      tracker.updateStatus(n, 'ready', 'Stop');
    }
    // Wait past the debounce window.
    await new Promise((r) => setTimeout(r, 80));
    expect(plays.length).toBe(1);
    expect(plays[0].filename).toBe('chime.mp3');
  });
});

describe('AudioPlayer enabled:false short-circuit', () => {
  it('enabled:false never fires even with valid sounds', async () => {
    const { root, configPath, sounds } = setupEnv();
    dropSound(sounds, 'chime.mp3');
    writeConfig(configPath, {
      audio: { enabled: false, debounceMs: 0, sounds: { ready: 'chime.mp3' } },
    });
    addTerminal('proj');
    const cm = new ConfigManager(configPath);
    const tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    const player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);

    try {
      tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
      tracker.updateStatus('proj', 'ready', 'Stop');
      await new Promise((r) => setTimeout(r, 5));
      expect(rec.plays.length).toBe(0);
    } finally {
      player.dispose();
      tracker.dispose();
      cm.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AudioPlayer missing-file / bad-filename per slot', () => {
  it('slot with filename that does not exist in sounds dir is treated as unset', async () => {
    const { root, configPath, sounds } = setupEnv();
    dropSound(sounds, 'chime.mp3');
    writeConfig(configPath, {
      audio: {
        enabled: true,
        debounceMs: 0,
        sounds: { ready: 'chime.mp3', permission: 'missing.mp3' },
      },
    });
    addTerminal('proj');
    const cm = new ConfigManager(configPath);
    const tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    const player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);

    try {
      tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
      // Notification → permission slot → missing → fallback to ready.
      tracker.updateStatus('proj', 'ready', 'Notification', undefined, {
        notification_type: 'permission_prompt',
      });
      await new Promise((r) => setTimeout(r, 5));
      // Permission is invalid, so AudioPlayer falls back to the ready slot.
      expect(rec.plays.map((p) => p.filename)).toEqual(['chime.mp3']);
    } finally {
      player.dispose();
      tracker.dispose();
      cm.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('slot with path-traversal filename is rejected (whitelist)', async () => {
    const { root, configPath, sounds } = setupEnv();
    dropSound(sounds, 'chime.mp3');
    // Even if the file physically exists, the name contains a slash and
    // must be rejected by the whitelist.
    writeConfig(configPath, {
      audio: {
        enabled: true,
        debounceMs: 0,
        sounds: { ready: '../../../etc/passwd' },
      },
    });
    addTerminal('proj');
    const cm = new ConfigManager(configPath);
    const tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    const player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);

    try {
      tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
      tracker.updateStatus('proj', 'ready', 'Stop');
      await new Promise((r) => setTimeout(r, 5));
      expect(rec.plays.length).toBe(0);
    } finally {
      player.dispose();
      tracker.dispose();
      cm.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('both slots missing → silent but does not crash', async () => {
    const { root, configPath, sounds } = setupEnv();
    writeConfig(configPath, {
      audio: { enabled: true, debounceMs: 0, sounds: {} },
    });
    addTerminal('proj');
    const cm = new ConfigManager(configPath);
    const tracker = new TerminalTracker(cm);
    const rec = makePostTarget();
    const player = new AudioPlayer(tracker, cm, rec.target, undefined, sounds);

    try {
      tracker.updateStatus('proj', 'working', 'UserPromptSubmit');
      tracker.updateStatus('proj', 'ready', 'Stop');
      await new Promise((r) => setTimeout(r, 5));
      expect(rec.plays.length).toBe(0);
    } finally {
      player.dispose();
      tracker.dispose();
      cm.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
