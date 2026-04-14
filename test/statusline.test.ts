import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  runStatuslineSetup,
  isStatuslineConfigured,
  isClaudelikeStatuslineActive,
  STATUSLINE_FILENAME,
} from '../src/statusline';

const STATUSLINE_PATH = path.resolve(__dirname, '..', 'hooks', STATUSLINE_FILENAME);

describe('statusline module (install)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let extensionPath: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-home-'));
    extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-ext-'));
    fs.mkdirSync(path.join(extensionPath, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, 'hooks', STATUSLINE_FILENAME),
      '#!/usr/bin/env node\nprocess.stdout.write("test statusline");\n',
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  it('installs script and registers statusLine in fresh environment', async () => {
    const result = await runStatuslineSetup(extensionPath);
    expect(result.scriptInstalled).toBe(true);
    expect(result.settingsUpdated).toBe(true);

    const scriptPath = path.join(fakeHome, '.claude', 'hooks', STATUSLINE_FILENAME);
    expect(fs.existsSync(scriptPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
    expect(settings.statusLine?.type).toBe('command');
    expect(settings.statusLine?.command).toContain(STATUSLINE_FILENAME);
  });

  it('does NOT replace existing user statusline by default', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: '~/.claude/my-custom-statusline.sh',
          padding: 0,
        },
      }),
    );

    const result = await runStatuslineSetup(extensionPath);
    // Script is copied (idempotent), but settings are untouched
    expect(result.scriptInstalled).toBe(true);
    expect(result.settingsUpdated).toBe(false);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine?.command).toBe('~/.claude/my-custom-statusline.sh');
  });

  it('replaces existing statusline when force=true', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: '~/.claude/my-custom-statusline.sh' },
      }),
    );

    const result = await runStatuslineSetup(extensionPath, true);
    expect(result.settingsUpdated).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine?.command).toContain(STATUSLINE_FILENAME);
  });

  it('re-runs idempotently when Claudelike statusline is already registered', async () => {
    await runStatuslineSetup(extensionPath);
    const result = await runStatuslineSetup(extensionPath);
    // Second run: command still points at our statusline, settings get rewritten
    // but value is the same
    expect(result.scriptInstalled).toBe(true);
  });

  it('isStatuslineConfigured returns true only when statusLine.command is set', async () => {
    expect(isStatuslineConfigured()).toBe(false);
    await runStatuslineSetup(extensionPath);
    expect(isStatuslineConfigured()).toBe(true);
  });

  it('isClaudelikeStatuslineActive distinguishes our statusline from others', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/other.sh' } }),
    );

    expect(isStatuslineConfigured()).toBe(true);
    expect(isClaudelikeStatuslineActive()).toBe(false);

    await runStatuslineSetup(extensionPath, true); // force replace
    expect(isClaudelikeStatuslineActive()).toBe(true);
  });

  it('preserves other settings keys when installing statusline', async () => {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [] }] }, someSetting: 'keep' }),
    );

    await runStatuslineSetup(extensionPath);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.someSetting).toBe('keep');
    expect(Array.isArray(settings.hooks?.PreToolUse)).toBe(true);
  });

  it('leaves no .tmp files behind after install', async () => {
    await runStatuslineSetup(extensionPath);
    const files = fs.readdirSync(path.join(fakeHome, '.claude'));
    expect(files.filter(f => f.includes('.tmp'))).toHaveLength(0);
  });

  it('throws clearly when bundled script is missing', async () => {
    fs.rmSync(path.join(extensionPath, 'hooks'), { recursive: true });
    await expect(runStatuslineSetup(extensionPath)).rejects.toThrow(/not found/);
  });
});

