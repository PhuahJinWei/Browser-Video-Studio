/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any GitHub Pages sub-path.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext', // Chromium-latest only; we want top-level await, etc.
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    // Honour PORT when something upstream assigns one, so a second dev server can
    // run alongside a first instead of colliding on 5173.
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    globals: true,
    // Model layer is pure and runs in Node. Engine tests will opt into a
    // browser environment later via a separate project config.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
