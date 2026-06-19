/**
 * Broadcast fan-out core (#68). Pure — no vscode — so it's unit-testable.
 *
 * `claudeDashboard.broadcast` sends a prompt to every tracked terminal. Doing
 * that in a tight synchronous loop submits every Claude session's turn in the
 * same instant, which trips the API rate limit (429). This helper spaces the
 * sends out by `staggerMs` so the submissions spread over (N-1)×stagger ms.
 */

export interface BroadcastTarget {
  /** Tile display name — for the tally and progress messages. */
  name: string;
  /** Tile status at send time — for the per-state breakdown. */
  status: string;
  /** Performs the actual send (e.g. `terminal.sendText(text, true)`). */
  send: () => void;
}

export interface BroadcastResult {
  /** Count of sends per tile status (`{ ready: 3, working: 1 }`). */
  tally: Record<string, number>;
  /** Names that were sent to successfully. */
  hitNames: string[];
  /** `"<name>: <error>"` for each send that threw. */
  failures: string[];
}

export interface BroadcastDeps {
  /** Awaitable delay — injected so tests don't wait real time. */
  sleep: (ms: number) => Promise<void>;
  /** Optional progress callback, fired once per target after its send. */
  onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * Send to each target in order, waiting `staggerMs` between sends (not before
 * the first, not after the last). A send that throws is recorded in `failures`
 * and does NOT abort the batch. `staggerMs <= 0` sends them all without waiting.
 */
export async function broadcastStaggered(
  targets: BroadcastTarget[],
  staggerMs: number,
  deps: BroadcastDeps,
): Promise<BroadcastResult> {
  const tally: Record<string, number> = {};
  const hitNames: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // Delay BETWEEN sends only — first goes immediately, so N sends span
    // (N-1)×staggerMs rather than N×.
    if (i > 0 && staggerMs > 0) {
      await deps.sleep(staggerMs);
    }
    try {
      t.send();
      tally[t.status] = (tally[t.status] ?? 0) + 1;
      hitNames.push(t.name);
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    deps.onProgress?.(i + 1, targets.length, t.name);
  }

  return { tally, hitNames, failures };
}
