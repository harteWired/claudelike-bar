import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkForDuplicateInstall, type DuplicateDetectDeps } from '../src/duplicateExtension';

const HYPHENATED = 'harteWired.claudelike-bar';
const NO_HYPHEN = 'harteWired.claudelikebar';

function makeDeps(overrides: Partial<DuplicateDetectDeps> = {}): DuplicateDetectDeps & {
  getPeerExtension: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    ownId: HYPHENATED,
    getPeerExtension: vi.fn(() => undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as any;
}

describe('checkForDuplicateInstall (#32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "no-peer" when own id is not in KNOWN_IDS', async () => {
    const deps = makeDeps({ ownId: 'someone-else.unrelated-extension' });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('no-peer');
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it('returns "no-peer" when peer extension is not installed', async () => {
    const deps = makeDeps({ getPeerExtension: vi.fn(() => undefined) });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('no-peer');
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it('prompts when own id is the lexicographic prompter and peer is installed', async () => {
    // HYPHENATED ('harteWired.claudelike-bar') sorts before NO_HYPHEN ('harteWired.claudelikebar')
    // because '-' (0x2D) < 'b' (0x62) at the comparison point.
    const deps = makeDeps({
      ownId: HYPHENATED,
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });
    await checkForDuplicateInstall(deps);
    expect(deps.showInformationMessage).toHaveBeenCalledTimes(1);
    const [msg, ...actions] = deps.showInformationMessage.mock.calls[0];
    expect(msg).toContain('Two copies of Claudelike Bar');
    expect(actions).toContain(`Keep ${HYPHENATED}`);
    expect(actions).toContain(`Keep ${NO_HYPHEN}`);
  });

  it('returns "follower" without prompting when own id is the lexicographic loser', async () => {
    const deps = makeDeps({
      ownId: NO_HYPHEN, // sorts after HYPHENATED, so HYPHENATED is the prompter
      getPeerExtension: vi.fn(() => ({})),
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('follower');
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });

  it('uninstalls peer when user picks "Keep this version"', async () => {
    const showMessage = vi.fn()
      .mockResolvedValueOnce(`Keep ${HYPHENATED}`)
      .mockResolvedValueOnce(undefined); // user dismisses reload prompt
    const deps = makeDeps({
      ownId: HYPHENATED,
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: showMessage,
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('kept-self');
    expect(deps.uninstall).toHaveBeenCalledWith(NO_HYPHEN);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('uninstalls self when user picks "Keep the other"', async () => {
    const showMessage = vi.fn()
      .mockResolvedValueOnce(`Keep ${NO_HYPHEN}`)
      .mockResolvedValueOnce('Reload Now');
    const deps = makeDeps({
      ownId: HYPHENATED,
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: showMessage,
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('kept-peer');
    expect(deps.uninstall).toHaveBeenCalledWith(HYPHENATED);
    expect(deps.reload).toHaveBeenCalled();
  });

  it('returns "dismissed" without uninstalling when user closes the prompt', async () => {
    const deps = makeDeps({
      ownId: HYPHENATED,
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('dismissed');
    expect(deps.uninstall).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('swallows thrown errors and returns "errored"', async () => {
    const deps = makeDeps({
      ownId: HYPHENATED,
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: vi.fn(() => { throw new Error('boom'); }),
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('errored');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('errored'));
  });

  it('matches own id case-insensitively (VS Code lowercases ids on install)', async () => {
    // VS Code persists extension ids in lowercase. context.extension.id may
    // arrive as 'hartewired.claudelike-bar' even though package.json has the
    // mixed-case form.
    const deps = makeDeps({
      ownId: HYPHENATED.toLowerCase(),
      getPeerExtension: vi.fn(() => ({})),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('dismissed');
    expect(deps.showInformationMessage).toHaveBeenCalled();
  });

  it('does not prompt the follower even when ids differ in case', async () => {
    const deps = makeDeps({
      ownId: NO_HYPHEN.toLowerCase(),
      getPeerExtension: vi.fn(() => ({})),
    });
    const result = await checkForDuplicateInstall(deps);
    expect(result).toBe('follower');
    expect(deps.showInformationMessage).not.toHaveBeenCalled();
  });
});
