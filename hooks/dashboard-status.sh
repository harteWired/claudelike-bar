#!/bin/bash
# Claudelike Bar — Claude Code hook script
# Handles all 4 hook events: PreToolUse, UserPromptSubmit, Stop, Notification
# Stop/Notification → "ready", PreToolUse/UserPromptSubmit → "working"
#
# Project-name derivation (in priority order):
#   1. $CLAUDELIKE_BAR_NAME env var — explicit override set by the extension
#      when auto-starting a terminal. Required for terminals whose name doesn't
#      match their directory (e.g. "Vault Direct" → /workspace/projects/obsidian-vault/vault).
#   2. /workspace/projects/<name>/... — walk up the cwd for the project root.
#   3. /workspace itself → "workspace".
#   4. basename of cwd (fallback).
#
# Debug logging: create /tmp/claude-dashboard/.debug to enable a trace log at
# /tmp/claude-dashboard/debug.log. The extension toggles this file from config.

set -u

STATUS_DIR=/tmp/claude-dashboard
DEBUG_FLAG="$STATUS_DIR/.debug"
DEBUG_LOG="$STATUS_DIR/debug.log"

mkdir -p "$STATUS_DIR"

# Read hook payload from stdin (Claude Code passes JSON via stdin)
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat)
fi

EVENT=""
CWD=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
fi

# Fallbacks for event + cwd
[ -z "$EVENT" ] && EVENT="${CLAUDE_HOOK_EVENT_NAME:-}"
[ -z "$CWD" ] && CWD="$PWD"

# Derive project name
PROJECT="${CLAUDELIKE_BAR_NAME:-}"
if [ -z "$PROJECT" ]; then
  case "$CWD" in
    /workspace/projects/*)
      PROJECT="${CWD#/workspace/projects/}"
      PROJECT="${PROJECT%%/*}"
      ;;
    /workspace|/workspace/)
      PROJECT="workspace"
      ;;
    /workspace/*)
      # Under /workspace but not /workspace/projects (e.g. /workspace/shared)
      PROJECT="workspace"
      ;;
    *)
      PROJECT=$(basename "$CWD")
      ;;
  esac
fi

# Sanitize project name — strip anything that could break the filename
PROJECT=$(printf '%s' "$PROJECT" | tr -d '\n\r' | tr '/' '_')
if [ -z "$PROJECT" ]; then
  PROJECT="unknown"
fi

STATUS="working"
if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "Notification" ]; then
  STATUS="ready"
fi

TIMESTAMP=$(date +%s)

# Escape project name for JSON (backslashes + quotes)
JSON_PROJECT=$(printf '%s' "$PROJECT" | sed 's/\\/\\\\/g; s/"/\\"/g')
JSON_EVENT=$(printf '%s' "$EVENT" | sed 's/\\/\\\\/g; s/"/\\"/g')

printf '{"project":"%s","status":"%s","timestamp":%s,"event":"%s"}\n' \
  "$JSON_PROJECT" "$STATUS" "$TIMESTAMP" "$JSON_EVENT" \
  > "$STATUS_DIR/${PROJECT}.json"

# Debug trace — only when flag file exists
if [ -f "$DEBUG_FLAG" ]; then
  {
    printf '[%s] event=%q status=%q project=%q cwd=%q env_name=%q stdin_bytes=%s\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" \
      "$EVENT" "$STATUS" "$PROJECT" "$CWD" \
      "${CLAUDELIKE_BAR_NAME:-}" \
      "${#INPUT}"
  } >> "$DEBUG_LOG" 2>/dev/null
fi

exit 0
