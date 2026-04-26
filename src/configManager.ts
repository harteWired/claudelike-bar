import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { ThemeGroup, getDefaultColor, ICON_MAP, AudioConfig } from './types';
import { claudeDir, globalConfigPath, pathIndexPath, soundsDir, DEFAULT_TURN_DONE_SOUND } from './claudePaths';

export interface TerminalConfig {
  color: ThemeGroup | 'red' | string;
  icon: string | null;
  nickname: string | null;
  autoStart: boolean;
  command?: string | null;
  order?: number;
  /**
   * Project name used by the hook script (e.g. "vscode-enhancement") when the
   * terminal's VS Code display name differs (e.g. "VS Code Enhancement").
   * Used to match status file writes to the correct tile.
   * Leave unset to match on terminal name directly, or rely on the
   * normalized fallback (lowercase, stripped whitespace/hyphens).
   */
  projectName?: string | null;
  /**
   * Absolute path to the project directory. Canonical identity — used for
   * matching hook status updates to tiles and for deriving collision-free
   * status filenames. Also serves as the default `cwd` when `cwd` is unset.
   * Set automatically by the "Register Project" command or the setup wizard.
   */
  path?: string | null;
  /**
   * Working directory the terminal opens in. Passed to VS Code's
   * `createTerminal({ cwd })` API — cross-platform, no shell syntax.
   * Separating `cwd` from `command` means `command` can be a simple
   * `"claude --auto"` that works on any shell, instead of a
   * shell-specific `"cd '/path' && claude --auto"` pattern.
   */
  cwd?: string | null;
  /**
   * Absolute path to a shell executable (e.g.
   * "C:\\Program Files\\Git\\bin\\bash.exe"). When set, auto-started terminals
   * use this shell regardless of VS Code's default profile. Escape hatch
   * for users who need a specific shell; most users should use `cwd` +
   * `command` instead. Leave unset to inherit the VS Code default.
   */
  shellPath?: string | null;
  /**
   * Arguments passed to `shellPath`. Ignored when `shellPath` is unset.
   * Example (pwsh 7 with no profile): ["-NoProfile"].
   */
  shellArgs?: string[] | null;
  /**
   * v0.13.4 (#4) — when true, the tile lives in a fixed-position "pinned"
   * zone at the bottom of the bar regardless of `sortMode`. Pinned tiles
   * are sorted by `order` within their zone (assigned via drag); unpinned
   * tiles fill the top of the bar and follow the global sort. Useful for
   * keeping monitoring/infra terminals at known coordinates while urgent
   * project tiles float to the top.
   */
  pinned?: boolean;
  /**
   * v0.13.4 (#15) — when true, this entry is excluded from the registered-
   * tile zone (the dim "click to launch" tiles for projects you've registered
   * but haven't opened yet). Use this for archived projects you don't want
   * to delete from the registry but also don't want cluttering the bar.
   * Has no effect on entries that are currently running — the live tile
   * always appears regardless.
   */
  hidden?: boolean;
  /**
   * v0.16.0 (#25) — terminal kind. `"claude"` (default when unset) engages
   * the full state machine — hooks, status JSONs, animated dots, all the
   * working/ready/waiting transitions. `"shell"` is a plain non-Claude
   * terminal that lives in the bar without any of that — gray pill, no
   * status, click to focus. Use for ad-hoc shells you want reachable from
   * the bar alongside Claude tiles.
   */
  type?: 'claude' | 'shell';
}

/**
 * Options for creating an auto-started terminal. Passed through to
 * `vscode.window.createTerminal({ name, env, shellPath, shellArgs })`.
 * `env` is always populated with `CLAUDELIKE_BAR_NAME` so the hook can map
 * the terminal to a tile; `shellPath`/`shellArgs` come from the config and
 * are optional.
 */
export interface AutoStartTerminalOptions {
  env: Record<string, string>;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
}

export interface ContextThresholds {
  warn: number;
  crit: number;
}

export type SortMode = 'auto' | 'manual';

/**
 * Raw on-disk shape of the audio section — every field optional, and any
 * unknown keys are preserved through read-merge-write (v0.12).
 *
 * v0.14 added `turnDone` / `midJobPrompt` as the canonical slot names. The
 * v0.12-era `ready` / `permission` are accepted as aliases on read (new
 * names win when both are set) and dropped from the serialized output on
 * next save, migrating the file in place without any user action.
 */
