# Proposal: Unattended-Session Hang Fix (#333/#334)

**Status:** gate-ready draft — NOTHING applied. Author: computer-use (Jinn). Scope: Jinn CLB
sessions only. Hana's jailed Fornax `hana-agent` is entirely out of scope and untouched.

## Problem

On 2026-07-14 two always-on belfry sessions (`life-planner`, `wintermute`) went dark and sat
dead for ~3 days until Matt returned and un-stuck them by hand. They were alive the whole time,
belfry kept delivering messages to them ("delivered to 1 instance"), but they never responded.

### Root cause (from the transcripts — NOT a permission prompt)

Both sessions already run `--dangerously-skip-permissions` (`bypassPermissions`), so tool-permission
prompts are already suppressed. The hangs were:

- **life-planner:** called `AskUserQuestion` at `2026-07-14T19:48:00`; the answer didn't arrive
  until `2026-07-17T03:52` (~3 days). It was confirming a second-hand approval relayed through
  another agent and asked Matt directly. The blocking modal owned stdin; belfry messages queued
  unprocessed behind it.
- **wintermute:** no blocking tool in the transcript — last action a belfry `send_to` at
  `10:38`, an idle `away_summary` at `10:41`, then deaf until resume at `03:54`. A TUI-level stall
  (auto-compact / trust / MCP-reconnect / update modal) or input-pump wedge, below the conversation
  layer.

**Common root:** an unattended session + *any* human-required interaction + no supervisor = an
indefinite hang. There is no native prompt-timeout in Claude Code (confirmed).

## Critical design constraint discovered

`hooks/dashboard-status.js` maps **both `Stop` and `Notification` → `status: "ready"`**. So a
session *blocked on a prompt* writes the same status as a session that *finished its turn and is
idle*. **The status file alone cannot distinguish "wedged" from "healthy idle."** The watchdog
therefore needs two things the current pipeline doesn't provide:

1. A **distinct waiting signal** — enhance the `Notification` branch of the hook to record that the
   session is *waiting for input* (not just "ready"), with a timestamp.
2. **Delivery-vs-activity correlation** — for the `wintermute`-class deaf-idle (no Notification
   fires at all), detect "belfry delivered an inbound but the session produced no new assistant
   turn within N minutes." This reuses the exact signature used to diagnose the incident.

## The fix — three layers

### A. Kill the blocking modal (the life-planner root cause)

Change the belfry launch command (`~/.claude/claudelike-bar.jsonc`: the top-level `claudeCommand`
and every belfry-cluster terminal `command`). Diff:

```diff
- claude --dangerously-skip-permissions --mcp-config /workspace/shared/belfry-mcp.json --dangerously-load-development-channels server:belfry
+ claude --permission-mode default \
+   --disallowedTools AskUserQuestion ExitPlanMode \
+   --mcp-config /workspace/shared/belfry-mcp.json \
+   --dangerously-load-development-channels server:belfry \
+   --append-system-prompt "You have no interactive question tool. When you need Matt's decision or input, send it to him asynchronously over belfry (mcp__belfry__send_to the human channel) and then continue or park — never wait on a blocking prompt."
```

