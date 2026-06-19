# Launch-Request Contract v1 (DRAFT)

> **Status: design-lock draft.** Not yet built — no greenlight for implementation.
> Issue #31 ("spawn a Claude Code terminal from Telegram"). Sibling to
> [`STATUS-FILE-CONTRACT.md`](STATUS-FILE-CONTRACT.md).

A neutral, launcher-agnostic protocol for **requesting that a Claude Code session be
launched**, decoupled exactly the way the status-file protocol decouples writers from
readers. A *requester* (e.g. belfry's `/spawn`) drops a request file; a *launcher* (e.g.
this extension, or a plain tmux script) consumes it. Neither side depends on the other —
they agree only on the file shape below.

- **No owner.** belfry does not own this; claudelike-bar does not own this. Any tool may
  write a request; any tool may consume one.
- **claudelike-bar is one optional launcher**, never required. A standalone-belfry user
  with a shell/tmux launcher works without it; a standalone-CLB user never has to enable it.

This document is the source of truth. If code and this doc disagree, the doc is the
intent and the code is the bug — fix the code.

---

## §A — Request directory

Every requester and launcher resolves the request directory identically — **ephemeral**,
mirroring the status-dir resolver so the two stay in lock-step:

```
1. $CLAUDE_LAUNCH_REQUESTS_DIR    (canonical override; trimmed)
2. POSIX:  /tmp/claude-launch-requests       (a FIXED literal)
   win32:  os.tmpdir()/claude-launch-requests
```

A **separate** directory from `/tmp/claude-dashboard` — not a subdirectory of it. The
status dir is watched with a `*.json` glob and every file there is interpreted as a status
update; mixing launch requests in would cross the two watchers' wires. Sibling, not child.

**Ephemeral on purpose.** Requests are one-shot and must not survive a reboot — a stale
durable request firing a spawn on next activation is the exact footgun §C's freshness gate
guards against; tmp + freshness is belt-and-suspenders.

**Permissions.** The directory is created `0700` and request files written `0600`
(owner-only). For a dumb launcher the request file *is* an exec surface, so owner-only
means the only entity that can write a request is the user themselves — who already has a
shell. No privilege boundary is crossed.

```js
function resolveLaunchRequestsDir() {
  const explicit = (process.env.CLAUDE_LAUNCH_REQUESTS_DIR || '').trim();
  if (explicit) return explicit;
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claude-launch-requests')
    : '/tmp/claude-launch-requests';
}
```

---

## §B — Request payload

One request per file: `<dir>/<slug>.json`. The filename stem is the slug (slug naming +
sanitize identical to the Status-File Contract §C — `[\r\n]`→'', `[/\\:*?"<>|]`→'_', strip
leading/trailing dots).

```jsonc
{
  "slug":    "api",                              // REQUIRED. The session identity.
  "ts":      1750000000,                          // REQUIRED. Unix seconds; freshness gate (§C).
  "resume":  "550e8400-e29b-41d4-a716-446655440000", // OPTIONAL. Resume an existing session.
  "command": "claude --channels server:belfry",   // OPTIONAL HINT. See below.
  "cwd":     "/workspace/projects/api"             // OPTIONAL HINT. See below.
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `slug` | yes | The session/project identity. The only field a security-conscious launcher trusts. |
| `ts` | yes | Unix seconds when written. Launchers reject requests older than the freshness window (§C). |
| `resume` | no | A session UUID to resume. Launchers that honor it MUST validate it as a UUID before use. |
| `command` | no | **A hint, not a directive.** A *dumb* launcher (tmux/plain shell) MAY exec it verbatim. A *security-conscious* launcher (CLB) **ignores it** and derives its own command (§D). |
| `cwd` | no | **A hint.** A dumb launcher with no registry MAY use it. CLB ignores it and resolves cwd from its own registered-project config (§D). |

The split is deliberate: `command`/`cwd` keep a no-registry launcher whole, while a
launcher that has its own trusted source of truth never executes requester-supplied
strings.

---

## §C — Launcher consume semantics

A launcher that opts in (see §D) watches the request dir and, for each `<slug>.json`:

1. **Freshness gate.** If `now - ts > FRESHNESS_WINDOW` (recommended **60s**), delete the
   file and ignore it. Guards against stale/replayed requests firing on activation.
2. **Atomic consume.** Read → act → `unlink()` the request file, exactly once. The unlink
   happens regardless of launch success, so a config reload or dir re-scan can never
   double-launch from the same request.
3. **Idempotent launch.** If a session for `slug` is already live, focus it rather than
   spawning a duplicate. (CLB's `launchRegisteredProject` already focuses-not-duplicates.)

A launcher SHOULD also sweep stale request files on startup (same freshness gate) so a
request written while the launcher was down doesn't fire late.

---

## §D — Security model (launcher side)

Auto-launching a process from a file is an RCE-adjacent capability. A conforming launcher
MUST apply all of:

1. **Opt-in, default off.** The behavior is dormant until the user explicitly enables it
   (CLB: `acceptLaunchRequests: false` by default). A user who never wants it carries no
   watcher and no attack surface.
2. **Trust gate.** Honor the host's workspace-trust state. CLB ignores all requests when
   `vscode.workspace.isTrusted` is false — the same gate that already disables autostart
   (an identical RCE surface; `untrustedWorkspaces` is declared in the manifest).
3. **Slug, not command.** A security-conscious launcher derives the command from its **own
   trusted config**, never from the request's `command` field. CLB resolves `slug` →
   registered project and runs the user-configured command (`getAutoStartCommand`),
   optionally appending only a **constrained, regex-validated** channel/resume flag:
   - `--channels server:<slug>` where `<slug>` matches `^[A-Za-z0-9._-]+$`
   - `--resume <uuid>` where `<uuid>` matches the UUID grammar

   A stray or malicious request can therefore cause at most
   `<user's own configured claude command> --channels server:<slug>` — never arbitrary
   code. The path is **RCE-proof by construction**: it can only run a command the user
   already configured for a project they already registered.
