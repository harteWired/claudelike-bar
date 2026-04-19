import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';

/**
 * ConfigManager options tests — verify the v0.9.2 cross-platform auto-start
 * contract. The extension passes `env` through createTerminal's API so the
 * hook gets CLAUDELIKE_BAR_NAME without any shell-syntax quoting, and
 * optionally passes `shellPath` / `shellArgs` from per-terminal config so
 * Windows users can pin git-bash (or any shell) for bash-syntax commands.
 */
describe('ConfigManager.getAutoStartTerminalOptions', () => {
  let tmpWorkspace: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-opts-test-'));
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
    // The mock vscode workspaceFolders returns a fixed test path; override
    // by placing the config in a known temp dir and poking vscode's mock.
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    return cm;
  }

  it('always sets CLAUDELIKE_BAR_NAME env matching the terminal name', () => {
    writeConfig({ terminals: { 'my-terminal': { color: 'cyan', icon: null, nickname: null, autoStart: true } } });
    const opts = makeCm().getAutoStartTerminalOptions('my-terminal');
    expect(opts.env.CLAUDELIKE_BAR_NAME).toBe('my-terminal');
  });

  it('sets env even for terminal names not yet in the config', () => {
    writeConfig({ terminals: {} });
    const opts = makeCm().getAutoStartTerminalOptions('fresh-terminal');
    expect(opts.env.CLAUDELIKE_BAR_NAME).toBe('fresh-terminal');
  });

  it('preserves special characters in the env var (no shell quoting needed)', () => {
    writeConfig({ terminals: { "Matt's Project": { color: 'cyan', icon: null, nickname: null, autoStart: true } } });
    const opts = makeCm().getAutoStartTerminalOptions("Matt's Project");
    // createTerminal({env}) takes the raw string through the API; no escaping
    // required. This is the whole point of replacing sendText('export ...').
    expect(opts.env.CLAUDELIKE_BAR_NAME).toBe("Matt's Project");
  });

  it('omits shellPath/shellArgs when the terminal config has none', () => {
    writeConfig({ terminals: { 'plain': { color: 'cyan', icon: null, nickname: null, autoStart: true } } });
    const opts = makeCm().getAutoStartTerminalOptions('plain');
    expect(opts.shellPath).toBeUndefined();
    expect(opts.shellArgs).toBeUndefined();
  });

  it('returns shellPath when the terminal config sets one', () => {
    writeConfig({
      terminals: {
        'pinned-bash': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('pinned-bash');
    expect(opts.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(opts.shellArgs).toBeUndefined();
  });

  it('returns shellPath + shellArgs when the config sets both', () => {
    writeConfig({
      terminals: {
        'pwsh-clean': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: 'pwsh.exe',
          shellArgs: ['-NoProfile', '-Command'],
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('pwsh-clean');
    expect(opts.shellPath).toBe('pwsh.exe');
    expect(opts.shellArgs).toEqual(['-NoProfile', '-Command']);
  });

  it('ignores shellArgs without shellPath (no partial config)', () => {
    writeConfig({
      terminals: {
        'bad-cfg': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellArgs: ['--what'],
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('bad-cfg');
    expect(opts.shellPath).toBeUndefined();
    expect(opts.shellArgs).toBeUndefined();
  });

  it('ignores empty-string shellPath (treats as unset)', () => {
    writeConfig({
      terminals: {
        'empty': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: '',
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('empty');
    expect(opts.shellPath).toBeUndefined();
  });

  it('filters non-string shellArgs entries (defensive — JSONC is untyped)', () => {
    writeConfig({
      terminals: {
        'defensive': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: '/bin/bash',
          // JSONC can smuggle arbitrary values; we only accept strings.
          shellArgs: ['-l', 42, null, '-i'] as any,
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('defensive');
    expect(opts.shellArgs).toEqual(['-l', '-i']);
  });

  it('cwd defaults to path when cwd is unset', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          path: '/home/user/projects/proj',
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('proj');
    expect(opts.cwd).toBe('/home/user/projects/proj');
  });

  it('explicit cwd overrides path', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          path: '/home/user/projects/proj',
          cwd: '/home/user/projects/proj/subdir',
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('proj');
    expect(opts.cwd).toBe('/home/user/projects/proj/subdir');
  });

  it('addProjectEntry adds a fully-specified entry', () => {
    writeConfig({ terminals: {} });
    const cm2 = makeCm();
    const added = cm2.addProjectEntry('new-proj', {
      path: '/some/path',
      command: 'claude',
      color: 'cyan',
      icon: null,
      nickname: null,
      autoStart: true,
    });
    expect(added).toBe(true);
    const cfg = cm2.getTerminal('new-proj');
    expect(cfg?.path).toBe('/some/path');
    expect(cfg?.command).toBe('claude');
    expect(cfg?.autoStart).toBe(true);
  });

  it('addProjectEntry refuses to overwrite without overwrite flag', () => {
    writeConfig({
      terminals: {
        'existing': { color: 'cyan', icon: null, nickname: null, autoStart: true, path: '/original' },
      },
    });
    const cm2 = makeCm();
    const result = cm2.addProjectEntry('existing', {
      path: '/overwrite-attempt',
      command: 'claude',
      color: 'green',
      icon: null,
      nickname: null,
      autoStart: false,
    });
    expect(result).toBe(false);
    expect(cm2.getTerminal('existing')?.path).toBe('/original');
  });

  it('addProjectEntry overwrites when overwrite=true', () => {
    writeConfig({
      terminals: {
        'existing': { color: 'cyan', icon: null, nickname: null, autoStart: true, path: '/original' },
      },
    });
    const cm2 = makeCm();
    const result = cm2.addProjectEntry('existing', {
      path: '/new-path',
      command: 'claude',
      color: 'green',
      icon: null,
      nickname: null,
      autoStart: false,
    }, true);
    expect(result).toBe(true);
    expect(cm2.getTerminal('existing')?.path).toBe('/new-path');
  });

  it('returns cwd when the terminal config sets one', () => {
    writeConfig({
      terminals: {
        'with-cwd': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          cwd: 'C:\\Users\\me\\projects\\foo',
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('with-cwd');
    expect(opts.cwd).toBe('C:\\Users\\me\\projects\\foo');
    expect(opts.env.CLAUDELIKE_BAR_NAME).toBe('with-cwd');
  });

  it('omits cwd when the terminal config has none', () => {
    writeConfig({
      terminals: {
        'no-cwd': { color: 'cyan', icon: null, nickname: null, autoStart: true },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('no-cwd');
    expect(opts.cwd).toBeUndefined();
  });

  it('ignores empty-string cwd (treats as unset)', () => {
    writeConfig({
      terminals: {
        'empty-cwd': { color: 'cyan', icon: null, nickname: null, autoStart: true, cwd: '' },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('empty-cwd');
    expect(opts.cwd).toBeUndefined();
  });

  // --- cd → cwd migration (v0.9.4) ---

  it('migrates cd /path && command into cwd + command on load', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: "cd '/home/user/projects/proj' && claude --enable-auto-mode",
        },
      },
    });
    const cm2 = makeCm();
    const cfg = cm2.getTerminal('proj');
    expect(cfg?.cwd).toBe('/home/user/projects/proj');
    expect(cfg?.command).toBe('claude --enable-auto-mode');
  });

  it('migrates cd with double quotes', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: 'cd "C:\\Users\\me\\proj" && claude',
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBe('C:\\Users\\me\\proj');
    expect(cfg?.command).toBe('claude');
  });

  it('migrates cd with unquoted path (no spaces)', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: 'cd /workspace/projects/proj && claude',
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBe('/workspace/projects/proj');
    expect(cfg?.command).toBe('claude');
  });

  it('migrates cd with semicolon separator (PowerShell-style)', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: "cd 'C:\\Users\\me\\proj'; claude --enable-auto-mode",
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBe('C:\\Users\\me\\proj');
    expect(cfg?.command).toBe('claude --enable-auto-mode');
  });

  it('does NOT migrate when cwd is already set', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          cwd: '/already/set',
          command: "cd /other/path && claude",
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBe('/already/set');
    expect(cfg?.command).toBe('cd /other/path && claude');
  });

  it('does NOT migrate commands that are not cd patterns', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: 'claude --enable-auto-mode',
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBeUndefined();
    expect(cfg?.command).toBe('claude --enable-auto-mode');
  });

  it('handles Windows paths with spaces in single quotes', () => {
    writeConfig({
      terminals: {
        'proj': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          command: "cd 'C:/Users/MattHarte/Documents/Claude Code/Chief-of-Staff' && claude --enable-auto-mode",
        },
      },
    });
    const cfg = makeCm().getTerminal('proj');
    expect(cfg?.cwd).toBe('C:/Users/MattHarte/Documents/Claude Code/Chief-of-Staff');
    expect(cfg?.command).toBe('claude --enable-auto-mode');
  });

  // --- v0.12 audio section ---

  describe('audio config parsing', () => {
    let soundsDir: string;

    beforeEach(() => {
      soundsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-audio-sounds-'));
    });

    afterEach(() => {
      fs.rmSync(soundsDir, { recursive: true, force: true });
    });

    function dropFile(name: string) {
      fs.writeFileSync(path.join(soundsDir, name), 'x');
    }

    it('returns sensible defaults when no audio section is present', () => {
      writeConfig({ terminals: {} });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.enabled).toBe(false);
      expect(audio.volume).toBe(0.6);
      expect(audio.debounceMs).toBe(150);
      expect(audio.sounds.turnDone).toBeNull();
      expect(audio.sounds.midJobPrompt).toBeNull();
    });

    it('parses a fully-specified audio section', () => {
      dropFile('chime.mp3');
      dropFile('ping.mp3');
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          volume: 0.3,
          debounceMs: 250,
          sounds: { turnDone: 'chime.mp3', midJobPrompt: 'ping.mp3' },
        },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.enabled).toBe(true);
      expect(audio.volume).toBe(0.3);
      expect(audio.debounceMs).toBe(250);
      expect(audio.sounds.turnDone).toBe('chime.mp3');
      expect(audio.sounds.midJobPrompt).toBe('ping.mp3');
    });

    it('v0.14 legacy compat: reads `ready` as turnDone and `permission` as midJobPrompt', () => {
      dropFile('chime.mp3');
      dropFile('ping.mp3');
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          sounds: { ready: 'chime.mp3', permission: 'ping.mp3' },
        },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.sounds.turnDone).toBe('chime.mp3');
      expect(audio.sounds.midJobPrompt).toBe('ping.mp3');
    });

    it('v0.14 new name wins when both old and new keys are present', () => {
      dropFile('new.mp3');
      dropFile('legacy.mp3');
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          sounds: { turnDone: 'new.mp3', ready: 'legacy.mp3' },
        },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.sounds.turnDone).toBe('new.mp3');
    });

    it('rejects path-traversal filenames (whitelist regex)', () => {
      // Even if the file exists, the name must match ^[a-zA-Z0-9._-]+$.
      // Slashes and leading dots beyond the filename part are rejected.
      writeConfig({
        terminals: {},
        audio: { enabled: true, sounds: { turnDone: '../evil.mp3' } },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.sounds.turnDone).toBeNull();
    });

    it('rejects filenames for files that do not exist in the sounds dir', () => {
      writeConfig({
        terminals: {},
        audio: { enabled: true, sounds: { turnDone: 'ghost.mp3' } },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.sounds.turnDone).toBeNull();
    });

    it('slots fail independently — invalid midJobPrompt does not disable turnDone', () => {
      dropFile('chime.mp3');
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          sounds: { turnDone: 'chime.mp3', midJobPrompt: 'missing.mp3' },
        },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      expect(audio.sounds.turnDone).toBe('chime.mp3');
      expect(audio.sounds.midJobPrompt).toBeNull();
    });

    it('clamps out-of-range volume to default', () => {
      writeConfig({
        terminals: {},
        audio: { enabled: true, volume: 2.5, sounds: {} },
      });
      const audio = makeCm().getAudioConfig(soundsDir);
      // Out-of-range → default, not clamped-to-1. Keeps the config explicit.
      expect(audio.volume).toBe(0.6);
    });

    it('preserves unknown audio.* keys through read-merge-write', () => {
      dropFile('chime.mp3');
      // User has added an experimental slot `error` that v1 doesn't wire up;
      // the config must preserve it unchanged across save.
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          customKey: 'experimental-value',
          sounds: { turnDone: 'chime.mp3', error: 'oh-no.mp3' },
        },
      });
      const cm2 = makeCm();
      // Force a save by toggling an unrelated field.
      cm2.setAudioEnabled(false);
      // Flush by disposing (disposer calls save() for pending debounces).
      cm2.dispose();

      // Re-read raw file contents to verify preservation.
      const raw = fs.readFileSync(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), 'utf-8');
      expect(raw).toContain('customKey');
      expect(raw).toContain('experimental-value');
      expect(raw).toContain('oh-no.mp3');
      // Reset cm field so afterEach doesn't try to dispose a second time.
      cm = undefined as any;
    });

    it('v0.14 bundled fallback: filename resolves from bundled dir when missing in user dir', () => {
      // Two separate dirs — user dir empty, bundled dir has the file. The
      // validator must resolve the slot via bundled fallback.
      const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-'));
      try {
        fs.writeFileSync(path.join(bundledDir, 'turn-done-default.mp3'), 'x');
        writeConfig({
          terminals: {},
          audio: { enabled: true, sounds: { turnDone: 'turn-done-default.mp3' } },
        });
        const cm2 = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), bundledDir);
        const audio = cm2.getAudioConfig(soundsDir);
        expect(audio.sounds.turnDone).toBe('turn-done-default.mp3');
        cm2.dispose();
      } finally {
        fs.rmSync(bundledDir, { recursive: true, force: true });
      }
    });

    it('v0.14 bundled fallback: user dir wins over bundled dir for same filename', () => {
      dropFile('turn-done-default.mp3'); // user-dir version
      const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-'));
      try {
        // Bundled also has a file with the same name — user dir should win,
        // but since validateSlot only returns the filename (not a path), the
        // fact that both exist only matters for the downstream URI resolver.
        // This test guards that the slot is considered VALID when either
        // dir has it, not silently nulled due to conflicting state.
        fs.writeFileSync(path.join(bundledDir, 'turn-done-default.mp3'), 'x');
        writeConfig({
          terminals: {},
          audio: { enabled: true, sounds: { turnDone: 'turn-done-default.mp3' } },
        });
        const cm2 = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), bundledDir);
        const audio = cm2.getAudioConfig(soundsDir);
        expect(audio.sounds.turnDone).toBe('turn-done-default.mp3');
        cm2.dispose();
      } finally {
        fs.rmSync(bundledDir, { recursive: true, force: true });
      }
    });

    it('v0.14 fresh config: first save seeds turnDone with bundled default', () => {
      // No audio section at all in the source config — the serializer
      // should treat this as a never-configured audio block and default
      // turnDone to the bundled filename.
      writeConfig({ terminals: {} });
      const cm2 = makeCm();
      // Trigger a save by enabling audio.
      cm2.setAudioEnabled(true);
      cm2.dispose();

      const raw = fs.readFileSync(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), 'utf-8');
      expect(raw).toContain('turn-done-default.mp3');
      cm = undefined as any;
    });

    it('v0.14 explicit null preserves user intent across save', () => {
      dropFile('ping.mp3');
      // User explicitly set turnDone:null because they want silence on
      // turn-done. The fresh-config default must NOT overwrite this.
      writeConfig({
        terminals: {},
        audio: {
          enabled: true,
          sounds: { turnDone: null, midJobPrompt: 'ping.mp3' },
        },
      });
      const cm2 = makeCm();
      cm2.setAudioEnabled(false);
      cm2.dispose();

      const raw = fs.readFileSync(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), 'utf-8');
      const audioMatch = raw.match(/"audio":\s*\{[\s\S]*?^\s*\},$/m);
      expect(audioMatch).not.toBeNull();
      const audioBlock = audioMatch![0];
      // turnDone is explicitly null — not replaced with the bundled default.
      expect(audioBlock).toMatch(/"turnDone"\s*:\s*null/);
      expect(audioBlock).not.toContain('turn-done-default.mp3');
      cm = undefined as any;
    });

    it('v0.14 migration: save drops legacy `ready`/`permission` keys', () => {
      dropFile('chime.mp3');
      dropFile('ping.mp3');
      // User still has v0.12-era keys; on first save we rewrite with new names.
      writeConfig({
        terminals: {},
        audio: {
          enabled: false,
          sounds: { ready: 'chime.mp3', permission: 'ping.mp3' },
        },
      });
      const cm2 = makeCm();
      cm2.setAudioEnabled(true);
      cm2.dispose();

      const raw = fs.readFileSync(path.join(tmpWorkspace, '.claudelike-bar.jsonc'), 'utf-8');
      // Extract the audio section so we only assert against its keys — the
      // labels block has its own `ready` key that shouldn't trip us up.
      const audioMatch = raw.match(/"audio":\s*\{[\s\S]*?^\s*\},$/m);
      expect(audioMatch, 'audio block not found in serialized config').not.toBeNull();
      const audioBlock = audioMatch![0];
      // New names written:
      expect(audioBlock).toContain('"turnDone"');
      expect(audioBlock).toContain('"midJobPrompt"');
      // Filenames preserved through the rename:
      expect(audioBlock).toContain('chime.mp3');
      expect(audioBlock).toContain('ping.mp3');
      // Legacy keys are gone from the audio block.
      expect(audioBlock).not.toMatch(/"ready"\s*:/);
      expect(audioBlock).not.toMatch(/"permission"\s*:/);
      cm = undefined as any;
    });

    it('setAudioEnabled toggles the master switch and preserves sounds', () => {
      dropFile('chime.mp3');
      writeConfig({
        terminals: {},
        audio: { enabled: false, sounds: { turnDone: 'chime.mp3' } },
      });
      const cm2 = makeCm();
      cm2.setAudioEnabled(true);
      const audio = cm2.getAudioConfig(soundsDir);
      expect(audio.enabled).toBe(true);
      expect(audio.sounds.turnDone).toBe('chime.mp3');
    });
  });

  it('drops shellArgs when every entry is non-string (remains undefined)', () => {
    writeConfig({
      terminals: {
        'all-garbage': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: true,
          shellPath: '/bin/bash',
          shellArgs: [42, null, {}] as any,
        },
      },
    });
    const opts = makeCm().getAutoStartTerminalOptions('all-garbage');
    // shellPath retained, but empty shellArgs collapses to undefined so the
    // spread in extension.ts doesn't pass a meaningless empty array.
    expect(opts.shellPath).toBe('/bin/bash');
    expect(opts.shellArgs).toBeUndefined();
  });
});
