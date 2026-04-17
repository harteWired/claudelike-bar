import { describe, it, expect } from 'vitest';
import { deriveSlug, sanitizeSlug, normalizeToSlug } from '../src/slug';

describe('sanitizeSlug', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeSlug('My Project')).toBe('my-project');
  });

  it('strips leading/trailing hyphens', () => {
    expect(sanitizeSlug('--api--')).toBe('api');
  });

  it('collapses consecutive non-alphanumeric runs', () => {
    expect(sanitizeSlug('a___b...c')).toBe('a-b-c');
  });

  it('handles Windows path segments', () => {
    expect(sanitizeSlug('Documents\\Claude Code')).toBe('documents-claude-code');
  });

  it('preserves numbers', () => {
    expect(sanitizeSlug('3d-printing')).toBe('3d-printing');
  });

  it('returns empty string for all-special input', () => {
    expect(sanitizeSlug('...')).toBe('');
  });
});

describe('deriveSlug', () => {
  it('uses basename when no collision', () => {
    expect(deriveSlug('/home/user/projects/api', new Set())).toBe('api');
  });

  it('prepends parent on collision', () => {
    expect(deriveSlug('/home/user/work/client-a/api', new Set(['api']))).toBe('client-a-api');
  });

  it('prepends grandparent on double collision', () => {
    const taken = new Set(['api', 'client-b-api']);
    expect(deriveSlug('/home/user/work/client-b/api', taken)).toBe('work-client-b-api');
  });

  it('falls back to numeric suffix when all depths collide', () => {
    const taken = new Set(['api', 'a-api', 'b-a-api', 'c-b-a-api']);
    const slug = deriveSlug('/c/b/a/api', taken);
    expect(slug).toBe('b-a-api-2');
  });

  it('handles Windows paths', () => {
    expect(deriveSlug('C:\\Users\\Matt\\Documents\\Claude Code\\my-project', new Set())).toBe('my-project');
  });

  it('handles Windows path collision by prepending parent', () => {
    const taken = new Set(['my-project']);
    expect(deriveSlug('C:\\Users\\Matt\\Documents\\Claude Code\\my-project', taken)).toBe('claude-code-my-project');
  });

  it('handles trailing slashes', () => {
    expect(deriveSlug('/home/user/projects/api/', new Set())).toBe('api');
  });

  it('returns "unknown" for empty path', () => {
    expect(deriveSlug('', new Set())).toBe('unknown');
  });

  it('handles path with spaces in segments', () => {
    expect(deriveSlug('/home/user/Claude Code/Chief of Staff', new Set())).toBe('chief-of-staff');
  });

  it('handles deep monorepo paths', () => {
    const taken = new Set(['api']);
    expect(deriveSlug('/repo/packages/backend/api', taken)).toBe('backend-api');
  });
});

describe('normalizeToSlug', () => {
  it('converts display names to slugs', () => {
    expect(normalizeToSlug('VS Code Enhancement')).toBe('vs-code-enhancement');
  });

  it('passes through already-valid slugs', () => {
    expect(normalizeToSlug('3d-printing')).toBe('3d-printing');
  });

  it('converts Vault Direct', () => {
    expect(normalizeToSlug('Vault Direct')).toBe('vault-direct');
  });

  it('returns "unknown" for empty string', () => {
    expect(normalizeToSlug('')).toBe('unknown');
  });
});
