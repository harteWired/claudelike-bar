import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { StateTransition, TransitionListener } from './types';

/**
 * v0.12 — AudioPlayer
 *
 * Subscribes to `TerminalTracker.onStateChange` and emits `play` messages to
 * the webview whenever a tile transitions *into* `ready` (Claude is blocked
 * on the user). Two optional sound slots:
 *   - `permission` — for mid-job prompts (Notification events)
 *   - `ready`     — for end-of-turn (Stop events), also the fallback when
 *                   `permission` isn't set
 *
 * Filtering:
 *   - config.audio.enabled === false → drop
 *   - transition is `ready → ready` (label refresh) → drop
 *   - tile is currently the focused VS Code terminal → drop
 *   - chosen slot has no file configured / file missing → drop + warn-once
 *
 * Debounce: simultaneous transitions on multiple tiles within `debounceMs`
 * coalesce into a single `play` per sound key. Keyed on the resolved filename
 * so `ready` + `permission` can both fire close together without stomping.
 */
export interface AudioPostTarget {
  /** Post a play message to the webview. Implemented by DashboardProvider. */
  postPlay(filename: string, volume: number): void;
}

/** Minimum contract the AudioPlayer needs from the tracker. Keeps DI cheap. */
export interface TransitionSource {
  onStateChange(listener: TransitionListener): vscode.Disposable;
}

export class AudioPlayer implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private missingWarnings = new Set<string>();
  private log: (msg: string | (() => string)) => void;

  constructor(
    private readonly tracker: TransitionSource,
    private readonly configManager: ConfigManager,
    private readonly postTarget: AudioPostTarget,
    log?: (msg: string | (() => string)) => void,
    private readonly soundsDirOverride?: string,
  ) {
    this.log = log ?? (() => {});
    this.disposables.push(
      this.tracker.onStateChange((t) => this.handleTransition(t)),
    );
  }

  private handleTransition(t: StateTransition): void {
    // Filter: only transitions INTO ready, and not ready → ready (label
    // refresh). The guard `from !== 'ready'` also covers SubagentStop and
    // StopFailure because those don't land on ready in the first place.
    if (t.to !== 'ready' || t.from === 'ready') return;

    const audio = this.configManager.getAudioConfig(this.soundsDirOverride);
    if (!audio.enabled) {
      this.log(() => `audio: enabled=false, skipping ${t.name}`);
      return;
    }

    // Focused tile — user is already looking at it. Don't ding themselves.
    if (t.isActive) {
      this.log(() => `audio: tile ${t.name} focused, skipping`);
      return;
    }

    // Slot selection: Notification → permission (fallback ready), else ready.
    const isPermission = t.event === 'Notification';
    const chosen = isPermission && audio.sounds.permission
      ? audio.sounds.permission
      : audio.sounds.ready;

    if (!chosen) {
      // Warn-once per slot. Point the user at the slot they'd actually need
      // to fix: if a Notification fell through to the `ready` slot (because
      // `permission` wasn't set) and `ready` is missing too, naming
      // `permission` in the log sends them to the wrong knob.
      let slotKey: string;
      if (!audio.sounds.ready && !audio.sounds.permission) {
        slotKey = 'ready or permission';
      } else if (isPermission && !audio.sounds.permission) {
        // Fell back to `ready`, but `ready` is also unset — it's `ready`
        // that the user needs to configure to get sound here.
        slotKey = 'ready';
      } else {
        slotKey = isPermission ? 'permission' : 'ready';
      }
      if (!this.missingWarnings.has(slotKey)) {
        this.missingWarnings.add(slotKey);
        this.log(`audio: no ${slotKey} sound configured or file missing — silent`);
      }
      return;
    }

    this.scheduleDebounced(chosen, audio.volume, audio.debounceMs);
  }

  private scheduleDebounced(filename: string, volume: number, debounceMs: number): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      try {
        this.postTarget.postPlay(filename, volume);
        this.log(() => `audio: play ${filename} @ vol ${volume}`);
      } catch (err) {
        this.log(() => `audio: postPlay failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }, debounceMs);
    this.debounceTimers.set(filename, timer);
  }

  /** Reset the "warn-once" memory — useful after the user edits the config. */
  resetWarnings(): void {
    this.missingWarnings.clear();
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
