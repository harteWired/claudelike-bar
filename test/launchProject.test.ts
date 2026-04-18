import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';
import {
  launchRegisteredProject,
  buildLaunchCandidates,
  executeLaunchProjectCommand,
} from '../src/launchProject';

vi.mock('vscode', () => import('./__mocks__/vscode'));

const noopLog = () => {};

interface CreateTerminalOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
}

function captureCreateTerminalCalls(): { calls: CreateTerminalOptions[]; show: ReturnType<typeof vi.fn> } {
  const calls: CreateTerminalOptions[] = [];
  const show = vi.fn();
  (vscode.window.createTerminal as any).mockImplementation((opts: any) => {
    calls.push(opts);
    return { name: opts?.name, sendText: vi.fn(), show, dispose: vi.fn() };
  });
  return { calls, show };
}

describe('launchProject', () => {
  let tmpWorkspace: string;
  let tmpProjectsRoot: string;
  let cm: ConfigManager;
  let tracker: TerminalTracker;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-ws-'));
    tmpProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-projects-'));
    (vscode.window.createTerminal as any).mockReset();
    (vscode.window.showQuickPick as any).mockReset();
    (vscode.window.showInformationMessage as any).mockReset();
    (vscode.window.terminals as any).length = 0;
  });

  afterEach(() => {
    if (tracker) tracker.dispose();
    if (cm) cm.dispose();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    fs.rmSync(tmpProjectsRoot, { recursive: true, force: true });
  });

  function writeConfig(config: object): void {
    fs.writeFileSync(
      path.join(tmpWorkspace, '.claudelike-bar.jsonc'),
      JSON.stringify(config),
    );
  }

  function makeCm(): ConfigManager {
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(tmpWorkspace), name: 'test', index: 0 },
    ];
    cm = new ConfigManager(path.join(tmpWorkspace, '.claudelike-bar.jsonc'));
    tracker = new TerminalTracker(cm, noopLog);
    return cm;
  }

  function makeProjectDir(name: string): string {
    const dir = path.join(tmpProjectsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── launchRegisteredProject ────────────────────────────────────────

  describe('launchRegisteredProject', () => {
    it('creates a terminal with options matching the auto-start contract', () => {
      const projectDir = makeProjectDir('my-proj');
      writeConfig({
        terminals: {
          'my-proj': {
            color: 'cyan', icon: null, nickname: null, autoStart: false,
            path: projectDir, command: 'claude',
          },
        },
      });
      const { calls } = captureCreateTerminalCalls();
      makeCm();

      const terminal = launchRegisteredProject(cm, tracker, 'my-proj', noopLog);

      expect(terminal).toBeDefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('my-proj');
      expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('my-proj');
      expect(calls[0].cwd).toBe(projectDir);
    });

    it('focuses an already-open terminal instead of creating a duplicate', () => {
      writeConfig({
        terminals: {
          'my-proj': { color: 'cyan', icon: null, nickname: null, autoStart: false },
        },
      });
      const { calls, show } = captureCreateTerminalCalls();
      makeCm();

      // First call creates the terminal. Push it into the mock's terminals
      // array so the tracker (already constructed) doesn't see it — the
      // tracker indexes its own onDidOpenTerminal events. We need to stage
      // the "already tracked" condition by hand.
      const fakeTerminal = (vscode.window.createTerminal as any)({ name: 'my-proj' });
      // Simulate the tracker having indexed this terminal — splice it into
      // the internal map by going through addTerminal via the public
      // onDidOpenTerminal listener path. Cleaner: just verify via
      // getTerminalByName lookup using a tiny shim.
      // Easier: poke the tracker's getTerminalByName to return our terminal.
      const spy = vi.spyOn(tracker, 'getTerminalByName').mockReturnValue(fakeTerminal as any);

      // calls now has the createTerminal from the staging step. Reset the
      // counter so we can prove the focus branch makes zero further calls.
      const callCountBefore = calls.length;
      const showCountBefore = show.mock.calls.length;

      const result = launchRegisteredProject(cm, tracker, 'my-proj', noopLog);

      expect(result).toBeUndefined();
      expect(calls.length).toBe(callCountBefore); // no second createTerminal
      expect(show.mock.calls.length).toBe(showCountBefore + 1); // focused

      spy.mockRestore();
    });

    it('omits cwd/shellPath/shellArgs when the config does not set them', () => {
      writeConfig({
        terminals: {
          'plain': { color: 'cyan', icon: null, nickname: null, autoStart: false },
        },
      });
      const { calls } = captureCreateTerminalCalls();
      makeCm();

      launchRegisteredProject(cm, tracker, 'plain', noopLog);

      expect(calls[0].cwd).toBeUndefined();
      expect(calls[0].shellPath).toBeUndefined();
      expect(calls[0].shellArgs).toBeUndefined();
    });
  });

  // ─── buildLaunchCandidates ──────────────────────────────────────────

  describe('buildLaunchCandidates', () => {
    it('filters out entries whose slug matches a tracked terminal', () => {
      const aDir = makeProjectDir('alpha');
      const bDir = makeProjectDir('beta');
      writeConfig({
        terminals: {
          alpha: { color: 'cyan', icon: null, nickname: null, autoStart: false, path: aDir },
          beta: { color: 'cyan', icon: null, nickname: null, autoStart: false, path: bDir },
        },
      });
      makeCm();

      vi.spyOn(tracker, 'getTiles').mockReturnValue([
        { name: 'alpha' } as any,
      ]);

      const candidates = buildLaunchCandidates(cm, tracker);
      expect(candidates.map((c) => c.slug)).toEqual(['beta']);
    });

    it('filters out entries whose path is set but does not exist on disk', () => {
      const liveDir = makeProjectDir('live');
      writeConfig({
        terminals: {
          live: { color: 'cyan', icon: null, nickname: null, autoStart: false, path: liveDir },
          dead: { color: 'cyan', icon: null, nickname: null, autoStart: false, path: '/nonexistent/path/that/should/never/exist' },
        },
      });
      makeCm();

      const candidates = buildLaunchCandidates(cm, tracker);
      expect(candidates.map((c) => c.slug)).toEqual(['live']);
    });

    it('keeps entries with no path set (path-missing filter is opt-in via path field)', () => {
      writeConfig({
        terminals: {
          pathless: { color: 'cyan', icon: null, nickname: null, autoStart: false },
        },
      });
      makeCm();

      const candidates = buildLaunchCandidates(cm, tracker);
      expect(candidates.map((c) => c.slug)).toEqual(['pathless']);
    });

    it('sorts by slug in auto sort mode', () => {
      writeConfig({
        sortMode: 'auto',
        terminals: {
          zulu: { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 0 },
          alpha: { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 5 },
          mike: { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 2 },
        },
      });
      makeCm();

      const candidates = buildLaunchCandidates(cm, tracker);
      // auto mode ignores `order` for the QuickPick; alphabetical wins.
      expect(candidates.map((c) => c.slug)).toEqual(['alpha', 'mike', 'zulu']);
    });

    it('sorts by order in manual sort mode (unordered last, then by slug)', () => {
      writeConfig({
        sortMode: 'manual',
        terminals: {
          gamma: { color: 'cyan', icon: null, nickname: null, autoStart: false }, // unordered
          alpha: { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 2 },
          beta: { color: 'cyan', icon: null, nickname: null, autoStart: false, order: 0 },
          delta: { color: 'cyan', icon: null, nickname: null, autoStart: false }, // unordered
        },
      });
      makeCm();

      const candidates = buildLaunchCandidates(cm, tracker);
      expect(candidates.map((c) => c.slug)).toEqual(['beta', 'alpha', 'delta', 'gamma']);
    });
  });

  // ─── executeLaunchProjectCommand ────────────────────────────────────

  describe('executeLaunchProjectCommand', () => {
    it('shows an info toast when there are no launchable candidates', async () => {
      writeConfig({
        terminals: {
          alpha: { color: 'cyan', icon: null, nickname: null, autoStart: false },
        },
      });
      const { calls } = captureCreateTerminalCalls();
      makeCm();

      vi.spyOn(tracker, 'getTiles').mockReturnValue([
        { name: 'alpha' } as any,
      ]);

      await executeLaunchProjectCommand(cm, tracker, noopLog);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      const message = (vscode.window.showInformationMessage as any).mock.calls[0][0];
      expect(message).toMatch(/no registered projects to launch/i);
      expect(calls).toHaveLength(0);
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('routes the picked slug (not the label) through launchRegisteredProject', async () => {
      const aDir = makeProjectDir('alpha');
      writeConfig({
        terminals: {
          alpha: {
            color: 'cyan', icon: null, nickname: 'Alpha (the cool one)',
            autoStart: false, path: aDir, command: 'claude',
          },
        },
      });
      const { calls } = captureCreateTerminalCalls();
      makeCm();

      // The QuickPick item the user "picks" returns the LaunchQuickPickItem
      // with the label "Alpha (the cool one)" but slug "alpha".
      (vscode.window.showQuickPick as any).mockResolvedValueOnce({
        label: 'Alpha (the cool one)',
        slug: 'alpha',
      });

      await executeLaunchProjectCommand(cm, tracker, noopLog);

      expect(calls).toHaveLength(1);
      // Critical: createTerminal received name="alpha" (the slug),
      // not "Alpha (the cool one)" (the label).
      expect(calls[0].name).toBe('alpha');
      expect(calls[0].env?.CLAUDELIKE_BAR_NAME).toBe('alpha');
    });

    it('does nothing when the user dismisses the QuickPick', async () => {
      writeConfig({
        terminals: {
          alpha: { color: 'cyan', icon: null, nickname: null, autoStart: false },
        },
      });
      const { calls } = captureCreateTerminalCalls();
      makeCm();

      (vscode.window.showQuickPick as any).mockResolvedValueOnce(undefined);

      await executeLaunchProjectCommand(cm, tracker, noopLog);

      expect(calls).toHaveLength(0);
    });

    it('builds QuickPick items with label/description/detail per spec', async () => {
      const aDir = makeProjectDir('alpha');
      const bDir = makeProjectDir('beta');
      writeConfig({
        terminals: {
          alpha: {
            color: 'cyan', icon: null, nickname: 'Alpha', autoStart: false,
            path: aDir, command: 'claude --quiet',
          },
          beta: {
            color: 'cyan', icon: null, nickname: null, autoStart: false,
            path: bDir, command: null,
          },
        },
      });
      captureCreateTerminalCalls();
      makeCm();

      (vscode.window.showQuickPick as any).mockResolvedValueOnce(undefined);
      await executeLaunchProjectCommand(cm, tracker, noopLog);

      const items = (vscode.window.showQuickPick as any).mock.calls[0][0];
      expect(items).toHaveLength(2);

      const alpha = items.find((i: any) => i.slug === 'alpha');
      expect(alpha.label).toBe('Alpha');
      expect(alpha.description).toBe('alpha'); // distinct from label, so shown
      expect(alpha.detail).toBe(`${aDir} · claude --quiet`);

      const beta = items.find((i: any) => i.slug === 'beta');
      expect(beta.label).toBe('beta');
      expect(beta.description).toBeUndefined(); // matches label, so omitted
      expect(beta.detail).toBe(`${bDir} · (no command)`);
    });
  });
});
