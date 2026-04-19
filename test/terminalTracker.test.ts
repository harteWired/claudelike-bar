import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetMock } from './__mocks__/vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ConfigManager reads from disk on construction — write a minimal config first.
// Use os.tmpdir() for cross-platform compatibility (not hardcoded /tmp).
const TEST_ROOT = path.join(os.tmpdir(), 'test-workspace');
const CONFIG_PATH = path.join(TEST_ROOT, '.claudelike-bar.jsonc');

function writeConfig(config: Record<string, any> = { terminals: {} }) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

function cleanConfig() {
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  try { fs.unlinkSync(path.join(TEST_ROOT, '.claudelike-bar.json')); } catch {}
}

// Import after mock is in place (vitest alias handles this)
import { ConfigManager } from '../src/configManager';
import { TerminalTracker } from '../src/terminalTracker';

function addMockTerminal(name: string) {
  const t = { name, sendText: vi.fn(), dispose: vi.fn() };
  (vscode.window.terminals as any[]).push(t);
  return t;
}

describe('TerminalTracker state machine', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
    writeConfig({ terminals: {} });
    // Add a terminal before constructing tracker (it scans window.terminals)
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);
  });

  afterEach(() => {
    tracker.dispose();
    config.dispose();
    cleanConfig();
  });

  function getTile() {
    const tiles = tracker.getTiles();
    return tiles.find(t => t.name === 'my-project');
  }

  it('starts in idle state', () => {
    expect(getTile()?.status).toBe('idle');
  });

  // --- UserPromptSubmit: universal reset ---

  it('UserPromptSubmit transitions idle → working', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(getTile()?.status).toBe('working');
  });

  it('UserPromptSubmit transitions done → working', () => {
    tracker.markDone(getTile()!.id);
    expect(getTile()?.status).toBe('done');
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(getTile()?.status).toBe('working');
  });

  it('UserPromptSubmit transitions ignored → working', () => {
    // Force into ignored state
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    // Manually set to ignored for testing (normally done via focus tracking)
    const tile = getTile()!;
    (tile as any).status = 'ignored';
    (tile as any).ignoredText = 'Patiently judging you';
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.ignoredText).toBeUndefined();
  });

  // --- PreToolUse: working transition ---

  it('PreToolUse transitions idle → working', () => {
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.status).toBe('working');
  });

  it('PreToolUse transitions ignored → working (not sticky)', () => {
    const tile = getTile()!;
    (tile as any).status = 'ignored';
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.status).toBe('working');
  });

  it('PreToolUse does NOT transition done → working (done is sticky)', () => {
    tracker.markDone(getTile()!.id);
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.status).toBe('done');
  });

  // --- Stop/Notification: ready transition ---

  it('Stop transitions working → ready', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('ready');
  });

  it('Notification transitions working → ready', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification');
    expect(getTile()?.status).toBe('ready');
  });

  it('Stop transitions ignored → ready (not sticky)', () => {
    const tile = getTile()!;
    (tile as any).status = 'ignored';
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('ready');
  });

  it('Stop does NOT transition done → ready (done is sticky)', () => {
    tracker.markDone(getTile()!.id);
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('done');
  });

  it('Stop on already-ready tile is a no-op', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    const activity1 = getTile()!.lastActivity;
    tracker.updateStatus('my-project', 'ready', 'Stop');
    // lastActivity should not change on no-op
    expect(getTile()?.status).toBe('ready');
  });

  // --- markDone ---

  it('markDone sets status to done', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.markDone(getTile()!.id);
    expect(getTile()?.status).toBe('done');
  });

  // --- context updates ---

  it('updateStatus carries context percent', () => {
    tracker.updateStatus('my-project', 'working', 'PreToolUse', 42);
    expect(getTile()?.contextPercent).toBe(42);
  });

  it('updateContext sets context percent independently', () => {
    tracker.updateContext('my-project', 75);
    expect(getTile()?.contextPercent).toBe(75);
  });

  // --- unmatched project ---

  it('ignores status updates for unknown projects', () => {
    tracker.updateStatus('nonexistent', 'working', 'PreToolUse');
    // Should not throw, and existing tile should be unchanged
    expect(getTile()?.status).toBe('idle');
  });
});

