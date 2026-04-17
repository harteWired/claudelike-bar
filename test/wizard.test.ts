import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetMock, window } from './__mocks__/vscode';
import {
  scanForProjects,
  buildSlugAssignments,
  assignColors,
  buildProjectEntries,
  runSetupWizard,
} from '../src/wizard';
import type { WizardProjectEntry } from '../src/wizard';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('vscode', () => import('./__mocks__/vscode'));

// ═══════════════════════════════════════════════════════════════
//  Pure function tests
// ═══════════════════════════════════════════════════════════════

describe('scanForProjects', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-scan-'));
  });

  it('returns immediate child directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'alpha'));
    fs.mkdirSync(path.join(tmpDir, 'beta'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), '');

    const results = scanForProjects(tmpDir);
    expect(results).toHaveLength(2);
    expect(results.map(p => path.basename(p))).toEqual(['alpha', 'beta']);
  });

  it('skips hidden directories', () => {
    fs.mkdirSync(path.join(tmpDir, '.hidden'));
    fs.mkdirSync(path.join(tmpDir, 'visible'));

    const results = scanForProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(path.basename(results[0])).toBe('visible');
  });

  it('skips node_modules', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.mkdirSync(path.join(tmpDir, 'src'));

    const results = scanForProjects(tmpDir);
    expect(results).toHaveLength(1);
    expect(path.basename(results[0])).toBe('src');
  });

  it('returns empty array for nonexistent directory', () => {
    expect(scanForProjects('/nonexistent/path')).toEqual([]);
  });

  it('returns sorted results', () => {
    fs.mkdirSync(path.join(tmpDir, 'zulu'));
    fs.mkdirSync(path.join(tmpDir, 'alpha'));
    fs.mkdirSync(path.join(tmpDir, 'mike'));

    const results = scanForProjects(tmpDir);
    expect(results.map(p => path.basename(p))).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('depth > 1 includes both parent and child directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'parent'));
    fs.mkdirSync(path.join(tmpDir, 'parent', 'child-a'));
    fs.mkdirSync(path.join(tmpDir, 'parent', 'child-b'));

    const results = scanForProjects(tmpDir, 2);
    const names = results.map(p => path.basename(p));
    expect(names).toContain('parent');
    expect(names).toContain('child-a');
    expect(names).toContain('child-b');
    expect(results).toHaveLength(3);
  });
});

describe('buildSlugAssignments', () => {
  it('derives unique slugs for each folder', () => {
    const folders = ['/home/user/projects/api', '/home/user/projects/web'];
    const assignments = buildSlugAssignments(folders, new Set());

    expect(assignments.get('/home/user/projects/api')).toBe('api');
    expect(assignments.get('/home/user/projects/web')).toBe('web');
  });

  it('avoids collisions with existing slugs', () => {
    const folders = ['/home/user/work/api'];
    const assignments = buildSlugAssignments(folders, new Set(['api']));

    expect(assignments.get('/home/user/work/api')).toBe('work-api');
  });

  it('avoids collisions between new folders', () => {
    const folders = [
      '/home/user/work/client-a/api',
      '/home/user/work/client-b/api',
    ];
    const assignments = buildSlugAssignments(folders, new Set());

    const slugs = [...assignments.values()];
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain('api');
    expect(slugs.some(s => s.includes('client'))).toBe(true);
  });
});

