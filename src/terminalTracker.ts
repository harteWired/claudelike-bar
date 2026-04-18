import * as vscode from 'vscode';
import { TileData, SessionStatus, HookStatusSignal, ICON_MAP, getThemeColor, StateTransition } from './types';
import { ConfigManager } from './configManager';

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
  private nameRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private nameRefreshIdleCycles = 0;
  private configManager: ConfigManager;
  private log: (msg: string | (() => string)) => void;

  // State machine timers: ready → waiting after 60s
  private readyTimers = new Map<number, NodeJS.Timeout>();

  // Focus tracking: which tile was focused while in "waiting" state
  private focusedWaitingTile: number | null = null;

  constructor(configManager: ConfigManager, log?: (msg: string | (() => string)) => void) {
    this.configManager = configManager;
    this.log = log ?? (() => {});
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
      vscode.window.onDidCloseTerminal((t) => {
        this.removeTerminal(t);
        this.onChangeEmitter.fire();
      }),
      vscode.window.onDidChangeActiveTerminal((active) => {
        this.handleActiveTerminalChange(active);
        this.onChangeEmitter.fire();
      }),
      this.onChangeEmitter,
      this.onStateChangeEmitter,
    );

    // Periodically refresh terminal names — catches late profile name assignment
    this.startNameRefresh();
  }

  private addTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    if (name === 'bash' || name === 'zsh' || name === 'sh') return;

    // Auto-populate config file entry
    this.configManager.ensureEntry(name);
    const cfg = this.configManager.getTerminal(name);
    const thresholds = this.configManager.getContextThresholds();

    const id = this.assignId(terminal);
    this.terminalRefs.set(id, terminal);
    this.terminals.set(id, {
      id,
      name,
      displayName: cfg?.nickname || name,
      status: 'idle',
      statusLabel: this.configManager.getLabel('idle'),
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
    });
  }

  private removeTerminal(terminal: vscode.Terminal): void {
    const id = this.terminalIdMap.get(terminal);
    if (id !== undefined) {
      this.terminals.delete(id);
      this.terminalRefs.delete(id);
      this.clearReadyTimer(id);
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
            this.configManager.ensureEntry(name);
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

  /** Re-apply config (colors, nicknames, icons, thresholds) to all tracked tiles. */
  refreshFromConfig(): void {
    const thresholds = this.configManager.getContextThresholds();
    for (const [, tile] of this.terminals) {
      const cfg = this.configManager.getTerminal(tile.name);
      tile.displayName = cfg?.nickname || tile.name;
      tile.themeColor = getThemeColor(tile.name, cfg?.color);
      tile.icon = cfg?.icon ?? ICON_MAP[tile.name] ?? null;
      tile.contextWarn = thresholds.warn;
      tile.contextCrit = thresholds.crit;
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
      const prev = tile.status;
      let changed = false;

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
        if (this.focusedWaitingTile === tile.id) {
          this.focusedWaitingTile = null;
        }
        changed = true;
      } else if (status === 'subagent_start') {
        // v0.9 — Task-tool subagent spawned. Increment counter, stay working.
        tile.pendingSubagents = (tile.pendingSubagents ?? 0) + 1;
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
      if (contextPercent !== undefined && tile.contextPercent !== contextPercent) {
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

  updateContext(projectName: string, contextPercent: number): void {
    const tile = this.findMatchingTile(projectName);
    if (tile) {
      tile.contextPercent = contextPercent;
      this.onChangeEmitter.fire();
    }
  }

  getTiles(): TileData[] {
    const tiles = Array.from(this.terminals.values());

    if (this.configManager.getSortMode() === 'manual') {
      tiles.sort((a, b) => {
        const ao = this.configManager.getTerminal(a.name)?.order;
        const bo = this.configManager.getTerminal(b.name)?.order;
        // Unordered tiles sink to the bottom, most-recent first.
        if (ao === undefined && bo === undefined) return b.lastActivity - a.lastActivity;
        if (ao === undefined) return 1;
        if (bo === undefined) return -1;
        return ao - bo;
      });
      return tiles;
    }

    // Auto mode: status-based with lastActivity tiebreak.
    // error floats to the top (above waiting) — errors demand attention more
    // than a tile that's just been waiting a while.
    // offline sits below idle — Claude isn't running, nothing actionable.
    const statusOrder: Record<string, number> = { error: 0, waiting: 1, ignored: 2, ready: 3, working: 4, done: 5, idle: 6, offline: 7 };
    tiles.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
      if (orderDiff !== 0) return orderDiff;
      return b.lastActivity - a.lastActivity;
    });

    return tiles;
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

  dispose(): void {
    this.stopNameRefresh();
    for (const timer of this.readyTimers.values()) {
      clearTimeout(timer);
    }
    this.readyTimers.clear();
    for (const d of this.disposables) d.dispose();
    this.terminals.clear();
    this.terminalRefs.clear();
  }
}
