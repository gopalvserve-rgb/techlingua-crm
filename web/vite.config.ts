/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // DEF-2 — web test harness (vitest + jsdom). Guards form/modal RENDERING,
  // which the API-only jest suite structurally could not catch.
  test: {
    environment: 'jsdom',
    // `.ts` AS WELL AS `.tsx` — Sprint 5 added `money.test.ts` (pure functions, no JSX)
    // and the old `*.test.tsx`-only glob SILENTLY SKIPPED IT. A test file that never runs
    // is worse than no test file: it reports green and guards nothing. Same class as the
    // qa10 harness clicking the wrong button.
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    port: 5173,
    proxy: {
      // dev proxy to the NestJS API so the app can call /api/* same-origin
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
