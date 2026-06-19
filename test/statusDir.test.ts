import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { getStatusDir } from '../src/statusDir';

// Status-File Contract v1 §A. The POSIX default is a FIXED literal — NOT
// os.tmpdir() — because Claude Code sets TMPDIR per process; an os.tmpdir()
// default would diverge between writers and readers.
describe('getStatusDir (Contract §A)', () => {
  const original = {
    status: process.env.CLAUDELIKE_STATUS_DIR,
    dashboard: process.env.CLAUDE_DASHBOARD_DIR,
  };

  beforeEach(() => {
    delete process.env.CLAUDELIKE_STATUS_DIR;
    delete process.env.CLAUDE_DASHBOARD_DIR;
  });

  afterEach(() => {
    for (const [key, val] of [
      ['CLAUDELIKE_STATUS_DIR', original.status],
      ['CLAUDE_DASHBOARD_DIR', original.dashboard],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  const expectedDefault =
    process.platform === 'win32'
      ? path.join(os.tmpdir(), 'claude-dashboard')
      : '/tmp/claude-dashboard';

  it('defaults to the POSIX literal /tmp/claude-dashboard (os.tmpdir only on win32)', () => {
    expect(getStatusDir()).toBe(expectedDefault);
    if (process.platform !== 'win32') {
      expect(getStatusDir()).toBe('/tmp/claude-dashboard');
    }
  });

  it('honors CLAUDELIKE_STATUS_DIR override', () => {
    process.env.CLAUDELIKE_STATUS_DIR = '/custom/path';
    expect(getStatusDir()).toBe('/custom/path');
  });

  it('honors the deprecated CLAUDE_DASHBOARD_DIR alias', () => {
    process.env.CLAUDE_DASHBOARD_DIR = '/legacy/path';
    expect(getStatusDir()).toBe('/legacy/path');
  });

  it('prefers CLAUDELIKE_STATUS_DIR over the CLAUDE_DASHBOARD_DIR alias', () => {
    process.env.CLAUDELIKE_STATUS_DIR = '/canonical';
    process.env.CLAUDE_DASHBOARD_DIR = '/legacy';
    expect(getStatusDir()).toBe('/canonical');
  });

  it('falls back to the default when env vars are empty or whitespace', () => {
    process.env.CLAUDELIKE_STATUS_DIR = '';
    process.env.CLAUDE_DASHBOARD_DIR = '   ';
    expect(getStatusDir()).toBe(expectedDefault);
  });

  it('trims surrounding whitespace on an explicit override', () => {
    process.env.CLAUDELIKE_STATUS_DIR = '  /spaced/dir  ';
    expect(getStatusDir()).toBe('/spaced/dir');
  });
});
