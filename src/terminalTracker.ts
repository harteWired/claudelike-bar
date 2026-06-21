import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TileData, SessionStatus, HookStatusSignal, ICON_MAP, getThemeColor, StateTransition } from './types';
import { ConfigManager } from './configManager';
import { getStatusDir } from './statusDir';

// v0.15.0 (#20) — how recently a status JSON must have been written for the
// tracker to treat its slug as "live" when deciding whether to suppress a
// registered-tile synthesis. 60s matches the state-machine's ready→waiting
// timer; shorter threshold risks false suppression during a quiet Stop→idle
// lull, longer risks showing a false-live tile for a slug whose hook is
// stale from a crashed session.
const STATUS_FRESH_MS = 60_000;

// v0.17.1 (#30) — inactivity window for the subagent-counter watchdog.
// 60s mirrors STATUS_FRESH_MS / the ready→waiting timer: long enough that
// a slow subagent group still re-arms before firing, short enough that a
// genuinely-stale counter clears within the next attention window.
const SUBAGENT_WATCHDOG_MS = 60_000;

// v0.19 (#36) — burst window for the "freshly ready" pulse. Long enough to
// notice across a peripheral glance, short enough to fade before it becomes
// background noise. Mirrors the audio chime as the canonical "this just
// finished" cue.
const FRESHLY_READY_MS = 3_000;

// Status values that mean "Claude is not actively running" — suppression of
// the registered tile doesn't apply to these. `idle` is included because a
// fresh idle file just means the hook fired on session start/end; the slug
// isn't "live" in the sense of having active Claude work.
const NON_LIVE_STATUSES = new Set(['offline', 'idle']);

// v0.15.0 (#17) — VS Code's "Clone terminal" action names new terminals
// `<parent> (copy)`. Repeated clones append further `(copy)` suffixes. These
// are transient by intent — the user isn't registering a project, they're
// forking a shell. Matching this pattern lets us skip the auto-ensureEntry
// call so clones don't pollute `claudelike-bar.jsonc` with throwaway entries
// that survive the session as permanent registered tiles.
const CLONE_SUFFIX_RE = / \(copy\)(?: \(copy\))*$/;

export class TerminalTracker implements vscode.Disposable {
  private terminals = new Map<number, TileData>();
  private terminalRefs = new Map<number, vscode.Terminal>();
  private terminalIdMap = new WeakMap<vscode.Terminal, number>();
  private nextId = 0;
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  // v0.12 — fires on every status transition (old → new). Consumers filter
  // on to/from. Separate from `onChange` which debounces for the webview
  // and doesn't carry transition detail.
  private onStateChangeEmitter = new vscode.EventEmitter<StateTransition>();
  readonly onStateChange = this.onStateChangeEmitter.event;

  // v0.19 (#48) — fires when a pinned tile's terminal closes and the pin
  // is auto-cleared. Consumed by the UI layer (extension.ts) to show the
  // first-auto-unpin toast; this keeps user-facing notification concerns
  // out of the state machine.
  private onPinClearedEmitter = new vscode.EventEmitter<{
    name: string;
    displayName: string;
  }>();
  readonly onPinCleared = this.onPinClearedEmitter.event;
  private nameRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private nameRefreshIdleCycles = 0;
  private configManager: ConfigManager;
  private log: (msg: string | (() => string)) => void;
  // v0.15.0 (#20) — status dir path, overridable for tests.
  private statusDir: string;

  // State machine timers: ready → waiting after 60s
  private readyTimers = new Map<number, NodeJS.Timeout>();

  // v0.17.1 (#30) — per-tile inactivity watchdog for the subagent counter.
  // Re-armed on every SubagentStart/SubagentStop; if no further start/stop
  // arrives for SUBAGENT_WATCHDOG_MS, drift is by definition stale and we
  // zero the counter. Catches the in-turn fan-out case the v0.14.1 Stop-
  // reset doesn't cover (long agentic turns that never yield a parent Stop).
  private subagentWatchdogTimers = new Map<number, NodeJS.Timeout>();

  // v0.19 (#36) — per-tile timer that clears the `freshlyReady` flag after
  // FRESHLY_READY_MS. Cancelled if the tile transitions out of ready before
  // the timer fires (avoids a spurious "fresh" pulse on a tile that already
  // moved on).
  private freshlyReadyTimers = new Map<number, NodeJS.Timeout>();

  // Focus tracking: which tile was focused while in "waiting" state
  private focusedWaitingTile: number | null = null;

  // v0.13.4 (#15) — stable negative ids for synthesized "registered" tiles.
  // Lazy assignment per slug; survives across getTiles() calls so the
  // webview's diff-update doesn't churn DOM elements between renders.
  private syntheticIds = new Map<string, number>();
  private nextSyntheticId = -1;

