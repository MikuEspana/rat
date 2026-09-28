/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API base URL. Default: the mock API (pnpm mock:api) on http://localhost:8787 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
