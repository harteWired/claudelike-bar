#!/bin/bash
# Claudelike Bar — Claude Code hook script
# Writes status JSON to /tmp/claude-dashboard/ for the sidebar extension.
#
# Register this script for these Claude Code hook events:
#   - PreToolUse
#   - UserPromptSubmit
#   - Stop
#   - Notification
#
# See hooks/settings-snippet.json for the registration config.

PROJECT=$(basename "$PWD")
EVENT="$CLAUDE_HOOK_EVENT_NAME"
INPUT=$(cat)

STATUS="working"

case "$EVENT" in
  Stop)
    STATUS="done"
    ;;
  Notification)
    STATUS="waiting"
    ;;
  PreToolUse)
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
    if [ "$TOOL" = "AskUserQuestion" ] || [ "$TOOL" = "ExitPlanMode" ]; then
      STATUS="waiting"
    fi
    ;;
  UserPromptSubmit)
    STATUS="working"
    ;;
esac

mkdir -p /tmp/claude-dashboard
echo "{\"project\":\"$PROJECT\",\"status\":\"$STATUS\",\"timestamp\":$(date +%s),\"event\":\"$EVENT\"}" \
  > "/tmp/claude-dashboard/${PROJECT}.json"

exit 0