  constructor(
    configManager: ConfigManager,
    log?: (msg: string | (() => string)) => void,
    statusDirOverride?: string,
  ) {
    this.configManager = configManager;
    this.log = log ?? (() => {});
    this.statusDir = statusDirOverride ?? getStatusDir();
    // Track existing terminals
    for (const terminal of vscode.window.terminals) {
      this.addTerminal(terminal);
    }

    this.disposables.push(
      vscode.window.onDidOpenTerminal((t) => {
        this.addTerminal(t);
        this.startNameRefresh(); // restart polling on new terminal
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidCloseTerminal((t) => this.handleTerminalClosed(t)),
      vscode.window.onDidChangeActiveTerminal((active) => {
        this.handleActiveTerminalChange(active);
        this.onChangeEmitter.fire();
      }),
      this.onChangeEmitter,
      this.onStateChangeEmitter,
      this.onPinClearedEmitter,
    );

    // Periodically refresh terminal names — catches late profile name assignment
    this.startNameRefresh();
  }

  private addTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    if (name === 'bash' || name === 'zsh' || name === 'sh') return;

    // v0.19 (#45) — idempotent. attachLaunchedTerminal() pre-attaches the
    // terminal so the tile exists before VS Code's onDidOpenTerminal event
    // fires. When the event then arrives, the second addTerminal call here
    // would otherwise overwrite the tile's state machine with a fresh
    // 'idle' entry. Bail early if the terminal is already tracked.
    const existingId = this.terminalIdMap.get(terminal);
    if (existingId !== undefined && this.terminals.has(existingId)) {
      return;
    }

    // v0.15.0 (#17) — VS Code "Clone terminal" produces `<parent> (copy)`
    // names. Don't write these to config: they're transient, and persisting
    // them leaves dead entries that render as registered tiles after the
    // clone is closed. The in-memory tile still tracks normally.
    if (!CLONE_SUFFIX_RE.test(name)) {
      this.configManager.ensureEntry(name);
    }
    const cfg = this.configManager.getTerminal(name);
    const thresholds = this.configManager.getContextThresholds();

    // v0.16.0 (#25) — `type: "shell"` means a plain non-Claude terminal.
    // The tile sits in the bar without a state machine: status is fixed
    // at `shell` and never transitions, so the user gets a gray pill
    // they can click to focus the terminal alongside their Claude tiles.
    const isShell = cfg?.type === 'shell';
    const initialStatus: SessionStatus = isShell ? 'shell' : 'idle';

    const id = this.assignId(terminal);
    this.terminalRefs.set(id, terminal);
    this.terminals.set(id, {
      id,
      name,
      displayName: cfg?.nickname || name,
      status: initialStatus,
      statusLabel: this.configManager.getLabel(initialStatus),
      lastActivity: Date.now(),
      isActive: vscode.window.activeTerminal === terminal,
      themeColor: getThemeColor(name, cfg?.color),
      icon: cfg?.icon ?? ICON_MAP[name] ?? null,
      contextWarn: thresholds.warn,
      contextCrit: thresholds.crit,
      pendingSubagents: 0,
      teammateIdle: false,
      toolError: false,
      compacting: false,
      subagentPermissionPending: false,
      pinned: cfg?.pinned === true,
      type: isShell ? 'shell' : 'claude',
    });
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const id = this.terminalIdMap.get(terminal);
    if (id !== undefined) {
      this.terminals.delete(id);
      this.terminalRefs.delete(id);
      this.clearReadyTimer(id);
      this.clearSubagentWatchdog(id);
      if (this.focusedWaitingTile === id) {
        this.focusedWaitingTile = null;
      }
    }
  }

  private handleActiveTerminalChange(active: vscode.Terminal | undefined): void {
    const activeId = active ? this.terminalIdMap.get(active) : undefined;

    // Check if we're leaving a tile that was focused while waiting.
    // v0.9.3: `ready` is NOT eligible for this transition — it's too early
    // in the "needs attention" window to punish a glance-and-leave. The
    // common "approve permission → switch back to editor" pattern was
    // wrongly marking tiles ignored/done while Claude was actively running
    // the approved tool. After 60s the tile becomes `waiting`, at which
    // point glance-and-leave does get punished (mode-dependent).
    if (this.focusedWaitingTile !== null && this.focusedWaitingTile !== activeId) {
      const tile = this.terminals.get(this.focusedWaitingTile);
      if (tile && tile.status === 'waiting') {
        // User looked and left without acting — mode-dependent transition.
        // Also clear v0.9 transient flags — the tile is being explicitly
        // parked, so stale subagent counts or teammate-idle flags shouldn't
        // resurface if an auto-retry or stray signal arrives.
        const mode = this.configManager.getMode();
        if (mode === 'passive-aggressive') {
          const texts = this.configManager.getIgnoredTexts();
          tile.status = 'ignored';
          tile.ignoredText = texts[Math.floor(Math.random() * texts.length)];
          tile.statusLabel = tile.ignoredText;
        } else {
          tile.status = 'done';
          tile.statusLabel = this.configManager.getLabel('done');
          tile.ignoredText = undefined;
        }
        tile.pendingSubagents = 0;
        tile.teammateIdle = false;
        tile.errorType = undefined;
        tile.toolError = false;
        tile.compacting = false;
        tile.subagentPermissionPending = false;
        this.clearReadyTimer(tile.id);
        this.clearSubagentWatchdog(tile.id);
      }
      this.focusedWaitingTile = null;
    }

    for (const [id, tile] of this.terminals) {
      tile.isActive = id === activeId;

      // If focusing a tile that's waiting or ready, start tracking it —
      // the focus-loss transition (above) still only fires when status is
      // `waiting` by the time the user leaves, but we want to start the
      // tracking window as soon as they look at a ready tile so the later
      // waiting transition can act on it.
      if (id === activeId && (tile.status === 'waiting' || tile.status === 'ready')) {
        this.focusedWaitingTile = id;
      }
    }
  }

  private assignId(terminal: vscode.Terminal): number {
    let id = this.terminalIdMap.get(terminal);
    if (id === undefined) {
      id = this.nextId++;
      this.terminalIdMap.set(terminal, id);
    }
    return id;
  }

  private startNameRefresh(): void {
    this.nameRefreshIdleCycles = 0;
    if (this.nameRefreshTimer) return; // already running
    this.nameRefreshTimer = setInterval(() => this.refreshNames(), 2000);
  }

  private stopNameRefresh(): void {
    if (this.nameRefreshTimer) {
      clearInterval(this.nameRefreshTimer);
      this.nameRefreshTimer = undefined;
    }
  }

  /**
   * Re-check terminal names — picks up profile names assigned after onDidOpenTerminal,
   * and adds terminals that were initially filtered as "zsh" but since got renamed.
   * Stops itself after 3 consecutive no-change cycles to avoid wasted work.
   */
  private refreshNames(): void {
    let changed = false;

    for (const terminal of vscode.window.terminals) {
      const name = terminal.name;
      const id = this.terminalIdMap.get(terminal);

      if (id !== undefined) {
        // Already tracked — update name if it changed
        const tile = this.terminals.get(id);
        if (tile && tile.name !== name) {
          if (name === 'bash' || name === 'zsh' || name === 'sh') {
            // Name regressed to shell — remove it
            this.terminals.delete(id);
            this.terminalRefs.delete(id);
          } else {
            // v0.15.0 (#17) — don't persist clone-suffixed names to config.
            if (!CLONE_SUFFIX_RE.test(name)) {
              this.configManager.ensureEntry(name);
            }
            const cfg = this.configManager.getTerminal(name);
            tile.name = name;
            tile.displayName = cfg?.nickname || name;
            tile.themeColor = getThemeColor(name, cfg?.color);
            tile.icon = cfg?.icon ?? ICON_MAP[name] ?? null;
          }
          changed = true;
        }
      } else if (name !== 'bash' && name !== 'zsh' && name !== 'sh') {
        // Not tracked yet — was likely "zsh" at open time, now has a real name
        this.addTerminal(terminal);
        changed = true;
      }
    }

    if (changed) {
      this.nameRefreshIdleCycles = 0;
      this.onChangeEmitter.fire();
    } else {
      this.nameRefreshIdleCycles++;
      if (this.nameRefreshIdleCycles >= 3) {
        this.stopNameRefresh();
      }
    }
  }

  /** Re-apply config (colors, nicknames, icons, thresholds, pinned, type) to all tracked tiles. */
  refreshFromConfig(): void {
    const thresholds = this.configManager.getContextThresholds();
    for (const [, tile] of this.terminals) {
      const cfg = this.configManager.getTerminal(tile.name);
      tile.displayName = cfg?.nickname || tile.name;
      tile.themeColor = getThemeColor(tile.name, cfg?.color);
      tile.icon = cfg?.icon ?? ICON_MAP[tile.name] ?? null;
      tile.contextWarn = thresholds.warn;
      tile.contextCrit = thresholds.crit;
      tile.pinned = cfg?.pinned === true;
      // v0.16.0 (#25) — type can be flipped live via config edit. When a
      // tile becomes a shell, snap status to 'shell' and clear the
      // claude-side transient flags (counter, error type, etc) so any
      // stale state from a prior claude life doesn't bleed through. The
      // reverse direction (shell → claude) resets to idle and lets the
      // state machine take over from there.
      const wasShell = tile.type === 'shell';
      const isShell = cfg?.type === 'shell';
      tile.type = isShell ? 'shell' : 'claude';
      if (isShell && !wasShell) {
        tile.status = 'shell';
        tile.pendingSubagents = 0;
        tile.teammateIdle = false;
        tile.errorType = undefined;
        tile.toolError = false;
        tile.compacting = false;
        tile.subagentPermissionPending = false;
        tile.ignoredText = undefined;
        this.clearReadyTimer(tile.id);
        this.clearSubagentWatchdog(tile.id);
      } else if (!isShell && wasShell) {
        tile.status = 'idle';
      }
      // Refresh status label — recompose v0.9 / v0.9.1 / v0.9.3 rich labels
      // from current flags. Skip `ignored` (uses custom passive-aggressive text).
      if (tile.status === 'ignored') {
        // keep tile.statusLabel as-is (random ignored text)
      } else if (tile.status === 'error') {
        tile.statusLabel = this.errorLabel(tile.errorType);
      } else if (tile.status === 'working') {
        tile.statusLabel = this.workingLabel(tile);
      } else {
        tile.statusLabel = this.configManager.getLabel(tile.status);
      }
    }
    this.onChangeEmitter.fire();
  }

  /**
   * Score how strongly a tile matches an incoming project name. Higher is better.
   *   3 — exact match on terminal name
   *   2 — explicit `projectName` alias in config
   *   1 — normalized match (lowercase, stripped whitespace/hyphens/underscores)
   *   0 — no match
   * Tier 3 (normalized) catches common cases like "VS Code Enhancement" vs
   * "vscode-enhancement" without requiring config, but is skipped when the
   * tile has an explicit `projectName` alias — that's the user's signal that
   * they've handled disambiguation themselves.
   */
  private matchScore(tile: TileData, projectName: string): number {
    if (tile.name === projectName) return 3;
    const cfg = this.configManager.getTerminal(tile.name);
    if (cfg?.projectName && cfg.projectName === projectName) return 2;
    // projectName is the user's "I've handled disambiguation" signal —
    // opt out of ALL fuzzy matching (path-based AND normalized).
    if (cfg?.projectName) return 0;
    // v0.10 — path-based matching. If the incoming projectName looks like a
    // basename that could have come from a directory matching this tile's
    // registered `path`, score it between alias and normalized. This catches
    // manually-opened terminals whose hook falls back to basename(cwd) when
    // the tile's path ends with that basename.
    if (cfg?.path && typeof cfg.path === 'string') {
      const pathBasename = cfg.path.split(/[/\\]/).filter(Boolean).pop() ?? '';
      if (pathBasename && this.normalizeForMatch(pathBasename) === this.normalizeForMatch(projectName)) {
        return 1.5;
      }
    }
    if (this.normalizeForMatch(tile.name) === this.normalizeForMatch(projectName)) return 1;
    return 0;
  }

  /**
   * Find the single best-matching tile for a given project name, preferring
   * exact matches over alias matches over normalized matches. Returns undefined
   * if no tile matches at any tier.
   */
  private findMatchingTile(projectName: string): TileData | undefined {
    let best: TileData | undefined;
    let bestScore = 0;
    let tied = false;
    for (const [, tile] of this.terminals) {
      const score = this.matchScore(tile, projectName);
      if (score > bestScore) {
        best = tile;
        bestScore = score;
        tied = false;
        if (score === 3) break; // exact match — can't do better
      } else if (score === bestScore && score > 0 && tile !== best) {
        tied = true;
      }
    }
    // When multiple tiles tie at the same fuzzy score, the match is
    // ambiguous — return undefined rather than picking one arbitrarily.
    // Exact matches (score 3) can't tie by definition (names are unique).
    if (tied && bestScore < 3) {
      this.log(() => `ambiguous match for "${projectName}": multiple tiles scored ${bestScore}, skipping`);
      return undefined;
    }
    return best;
  }

  private normalizeForMatch(name: string): string {
    return name.toLowerCase().replace(/[-_\s]+/g, '');
  }

  /** Compose a working-state label that includes the subagent count if any. */
  private labelWithSubagents(key: string, count: number): string {
    const base = this.configManager.getLabel(key);
    if (count > 0) {
      return `${base} (${count} agent${count === 1 ? '' : 's'})`;
    }
    return base;
  }

  /**
   * Compose the label a `working` tile should show, respecting the cascade
   * of transient flags. Single source of truth used by both the state
   * machine and `refreshFromConfig`. Priority (highest first):
   *   subagentPermissionPending — user action required on a subagent
   *   compacting                — context compaction in progress
   *   teammateIdle              — Agent Teams peer waiting
   *   toolError                 — a recent tool call failed
   *   default                   — "Working" with optional subagent count
   */
  private workingLabel(tile: TileData): string {
    if (tile.subagentPermissionPending) {
      return this.configManager.getLabel('subagent_permission');
    }
    if (tile.compacting) return this.configManager.getLabel('compacting');
    if (tile.teammateIdle) return this.configManager.getLabel('teammate_idle');
    if (tile.toolError) return this.configManager.getLabel('tool_error');
    return this.labelWithSubagents('working', tile.pendingSubagents ?? 0);
  }

  /** Map a StopFailure error_type matcher to a human-readable error label. */
  private errorLabel(errorType: string | undefined): string {
    const base = this.configManager.getLabel('error');
    const readable: Record<string, string> = {
      rate_limit: 'rate limit',
      authentication_failed: 'auth failed',
      billing_error: 'billing error',
      invalid_request: 'invalid request',
      server_error: 'server error',
      max_output_tokens: 'output limit',
      unknown: 'unknown error',
    };
    if (errorType && readable[errorType]) {
      return `${base}: ${readable[errorType]}`;
    }
    return base;
  }

  /** Refine the ready label based on the Notification matcher type. */
  private readyLabelForNotification(notifType: string | undefined): string {
    const overrides: Record<string, string> = {
      permission_prompt: 'Needs permission',
      idle_prompt: 'Awaiting input',
      elicitation_dialog: 'MCP needs input',
    };
    if (notifType && overrides[notifType]) {
      return overrides[notifType];
    }
    return this.configManager.getLabel('ready');
  }

  updateStatus(
    projectName: string,
    status: SessionStatus | HookStatusSignal,
    event?: string,
    contextPercent?: number,
    extra?: {
      tool_name?: string;
      agent_type?: string;
      error_type?: string;
      notification_type?: string;
      source?: string;              // v0.9.1: SessionStart matcher
      reason?: string;              // v0.9.1: SessionEnd matcher
      compaction_trigger?: string;  // v0.9.1: PreCompact/PostCompact matcher
    },
  ): void {
    const tile = this.findMatchingTile(projectName);
    if (tile) {
      // v0.16.0 (#25) — shell tiles are explicitly opted out of the state
      // machine. A status JSON arriving for one (e.g. user dropped a
      // CLAUDELIKE_BAR_NAME envvar matching this slug into a shell that
      // wasn't supposed to be tracked) is ignored — the user's `type:
      // "shell"` declaration is authoritative. Logged so drift is
      // diagnosable but never silently overrides their config.
      if (tile.type === 'shell') {
        this.log(() => `shell tile ${tile.name}: ignoring status update (status=${status}, event=${event ?? '-'})`);
        return;
      }
      const prev = tile.status;
      let changed = false;

      // v0.20.2 (#43) — a genuinely fresh session (SessionStart with a
      // `startup`/`clear` source) or a session ending carries ~no meaningful
      // context. The hook's read-merge-write preserves `context_percent`
      // (owned by the statusline module) across every event, so a restart can
      // surface a *prior* session's context on a brand-new tile. Treat these
      // events as a context reset and never apply a stale incoming value.
      // Belt-and-suspenders with the hook, which also drops context_percent on
      // these events — this side also catches the startup race where the old
      // status file is read before the new session's SessionStart fires.
      const ctxResetEvent =
        (event === 'SessionStart' && (extra?.source === 'startup' || extra?.source === 'clear')) ||
        event === 'SessionEnd';

      // UserPromptSubmit is the universal reset — always goes to working,
      // clears subagent counter and teammate-idle flag.
      if (event === 'UserPromptSubmit') {
        tile.status = 'working';
        tile.pendingSubagents = 0;
        tile.teammateIdle = false;
        tile.errorType = undefined;
        tile.toolError = false;
        tile.compacting = false;
        tile.subagentPermissionPending = false;
        tile.ignoredText = undefined;
        tile.statusLabel = this.workingLabel(tile);
        this.clearReadyTimer(tile.id);
        this.clearSubagentWatchdog(tile.id);
        if (this.focusedWaitingTile === tile.id) {
          this.focusedWaitingTile = null;
        }
        changed = true;
      } else if (status === 'subagent_start') {
        // v0.9 — Task-tool subagent spawned. Increment counter, stay working.
        tile.pendingSubagents = (tile.pendingSubagents ?? 0) + 1;
        // v0.17.1 (#30) — re-arm the inactivity watchdog on every event so
        // a long fan-out keeps deferring the wipe; only true silence trips it.
        this.startSubagentWatchdog(tile.id);
        if (tile.status !== 'done' && tile.status !== 'offline') {
          tile.status = 'working';
          tile.errorType = undefined; // real activity — clear any prior error
          tile.compacting = false;    // real activity — can't be compacting too
          tile.ignoredText = undefined;
          tile.statusLabel = this.workingLabel(tile);
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'subagent_stop') {
        // v0.9 — subagent finished. Decrement counter (floor 0).
        tile.pendingSubagents = Math.max(0, (tile.pendingSubagents ?? 0) - 1);
        // v0.17.1 (#30) — counter still non-zero ⇒ keep watchdog armed;
        // counter just drained to 0 ⇒ disarm so a quiet tile doesn't sit
        // with a pending wipe queued behind it.
        if (tile.pendingSubagents > 0) {
          this.startSubagentWatchdog(tile.id);
        } else {
          this.clearSubagentWatchdog(tile.id);
        }
        // v0.9.3 — when all subagents finish, any pending subagent-permission
        // indicator is stale by definition. We don't track per-subagent
        // permissions, so clearing on count=0 is the conservative rule:
        // if another subagent is still running its prompt could still be
        // outstanding, so we keep the flag until the group is done.
        if (tile.pendingSubagents === 0 && tile.subagentPermissionPending) {
          tile.subagentPermissionPending = false;
        }
        if (tile.status === 'working') {
          // Label change is always possible (subagent count decreased and
          // may have cleared the permission flag).
          const newLabel = this.workingLabel(tile);
          if (tile.statusLabel !== newLabel) {
            tile.statusLabel = newLabel;
            changed = true;
          }
          // Event-ordering fallback: if parent's Stop was suppressed earlier
          // because a subagent was in-flight, the Stop signal is gone — it
          // won't re-fire. When the last subagent finishes and we're still
          // in working with no teammate idle, promote to ready so the tile
          // doesn't get stuck. This mirrors what a Stop event would have
          // done if fired now.
          if (tile.pendingSubagents === 0 && !tile.teammateIdle) {
            tile.status = 'ready';
            tile.statusLabel = this.configManager.getLabel('ready');
            tile.ignoredText = undefined;
            this.markFreshlyReady(tile);
            this.startReadyTimer(tile.id);
            changed = true;
          }
        }
      } else if (status === 'teammate_idle') {
        // v0.9 — Agent Teams teammate waiting for a peer. Not "ready" — the
        // user isn't expected to reply; another teammate will feed it work.
        tile.teammateIdle = true;
        if (tile.status !== 'done' && tile.status !== 'offline') {
          tile.status = 'working';
          tile.errorType = undefined; // real activity — clear any prior error
          tile.compacting = false;    // real activity — can't be compacting too
          tile.ignoredText = undefined;
          tile.statusLabel = this.workingLabel(tile);
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'error') {
        // v0.9 — StopFailure. Red, sticky except for UserPromptSubmit.
        // Only read error_type when the originating event was StopFailure —
        // the hook's read-merge-write preserves the field across subsequent
        // events that don't carry it (v0.9.3 F2).
        if (tile.status !== 'done' && tile.status !== 'offline') {
          const errorType = event === 'StopFailure' ? extra?.error_type : undefined;
          tile.status = 'error';
          tile.errorType = errorType;
          tile.statusLabel = this.errorLabel(errorType);
          tile.ignoredText = undefined;
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'ready') {
        // Stop/Notification → ready, then 60s timer → waiting.
        // v0.9: if a subagent is still running or a teammate is idle, the
        // parent turn ended but work is genuinely in-flight — stay `working`.
        // v0.9.3 (F6): when a Notification fires during active subagent work,
        //   a permission_prompt for the subagent would otherwise disappear.
        //   Reflect it as a label override on the parent tile so the user
        //   sees there's a prompt to act on, without losing the subagent
        //   counter.
        // `done` is a sticky end state (user explicitly parked via
        // Mark-as-done) — only UserPromptSubmit un-parks it.
        // `ignored` is NOT sticky — it's auto-assigned by passive-aggressive
        // mode, so real activity (Stop/Notification) should override it.
        // v0.9.3 (F2): only trust extra.notification_type when the originating
        //   event was actually a Notification — the hook's read-merge-write
        //   persists the field into Stop events that don't carry it.
        const notifType = event === 'Notification' ? extra?.notification_type : undefined;
        // v0.14.1 (#16): zero the subagent counter on parent Stop. The
        // counter is derived from a stream of SubagentStart/SubagentStop
        // events that share a single status JSON file with every other
        // hook event for this project — the FileSystemWatcher's debounce
        // coalesces rapid-fire writes, so SubagentStop events get dropped
        // when subagents fan out fast. Each lost Stop permanently inflates
        // the counter for the rest of the session, eventually wedging the
        // tile in `Working (N agents)` because hasActiveWork below
        // suppresses the ready transition.
        // Stop is the authoritative end-of-parent-turn signal — Claude
        // Code's Task tool is synchronous, so the parent doesn't fire Stop
        // until subagents have actually finished. Any non-zero count here
        // is by definition stale drift, not in-flight work. Zeroing on
        // Stop unwedges the tile and restores agreement with the on-disk
        // status. Notification is intentionally NOT reset — that fires
        // mid-turn and the existing subagentPermissionPending logic still
        // routes mid-turn permission prompts correctly.
        if (event === 'Stop') {
          tile.pendingSubagents = 0;
          tile.subagentPermissionPending = false;
          this.clearSubagentWatchdog(tile.id);
        }
        const hasActiveWork = (tile.pendingSubagents ?? 0) > 0 || tile.teammateIdle;
        if (hasActiveWork) {
          // v0.9.3 (F6): a permission_prompt arriving while subagents are
          // in-flight is almost certainly on behalf of a subagent — surface
          // it as a flag that drives the working label. Gated on
          // pendingSubagents > 0 so a teammate-only `teammate_idle` scenario
          // keeps its own "Waiting for teammate" label instead of being
          // mislabeled as subagent permission.
          if (notifType === 'permission_prompt'
              && tile.status === 'working'
              && (tile.pendingSubagents ?? 0) > 0
              && !tile.subagentPermissionPending) {
            tile.subagentPermissionPending = true;
            tile.statusLabel = this.workingLabel(tile);
            changed = true;
          } else {
            this.log(() => `suppressed ready for ${tile.name}: pendingSubagents=${tile.pendingSubagents}, teammateIdle=${tile.teammateIdle}, notifType=${notifType ?? '-'}`);
          }
        } else if (tile.status !== 'done' && tile.status !== 'error' && tile.status !== 'offline') {
          // Transition into ready, OR refresh the label when already ready
          // (v0.9.3 F3). The prior guard `tile.status !== 'ready'` left
          // stale "Needs permission" labels stuck across the end-of-turn
          // Stop event — lift it, and only fire `changed` if the label
          // actually differs.
          const newLabel = this.readyLabelForNotification(notifType);
          if (tile.status !== 'ready') {
            tile.status = 'ready';
            tile.statusLabel = newLabel;
            tile.ignoredText = undefined;
            // Stop marks end-of-turn — clear transient flags. tool_failure
            // was from a call earlier this turn; compacting either completed
            // or was interrupted. Either way they're over at end-of-turn.
            tile.toolError = false;
            tile.compacting = false;
            // subagentPermissionPending is a working-only flag — a transition
            // to ready means the group has wrapped up (or Stop arrived while
            // the flag was stale). Clear it so it doesn't resurface if the
            // tile later cycles through working again.
            tile.subagentPermissionPending = false;
            this.markFreshlyReady(tile);
            this.startReadyTimer(tile.id);
            changed = true;
          } else if (tile.statusLabel !== newLabel) {
            tile.statusLabel = newLabel;
            // v0.9.3 (F3): a fresh Notification in an already-ready tile
            // deserves a fresh 60s attention window. Without this, a
            // permission_prompt arriving late into a ready state would
            // decay faster than if it had triggered the initial transition.
            if (event === 'Notification') {
              this.startReadyTimer(tile.id);
            }
            changed = true;
          }
        }
      } else if (status === 'working') {
        // PreToolUse → working. `done` is a sticky end state (user explicitly
        // parked via Mark-as-done) — only UserPromptSubmit un-parks it.
        // `ignored` is NOT sticky — real work overrides it.
        // `error` is cleared here too: real tool use is unambiguous evidence
        // that Claude recovered (e.g. auto-retry after rate limit).
        // Keeping error sticky on `ready` still filters out transient
        // Notification events during an outage.
        if (tile.status !== 'done' && tile.status !== 'offline') {
          tile.status = 'working';
          // Real tool use indicates the agent is back to work — clear
          // teammate-idle and any lingering error type.
          if (tile.teammateIdle) tile.teammateIdle = false;
          tile.errorType = undefined;
          // A successful PreToolUse clears a prior tool_failure flag — if the
          // next tool call succeeded far enough to fire PreToolUse, the
          // previous failure is old news.
          if (tile.toolError) tile.toolError = false;
          // Compaction had better be done if we're firing a tool — clear flag.
          if (tile.compacting) tile.compacting = false;
          // v0.9.3 — PreToolUse is "real activity from the parent" and so
          // belongs in the same clear set as teammateIdle / toolError /
          // compacting. Otherwise a subagent-permission label would linger
          // through the parent's next tool call (the flag would only clear
          // on a subsequent PostToolUse). If the subagent's prompt is
          // genuinely still outstanding, a fresh Notification will re-set
          // the flag on the next hook fire.
          if (tile.subagentPermissionPending) tile.subagentPermissionPending = false;
          tile.ignoredText = undefined;
          tile.statusLabel = this.workingLabel(tile);
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'session_start') {
        // v0.9.1 — Claude session came online. If tile was offline, restore
        // it. v0.9.3 (F5) — a `startup` or `clear` source means the session
        // is starting fresh (boot, or user-initiated /clear), so stale
        // `working` state from a prior-session crash should be reset too.
        // `resume` and `compact` are mid-session bookkeeping — leave state
        // alone. `done` remains sticky (user explicitly parked).
        const src = extra?.source ?? '';
        const isFreshStart = src === 'startup' || src === 'clear';
        if (tile.status === 'offline') {
          tile.status = 'idle';
          tile.statusLabel = this.configManager.getLabel('idle');
          tile.toolError = false;
          tile.compacting = false;
          tile.subagentPermissionPending = false;
          changed = true;
        } else if (isFreshStart && tile.status !== 'done' && tile.status !== 'idle') {
          // A previous session left the tile in some non-idle state (most
          // commonly `working` after a crash) — reset to idle so the next
          // UserPromptSubmit is the first observable event.
          tile.status = 'idle';
          tile.statusLabel = this.configManager.getLabel('idle');
          tile.ignoredText = undefined;
          tile.pendingSubagents = 0;
          tile.teammateIdle = false;
          tile.errorType = undefined;
          tile.toolError = false;
          tile.compacting = false;
          tile.subagentPermissionPending = false;
          this.clearReadyTimer(tile.id);
          this.clearSubagentWatchdog(tile.id);
          changed = true;
        }
      } else if (status === 'session_end') {
        // v0.9.1 — session terminated. Only the `logout` and
        // `prompt_input_exit` matchers mean Claude is genuinely gone;
        // `clear`, `resume`, `compact` are mid-session bookkeeping.
        // `bypass_permissions_disabled` and `other` are treated as soft
        // end events (still mark offline so user knows Claude isn't running).
        const reason = extra?.reason ?? '';
        const terminalReasons = ['logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other'];
        const isTerminal = terminalReasons.includes(reason) || reason === '';
        if (isTerminal && tile.status !== 'done') {
          tile.status = 'offline';
          tile.statusLabel = this.configManager.getLabel('offline');
          tile.ignoredText = undefined;
          tile.pendingSubagents = 0;
          tile.teammateIdle = false;
          tile.errorType = undefined;
          tile.toolError = false;
          tile.compacting = false;
          tile.subagentPermissionPending = false;
          this.clearReadyTimer(tile.id);
          this.clearSubagentWatchdog(tile.id);
          changed = true;
        }
      } else if (status === 'tool_failure') {
        // v0.9.1 — PostToolUseFailure. Transient flag; no state change.
        // Gets cleared on next successful PreToolUse (working branch above)
        // or on Stop/UserPromptSubmit. Shows "Working (tool error)" while set.
        // Only set the flag when we're already in working — the display
        // requires working state, so setting it elsewhere is just a leak.
        if (tile.status === 'working' && !tile.toolError) {
          tile.toolError = true;
          tile.statusLabel = this.workingLabel(tile);
          changed = true;
        }
      } else if (status === 'compact_start') {
        // v0.9.1 — PreCompact. Label override while compaction is running.
        // State stays `working` — compaction isn't user-actionable.
        // Only set the flag when we can actually display it (working or
        // idle → working). Any other state would silently hold the flag.
        if ((tile.status === 'working' || tile.status === 'idle') && !tile.compacting) {
          tile.compacting = true;
          tile.status = 'working';
          tile.statusLabel = this.workingLabel(tile);
          this.clearReadyTimer(tile.id);
          changed = true;
        }
      } else if (status === 'compact_end') {
        // v0.9.1 — PostCompact. Always clear compacting flag regardless of
        // current status — compaction is over even if the tile has moved
        // on (e.g. Stop fired first and moved us to ready). Only refresh
        // the label when we're still in working.
        if (tile.compacting) {
          tile.compacting = false;
          if (tile.status === 'working') {
            tile.statusLabel = this.workingLabel(tile);
            changed = true;
          }
        }
      } else if (status === 'tool_end') {
        // v0.9.3 (F1) — PostToolUse. A tool call just completed successfully.
        // Primary use: close the gap when the user approves a permission
        // prompt and the approved tool is the last of the turn — no further
        // PreToolUse fires, and Stop isn't enough (the ready branch's F3
        // label refresh only applies when Stop reaches us; PostToolUse is
        // what bumps status back to `working`).
        //
        // Promotion set includes `ignored` alongside `ready` and `error` —
        // "ignored" is the passive-aggressive park and is explicitly
        // non-sticky. The sibling `working` / `subagent_start` / `teammate_idle`
        // branches all promote out of `ignored`; keeping tool_end in that
        // set stays consistent. `done` and `offline` remain sticky.
        //
        // Does NOT clear the `toolError` flag: PostToolUseFailure and
        // PostToolUse may both fire on a failed tool call, and we want the
        // "Working (tool error)" indicator to stick until end-of-turn Stop
        // rather than flicker.
        if (tile.status === 'ready' || tile.status === 'error' || tile.status === 'ignored') {
          tile.status = 'working';
          tile.errorType = undefined;
          tile.ignoredText = undefined;
          tile.statusLabel = this.workingLabel(tile);
          this.clearReadyTimer(tile.id);
          changed = true;
        } else if (tile.status === 'working' && tile.subagentPermissionPending) {
          // The subagent's pending-permission may have just been resolved:
          // a PostToolUse after the permission was granted is the signal
          // that the subagent's tool actually ran. We don't have per-subagent
          // permission tracking, but clearing on any PostToolUse while
          // subagents are still running is the conservative refresh.
          tile.subagentPermissionPending = false;
          const newLabel = this.workingLabel(tile);
          if (tile.statusLabel !== newLabel) {
            tile.statusLabel = newLabel;
            changed = true;
          }
        } else {
          // Explicit no-op log: working-state PostToolUse is the common case
          // and is intentionally a no-op, but silence makes debugging stuck
          // tiles harder. Mirror the pattern used elsewhere in this switch.
          this.log(() => `tool_end no-op ${tile.name}: status=${tile.status}`);
        }
      }

      if (changed) {
        tile.lastActivity = Date.now();
        tile.event = event;
        // v0.19 (#36) — clear fresh-ready on transitions out of ready.
        // Label-only refreshes (ready → ready) leave both alone.
        if (prev === 'ready' && tile.status !== 'ready') {
          this.clearFreshlyReady(tile);
        }
        this.log(() => `transition ${tile.name}: ${prev} → ${tile.status} (event=${event ?? '-'})`);
        // v0.12 — emit state transition for audio + other downstream
        // consumers. Fires on every status change (not label-only refreshes).
        // Emitted even when from === to so consumers that care about a
        // specific incoming transition (e.g. ready-label refresh from a late
        // Notification) can still see the event, but AudioPlayer filters
        // from === 'ready' && to === 'ready' itself.
        this.onStateChangeEmitter.fire({
          tileId: tile.id,
          name: tile.name,
          from: prev,
          to: tile.status,
          event,
          isActive: tile.isActive,
        });
      } else {
        this.log(() => `no-op ${tile.name}: stayed ${prev} (event=${event ?? '-'}, incoming=${status})`);
      }
      let contextChanged = false;
      if (ctxResetEvent) {
        // Fresh session / session end — wipe any carried-over context%.
        if (tile.contextPercent !== undefined) {
          tile.contextPercent = undefined;
          contextChanged = true;
        }
      } else if (contextPercent !== undefined && tile.contextPercent !== contextPercent) {
        tile.contextPercent = contextPercent;
        contextChanged = true;
      }
      // Only fire when something actually changed — avoids spurious webview
      // repaints on no-op signals (e.g. v0.9 raw hook signals like
      // subagent_start that state machine doesn't yet act on).
      if (changed || contextChanged) {
        this.onChangeEmitter.fire();
      }
      return;
    }
    // Unmatched: log and do not fire — mirrors the `updateContext` pattern.
    this.log(() => {
      const names = Array.from(this.terminals.values()).map((t) => t.name).join(', ');
      return `unmatched status for "${projectName}" (tracked: [${names}])`;
    });
  }

  private startReadyTimer(id: number): void {
    this.clearReadyTimer(id);
    const timer = setTimeout(() => {
      this.readyTimers.delete(id);
      const tile = this.terminals.get(id);
      if (tile && tile.status === 'ready') {
        tile.status = 'waiting';
        tile.statusLabel = this.configManager.getLabel('waiting');
        // If this tile is currently focused, start tracking it
        if (tile.isActive) {
          this.focusedWaitingTile = id;
        }
        this.onChangeEmitter.fire();
      }
    }, 60_000);
    this.readyTimers.set(id, timer);
  }

  private clearReadyTimer(id: number): void {
    const existing = this.readyTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.readyTimers.delete(id);
    }
  }

  /**
   * v0.19 (#36) — stamp a tile as just-now-ready. Sets `readyAt` for the
   * sort comparator (so the tile floats to the top of the ready band) and
   * `freshlyReady` for the webview's brighter burst pulse. The flag clears
   * after FRESHLY_READY_MS via a per-tile timer that fires `onChange` so
   * the webview repaints.
   */
  private markFreshlyReady(tile: TileData): void {
    tile.readyAt = Date.now();
    tile.freshlyReady = true;
    const existing = this.freshlyReadyTimers.get(tile.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.freshlyReadyTimers.delete(tile.id);
      const live = this.terminals.get(tile.id);
      if (!live || !live.freshlyReady) return;
      live.freshlyReady = false;
      this.onChangeEmitter.fire();
    }, FRESHLY_READY_MS);
    this.freshlyReadyTimers.set(tile.id, timer);
  }

  /**
   * v0.19 (#36) — wipe the freshly-ready stamp + cancel the pending decay
   * timer. Called from the central transition-out-of-ready check so working
   * / done / error / offline transitions don't leave a stale "fresh" pulse
   * on a tile that's no longer ready.
   */
  private clearFreshlyReady(tile: TileData): void {
    tile.readyAt = undefined;
    tile.freshlyReady = false;
    const existing = this.freshlyReadyTimers.get(tile.id);
    if (existing) {
      clearTimeout(existing);
      this.freshlyReadyTimers.delete(tile.id);
    }
  }

  /**
   * v0.17.1 (#30) — arm (or re-arm) the inactivity watchdog for a tile's
   * subagent counter. Called after every SubagentStart/SubagentStop while
   * `pendingSubagents > 0`. When the timer fires without further activity,
   * the counter is by definition drift (the parent's Task tool is
   * synchronous — silence means the round drained), so we zero it and
   * re-fire onChange so the label updates.
   */
  private startSubagentWatchdog(id: number): void {
    this.clearSubagentWatchdog(id);
    const timer = setTimeout(() => {
      this.subagentWatchdogTimers.delete(id);
      const tile = this.terminals.get(id);
      if (!tile || (tile.pendingSubagents ?? 0) === 0) return;
      this.log(() => `subagent watchdog fired for ${tile.name}: zeroing pendingSubagents=${tile.pendingSubagents} (no SubagentStart/Stop in ${SUBAGENT_WATCHDOG_MS}ms)`);
      tile.pendingSubagents = 0;
      tile.subagentPermissionPending = false;
      if (tile.status === 'working') {
        tile.statusLabel = this.workingLabel(tile);
      }
      this.onChangeEmitter.fire();
    }, SUBAGENT_WATCHDOG_MS);
    this.subagentWatchdogTimers.set(id, timer);
  }

  private clearSubagentWatchdog(id: number): void {
    const existing = this.subagentWatchdogTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.subagentWatchdogTimers.delete(id);
    }
  }

  /**
   * Manually mark a tile as "done" — silences passive-aggressive judgement
   * when the user knows they're not actively using it. A subsequent
   * UserPromptSubmit will reset it back to "working".
   */
  markDone(id: number): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    const prev = tile.status;
    tile.status = 'done';
    tile.statusLabel = this.configManager.getLabel('done');
    tile.ignoredText = undefined;
    // Mark-done is a full park — clear v0.9/v0.9.1 transient state so a later
    // auto-retry or stray signal doesn't show stale "Working (2 agents)" /
    // "Waiting for teammate" / "Error: rate limit" / "Compacting…" text.
    tile.pendingSubagents = 0;
    tile.teammateIdle = false;
    tile.errorType = undefined;
    tile.toolError = false;
    tile.compacting = false;
    tile.subagentPermissionPending = false;
    tile.lastActivity = Date.now();
    this.clearReadyTimer(id);
    this.clearSubagentWatchdog(id);
    if (this.focusedWaitingTile === id) {
      this.focusedWaitingTile = null;
    }
    this.log(`manual mark-done ${tile.name}: ${prev} → done`);
    this.onChangeEmitter.fire();
  }

  setColor(id: number, color: string | undefined): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    // Persist to config file — single source of truth
    this.configManager.setColor(tile.name, color as any);
    const cfg = this.configManager.getTerminal(tile.name);
    tile.themeColor = getThemeColor(tile.name, cfg?.color);
    this.onChangeEmitter.fire();
  }

