import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createQueryClient } from './lib/queryClient';
import { createTestRouter } from './router';
import { useAuthStore } from './stores/auth';
import { useUiStore } from './stores/ui';

const signIn = () => useAuthStore.getState().setSession({ user: { id: 'u1', email: 'a@b.c', name: 'Asha Rao', role: 'INVESTIGATOR' }, accessToken: 'a', refreshToken: 'r' });

function mount(path: string, mode: string = 'live') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode }), { status: 200 })));
  const router = createTestRouter([path]);
  render(<App queryClient={createQueryClient()} router={router} />);
  return router;
}

beforeEach(() => {
  useAuthStore.getState().clearSession();
  useUiStore.setState({ theme: 'dark', sidebarCollapsed: false, mobileNavOpen: false });
  document.documentElement.classList.add('dark');
});

describe('routing and auth guard', () => {
  it('redirects unauthenticated users to /login', () => {
    const router = mount('/cases');
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps /login public', () => {
    mount('/login');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('sends a signed-in user from / to the dashboard inside the shell', () => {
    signIn();
    const router = mount('/');
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu, Asha Rao, Investigator' })).toBeInTheDocument();
  });

  it.each([
    ['/dashboard', 'Dashboard'],
    ['/intake', 'Complaint intake'],
    ['/cases', 'Cases'],
    ['/cases/abc', 'Case'],
    ['/alerts', 'Alerts'],
    ['/watchlist', 'Watchlist'],
    ['/vasps', 'VASP registry'],
    ['/reports', 'Reports'],
    ['/settings', 'Settings'],
  ])('renders %s', (path, title) => {
    signIn();
    mount(path);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
  });

  it('shows a not-found state for unknown routes', () => {
    signIn();
    mount('/nope');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });

  it('returns to /login on sign-out', async () => {
    signIn();
    const router = mount('/dashboard');
    await userEvent.click(screen.getByRole('button', { name: /account menu/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

describe('shell', () => {
  it('navigates via the sidebar and marks the active item', async () => {
    signIn();
    const router = mount('/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Alerts' }));
    expect(router.state.location.pathname).toBe('/alerts');
    expect(within(nav).getByRole('link', { name: 'Alerts' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('collapses the sidebar and keeps accessible link names', async () => {
    signIn();
    mount('/dashboard');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Cases' })).toBeInTheDocument();
    expect(within(nav).queryByText('Cases')).not.toBeInTheDocument(); // label text hidden, aria-label remains
  });

  it('toggles the theme and persists the preference', async () => {
    signIn();
    mount('/dashboard');
    expect(document.documentElement).toHaveClass('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(useUiStore.getState().theme).toBe('light');
    expect(localStorage.getItem('ps26183.ui')).toContain('"light"');
  });

  it('shows the demo-mode indicator only in replay mode', async () => {
    signIn();
    mount('/dashboard', 'replay');
    expect((await screen.findAllByText('Demo mode (replay)')).length).toBeGreaterThan(0);
  });

  it('hides the demo-mode indicator in live mode', async () => {
    signIn();
    mount('/dashboard', 'live');
    await Promise.resolve();
    expect(screen.queryByText('Demo mode (replay)')).not.toBeInTheDocument();
  });
});

describe('QueryClient provider', () => {
  it('serves useQuery to the shell (demo-mode badge reads /health through it) with the configured defaults', async () => {
    signIn();
    mount('/dashboard', 'replay');
    expect((await screen.findAllByText('Demo mode (replay)')).length).toBeGreaterThan(0);
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(30_000);
  });
});
