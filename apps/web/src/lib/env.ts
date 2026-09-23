export type DataMode = 'live' | 'record' | 'replay';

export const isDataMode = (v: unknown): v is DataMode => v === 'live' || v === 'record' || v === 'replay';

/** Build-time data-mode override; when unset the mode is read from GET /health (see useDataMode). */
export const envDataMode: DataMode | undefined = isDataMode(import.meta.env.VITE_DATA_MODE) ? import.meta.env.VITE_DATA_MODE : undefined;

/** API origin without trailing slash. Empty means same-origin (Vite dev proxy / nginx). */
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