describe('TerminalTracker name matching (3-tier)', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  afterEach(() => {
    tracker?.dispose();
    config?.dispose();
    cleanConfig();
  });

  it('matches via exact terminal name (Tier 1)', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    addMockTerminal('backend');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    tracker.updateStatus('backend', 'working', 'PreToolUse');
    const tile = tracker.getTiles().find(t => t.name === 'backend');
    expect(tile?.status).toBe('working');
  });

  it('matches via explicit projectName alias (Tier 2)', () => {
    __resetMock();
    writeConfig({
      terminals: {
        'VS Code Enhancement': {
          color: 'yellow',
          icon: null,
          nickname: null,
          autoStart: false,
          projectName: 'vscode-enhancement',
        },
      },
    });
    addMockTerminal('VS Code Enhancement');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    tracker.updateStatus('vscode-enhancement', 'working', 'PreToolUse');
    const tile = tracker.getTiles().find(t => t.name === 'VS Code Enhancement');
    expect(tile?.status).toBe('working');
  });

  it('matches via normalized fallback (Tier 3)', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    addMockTerminal('VS Code Enhancement');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    tracker.updateStatus('vscode-enhancement', 'working', 'PreToolUse');
    const tile = tracker.getTiles().find(t => t.name === 'VS Code Enhancement');
    expect(tile?.status).toBe('working');
  });

  it('prefers exact match over normalized match when both possible', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    // Two terminals: one exact match, one that would normalize-match
    addMockTerminal('myapi');
    addMockTerminal('my-api');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    // Incoming project "my-api" — should match the tile literally named "my-api"
    // (Tier 1, score 3) not "myapi" (Tier 3, score 1)
    tracker.updateStatus('my-api', 'working', 'PreToolUse');
    const exactTile = tracker.getTiles().find(t => t.name === 'my-api');
    const normalizedTile = tracker.getTiles().find(t => t.name === 'myapi');
    expect(exactTile?.status).toBe('working');
    expect(normalizedTile?.status).toBe('idle');
  });

  it('skips normalized match when projectName is explicitly set but does not match', () => {
    __resetMock();
    writeConfig({
      terminals: {
        'my-project': {
          color: 'cyan',
          icon: null,
          nickname: null,
          autoStart: false,
          projectName: 'explicitly-different',
        },
      },
    });
    addMockTerminal('my-project');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    // Status for "myproject" would normally Tier-3 match "my-project",
    // but projectName is set to something else — user has opted out of fuzzy matching
    tracker.updateStatus('myproject', 'working', 'PreToolUse');
    const tile = tracker.getTiles().find(t => t.name === 'my-project');
    expect(tile?.status).toBe('idle');
  });

  it('updateContext uses the same matching logic', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    addMockTerminal('VS Code Enhancement');
    config = new ConfigManager(CONFIG_PATH);
    tracker = new TerminalTracker(config);

    tracker.updateContext('vscode-enhancement', 55);
    const tile = tracker.getTiles().find(t => t.name === 'VS Code Enhancement');
    expect(tile?.contextPercent).toBe(55);
  });
});

// -----------------------------------------------------------------
// v0.9 state machine — subagent tracking, teammate_idle, error
// -----------------------------------------------------------------

