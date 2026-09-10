import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep the worker independent of the frontend's PostCSS dependencies.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
