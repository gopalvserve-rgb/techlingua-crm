import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // dev proxy to the NestJS API so the app can call /api/* same-origin
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
