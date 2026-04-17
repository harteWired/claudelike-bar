# Project Identity Architecture — Options

**Issue:** [#6](https://github.com/aes87/claudelike-bar/issues/6) — extension assumes all projects live under the workspace root.

## Problem Summary

Three things are coupled today that shouldn't be:

1. **Config location** — `.claudelike-bar.jsonc` lives in the first workspace folder. Users with multi-root workspaces, single-project folders, or no-folder windows can't use it.
2. **Project identity** — the hook uses `path.basename(cwd)` as the project key. Two projects named `api` in different trees collide in the status directory and in the config file.
3. **Onboarding** — no discovery flow. Terminals auto-populate the config when opened, but users with 15 projects across scattered directories have no "here are my projects, set them all up" path.

## Current Architecture (for reference)

```
User opens VS Code
  → extension reads .claudelike-bar.jsonc from workspace root
  → terminals auto-populate config entries keyed by terminal name
  → hook writes status to {os.tmpdir()}/claude-dashboard/{basename(cwd)}.json
  → extension matches terminal name ↔ status file project name (3-tier: exact/alias/normalized)
  → auto-start creates terminals with cwd + command from config
```

Identity chain: terminal display name ↔ config key ↔ hook project name ↔ status filename. All must agree, and all currently derive from `basename(cwd)` by default.

---

## Option A: Path-Keyed Config (minimal, backwards-compatible)

**Philosophy:** Keep everything where it is, but make identity robust by keying on absolute path instead of basename.

### Changes

1. **Add `path` to TerminalConfig** — the absolute project directory. Auto-populated from `cwd` when set, or from the hook's `cwd` on first status write. This is the **canonical identity**.

2. **Hook writes status files keyed on a slug of the full path**, not just basename:
   ```
   /home/user/work/client-a/api  →  work-client-a-api.json
   /home/user/personal/api       →  personal-api.json
   ```
   Slug = last N path segments (configurable, default 3), joined by `-`, sanitized. Human-readable, collision-resistant.

3. **Extension matches by `path` field first**, falls back to name-based 3-tier for backwards compat. A config entry with `path` set always wins over one without.

4. **Auto-migration on upgrade:** when the extension loads a config with entries that have `cwd` but no `path`, copy `cwd` into `path`. For entries with the old `cd /path && claude` pattern (already migrated to `cwd` by v0.9.5), `path` is set automatically.

### Onboarding flow

- Same as today — terminals auto-populate. The difference is that the `path` field makes them unambiguous.
- New: "Claudelike Bar: Register Project" command — opens a folder picker, adds an entry with `path` + `cwd` + default `command: "claude"`.

### Trade-offs

| Pro | Con |
|-----|-----|
| Smallest change, fully backwards-compatible | Config still in workspace root — multi-root/no-folder users still awkward |
| Status file slugs are human-readable | Slug collision still possible (unlikely with 3 segments) |
| No new concepts — `path` is just another config field | Users without `path` set fall back to basename (same bug, opt-in fix) |

### Effort: ~1 day

---

## Option B: User-Global Config (relocate config to ~/.claude/)

**Philosophy:** The config is about the user's Claude terminals, not about the workspace. Move it to the user's home directory so it works regardless of what's open in VS Code.

### Changes

1. **Config at `~/.claude/claudelike-bar.jsonc`** — next to `settings.json` and the hooks. One config across all workspaces.

2. **Terminal entries keyed by a user-chosen slug**, each with a required `path` field:
   ```jsonc
   "terminals": {
     "client-a-api": {
       "path": "/home/user/work/client-a/api",
       "cwd": "/home/user/work/client-a/api",
       "command": "claude",
       "color": "yellow",
       ...
     },
     "personal-api": {
       "path": "/home/user/personal/api",
       "cwd": "/home/user/personal/api",
       "command": "claude",
       "color": "green",
       ...
     }
   }
   ```
   The key IS the slug, `path` is the canonical identity, `cwd` defaults to `path` if unset.

3. **Hook derives slug from path** using the same algorithm as Option A. Extension matches by `path`.

4. **Workspace-local `.claudelike-bar.jsonc` becomes an optional override** — display preferences (colors, sort mode, personality) that are workspace-specific. Terminal entries in the workspace file merge over the global config. Users who only work in one workspace never touch the global file.

5. **Status files keyed by slug** (same as Option A).

### Onboarding flow

Two paths:

- **"I just want it to work"** — same as today. Extension auto-discovers terminals, writes entries to global config. `path` auto-set from first-observed `cwd`.
- **"Set up my projects"** — new command: "Claudelike Bar: Set Up Projects". Opens a multi-folder picker. For each selected folder: assigns a slug (basename, or prompted if collision), sets `path`, `cwd`, `command: "claude"`, default color from the taxonomy. Writes all entries at once. User drags to reorder, tweaks colors, done.

### Trade-offs

| Pro | Con |
|-----|-----|
| One config, any workspace, any layout | Breaking change for existing users — migration required |
| Slug-based keys are explicit and collision-free | Two config files to reason about (global + workspace override) |
| "Set Up Projects" wizard is the clean onboarding | Global config is a new concept for VS Code extensions (uncommon) |
| Path is first-class, not an afterthought | Users switching between machines need to sync `~/.claude/` |

### Effort: ~2-3 days

---

## Option C: Hybrid — Path Registry + Workspace Display Config

**Philosophy:** Separate identity (which projects exist, where they live) from display (how they look in the sidebar). Identity is global; display is per-workspace.

### Changes

1. **Project registry at `~/.claude/claudelike-bar-projects.json`** — a simple map of slug → absolute path. This is the single source of truth for "what projects does this user have."
   ```json
   {
     "client-a-api": "/home/user/work/client-a/api",
     "personal-api": "/home/user/personal/api",
     "mushroom-tek": "/home/user/hobbies/automated-martha-tek"
   }
   ```

2. **Workspace `.claudelike-bar.jsonc` stays where it is** — but it only controls display: colors, icons, nicknames, sort mode, personality, auto-start. Terminal entries reference slugs from the registry:
   ```jsonc
   "terminals": {
     "client-a-api": {
       "color": "yellow",
       "autoStart": true,
       "command": "claude --enable-auto-mode"
     }
   }
   ```
   `cwd` is resolved from the registry, not stored in the workspace config.

3. **Hook reads the registry** to resolve `cwd` → slug. Falls back to basename if unregistered (backwards compat).

4. **Status files keyed by slug.**

### Onboarding flow

- **"Claudelike Bar: Register Projects"** — folder picker, assigns slugs, writes registry.
- **"Claudelike Bar: Import to Workspace"** — given a registry, adds auto-start entries for selected projects into the workspace config.
- **"Walk me through it"** — Claude reads the registry, asks which projects to auto-start in this workspace, assigns colors.

### Trade-offs

| Pro | Con |
|-----|-----|
| Clean separation of concerns | Most complex — two files, a registry concept, slug resolution |
| Registry is tiny and portable (just paths) | Hook must read the registry on every fire (or cache it) |
| Workspace config is lightweight and shareable | Three-file system: registry + workspace config + status files |
| Multiple workspaces can show different subsets of the same projects | Over-engineered if most users have <10 projects |

### Effort: ~3-4 days

---

## Recommendation

**Option B for v0.11.** Here's why:

- Option A is the smallest fix but doesn't solve the config-location problem. Multi-root and single-project-folder users are still stuck. It's a patch, not a solution.
- Option C is clean but over-separates. The registry + workspace config split adds cognitive load for a problem that most users solve by listing their projects once.
- Option B puts everything in one file, in a location that always exists (`~/.claude/`), with a setup wizard that asks the right question ("where are your projects?") instead of relying on auto-detection from terminal names.

**Migration path:**
1. v0.9.x → v0.11: on first load, if `~/.claude/claudelike-bar.jsonc` doesn't exist but a workspace-local one does, copy it over (one-time migration). Log the action.
2. Workspace-local file becomes an override layer — existing users who don't touch anything keep working.
3. "Set Up Projects" wizard runs on first activation if no config exists anywhere.

**What ships first (v0.10.0, pre-v0.11):**
- `path` field added to TerminalConfig (Option A's minimal change)
- Path-based status file slugs (collision fix)
- "Register Project" command (single folder picker)
- This unblocks Matt's Windows setup immediately while the full B migration is built.

**What ships in v0.11:**
- Global config at `~/.claude/claudelike-bar.jsonc`
- "Set Up Projects" multi-folder wizard
- Migration from workspace-local config
- Workspace override layer
