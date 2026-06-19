import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Webview JavaScript syntax guard.
 *
 * Vitest runs in Node and never loads media/webview.js — so a syntax error
 * in the webview script (e.g. duplicate `const` declarations, mismatched
 * braces) won't fail any unit test. Past incident: v0.13.4 shipped with
 * `const tile` declared twice in showContextMenu(); the unit suite was
 * green but the autoplay-smoke CI job timed out because the webview
 * script never registered its message listeners.
 *
 * This test catches that class of bug at the cheapest possible level by
 * round-tripping the file through `new Function(...)` — which validates
 * syntax without executing top-level DOM API calls.
 */
describe('webview.js syntax guard', () => {
  it('media/webview.js parses without syntax errors', () => {
    const file = path.resolve(__dirname, '../media/webview.js');
    const source = fs.readFileSync(file, 'utf8');
    expect(() => new Function(source)).not.toThrow();
  });

  // v0.19 — organizer panel webview. Same syntax-guard rationale: a stray
  // duplicate `const`, missing brace, or unterminated string in this file
  // would never fail any unit test (vitest runs in Node, organizer.js
  // runs in the webview), but would break the panel at runtime.
  it('media/organizer.js parses without syntax errors', () => {
    const file = path.resolve(__dirname, '../media/organizer.js');
    const source = fs.readFileSync(file, 'utf8');
    expect(() => new Function(source)).not.toThrow();
  });
});

/**
 * v0.19 (#49) — drop-preview footer copy is a pure function so its truth
 * table is the spec. The webview IIFE exposes it as
 * `globalThis.__organizerDropPreview` for testability — that's the only
 * escape hatch from the wrapping closure.
 */
describe('organizer.js dropPreview (#49)', () => {
  let dropPreview: (src: string, dst: string, isLive: boolean, name: string) => string | null;

  beforeAll(() => {
    const file = path.resolve(__dirname, '../media/organizer.js');
    const source = fs.readFileSync(file, 'utf8');
    // Stub the webview-only globals so the IIFE evaluates cleanly under Node.
    const stub = `
      const acquireVsCodeApi = () => ({ postMessage: () => {} });
      const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createElement: () => ({
          appendChild: () => {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          addEventListener: () => {},
          setAttribute: () => {},
          dataset: {},
          style: { setProperty: () => {} },
        }),
      };
      const window = { addEventListener: () => {} };
      ${source}
    `;
    new Function(stub)();
    dropPreview = (globalThis as any).__organizerDropPreview;
  });

  it('returns null for same-lane drops', () => {
    expect(dropPreview('pinned', 'pinned', true, 'foo')).toBe(null);
    expect(dropPreview('auto', 'auto', true, 'foo')).toBe(null);
  });

  it('closed → pinned reads as Launch + pin', () => {
    expect(dropPreview('closedVisible', 'pinned', false, 'foo')).toBe('Launch + pin foo');
  });

  it('closed → auto reads as Launch', () => {
    expect(dropPreview('closedVisible', 'auto', false, 'foo')).toBe('Launch foo');
  });

  it('live → closedVisible reads as Close', () => {
    expect(dropPreview('auto', 'closedVisible', true, 'foo')).toBe('Close foo');
    expect(dropPreview('pinned', 'closedVisible', true, 'foo')).toBe('Close foo');
  });

  it('any → hidden reads as Hide', () => {
    expect(dropPreview('auto', 'hidden', true, 'foo')).toBe('Hide foo');
    expect(dropPreview('pinned', 'hidden', true, 'foo')).toBe('Hide foo');
    expect(dropPreview('closedVisible', 'hidden', false, 'foo')).toBe('Hide foo');
  });

  it('hidden → auto reads as Unhide (and Unhide + launch when closed)', () => {
    expect(dropPreview('hidden', 'auto', true, 'foo')).toBe('Unhide foo');
    expect(dropPreview('hidden', 'auto', false, 'foo')).toBe('Unhide + launch foo');
  });

  it('hidden → pinned reads as Unhide + pin (and Unhide + launch + pin when closed)', () => {
    expect(dropPreview('hidden', 'pinned', true, 'foo')).toBe('Unhide + pin foo');
    expect(dropPreview('hidden', 'pinned', false, 'foo')).toBe('Unhide + launch + pin foo');
  });

  it('pinned → auto reads as Unpin', () => {
    expect(dropPreview('pinned', 'auto', true, 'foo')).toBe('Unpin foo');
  });

  it('pinned → closedVisible for a NON-live tile reads as Unpin (not Close)', () => {
    // Edge case: pinned+closed tile exists only briefly between exit
    // and auto-unpin, but if a panel state push catches it mid-flight,
    // moving it to CBV should drop the pin, not pretend to close.
    expect(dropPreview('pinned', 'closedVisible', false, 'foo')).toBe('Unpin foo');
  });

  it('returns null for malformed input', () => {
    expect(dropPreview('', 'pinned', true, 'foo')).toBe(null);
    expect(dropPreview('auto', '', true, 'foo')).toBe(null);
    expect(dropPreview('auto', 'pinned', true, '')).toBe(null);
  });
});
