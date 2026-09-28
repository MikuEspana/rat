import { defineConfig } from 'vite';

// VITE_API_BASE switches the API (default: the mock API on http://localhost:8787, see src/config.ts).
// VITE_SIM=1 builds the static demo: the in-browser launch simulator replaces the API.
// VITE_BASE sets the base path. The Pages build (https://wallstreetrats.world) serves from the root: VITE_BASE=/.
// Default: relative asset paths, so a local build runs from any folder (Netlify Drop, a zip).
export default defineConfig({
  base: process.env.VITE_BASE || './',
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
