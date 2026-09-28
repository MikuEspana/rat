import { defineConfig } from 'vite';

// VITE_API_BASE switches the API (default: the mock API on http://localhost:8787, see src/config.ts).
// VITE_SIM=1 builds the static demo: the in-browser launch simulator replaces the API.
// Relative asset paths, so the build runs from any folder: GitHub Pages (/rat/), Netlify or Vercel (/), a zip.
export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
