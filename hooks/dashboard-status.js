#!/usr/bin/env node
/**
 * Claudelike Bar — Claude Code hook script (Node.js).
 *
 * Reads the hook payload from stdin (JSON), derives the project name, and
 * writes a status file that the VS Code extension watches.
 *
 * Handles all 4 hook events: PreToolUse, UserPromptSubmit, Stop, Notification.
 *   Stop/Notification → "ready"
 *   PreToolUse/UserPromptSubmit → "working"
 *
 * Project-name priority:
 *   1. $CLAUDELIKE_BAR_NAME env var — explicit override set by the extension
 *      when auto-starting a terminal. Required when the terminal name doesn't
 *      match its directory (e.g. "My Staging" → ~/projects/staging).
 *   2. basename(cwd) — works on any system regardless of layout.
 *
 * Status dir priority:
 *   1. $CLAUDELIKE_STATUS_DIR env var
 *   2. os.tmpdir()/claude-dashboard
 *
 * Debug logging: create <STATUS_DIR>/.debug to enable a trace log at
 * <STATUS_DIR>/debug.log. The extension toggles this file from config.
 *
 * Zero npm dependencies — uses only Node.js built-ins.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function main() {
  const statusDir = process.env.CLAUDELIKE_STATUS_DIR
    || path.join(os.tmpdir(), 'claude-dashboard');

  fs.mkdirSync(statusDir, { recursive: true });

  // Read stdin — Claude Code pipes JSON. If stdin is a TTY, skip parsing.
  let input = '';
  try {
    if (!process.stdin.isTTY) {
      input = fs.readFileSync(0, 'utf8');
    }
  } catch {
    // No stdin available — proceed with empty input, will fall back.
  }

  let event = '';
  let cwd = '';
  if (input) {
    try {
      const parsed = JSON.parse(input);
      event = typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '';
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
    } catch {
      // Malformed JSON — leave event/cwd empty, fall back below.
    }
  }

  if (!cwd) cwd = process.cwd();

  // Derive project name
  let project = process.env.CLAUDELIKE_BAR_NAME || '';
  if (!project) {
    project = path.basename(cwd);
  }

  // Sanitize project name — strip anything that could break the filename.
  // Covers POSIX path separators plus Windows-reserved chars (: * ? " < > |).
  // Strip leading/trailing dots too to avoid `.json` files that are purely
  // extensions (".json") or Windows-reserved names like `..`.
  project = project
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) project = 'unknown';

  const status = (event === 'Stop' || event === 'Notification') ? 'ready' : 'working';
  const timestamp = Math.floor(Date.now() / 1000);

  const outPath = path.join(statusDir, `${project}.json`);
  const tmpPath = `${outPath}.tmp.${process.pid}`;

  // Read-merge-write: the statusline module (claudelike-statusline.js) owns
  // `context_percent`. If we just wrote { project, status, timestamp, event }
  // we'd wipe context_percent on every hook fire (4+ per Claude turn). Read
  // the existing file first, merge our fields in, preserve whatever the
  // statusline left behind.
  let payload = { project, status, timestamp, event };
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    // Existing fields we don't own (like context_percent) carry through;
    // fields we do own (status, timestamp, event) are overwritten.
    payload = Object.assign({}, existing, payload);
  } catch {
    // No existing file or malformed — write fresh.
  }

  // Atomic write via rename — prevents the extension's FileSystemWatcher from
  // seeing partially-written JSON. The hook fires 4+ times per Claude turn,
  // so the race has real exposure. rename() is atomic on POSIX and uses
  // ReplaceFile/MoveFileEx semantics on Windows (close-to-atomic).
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n');
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    // Write failures are non-fatal — the hook must not block Claude.
    // Clean up the temp file if it was created.
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  // Debug trace — only when the .debug flag file exists.
  const debugFlag = path.join(statusDir, '.debug');
  if (fs.existsSync(debugFlag)) {
    const line = `[${new Date().toISOString()}] event=${JSON.stringify(event)} `
      + `status=${JSON.stringify(status)} project=${JSON.stringify(project)} `
      + `cwd=${JSON.stringify(cwd)} env_name=${JSON.stringify(process.env.CLAUDELIKE_BAR_NAME || '')} `
      + `stdin_bytes=${input.length}\n`;
    try {
      fs.appendFileSync(path.join(statusDir, 'debug.log'), line);
    } catch {
      // Debug log failure is silent.
    }
  }
}

try {
  main();
} catch {
  // Any uncaught error is swallowed — the hook must never fail Claude's execution.
}

process.exit(0);
