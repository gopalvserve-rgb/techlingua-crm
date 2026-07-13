/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // DEF-2 — web test harness (vitest + jsdom). Guards form/modal RENDERING,
  // which the API-only jest suite structurally could not catch.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
  },
  server: {
    port: 5173,
    proxy: {
      // dev proxy to the NestJS API so the app can call /api/* same-origin
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
