import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { json, mountApp, resetAppState, USERS } from '@/test/utils';

const loginOk = (role: keyof typeof USERS = 'INVESTIGATOR') => json(200, { accessToken: 'a1', refreshToken: 'r1', tokenType: 'Bearer', expiresIn: 900, user: USERS[role] });

async function fill(email: string, password: string) {
  if (email) await userEvent.type(screen.getByLabelText('Email'), email);
  if (password) await userEvent.type(screen.getByLabelText('Password'), password);
}
const submit = () => userEvent.click(screen.getByRole('button', { name: /sign in/i }));

beforeEach(resetAppState);

describe('login form', () => {
  it('validates on the client before calling the API', async () => {
    const { fetchMock } = mountApp('/login');
    await submit();
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');

    await fill('not-an-email', 'x');
    await submit();
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/login'))).toBe(false);
  });

  it('signs in with valid credentials, sends the documented body, and lands on /dashboard', async () => {
    const { router, fetchMock } = mountApp('/login', (url) => (url.pathname === '/api/v1/auth/login' ? loginOk() : undefined));
    await fill('  investigator@demo.local ', 'ChangeMe!123');
    await submit();
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/v1/auth/login'))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ email: 'investigator@demo.local', password: 'ChangeMe!123' });
    expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
    const s = useAuthStore.getState();
    expect(s.user).toEqual(USERS.INVESTIGATOR);
    expect(s.accessToken).toBe('a1');
    expect(s.refreshToken).toBe('r1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('returns to the originally requested route after login', async () => {
    const { router } = mountApp('/cases/CASE-9', (url) => (url.pathname.endsWith('/auth/login') ? loginOk() : undefined));
    expect(router.state.location.pathname).toBe('/login');
    await fill('investigator@demo.local', 'ChangeMe!123');
    await submit();
    await waitFor(() => expect(router.state.location.pathname).toBe('/cases/CASE-9'));
  });

  it('shows a clean message for invalid credentials and stays signed out', async () => {
    const { router } = mountApp('/login', (url) => (url.pathname.endsWith('/auth/login') ? json(401, { error: 'INVALID_CREDENTIALS', message: 'invalid email or password' }) : undefined));
    await fill('viewer@demo.local', 'wrong');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(router.state.location.pathname).toBe('/login');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('never shows raw server errors', async () => {
    mountApp('/login', (url) => (url.pathname.endsWith('/auth/login') ? json(500, { error: 'INTERNAL', message: 'PrismaClientKnownRequestError: connection refused at db:5432' }) : undefined));
    await fill('viewer@demo.local', 'ChangeMe!123');
    await submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server hit a problem/i);
    expect(alert).not.toHaveTextContent(/prisma|db:5432|connection refused/i);
  });

  it('explains rate limiting', async () => {
    mountApp('/login', (url) => (url.pathname.endsWith('/auth/login') ? json(429, { error: 'RATE_LIMITED', message: 'too many requests; retry later' }) : undefined));
    await fill('viewer@demo.local', 'x');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
  });

  it('rejects a malformed success response instead of trusting it', async () => {
    mountApp('/login', (url) => (url.pathname.endsWith('/auth/login') ? json(200, { accessToken: 'a', refreshToken: 'r', user: { id: '1', email: 'a@b.c', name: 'X', role: 'ROOT' } }) : undefined));
    await fill('viewer@demo.local', 'x');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected response/i);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('disables the form and shows progress while the request is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mountApp('/login', async (url) => {
      if (!url.pathname.endsWith('/auth/login')) return undefined;
      await gate;
      return loginOk();
    });
    await fill('investigator@demo.local', 'ChangeMe!123');
    await submit();
    const btn = await screen.findByRole('button', { name: /signing in/i });
    expect(btn).toBeDisabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    release();
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull());
  });

  it('ignores an unsafe return path and goes to /dashboard', async () => {
    const { router } = mountApp('/login');
    await act(() => router.navigate('/login', { state: { from: '//evil.example' } }));
    act(() => useAuthStore.getState().setSession({ user: USERS.VIEWER, accessToken: 'a', refreshToken: 'r' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });

  it('redirects an already signed-in user away from /login', async () => {
    useAuthStore.getState().setSession({ user: USERS.VIEWER, accessToken: 'a', refreshToken: 'r' });
    const { router } = mountApp('/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
  });
});
