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
 * Project-name priority (Status-File Contract v1 §B):
 *   1. $CLAUDELIKE_BAR_NAME env var — explicit override set by the extension
 *      when auto-starting a terminal. Required when the terminal name doesn't
 *      match its directory (e.g. "My Staging" → ~/projects/staging).
 *   2. Ancestor-walk of the path index (~/.claude/claudelike-bar-paths.json):
 *      the nearest registered ancestor of cwd wins.
 *   3. No match → STRICT (default) skips the write; CLAUDELIKE_BAR_STRICT=0
 *      restores the legacy basename(cwd) mint.
 *
 * Status dir priority (Status-File Contract v1 §A):
 *   1. $CLAUDELIKE_STATUS_DIR env var
 *   2. $CLAUDE_DASHBOARD_DIR (deprecated alias)
 *   3. POSIX: /tmp/claude-dashboard literal; win32: os.tmpdir()/claude-dashboard
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

// v0.18.2 (belfry, 2026-05-22) — retry budget for the transcript-flush
// race. Claude Code can fire the Stop hook before the final assistant
// text block has been flushed to disk. Empirically the flush lands within
// ~50–150ms, so one brief retry catches almost all races without
// meaningfully delaying legitimate pure-tool turns (where no text was
// emitted at all and the retry will still return null).
const FLUSH_RETRY_MS = 150;

function syncSleep(ms) {
  // Block this subprocess for ms. The hook is a one-shot CLI; there's no
  // event loop to protect. Atomics.wait on an unshared buffer that never
  // gets notified is the standard Node idiom for "sleep without spinning."
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// v0.18.1 (belfry) — pull the last assistant text out of a Claude Code
// JSONL transcript. Used to populate `last_response` on Stop/Notification
// so consumers (the webview's `Show last prompt`-style modal, belfry's
// Telegram messages) have end-of-turn context for the user.
//
// Reads only the tail of the file (default 64KB) — assistant messages
// rarely exceed that, and we'd rather miss a too-long response than
// stall the hook on a multi-MB session log. Scans backwards line by line
// for the most recent {role:"assistant"} entry and extracts its first
// text block. Returns null on any IO/parse failure — the hook must never
// fail Claude's execution.
// A user JSONL entry whose content is *only* tool_result blocks is the
// model's tool-execution feedback — it belongs to the current turn, not
// the previous one. Used by extractLastAssistantText to walk past
// tool-result entries without treating them as turn boundaries.
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => b && typeof b === 'object' && b.type === 'tool_result');
}

// v0.18.2 (belfry) — turn-boundary-aware reverse scan + flush-race retry.
//
// Claude Code's JSONL transcript stores each content block on its own line:
// a single assistant turn produces separate entries for thinking, tool_use,
// and text blocks rather than bundling them into one message. The original
// "find the most recent text-bearing assistant line" walk dropped into the
// previous turn whenever the current turn ended with tool_use/thinking
// (the common case for tool-heavy turns). That manifested as Telegram
// pings being one event out of phase — observed and root-caused 2026-05-22.
//
// Two compounding root causes were addressed:
//
//   1. Turn-boundary: bound the reverse scan at the next non-tool_result
//      user entry — that user message IS the prompt that started this
//      turn. Tool-result user entries are part of the current turn and
//      we walk past them. Pure-tool turns return null rather than
//      reaching into the previous turn for stale text.
//
//   2. Flush race: Claude Code can fire the Stop hook before the final
//      assistant text block has been flushed to disk (observed: a 1.6KB
//      text block with content-timestamp 100ms before Stop fired was
//      still not on disk when the hook read it). Defense: if the first
//      scan returns null, sleep FLUSH_RETRY_MS and retry once. Almost
//      all flush races land within ~150ms; pure-tool turns pay the same
//      delay then correctly return null again.
function extractLastAssistantText(transcriptPath, maxBytes = 65536, charCap = 500) {
  let result = extractLastAssistantTextOnce(transcriptPath, maxBytes, charCap);
  if (result) return result;
  syncSleep(FLUSH_RETRY_MS);
  return extractLastAssistantTextOnce(transcriptPath, maxBytes, charCap);
}

function extractLastAssistantTextOnce(transcriptPath, maxBytes = 65536, charCap = 500) {
  if (!transcriptPath) return null;
  let stat;
  try { stat = fs.statSync(transcriptPath); }
  catch { return null; }
  const start = Math.max(0, stat.size - maxBytes);
  let text;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { continue; } // partial line at the byte boundary, or transcript noise
    const role = entry?.role || entry?.message?.role;
    const content = entry?.content ?? entry?.message?.content;
    if (role === 'assistant') {
      const extracted = extractAssistantContent(content);
      if (extracted) {
        return extracted.length > charCap ? extracted.slice(0, charCap) + '…' : extracted;
      }
      // No text in this assistant entry — keep walking back through the
      // current turn (thinking and tool_use entries land here).
    } else if (role === 'user') {
      if (isToolResultOnly(content)) continue;
      // Real user message — the turn boundary. Stop here; anything before
      // is the previous turn and must not be surfaced.
      return null;
    }
    // Other roles (system / metadata) are skipped.
  }
  return null;
}

