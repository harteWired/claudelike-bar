import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the status directory path (Status-File Contract v1 §A). This MUST stay
 * byte-identical in behavior with the hook script's `resolveStatusDir` and
 * belfry-hook's resolver — the watcher/GC (this side) and every writer have to
 * agree on one dir, or status files written by one are invisible to the other.
 *
 * Priority:
 *   1. $CLAUDELIKE_STATUS_DIR (canonical override)
 *   2. $CLAUDE_DASHBOARD_DIR (deprecated transition alias)
 *   3. POSIX: the FIXED literal `/tmp/claude-dashboard`; win32: os.tmpdir()/claude-dashboard
 *
 * The POSIX default is a literal, NOT os.tmpdir(): Claude Code sets
 * TMPDIR=/tmp/claude-<uid> per process, so an os.tmpdir() default diverges
 * between writers and readers — that split is exactly the bug this contract fixes.
 */
export function getStatusDir(): string {
  const explicit = (process.env.CLAUDELIKE_STATUS_DIR || '').trim()
    || (process.env.CLAUDE_DASHBOARD_DIR || '').trim();
  if (explicit) {
    return explicit;
  }
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claude-dashboard')
    : '/tmp/claude-dashboard';
}
