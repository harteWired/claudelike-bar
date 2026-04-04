import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StatusFileData, SessionStatus } from './types';

const STATUS_DIR = '/tmp/claude-dashboard';

export class StatusWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private onStatusChangeEmitter = new vscode.EventEmitter<StatusFileData>();
  readonly onStatusChange = this.onStatusChangeEmitter.event;
  private doneTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.ensureDir();
    this.setupWatcher();

    // Read any existing status files on startup
    this.readAllExisting();

    this.disposables.push(this.onStatusChangeEmitter);
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
      if (!data.project || !data.status || !data.timestamp) return;

      // Clear any existing done->idle timer for this project
      const existingTimer = this.doneTimers.get(data.project);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.doneTimers.delete(data.project);
      }

      // If done, set a 30s timer to fade to idle
      if (data.status === 'done') {
        const timer = setTimeout(() => {
          this.doneTimers.delete(data.project);
          this.onStatusChangeEmitter.fire({
            project: data.project,
            status: 'idle' as SessionStatus,
            timestamp: Math.floor(Date.now() / 1000),
            event: 'fade',
          });
        }, 30_000);
        this.doneTimers.set(data.project, timer);
      }

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
    for (const timer of this.doneTimers.values()) {
      clearTimeout(timer);
    }
    this.doneTimers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
