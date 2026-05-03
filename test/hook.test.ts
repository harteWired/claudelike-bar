import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'dashboard-status.js');

/** Run the hook with the given stdin + env, return parsed output status file contents. */
function runHook(
  stdin: string,
  opts: { env?: Record<string, string>; statusDir?: string } = {},
): { exitCode: number | null; statusFile: any; projectName: string } {
  const statusDir = opts.statusDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  const env = {
    ...process.env,
    CLAUDELIKE_STATUS_DIR: statusDir,
    ...opts.env,
  };
  // Remove PATH-inherited CLAUDELIKE_BAR_NAME unless the caller set it
  if (opts.env?.CLAUDELIKE_BAR_NAME === undefined) {
    delete env.CLAUDELIKE_BAR_NAME;
  }
  const result = spawnSync('node', [HOOK_PATH], {
    input: stdin,
    env,
    encoding: 'utf8',
  });
  // Find the project name from whatever file was written
  const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.json'));
  const projectName = files.length === 1 ? files[0].replace(/\.json$/, '') : '';
  const statusFile = projectName
    ? JSON.parse(fs.readFileSync(path.join(statusDir, `${projectName}.json`), 'utf8'))
    : null;
  return { exitCode: result.status, statusFile, projectName };
}

describe('dashboard-status.js hook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('exits 0 even on malformed input', () => {
    const { exitCode } = runHook('not json', { statusDir: tmpDir });
    expect(exitCode).toBe(0);
  });

  it('writes "ready" status for Stop event', () => {
    const { statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile.status).toBe('ready');
    expect(statusFile.event).toBe('Stop');
    expect(statusFile.project).toBe('my-project');
  });

  it('writes "ready" status for Notification event', () => {
    const { statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'Notification', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile.status).toBe('ready');
  });

  it('writes "working" status for PreToolUse event', () => {
    const { statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'PreToolUse', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile.status).toBe('working');
  });

  it('writes "working" status for UserPromptSubmit event', () => {
    const { statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile.status).toBe('working');
  });

  it('derives project name from basename(cwd)', () => {
    const { projectName } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'deeply', 'nested', 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(projectName).toBe('my-project');
  });

  it('prefers CLAUDELIKE_BAR_NAME env var over cwd basename', () => {
    const { projectName, statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'other-name') }),
      { statusDir: tmpDir, env: { CLAUDELIKE_BAR_NAME: 'explicit-name' } },
    );
    expect(projectName).toBe('explicit-name');
    expect(statusFile.project).toBe('explicit-name');
  });

  it('sanitizes path separators in project name', () => {
    const { projectName } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: tmpDir }),
      { statusDir: tmpDir, env: { CLAUDELIKE_BAR_NAME: 'foo/bar\\baz' } },
    );
    expect(projectName).toBe('foo_bar_baz');
  });

  it('sanitizes Windows-reserved characters in project name', () => {
    const { projectName } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: tmpDir }),
      { statusDir: tmpDir, env: { CLAUDELIKE_BAR_NAME: 'foo:bar*baz?qux' } },
    );
    // Each invalid char → underscore
    expect(projectName).toBe('foo_bar_baz_qux');
  });

  it('falls back to "unknown" when project name is empty after sanitization', () => {
    // basename('/') returns '' on POSIX. No CLAUDELIKE_BAR_NAME override.
    // The hook should fall through to 'unknown'.
    const { projectName } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: '/' }),
      { statusDir: tmpDir },
    );
    expect(projectName).toBe('unknown');
  });

  it('falls back to "unknown" when project name is only dots (stripped by sanitizer)', () => {
    const { projectName } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: tmpDir }),
      { statusDir: tmpDir, env: { CLAUDELIKE_BAR_NAME: '...' } },
    );
    expect(projectName).toBe('unknown');
  });

  it('writes valid JSON with all expected fields', () => {
    const { statusFile } = runHook(
      JSON.stringify({ hook_event_name: 'PreToolUse', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile).toHaveProperty('project');
    expect(statusFile).toHaveProperty('status');
    expect(statusFile).toHaveProperty('timestamp');
    expect(statusFile).toHaveProperty('event');
    expect(typeof statusFile.timestamp).toBe('number');
  });

  it('uses CLAUDELIKE_STATUS_DIR when set', () => {
    const customDir = path.join(tmpDir, 'custom');
    runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: customDir },
    );
    expect(fs.existsSync(path.join(customDir, 'my-project.json'))).toBe(true);
  });

  it('handles missing hook_event_name gracefully (defaults to working)', () => {
    const { statusFile } = runHook(
      JSON.stringify({ cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(statusFile.status).toBe('working');
    expect(statusFile.event).toBe('');
  });

  it('leaves no .tmp files behind after a successful run', () => {
    runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    const files = fs.readdirSync(tmpDir);
    expect(files.filter(f => f.includes('.tmp'))).toHaveLength(0);
  });

  // v0.18.1 (belfry) — last_response capture
  it('writes last_response on Stop when transcript_path is provided', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Hello back!' }] }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'Stop',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toBe('Hello back!');
    expect(typeof statusFile.last_response_at).toBe('number');
  });

  it('writes last_response on Notification', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'do X' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Need permission to run X' }] }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'Notification',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toBe('Need permission to run X');
  });

  it('skips tool_use blocks and picks the last text block', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'do X' }),
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'Bash', input: {} },
          { type: 'text', text: 'I ran the command and the result is ready.' },
        ],
      }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'Stop',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toBe('I ran the command and the result is ready.');
  });

  it('truncates over-long assistant responses with ellipsis', () => {
    const longText = 'a'.repeat(800);
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: longText }] }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'Stop',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toMatch(/^a{500}…$/);
  });

  it('skips last_response capture for subagent Stop events', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'subagent text' }] }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'Stop',
        cwd: path.join(tmpDir, 'my-project'),
        agent_type: 'general-purpose',
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toBeUndefined();
  });

  it('does not write last_response on PreToolUse / UserPromptSubmit', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'should not surface' }] }),
    ].join('\n') + '\n');
    const { statusFile } = runHook(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: transcriptPath,
      }),
      { statusDir: tmpDir },
    );
    expect(statusFile.last_response).toBeUndefined();
  });

  it('handles missing transcript_path silently', () => {
    const { statusFile, exitCode } = runHook(
      JSON.stringify({ hook_event_name: 'Stop', cwd: path.join(tmpDir, 'my-project') }),
      { statusDir: tmpDir },
    );
    expect(exitCode).toBe(0);
    expect(statusFile.last_response).toBeUndefined();
  });

  it('handles non-existent transcript file silently', () => {
    const { statusFile, exitCode } = runHook(
      JSON.stringify({
        hook_event_name: 'Stop',
        cwd: path.join(tmpDir, 'my-project'),
        transcript_path: '/nonexistent/path/transcript.jsonl',
      }),
      { statusDir: tmpDir },
    );
    expect(exitCode).toBe(0);
    expect(statusFile.last_response).toBeUndefined();
  });
});
