# Install guide

Three install paths. Pick one.

## Prerequisites

- **VS Code** >= 1.93
- **Claude Code** — the CLI, installed and working
- **Node.js** — bundled with Claude Code, no separate install needed

No `jq`, no bash, no special tools.

## Fast path (recommended)

1. Install from your editor's extension panel:
   - **Vanilla VS Code:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=harteWired.claudelikebar) — search "Claudelike-Bar".
   - **VSCodium / Cursor / forks:** [Open VSX](https://open-vsx.org/extension/harteWired/claudelike-bar) — search "Claudelike Bar".
2. Open VS Code — a notification prompts: **"Claudelike Bar needs hooks to track terminal status. Set up your projects now?"**
3. Click **Set Up Projects** to run the wizard, or **Install Hooks Only** for a minimal start.

The extension writes a hook script to `~/.claude/hooks/dashboard-status.js` and registers event handlers in `~/.claude/settings.json`. Config lives at `~/.claude/claudelike-bar.jsonc` — a single file across all workspaces. Tiles start updating on your next Claude turn.

You can also trigger install manually: `Cmd+Shift+P` → **Claudelike Bar: Install Hooks**.

## Dev Containers / Codespaces

Pick the right extension ID for your editor's gallery:

- **Vanilla VS Code** (Microsoft Marketplace): `harteWired.claudelikebar`
- **VSCodium / Cursor / forks** (Open VSX): `harteWired.claudelike-bar`

Drop the matching ID into `customizations.vscode.extensions` in `devcontainer.json` and the gallery handles install on attach.

If you want belt-and-suspenders self-heal — for example, environments where the gallery install silently fails — add this to your container's `postAttachCommand`. Idempotent across rebuilds:

```bash
if ! code --list-extensions 2>/dev/null | grep -qE 'harteWired\.claudelike-?bar'; then
  curl -sL https://github.com/harteWired/claudelike-bar/releases/latest/download/claudelike-bar.vsix \
    -o /tmp/clb.vsix \
    && code --install-extension /tmp/clb.vsix
fi
```

Or point directly at a pinned version instead of `latest`:

```bash
code --install-extension https://github.com/harteWired/claudelike-bar/releases/download/v0.14.0/claudelike-bar-0.14.0.vsix
```

Everything else (hooks, config, sounds, statusline) lives in `~/.claude/` — persist that directory via a Docker volume and rebuilds don't touch your setup.

## Command line

Clone the repo and run:

```bash
./setup.sh
```

Builds the extension, installs the VSIX, copies the hook script, and merges `settings.json` entries. Idempotent — safe to re-run.

## Manual setup

If you prefer to see every step yourself:

### 1. Build and install the extension

```bash
npm install
npm run package
code --install-extension claudelike-bar-*.vsix --force
```

### 2. Copy the hook script

```bash
cp hooks/dashboard-status.js ~/.claude/hooks/
chmod +x ~/.claude/hooks/dashboard-status.js
```

### 3. Register hooks

Add these under the `"hooks"` key in `~/.claude/settings.json`. If you already have hooks for these events, add the dashboard entry alongside your existing ones — don't replace them.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-status.js" }] }]
  }
}
```

> [!NOTE]
> On Windows, prefix the command with `node` so it doesn't depend on shebang interpretation:
> `"node \"C:/Users/you/.claude/hooks/dashboard-status.js\""`.
> The `setup.sh` / `merge-hooks.js` flow handles this automatically.

### 4. Reload VS Code

`Cmd+Shift+P` → **Reload Window**.

## After install: set up your projects

Three options, pick whichever feels least like work:

**Setup Wizard** — `Cmd+Shift+P` → **Claudelike Bar: Set Up Projects**. Walks you through 5 steps: pick folders, confirm names, assign colors, choose a startup command, review. Projects auto-start on the next VS Code launch.

**Let Claude do it** — open a Claude Code terminal and say: *"Walk me through configuring the Claudelike Bar."* Claude reads `~/.claude/claudelike-bar.jsonc`, asks which projects you care about, sets up auto-start, picks a personality mode, assigns colors, and nudges you to drag tiles into order.

**Edit the config directly** — `Cmd+Shift+P` → **Claudelike Bar: Open Config**. The JSONC file is documented with inline comments.

## Upgrading

```bash
cd claudelike-bar
git pull
./setup.sh
```

The setup script is idempotent — it won't duplicate hooks or break existing config.
