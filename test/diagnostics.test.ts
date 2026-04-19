import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDiagnostics, formatDiagnosticsReport, fingerprintDiagnostics } from '../src/diagnostics';
import { ConfigManager } from '../src/configManager';

/**
 * Diagnostics run against real files and the real ConfigManager; no Node
 * builtins mocked (project convention). HOME gets redirected so the
 * checks hit a throwaway ~/.claude/ tree.
 */

let originalHome: string | undefined;
let tmpHome: string;
let tmpWorkspace: string;
let bundledDir: string;
let configPath: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-home-'));
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-ws-'));
  bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-bundled-'));
  process.env.HOME = tmpHome;
  configPath = path.join(tmpWorkspace, 'claudelike-bar.jsonc');
  fs.mkdirSync(path.join(tmpHome, '.claude', 'hooks'), { recursive: true });
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  fs.rmSync(bundledDir, { recursive: true, force: true });
});

function writeSettings(hookEvents: string[] | null): void {
  const hookPath = path.join(tmpHome, '.claude', 'hooks', 'dashboard-status.js');
  const cmd = process.platform === 'win32' ? `node "${hookPath}"` : hookPath;
  const hooks: Record<string, unknown> = {};
  if (hookEvents) {
    for (const e of hookEvents) {
      hooks[e] = [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }];
    }
  }
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'settings.json'),
    JSON.stringify({ hooks }, null, 2),
  );
}

// isSetupComplete checks for a specific set of hook events; mirror the
// list from src/setup.ts so the "healthy" case writes them all.
const ALL_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'SessionStart',
  'SessionEnd',
  'PostToolUseFailure',
  'PreCompact',
  'PostCompact',
];

function installHookScript(): void {
  const scriptPath = path.join(tmpHome, '.claude', 'hooks', 'dashboard-status.js');
  fs.writeFileSync(scriptPath, '#!/usr/bin/env node\n');
  fs.chmodSync(scriptPath, 0o755);
}

function writeValidConfig(audioBlock?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = { terminals: {} };
  if (audioBlock) payload.audio = audioBlock;
  fs.writeFileSync(configPath, JSON.stringify(payload));
}

function freshCm(): ConfigManager {
  return new ConfigManager(configPath, bundledDir);
}

describe('runDiagnostics — healthy path', () => {
  it('all checks ok when hooks wired, script installed, config clean, audio disabled', () => {
    writeSettings(ALL_HOOK_EVENTS);
    installHookScript();
    writeValidConfig();
    const cm = freshCm();
    try {
      const results = runDiagnostics(cm, bundledDir);
      const bad = results.filter((r) => !r.ok);
      expect(bad).toEqual([]);
    } finally {
      cm.dispose();
    }
  });
});

describe('runDiagnostics — failure modes', () => {
  it('flags missing settings.json', () => {
    writeValidConfig();
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'settings-file')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('error');
      expect(r.summary).toMatch(/missing/);
    } finally {
      cm.dispose();
    }
  });

  it('flags corrupted settings.json', () => {
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{not json');
    writeValidConfig();
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'settings-file')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('error');
    } finally {
      cm.dispose();
    }
  });

  it('flags missing hook script', () => {
    writeSettings(ALL_HOOK_EVENTS);
    writeValidConfig();
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'hook-script')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('error');
    } finally {
      cm.dispose();
    }
  });

  it('flags incomplete hook registration', () => {
    installHookScript();
    writeSettings(['Stop']); // only one of the required events
    writeValidConfig();
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'hooks-registered')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('error');
    } finally {
      cm.dispose();
    }
  });

  it('warns when audio is enabled but turnDone is null', () => {
    writeSettings(ALL_HOOK_EVENTS);
    installHookScript();
    writeValidConfig({
      enabled: true,
      sounds: { turnDone: null, midJobPrompt: null },
    });
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'audio')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('warn');
    } finally {
      cm.dispose();
    }
  });

  it('warns when legacy notify*.sh hooks are present', () => {
    installHookScript();
    writeValidConfig();
    // Manually write settings with BOTH the canonical hook AND a legacy one.
    const hookPath = path.join(tmpHome, '.claude', 'hooks', 'dashboard-status.js');
    const hooksJson: Record<string, unknown> = {};
    for (const e of ALL_HOOK_EVENTS) {
      hooksJson[e] = [{ matcher: '', hooks: [{ type: 'command', command: hookPath }] }];
    }
    // Append a legacy entry on Stop.
    (hooksJson.Stop as any[]).push({
      matcher: '',
      hooks: [{ type: 'command', command: path.join(tmpHome, '.claude', 'hooks', 'notify-silent.sh') }],
    });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ hooks: hooksJson }, null, 2),
    );
    const cm = freshCm();
    try {
      const r = runDiagnostics(cm, bundledDir).find((x) => x.id === 'legacy-hooks')!;
      expect(r.ok).toBe(false);
      expect(r.severity).toBe('warn');
    } finally {
      cm.dispose();
    }
  });
});

describe('fingerprintDiagnostics', () => {
  it('produces identical fingerprints for identical state', () => {
    writeSettings(ALL_HOOK_EVENTS);
    installHookScript();
    writeValidConfig();
    const cm = freshCm();
    try {
      const a = fingerprintDiagnostics(runDiagnostics(cm, bundledDir));
      const b = fingerprintDiagnostics(runDiagnostics(cm, bundledDir));
      expect(a).toBe(b);
    } finally {
      cm.dispose();
    }
  });

  it('changes when a check flips from ok to not-ok', () => {
    writeSettings(ALL_HOOK_EVENTS);
    installHookScript();
    writeValidConfig();
    let cm: ConfigManager | undefined = freshCm();
    let okFingerprint = '';
    try {
      okFingerprint = fingerprintDiagnostics(runDiagnostics(cm, bundledDir));
    } finally {
      cm.dispose();
      cm = undefined;
    }
    // Break the hook script.
    fs.unlinkSync(path.join(tmpHome, '.claude', 'hooks', 'dashboard-status.js'));
    cm = freshCm();
    try {
      const brokenFingerprint = fingerprintDiagnostics(runDiagnostics(cm, bundledDir));
      expect(brokenFingerprint).not.toBe(okFingerprint);
    } finally {
      cm.dispose();
    }
  });
});

describe('formatDiagnosticsReport', () => {
  it('includes the summary line + any hint for failing checks', () => {
    writeValidConfig();
    const cm = freshCm();
    try {
      const results = runDiagnostics(cm, bundledDir);
      const report = formatDiagnosticsReport(results);
      expect(report).toContain('Claudelike Bar — diagnostics');
      expect(report).toContain('settings-file');
      // At least one failing check prints its hint.
      const bad = results.filter((r) => !r.ok);
      if (bad[0]?.hint) {
        expect(report).toContain(bad[0].hint);
      }
    } finally {
      cm.dispose();
    }
  });
});
