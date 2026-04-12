#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Preflight checks
if ! command -v npm &>/dev/null; then
  echo "Error: npm not found. Install Node.js first." >&2
  exit 1
fi

echo "══════════════════════════════════════════════"
echo "  Claudelike Bar — Setup"
echo "══════════════════════════════════════════════"
echo

# 1. Hook script
echo "[1/4] Installing hook script..."
mkdir -p ~/.claude/hooks
cp "$SCRIPT_DIR/hooks/dashboard-status.sh" ~/.claude/hooks/ || { echo "Error: failed to copy hook script" >&2; exit 1; }
chmod +x ~/.claude/hooks/dashboard-status.sh
echo "      Copied to ~/.claude/hooks/dashboard-status.sh"

# 2. Merge hooks into settings.json
echo "[2/4] Configuring Claude Code hooks..."
cd "$SCRIPT_DIR"
node scripts/merge-hooks.js

# 3. Build extension
echo "[3/4] Building extension..."
npm install --no-audit --no-fund --silent || { echo "Error: npm install failed" >&2; exit 1; }
npm run build --silent 2>&1 || { echo "Error: build failed" >&2; exit 1; }

# 4. Install extension
echo "[4/4] Installing VS Code extension..."
npm run package --silent 2>&1 || { echo "Error: packaging failed" >&2; exit 1; }
if command -v code &>/dev/null; then
  code --install-extension "$SCRIPT_DIR"/claudelike-bar-*.vsix --force 2>/dev/null
  echo "      Extension installed."
else
  echo "      'code' CLI not found — install the .vsix manually:"
  echo "      VS Code → Extensions → ⋯ → Install from VSIX → select claudelike-bar-*.vsix"
fi

echo
echo "══════════════════════════════════════════════"
echo "  Done! Reload VS Code to activate."
echo "══════════════════════════════════════════════"
echo
echo "  Verify:  Open a Claude Code terminal, then run:"
echo "           cat /tmp/claude-dashboard/*.json"
echo
