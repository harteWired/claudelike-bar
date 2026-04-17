#!/usr/bin/env node
/**
 * Claudelike Bar — Claude Code hook script (Node.js).
 *
 * Reads the hook payload from stdin (JSON), derives the project name, and
 * writes a status file that the VS Code extension watches.
 *
 * Handles all configured hook events and emits a raw status signal into
 * the status file. The extension's state machine interprets the signals;
 * this script is intentionally dumb about state transitions.
 *
 * Event → status signal mapping (see body for authoritative logic):
 *   Stop, Notification              → "ready"
 *   StopFailure                     → "error"
 *   SubagentStart / SubagentStop    → "subagent_start" / "subagent_stop"
 *   TeammateIdle                    → "teammate_idle"
 *   SessionStart                    → "session_start"          (v0.9.1)
 *   SessionEnd                      → "session_end"            (v0.9.1)
 *   PostToolUseFailure              → "tool_failure"           (v0.9.1)
 *   PreCompact                      → "compact_start"          (v0.9.1)
 *   PostCompact                     → "compact_end"            (v0.9.1)
 *   PostToolUse                     → "tool_end"               (v0.9.3)
 *   PreToolUse, UserPromptSubmit,
 *   everything else                 → "working"
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
  let toolName = '';
  let agentType = '';
  let errorType = '';
  let notificationType = '';
  let sessionSource = '';      // v0.9.1: SessionStart matcher
  let sessionEndReason = '';   // v0.9.1: SessionEnd matcher
  let compactionTrigger = '';  // v0.9.1: PreCompact/PostCompact matcher
  if (input) {
    try {
      const parsed = JSON.parse(input);
      event = typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '';
      cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
      // Tool/subagent/error/notification metadata — event-specific, may be absent.
      toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
      agentType = typeof parsed.agent_type === 'string' ? parsed.agent_type : '';
      errorType = typeof parsed.error_type === 'string' ? parsed.error_type : '';
      notificationType = typeof parsed.notification_type === 'string' ? parsed.notification_type : '';
      // v0.9.1 — session/compaction metadata.
      sessionSource = typeof parsed.source === 'string' ? parsed.source : '';
      sessionEndReason = typeof parsed.reason === 'string' ? parsed.reason : '';
      compactionTrigger = typeof parsed.compaction_trigger === 'string' ? parsed.compaction_trigger : '';
    } catch {
      // Malformed JSON — leave event/cwd empty, fall back below.
    }
  }

  if (!cwd) cwd = process.cwd();

  // Derive project name
  //   1. CLAUDELIKE_BAR_NAME env var (auto-started terminals)
  //   2. Path index lookup (manual terminals with registered path)
  //   3. basename(cwd) fallback
  let project = process.env.CLAUDELIKE_BAR_NAME || '';
  if (!project) {
    try {
      const indexPath = path.join(os.homedir(), '.claude', 'claudelike-bar-paths.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (typeof index === 'object' && index !== null) {
        const normalizedCwd = cwd.replace(/[/\\]+$/, '') || cwd;
        project = index[normalizedCwd] || index[cwd] || '';
      }
    } catch {
      // No index or parse error — fall through to basename
    }
  }
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

  // Status resolution — the hook writes the raw state signal, the extension's
  // state machine decides what transition (if any) to apply.
  //   Stop/Notification     → ready (extension may override if subagent pending)
  //   StopFailure           → error (v0.9)
  //   SubagentStart         → subagent_start (extension increments counter)
  //   SubagentStop          → subagent_stop (extension decrements counter)
  //   TeammateIdle          → teammate_idle (extension sets flag)
  //   SessionStart          → session_start (v0.9.1 — clear offline state)
  //   SessionEnd            → session_end (v0.9.1 — set offline if matcher says so)
  //   PostToolUseFailure    → tool_failure (v0.9.1 — transient flag)
  //   PreCompact            → compact_start (v0.9.1 — label override)
  //   PostCompact           → compact_end (v0.9.1 — clear override)
  //   PostToolUse           → tool_end (v0.9.3 — closes the post-permission gap)
  //   Everything else       → working
  let status = 'working';
  if (event === 'Stop' || event === 'Notification') status = 'ready';
  else if (event === 'StopFailure') status = 'error';
  else if (event === 'SubagentStart') status = 'subagent_start';
  else if (event === 'SubagentStop') status = 'subagent_stop';
  else if (event === 'TeammateIdle') status = 'teammate_idle';
  else if (event === 'SessionStart') status = 'session_start';
  else if (event === 'SessionEnd') status = 'session_end';
  else if (event === 'PostToolUseFailure') status = 'tool_failure';
  else if (event === 'PreCompact') status = 'compact_start';
  else if (event === 'PostCompact') status = 'compact_end';
  else if (event === 'PostToolUse') status = 'tool_end';
  const timestamp = Math.floor(Date.now() / 1000);

  const outPath = path.join(statusDir, `${project}.json`);
  const tmpPath = `${outPath}.tmp.${process.pid}`;

  // Read-merge-write: the statusline module (claudelike-statusline.js) owns
  // `context_percent`. If we just wrote { project, status, timestamp, event }
  // we'd wipe context_percent on every hook fire (4+ per Claude turn). Read
  // the existing file first, merge our fields in, preserve whatever the
  // statusline left behind.
  const ownFields = { project, status, timestamp, event };
  // Optional event-specific fields — v0.9.3 always write them, even when
  // empty, so a prior event's values don't leak through Object.assign.
  // Examples of the leak this prevents:
  //   Notification(permission_prompt) → Stop: the Stop payload doesn't carry
  //     notification_type, but Object.assign(existing, ownFields) would keep
  //     the prior "permission_prompt" string in the file — and the extension
  //     would then render a stale "Needs permission" label after Stop.
  //   StopFailure(rate_limit) → Stop: same shape, error_type would linger.
  // Writing empty strings clobbers cleanly; the extension treats '' as absent.
  ownFields.tool_name = toolName;
  ownFields.agent_type = agentType;
  ownFields.error_type = errorType;
  ownFields.notification_type = notificationType;
  ownFields.source = sessionSource;
  ownFields.reason = sessionEndReason;
  ownFields.compaction_trigger = compactionTrigger;

  let payload = ownFields;
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    // Existing fields we don't own (like context_percent) carry through;
    // fields we do own (status, timestamp, event, …) are overwritten.
    payload = Object.assign({}, existing, ownFields);
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
      + `tool=${JSON.stringify(toolName)} agent=${JSON.stringify(agentType)} `
      + `err=${JSON.stringify(errorType)} notif=${JSON.stringify(notificationType)} `
      + `src=${JSON.stringify(sessionSource)} end_reason=${JSON.stringify(sessionEndReason)} `
      + `compact=${JSON.stringify(compactionTrigger)} `
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