describe('claudelike-statusline.js script (stdin → status file + display)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-script-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function run(stdin: string, env: Record<string, string> = {}) {
    const result = spawnSync('node', [STATUSLINE_PATH], {
      input: stdin,
      env: { ...process.env, CLAUDELIKE_STATUS_DIR: tmpDir, ...env },
      encoding: 'utf8',
    });
    return { stdout: result.stdout, exitCode: result.status };
  }

  it('writes context_percent to status file', () => {
    const stdin = JSON.stringify({
      workspace: { current_dir: path.join(tmpDir, 'my-app') },
      context_window: { used_percentage: 42.7 },
    });
    run(stdin);
    const statusFile = path.join(tmpDir, 'my-app.json');
    expect(fs.existsSync(statusFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(data.context_percent).toBe(42);
    expect(data.project).toBe('my-app');
  });

  it('outputs a minimal display line including context %', () => {
    const stdin = JSON.stringify({
      model: { display_name: 'Claude Opus 4.6' },
      workspace: { current_dir: path.join(tmpDir, 'my-app') },
      context_window: { used_percentage: 42 },
    });
    const { stdout } = run(stdin);
    expect(stdout).toContain('Claude Opus 4.6');
    expect(stdout).toContain('my-app');
    expect(stdout).toContain('ctx 42%');
  });

  it('merges context_percent into existing status file (preserves status)', () => {
    // Pre-seed status file from a hook event
    const projectDir = path.join(tmpDir, 'my-app');
    const statusFile = path.join(tmpDir, 'my-app.json');
    fs.writeFileSync(statusFile, JSON.stringify({
      project: 'my-app',
      status: 'working',
      timestamp: 1000,
      event: 'PreToolUse',
    }));

    const stdin = JSON.stringify({
      workspace: { current_dir: projectDir },
      context_window: { used_percentage: 55 },
    });
    run(stdin);

    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(data.status).toBe('working'); // preserved
    expect(data.event).toBe('PreToolUse'); // preserved
    expect(data.context_percent).toBe(55); // added
  });

  it('omits context_percent entirely when payload lacks context_window', () => {
    const stdin = JSON.stringify({
      workspace: { current_dir: path.join(tmpDir, 'my-app') },
    });
    run(stdin);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'my-app.json'), 'utf8'));
    // No context_percent field written — prevents clobbering a prior good value
    expect(data.context_percent).toBeUndefined();
  });

  it('handles malformed JSON gracefully (exits 0, writes default)', () => {
    const { exitCode } = run('not-json');
    expect(exitCode).toBe(0);
  });

  it('clamps out-of-range context percentages to [0, 100]', () => {
    const stdin = JSON.stringify({
      workspace: { current_dir: path.join(tmpDir, 'my-app') },
      context_window: { used_percentage: 250 },
    });
    run(stdin);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'my-app.json'), 'utf8'));
    expect(data.context_percent).toBeLessThanOrEqual(100);
  });

  it('honors CLAUDELIKE_BAR_NAME env override for project name', () => {
    const stdin = JSON.stringify({
      workspace: { current_dir: path.join(tmpDir, 'different-name') },
      context_window: { used_percentage: 30 },
    });
    run(stdin, { CLAUDELIKE_BAR_NAME: 'explicit' });
    expect(fs.existsSync(path.join(tmpDir, 'explicit.json'))).toBe(true);
  });

  it('does NOT overwrite existing context_percent when input has no context_window', () => {
    // Pre-seed status file with a valid context %
    const statusFile = path.join(tmpDir, 'my-app.json');
    fs.writeFileSync(statusFile, JSON.stringify({
      project: 'my-app',
      status: 'working',
      timestamp: 1000,
      context_percent: 73,
    }));

    // Run statusline with payload lacking context_window
    const stdin = JSON.stringify({ workspace: { current_dir: path.join(tmpDir, 'my-app') } });
    run(stdin);

    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(data.context_percent).toBe(73); // preserved, NOT reset to 0
  });

  it('does NOT write context_percent on empty stdin', () => {
    const statusFile = path.join(tmpDir, 'my-app.json');
    fs.writeFileSync(statusFile, JSON.stringify({
      project: 'my-app',
      context_percent: 88,
    }));

    // No stdin at all — statusline should not mutate context_percent
    spawnSync('node', [STATUSLINE_PATH], {
      env: { ...process.env, CLAUDELIKE_STATUS_DIR: tmpDir, CLAUDELIKE_BAR_NAME: 'my-app' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(data.context_percent).toBe(88);
  });

  it('omits "ctx N%" from display output when context is unavailable', () => {
    const stdin = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: path.join(tmpDir, 'my-app') },
    });
    const { stdout } = run(stdin);
    expect(stdout).not.toContain('ctx 0%');
    expect(stdout).not.toContain('ctx');
    expect(stdout).toContain('Claude');
  });
});

describe('dashboard-status.js hook (context_percent preservation)', () => {
  const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'dashboard-status.js');
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-preserve-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('preserves context_percent written by statusline when hook fires', () => {
    // Simulate: statusline wrote context_percent, then hook fires
    const statusFile = path.join(tmpDir, 'my-project.json');
    fs.writeFileSync(statusFile, JSON.stringify({
      project: 'my-project',
      status: 'ready',
      timestamp: 1000,
      event: 'Stop',
      context_percent: 42,
    }));

    // Hook fires for a new event
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd: path.join(tmpDir, 'my-project'),
    });
    spawnSync('node', [HOOK_PATH], {
      input: stdin,
      env: { ...process.env, CLAUDELIKE_STATUS_DIR: tmpDir },
      encoding: 'utf8',
    });

    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // Hook owns status/event/timestamp — those update
    expect(data.status).toBe('working');
    expect(data.event).toBe('PreToolUse');
    // Hook does NOT own context_percent — that survives
    expect(data.context_percent).toBe(42);
  });
});
