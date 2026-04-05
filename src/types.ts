export type SessionStatus = 'idle' | 'working' | 'waiting' | 'done' | 'ignored';

export interface TileData {
  id: number; // stable numeric identity ��� used as DOM key and in webview messages
  name: string;
  displayName: string; // nickname from config, or same as name
  status: SessionStatus;
  lastActivity: number; // unix timestamp
  event?: string;
  isActive: boolean;
  themeColor: string; // CSS variable name for the ANSI color
  contextPercent?: number;
  ignoredText?: string;
}

export type WebviewMessage =
  | { type: 'switchTerminal'; id: number }
  | { type: 'cloneTerminal'; id: number }
  | { type: 'killTerminal'; id: number }
  | { type: 'setColor'; id: number; color: string | null };

export interface StatusFileData {
  project: string;
  status: SessionStatus;
  timestamp: number;
  event: string;
  context_percent?: number;
}

export type ThemeGroup = 'cyan' | 'green' | 'blue' | 'magenta' | 'yellow' | 'white';

export const THEME_MAP: Record<string, ThemeGroup> = {
  // Life & finance → cyan
  'life-planner': 'cyan',
  'financial-planner': 'cyan',
  'travel-planner': 'cyan',
  'health-dash': 'cyan',
  'mortgage-viz': 'cyan',
  // Home & IoT → green
  'ha-tools': 'green',
  'automated-martha-tek': 'green',
  'garden-assist': 'green',
  '3d-printing': 'green',
  // Knowledge & research → blue
  'obsidian-vault': 'blue',
  'git-publishing': 'blue',
  'research-workflows': 'blue',
  'prompt-master': 'blue',
  'media-recs': 'blue',
  // Web & design → magenta
  'web-design-pipeline': 'magenta',
  'web-hosting': 'magenta',
  'web-auto': 'magenta',
  'strudel-noodle': 'magenta',
  // Dev infrastructure → yellow
  'api': 'yellow',
  'secrets-manager': 'yellow',
  'container-backup': 'yellow',
  'scripts': 'yellow',
  'vscode-enhancement': 'yellow',
  // Root → white
  'workspace': 'white',
};

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
