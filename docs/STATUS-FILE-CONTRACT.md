# Status-File Contract v1

The status-file protocol shared by every writer and reader of the Claude-session
dashboard. Three independent codebases implement it and **must agree byte-for-byte**
on the rules below, or status files written by one become invisible to another:

- **claudelike-bar** — the published VS Code extension. Its hook (`hooks/dashboard-status.js`)
  writes status files; its watcher/GC (`src/statusDir.ts`, `src/statusWatcher.ts`) reads them.
- **belfry** — `bin/belfry-hook.js` writes status files; `lib/watcher.js` reads them.
  Slug + sanitize logic lives in `lib/slug.js`.
- Any other tool that drops a `<slug>.json` into the status directory.

This document is the source of truth. If code and this doc disagree, the doc is the
intent and the code is the bug — fix the code.

---

## §A — Status directory

Every writer and reader resolves the status directory identically:

```
1. $CLAUDELIKE_STATUS_DIR        (canonical override; trimmed)
2. $CLAUDE_DASHBOARD_DIR         (deprecated transition alias; trimmed)
3. POSIX:  /tmp/claude-dashboard       (a FIXED literal)
   win32:  os.tmpdir()/claude-dashboard
```

The POSIX default is a **literal**, never `os.tmpdir()`. Claude Code sets
`TMPDIR=/tmp/claude-<uid>` per process, so an `os.tmpdir()` default makes a hook with
no env var write to `/tmp/claude-1000/claude-dashboard` while another writer uses the
literal `/tmp/claude-dashboard` — two directories, desynced. That split is the original
bug this contract exists to prevent.

Reference (`hooks/dashboard-status.js` `resolveStatusDir`, mirrored in `src/statusDir.ts`):

```js
function resolveStatusDir() {
  const explicit = (process.env.CLAUDELIKE_STATUS_DIR || '').trim()
    || (process.env.CLAUDE_DASHBOARD_DIR || '').trim();
  if (explicit) return explicit;
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claude-dashboard')
    : '/tmp/claude-dashboard';
}
```

---

## §B — Slug resolution

The slug is the status filename stem (`<slug>.json`). Resolution order:

```
1. $CLAUDELIKE_BAR_NAME        explicit override the extension sets when it
                               auto-starts a terminal (name ≠ directory).
2. Ancestor-walk of the path index (~/.claude/claudelike-bar-paths.json):
   walk cwd, then each parent up to the filesystem root; the FIRST indexed
   path wins → its slug.
3. No match → STRICT (default) returns null and the writer writes NOTHING.
   Legacy mode (CLAUDELIKE_BAR_STRICT=0) falls back to basename(cwd).
```

