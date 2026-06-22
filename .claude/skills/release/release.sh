#!/usr/bin/env bash
# release.sh — publish claudelike-bar to Open VSX + VS Code Marketplace, tag, GitHub release.
#
# Tokens are pulled from secrets-manager at call time and passed to the
# publishers via ENV VARS (OVSX_PAT / VSCE_PAT / GH_TOKEN) — never argv, never
# echoed — so they don't leak into `ps`, logs, or the terminal.
#
# Usage:
#   release.sh [version]                 # default: version from package.json
#   release.sh --dry-run                 # build + package, print what WOULD publish
#   release.sh --no-marketplace          # Open VSX + tag + GH release only
#   release.sh --skip-tests              # skip `npm test` (CI already green)
#
# Steps: preflight → test → package → Open VSX → Marketplace → git tag → GitHub release.
# Each publish target is best-effort and independently reported; a Marketplace
# failure (e.g. listing unpublished) does NOT abort the Open VSX publish or tag.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SECRETS_BIN="${SECRETS_MANAGER_BIN:-/workspace/projects/secrets-manager/bin/secrets.js}"
cd "$REPO_ROOT"

DRY_RUN=0; DO_MARKETPLACE=1; SKIP_TESTS=0; VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-marketplace) DO_MARKETPLACE=0 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

secret() { node "$SECRETS_BIN" get "$1" "$2" 2>/dev/null; }

# ── Preflight ────────────────────────────────────────────────────────────────
say "Preflight"
[ -f "$SECRETS_BIN" ] || die "secrets-manager not found at $SECRETS_BIN"
[ "$(git branch --show-current)" = "main" ] || die "not on main (on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || die "working tree dirty — commit or stash first"

PKG_VERSION="$(node -p "require('./package.json').version")"
VERSION="${VERSION:-$PKG_VERSION}"
[ "$VERSION" = "$PKG_VERSION" ] || die "requested $VERSION but package.json is $PKG_VERSION — bump package.json first"
TAG="v$VERSION"
VSIX="claudelike-bar-$VERSION.vsix"
ok "Releasing $TAG (publisher: $(node -p "require('./package.json').publisher"))"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  warn "tag $TAG already exists locally — will skip tagging"
fi

# ── Test ─────────────────────────────────────────────────────────────────────
if [ "$SKIP_TESTS" -eq 1 ]; then
  warn "skipping tests (--skip-tests)"
else
  say "Tests"
  npm test || die "tests failed — aborting release"
  ok "tests green"
fi

# ── Package ──────────────────────────────────────────────────────────────────
say "Package VSIX"
npm run package || die "npm run package failed"
[ -f "$VSIX" ] || die "expected $VSIX not produced"
ok "built $VSIX ($(du -h "$VSIX" | cut -f1))"

if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY RUN — would publish $VSIX to:"
  echo "  • Open VSX (ovsx)"
  [ "$DO_MARKETPLACE" -eq 1 ] && echo "  • VS Code Marketplace (vsce)"
  echo "  • git tag $TAG + GitHub release"
  exit 0
fi

# ── Open VSX ─────────────────────────────────────────────────────────────────
say "Publish → Open VSX"
OVSX_PAT="$(secret openvsx OVSX_PAT)"; export OVSX_PAT
[ -n "$OVSX_PAT" ] || die "OVSX_PAT empty from secrets-manager (openvsx/OVSX_PAT)"
if npx --no-install ovsx publish "$VSIX"; then
  ok "Open VSX: published $VERSION"
  OVSX_DONE=1
else
  warn "Open VSX publish failed (see output above)"
  OVSX_DONE=0
fi
unset OVSX_PAT

# ── VS Code Marketplace ──────────────────────────────────────────────────────
MKT_DONE=skipped
if [ "$DO_MARKETPLACE" -eq 1 ]; then
  say "Publish → VS Code Marketplace"
  VSCE_PAT="$(secret azure AZURE_DEVOPS_PAT)"; export VSCE_PAT
  if [ -z "$VSCE_PAT" ]; then
    warn "AZURE_DEVOPS_PAT empty — skipping Marketplace"
    MKT_DONE=no-token
  elif npx --no-install vsce publish --packagePath "$VSIX"; then
    ok "Marketplace: published $VERSION"
    MKT_DONE=1
  else
    warn "Marketplace publish failed (listing may be unpublished / PAT scope) — continuing"
    MKT_DONE=0
  fi
  unset VSCE_PAT
fi

# ── Git tag ──────────────────────────────────────────────────────────────────
say "Git tag"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  warn "tag $TAG exists — not re-tagging"
else
  git tag -a "$TAG" -m "Release $TAG" || die "git tag failed"
  git push origin "$TAG" || warn "git push tag failed (tag created locally)"
  ok "tagged + pushed $TAG"
fi

# ── GitHub release ───────────────────────────────────────────────────────────
say "GitHub release"
GH_TOKEN="$(secret github GITHUB_PAT)"; export GH_TOKEN
if [ -z "$GH_TOKEN" ]; then
  warn "GITHUB_PAT empty — skipping GitHub release (tag is pushed)"
elif gh release view "$TAG" >/dev/null 2>&1; then
  warn "GitHub release $TAG already exists — skipping"
else
  NOTES="$(awk -v ver="$VERSION" '
    $0 ~ "## \\[?"ver { grab=1; next }
    grab && /^## / { exit }
    grab { print }
  ' CHANGELOG.md 2>/dev/null)"
  [ -n "$NOTES" ] || NOTES="Release $TAG"
  if gh release create "$TAG" "$VSIX" --title "$TAG" --notes "$NOTES"; then
    ok "GitHub release $TAG created"
  else
    warn "gh release create failed (tag is pushed; create manually if needed)"
  fi
fi
unset GH_TOKEN

# ── Summary ──────────────────────────────────────────────────────────────────
say "Done — $TAG"
printf '  Open VSX:     %s\n' "$([ "${OVSX_DONE:-0}" = 1 ] && echo published || echo FAILED)"
printf '  Marketplace:  %s\n' "$MKT_DONE"
echo  '  (verify: https://open-vsx.org/extension/harteWired/claudelike-bar )'
