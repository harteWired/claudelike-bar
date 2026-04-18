/**
 * Extension-host test runner for the autoplay smoke test. Executed by the
 * VS Code instance launched by `autoplay.test.ts`.
 *
 * The contract: expose a `run()` export that returns a Promise. A rejection
 * is treated as a CI failure.
 *
 * Strategy: ask the extension to fire a play via the private
 * `claudeDashboard.__firePlayForTest` command, which round-trips through
 * the webview's `audio.play()` and resolves with the real outcome:
 *
 *   'played'  → Chromium decoded and played the clip — autoplay not blocked
 *   'error'   → play() rejected — the regression we exist to catch
 *   'timeout' → no ack in 5s — usually means the sidebar never resolved,
 *               treated as a failure because it signals broken wiring
 *
 * We're deliberately using a private command rather than an exported API
 * from `activate()` so this extension keeps its "no programmatic surface"
 * posture. The underscore prefix + absence from package.json contributes
 * signals "test-only, don't depend on it."
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const SMOKE_TIMEOUT_MS = 30_000;
const FIRE_TIMEOUT_MS = 5_000;

export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    const overallTimeout = setTimeout(() => {
      reject(new Error(`autoplay smoke test timed out after ${SMOKE_TIMEOUT_MS}ms`));
    }, SMOKE_TIMEOUT_MS);

    (async () => {
      try {
        // 1. Drop a silent WAV into ~/.claude/sounds/ so the webview has a
        //    valid file to decode. 44-byte header + one silent sample; no
        //    audio asset is shipped with the repo.
        const soundsDir = path.join(os.homedir(), '.claude', 'sounds');
        fs.mkdirSync(soundsDir, { recursive: true });
        const filename = 'ci-smoke.wav';
        fs.writeFileSync(path.join(soundsDir, filename), silentWavBytes());

        // 2. Write a minimal config. `enabled` isn't strictly required for
        //    the private command (it bypasses the AudioPlayer pipeline and
        //    calls postPlay directly), but set it true so the extension
        //    behaves identically to a real user's enabled state.
        const configPath = path.join(os.homedir(), '.claude', 'claudelike-bar.jsonc');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            terminals: {},
            audio: { enabled: true, volume: 0.0, debounceMs: 0, sounds: { ready: filename } },
          }, null, 2),
        );

        // 3. Focus the sidebar so the webview resolves. Without this, the
        //    webview postMessage goes nowhere and we'd hit the 5s timeout.
        await vscode.commands.executeCommand('claudeDashboard.mainView.focus');
        await new Promise((r) => setTimeout(r, 1500));

        // 4. Fire the play and wait for the ack.
        const result = await vscode.commands.executeCommand<'played' | 'error' | 'timeout'>(
          'claudeDashboard.__firePlayForTest',
          filename,
          0,
          FIRE_TIMEOUT_MS,
        );

        if (result !== 'played') {
          throw new Error(
            `autoplay smoke failed: expected 'played', got '${result}'. ` +
            (result === 'error'
              ? 'Chromium rejected audio.play() — likely an autoplay-policy regression.'
              : 'Webview never acked — sidebar may have failed to resolve.'),
          );
        }

        clearTimeout(overallTimeout);
        resolve();
      } catch (err) {
        clearTimeout(overallTimeout);
        reject(err);
      }
    })();
  });
}

/**
 * Minimal WAV: RIFF header + fmt chunk + one 8-bit silent sample.
 * Decodes on every Chromium version we care about.
 */
function silentWavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(37, 4); // file size - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);    // fmt chunk size
  header.writeUInt16LE(1, 20);     // PCM
  header.writeUInt16LE(1, 22);     // mono
  header.writeUInt32LE(8000, 24);  // 8kHz sample rate
  header.writeUInt32LE(8000, 28);  // byte rate
  header.writeUInt16LE(1, 32);     // block align
  header.writeUInt16LE(8, 34);     // 8 bits/sample
  header.write('data', 36);
  header.writeUInt32LE(1, 40);     // data chunk size
  return Buffer.concat([header, Buffer.from([128])]); // one silent sample
}