**STRICT is default-on.** It is the fix for the subdir-junk problem: a terminal opened
in an unregistered directory (`cache/`, `docs/`, `inputs/`, …) used to mint a
`basename(cwd)` status file and a junk tile. Under STRICT it resolves nothing and skips
the write entirely. The `CLAUDELIKE_BAR_STRICT=0` escape hatch restores the old
basename behavior for tools that depend on it (e.g. belfry-mcp's legacy path).

The **ancestor-walk** (step 2) is what lets a terminal in a project *subdirectory* still
map to its real project instead of skipping: `/workspace/projects/api/src` walks up to
`/workspace/projects/api` and resolves to `api`.

Reference (`hooks/dashboard-status.js`):

```js
function lookupAncestor(cwd) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.claude', 'claudelike-bar-paths.json'), 'utf8'));
  } catch { return ''; }
  if (typeof index !== 'object' || index === null) return '';
  let dir = cwd.replace(/[/\\]+$/, '') || cwd;
  for (;;) {
    const hit = index[dir];
    if (typeof hit === 'string' && hit.length > 0) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

function resolveSlug(cwd) {
  const strict = process.env.CLAUDELIKE_BAR_STRICT !== '0';
  let project = (process.env.CLAUDELIKE_BAR_NAME || '').trim();
  if (!project) project = lookupAncestor(cwd);
  if (!project) {
    if (strict) return null;
    project = path.basename(cwd);
  }
  project = sanitize(project);            // §C
  if (!project) return strict ? null : 'unknown';
  return project;
}
```

### Index hygiene (extension side)

The path index is the **shared allowlist** both hooks read. The extension
(`configManager.writePathIndex`) is the only writer and guarantees:

- Keys are **normalized absolute paths, no trailing separator**.
- **No key is a strict ancestor of another key.** A broad entry (e.g. a bare
  `/workspace → "Shell"`) would otherwise capture every project beneath it via the
  ancestor-walk, so every unregistered subdir would resolve to that catch-all slug and
  STRICT-skip could never fire. Such ancestor entries are dropped; specific leaf entries
  are kept. The real catch-all terminal still works — it launches with its
  `CLAUDELIKE_BAR_NAME` env (step 1), which outranks the index.

---

## §C — Sanitize

Applied to the resolved slug before it becomes a filename. **Byte-identical** across
claudelike-bar (hook + extension) and belfry (`lib/slug.js`):

```js
project
  .replace(/[\r\n]/g, '')          // strip newlines
  .replace(/[\/\\:*?"<>|]/g, '_')  // POSIX separators + Windows-reserved chars
  .replace(/^\.+|\.+$/g, '');      // strip leading/trailing dots (no ".json" / "..")
```

An empty result after sanitize is treated as "no slug": STRICT skips, legacy uses
`'unknown'`.

---

## §D — Write semantics

- **Atomic write:** serialize to `<dir>/<slug>.json.tmp.<pid>` then `rename()` over the
  destination. Readers never see a half-written file.
- **Read-merge-write (multi-writer slugs):** when more than one writer may touch the same
  `<slug>.json`, a writer must **read the existing file first and merge**, clearing only
  the keys it owns and preserving foreign fields. belfry-hook owns
  `status / event / ts / last_prompt / last_response`; the extension's statusline owns
  `context_percent` (among others). Without read-merge, co-writing a shared slug clobbers
  the other party's fields.
- **Directory creation is gated:** create the status dir only once a write is actually
  going to happen (i.e. after the §B STRICT skip check). A skipped session leaves no
  directory side effect.

---

## §E — Activation-time GC (item C)

STRICT (§B) stops *new* junk from being minted, but the status dir can still hold orphans
from before the cutover, or `<slug>.json` for terminals that are long gone. The reader side
(`src/statusWatcher.ts` `sweepOrphanStatusFiles`) sweeps these on activation.

- **Reaped** (only when older than the stale window, default **24h**): `<slug>.json` whose
  slug is **not** in the §B allowlist (the path index), plus `*.tmp.<pid>` atomic-write
  orphans left by a crashed writer.
- **Kept regardless of age:** any slug in the allowlist (registered / path-bearing /
  autoStart terminals).
- **The mtime guard is the safety net.** An active terminal — even one tracked only by
  `CLAUDELIKE_BAR_NAME`, with no path-index entry — refreshes its file on every hook event,
  so it is never stale and never reaped.
- **Out of scope:** non-JSON files (`.debug`, `debug.log`) are never touched — `debug.log`
  is belfry's to rotate.
- **Fail safe:** if the allowlist can't be read (missing/unparseable index), GC is skipped
  entirely rather than risk over-reaping. GC is best-effort and never blocks activation.

---

## Canonical decisions (frozen)

- `CLAUDELIKE_STATUS_DIR` is the canonical env var; `CLAUDE_DASHBOARD_DIR` is a
  deprecated alias honored during transition.
- STRICT is **default-on**; `CLAUDELIKE_BAR_STRICT=0` is the legacy escape hatch.
- No migration drain: status files in a pre-contract `os.tmpdir()` directory are left to
  age out (or removed by a one-time sweep), not copied forward.

---

## Implementations

| Concern | claudelike-bar | belfry |
|---------|----------------|--------|
| §A dir resolution | `hooks/dashboard-status.js` `resolveStatusDir`; `src/statusDir.ts` `getStatusDir` | `bin/belfry-hook.js` `resolveStatusDir`; `lib/watcher.js` |
| §B slug + ancestor-walk + STRICT | `hooks/dashboard-status.js` `resolveSlug`/`lookupAncestor` | `lib/slug.js` `resolveSlug`/`lookupIndex` |
| §B index writer (allowlist) | `src/configManager.ts` `writePathIndex` | — (reads the same index) |
| §C sanitize | hook + extension | `lib/slug.js` |
| §D atomic + read-merge | hook + `src/statusWatcher.ts` | `bin/belfry-hook.js` `writeAtomic` |
| §E activation-time GC | `src/statusWatcher.ts` `sweepOrphanStatusFiles` | — (belfry rotates its own `debug.log`) |

Historical design notes: [`drafts/ancestor-walk-patch-draft.md`](drafts/ancestor-walk-patch-draft.md).