describe('TerminalTracker v0.9 — multi-agent state', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
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

  function getTile() {
    return tracker.getTiles().find(t => t.name === 'my-project');
  }

  it('subagent_start increments counter and labels working with count', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    const tile = getTile()!;
    expect(tile.status).toBe('working');
    expect(tile.pendingSubagents).toBe(1);
    expect(tile.statusLabel).toContain('1 agent');
  });

  it('multiple subagent_starts show aggregate count', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    const tile = getTile()!;
    expect(tile.pendingSubagents).toBe(3);
    expect(tile.statusLabel).toContain('3 agents');
  });

  it('subagent_stop decrements counter, floors at 0', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    expect(getTile()?.pendingSubagents).toBe(1);
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    expect(getTile()?.pendingSubagents).toBe(0);
    // Floor at 0 even on stray stops
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    expect(getTile()?.pendingSubagents).toBe(0);
  });

  // --- v0.14.1 (#16): Stop as authoritative end-of-turn + Notification suppress ---

  it('Stop zeros the subagent counter and transitions to ready', () => {
    // v0.14.1 (#16): Task tool is synchronous — parent Stop means subagents
    // already finished. Any non-zero counter at Stop is drift from dropped
    // SubagentStop events on the shared status file. Trust the Stop signal.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('ready');
    expect(getTile()?.pendingSubagents).toBe(0);
  });

  it('Stop clears stale drift that accumulated across turns', () => {
    // Regression guard for #16: simulate 12 SubagentStart events with only
    // 4 SubagentStop events arriving (8 lost to file-coalescing). Without
    // the fix the counter wedges the tile on "Working (N agents)" until
    // UserPromptSubmit. With the fix, next parent Stop unwedges.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    for (let i = 0; i < 12; i++) {
      tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    }
    for (let i = 0; i < 4; i++) {
      tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    }
    expect(getTile()?.pendingSubagents).toBe(8); // drift: 8 lost SubagentStops
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('ready');
    expect(getTile()?.pendingSubagents).toBe(0);
  });

  it('Stop zeros subagentPermissionPending alongside the counter', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    // Mid-job permission prompt during subagent work — raises the flag.
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(getTile()?.subagentPermissionPending).toBe(true);
    // Parent Stop must clear both the counter and the (now-stale) flag so
    // the group's wrap-up doesn't get mislabeled on the next cycle.
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.pendingSubagents).toBe(0);
    expect(getTile()?.subagentPermissionPending).toBe(false);
  });

  it('Stop stays working when teammateIdle is true (counter zeroed, teammate authoritative)', () => {
    // teammate_idle is an Agent Teams signal, not derived from a lossy
    // event stream — trust it. Zero the counter on Stop but keep the
    // working state because the teammate is still waiting for a peer.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.pendingSubagents).toBe(0);
    expect(getTile()?.teammateIdle).toBe(true);
  });

  it('Notification does NOT zero the subagent counter (mid-turn signal, different semantics)', () => {
    // Only Stop is the authoritative end-of-turn signal. A Notification
    // arriving while subagents run legitimately surfaces a mid-job prompt;
    // zeroing would clobber the in-flight counter and break the permission
    // label routing on the next cycle.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, {
      notification_type: 'permission_prompt',
    });
    expect(getTile()?.pendingSubagents).toBe(2);
  });

  it('Subagent lifecycle after Stop-reset works normally (re-entry)', () => {
    // After Stop zeros the counter, if another turn fires subagents, the
    // counter starts fresh from 0 and the usual increment/decrement flow
    // applies — no lingering floor effects from the reset.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.pendingSubagents).toBe(0);
    // New turn starts.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    expect(getTile()?.pendingSubagents).toBe(2);
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    expect(getTile()?.pendingSubagents).toBe(0);
  });

  it('SubagentStop with counter=0 and teammate idle leaves status working (teammate suppress)', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    tracker.updateStatus('my-project', 'subagent_stop', 'SubagentStop');
    // Counter at 0 but teammate still idle — stay working.
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.teammateIdle).toBe(true);
  });

  // --- teammate_idle (Agent Teams) ---

  it('teammate_idle keeps tile in working with dedicated label', () => {
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    const tile = getTile()!;
    expect(tile.status).toBe('working');
    expect(tile.teammateIdle).toBe(true);
    expect(tile.statusLabel).toBe('Waiting for teammate');
  });

  it('Stop/ready SUPPRESSED when teammateIdle is true', () => {
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.teammateIdle).toBe(true);
  });

  it('PreToolUse (working) clears teammateIdle — agent is back to work', () => {
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    expect(getTile()?.teammateIdle).toBe(true);
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.teammateIdle).toBe(false);
    expect(getTile()?.status).toBe('working');
  });

  // --- error state (StopFailure) ---

  it('StopFailure transitions to error with readable label', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    const tile = getTile()!;
    expect(tile.status).toBe('error');
    expect(tile.errorType).toBe('rate_limit');
    expect(tile.statusLabel).toContain('rate limit');
  });

  it('error survives Stop/Notification (sticky until recovery signal)', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('error'); // still error
  });

  it('error is cleared by PreToolUse (auto-retry recovery)', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.errorType).toBeUndefined();
  });

  it('error is cleared by UserPromptSubmit', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    expect(getTile()?.status).toBe('working');
    expect(getTile()?.errorType).toBeUndefined();
  });

  it('error is NOT cleared by user-park (done)', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.markDone(getTile()!.id);
    // Done wins — but also cleans v0.9 flags
    expect(getTile()?.status).toBe('done');
    expect(getTile()?.errorType).toBeUndefined();
  });

  // --- Notification matchers ---

  it('Notification with permission_prompt shows "Needs permission"', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, { notification_type: 'permission_prompt' });
    expect(getTile()?.statusLabel).toBe('Needs permission');
  });

  it('Notification with idle_prompt shows "Awaiting input"', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Notification', undefined, { notification_type: 'idle_prompt' });
    expect(getTile()?.statusLabel).toBe('Awaiting input');
  });

  // --- UserPromptSubmit reset ---

  it('UserPromptSubmit clears all v0.9 state', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    const tile = getTile()!;
    expect(tile.pendingSubagents).toBe(0);
    expect(tile.teammateIdle).toBe(false);
    expect(tile.errorType).toBeUndefined();
    expect(tile.status).toBe('working');
  });

  // --- markDone clears v0.9 flags ---

  it('markDone clears all v0.9 transient state', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.markDone(getTile()!.id);
    const tile = getTile()!;
    expect(tile.pendingSubagents).toBe(0);
    expect(tile.teammateIdle).toBe(false);
    expect(tile.errorType).toBeUndefined();
    expect(tile.status).toBe('done');
  });

  // --- sort order ---

  it('error status sorts above all others (top priority)', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    addMockTerminal('working-proj');
    addMockTerminal('error-proj');
    addMockTerminal('ready-proj');
    const c = new ConfigManager(CONFIG_PATH);
    const t = new TerminalTracker(c);
    try {
      t.updateStatus('working-proj', 'working', 'UserPromptSubmit');
      t.updateStatus('error-proj', 'error', 'StopFailure');
      t.updateStatus('ready-proj', 'working', 'UserPromptSubmit');
      t.updateStatus('ready-proj', 'ready', 'Stop');
      const tiles = t.getTiles();
      // Error should be first
      expect(tiles[0].name).toBe('error-proj');
    } finally {
      t.dispose();
      c.dispose();
    }
  });
});