  /**
   * v0.16.3 (#11) — rename a tile from the webview context menu. Persists
   * `nickname` (display) + `projectName` (status routing) on the config
   * entry so incoming hook events that claim the new name route to this
   * tile too. The underlying VS Code terminal name is left alone — VS
   * Code's `Terminal.name` is read-only by API. Empty string clears both
   * fields, reverting to the raw terminal name.
   */
  setRenameOverride(id: number, newName: string): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    this.configManager.setRenameOverride(tile.name, newName);
    const cfg = this.configManager.getTerminal(tile.name);
    tile.displayName = cfg?.nickname || tile.name;
    this.onChangeEmitter.fire();
  }

  /** v0.13.4 (#4) — flip the pinned flag from the webview context menu. */
  setPinned(id: number, pinned: boolean): void {
    const tile = this.terminals.get(id);
    if (!tile) return;
    this.configManager.setPinned(tile.name, pinned);
    tile.pinned = pinned;
    this.onChangeEmitter.fire();
  }

  /**
   * v0.19 (#48) — handle a VS Code terminal close event. Public so tests
   * can invoke it directly (the vscode mock's onDidCloseTerminal stub
   * doesn't capture callbacks). Production code wires this in the
   * constructor's onDidCloseTerminal listener.
   *
   * Behavior: capture pinned state BEFORE removing the tile, then if the
   * tile was pinned, auto-clear the pin in config and fire the one-time
   * notice. Pinning is a statement about an active terminal slot — a
   * terminal exit therefore clears the pin so the tile lands cleanly in
   * Closed-but-visible.
   *
   * Exception: an `autoStart: true` entry is an explicitly permanent slot
   * (always-on "watch"/stream terminals, pinned dashboards). The class
   * docstring's "for pin-across-restart, users set autoStart: true" contract
   * only holds if we DON'T clear its pin on close — otherwise the next
   * auto-start relaunch reads `pinned: false` and the tile drops out of the
   * pinned zone. So autoStart entries keep their pin (and skip the unpin
   * toast). Manual (ad-hoc) pins still auto-clear so a closed one-off terminal
   * lands cleanly in Closed-but-visible.
   *
   * Note on timing: keeping `pinned: true` in config does NOT re-pin the tile
   * the instant it closes — nothing relaunches on `onDidCloseTerminal`. The
   * re-pin takes effect at the *next activation-time auto-start* (VS Code
   * restart / reload), when `addTerminal` reads `pinned: cfg?.pinned === true`
   * for the freshly-launched terminal. While the terminal stays closed within
   * a session it renders as an offline/registered tile (unchanged behavior) —
   * the point of preserving the config pin is purely cross-restart survival.
   */
  handleTerminalClosed(t: vscode.Terminal): void {
    const id = this.terminalIdMap.get(t);
    const tile = id !== undefined ? this.terminals.get(id) : undefined;
    const cfg = tile ? this.configManager.getTerminal(tile.name) : undefined;
    const isPermanent = cfg?.autoStart === true;
    const wasPinned = cfg?.pinned === true && !isPermanent;
    const closedName = tile?.name;
    const closedDisplay = tile?.displayName ?? closedName;
    this.removeTerminal(t);
    if (wasPinned && closedName) {
      this.configManager.setPinned(closedName, false);
      // v0.19 (#48) — fire onPinCleared so the UI layer (extension.ts)
      // can show the first-auto-unpin toast. Keeping vscode.window calls
      // out of the state machine — tracker stays a pure state machine,
      // UI lives where the rest of the toasts do.
      this.log(() => `pin-cleared event fired for ${closedName}`);
      this.onPinClearedEmitter.fire({
        name: closedName,
        displayName: closedDisplay ?? closedName,
      });
    }
    this.onChangeEmitter.fire();
  }

  /**
   * v0.19 (#45) — attach a freshly-launched terminal synchronously so the
   * tile is in the tracker map BEFORE the bar's next render. VS Code's
   * `onDidOpenTerminal` event fires asynchronously after `createTerminal`
   * returns; until it does, the registered (offline-looking) tile is what
   * the bar renders. Calling this method from the launch path closes that
   * gap — the live tile exists at status='idle' the instant the launch
   * resolves, and the later `onDidOpenTerminal` is idempotent (same id via
   * the WeakMap, same status — fired re-fire is harmless).
   */
  attachLaunchedTerminal(terminal: vscode.Terminal): void {
    this.addTerminal(terminal);
    this.startNameRefresh();
    this.onChangeEmitter.fire();
  }

  /**
   * v0.19 (#41) — close the live VS Code terminal for a tile by name.
   * Used by the organizer panel's drop-to-close path. Returns true when a
   * live terminal was found and disposed. The tracker's existing
   * `onDidCloseTerminal` listener will remove the tile from
   * `this.terminals` and fire `onChange` as part of normal cleanup, so
   * the bar refreshes without any extra plumbing here.
   */
  closeTerminalByName(name: string): boolean {
    for (const [id, tile] of this.terminals) {
      if (tile.name !== name) continue;
      const term = this.terminalRefs.get(id);
      if (!term) return false;
      term.dispose();
      return true;
    }
    return false;
  }

  /**
   * v0.16.4 (#19) — capture the last user prompt for a tile. Independent
   * of the state machine — no transitions, no label changes, just a
   * persistent string + timestamp on the tile that the webview can
   * surface as a hover tooltip and that the right-click "Show last
   * prompt" command can read for the full text. Empty/undefined prompt
   * is a no-op (preserves whatever was there from a prior submit).
   */
  updateLastPrompt(projectName: string, prompt: string, at: number): void {
    if (!prompt) return;
    const tile = this.findMatchingTile(projectName);
    if (!tile) return;
    tile.lastPrompt = prompt;
    tile.lastPromptAt = at;
    this.onChangeEmitter.fire();
  }

  updateContext(projectName: string, contextPercent: number): void {
    const tile = this.findMatchingTile(projectName);
    if (tile) {
      tile.contextPercent = contextPercent;
      this.onChangeEmitter.fire();
    }
  }

  getTiles(): TileData[] {
    // v0.13.4 (#4) — pinned tiles live in a fixed-position zone at the
    // bottom regardless of sortMode. Split, sort each group independently,
    // concat unpinned-first.
    //
    // v0.15.4 (#23) — a tile in `working` with `subagentPermissionPending`
    // is functionally awaiting user input on a subagent's permission prompt.
    // For sort + render purposes promote it to `ready` so it floats to the
    // top alongside primary Stop/Notification ready tiles and gets the
    // amber attention dot instead of the green working pulse. The internal
    // state machine still tracks it as `working` so transitions and
    // clearing logic don't need to change. Cloning the TileData here means
    // the override is render-only — the tracker's live tile state stays
    // authoritative for the state machine.
    const all = Array.from(this.terminals.values())
      .filter((t) => this.configManager.getTerminal(t.name)?.hidden !== true)
      .map((t) => {
        if (t.status === 'working' && t.subagentPermissionPending) {
          return { ...t, status: 'ready' as SessionStatus };
        }
        return t;
      });
    const unpinned = all.filter((t) => !t.pinned);
    const pinned = all.filter((t) => t.pinned);

    const manualSort = (a: TileData, b: TileData): number => {
      const ao = this.configManager.getTerminal(a.name)?.order;
      const bo = this.configManager.getTerminal(b.name)?.order;
      if (ao === undefined && bo === undefined) return b.lastActivity - a.lastActivity;
      if (ao === undefined) return 1;
      if (bo === undefined) return -1;
      return ao - bo;
    };

    // Pinned tiles always use manual `order` — the whole point of pinning is
    // a stable position, so floating by status would defeat it.
    pinned.sort(manualSort);

    if (this.configManager.getSortMode() === 'manual') {
      unpinned.sort(manualSort);
    } else {
      // Auto mode for unpinned: status-based with lastActivity tiebreak.
      // error floats to the top (above waiting) — errors demand attention more
      // than a tile that's just been waiting a while.
      // offline sits below idle — Claude isn't running, nothing actionable.
      // v0.16.0 (#25) — `shell` tiles are passive (no state, no urgency)
      // so they sit between `idle` (live but quiet Claude) and `offline`
      // (Claude was running, isn't now). Reads as "this terminal exists
      // and you can click it but nothing is happening here."
      const statusOrder: Record<string, number> = { error: 0, waiting: 1, ignored: 2, ready: 3, working: 4, done: 5, idle: 6, shell: 7, offline: 8 };
      unpinned.sort((a, b) => {
        const orderDiff = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
        if (orderDiff !== 0) return orderDiff;
        // v0.19 (#36) — within the ready band, sort by transition-into-ready
        // time descending so the just-now-ready tile sits at the top. Falls
        // back to lastActivity for tiles without readyAt (e.g. the
        // subagentPermissionPending → ready render-only promotion above,
        // which doesn't go through the ready-transition code path).
        if (a.status === 'ready' && b.status === 'ready') {
          const ar = a.readyAt ?? a.lastActivity;
          const br = b.readyAt ?? b.lastActivity;
          return br - ar;
        }
        return b.lastActivity - a.lastActivity;
      });
    }

    // v0.13.4 (#15) — registered (offline-but-launchable) tiles for every
    // config entry not currently running. Live in their own zone at the
    // very bottom, below pinned. Sorted by config `order` then slug.
    const registered = this.configManager.getShowRegisteredProjects()
      ? this.synthesizeRegisteredTiles(new Set(all.map((t) => t.name)))
      : [];
    // v0.19 (#37) — strict alphabetical by displayName. Registered tiles
    // aren't drag-reorderable in the bar (only running tiles in manual sort
    // are), so any `order` field on a registered entry is by definition
    // stale state from a prior session. displayName (nickname || name)
    // matches what the user actually sees on the tile.
    registered.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
    );

    return [...unpinned, ...pinned, ...registered];
  }

  /**
   * v0.15.0 (#20) — read the status JSON for a slug and decide if its
   * last-written state looks "live" (not idle/offline and recent enough).
   * A true result means a registered-tile synthesis for this slug would
   * show `offline` while Claude is actually running there, so the caller
   * should suppress it. Any IO/parse error returns false — safer to show
   * the registered tile than hide it on a hunch.
   */
  private isSlugLive(slug: string): boolean {
    try {
      const filePath = path.join(this.statusDir, `${slug}.json`);
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs > STATUS_FRESH_MS) return false;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { status?: string };
      if (!data.status) return false;
      return !NON_LIVE_STATUSES.has(data.status);
    } catch {
      return false;
    }
  }

  /**
   * v0.13.4 (#15) — build dim/dashed tiles for every config entry that
   * isn't currently running and isn't `hidden: true`. Click → launch.
   *
   * Synthetic ids are negative + stable per slug for the session, assigned
   * lazily so the webview's diff-update can re-use the same DOM elements
   * across renders without flicker.
   */
  private synthesizeRegisteredTiles(realNames: Set<string>): TileData[] {
    const thresholds = this.configManager.getContextThresholds();
    const out: TileData[] = [];
    const all = this.configManager.getAll();
    for (const [slug, cfg] of Object.entries(all)) {
      if (realNames.has(slug)) continue;
      if (cfg.hidden === true) continue;
      // v0.15.0 (#20) — a slug with a fresh non-idle status file is running
      // somewhere; the tracker just hasn't associated a VS Code terminal
      // with it (common cause: CLAUDELIKE_BAR_NAME env var routes the hook
      // to this slug but the terminal's VS Code name differs). Showing a
      // dim "offline" tile for a slug that's actively writing `working`
      // status is actively misleading — suppress the synthesis instead.
      // Log it so state drift still surfaces in the debug output.
      if (this.isSlugLive(slug)) {
        this.log(() => `drift ${slug}: fresh status file but no tracked terminal — suppressing registered tile`);
        continue;
      }
      let id = this.syntheticIds.get(slug);
      if (id === undefined) {
        id = this.nextSyntheticId--;
        this.syntheticIds.set(slug, id);
      }
      // v0.16.1 (#25) — carry tile type onto the synthesized registered
      // tile so the webview can apply shell-style chrome (gray dot, no
      // Claude-specific menu items) on the click-to-launch tile too.
      // Click handler routes through launchByName regardless of type;
      // launchProject + getAutoStartCommand know to skip the global
      // claudeCommand fallback when the entry is a shell.
      const isShell = cfg.type === 'shell';
      out.push({
        id,
        name: slug,
        displayName: cfg.nickname || slug,
        status: 'registered',
        statusLabel: this.configManager.getLabel('registered'),
        lastActivity: 0,
        isActive: false,
        themeColor: getThemeColor(slug, cfg.color),
        icon: cfg.icon ?? ICON_MAP[slug] ?? null,
        contextWarn: thresholds.warn,
        contextCrit: thresholds.crit,
        pinned: false,
        type: isShell ? 'shell' : 'claude',
      });
    }
    return out;
  }

  /**
   * Apply a new manual ordering by tile IDs. Persists to the config file so
   * the order survives window reloads and container rebuilds.
   */
  reorderTiles(orderedIds: number[]): void {
    const orderedNames: string[] = [];
    for (const id of orderedIds) {
      const tile = this.terminals.get(id);
      if (tile) orderedNames.push(tile.name);
    }
    if (orderedNames.length === 0) return;
    // Single atomic call — ConfigManager owns both the order write and the
    // sortMode flip, so policy lives in one place.
    this.configManager.applyDragOrder(orderedNames);
    this.log(`reorder: ${orderedNames.join(', ')}`);
    this.onChangeEmitter.fire();
  }

  getTerminalById(id: number): vscode.Terminal | undefined {
    return this.terminalRefs.get(id);
  }

  getTerminalByName(name: string): vscode.Terminal | undefined {
    for (const [id, tile] of this.terminals) {
      if (tile.name === name) {
        return this.terminalRefs.get(id);
      }
    }
    return undefined;
  }

  // v0.20 (#55) — iterate live, user-visible terminals. Skips hidden tiles
  // (the issue's stated opt-out gesture: "mark it hidden or close it first")
  // and dead terminals (exitStatus set). Synthesized registered tiles have
  // no terminalRefs entry so they're skipped automatically. The cb gets the
  // live vscode.Terminal plus the tile state — callers that want to tally
  // by status (e.g. broadcast) can branch on tile.status without a second
  // lookup.
  forEachTrackedTerminal(
    cb: (terminal: vscode.Terminal, tile: TileData) => void,
  ): void {
    for (const [id, tile] of this.terminals) {
      if (this.configManager.getTerminal(tile.name)?.hidden === true) continue;
      const term = this.terminalRefs.get(id);
      if (!term) continue;
      if (term.exitStatus !== undefined) continue;
      cb(term, tile);
    }
  }

  dispose(): void {
    this.stopNameRefresh();
    for (const timer of this.readyTimers.values()) {
      clearTimeout(timer);
    }
    this.readyTimers.clear();
    for (const timer of this.subagentWatchdogTimers.values()) {
      clearTimeout(timer);
    }
    this.subagentWatchdogTimers.clear();
    for (const timer of this.freshlyReadyTimers.values()) {
      clearTimeout(timer);
    }
    this.freshlyReadyTimers.clear();
    for (const d of this.disposables) d.dispose();
    this.terminals.clear();
    this.terminalRefs.clear();
  }
}
