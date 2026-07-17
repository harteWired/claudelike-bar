import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getStatusDir } from './statusDir';

/**
 * Hang watchdog (#333/#334). Recovers always-on belfry sessions that stall on a
 * human-required interaction while unattended — the failure mode that left
 * life-planner (blocked on AskUserQuestion) and wintermute (deaf-idle) dead for
 * ~3 days on 2026-07-14.
 *
 * Layer A (--disallowedTools AskUserQuestion ExitPlanMode on the launch command)
 * removes the commonest blocking modal; this module is the safety net for
 * everything else: TUI stalls, unanswered permission prompts under C2, and
 * crashed sessions.
 *
 * Coupling is deliberately thin — it reads the Status-File Contract dir, the
 * belfry daemon delivery log, and per-session transcripts, and acts through the
 * public VS Code terminal API. It does NOT reach into TerminalTracker internals.
 *
 * NOTE: recovery is gated behind `hangWatchdog.enabled` (default false) so this
 * ships dark; it is turned on per the canary plan in
 * docs/proposals/unattended-hang-fix.md, only after the gate approves.
 */

interface WatchdogConfig {
  enabled: boolean;
  timeoutMs: number;
  pollMs: number;
  belfryLogPath: string;
  claudeCommand: string;
}

interface SessionState {
  /** slug === project dir name (belfry session identity). */
  slug: string;
  /** ms since epoch of the last assistant turn in the transcript, or 0. */
  lastAssistantTurnMs: number;
  /** ms since epoch of the last belfry inbound delivered to this slug, or 0. */
  lastDeliveryMs: number;
  /** status file signal ('ready' | 'working' | 'waiting_input' | ...) or ''. */
  status: string;
  /** waiting_since from the enhanced Notification hook, or 0. */
  waitingSinceMs: number;
}

const DEFAULTS = {
  timeoutMinutes: 5,
  pollSeconds: 30,
};