export interface AudioConfigRaw {
  enabled?: boolean;
  volume?: number;
  debounceMs?: number;
  sounds?: {
    /** @deprecated v0.14 — renamed to `turnDone`. Still read for back-compat. */
    ready?: string | null;
    /** @deprecated v0.14 — renamed to `midJobPrompt`. Still read for back-compat. */
    permission?: string | null;
    turnDone?: string | null;
    midJobPrompt?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ConfigFile {
  $schema?: string;
  description?: string;
  mode?: 'chill' | 'passive-aggressive';
  sortMode?: SortMode;
  claudeCommand?: string | null;
  debug?: boolean;
  labels?: Partial<Record<string, string>>;
  contextThresholds?: Partial<ContextThresholds>;
  ignoredTexts?: string[];
  audio?: AudioConfigRaw;
  /**
   * v0.13.4 (#15) — when true, render a dim/dashed tile for every
   * registered config entry that isn't currently running (and isn't
   * `hidden: true`). Click to launch. Default true — opt out by setting
   * this to false if you want the bar to only show currently-open
   * terminals, like prior versions.
   */
  showRegisteredProjects?: boolean;
  terminals: Record<string, TerminalConfig>;
}

const AUDIO_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_AUDIO_VOLUME = 0.6;
const DEFAULT_AUDIO_DEBOUNCE_MS = 150;

const CONFIG_FILENAME = '.claudelike-bar.jsonc';
const LEGACY_CONFIG_FILENAME = '.claudelike-bar.json';

const DEFAULT_LABELS: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  ready: 'Ready for input',
  waiting: 'Waiting...',
  done: 'Done',
  // v0.9 — richer state awareness
  error: 'Error',
  teammate_idle: 'Waiting for teammate',
  // v0.9.1 — lifecycle + transient flags
  offline: 'Offline',
  compacting: 'Compacting context…',
  tool_error: 'Working (tool error)',
  // v0.9.3 — subagent permission prompt while parent is still working
  subagent_permission: 'Subagent needs permission',
  // v0.13.4 (#15) — registered but not yet running. Click the dim tile to launch.
  registered: 'Click to launch',
  // v0.16.0 (#25) — plain non-Claude shell tile. Empty string = no status
  // text rendered; the tile shows just the displayName and a gray pill.
  shell: '',
};

const DEFAULT_IGNORED_TEXTS = [
  'Being ignored :(',
  'Hello? Anyone?',
  "I'll just wait here then",
  'This is fine',
  'You have other terminals?',
  'Patiently judging you',
  'Still here btw',
  "I guess I'm not important",
  'Take your time, no rush',
  "It's not like I'm waiting or anything",
];

const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = { warn: 30, crit: 50 };

export class ConfigManager implements vscode.Disposable {
  private config: ConfigFile = { terminals: {} };
  private configPath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.onChangeEmitter.event;
  private writeDebounce: ReturnType<typeof setTimeout> | undefined;
  private isSaving = false;
  private isSavingTimer: ReturnType<typeof setTimeout> | undefined;
  private hasShownWriteError = false;
  private mergedLabels: Record<string, string> = { ...DEFAULT_LABELS };
  // v0.12 — getAudioConfig() hits fs.existsSync() twice per call. Cache the
  // validated result so hot-path callers (every state transition + every
  // refreshTiles) don't pay the sync I/O tax. Invalidated on reload.
  private _audioConfigCache: AudioConfig | undefined;
  // v0.14 — when set, validateSlot falls back to this dir if a filename
  // doesn't exist in the user's `~/.claude/sounds/`. Lets bundled defaults
  // resolve without the user having to hand-copy them. Unset in tests that
  // don't need bundled resolution — they just use the per-test temp dir.
  private _bundledSoundsDir: string | undefined;

  constructor(configPathOverride?: string, bundledSoundsDirOverride?: string) {
    // v0.10.1 — config lives at ~/.claude/claudelike-bar.jsonc (user-global).
    // Workspace-local files are checked only for one-time migration.
    // configPathOverride is for testing only — lets tests point at a temp dir.
    this.configPath = configPathOverride ?? globalConfigPath();
    this._bundledSoundsDir = bundledSoundsDirOverride;

    this.load();
    this.setupWatcher();
    this.disposables.push(this.onChangeEmitter);
  }

