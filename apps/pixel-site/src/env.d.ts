/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API base URL. Default: the mock API (pnpm mock:api) on http://localhost:8787 */
  readonly VITE_API_BASE?: string;
  /** "1": the static demo build, where the in-browser launch simulator replaces the API */
  readonly VITE_SIM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