function extractAssistantContent(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    // Pick the first text block. tool_use / thinking blocks aren't user-visible
    // text and shouldn't be surfaced as "what Claude said."
    for (const block of content) {
      if (typeof block === 'string' && block.trim()) return block.trim();
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return null;
}

// --- Status-File Contract v1 §A: status directory ------------------------
// Canonical env var is CLAUDELIKE_STATUS_DIR; CLAUDE_DASHBOARD_DIR is honored
// as a deprecated transition alias. The POSIX default is a FIXED literal —
// NOT os.tmpdir() — because Claude Code sets TMPDIR=/tmp/claude-<uid> per
// process, so an os.tmpdir() default would diverge from the convention literal
// that the extension's watcher/GC reads (today's split-dir bug).
function resolveStatusDir() {
  const explicit = (process.env.CLAUDELIKE_STATUS_DIR || '').trim()
    || (process.env.CLAUDE_DASHBOARD_DIR || '').trim();
  if (explicit) return explicit;
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claude-dashboard')
    : '/tmp/claude-dashboard';
}

// --- Status-File Contract v1 §B: slug resolution -------------------------
// Index keys are normalized absolute paths with NO trailing slash (guaranteed
// by the extension's index writer). Walk cwd then each parent up to the
// filesystem root; first index hit wins. This is the ancestor-walk that maps
// subdir terminals to their real project instead of minting a basename slug.
// No in-process parse cache: the hook is one-shot per event (fresh subprocess),
// so caching buys nothing — matches belfry lib/slug.js's stated rationale.
function lookupAncestor(cwd) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.claude', 'claudelike-bar-paths.json'), 'utf8'));
  } catch {
    return ''; // no index or parse error — no match
  }
  if (typeof index !== 'object' || index === null) return '';
  let dir = cwd.replace(/[/\\]+$/, '') || cwd;
  for (;;) {
    const hit = index[dir];
    if (typeof hit === 'string' && hit.length > 0) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return ''; // reached filesystem root, no match
    dir = parent;
  }
}

// Resolve the dashboard slug, or null when STRICT (default) says skip the
// write. Order: 1) CLAUDELIKE_BAR_NAME env (auto-started terminals), 2)
// ancestor-walk of the path index, 3) no match → STRICT skips; LEGACY
// (CLAUDELIKE_BAR_STRICT=0) restores the old basename(cwd) mint.
function resolveSlug(cwd) {
  const strict = process.env.CLAUDELIKE_BAR_STRICT !== '0';
  let project = (process.env.CLAUDELIKE_BAR_NAME || '').trim();
  if (!project) project = lookupAncestor(cwd);
  if (!project) {
    if (strict) return null;
    project = path.basename(cwd);
  }
  // §C sanitize — byte-identical with belfry lib/slug.js and the extension.
  project = project
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) return strict ? null : 'unknown';
  return project;
}

function main() {
  const statusDir = resolveStatusDir();

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
  let userPrompt = '';         // v0.16.4 (#19): UserPromptSubmit prompt text
  let transcriptPath = '';     // v0.18.1 (belfry): path to JSONL session transcript
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
      // v0.16.4 (#19) — capture the user prompt on UserPromptSubmit only.
      // Truncate at the source (300 chars) so status JSONs stay small even
      // for very long pasted prompts. Subagent prompts (agent_type set)
      // are skipped — only parent-turn user input.
      if (event === 'UserPromptSubmit' && !agentType) {
        const raw = typeof parsed.prompt === 'string' ? parsed.prompt : '';
        userPrompt = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
      }
      // v0.18.1 (belfry) — claude code passes transcript_path on most events.
      // Used by extractLastAssistantText below to grab the last assistant turn
      // for end-of-turn (Stop) and mid-turn-prompt (Notification) events.
      if (typeof parsed.transcript_path === 'string') {
        transcriptPath = parsed.transcript_path;
      }
    } catch {
      // Malformed JSON — leave event/cwd empty, fall back below.
    }
  }

  if (!cwd) cwd = process.cwd();

  // Derive the project slug (Contract v1 §B/§C). STRICT (default) returns null
  // for an unregistered cwd, and we write nothing rather than minting a
  // basename slug — the root fix for the subdir-junk files. Opt out with
  // CLAUDELIKE_BAR_STRICT=0 (legacy basename behavior).
  const project = resolveSlug(cwd);
  if (project === null) return;

  // Create the status dir only once we know we're going to write (skipped
  // sessions leave no directory side effect).
  fs.mkdirSync(statusDir, { recursive: true });

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
  // v0.16.4 (#19) — only OVERWRITE last_prompt on UserPromptSubmit. On
  // other events, leave it absent in ownFields so the read-merge-write
  // below preserves the value the most recent UserPromptSubmit captured.
  if (event === 'UserPromptSubmit' && userPrompt) {
    ownFields.last_prompt = userPrompt;
    ownFields.last_prompt_at = timestamp;
  }

  // v0.18.1 (belfry) — capture the last assistant text on end-of-turn (Stop)
  // and mid-turn-prompt (Notification). Subagent events are skipped (only
  // the parent's response is the user's "what Claude said"). Read-merge-
  // write below preserves last_response across other events that don't
  // carry a fresh transcript update.
  if ((event === 'Stop' || event === 'Notification') && !agentType) {
    const lastResp = extractLastAssistantText(transcriptPath);
    if (lastResp) {
      ownFields.last_response = lastResp;
      ownFields.last_response_at = timestamp;
    }
  }

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
