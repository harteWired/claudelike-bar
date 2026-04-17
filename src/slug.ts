/**
 * Slug derivation for project identity.
 *
 * A slug is a short, unique, filesystem-safe string used as:
 *   - the config key in `.claudelike-bar.jsonc`
 *   - the terminal name in VS Code
 *   - the `CLAUDELIKE_BAR_NAME` env var
 *   - the status filename (`{slug}.json`)
 *
 * Derived from the project's absolute path by taking the last N path
 * segments, lowercased, joined by hyphens, with non-alphanumeric chars
 * replaced. Collision-resistant: if the basename alone collides, we
 * prepend parent segments until it's unique.
 */

/**
 * Sanitize a raw path-derived string into a valid slug.
 * Lowercase, replace non-alphanumeric runs with hyphens, strip
 * leading/trailing hyphens.
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a unique slug from an absolute path. Starts with the basename
 * and prepends parent segments until the slug doesn't collide with
 * `existingSlugs`. Falls back to a numeric suffix if 4 segments deep
 * still collides.
 *
 * Examples:
 *   /home/user/projects/api          → "api"
 *   /home/user/work/client-a/api     → "client-a-api" (if "api" taken)
 *   /home/user/personal/api          → "personal-api" (if "api" taken)
 */
export function deriveSlug(
  absolutePath: string,
  existingSlugs: Set<string>,
): string {
  const segments = absolutePath.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return 'unknown';

  const maxDepth = Math.min(segments.length, 4);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const slug = sanitizeSlug(segments.slice(-depth).join('-'));
    if (slug && !existingSlugs.has(slug)) return slug;
  }

  // All depths collide — append a numeric suffix to the deepest attempt.
  const base = sanitizeSlug(segments.slice(-Math.min(segments.length, 3)).join('-')) || 'project';
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  throw new Error(`Cannot derive a unique slug for ${absolutePath}`);
}

/**
 * Normalize an existing config key into a valid slug. Used during
 * migration when config keys are terminal display names (may have
 * spaces, caps, special chars).
 *
 * Examples:
 *   "VS Code Enhancement"  → "vs-code-enhancement"
 *   "3d-printing"          → "3d-printing"
 *   "Vault Direct"         → "vault-direct"
 */
export function normalizeToSlug(name: string): string {
  const slug = sanitizeSlug(name);
  return slug || 'unknown';
}
