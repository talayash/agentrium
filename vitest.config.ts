import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
      ['src/hooks/**', 'jsdom'],
      ['src/store/**', 'jsdom'],
    ],
    clearMocks: true,
    restoreMocks: true,
  },
});