describe('assignColors', () => {
  it('assigns round-robin from available colors', () => {
    const colors = assignColors(['a', 'b', 'c'], new Map());
    expect(colors.get('a')).toBe('cyan');
    expect(colors.get('b')).toBe('green');
    expect(colors.get('c')).toBe('blue');
  });

  it('skips colors already in use', () => {
    const existing = new Map<string, 'cyan'>([['existing', 'cyan']]);
    const colors = assignColors(['a', 'b'], existing);
    expect(colors.get('a')).toBe('green');
    expect(colors.get('b')).toBe('blue');
  });

  it('wraps around when more projects than colors', () => {
    const slugs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const colors = assignColors(slugs, new Map());
    expect(colors.get('g')).toBe('cyan');
  });

  it('uses full palette when all colors are in use', () => {
    const existing = new Map([
      ['e1', 'cyan' as const], ['e2', 'green' as const], ['e3', 'blue' as const],
      ['e4', 'magenta' as const], ['e5', 'yellow' as const], ['e6', 'white' as const],
    ]);
    const colors = assignColors(['a'], existing);
    expect(colors.get('a')).toBe('cyan');
  });
});

describe('buildProjectEntries', () => {
  it('creates config entries from wizard selections', () => {
    const projects: WizardProjectEntry[] = [
      { slug: 'my-api', path: '/home/user/api', color: 'cyan', command: 'claude' },
      { slug: 'my-web', path: '/home/user/web', color: 'green', command: null },
    ];

    const entries = buildProjectEntries(projects);

    expect(Object.keys(entries)).toEqual(['my-api', 'my-web']);
    expect(entries['my-api']).toEqual({
      path: '/home/user/api',
      command: 'claude',
      color: 'cyan',
      icon: null,
      nickname: null,
      autoStart: true,
    });
    expect(entries['my-web'].command).toBeNull();
    expect(entries['my-web'].autoStart).toBe(true);
  });

  it('returns empty object for empty input', () => {
    expect(buildProjectEntries([])).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════
//  Wizard flow tests (mocked VS Code APIs)
// ═══════════════════════════════════════════════════════════════

describe('runSetupWizard', () => {
  let tmpDir: string;
  let configPath: string;

  // Lazy import to pick up the vscode mock
  const makeConfigManager = async () => {
    const { ConfigManager } = await import('../src/configManager');
    return new ConfigManager(configPath);
  };

  beforeEach(() => {
    __resetMock();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-flow-'));
    configPath = path.join(tmpDir, 'claudelike-bar.jsonc');
  });

  it('cancels gracefully when user dismisses step 1', async () => {
    const log = vi.fn();
    window.showQuickPick.mockResolvedValueOnce(undefined);

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('cancelled at step 1'));
    expect(Object.keys(cm.getAll())).toHaveLength(0);
  });

  it('cancels gracefully when user dismisses step 4 (command)', async () => {
    const log = vi.fn();
    const projectDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectDir);

    // Step 1: browse → picks a folder
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: projectDir }]);
    // Step 2: accept all
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    // Step 3: auto colors
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    // Step 4: cancel
    window.showQuickPick.mockResolvedValueOnce(undefined);

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('cancelled at step 4'));
  });

  it('full happy path: browse → accept slugs → auto colors → claude → confirm', async () => {
    const log = vi.fn();
    const projectDir = path.join(tmpDir, 'cool-project');
    fs.mkdirSync(projectDir);

    // Step 1: browse → picks a folder
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: projectDir }]);
    // Step 2: accept all names
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    // Step 3: auto colors
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    // Step 4: claude command
    window.showQuickPick.mockResolvedValueOnce({ label: 'claude', value: 'claude' });
    // Step 5: confirm
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('added 1 project'));
    const all = cm.getAll();
    expect(all['cool-project']).toBeDefined();
    expect(all['cool-project'].path).toBe(projectDir);
    expect(all['cool-project'].command).toBe('claude');
    expect(all['cool-project'].autoStart).toBe(true);
  });

  it('full path with "none" command writes null', async () => {
    const log = vi.fn();
    const projectDir = path.join(tmpDir, 'no-cmd-project');
    fs.mkdirSync(projectDir);

    // Step 1: browse
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: projectDir }]);
    // Step 2: accept
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    // Step 3: auto colors
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    // Step 4: none
    window.showQuickPick.mockResolvedValueOnce({ label: 'None', value: '__none__' });
    // Step 5: confirm
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    const all = cm.getAll();
    expect(all['no-cmd-project'].command).toBeNull();
  });

  it('does not overwrite existing config entries', async () => {
    const log = vi.fn();
    const projectDir = path.join(tmpDir, 'existing-project');
    fs.mkdirSync(projectDir);

    // Pre-populate config
    const cm = await makeConfigManager();
    cm.addProjectEntry('existing-project', {
      path: projectDir,
      command: 'custom-claude',
      color: 'magenta',
      icon: null,
      nickname: null,
      autoStart: false,
    });

    // Step 1-5: try to add the same project
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: projectDir }]);
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'claude', value: 'claude' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    await runSetupWizard(cm, '/ext', log);

    // Original entry preserved — addProjectEntry returns false on collision
    expect(cm.getAll()['existing-project'].command).toBe('custom-claude');
    expect(cm.getAll()['existing-project'].color).toBe('magenta');
  });

  it('handles multiple folders in one wizard run', async () => {
    const log = vi.fn();
    const dir1 = path.join(tmpDir, 'alpha');
    const dir2 = path.join(tmpDir, 'beta');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    // Step 1: browse → picks both folders
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: dir1 }, { fsPath: dir2 }]);
    // Step 2: accept
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    // Step 3: auto colors
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    // Step 4: claude
    window.showQuickPick.mockResolvedValueOnce({ label: 'claude', value: 'claude' });
    // Step 5: confirm
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('added 2 project'));
    const all = cm.getAll();
    expect(all['alpha']).toBeDefined();
    expect(all['beta']).toBeDefined();
    expect(all['alpha'].color).not.toBe(all['beta'].color);
  });

  it('start fresh clears existing entries and replaces with new ones', async () => {
    const log = vi.fn();
    const cm = await makeConfigManager();

    // Pre-populate with stale entries
    cm.addProjectEntry('stale-project', {
      path: '/old/stale',
      command: 'claude',
      color: 'red',
      icon: null,
      nickname: null,
      autoStart: true,
    });
    expect(Object.keys(cm.getAll())).toContain('stale-project');

    const newDir = path.join(tmpDir, 'fresh-project');
    fs.mkdirSync(newDir);

    // Step 1: start fresh → browse
    window.showQuickPick.mockResolvedValueOnce({ label: 'Start fresh', value: 'fresh' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: newDir }]);
    // Step 2: accept
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    // Step 3: auto colors
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    // Step 4: claude
    window.showQuickPick.mockResolvedValueOnce({ label: 'claude', value: 'claude' });
    // Step 5: confirm
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    await runSetupWizard(cm, '/ext', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('cleared existing'));
    const all = cm.getAll();
    expect(Object.keys(all)).not.toContain('stale-project');
    expect(all['fresh-project']).toBeDefined();
    expect(all['fresh-project'].path).toBe(newDir);
  });

  it('start fresh option not shown when config has no terminals', async () => {
    const log = vi.fn();
    const projectDir = path.join(tmpDir, 'new-project');
    fs.mkdirSync(projectDir);

    // Step 1: no "fresh" option — browse directly
    window.showQuickPick.mockResolvedValueOnce({ label: 'Browse', value: 'browse' });
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: projectDir }]);
    // Step 2-5
    window.showQuickPick.mockResolvedValueOnce({ label: 'Accept', value: 'accept' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'Auto', value: 'auto' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'claude', value: 'claude' });
    window.showQuickPick.mockResolvedValueOnce({ label: 'Confirm', value: 'confirm' });

    const cm = await makeConfigManager();
    await runSetupWizard(cm, '/ext', log);

    // Verify the first showQuickPick was called with only 2 items (no "Start fresh")
    const firstCallItems = window.showQuickPick.mock.calls[0][0];
    expect(firstCallItems).toHaveLength(2);
    expect(firstCallItems.map((i: any) => i.value)).not.toContain('fresh');
  });
});
