import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two projects replace the removed-in-v4 `environmentMatchGlobs`: browser-ish
// code (components/hooks/stores/lib) runs under jsdom, everything else (utils,
// pure logic) under node - same split the globs used to express.
const JSDOM_GLOBS = [
  'src/components/**/*.test.{ts,tsx}',
  'src/hooks/**/*.test.{ts,tsx}',
  'src/store/**/*.test.{ts,tsx}',
  'src/lib/**/*.test.{ts,tsx}',
];

export default defineConfig({
  plugins: [react()],
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: JSDOM_GLOBS,
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: JSDOM_GLOBS,
        },
      },
    ],
  },
});
