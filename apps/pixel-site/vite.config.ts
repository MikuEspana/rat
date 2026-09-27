import { defineConfig } from 'vite';

// VITE_API_BASE switches the API (default: the mock API on http://localhost:8787, see src/config.ts).
export default defineConfig({
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
