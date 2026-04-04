export type SessionStatus = 'idle' | 'working' | 'waiting' | 'done';

export interface TileData {
  name: string;
  status: SessionStatus;
  lastActivity: number; // unix timestamp
  event?: string;
  isActive: boolean;
  themeColor: string;
}

export interface StatusFileData {
  project: string;
  status: SessionStatus;
  timestamp: number;
  event: string;
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

export const THEME_COLORS: Record<ThemeGroup, string> = {
  cyan: '#4ec9b0',
  green: '#6a9955',
  blue: '#569cd6',
  magenta: '#c586c0',
  yellow: '#dcdcaa',
  white: '#d4d4d4',
};

export function getThemeColor(projectName: string): string {
  const group = THEME_MAP[projectName];
  return THEME_COLORS[group ?? 'white'];
}
