import { ApiError, humanMessage } from './errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ApiClientOptions {
  /** Origin prefix, '' for same-origin. */
  baseUrl?: string;
  getTokens: () => TokenPair | null;
  /** Called after a successful refresh so the session store can persist the rotated pair. */
  onTokens: (tokens: TokenPair) => void;
  /** Called when the session cannot be recovered (no refresh token, or refresh rejected). */
  onAuthFailure: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** false for public endpoints (login/refresh/verify): no Authorization header and no 401 refresh dance. */
  auth?: boolean;
}

export const API_PREFIX = '/api/v1';

/**
 * Fetch wrapper for /api/v1: JSON in/out, Bearer auth, single-flight refresh-and-retry on 401,
 * and every failure normalised to ApiError. Pages never call fetch directly; they go through this
 * (usually inside TanStack Query hooks).
 */
export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  let refreshing: Promise<'ok' | 'rejected' | 'unavailable'> | null = null;

  const url = (path: string, query?: RequestOptions['query']) => {
    const u = `${base}${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return u;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const s = qs.toString();
    return s ? `${u}?${s}` : u;
  };

  async function send(path: string, o: RequestOptions, token?: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const timeout = AbortSignal.timeout?.(opts.timeoutMs ?? 30_000);
    const signal = o.signal && timeout && AbortSignal.any ? AbortSignal.any([o.signal, timeout]) : (o.signal ?? timeout);
    try {
      return await doFetch(url(path, o.query), { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal });
    } catch (e) {
      if (o.signal?.aborted) throw e; // caller cancelled (TanStack Query unmount): not an error to report
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
      throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? 'The server took too long to respond. Try again.' : humanMessage(0));
    }
  }

  /**
   * One refresh at a time; concurrent 401s share the same promise.
   * 'rejected' = the server refused our refresh token (session is over); 'unavailable' = we could not find out
   * (network / 5xx / rate limit), so the session is kept and the original request fails with a retryable error.
   */
  function refresh(): Promise<'ok' | 'rejected' | 'unavailable'> {
    refreshing ??= (async () => {
      const t = opts.getTokens();
      if (!t?.refreshToken) return 'rejected' as const;
      try {
        const res = await send('/auth/refresh', { method: 'POST', body: { refreshToken: t.refreshToken }, auth: false });
        if (res.status === 400 || res.status === 401 || res.status === 403) return 'rejected' as const;
        if (!res.ok) return 'unavailable' as const;
        const data = (await res.json()) as Partial<TokenPair>;
        if (!data.accessToken || !data.refreshToken) return 'unavailable' as const;
        opts.onTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return 'ok' as const;
      } catch {
        return 'unavailable' as const;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (res.ok) return body as T;
    const b = (body ?? {}) as { error?: unknown; message?: unknown; issues?: { path: string; message: string }[] };
    throw new ApiError(res.status, typeof b.error === 'string' ? b.error : 'HTTP_ERROR', humanMessage(res.status, b), Array.isArray(b.issues) ? b.issues : []);
  }

  async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
    const authed = o.auth !== false;
    let res = await send(path, o, authed ? opts.getTokens()?.accessToken : undefined);
    if (res.status === 401 && authed) {
      const outcome = await refresh();
      if (outcome === 'ok') {
        res = await send(path, o, opts.getTokens()?.accessToken);
        if (res.status === 401) opts.onAuthFailure(); // a freshly issued token was refused too
      } else if (outcome === 'rejected') {
        opts.onAuthFailure();
      } else {
        throw new ApiError(0, 'NETWORK', humanMessage(0));
      }
    }
    return parse<T>(res);
  }

  return {
    request,
    get: <T>(path: string, o?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...o, method: 'GET' }),
    post: <T>(path: string, body?: unknown, o?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...o, method: 'POST', body }),
    patch: <T>(path: string, body?: unknown, o?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...o, method: 'PATCH', body }),
    delete: <T>(path: string, o?: Omit<RequestOptions, 'method' | 'body'>) => request<T>(path, { ...o, method: 'DELETE' }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
