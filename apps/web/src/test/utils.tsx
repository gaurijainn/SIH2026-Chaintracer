import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from '@/App';
import { createQueryClient } from '@/lib/queryClient';
import { createTestRouter } from '@/router';
import { useAuthStore, type Role } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';

export const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const USERS: Record<Role, { id: string; email: string; name: string; role: Role }> = {
  VIEWER: { id: 'u-viewer', email: 'viewer@demo.local', name: 'Demo Viewer', role: 'VIEWER' },
  INVESTIGATOR: { id: 'u-inv', email: 'investigator@demo.local', name: 'Demo Investigator', role: 'INVESTIGATOR' },
  SUPERVISOR: { id: 'u-sup', email: 'supervisor@demo.local', name: 'Demo Supervisor', role: 'SUPERVISOR' },
  ADMIN: { id: 'u-admin', email: 'admin@demo.local', name: 'Demo Admin', role: 'ADMIN' },
};

export const signInAs = (role: Role, tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' }) => useAuthStore.getState().setSession({ user: USERS[role], ...tokens });

export type FetchHandler = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

/** Stubs global fetch: /health answers `live`; everything else goes to `handler` (404 if it returns undefined). Returns the mock. */
export function stubFetch(handler: FetchHandler = () => undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/health') return json(200, { mode: 'live' });
    return (await handler(url, init)) ?? json(404, { error: 'NOT_FOUND' });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function resetAppState() {
  useAuthStore.getState().clearSession();
  useUiStore.setState({ theme: 'dark', sidebarCollapsed: false, mobileNavOpen: false });
  document.documentElement.classList.add('dark');
}

export function mountApp(path: string, handler?: FetchHandler) {
  const fetchMock = stubFetch(handler);
  const router = createTestRouter([path]);
  const queryClient = createQueryClient();
  const utils = render(<App queryClient={queryClient} router={router} />);
  return { router, fetchMock, queryClient, ...utils };
}
