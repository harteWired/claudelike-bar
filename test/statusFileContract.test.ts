import { describe, it, expect } from 'vitest';
import { isStrictAncestor, isTransientTerminalName } from '../src/configManager';

// Status-File Contract v1 §B — index hygiene helpers. These back
// writePathIndex's rule that no index key may be a strict ancestor of another
// (so a bare /workspace → "Shell" entry can't capture every project beneath it
// via the hook's ancestor-walk), and ensureEntry's transient-name guard.
describe('isStrictAncestor (index hygiene)', () => {
  it('is true for a real parent directory', () => {
    expect(isStrictAncestor('/workspace', '/workspace/projects/api')).toBe(true);
    expect(isStrictAncestor('/a', '/a/b')).toBe(true);
  });

  it('is false for identical paths', () => {
    expect(isStrictAncestor('/workspace/projects/api', '/workspace/projects/api')).toBe(false);
  });

  it('is false for a shared string prefix that is not a path boundary', () => {
    // /workspace is NOT an ancestor of /workspaceX, and api is not of apiv2.
    expect(isStrictAncestor('/workspace', '/workspaceX')).toBe(false);
    expect(isStrictAncestor('/workspace/projects/api', '/workspace/projects/apiv2')).toBe(false);
  });

  it('is false for unrelated leaf paths (e.g. Vault Direct survives)', () => {
    expect(isStrictAncestor('/workspace/projects/obsidian-vault/vault', '/workspace/projects/api')).toBe(false);
  });

  it('handles Windows separators', () => {
    expect(isStrictAncestor('C:\\ws', 'C:\\ws\\proj')).toBe(true);
    expect(isStrictAncestor('C:\\ws', 'C:\\wsX')).toBe(false);
  });

  it('drops the /workspace catch-all when a real project is also indexed', () => {
    // The concrete scenario item D fixes: with both entries present, /workspace
    // is a strict ancestor of the project path → it must be the dropped one.
    const entries = ['/workspace', '/workspace/projects/api'];
    const dropped = entries.filter((p) =>
      entries.some((other) => other !== p && isStrictAncestor(p, other)),
    );
    expect(dropped).toEqual(['/workspace']);
  });
});

describe('isTransientTerminalName (config-list hygiene)', () => {
  it('is true for empty or whitespace-only names', () => {
    expect(isTransientTerminalName('')).toBe(true);
    expect(isTransientTerminalName('   ')).toBe(true);
  });

  it('is true for spinner/Configuring… titles ending in an ellipsis', () => {
    expect(isTransientTerminalName('Configuring…')).toBe(true);
    expect(isTransientTerminalName('Installing...')).toBe(true);
  });

  it('is false for real project names', () => {
    expect(isTransientTerminalName('api')).toBe(false);
    expect(isTransientTerminalName('my-project')).toBe(false);
    expect(isTransientTerminalName('  api  ')).toBe(false);
  });
});
