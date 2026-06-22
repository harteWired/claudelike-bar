---
name: release
description: Publish claudelike-bar to Open VSX and the VS Code Marketplace, tag the release, and cut a GitHub release. Use when the user wants to ship/publish/release a new version of the claudelike-bar extension, push it to the galleries, or asks why the published version is behind. Scoped to /workspace/projects/claudelike-bar.
---

# release — ship claudelike-bar to the galleries

Publishes the **current `package.json` version** of claudelike-bar to Open VSX +
VS Code Marketplace, tags it, and creates a GitHub release. Replaces the manual
`vsce package` → hand-publish dance that left the galleries stale (the reason
0.20.1–0.20.3 only ever existed as a local VSIX).

## When to use
- "publish / ship / release claudelike-bar", "push it to Open VSX / the Marketplace"
- "the published version is behind" / "update the galleries"

## How it works

One script does everything: `.claude/skills/release/release.sh`.

```bash
.claude/skills/release/release.sh            # release current package.json version
.claude/skills/release/release.sh --dry-run  # build + package only, show what would publish
.claude/skills/release/release.sh --no-marketplace
.claude/skills/release/release.sh --skip-tests   # CI already green
```

Steps, in order — each publish target is **best-effort and independently
reported**, so a Marketplace failure never blocks the Open VSX publish or tag:

1. **Preflight** — must be on `main`, clean tree; reads version from `package.json`.
2. **Tests** — `npm test` (skip with `--skip-tests`).
3. **Package** — `npm run package` → `claudelike-bar-<version>.vsix`.
4. **Open VSX** — `ovsx publish` (always).
5. **Marketplace** — `vsce publish --packagePath` (unless `--no-marketplace`).
6. **Tag** — `git tag -a vX.Y.Z` + push.
7. **GitHub release** — `gh release create` with the VSIX attached and notes
   pulled from the matching `CHANGELOG.md` section.

## Credentials

All tokens come from **secrets-manager at call time** and are passed to the
publishers via **environment variables** (`OVSX_PAT`, `VSCE_PAT`, `GH_TOKEN`) —
never argv, never echoed:

| Target            | secrets-manager namespace / key |
|-------------------|---------------------------------|
| Open VSX          | `openvsx` / `OVSX_PAT`          |
| VS Code Marketplace | `azure` / `AZURE_DEVOPS_PAT`  |
| GitHub release    | `github` / `GITHUB_PAT`        |

### Gallery identity split (important)

The two galleries use **different extension identities** — a legacy of the
`aes87 → harteWired` rebrand, and the reason a naive `vsce publish` fails:

| Gallery | id | name | displayName |
|---------|----|------|-------------|
| Open VSX (+ git) | `harteWired.claudelike-bar` | `claudelike-bar` (hyphen) | `Claudelike Bar` (space) |
| VS Code Marketplace | `harteWired.claudelikebar` | `claudelikebar` (no hyphen) | `Claudelike-Bar` (hyphen) |

`package.json` holds the Open VSX/git identity. The script **repackages a
Marketplace-only VSIX** with the no-hyphen name + hyphenated displayName, then
publishes that and restores `package.json`. Publishing the git identity to the
Marketplace fails on its global name/displayName uniqueness ("extension/display
name already exists"). The old `aes87.claudelike-bar` listing no longer exists —
MS declined the name transfer, so `harteWired.claudelikebar` is the canonical
Marketplace listing. The Azure PAT controls both `aes87` and `harteWired`.
If the Marketplace identity ever changes, edit `MKT_PUB/MKT_NAME/MKT_DISPLAY`
at the top of the Marketplace block in `release.sh`.

## To release a NEW version (not just re-publish current)

Bump `package.json` + add a `CHANGELOG.md` section first, commit to `main`, then
run the script — preflight refuses to run on a dirty tree or a version mismatch.

## CI note

`ci.yml` builds/tests/packages but does **not** publish. A future hardening is a
`release` job triggered on `v*` tags that runs this same publish path in CI; for
now this skill is the release path.