`--disallowedTools` removes the tools regardless of permission mode, so A is safe to ship even
without C. (The same change applies to the other always-on claude clusters — the `--strict-mcp-config`
and telegram-plugin terminals — but NOT the `fleet-watch` terminal, which isn't claude.)

### C. Permission posture (target C2; C1 is a trivial flip)

Layer A above already swaps `--dangerously-skip-permissions` → `--permission-mode default`, which
activates the existing `permissions.allow[]` in `~/.claude/settings.json` +
`/workspace/.claude/settings.local.json` (safe tools run with no prompt).

- **C2 (target):** sensitive/unlisted tools **prompt** → Matt approves when present; if unanswered
  N minutes, the watchdog (B) auto-defers (Esc = treated as deny; the action is NOT executed and the
  session continues). This is exactly #334 "review-when-present, auto-defer-when-away." Requires B.
- **C1 (fallback):** add a `permissions.deny[]` list so those ops are hard-blocked (no prompt; the
  agent defers via belfry). Same list, different bucket — flipping C2→C1 is moving these entries in:

```jsonc
// ~/.claude/settings.json  ->  add under "permissions":
"deny": [
  "Bash(rm -rf *)",
  "Bash(git push --force*)",
  "Bash(git push -f *)",
  "Bash(dd *)",
  "Bash(mkfs*)",
  "Bash(sudo *)",              // the two safe sudo forms stay in allow[]; deny wins only on non-allowed sudo
  "Bash(* secrets.js set *)", // secrets-manager writes
  "Bash(node bin/secrets.js set *)"
  // cross-fleet mutations are covered case-by-case; the existing
  // block-age-key.sh / block-secret-leak.sh PreToolUse hooks already
  // hard-deny the secret/age-key class today (partial C1, live).
]
```

Under C2 these same patterns are simply left OUT of `deny[]` (unlisted → prompt). **Only Matt's
C1-vs-C2 pick selects the bucket; everything else is identical.**

### B. Watchdog / auto-recovery (catches both hang classes)

New module `src/hangWatchdog.ts` (this branch), wired once in `extension.ts`. It is self-contained
(VS Code terminal API + fs), coupling only to stable surfaces: the status dir (`getStatusDir()`),
the belfry daemon delivery log, and per-session transcripts.

**Signals**
1. Enhanced `Notification` status (hook change below) → session is *waiting for input* since T.
2. Belfry delivered an inbound to slug S (parsed from the daemon log) with no newer assistant turn
   in S's transcript → deaf-idle.
3. Terminal `exitStatus` / `onDidCloseTerminal` → the claude process exited.

**Recovery ladder** (per session, N = 5 min default, `hangWatchdog.timeoutMinutes` setting):
- exited → relaunch the cluster command (already ends in `/resume`).
- wedged > N → send `Esc` (clears a modal), wait 30s; still stalled → `Ctrl-C` then re-send the
  cluster command (with `/resume`).
- On the FIRST detected "waiting", ping Matt via belfry/Pushover so he can answer before the timer
  fires — this is what makes "review-when-present" actually work.

**Hook enhancement** (`hooks/dashboard-status.js`, installed by `setup.ts`) — make Notification
distinguishable from Stop:

```diff
- if (event === 'Stop' || event === 'Notification') status = 'ready';
+ if (event === 'Stop') status = 'ready';
+ else if (event === 'Notification') { status = 'waiting_input'; extra.waiting_since = Date.now(); }
```

The extension's state machine treats `waiting_input` as a live-but-attention state (NOT reaped, NOT
shown as offline). The watchdog reads `waiting_since` for the timer.

## Canary before fleet-wide

Apply to ONE non-critical session first and verify: (1) allow-listed tools still run silently;
(2) a sensitive op behaves per the chosen mode (C1 blocked / C2 prompts→auto-defers);
(3) a simulated wedge (a stuck prompt) auto-recovers within N+~0.5 min; (4) `AskUserQuestion` is
gone (agent routes questions to belfry). Only then roll to the rest of the belfry cluster.

## Files in this change

- `src/hangWatchdog.ts` (new) — the watchdog.
- `src/extension.ts` — one wiring line in `activate()` (diff below).
- `hooks/dashboard-status.js` — the Notification-signal enhancement (diff above).
- `~/.claude/claudelike-bar.jsonc` — launch command change (A + C; live file, applied on approval).
- `~/.claude/settings.json` — `deny[]` for C1 (live file, applied on approval; C2 = omit).

`extension.ts` wiring:

```diff
  // inside activate(), after the TerminalTracker / StatusWatcher are constructed:
+ import { HangWatchdog } from './hangWatchdog';
+ const hangWatchdog = new HangWatchdog(context);
+ hangWatchdog.start();
+ context.subscriptions.push(hangWatchdog);
```
