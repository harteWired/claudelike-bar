import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StatusFileData } from './types';
import { getStatusDir } from './statusDir';
import { pathIndexPath } from './claudePaths';

const STATUS_DIR = getStatusDir();

// Status-File Contract v1 item C — activation-time GC. STRICT (the hook) stops
// NEW junk from being minted, but the status dir can still hold orphans from
// before the cutover, or `<slug>.json` for terminals that are long gone. A file
// is junk when its slug is not in the shared allowlist (the path index every
// hook reads) AND it hasn't been touched in GC_STALE_MS. The mtime guard is the
// safety net: an active terminal — even one tracked only by CLAUDELIKE_BAR_NAME,
// with no path-index entry — refreshes its file on every hook event, so it's
// never stale and never reaped. Registered slugs are kept regardless of age.
const GC_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Sweep orphaned status files from `statusDir`. Pure (no vscode), so it's unit-
 * testable against a temp dir. Deletes, for entries older than `staleMs`:
 *   - `<slug>.json` whose slug is NOT in `allowlist`
 *   - `*.tmp.<pid>` atomic-write orphans (left behind by a crashed writer)
 * Keeps allowlisted slugs at any age, all fresh files, and any non-JSON file
 * that isn't a tmp orphan (`.debug`, `debug.log` — not ours to reap). Returns
 * the names it removed. Best-effort: per-file IO errors are swallowed.
 */
export function sweepOrphanStatusFiles(
  statusDir: string,
  allowlist: Set<string>,
  now: number = Date.now(),
  staleMs: number = GC_STALE_MS,
): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(statusDir);
  } catch {
    return []; // dir doesn't exist yet — nothing to sweep
  }
  const reaped: string[] = [];
  for (const name of names) {
    const full = path.join(statusDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // vanished mid-sweep, or not a stat-able entry
    }
    if (now - mtimeMs < staleMs) continue; // fresh — an active writer owns it

    const isTmpOrphan = /\.tmp\.\d+$/.test(name);
    if (isTmpOrphan) {
      if (tryUnlink(full)) reaped.push(name);
      continue;
    }
    if (!name.endsWith('.json')) continue; // .debug / debug.log — out of scope
    const slug = name.slice(0, -'.json'.length);
    if (allowlist.has(slug)) continue; // registered — keep regardless of age
    if (tryUnlink(full)) reaped.push(name);
  }
  return reaped;
}

function tryUnlink(full: string): boolean {
  try {
    fs.unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the shared allowlist — the slug values of the path index that every hook
 * reads for ancestor-walk resolution. These are the registered / path-bearing /
 * autoStart terminals; their status files must never be reaped. Returns null
 * (caller skips GC) when the index is missing or unreadable, so a transient read
 * failure can never be mistaken for "nothing is registered" and over-reap.
 */
export function readStatusAllowlist(): Set<string> | null {
  try {
    const index = JSON.parse(fs.readFileSync(pathIndexPath(), 'utf-8'));
    if (typeof index !== 'object' || index === null) return null;
    return new Set(
      Object.values(index).filter((v): v is string => typeof v === 'string'),
    );
  } catch {
    return null;
  }
}

export class StatusWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private onStatusChangeEmitter = new vscode.EventEmitter<StatusFileData>();
  readonly onStatusChange = this.onStatusChangeEmitter.event;

  constructor() {
    this.ensureDir();

    // Item C: sweep orphaned status files before reading the dir, so junk from
    // pre-STRICT writers and dead terminals doesn't linger. Skipped entirely if
    // the allowlist can't be read (fail safe — never over-reap).
    this.collectGarbage();

    this.setupWatcher();

    // Read any existing status files on startup
    this.readAllExisting();

    this.disposables.push(this.onStatusChangeEmitter);
  }

  private collectGarbage(): void {
    try {
      const allowlist = readStatusAllowlist();
      if (!allowlist) return; // no readable allowlist — skip rather than reap
      sweepOrphanStatusFiles(STATUS_DIR, allowlist);
    } catch {
      // GC is best-effort hardening — it must never break activation.
    }
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  private setupWatcher(): void {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(STATUS_DIR), '*.json');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidCreate((uri) => this.handleFileChange(uri));
    this.watcher.onDidChange((uri) => this.handleFileChange(uri));

    this.disposables.push(this.watcher);
  }

  private handleFileChange(uri: vscode.Uri): void {
    try {
      const content = fs.readFileSync(uri.fsPath, 'utf-8');
      const data: StatusFileData = JSON.parse(content);

      // Validate expected shape
      if (!data.project || !data.timestamp) return;
      // Statusline writes may only have context_percent, no status
      if (!data.status && data.context_percent === undefined) return;

      this.onStatusChangeEmitter.fire(data);
    } catch {
      // Ignore malformed files
    }
  }

  private readAllExisting(): void {
    try {
      const files = fs.readdirSync(STATUS_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const uri = vscode.Uri.file(path.join(STATUS_DIR, file));
        this.handleFileChange(uri);
      }
    } catch {
      // Directory may not exist yet
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