// -----------------------------------------------------------------
// v0.9.1 state machine — offline, tool_failure, compacting
// -----------------------------------------------------------------

describe('TerminalTracker v0.9.1 — session / tool-failure / compaction', () => {
  let tracker: TerminalTracker;
  let config: ConfigManager;

  beforeEach(() => {
    __resetMock();
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

  function getTile() {
    return tracker.getTiles().find(t => t.name === 'my-project');
  }

  // --- SessionEnd → offline ---

  it('session_end with logout reason transitions tile to offline', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    expect(getTile()?.status).toBe('offline');
  });

  it('session_end with prompt_input_exit reason transitions tile to offline', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'prompt_input_exit' });
    expect(getTile()?.status).toBe('offline');
  });

  it('session_end clears all v0.9/v0.9.1 transient flags', () => {
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    const tile = getTile()!;
    expect(tile.status).toBe('offline');
    expect(tile.pendingSubagents).toBe(0);
    expect(tile.teammateIdle).toBe(false);
    expect(tile.errorType).toBeUndefined();
    expect(tile.toolError).toBe(false);
    expect(tile.compacting).toBe(false);
  });

  it('session_end respects done stickiness', () => {
    tracker.markDone(getTile()!.id);
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    expect(getTile()?.status).toBe('done'); // still done, not overridden
  });

  // --- SessionStart → restore from offline ---

  it('session_start restores offline tile to idle', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    expect(getTile()?.status).toBe('offline');
    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, { source: 'startup' });
    expect(getTile()?.status).toBe('idle');
  });

  it('session_start is a no-op when tile is not offline', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'session_start', 'SessionStart', undefined, { source: 'resume' });
    expect(getTile()?.status).toBe('working'); // unchanged
  });

  // --- sort order ---

  it('offline sorts below idle (not urgent)', () => {
    __resetMock();
    writeConfig({ terminals: {} });
    addMockTerminal('idle-proj');
    addMockTerminal('offline-proj');
    const c = new ConfigManager(CONFIG_PATH);
    const t = new TerminalTracker(c);
    try {
      t.updateStatus('offline-proj', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
      // idle-proj stays idle
      const tiles = t.getTiles();
      const idlePos = tiles.findIndex(x => x.name === 'idle-proj');
      const offlinePos = tiles.findIndex(x => x.name === 'offline-proj');
      expect(idlePos).toBeLessThan(offlinePos);
    } finally {
      t.dispose();
      c.dispose();
    }
  });

  // --- PostToolUseFailure → tool_error flag ---

  it('tool_failure sets toolError flag and updates label', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure', undefined, { tool_name: 'Bash' });
    const tile = getTile()!;
    expect(tile.toolError).toBe(true);
    expect(tile.statusLabel).toContain('tool error');
  });

  it('tool_failure respects done stickiness', () => {
    tracker.markDone(getTile()!.id);
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(getTile()?.toolError).toBe(false); // guard blocked the flag
    expect(getTile()?.status).toBe('done');
  });

  it('tool_failure respects error stickiness', () => {
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(getTile()?.toolError).toBe(false);
    expect(getTile()?.status).toBe('error');
  });

  it('next PreToolUse clears toolError flag', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(getTile()?.toolError).toBe(true);
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.toolError).toBe(false);
  });

  it('Stop clears toolError flag at end of turn', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.toolError).toBe(false);
    expect(getTile()?.status).toBe('ready');
  });

  // --- PreCompact / PostCompact ---

  it('compact_start overrides label with "Compacting..."', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact', undefined, { compaction_trigger: 'auto' });
    const tile = getTile()!;
    expect(tile.compacting).toBe(true);
    expect(tile.statusLabel).toContain('Compacting');
  });

  it('compact_end clears compacting flag and restores working label', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    tracker.updateStatus('my-project', 'compact_end', 'PostCompact');
    const tile = getTile()!;
    expect(tile.compacting).toBe(false);
    expect(tile.statusLabel).not.toContain('Compacting');
  });

  it('compact_end clears flag even when status has moved away from working', () => {
    // Worst-case ordering: compact_start → Stop (before compact_end) →
    // compact_end arrives too late. Flag should still clear.
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    // Stop should also have cleared compacting as end-of-turn
    expect(getTile()?.compacting).toBe(false);
    // Now late compact_end arrives — no-op since already cleared
    tracker.updateStatus('my-project', 'compact_end', 'PostCompact');
    expect(getTile()?.compacting).toBe(false);
  });

  it('PreToolUse clears stale compacting flag', () => {
    // compact_start fires but compact_end never does; next PreToolUse
    // should clear the stale flag (real activity means compaction is done).
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    expect(getTile()?.compacting).toBe(true);
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.compacting).toBe(false);
  });

  it('UserPromptSubmit clears all v0.9.1 flags', () => {
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    const tile = getTile()!;
    expect(tile.toolError).toBe(false);
    expect(tile.compacting).toBe(false);
  });

  it('markDone clears all v0.9.1 flags', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    tracker.markDone(getTile()!.id);
    const tile = getTile()!;
    expect(tile.toolError).toBe(false);
    expect(tile.compacting).toBe(false);
    expect(tile.status).toBe('done');
  });

  // --- offline stickiness (hook events arriving after SessionEnd) ---

  it('subagent_start does NOT resurrect an offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    expect(getTile()?.status).toBe('offline');
    tracker.updateStatus('my-project', 'subagent_start', 'SubagentStart');
    expect(getTile()?.status).toBe('offline'); // stays offline
  });

  it('teammate_idle does NOT resurrect an offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'teammate_idle', 'TeammateIdle');
    expect(getTile()?.status).toBe('offline');
  });

  it('StopFailure does NOT override an offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'error', 'StopFailure', undefined, { error_type: 'rate_limit' });
    expect(getTile()?.status).toBe('offline');
  });

  it('Stop does NOT override an offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'ready', 'Stop');
    expect(getTile()?.status).toBe('offline');
  });

  it('PreToolUse does NOT resurrect an offline tile — only SessionStart does', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'working', 'PreToolUse');
    expect(getTile()?.status).toBe('offline');
  });

  it('tool_failure does not set flag on offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(getTile()?.toolError).toBe(false);
  });

  it('compact_start does not set flag on offline tile', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    expect(getTile()?.compacting).toBe(false);
  });

  it('UserPromptSubmit is the escape hatch from offline', () => {
    tracker.updateStatus('my-project', 'session_end', 'SessionEnd', undefined, { reason: 'logout' });
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    // UserPromptSubmit is universal reset — brings offline back to working
    expect(getTile()?.status).toBe('working');
  });

  // --- tool_failure and compact_start only activate in valid states ---

  it('tool_failure does not set flag on ready tile (no visible effect possible)', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    tracker.updateStatus('my-project', 'tool_failure', 'PostToolUseFailure');
    expect(getTile()?.toolError).toBe(false); // status isn't working, no set
  });

  it('compact_start does not set flag on ready tile', () => {
    tracker.updateStatus('my-project', 'working', 'UserPromptSubmit');
    tracker.updateStatus('my-project', 'ready', 'Stop');
    tracker.updateStatus('my-project', 'compact_start', 'PreCompact');
    expect(getTile()?.compacting).toBe(false);
  });
});
