export type SessionStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'done' | 'ignored' | 'error' | 'offline';

/**
 * Raw status signals written by the hook script (not internal tile states).
 * The extension's state machine maps these to `SessionStatus`.
 *
 * - `working` | `ready` | `error` — direct state signals
 * - `subagent_start` | `subagent_stop` — counter updates, no state change
 * - `teammate_idle` — flag update, no state change
 * - `session_start` | `session_end` — lifecycle signals (v0.9.1)
 * - `tool_failure` — transient flag (v0.9.1)
 * - `compact_start` | `compact_end` — label override (v0.9.1)
 * - `tool_end` — PostToolUse: tool just completed; promotes stuck-ready back
 *   to working so permission-approved tool runs aren't stuck on "Needs
 *   permission" until Stop (v0.9.3)
 */
export type HookStatusSignal =
  | 'working'
  | 'ready'
  | 'error'
  | 'subagent_start'
  | 'subagent_stop'
  | 'teammate_idle'
  | 'session_start'
  | 'session_end'
  | 'tool_failure'
  | 'compact_start'
  | 'compact_end'
  | 'tool_end';

export interface TileData {
  id: number; // stable numeric identity — used as DOM key and in webview messages
  name: string;
  displayName: string; // nickname from config, or same as name
  status: SessionStatus;
  statusLabel: string; // resolved display text from config labels
  lastActivity: number; // unix timestamp
  event?: string;
  isActive: boolean;
  themeColor: string; // CSS variable name for the ANSI color
  icon: string | null; // codicon name (e.g. "calendar", "server")
  contextPercent?: number;
  contextWarn: number; // threshold for yellow
  contextCrit: number; // threshold for red
  ignoredText?: string;
  // v0.9 — multi-agent state tracking
  pendingSubagents?: number;  // count of in-flight Task-tool subagents
  teammateIdle?: boolean;     // Agent Teams teammate waiting for peer
  errorType?: string;         // e.g. "rate_limit", "authentication_failed"
  // v0.9.1 — transient flags (don't affect SessionStatus directly)
  toolError?: boolean;        // PostToolUseFailure fired; cleared on next Stop
  compacting?: boolean;       // PreCompact received, no matching PostCompact yet
  // v0.9.3 — subagent permission prompt is pending on at least one in-flight
  // subagent. Set when a permission_prompt Notification fires with
  // pendingSubagents > 0. Cleared only when pendingSubagents drops to 0 or
  // on UserPromptSubmit/Stop — we don't have per-subagent permission
  // tracking, so we wait until all subagents have finished (conservative).
  subagentPermissionPending?: boolean;
}

export type WebviewMessage =
  | { type: 'switchTerminal'; id: number }
  | { type: 'cloneTerminal'; id: number }
  | { type: 'killTerminal'; id: number }
  | { type: 'markDone'; id: number }
  | { type: 'reorderTiles'; orderedIds: number[] }
  | { type: 'setColor'; id: number; color: string | null }
  | { type: 'addProject' };

export interface StatusFileData {
  project: string;
  status: HookStatusSignal | SessionStatus;
  timestamp: number;
  event: string;
  context_percent?: number;
  // v0.9 — additional hook payload fields, optional
  tool_name?: string;          // PreToolUse/PostToolUse
  agent_type?: string;         // SubagentStart/SubagentStop
  error_type?: string;         // StopFailure matchers
  notification_type?: string;  // Notification matchers
  // v0.9.1 — session / compaction metadata
  source?: string;             // SessionStart matcher (startup/resume/clear/compact)
  reason?: string;             // SessionEnd matcher (logout/prompt_input_exit/...)
  compaction_trigger?: string; // PreCompact/PostCompact matcher (manual/auto)
}

export type ThemeGroup = 'cyan' | 'green' | 'blue' | 'magenta' | 'yellow' | 'white';

// Fallback color hints for common project-name patterns.
// The config file (.claudelike-bar.jsonc) overrides these — once a terminal
// appears in the config its color is read from there, not this map.
// Add entries here only for names likely to appear across many workspaces.
export const THEME_MAP: Record<string, ThemeGroup> = {};

// Use VS Code's terminal ANSI CSS variables so colors match terminal tab indicators exactly
export const THEME_CSS_VARS: Record<ThemeGroup, string> = {
  cyan: 'var(--vscode-terminal-ansiCyan)',
  green: 'var(--vscode-terminal-ansiGreen)',
  blue: 'var(--vscode-terminal-ansiBrightBlue)',
  magenta: 'var(--vscode-terminal-ansiMagenta)',
  yellow: 'var(--vscode-terminal-ansiYellow)',
  white: 'var(--vscode-terminal-ansiBrightWhite)',
};

export const COLOR_OVERRIDE_CSS: Record<string, string> = {
  ...THEME_CSS_VARS,
  red: 'var(--vscode-terminal-ansiRed)',
};

export function getDefaultColor(projectName: string): ThemeGroup {
  return THEME_MAP[projectName] ?? 'white';
}

export function getThemeColor(projectName: string, override?: string): string {
  if (override && COLOR_OVERRIDE_CSS[override]) {
    return COLOR_OVERRIDE_CSS[override];
  }
  return THEME_CSS_VARS[getDefaultColor(projectName)];
}

// Fallback icon hints for common project-name patterns.
// Same as THEME_MAP — the config file takes precedence once it exists.
export const ICON_MAP: Record<string, string> = {};
