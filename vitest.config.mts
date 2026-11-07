import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    globalSetup: path.resolve(import.meta.dirname, './tests/globalSetup.ts'),
    setupFiles: [path.resolve(import.meta.dirname, './tests/setupEnv.ts')],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
