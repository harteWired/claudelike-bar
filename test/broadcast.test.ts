import { describe, it, expect, vi } from 'vitest';
import { broadcastStaggered, BroadcastTarget } from '../src/broadcast';

// #68 — broadcast fan-out core: stagger sends so all sessions don't submit at
// once. These cover the spacing, the instant path, failure isolation, progress
// callbacks, and the empty case.
describe('broadcastStaggered', () => {
  // A fake sleep that records each delay and resolves immediately (no real wait).
  function fakeSleep() {
    const calls: number[] = [];
    return { sleep: async (ms: number) => { calls.push(ms); }, calls };
  }

  function target(name: string, status: string, sent: string[], throws = false): BroadcastTarget {
    return {
      name,
      status,
      send: () => {
        if (throws) throw new Error('disposed');
        sent.push(name);
      },
    };
  }

  it('sends to every target and tallies by status', async () => {
    const sent: string[] = [];
    const { sleep } = fakeSleep();
    const targets = [
      target('a', 'ready', sent),
      target('b', 'working', sent),
      target('c', 'ready', sent),
    ];
    const res = await broadcastStaggered(targets, 1000, { sleep });
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(res.hitNames).toEqual(['a', 'b', 'c']);
    expect(res.tally).toEqual({ ready: 2, working: 1 });
    expect(res.failures).toEqual([]);
  });

  it('waits staggerMs BETWEEN sends only (N-1 sleeps, not N)', async () => {
    const sent: string[] = [];
    const { sleep, calls } = fakeSleep();
    const targets = [target('a', 'ready', sent), target('b', 'ready', sent), target('c', 'ready', sent)];
    await broadcastStaggered(targets, 750, { sleep });
    expect(calls).toEqual([750, 750]); // 2 sleeps for 3 targets
  });

  it('staggerMs = 0 never sleeps (instant fan-out)', async () => {
    const sent: string[] = [];
    const { sleep, calls } = fakeSleep();
    const targets = [target('a', 'ready', sent), target('b', 'ready', sent)];
    await broadcastStaggered(targets, 0, { sleep });
    expect(calls).toEqual([]);
    expect(sent).toEqual(['a', 'b']);
  });

  it('a failing send is recorded and does not abort the batch', async () => {
    const sent: string[] = [];
    const { sleep } = fakeSleep();
    const targets = [
      target('a', 'ready', sent),
      target('b', 'working', sent, true), // throws
      target('c', 'ready', sent),
    ];
    const res = await broadcastStaggered(targets, 10, { sleep });
    expect(sent).toEqual(['a', 'c']); // c still sent after b threw
    expect(res.hitNames).toEqual(['a', 'c']);
    expect(res.tally).toEqual({ ready: 2 });
    expect(res.failures).toEqual(['b: disposed']);
  });

  it('reports progress once per target with done/total/name', async () => {
    const sent: string[] = [];
    const { sleep } = fakeSleep();
    const onProgress = vi.fn();
    const targets = [target('a', 'ready', sent), target('b', 'ready', sent)];
    await broadcastStaggered(targets, 5, { sleep, onProgress });
    expect(onProgress.mock.calls).toEqual([
      [1, 2, 'a'],
      [2, 2, 'b'],
    ]);
  });

  it('empty target list: no sleeps, empty result', async () => {
    const { sleep, calls } = fakeSleep();
    const res = await broadcastStaggered([], 1000, { sleep });
    expect(calls).toEqual([]);
    expect(res).toEqual({ tally: {}, hitNames: [], failures: [] });
  });
});
