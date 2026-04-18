/**
 * v0.12 — CI autoplay smoke test
 *
 * Launches a real VS Code instance headlessly via `@vscode/test-electron`,
 * installs the packaged VSIX, opens the Claudelike Bar sidebar webview,
 * and exercises the same HTML5 Audio path the extension uses at runtime.
 *
 * The test FAILS if Chromium reports the autoplay-blocked error when the
 * webview calls `audio.play()` — that's the regression we want CI to catch.
 * VS Code webviews have historically been exempt from Chromium's autoplay
 * gating; if a VS Code update ever tightens that, this is where we find out.
 *
 * Run via `npm run test:integration` (scripts entry added in package.json).
 * The vitest unit suite skips this file — it's in test/integration/ and
 * vitest.config.ts only picks up test/*.test.ts (one level deep).
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './autoplay.runner');

  // Launch a VS Code instance, install the extension from source, and run
  // the test runner file (which executes inside the extension host).
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // --disable-workspace-trust so the setup wizard doesn't block activation.
    launchArgs: ['--disable-workspace-trust', '--disable-extensions'],
  });
}

main().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