export class HangWatchdog implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  /** slugs we've already pinged Matt about, to avoid ping spam per stall. */
  private pinged = new Set<string>();
  /** slugs currently mid-recovery, so we don't stack recovery attempts. */
  private recovering = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    const cfg = this.readConfig();
    // Poll even when disabled so the dashboard can surface "would-recover"
    // diagnostics during the canary; recovery actions are gated on cfg.enabled.
    this.timer = setInterval(() => this.tick().catch(() => { /* never throw from the loop */ }), cfg.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  // ── main loop ────────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    if (this.disposed) return;
    const cfg = this.readConfig();
    const now = Date.now();

    for (const terminal of vscode.window.terminals) {
      const slug = this.slugForTerminal(terminal);
      if (!slug || !this.isBelfrySession(terminal)) continue;

      // (3) crashed/exited: the shell is still open but claude has exited.
      // exitStatus is only set once the terminal itself closes; a claude that
      // exited to a bare zsh is caught by the transcript-staleness path below.
      const state = this.readState(slug);
      const wedged = this.isWedged(state, now, cfg.timeoutMs);

      if (!wedged) {
        this.pinged.delete(slug);
        continue;
      }

      // First detection: ping Matt so he can answer in person before we act.
      if (!this.pinged.has(slug)) {
        this.pinged.add(slug);
        this.pingHuman(slug, state);
        continue; // give the human one poll cycle's grace before recovering
      }

      if (cfg.enabled && !this.recovering.has(slug)) {
        this.recovering.add(slug);
        this.recover(terminal, slug, cfg).finally(() => this.recovering.delete(slug));
      }
    }
  }

  /** Wedged = attention-required (or deaf to a delivery) with no progress for > timeout. */
  private isWedged(s: SessionState, now: number, timeoutMs: number): boolean {
    // Signal 1: enhanced Notification hook says the session is waiting for input.
    if (s.status === 'waiting_input' && s.waitingSinceMs > 0 && now - s.waitingSinceMs > timeoutMs) {
      return true;
    }
    // Signal 2: a belfry message was delivered but no assistant turn followed
    // (the deaf-idle signature — wintermute's case; no Notification fires).
    if (s.lastDeliveryMs > 0 &&
        s.lastDeliveryMs - s.lastAssistantTurnMs > 0 &&
        now - s.lastDeliveryMs > timeoutMs) {
      return true;
    }
    return false;
  }

  // ── recovery ladder ──────────────────────────────────────────────────────
  private async recover(terminal: vscode.Terminal, slug: string, cfg: WatchdogConfig): Promise<void> {
    // Rung 1: Esc clears a modal (AskUserQuestion / plan / trust) without losing the session.
    terminal.sendText('\x1b', false);
    await delay(30_000);
    if (!this.isWedged(this.readState(slug), Date.now(), cfg.timeoutMs)) return;

    // Rung 2: interrupt whatever is stuck, then resume the same session.
    terminal.sendText('\x03', false); // Ctrl-C
    await delay(2_000);
    terminal.sendText(cfg.claudeCommand, true); // ends in "\n/resume"
  }

  private pingHuman(slug: string, s: SessionState): void {
    const why = s.status === 'waiting_input' ? 'is waiting for input' : 'went deaf after a delivery';
    // Non-blocking notify: surface in VS Code and let the belfry/Pushover hook
    // (Notification pipeline) carry it to Matt's phone. We deliberately do not
    // block on delivery here.
    vscode.window.showWarningMessage(`Session "${slug}" ${why} — will auto-recover if unanswered.`);
    try {
      const dir = getStatusDir();
      fs.writeFileSync(
        path.join(dir, `${slug}.attention.json`),
        JSON.stringify({ slug, why, ts: Date.now() }),
        { mode: 0o600 },
      );
    } catch { /* best-effort */ }
  }

  // ── reads (all defensive) ─────────────────────────────────────────────────
  private readState(slug: string): SessionState {
    return {
      slug,
      status: this.readStatus(slug).status,
      waitingSinceMs: this.readStatus(slug).waitingSince,
      lastAssistantTurnMs: this.lastAssistantTurnMs(slug),
      lastDeliveryMs: this.lastDeliveryMs(slug),
    };
  }

  private readStatus(slug: string): { status: string; waitingSince: number } {
    try {
      const p = path.join(getStatusDir(), `${slug}.json`);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { status: String(j.status ?? ''), waitingSince: Number(j.waiting_since ?? 0) };
    } catch {
      return { status: '', waitingSince: 0 };
    }
  }

  /** Newest transcript for the slug; timestamp of its last assistant entry. */
  private lastAssistantTurnMs(slug: string): number {
    try {
      const dir = path.join(os.homedir(), '.claude', 'projects', `-workspace-projects-${slug}`);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (!files.length) return 0;
      const lines = fs.readFileSync(path.join(dir, files[0].f), 'utf8').trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let e: any;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e?.type === 'assistant' && e?.timestamp) return Date.parse(e.timestamp) || 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /** Last "→<slug> delivered" line in the belfry daemon log. */
  private lastDeliveryMs(slug: string): number {
    try {
      const cfg = this.readConfig();
      // tail the log cheaply: read the last 256 KB only.
      const fd = fs.openSync(cfg.belfryLogPath, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const needle = `→${slug} delivered`; // "→<slug> delivered"
      const text = buf.toString('utf8');
      const idx = text.lastIndexOf(needle);
      if (idx < 0) return 0;
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const tsMatch = text.slice(lineStart, idx).match(/2026-\d\d-\d\dT[\d:.]+Z/);
      return tsMatch ? (Date.parse(tsMatch[0]) || 0) : 0;
    } catch {
      return 0;
    }
  }

  // ── identity + config ─────────────────────────────────────────────────────
  private slugForTerminal(t: vscode.Terminal): string | null {
    // Terminal names are the project/slug; normalize to the project dir form.
    // TODO(before merge): replace with ./slug.slugify for byte-parity with the
    // hook/belfry slug resolver.
    const name = (t.name || '').trim().toLowerCase();
    return name ? name.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') : null;
  }

  private isBelfrySession(t: vscode.Terminal): boolean {
    // A belfry session's transcript project dir exists AND belfry delivers to it.
    const slug = this.slugForTerminal(t);
    if (!slug) return false;
    return fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-projects-${slug}`));
  }

  private readConfig(): WatchdogConfig {
    const c = vscode.workspace.getConfiguration('claudelikeBar.hangWatchdog');
    const minutes = Number(c.get('timeoutMinutes', DEFAULTS.timeoutMinutes));
    const secs = Number(c.get('pollSeconds', DEFAULTS.pollSeconds));
    let claudeCommand = '';
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'claudelike-bar.jsonc'), 'utf8');
      const m = raw.match(/"claudeCommand"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) claudeCommand = JSON.parse(`"${m[1]}"`);
    } catch { /* leave blank — relaunch rung is skipped if empty */ }
    return {
      enabled: Boolean(c.get('enabled', false)),
      timeoutMs: Math.max(60_000, minutes * 60_000),
      pollMs: Math.max(10_000, secs * 1_000),
      belfryLogPath: process.env.BELFRY_LOG_PATH || '/workspace/.belfry/belfry.log',
      claudeCommand,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
