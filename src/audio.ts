import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { StateTransition, TransitionListener } from './types';

/**
 * AudioPlayer
 *
 * Subscribes to `TerminalTracker.onStateChange` and emits `play` messages to
 * the webview whenever a tile transitions *into* `ready` (Claude is blocked
 * on the user). Two optional sound slots:
 *   - `midJobPrompt` — for mid-job prompts (Notification events)
 *   - `turnDone`     — for end-of-turn (Stop events), also the fallback when
 *                      `midJobPrompt` isn't set
 *
 * Filtering:
 *   - config.audio.enabled === false → drop
 *   - transition is `ready → ready` (label refresh) → drop
 *   - tile is the focused VS Code terminal AND
 *     config.audio.suppressOnFocusedTile === true → drop (v0.18.0 #28: the
 *     suppression default flipped to off so chimes always fire on Stop/
 *     Notification, even on the focused tile)
 *   - chosen slot has no file configured / file missing → drop + warn-once
 *
 * Debounce: rapid repeat transitions on the SAME tile within `debounceMs`
 * coalesce into a single `play`. Keyed on the unique tile id (#33) — the prior
 * per-filename key meant two *different* tiles flipping to ready within the
 * window collapsed into one chime, so a user watching a specific tile saw a
 * dropped cue. Per-tile keying lets every tile that finishes get its own
 * chime while still swallowing a single tile's duplicate fires.
 *
 * v0.14 renamed the slots from `ready`/`permission`. The config reader
 * accepts both names; this module only sees the canonical new names.
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

    // v0.18.0 (#28) — focused-tile suppression is now opt-in. Pre-v0.18 this
    // unconditionally swallowed chimes when the destination tile was focused;
    // users with eyes on the editor pane (not the terminal) silently missed
    // turn-done cues. Default: always play. Flip suppressOnFocusedTile to
    // true in config to restore the legacy behavior.
    if (t.isActive && audio.suppressOnFocusedTile) {
      this.log(() => `audio: tile ${t.name} focused + suppressOnFocusedTile=true, skipping`);
      return;
    }

    // Slot selection: Notification → midJobPrompt (fallback turnDone), else turnDone.
    const isMidJobPrompt = t.event === 'Notification';
    const chosen = isMidJobPrompt && audio.sounds.midJobPrompt
      ? audio.sounds.midJobPrompt
      : audio.sounds.turnDone;

    if (!chosen) {
      // Warn-once per slot. Point the user at the slot they'd actually need
      // to fix: if a Notification fell through to `turnDone` (because
      // `midJobPrompt` wasn't set) and `turnDone` is missing too, naming
      // `midJobPrompt` in the log sends them to the wrong knob.
      let slotKey: string;
      if (!audio.sounds.turnDone && !audio.sounds.midJobPrompt) {
        slotKey = 'turnDone or midJobPrompt';
      } else if (isMidJobPrompt && !audio.sounds.midJobPrompt) {
        slotKey = 'turnDone';
      } else {
        slotKey = isMidJobPrompt ? 'midJobPrompt' : 'turnDone';
      }
      if (!this.missingWarnings.has(slotKey)) {
        this.missingWarnings.add(slotKey);
        this.log(`audio: no ${slotKey} sound configured or file missing — silent`);
      }
      return;
    }

    // Key on the unique tile id, not the filename or the display name, so
    // concurrent ready transitions on different tiles each get a chime (#33).
    // tileId is guaranteed unique; tile names can collide (two folders with
    // the same basename, nickname clashes), which would re-introduce the
    // dropped-cue bug along the name axis.
    this.scheduleDebounced(String(t.tileId), chosen, audio.volume, audio.debounceMs);
  }

  private scheduleDebounced(key: string, filename: string, volume: number, debounceMs: number): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      try {
        this.postTarget.postPlay(filename, volume);
        this.log(() => `audio: play ${filename} @ vol ${volume}`);
      } catch (err) {
        this.log(() => `audio: postPlay failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }, debounceMs);
    this.debounceTimers.set(key, timer);
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
