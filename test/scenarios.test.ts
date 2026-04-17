import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMock } from './__mocks__/vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';

/**
 * v0.9.3 scenario tests — walks the state machine through realistic Claude
 * Code hook sequences, ensuring each ends in the UI state the user expects.
 *
 * Sequences cover:
 *   F1 — permission approval closes on PostToolUse (not stuck on ready)
 *   F2 — stale notification_type doesn't leak into Stop events
 *   F3 — ready-to-ready transition refreshes the label
 *   F4 — focus-loss does NOT transition ready → ignored/done
 *   F5 — SessionStart(startup|clear) resets stuck `working` state
 *   F6 — subagent permission prompt surfaces as a label override
 */

const TEST_ROOT = path.join(os.tmpdir(), 'test-scenarios-workspace');
const CONFIG_PATH = path.join(TEST_ROOT, '.claudelike-bar.jsonc');

function writeConfig(config: Record<string, any> = { terminals: {} }) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

function cleanConfig() {
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
}

function addMockTerminal(name: string) {
  const t = { name, sendText: vi.fn(), dispose: vi.fn() };
  (vscode.window.terminals as any[]).push(t);
  return t;
}

/**
 * Shared test fixture for scenario blocks. Builds a fresh ConfigManager +
 * TerminalTracker against a mock workspace with one terminal ("my-project"),
 * and returns helpers that each describe() uses. Caller is responsible for
 * calling `dispose()` in afterEach.
 */
function setupScenarioTracker(configOverrides: Record<string, any> = {}) {
  __resetMock();
  (vscode.workspace as any).workspaceFolders = [
    { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
  ];
  writeConfig({ terminals: {}, ...configOverrides });
  const term = addMockTerminal('my-project');
  const config = new ConfigManager(CONFIG_PATH);
  const tracker = new TerminalTracker(config);
  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;
  const dispose = () => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  };
  return { tracker, config, term, tile, dispose };
}

describe('v0.10 scenario: path-based matching', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({
      terminals: {
        'client-api': {
          color: 'cyan', icon: null, nickname: null, autoStart: true,
          path: '/home/user/work/client-a/api',
        },
        'personal-api': {
          color: 'green', icon: null, nickname: null, autoStart: true,
          path: '/home/user/personal/api',
        },
      },
    });
    addMockTerminal('client-api');
    addMockTerminal('personal-api');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  it('exact slug match: status update for "client-api" hits the right tile', () => {
    tracker.updateStatus('client-api', 'working', 'UserPromptSubmit');
    const tiles = tracker.getTiles();
    const client = tiles.find(t => t.name === 'client-api')!;
    const personal = tiles.find(t => t.name === 'personal-api')!;
    expect(client.status).toBe('working');
    expect(personal.status).toBe('idle');
  });

  it('ambiguous path-basename: hook sends "api" matching both tiles, neither updates (skip)', () => {
    // Both tiles have paths ending in /api, so both score 1.5. The matcher
    // detects the tie and skips — better to drop the update than guess wrong.
    tracker.updateStatus('api', 'working', 'UserPromptSubmit');
    const tiles = tracker.getTiles();
    const matched = tiles.filter(t => t.status === 'working');
    expect(matched.length).toBe(0); // ambiguous → no match
  });

  it('two projects with same basename: slug-based env var disambiguates', () => {
    // Auto-start sets CLAUDELIKE_BAR_NAME=slug, so hook writes the slug
    // directly. No ambiguity.
    tracker.updateStatus('client-api', 'working', 'UserPromptSubmit');
    tracker.updateStatus('personal-api', 'ready', 'Stop');

    const tiles = tracker.getTiles();
    expect(tiles.find(t => t.name === 'client-api')!.status).toBe('working');
    expect(tiles.find(t => t.name === 'personal-api')!.status).toBe('ready');
  });
});

