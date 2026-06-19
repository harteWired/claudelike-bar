import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepOrphanStatusFiles } from '../src/statusWatcher';

// Status-File Contract v1 item C — activation-time GC. sweepOrphanStatusFiles is
// the pure core: it reaps stale, unregistered `<slug>.json` and `*.tmp.<pid>`
// orphans while protecting registered slugs, fresh files, and non-JSON files.
describe('sweepOrphanStatusFiles', () => {
  let dir: string;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_000_000_000_000;

  // Write a file and backdate its mtime to `ageMs` before NOW.
  function seed(name: string, ageMs: number, body = '{}'): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, body);
    const t = new Date(NOW - ageMs);
    fs.utimesSync(full, t, t);
    return full;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-gc-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a stale, unregistered slug file', () => {
    seed('docs.json', 2 * DAY);
    const reaped = sweepOrphanStatusFiles(dir, new Set(), NOW);
    expect(reaped).toEqual(['docs.json']);
    expect(fs.existsSync(path.join(dir, 'docs.json'))).toBe(false);
  });

  it('keeps a registered slug regardless of age', () => {
    seed('api.json', 365 * DAY);
    const reaped = sweepOrphanStatusFiles(dir, new Set(['api']), NOW);
    expect(reaped).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'api.json'))).toBe(true);
  });

  it('keeps a fresh unregistered file (active writer guard)', () => {
    // An active terminal tracked only by CLAUDELIKE_BAR_NAME (no index entry)
    // refreshes its file constantly — younger than the stale window.
    seed('my-staging.json', 60 * 1000); // 1 minute old
    const reaped = sweepOrphanStatusFiles(dir, new Set(), NOW);
    expect(reaped).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'my-staging.json'))).toBe(true);
  });

  it('reaps stale .tmp.<pid> atomic-write orphans, keeps fresh ones', () => {
    seed('api.json.tmp.12345', 2 * DAY);
    seed('api.json.tmp.999', 60 * 1000); // fresh — a write may be in flight
    const reaped = sweepOrphanStatusFiles(dir, new Set(['api']), NOW);
    expect(reaped).toEqual(['api.json.tmp.12345']);
    expect(fs.existsSync(path.join(dir, 'api.json.tmp.999'))).toBe(true);
  });

  it('never reaps non-JSON files (.debug, debug.log) even when stale', () => {
    seed('.debug', 30 * DAY);
    seed('debug.log', 30 * DAY, 'belfry log lines\n');
    const reaped = sweepOrphanStatusFiles(dir, new Set(), NOW);
    expect(reaped).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.debug'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'debug.log'))).toBe(true);
  });

  it('mixed dir: reaps only stale unregistered .json + tmp orphans', () => {
    seed('belfry.json', 10 * DAY); // registered → keep
    seed('claudelike-bar.json', 10 * DAY); // registered → keep
    seed('sessions.json', 10 * DAY); // junk → reap
    seed('cache.json', 10 * DAY); // junk → reap
    seed('active.json', 30 * 1000); // fresh unregistered → keep
    seed('x.json.tmp.42', 10 * DAY); // tmp orphan → reap
    seed('debug.log', 10 * DAY); // non-json → keep

    const reaped = sweepOrphanStatusFiles(
      dir,
      new Set(['belfry', 'claudelike-bar']),
      NOW,
    ).sort();
    expect(reaped).toEqual(['cache.json', 'sessions.json', 'x.json.tmp.42']);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual(
      ['active.json', 'belfry.json', 'claudelike-bar.json', 'debug.log'].sort(),
    );
  });

  it('returns [] for a missing directory without throwing', () => {
    expect(sweepOrphanStatusFiles(path.join(dir, 'nope'), new Set(), NOW)).toEqual([]);
  });

  it('respects a custom stale window', () => {
    seed('docs.json', 2 * 60 * 60 * 1000); // 2h old
    // With a 1h window it's stale; with the default 24h it would survive.
    const reaped = sweepOrphanStatusFiles(dir, new Set(), NOW, 60 * 60 * 1000);
    expect(reaped).toEqual(['docs.json']);
  });
});
