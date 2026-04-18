import { describe, it, expect } from 'vitest';
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
});
