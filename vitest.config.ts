import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests run under @vscode/test-electron (real extension host),
    // not vitest. Exclude them from the unit suite.
    exclude: ['test/integration/**', 'node_modules/**'],
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
});
