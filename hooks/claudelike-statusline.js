#!/usr/bin/env node
/**
 * Claudelike Bar — Claude Code statusline script (standalone).
 *
 * Parses the statusline payload on stdin, extracts context window usage,
 * and merges it into the per-project status file so the sidebar tile can
 * display context %. Also prints a minimal status line for Claude Code
 * to show in the terminal.
 *
 * This script is COMPLETELY INDEPENDENT of the hook script
 * (dashboard-status.js). They share only the status file format — which is
 * a documented, stable interface. Either can run without the other.
 *
 * Zero npm dependencies — Node.js built-ins only.
 *
 * Install/uninstall is optional. The sidebar's tiles will still transition
 * between working/ready/waiting states without this; you just won't see a
 * context % badge on each tile.
 *
 * If you already have a Claude Code `statusLine.command` configured, the
 * extension will NOT overwrite it. You can either (a) keep your statusline
 * and have it write `context_percent` into the status file yourself (see
 * README → "Context % (Optional Enhancement)"), or (b) replace it with this
 * one via the "Claudelike Bar: Install Statusline" command (prompts first).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function sanitizeProject(name) {
  return (name || '')
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
}

function main() {
  const statusDir = process.env.CLAUDELIKE_STATUS_DIR
    || path.join(os.tmpdir(), 'claude-dashboard');
  fs.mkdirSync(statusDir, { recursive: true });

  let input = '';
  try {
    if (!process.stdin.isTTY) input = fs.readFileSync(0, 'utf8');
  } catch {}

  let data = {};
  if (input) {
    try { data = JSON.parse(input); } catch {}
  }

  const model = (data.model && typeof data.model.display_name === 'string') ? data.model.display_name : '';
  const cwd = (data.workspace && typeof data.workspace.current_dir === 'string')
    ? data.workspace.current_dir
    : (typeof data.cwd === 'string' ? data.cwd : process.cwd());
  // Only treat context_window.used_percentage as valid if it's actually a
  // number — we must not write context_percent=0 on empty/malformed input,
  // that would clobber a previously good value.
  const haveCtx = data.context_window && typeof data.context_window.used_percentage === 'number';
  const ctxPct = haveCtx ? Math.max(0, Math.min(100, Math.floor(data.context_window.used_percentage))) : null;

  const project = sanitizeProject(process.env.CLAUDELIKE_BAR_NAME || path.basename(cwd)) || 'unknown';

  // Merge context_percent into existing status file (if any), else start fresh.
  const statusFile = path.join(statusDir, `${project}.json`);
  let payload = { project, timestamp: Math.floor(Date.now() / 1000) };
  try {
    const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // Keep existing fields, overwrite only what we set.
    payload = Object.assign({}, existing, payload);
  } catch {}
  if (ctxPct !== null) {
    payload.context_percent = ctxPct;
  }

  // Atomic write via rename — same technique as the hook script.
  const tmpPath = `${statusFile}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n');
    fs.renameSync(tmpPath, statusFile);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  // Output a minimal status line for Claude Code to display in the terminal.
  // Nothing fancy — users who want rich status bars should bring their own.
  const parts = [];
  if (model) parts.push(model);
  if (project && project !== 'unknown') parts.push(project);
  if (ctxPct !== null) parts.push(`ctx ${ctxPct}%`);
  process.stdout.write(parts.join(' │ '));
}

try { main(); } catch {
  // Statusline must never fail — silence all errors.
}
process.exit(0);