  /**
   * Late-set the bundled-sounds dir (after construction). Used when the
   * ConfigManager is built before the extension's `context.extensionPath`
   * is handy, e.g. in a subset of initialization orderings.
   */
  setBundledSoundsDir(dir: string | undefined): void {
    if (this._bundledSoundsDir === dir) return;
    this._bundledSoundsDir = dir;
    this._audioConfigCache = undefined;
  }

  private load(): void {
    // 1. Try the global config first (the primary location).
    if (fs.existsSync(this.configPath)) {
      this.loadFrom(this.configPath);
      this.migrateCdCommands();
      return;
    }

    // 2. No global config — check for a workspace-local file to migrate.
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      const root = workspaceFolders[0].uri.fsPath;
      const candidates = [
        path.join(root, CONFIG_FILENAME),
        path.join(root, LEGACY_CONFIG_FILENAME),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          this.loadFrom(candidate);
          this.migrateCdCommands();
          // Copy to global location so subsequent loads go through path 1.
          fs.mkdirSync(claudeDir(), { recursive: true });
          this.save();
          vscode.window.showInformationMessage(
            `Claudelike Bar: migrated config to ${this.configPath}. The workspace file is no longer used.`,
          );
          return;
        }
      }
    }

    // 3. No config file anywhere — start fresh.
  }

  private loadFrom(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseJsonc(content);
      if (parsed && typeof parsed.terminals === 'object') {
        this.config = parsed;
        this.mergedLabels = { ...DEFAULT_LABELS, ...this.config.labels };
        // Any audio.* fields may have changed — drop the cache so the next
        // getAudioConfig() re-validates against the new on-disk state.
        this._audioConfigCache = undefined;
      }
    } catch {
      // File is malformed — start fresh
    }
  }

  /**
   * One-time migration: extract `cd /path && command` patterns in the
   * `command` field into separate `cwd` + `command`. Runs on load so
   * users upgrading from pre-v0.9.4 don't need to hand-edit every terminal.
   * Only touches terminals that have a `command` and no `cwd` already set.
   */
  private migrateCdCommands(): void {
    // Match:  cd <path> && <rest>   or   cd <path> ; <rest>
    // Path may be single-quoted, double-quoted, or unquoted (no spaces).
    const cdPattern = /^cd\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*(?:&&|;)\s*(.+)$/;
    let migrated = 0;
    for (const [, cfg] of Object.entries(this.config.terminals)) {
      if (!cfg.command || cfg.cwd) continue;
      const m = cfg.command.match(cdPattern);
      if (m) {
        cfg.cwd = m[1] ?? m[2] ?? m[3]; // whichever capture group matched
        cfg.command = m[4];              // everything after the separator
        migrated++;
      }
    }
    if (migrated > 0) {
      this.scheduleSave();
    }
  }

  private setupWatcher(): void {
    const dir = path.dirname(this.configPath);
    const filename = path.basename(this.configPath);
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), filename);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      this.watcher.onDidChange(() => this.reload()),
      this.watcher.onDidCreate(() => this.reload()),
      this.watcher.onDidDelete(() => {
        if (this.isSaving) return;
        this.config = { terminals: {} };
        this._audioConfigCache = undefined;
        this.onChangeEmitter.fire();
      }),
      this.watcher,
    );
  }

  /**
   * Re-read the config file from disk. Public so callers (and tests) can
   * force a refresh independent of the file-system watcher — the watcher
   * doesn't fire reliably across all platforms (Windows debounce, mocked
   * fs in tests).
   */
  reload(): void {
    if (this.isSaving) return; // skip reload from our own write
    this.loadFrom(this.configPath);
    this.mergedLabels = { ...DEFAULT_LABELS, ...this.config.labels };
    this.onChangeEmitter.fire();
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getMode(): 'chill' | 'passive-aggressive' {
    return this.config.mode === 'passive-aggressive' ? 'passive-aggressive' : 'chill';
  }

  getLabel(status: string): string {
    return this.mergedLabels[status] || status;
  }

  getIgnoredTexts(): string[] {
    if (this.config.ignoredTexts && this.config.ignoredTexts.length > 0) {
      return this.config.ignoredTexts;
    }
    return DEFAULT_IGNORED_TEXTS;
  }

  getContextThresholds(): ContextThresholds {
    return {
      warn: this.config.contextThresholds?.warn ?? DEFAULT_CONTEXT_THRESHOLDS.warn,
      crit: this.config.contextThresholds?.crit ?? DEFAULT_CONTEXT_THRESHOLDS.crit,
    };
  }

  /** Whether debug logging is enabled. */
  isDebugEnabled(): boolean {
    return this.config.debug === true;
  }

  /**
   * Resolve + validate the audio section. Returns a fully-typed AudioConfig
   * with slots nulled-out when their filename is invalid or missing on disk.
   * Slots fail independently — a bad `permission` never disables `ready`.
   *
   * Validation rules (per spec):
   *   - Filename must match ^[a-zA-Z0-9._-]+$ (prevents path traversal)
   *   - File must exist at ~/.claude/sounds/<name>
   *   - Missing / null / empty slot is silently allowed (just silent)
   *
   * `soundsDirOverride` is a test hook — tests point it at a temp dir.
   * When an override is passed the result is NOT cached (tests change dirs
   * between runs; caching a temp path would poison later calls).
   */
  getAudioConfig(soundsDirOverride?: string): AudioConfig {
    if (!soundsDirOverride && this._audioConfigCache) {
      return this._audioConfigCache;
    }
    const raw = (this.config.audio ?? {}) as AudioConfigRaw;
    const dir = soundsDirOverride ?? soundsDir();
    const volume = typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1
      ? raw.volume
      : DEFAULT_AUDIO_VOLUME;
    const debounceMs = typeof raw.debounceMs === 'number' && raw.debounceMs >= 0
      ? raw.debounceMs
      : DEFAULT_AUDIO_DEBOUNCE_MS;
    const sounds = (raw.sounds ?? {}) as {
      ready?: unknown;
      permission?: unknown;
      turnDone?: unknown;
      midJobPrompt?: unknown;
    };
    const bundled = this._bundledSoundsDir;
    const validateSlot = (value: unknown): string | null => {
      if (typeof value !== 'string' || value.length === 0) return null;
      if (!AUDIO_FILENAME_RE.test(value)) return null;
      try {
        if (fs.existsSync(path.join(dir, value))) return value;
        // v0.14 — fall back to bundled sounds dir so shipped defaults like
        // `turn-done-default.mp3` resolve without a user-dir copy.
        if (bundled && fs.existsSync(path.join(bundled, value))) return value;
      } catch {
        return null;
      }
      return null;
    };
    // v0.14 — new names win, legacy names fall back. A config that still has
    // `ready`/`permission` keeps working; on next save the serializer drops
    // the legacy keys and writes new names only.
    const turnDoneRaw = sounds.turnDone ?? sounds.ready;
    const midJobPromptRaw = sounds.midJobPrompt ?? sounds.permission;
    const resolved: AudioConfig = {
      enabled: raw.enabled === true,
      volume,
      debounceMs,
      sounds: {
        turnDone: validateSlot(turnDoneRaw),
        midJobPrompt: validateSlot(midJobPromptRaw),
      },
    };
    if (!soundsDirOverride) {
      this._audioConfigCache = resolved;
    }
    return resolved;
  }

  /**
   * Zero-I/O read of audio.enabled. Used on the hot path (every refreshTiles
   * call) so we don't pay the fs.existsSync() tax just to light up the
   * Mute/Unmute label in the webview menu.
   */
  isAudioEnabled(): boolean {
    return this.config.audio?.enabled === true;
  }

  /**
   * Flip the master audio switch. Preserves all other audio.* fields via
   * read-merge-write. Returns the new enabled value for toast text.
   */
  setAudioEnabled(enabled: boolean): boolean {
    const existing = (this.config.audio ?? {}) as AudioConfigRaw;
    this.config.audio = { ...existing, enabled };
    this._audioConfigCache = undefined;
    this.scheduleSave();
    return enabled;
  }

  /**
   * Get the command to run in an auto-started terminal.
   * Per-terminal `command` overrides the global `claudeCommand`.
   * Null/empty means don't run anything.
   */
  getAutoStartCommand(terminalName?: string): string | null {
    if (terminalName) {
      const override = this.config.terminals[terminalName]?.command;
      if (override !== undefined) {
        return override === null || override === '' ? null : override;
      }
    }
    const cmd = this.config.claudeCommand;
    if (cmd == null || cmd === '') return null;
    return cmd;
  }

  /** Get config for a terminal, or undefined if not in the file. */
  getTerminal(name: string): TerminalConfig | undefined {
    return this.config.terminals[name];
  }

  /** Get all terminal configs (shallow copy). */
  getAll(): Record<string, TerminalConfig> {
    return { ...this.config.terminals };
  }

  /** Remove all terminal entries from the config. Used by the wizard's "Start fresh" flow.
   * Writes synchronously to disk so the read-merge-write in save() doesn't resurrect old entries. */
  clearTerminals(): void {
    this.config.terminals = {};
    this.save();
  }

  /** Get terminals marked for auto-start. */
  getAutoStartTerminals(): string[] {
    return Object.entries(this.config.terminals)
      .filter(([, cfg]) => cfg.autoStart)
      .map(([name]) => name);
  }

  /**
   * Options for an auto-started terminal: env var, optional cwd, optional
   * shell override. Cross-platform — no shell-syntax quoting anywhere.
   */
  getAutoStartTerminalOptions(name: string): AutoStartTerminalOptions {
    const opts: AutoStartTerminalOptions = {
      env: { CLAUDELIKE_BAR_NAME: name },
    };
    const cfg = this.config.terminals[name];
    // cwd defaults to path when unset — most users set path via the wizard
    // and never touch cwd separately.
    const cwd = (cfg?.cwd && typeof cfg.cwd === 'string' && cfg.cwd.length > 0)
      ? cfg.cwd
      : (cfg?.path && typeof cfg.path === 'string' && cfg.path.length > 0)
        ? cfg.path
        : undefined;
    if (cwd) opts.cwd = cwd;
    if (cfg?.shellPath && typeof cfg.shellPath === 'string' && cfg.shellPath.length > 0) {
      opts.shellPath = cfg.shellPath;
      if (Array.isArray(cfg.shellArgs) && cfg.shellArgs.length > 0) {
        const cleaned = cfg.shellArgs.filter((a): a is string => typeof a === 'string');
        if (cleaned.length > 0) opts.shellArgs = cleaned;
      }
    }
    return opts;
  }

  /**
   * Ensure a terminal has an entry in the config file.
   * If it already exists, does nothing. If new, appends with defaults and writes.
   */
  ensureEntry(name: string): void {
    if (this.config.terminals[name]) return;

    this.config.terminals[name] = {
      color: getDefaultColor(name),
      icon: ICON_MAP[name] ?? null,
      nickname: null,
      autoStart: false,
    };

    this.scheduleSave();
  }

  /**
   * Add a fully-specified project entry. Used by "Register Project" and the
   * setup wizard — unlike `ensureEntry` (which auto-populates from terminal
   * names), this accepts all fields including `path` and `cwd`.
   * Returns false (no-op) if the slug already exists and `overwrite` is not
   * set. Callers should check the return value or validate beforehand.
   */
  addProjectEntry(slug: string, entry: TerminalConfig, overwrite = false): boolean {
    if (this.config.terminals[slug] && !overwrite) return false;
    this.config.terminals[slug] = entry;
    this.scheduleSave();
    return true;
  }

  /** Update the color for a terminal in the config file. */
  setColor(name: string, color: string | undefined): void {
    const entry = this.config.terminals[name];
    if (!entry) return;
    entry.color = color ?? getDefaultColor(name);
    this.scheduleSave();
  }

  /**
   * v0.13.4 (#4) — flip the `pinned` flag on a terminal entry. Pinned tiles
   * stay in a fixed-position zone at the bottom of the bar regardless of
   * `sortMode` (the tracker handles the splitting; ConfigManager just
   * persists the flag).
   */
  setPinned(name: string, pinned: boolean): void {
    const entry = this.config.terminals[name];
    if (!entry) return;
    if (pinned) entry.pinned = true;
    else delete entry.pinned;
    this.scheduleSave();
  }

  /**
   * Assign sequential `order` values to terminals by name. Names not in the
   * list are left with whatever order they already had. Used by drag-and-drop
   * reordering in the webview.
   */
  setOrder(orderedNames: string[]): void {
    orderedNames.forEach((name, index) => {
      const entry = this.config.terminals[name];
      if (entry) entry.order = index;
    });
    this.scheduleSave();
  }

  /**
   * Atomic drag-reorder: clear stale `order` values on every terminal entry,
   * assign sequential orders to the provided names, and flip `sortMode` to
   * `"manual"`. Called by the tracker when the user drags a tile. Keeps the
   * "dragging implies manual sort" policy in one place.
   */
  applyDragOrder(orderedNames: string[]): void {
    if (orderedNames.length === 0) return;
    // Wipe all orders first — avoids collisions with entries for terminals
    // that aren't currently open but still have a stale `order` field.
    for (const cfg of Object.values(this.config.terminals)) {
      delete cfg.order;
    }
    orderedNames.forEach((name, index) => {
      const entry = this.config.terminals[name];
      if (entry) entry.order = index;
    });
    this.config.sortMode = 'manual';
    this.scheduleSave();
  }

  /** True if any terminal has an explicit `order` set. */
  hasExplicitOrder(): boolean {
    for (const cfg of Object.values(this.config.terminals)) {
      if (typeof cfg.order === 'number') return true;
    }
    return false;
  }

  /** Resolve the sort mode. Defaults to 'auto' when unset. */
  getSortMode(): SortMode {
    return this.config.sortMode === 'manual' ? 'manual' : 'auto';
  }

  /** Force the sort mode (used when the user drags a tile). */
  setSortMode(mode: SortMode): void {
    if (this.config.sortMode === mode) return;
    this.config.sortMode = mode;
    this.scheduleSave();
  }

  /**
   * v0.13.4 (#15) — should the bar render dim "registered" tiles for
   * config entries that aren't currently running? Defaults to true.
   * Set false in the config to revert to the "running terminals only"
   * behavior of prior versions.
   */
  getShowRegisteredProjects(): boolean {
    return this.config.showRegisteredProjects !== false;
  }

  private scheduleSave(): void {
    // Debounce writes so rapid terminal opens don't thrash the file
    if (this.writeDebounce) clearTimeout(this.writeDebounce);
    this.writeDebounce = setTimeout(() => this.save(), 200);
  }

  private save(): void {
    // Clear any pending debounce — if save() is called explicitly (e.g.,
    // during migration) while a debounced write is pending, the debounce
    // would fire 200ms later and produce a redundant write.
    if (this.writeDebounce) {
      clearTimeout(this.writeDebounce);
      this.writeDebounce = undefined;
    }
    // Read-merge-write: re-read the file from disk before writing so that
    // concurrent changes from another VS Code window (e.g., ensureEntry
    // from a different workspace) aren't lost. Merge our in-memory terminal
    // entries over the disk state — our changes win on conflict, but
    // terminals we don't know about are preserved.
    // NOTE: only terminal entries are merged. Top-level scalar keys (mode,
    // sortMode, labels, etc.) use last-writer-wins — the race window is
    // narrow (between another window's write and our watcher reload) and
    // scalar config changes are rare enough that full merge isn't justified.
    try {
      if (fs.existsSync(this.configPath)) {
        const diskContent = fs.readFileSync(this.configPath, 'utf-8');
        const diskConfig = parseJsonc(diskContent);
        if (diskConfig && typeof diskConfig.terminals === 'object') {
          // Merge: disk terminals we don't have get added to ours.
          for (const [key, val] of Object.entries(diskConfig.terminals)) {
            if (!this.config.terminals[key]) {
              this.config.terminals[key] = val as TerminalConfig;
            }
          }
        }
      }
    } catch {
      // Disk read failed — proceed with in-memory state only.
    }

    const output = this.generateConfigText();

    this.isSaving = true;
    if (this.isSavingTimer) clearTimeout(this.isSavingTimer);
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, output, 'utf-8');
      this.hasShownWriteError = false;
      this.writePathIndex();
    } catch (err) {
      console.error('claudelike-bar: failed to write config', err);
      if (!this.hasShownWriteError) {
        this.hasShownWriteError = true;
        vscode.window.showErrorMessage(`Claudelike Bar: failed to save config — ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      this.isSavingTimer = setTimeout(() => { this.isSaving = false; this.isSavingTimer = undefined; }, 100);
    }
  }

  /**
   * Build the full JSONC config string with section headers and inline comments.
   * Comments are regenerated on every save — they're part of the format, not user content.
   */
  private generateConfigText(): string {
    const mode = this.getMode();
    const sortMode = this.getSortMode();
    const claudeCommand = this.config.claudeCommand ?? null;
    const debug = this.config.debug === true;
    const labels = { ...DEFAULT_LABELS, ...this.config.labels };
    const thresholds = this.getContextThresholds();
    const ignoredTexts = this.getIgnoredTexts();
    // Serialize the raw audio object (preserves unknown keys users may have
    // added). Fill the canonical fields with sensible defaults when absent so
    // the written block has a useful shape on first save.
    const rawAudio = (this.config.audio ?? {}) as AudioConfigRaw;
    // v0.14 — serialize with new slot names only. Legacy `ready`/`permission`
    // are read back but never written — this migrates configs in place on
    // first save. New-name wins if both are present in the raw config.
    const rawSounds = (rawAudio.sounds ?? {}) as Record<string, unknown>;
    // If the user has never touched `audio.sounds` at all (fresh config,
    // never-configured audio), seed `turnDone` with the bundled default so
    // a new user hears something on first enable. `Object.keys(rawSounds)`
    // is 0 for both undefined and `{}`. Users who explicitly set `turnDone:
    // null` keep their explicit null — `rawSounds` has a key in that case.
    const freshAudioBlock = Object.keys(rawSounds).length === 0;
    const turnDoneSerialized = freshAudioBlock
      ? DEFAULT_TURN_DONE_SOUND
      : ((rawSounds.turnDone as string | null | undefined)
          ?? (rawSounds.ready as string | null | undefined) ?? null);
    const audio: AudioConfigRaw = {
      enabled: rawAudio.enabled === true,
      volume: typeof rawAudio.volume === 'number' ? rawAudio.volume : DEFAULT_AUDIO_VOLUME,
      debounceMs: typeof rawAudio.debounceMs === 'number' ? rawAudio.debounceMs : DEFAULT_AUDIO_DEBOUNCE_MS,
      sounds: {
        turnDone: turnDoneSerialized,
        midJobPrompt: (rawSounds.midJobPrompt as string | null | undefined)
          ?? (rawSounds.permission as string | null | undefined) ?? null,
        // Carry through any unknown slot keys (future states). Drop the
        // canonical + legacy keys so they don't round-trip as duplicates.
        ...Object.fromEntries(
          Object.entries(rawSounds).filter(
            ([k]) => !['ready', 'permission', 'turnDone', 'midJobPrompt'].includes(k),
          ),
        ),
      },
      // Carry through unknown top-level audio.* keys.
      ...Object.fromEntries(
        Object.entries(rawAudio).filter(
          ([k]) => k !== 'enabled' && k !== 'volume' && k !== 'debounceMs' && k !== 'sounds',
        ),
      ),
    };
    const terminals = this.config.terminals;

    const indent = (json: string, spaces: number): string =>
      json.replace(/\n/g, '\n' + ' '.repeat(spaces));

    const lines: string[] = [
      '// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      '//  CLAUDELIKE BAR CONFIGURATION',
      '// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      '//  Edit this file directly \u2014 changes are picked up live.',
      '//  Open from VS Code: click the \u2699 gear in the Claudelike Bar.',
      '{',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  BIG KNOBS                                      \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '',
      '  // Personality mode \u2014 how the bar reacts when you ignore a terminal:',
      '  //   "chill"              \u2014 terminals quietly fade to "Done"',
      '  //   "passive-aggressive" \u2014 guilt-trips you with snarky messages',
      `  "mode": ${JSON.stringify(mode)},`,
      '',
      '  // How tiles are ordered in the sidebar:',
      '  //   "auto"   — sort by status (waiting → ready → working → done → idle)',
      '  //   "manual" — respect the drag-and-drop order from `terminals[].order`.',
      '  // Dragging a tile automatically flips this to "manual".',
      `  "sortMode": ${JSON.stringify(sortMode)},`,
      '',
      '  // Command to send to auto-started terminals after they open.',
      '  // null / empty = just open the terminal, don\'t run anything.',
      '  // Example: "claude --dangerously-skip-permissions"',
      `  "claudeCommand": ${JSON.stringify(claudeCommand)},`,
      '',
      '  // Debug logging — when true, the extension logs to the "Claudelike Bar"',
      '  // output channel AND the hook script writes /tmp/claude-dashboard/debug.log.',
      '  // Use this to diagnose stuck tiles or missing status events.',
      `  "debug": ${JSON.stringify(debug)},`,
      '',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  FINE TUNING                                    \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '',
      '  // Status labels \u2014 customize the text shown for each terminal state.',
      '  // Keys: idle, working, ready, waiting, done, error, teammate_idle',
      `  "labels": ${indent(JSON.stringify(labels, null, 4), 2)},`,
      '',
      '  // Context window usage thresholds (percentage of Claude\'s context used).',
      '  //   warn \u2014 tile turns yellow     crit \u2014 tile turns red',
      `  "contextThresholds": ${indent(JSON.stringify(thresholds, null, 4), 2)},`,
      '',
      '  // Passive-aggressive mode messages. Shown when you glance at a waiting',
      '  // terminal and switch away without acting. Only used in "passive-aggressive" mode.',
      '  // Add, remove, or edit these \u2014 one is picked at random each time.',
      `  "ignoredTexts": ${indent(JSON.stringify(ignoredTexts, null, 4), 2)},`,
      '',
      '  // Audio alerts. Off by default. Drop sound files into',
      '  // ~/.claude/sounds/ and reference them by filename.',
      '  //   turnDone     — plays when Claude finishes a turn (Stop event)',
      '  //   midJobPrompt — plays when Claude blocks mid-job on a prompt',
      '  //                  (Notification). Falls back to turnDone if unset.',
      '  // Renamed in v0.14 from ready/permission — old names still read.',
      '  // Bundled defaults: `turn-done-default.mp3` (seeded here) and',
      '  // `can-crack.mp3` — filenames resolve from the extension if you',
      '  // haven\'t copied same-named files into ~/.claude/sounds/.',
      `  "audio": ${indent(JSON.stringify(audio, null, 4), 2)},`,
      '',
      '  // \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '  // \u2502  TERMINALS \u2014 per-project overrides              \u2502',
      '  // \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      '  // New terminals are auto-added here when first opened.',
      '  //',
      '  // color:     cyan | green | blue | magenta | yellow | white | red | any CSS color (#hex, rgb(), hsl())',
      '  // icon:      any VS Code codicon (calendar, server, notebook, lock, etc.)',
      '  // nickname:  display name override (null = use terminal name)',
      '  // autoStart: true = open this terminal when VS Code starts',
      '  // path:      absolute path to the project directory (canonical identity)',
      '  //            also used as the default cwd when cwd is unset',
      '  // cwd:       working directory override (defaults to path if unset)',
      '  // command:   override the global claudeCommand for this terminal (omit to inherit)',
      '  // projectName: hook project name that maps to this terminal — set this',
      '  //            when the terminal display name differs from the hook cwd',
      '  //            (e.g. "VS Code Enhancement" terminal, project "vscode-enhancement")',
      '  // shellPath: absolute path to a shell executable. Pin a specific shell for',
      '  //            this terminal regardless of VS Code\'s default. Useful on',
      '  //            Windows to force git-bash so `command` (cd && claude) works:',
      '  //              "shellPath": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"',
      '  // shellArgs: optional array of args passed to shellPath (e.g. ["-NoProfile"]).',
      `  "terminals": ${indent(JSON.stringify(terminals, null, 4), 2)}`,
      '}',
      '',
    ];

    return lines.join('\n');
  }

  /**
   * Write a lightweight path → slug index that the hook reads to resolve
   * manual terminals (those without CLAUDELIKE_BAR_NAME env var).
   */
  private writePathIndex(): void {
    const index: Record<string, string> = {};
    for (const [slug, cfg] of Object.entries(this.config.terminals)) {
      if (cfg.path && typeof cfg.path === 'string') {
        const normalized = cfg.path.replace(/[/\\]+$/, '') || cfg.path;
        index[normalized] = slug;
      }
    }
    const dest = pathIndexPath();
    const tmp = `${dest}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(index) + '\n');
      fs.renameSync(tmp, dest);
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  dispose(): void {
    if (this.writeDebounce) {
      clearTimeout(this.writeDebounce);
      this.save(); // flush pending writes
    }
    if (this.isSavingTimer) {
      clearTimeout(this.isSavingTimer);
      this.isSavingTimer = undefined;
    }
    for (const d of this.disposables) d.dispose();
  }
}