describe('v0.9.3 scenario: permission approval flow (F1 + F3)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {} });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('single-tool permission flow: approve → PostToolUse → working, Stop → ready', () => {
    // 1. User submits prompt
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(tile().status).toBe('working');

    // 2. Claude decides to call a tool
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(tile().status).toBe('working');

    // 3. Permission prompt appears
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().status).toBe('ready');
    expect(tile().statusLabel).toBe('Needs permission');

    // 4. User approves. No hook fires on approval itself.

    // 5. Tool completes — PostToolUse fires (the v0.9.3 rescue signal)
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    // This is the whole point of F1: tile must leave 'ready' once the
    // approved tool actually runs to completion.
    expect(tile().status).toBe('working');
    expect(tile().statusLabel).toBe('Working');

    // 6. End of turn
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(tile().status).toBe('ready');
    expect(tile().statusLabel).toBe('Ready for input');
  });

  it('multi-tool chain: permission on first tool, PreToolUse on second restores working', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().status).toBe('ready');

    // Subsequent tool's PreToolUse arrives before PostToolUse of the first.
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(tile().status).toBe('working');

    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse'); // first tool end
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse'); // second tool end
    expect(tile().status).toBe('working');

    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(tile().status).toBe('ready');
    expect(tile().statusLabel).toBe('Ready for input');
  });

  it('permission rejected: Stop refreshes the "Needs permission" label to default (F3)', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().statusLabel).toBe('Needs permission');

    // User rejects — no PostToolUse. Claude writes a response and ends.
    // Stop arrives with no notification_type (and even if the hook leaks it,
    // F2 gates it on event === 'Notification'). The ready-to-ready refresh
    // must replace the stale "Needs permission" label.
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(tile().status).toBe('ready');
    expect(tile().statusLabel).toBe('Ready for input');
  });

  it('Notification idle_prompt → user types: label correct at each step', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'idle_prompt',
    });
    expect(tile().statusLabel).toBe('Awaiting input');

    // User responds — UserPromptSubmit is the universal reset.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(tile().status).toBe('working');
    expect(tile().statusLabel).toBe('Working');
  });
});

describe('v0.9.3 scenario: stale notification_type leak (F2)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {} });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('Stop carrying stale notification_type (hook read-merge artifact) is ignored', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().statusLabel).toBe('Needs permission');

    // PostToolUse bumps tile back to working.
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('working');

    // Stop arrives. The hook's read-merge-write can leak notification_type
    // from the earlier Notification event into the Stop payload. The
    // extension must ignore it — it's not a Notification anymore.
    tracker.updateStatus('my-project', 'ready', 'Stop', undefined, {
      notification_type: 'permission_prompt', // simulated stale leak
    });
    expect(tile().statusLabel).toBe('Ready for input');
  });

  it('error_type is only trusted when the originating event is StopFailure', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, {
      error_type: 'rate_limit',
    });
    expect(tile().status).toBe('error');
    expect(tile().errorType).toBe('rate_limit');
  });
});

describe('v0.9.3 scenario: focus-loss on ready tile (F4)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;
  let term: any;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {}, mode: 'passive-aggressive' });
    term = addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('approve-and-switch-back DOES NOT mark tile as ignored while status is ready', () => {
    // Setup: tile is in 'ready' because a permission prompt fired.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().status).toBe('ready');

    // User focuses the terminal to approve.
    (vscode.window as any).activeTerminal = term;
    const onChange = (vscode.window.onDidChangeActiveTerminal as any).mock.calls[0][0];
    onChange(term);

    // User switches back to the editor (no active terminal).
    onChange(undefined);

    // PRE-v0.9.3 bug: tile would be 'ignored' here. With F4, it stays 'ready'.
    expect(tile().status).toBe('ready');
  });

  it('focus-loss DOES still mark tile ignored once status has decayed to waiting', () => {
    // Directly force tile into 'waiting' (the 60s timer fire path).
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    // Simulate the 60s timer having fired: poke the state directly.
    const t = tile();
    t.status = 'waiting';
    t.statusLabel = 'Waiting...';

    // Focus the terminal then leave.
    (vscode.window as any).activeTerminal = term;
    const onChange = (vscode.window.onDidChangeActiveTerminal as any).mock.calls[0][0];
    onChange(term);
    onChange(undefined);

    // Waiting → ignored on focus-loss (passive-aggressive mode).
    expect(tile().status).toBe('ignored');
  });
});