4. **Registered-slug gate + cwd preflight.** CLB launches only slugs registered in **its
   own** config (it needs that entry for command/env/cwd anyway). Unknown slug → reject,
   don't guess (same STRICT philosophy as the slug contract). If the resolved cwd doesn't
   exist, reject (CLB's `launchRegisteredProject` already preflights `cwdExists`).

---

## The standalone boundary (documented honestly)

Because CLB launches only slugs it has registered, **`/spawn <slug>` reaches a VS Code
integrated terminal only when `<slug>` is a registered CLB project on a launcher host that
has opted in and is trusted.** Outside that:

- **Unregistered slug, or no CLB present** → the requester falls back to its own
  dumb-launcher path (using the `command`/`cwd` hints) or emits a copyable command. The
  request protocol still "works"; it just isn't CLB that fulfills it.
- A standalone-belfry user therefore needs no CLB and no registry: belfry provides inline
  `/spawn <slug> --cwd <path>` + a belfry-side CLI to resolve cwd, and writes a
  constrained `command` hint (`claude --channels server:<slug>`) for its dumb launcher.

This is the intended decoupling, not a gap: the contract guarantees a *request shape*, not
that any particular launcher is installed.

---

## /kill — deferred to v2

v1 is **spawn-only**. Killing is intentionally out of scope on the launcher side:

- belfry's `/kill` SIGTERMs the belfry-mcp channel via its registry PID — it kills the
  *channel*, not the terminal, and does not touch CLB-owned terminals. That stays as-is.
- CLB does **not** participate in kill in v1. Disposing a VS Code terminal from a file is
  more destructive than spawning (it tears down a live pty, possibly mid-task).
- A future v2 launcher-side close, if pursued, MUST be gated behind: the same opt-in flag +
  trust gate + **provenance** — a launcher may only close a terminal it itself spawned from
  a tracked request, never a terminal the user opened by hand.

---

## Canonical decisions (frozen for v1)

- Request dir is **ephemeral** (`/tmp/claude-launch-requests`), `0700`/`0600`, env override
  `CLAUDE_LAUNCH_REQUESTS_DIR`. Separate from the status dir.
- Payload key is **`slug`**; `command`/`cwd` are optional hints, not directives.
- Launcher behavior is **opt-in, default off**, trust-gated, slug-not-command, registered-only.
- Consume is **atomic** (read→act→unlink) with a **60s freshness gate**.
- **Spawn-only.** /kill stays the requester's channel-kill; launcher-side close is v2.

---

## Implementations

| Concern | claudelike-bar (launcher) | belfry (requester) |
|---------|---------------------------|--------------------|
| §A dir resolution | `resolveLaunchRequestsDir` (TBD, mirrors `getStatusDir`) | mirror in belfry writer |
| §B payload | reads `slug` (+ validated `resume`); ignores `command`/`cwd` | writes `slug`, `ts`, optional `command`/`cwd` hints |
| §C consume | watcher: freshness → atomic unlink → idempotent launch (TBD) | — (write-only) |
| §D security | opt-in flag + trust gate + slug→config command + registered gate (TBD) | constrains the hint to `claude --channels server:<slug>` |
| /kill | — (v1 none) | channel-kill via registry PID (unchanged) |

Cross-reference: [`STATUS-FILE-CONTRACT.md`](STATUS-FILE-CONTRACT.md) for the sibling
status protocol and the shared slug/sanitize rules.
