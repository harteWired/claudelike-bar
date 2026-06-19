> **HISTORICAL (landed).** This draft has shipped — see the canonical
> [`../STATUS-FILE-CONTRACT.md`](../STATUS-FILE-CONTRACT.md). Kept for design context.
> Paths/scope below reflect the pre-landing plan (e.g. the now-deleted
> `claude-terminal-dashboard` clone); the contract is the source of truth.

# DRAFT — Ancestor-walk + STRICT skip patch for `dashboard-status.js`

> **Status:** DRAFT for peer review (vscode-enhancement → claudelike-bar), 2026-06-09.
> Implements Contract v1 items **A** (ancestor-walk), **B** (STRICT skip), and the
> **status-dir** fix (canonical `CLAUDELIKE_STATUS_DIR`, fixed POSIX literal).
> NOTHING in the live hook is edited until this draft is acked. Canonical contract
> home will be `claude-terminal-dashboard/docs/STATUS-FILE-CONTRACT.md` (landed in step E).

Target file (canonical, byte-identical to the deployed `~/.claude/hooks/dashboard-status.js`):
`claude-terminal-dashboard/hooks/dashboard-status.js`.

---

## Change 1 — Status directory (Contract §A)

**Current (lines 176–177):**
```js
const statusDir = process.env.CLAUDELIKE_STATUS_DIR
  || path.join(os.tmpdir(), 'claude-dashboard');
```
The `os.tmpdir()` default is the daemon-divergence bug: Claude Code sets
`TMPDIR=/tmp/claude-<uid>`, so a hook with no env var writes to
`/tmp/claude-1000/claude-dashboard` while the convention literal is `/tmp/claude-dashboard`.

**Proposed — extract a helper:**
```js
function resolveStatusDir() {
  const explicit = (process.env.CLAUDELIKE_STATUS_DIR || '').trim()
    || (process.env.CLAUDE_DASHBOARD_DIR || '').trim();   // deprecated alias, honored in transition
  if (explicit) return explicit;
  // POSIX: FIXED literal — invariant to per-process TMPDIR. Windows: OS temp dir.
  return process.platform === 'win32'
    ? path.join(os.tmpdir(), 'claude-dashboard')
    : '/tmp/claude-dashboard';
}
```
Call site becomes `const statusDir = resolveStatusDir();`. **Move `fs.mkdirSync(statusDir, …)`
to after the STRICT skip check** (Change 2) so skipped sessions don't create the dir.

---

## Change 2 — Slug resolution: ancestor-walk + STRICT (Contract §B/§C)

**Current (lines 241–266):** env → **exact-match** index → `basename(cwd)` → sanitize → `'unknown'`.
The exact-match is the junk factory — any subdir cwd misses and falls to basename.

**Proposed — replace with:**
```js
// Walk cwd then each parent up to filesystem root; first index hit wins.
// Layout-agnostic: the index content is the gate, no hardcoded /workspace.
function lookupAncestor(cwd) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.claude', 'claudelike-bar-paths.json'), 'utf8'));
  } catch { return ''; }
  if (!index || typeof index !== 'object') return '';
  let dir = cwd.replace(/[/\\]+$/, '') || cwd;
  for (;;) {
    const hit = index[dir];
    if (typeof hit === 'string' && hit.length > 0) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return '';   // reached root, no match
    dir = parent;
  }
}

// Returns the resolved slug, or null when STRICT says "no match → skip the write".
function resolveSlug(cwd) {
  const strict = process.env.CLAUDELIKE_BAR_STRICT !== '0';  // default ON
  let project = (process.env.CLAUDELIKE_BAR_NAME || '').trim();   // 1. explicit env
  if (!project) project = lookupAncestor(cwd);                     // 2. ancestor-walk index
  if (!project) {                                                  // 3. no match
    if (strict) return null;
    project = path.basename(cwd);                                 //    LEGACY escape hatch
  }
  project = project                                               // sanitize (byte-identical w/ belfry+CLB)
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) return strict ? null : 'unknown';
  return project;
}
```

Call site (after `if (!cwd) cwd = process.cwd();`):
```js
const project = resolveSlug(cwd);
if (project === null) return;          // STRICT no-match — write nothing
fs.mkdirSync(statusDir, { recursive: true });   // moved here from line 179
```

---

## Effect on the current 62 files

- Subdir junk (`docs`, `cache`, `inputs`, `itineraries`, `asbury-park-2026`, `gym-coach`,
  `soua`, …) → now resolve to their real parent project via ancestor-walk, so they stop
  being minted. Existing stale files are cleaned by CLB's GC (item C), not by this patch.
- Genuinely-unregistered dirs outside any index ancestor → STRICT skips (no file).

---

## ⚠ ONE DESIGN QUESTION FOR REVIEW — the `/workspace → "Shell"` index entry

The index contains `"/workspace": "Shell"`. With ancestor-walk, **anything under `/workspace`
that isn't inside a registered project subdir walks up to `/workspace` and resolves to
`"Shell"` — it never hits the STRICT skip.** So STRICT-skip only ever fires for cwds
*outside* `/workspace`.

Consequence: a brand-new project dir `/workspace/projects/<new-thing>` not yet in the index
shows up as **`Shell`** (not skipped, not `new-thing`). That's arguably fine (Shell = the
workspace catch-all) — but if the intent is "unregistered project dirs mint NO file until
registered," then `"/workspace": "Shell"` should be **removed from the index** (index
registration is CLB's territory, not the hook's). The code stays layout-agnostic either way;
this is purely an index-content decision.

**Need CLB's call:** keep `/workspace→Shell` as a catch-all, or drop it so new dirs skip?

---

## Rollout (my scope: E, A+B, F)

1. **E** — land `STATUS-FILE-CONTRACT.md` (transcribe frozen Contract v1) as canonical home.
2. **A+B** — apply Changes 1+2 to `claude-terminal-dashboard/hooks/dashboard-status.js`,
   then deploy-copy to `~/.claude/hooks/dashboard-status.js`.
3. **F** — de-dup: retire CLB's stale `claudelike-bar/hooks/dashboard-status.js`
   (delete or symlink → claude-terminal-dashboard). Confirm with CLB before deleting.
4. Update `docs/HOOKS.md` + `project-identity-plan.md` to point at the contract.

belfry mirrors §B/§C in `lib/slug.js` + belfry-hook; CLB does C/D/G.