describe('v0.9.3 scenario: SessionStart reset (F5)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {} });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('SessionStart(startup) resets a tile stuck in working after a crash', () => {
    // Simulate a pre-crash state: tile in working with a pending subagent.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    expect(tile().status).toBe('working');
    expect(tile().pendingSubagents).toBe(1);

    // Claude crashed — no SessionEnd. User restarts.
    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, {
      source: 'startup',
    });
    expect(tile().status).toBe('idle');
    expect(tile().pendingSubagents).toBe(0);
  });

  it('SessionStart(clear) resets stuck error state too', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, {
      error_type: 'rate_limit',
    });
    expect(tile().status).toBe('error');

    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, {
      source: 'clear',
    });
    expect(tile().status).toBe('idle');
    expect(tile().errorType).toBeUndefined();
  });

  it('SessionStart(resume) leaves active working state alone', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'working', 'PreToolUse');

    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, {
      source: 'resume',
    });
    // Resume is a mid-session resume (e.g., /resume), not a fresh start.
    expect(tile().status).toBe('working');
  });

  it('SessionStart(startup) does NOT un-park a tile the user marked done', () => {
    tracker.markDone(tile().id);
    expect(tile().status).toBe('done');

    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, {
      source: 'startup',
    });
    // done is user-sticky; only UserPromptSubmit un-parks.
    expect(tile().status).toBe('done');
  });

  it('SessionStart still recovers from offline (existing v0.9.1 behaviour preserved)', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, {
      reason: 'logout',
    });
    expect(tile().status).toBe('offline');

    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, {
      source: 'resume', // any source, including resume, recovers from offline
    });
    expect(tile().status).toBe('idle');
  });
});

describe('v0.9.3 scenario: subagent permission prompt (F6)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {} });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('subagent running → permission_prompt surfaces as label override, status stays working', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    expect(tile().status).toBe('working');
    expect(tile().pendingSubagents).toBe(1);

    // Subagent needs permission. Before F6 this notification was suppressed
    // entirely (debug log only).
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().status).toBe('working'); // NOT ready — subagent still active
    expect(tile().statusLabel.toLowerCase()).toContain('subagent needs permission');
    expect(tile().pendingSubagents).toBe(1);
  });

  it('non-permission notifications during subagent work are still suppressed (not label-overridden)', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    const labelBefore = tile().statusLabel;

    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'idle_prompt',
    });
    // idle_prompt during subagent work isn't actionable from the parent —
    // don't swap the label.
    expect(tile().status).toBe('working');
    expect(tile().statusLabel).toBe(labelBefore);
  });

  it('permission_prompt during teammate_idle (no subagent) does NOT label as "subagent needs permission"', () => {
    // Regression test for review pass 1, bug-hunter #1: the F6 guard must
    // require pendingSubagents > 0 so a teammate-only suppress path keeps
    // its own "Waiting for teammate" label.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    expect(tile().teammateIdle).toBe(true);
    expect(tile().pendingSubagents).toBe(0);

    const labelBefore = tile().statusLabel;
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    // Label is unchanged — no subagent, so F6 doesn't fire.
    expect(tile().statusLabel).toBe(labelBefore);
    expect(tile().subagentPermissionPending).toBeFalsy();
  });

  it('subagentPermissionPending clears on tool_end (subagent approved + ran)', () => {
    // Regression test for review pass 1, bug-hunter #2: the flag must clear
    // after the approved subagent tool actually runs so the "subagent needs
    // permission" label doesn't hang around for the rest of the turn.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().subagentPermissionPending).toBe(true);

    // User approves — subagent's tool runs to completion, PostToolUse fires.
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().subagentPermissionPending).toBe(false);
    expect(tile().statusLabel).not.toContain('permission');
    // Still in working because subagent is active.
    expect(tile().status).toBe('working');
    expect(tile().pendingSubagents).toBe(1);
  });

  it('parent PreToolUse clears subagentPermissionPending (review pass 2, bug-hunter #1)', () => {
    // Scenario: subagent permission pending, then the PARENT's next tool
    // starts (unrelated PreToolUse). The subagent-permission label must
    // clear — if the subagent's prompt were genuinely still outstanding,
    // the next Notification would re-arm the flag.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().subagentPermissionPending).toBe(true);

    // Parent fires its own PreToolUse (not a subagent tool).
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(tile().subagentPermissionPending).toBe(false);
    expect(tile().statusLabel).not.toContain('permission');
  });

  it('refreshFromConfig preserves the "subagent needs permission" label via the flag', () => {
    // Regression test for review pass 1, architecture #1: the label is
    // flag-driven now (not a string concat), so a config reload recomposes
    // it correctly instead of silently dropping the suffix.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().statusLabel.toLowerCase()).toContain('subagent needs permission');

    // Simulate a config file change triggering refreshFromConfig.
    tracker.refreshFromConfig();
    expect(tile().statusLabel.toLowerCase()).toContain('subagent needs permission');
  });

  it('SubagentStop after permission override returns to normal working label', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(tile().statusLabel.toLowerCase()).toContain('subagent needs permission');

    // Subagent finishes — counter hits 0, tile promotes to ready.
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    expect(tile().status).toBe('ready');
    expect(tile().statusLabel).toBe('Ready for input');
  });
});

