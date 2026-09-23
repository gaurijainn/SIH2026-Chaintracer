/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin; empty (default) means same-origin via the Vite/nginx proxy. */
  readonly VITE_API_BASE_URL?: string;
  /** Overrides the data mode reported by /health: live | record | replay. */
  readonly VITE_DATA_MODE?: string;
}
