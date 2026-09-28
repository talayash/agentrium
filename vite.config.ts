import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // vite 8 bundles with rolldown and minifies with oxc; 'esbuild' is no
    // longer shipped, so use the default minifier (true) instead.
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
    // The polyfill only runs on WebKit without native modulepreload (macOS 13
    // and older) and fires fetch() with no .catch, so any failed preload lands
    // in the global unhandledrejection handler as "TypeError: Load failed".
    // Assets are served from local disk over tauri://, so preloading gains
    // nothing; the real import() still loads each module.
    modulePreload: { polyfill: false },
  },
});