describe('v0.9.3 scenario: PostToolUse with tool failure flag (F1 edge case)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    (vscode.workspace as any).workspaceFolders = [
      { uri: (vscode.Uri as any).file(TEST_ROOT), name: 'test', index: 0 },
    ];
    writeConfig({ terminals: {} });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  const tile = () => tracker.getTiles().find(t => t.name === 'my-project')!;

  it('tool_failure then tool_end preserves the "tool error" label (sticky until Stop)', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'working', 'PreToolUse');

    // Tool errors — flag set while working.
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(tile().toolError).toBe(true);
    expect(tile().statusLabel).toBe('Working (tool error)');

    // PostToolUse fires for the same failed tool (Claude Code emits both).
    // F1 handler preserves the toolError flag so the UI doesn't flicker.
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('working');
    expect(tile().toolError).toBe(true);
    expect(tile().statusLabel).toBe('Working (tool error)');

    // Stop at end-of-turn clears the flag.
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(tile().status).toBe('ready');
    expect(tile().toolError).toBe(false);
  });

  it('tool_end from error state clears error and transitions to working', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, {
      error_type: 'rate_limit',
    });
    expect(tile().status).toBe('error');

    // Claude auto-retries — a successful tool completion is unambiguous
    // recovery evidence (same semantics as PreToolUse).
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('working');
    expect(tile().errorType).toBeUndefined();
  });

  it('tool_end from done state is a no-op (sticky user-park)', () => {
    tracker.markDone(tile().id);
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('done');
  });

  it('tool_end from offline state is a no-op', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, {
      reason: 'logout',
    });
    expect(tile().status).toBe('offline');
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('offline');
  });

  it('tool_end promotes ignored → working (review pass 1, bug-hunter #4)', () => {
    // "ignored" is explicitly non-sticky — all sibling real-activity
    // branches promote out of it, so tool_end must too for consistency.
    // Scenario: passive-aggressive park, user approves a pending permission
    // out of band, PostToolUse fires before any new PreToolUse.
    const t = tile();
    t.status = 'ignored';
    t.statusLabel = 'Being ignored :(';
    tracker.updateStatus('my-project', 'tool_end', 'PostToolUse');
    expect(tile().status).toBe('working');
    expect(tile().statusLabel).toBe('Working');
  });

  it('Notification in already-ready tile restarts the 60s attention timer (F3 extension)', () => {
    // Regression test for review pass 1, bug-hunter #5: a late
    // permission_prompt arriving into an already-ready state needs a fresh
    // attention window, not the tail of the original one.
    vi.useFakeTimers();
    try {
      tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
      tracker.updateStatus('my-project', 'ready', 'Stop');
      expect(tile().status).toBe('ready');

      // 30s into the 60s window, a permission_prompt arrives.
      vi.advanceTimersByTime(30_000);
      tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
        notification_type: 'permission_prompt',
      });
      expect(tile().statusLabel).toBe('Needs permission');

      // If the timer were stale, after another 30s the tile would decay to
      // waiting. With F3's timer restart, we still have 60s from now.
      vi.advanceTimersByTime(30_000);
      expect(tile().status).toBe('ready');

      // After a further 30s (60s since the Notification), it decays.
      vi.advanceTimersByTime(31_000);
      expect(tile().status).toBe('waiting');
    } finally {
      vi.useRealTimers();
    }
  });
});
