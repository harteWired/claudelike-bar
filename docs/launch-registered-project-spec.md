# Launch Registered Project — Design Spec

Status: proposed
Issue: [#14](https://github.com/aes87/claudelike-bar/issues/14)
Target: v0.13

## Summary

The config already has `autoStart: true | false` — data-level support for "register a project but don't launch it at startup." What's missing is UI sugar:

1. A way to launch a registered-but-closed project without editing the config or hunting through the terminal dropdown.
2. A way to register a project without forcing a terminal open at registration time.

This spec delivers both via a new command, a sidebar header button, a tile context-menu entry, and a one-question branch in the Register Project flow.

## Goals

- Launch any registered project — whether `autoStart: true` or `false` — in one click or one command invocation, regardless of whether its terminal is currently running.
- Let users register projects without spawning the terminal immediately (for "setting up the whole list, picking what to open later" workflow).
- Reuse the exact terminal-creation path that `runAutoStart` uses — no drift between auto-start and user-initiated launch.

## Non-goals

- Dim/offline tiles for closed registered projects (that's [#15](https://github.com/aes87/claudelike-bar/issues/15) — a larger evolution).
- A settings UI for flipping `autoStart` on existing entries — config editing stays via the gear → JSONC file.
- Bulk "launch all registered" action — possible but hasn't come up; add if users request it.
- Inline tile right-click to launch a *specific* unopened project by name (doesn't fit the context-menu model; the launcher QuickPick covers the same need better).

## Architecture

### Extract a shared launch primitive

`runAutoStart` in `extension.ts:361` loops over `configManager.getAutoStartTerminals()` and calls `createTerminal` with the config's env/cwd/shell options. Extract the body into a reusable helper so the auto-start loop and the new launcher command share one code path:

```typescript
// src/launchProject.ts (new)
export function launchRegisteredProject(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  name: string,
  log: LogFn,
): vscode.Terminal | undefined {
  if (tracker.getTerminalByName(name)) {
    log(`launch: ${name} already open, focusing`);
    tracker.getTerminalByName(name)?.show();
    return undefined;
  }
  const opts = configManager.getAutoStartTerminalOptions(name);
  const terminal = vscode.window.createTerminal({
    name,
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.shellPath ? { shellPath: opts.shellPath } : {}),
    ...(opts.shellArgs ? { shellArgs: opts.shellArgs } : {}),
  });
  const command = configManager.getAutoStartCommand(name);
  if (command) terminal.sendText(command);
  terminal.show();
  return terminal;
}
```

`runAutoStart` becomes a thin loop over the filtered name list calling `launchRegisteredProject`. Same for the new command. Pre-flight check for a missing cwd (see [#13](https://github.com/aes87/claudelike-bar/issues/13)) lives in this one function so both paths benefit.

### New `LaunchRegisteredProject` command

```typescript
// src/launchProject.ts
export async function executeLaunchProjectCommand(
  configManager: ConfigManager,
  tracker: TerminalTracker,
  log: LogFn,
): Promise<void> {
  const all = configManager.getAll();
  const openNames = new Set(tracker.getTiles().map((t) => t.name));
  const candidates = Object.entries(all)
    .filter(([name]) => !openNames.has(name))
    .sort(/* by order if manual, else by slug */);

  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      'Claudelike Bar: no registered projects to launch — everything in your config is already open.',
    );
    return;
  }

  const items: vscode.QuickPickItem[] = candidates.map(([name, cfg]) => ({
    label: cfg.nickname || name,
    description: name !== (cfg.nickname || name) ? name : undefined,
    detail: `${cfg.path ?? '(no path)'} · ${cfg.command || configManager.getAutoStartCommand() || '(no command)'}`,
    // Hint for path-missing entries (related to #13)
    ...(cfg.path && !existsOnDisk(cfg.path)
      ? { description: '(path missing)', alwaysShow: true }
      : {}),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Launch which project?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  launchRegisteredProject(configManager, tracker, picked.label, log);
}
```

### Register Project: one-question branch

Keep the existing `claudeDashboard.registerProject` command as-is (folder picker → slug → config write → open terminal) — it's the common case. Add a final QuickPick step *only when called via the "Register Project (Advanced)" variant*:

- **Option A (lean)**: one command, same behavior as today, but append a final one-question QuickPick: *"Open terminal now?"* → Yes / No. "No" sets `autoStart: false` and skips the `createTerminal` call.
- **Option B (two commands)**: keep `claudeDashboard.registerProject` as-is (always opens). Add `claudeDashboard.registerProjectOnly` that skips the open and sets `autoStart: false`.

**Recommendation: Option A.** One command, one QuickPick, minimal surface area. The existing default (open now) is preserved — existing muscle memory doesn't break. Option B doubles the command count for a subtle variant.

The QuickPick only fires when the user hits *Register Project* — the "+" sidebar button and the palette entry both route through it. Default-selected item is "Open terminal now" so a quick Enter-Enter through the flow matches today's behavior exactly.

### Sidebar header button

A new entry in `package.json` `contributes.menus.view/title` next to the existing "+":

```json
{
  "command": "claudeDashboard.launchProject",
  "when": "view == claudeDashboard.mainView",
  "group": "navigation"
}
```

Icon: `$(rocket)` (play/launch intent), or `$(play)` — pick during implementation based on visual weight next to the existing "+" (`$(add)`).

### Tile context menu

Add **"Launch another project…"** as a menu entry in `media/webview.js`'s `showContextMenu` (tile right-click). Posts a new message type `launchProject`; `extension.ts` dispatcher routes it to the same palette command.

Placement: below Mute/Unmute Audio and above the separator before Clone Terminal — it's a workflow action, not a per-tile state mutation.

## Config shape

**No changes.** Everything keys off existing fields (`autoStart`, `path`, `cwd`, `command`, `nickname`, `order`). The whole feature is UI for data that's already in the config.

## Commands

| Command | Behavior |
|---|---|
| `claudeDashboard.launchProject` *(new)* | QuickPick of config entries not currently open → launches the selected one via the shared helper. |
| `claudeDashboard.registerProject` *(modified)* | Folder picker + slug + final "Open now?" QuickPick. "Yes" → existing behavior (autoStart: true + createTerminal). "No" → autoStart: false, no terminal. |

Both registered in `package.json` `contributes.commands`. Prefix matches existing pattern.

## Files touched

| File | Change |
|---|---|
| `src/launchProject.ts` *(new)* | `launchRegisteredProject` shared helper + `executeLaunchProjectCommand` QuickPick wrapper. ~90 LOC. |
| `src/extension.ts` | Register the new command; route webview `launchProject` message; refactor `runAutoStart` to call `launchRegisteredProject` per entry. |
| `src/registerProject.ts` | Append the "Open terminal now?" QuickPick at the end; gate the `createTerminal` block on the answer; set `autoStart` based on the answer. |
| `media/webview.js` | New "Launch another project…" tile context-menu entry. |
| `src/types.ts` | Add `launchProject` to `WebviewMessage` union. |
| `package.json` | Register new command; add `view/title` menu entry for sidebar header button. |
| `README.md` | Short blurb in the Commands table + maybe a paragraph in the config section about the register-only flow. |

Tests:

- `test/launchProject.test.ts` *(new)* — filtering (already-open projects excluded), sort order by `order` when manual / slug when auto, empty-candidate message, launch-already-open focuses instead of creating duplicate, createTerminal options match `runAutoStart` exactly.
- `test/runAutoStart.test.ts` — update to target the extracted helper rather than its inline copy; ensure no behavior drift.
- `test/registerProject.test.ts` *(new if missing, add if exists)* — register-and-open path (default), register-only path (no createTerminal, autoStart: false), cancel at the final QuickPick.

## Open questions

1. **Icon choice for the sidebar button** — `$(rocket)` vs `$(play)` vs `$(folder-opened)`. Defer to implementation-time visual check next to the existing `$(add)`.
2. **When the user picks an entry whose `path` doesn't exist** — hard-skip, or attempt the launch anyway (VS Code will surface the "directory doesn't exist" error like [#13](https://github.com/aes87/claudelike-bar/issues/13))? My lean: filter them out of the QuickPick entirely with a "(N entries hidden — missing paths)" footer hint. Same validator logic as [#13](https://github.com/aes87/claudelike-bar/issues/13) will eventually use.
3. **`alwaysShow` for missing-path entries** vs silent filter — tradeoff between surfacing broken config (good for fixing it) and noise (bad for the common case). Flip a coin at implementation time; both are trivial to swap.
4. **Naming: "Register Project" staying as one command with a branch vs two commands.** Recommendation above is Option A (one command, one branch). If during implementation the branch feels like it regresses the common case, fall back to Option B.

## Risks

1. **Runaway terminals.** A user who registers 20 projects and hits the "+" button thinking it's the launcher could spawn 20 terminals via the wizard. Mitigated by: sidebar gets TWO buttons now (launch + register) with distinct icons; the Register Project flow still defaults to "Open now" so muscle memory is preserved.
2. **Drift between `runAutoStart` and `launchRegisteredProject`.** Mitigated by extraction — both call the same helper. The per-platform shellPath/shellArgs logic lives in one place.
3. **Tile appears then disappears.** If a user launches a registered project whose slug collides with something the terminal tracker already indexed but marked offline, behavior might flicker. `tracker.getTerminalByName(name)` guard handles the "already open" case; need to verify the "previously open, now dead" case doesn't create a duplicate tile. Test scenario to add.

## Rollout

v0.13.0:
- All changes additive. No breaking changes to config shape, commands, or keyboard shortcuts.
- Existing `registerProject` muscle memory preserved (default-Yes to "Open now?").
- Release notes: *"Register Project now asks whether to open the terminal immediately. New 'Launch Registered Project' command and sidebar button let you open any config entry on demand."*

## Depends on / blocks

- Can land independently of [#13](https://github.com/aes87/claudelike-bar/issues/13) (cwd pre-flight), but the "skip missing-path entries" hint in the QuickPick should reuse whatever validator [#13](https://github.com/aes87/claudelike-bar/issues/13) lands for consistency.
- Unblocks [#15](https://github.com/aes87/claudelike-bar/issues/15) — the offline-tile evolution. That issue's tile-click-to-launch path is the same `launchRegisteredProject` helper this spec extracts.
