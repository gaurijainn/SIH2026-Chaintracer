import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { json, mountApp, resetAppState, signInAs, USERS } from '@/test/utils';

beforeEach(resetAppState);

describe('route protection', () => {
  it('redirects unauthenticated users to /login without rendering protected content', () => {
    const { router } = mountApp('/reports');
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reports' })).not.toBeInTheDocument();
  });

  it('lets an authenticated user in', () => {
    signInAs('INVESTIGATOR');
    const { router } = mountApp('/cases');
    expect(router.state.location.pathname).toBe('/cases');
    expect(screen.getByRole('heading', { level: 1, name: 'Cases' })).toBeInTheDocument();
  });

  it('discards a tampered stored session with an unknown role', async () => {
    sessionStorage.setItem('ps26183.session', JSON.stringify({ state: { user: { id: '1', email: 'a@b.c', name: 'X', role: 'ROOT' }, accessToken: 'a', refreshToken: 'r' }, version: 0 }));
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

async function signOutViaMenu() {
  await userEvent.click(screen.getByRole('button', { name: /account menu/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
}

describe('logout', () => {
  it('clears the session, revokes the refresh token, and does not remember the page', async () => {
    signInAs('SUPERVISOR');
    const { router, fetchMock } = mountApp('/watchlist', (url) => (url.pathname.endsWith('/auth/logout') ? new Response(null, { status: 204 }) : undefined));
    await signOutViaMenu();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/logout'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ refreshToken: 'refresh-1' });
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  it('still signs out locally when the server is unreachable', async () => {
    signInAs('VIEWER');
    const { router } = mountApp('/dashboard', () => {
      throw new TypeError('network down');
    });
    await signOutViaMenu();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('empties the query cache so the next user never sees previous data', () => {
    signInAs('VIEWER');
    const { queryClient } = mountApp('/dashboard');
    queryClient.setQueryData(['cases'], [{ id: 'secret' }]);
    act(() => useAuthStore.getState().signOut());
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
  });
});

describe('token lifecycle through the real API client', () => {
  it('sends the access token automatically', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/dashboard', (url) => (url.pathname === '/api/v1/cases' ? json(200, { ok: 1 }) : undefined));
    await expect(api.get('/cases')).resolves.toEqual({ ok: 1 });
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/v1/cases'))!;
    expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('refreshes an expired access token, stores the rotated pair, and retries', async () => {
    signInAs('INVESTIGATOR');
    let attempts = 0;
    const { fetchMock } = mountApp('/dashboard', (url, init) => {
      if (url.pathname.endsWith('/auth/refresh')) {
        expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'refresh-1' });
        return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2', user: USERS.INVESTIGATOR });
      }
      if (url.pathname === '/api/v1/cases') {
        attempts++;
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === 'Bearer access-2' ? json(200, { ok: true }) : json(401, { error: 'TOKEN_EXPIRED', message: 'access token has expired' });
      }
    });
    await expect(api.get('/cases')).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(useAuthStore.getState().accessToken).toBe('access-2');
    expect(useAuthStore.getState().refreshToken).toBe('refresh-2');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('shares one refresh between concurrent expired requests', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/dashboard', (url, init) => {
      if (url.pathname.endsWith('/auth/refresh')) return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      return (init.headers as Record<string, string>).Authorization === 'Bearer access-2' ? json(200, { path: url.pathname }) : json(401, { error: 'TOKEN_EXPIRED' });
    });
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('logs the user out and explains why when refresh is rejected', async () => {
    signInAs('INVESTIGATOR');
    const { router } = mountApp('/cases', (url) => (url.pathname.endsWith('/auth/refresh') ? json(401, { error: 'REFRESH_REVOKED', message: 'refresh token has been revoked or expired' }) : json(401, { error: 'TOKEN_EXPIRED' })));
    await expect(api.get('/cases')).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(useAuthStore.getState().user).toBeNull();
    expect(await screen.findByText(/your session has expired/i)).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ from: '/cases' });
  });

  it('keeps the session when the refresh endpoint is merely unavailable', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/dashboard', (url) => (url.pathname.endsWith('/auth/refresh') ? json(503, { error: 'UNAVAILABLE' }) : json(401, { error: 'TOKEN_EXPIRED' })));
    await expect(api.get('/cases')).rejects.toMatchObject({ isNetwork: true });
    expect(useAuthStore.getState().user).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });
});
