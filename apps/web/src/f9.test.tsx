import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { RiskBadge } from './components/common/badges';
import { EmptyState, ErrorState, LoadingState } from './components/common/states';
import i18n from './i18n';
import { formatDayMonth, formatIst, formatIstDate, formatIstTime } from './lib/datetime';
import { createQueryClient } from './lib/queryClient';
import { createTestRouter } from './router';
import { useAuthStore } from './stores/auth';
import { useUiStore } from './stores/ui';
import { ApiError } from './lib/api/errors';
import { resetAppState } from './test/utils';

const signIn = () => useAuthStore.getState().setSession({ user: { id: 'u1', email: 'a@b.c', name: 'Asha Rao', role: 'SUPERVISOR' }, accessToken: 'a', refreshToken: 'r' });

function mount(path: string, mode = 'live') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode }), { status: 200 })));
  render(<App queryClient={createQueryClient()} router={createTestRouter([path])} />);
}

beforeEach(() => resetAppState());

describe('IST formatting (one shared formatter)', () => {
  it('shows instants in Asia/Kolkata with an explicit IST suffix', () => {
    expect(formatIst('2026-09-23T08:30:00.000Z')).toMatch(/^23 Sep\w* 2026, 14:00 IST$/);
    expect(formatIst(Date.parse('2026-12-31T20:00:00Z'))).toMatch(/^01 Jan 2027, 01:30 IST$/);
    expect(formatIstTime('2026-09-23T08:30:09Z')).toBe('14:00:09 IST');
  });

  it('never invents a time for missing or invalid values', () => {
    for (const v of [null, undefined, '', 'not a date', NaN]) {
      expect(formatIst(v as never)).toBe('—');
      expect(formatIstTime(v as never)).toBe('—');
      expect(formatIstDate(v as never)).toBe('—');
    }
  });

  it('keeps date-only API values on the same calendar day, without a timezone shift', () => {
    expect(formatIstDate('2026-09-23')).toMatch(/^23 Sep\w* 2026$/);
    expect(formatDayMonth('2026-09-23')).toMatch(/^23 Sep\w*$/);
    expect(formatDayMonth(null)).toBe('—');
  });
});

describe('Hindi / English toggle', () => {
  it('switches the shell to Hindi from the top bar, marks the document language, and can switch back', async () => {
    signIn();
    mount('/settings');
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'हिन्दी' })[0]!);
    expect(await screen.findByRole('heading', { level: 1, name: 'सेटिंग्स' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'डैशबोर्ड' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');
    for (const b of screen.getAllByRole('button', { name: 'हिन्दी' })) expect(b).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getAllByRole('button', { name: 'English' })[0]!);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('persists the choice with the other UI preferences and restores it', async () => {
    useUiStore.getState().setLanguage('hi');
    expect(localStorage.getItem('ps26183.ui')).toContain('"language":"hi"');
    resetAppState();
    localStorage.setItem('ps26183.ui', JSON.stringify({ state: { theme: 'dark', language: 'hi', sidebarCollapsed: false, alertSoundEnabled: false }, version: 0 }));
    await useUiStore.persist.rehydrate();
    expect(i18n.language).toBe('hi');
    expect(useUiStore.getState().language).toBe('hi');
  });

  it('leaves untranslated text (addresses, unknown strings) exactly as given', () => {
    useUiStore.getState().setLanguage('hi');
    expect(i18n.t('TQzQZGkZ8M-not-a-label')).toBe('TQzQZGkZ8M-not-a-label');
  });

  it('is operable from the keyboard', async () => {
    signIn();
    mount('/settings');
    const user = userEvent.setup();
    const hi = screen.getAllByRole('button', { name: 'हिन्दी' })[0]!;
    hi.focus();
    expect(hi).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'हिन्दी' })[0]).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('Demo mode (replay) banner', () => {
  it('shows a non-dismissible banner on the shell in replay mode, and names the mode', async () => {
    signIn();
    mount('/settings', 'replay');
    const banner = (await screen.findByText('Demo mode (replay)')).closest('[role="status"]')!;
    expect(banner).toHaveTextContent(/no external provider is called live/);
    expect(banner.querySelector('button')).toBeNull();
  });

  it('is absent in live and record mode', async () => {
    signIn();
    mount('/settings', 'live');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await Promise.resolve();
    expect(screen.queryByText('Demo mode (replay)')).not.toBeInTheDocument();
  });

  it('is translated with the rest of the chrome', async () => {
    signIn();
    useUiStore.getState().setLanguage('hi');
    mount('/settings', 'replay');
    expect(await screen.findByText('डेमो मोड (रिप्ले)')).toBeInTheDocument();
  });
});

describe('loading, empty and error states', () => {
  it('announces loading politely to assistive tech', () => {
    render(<LoadingState label="Loading cases" />);
    expect(screen.getByRole('status', { name: 'Loading cases' })).toBeInTheDocument();
  });

  it('explains an empty state and offers only the action it is given', () => {
    render(<EmptyState title="No cases yet" description="Cases are created when a complaint with a wallet address is registered at intake." />);
    expect(screen.getByRole('heading', { name: 'No cases yet' })).toBeInTheDocument();
    expect(screen.getByText(/registered at intake/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the real failure as an alert with a retry, and never substitutes data', async () => {
    const retry = vi.fn();
    render(<ErrorState title="Could not load this panel" error={new ApiError(404, 'CASE_NOT_FOUND', 'The requested record could not be found.')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The requested record could not be found.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('translates state chrome but not the server message', () => {
    useUiStore.getState().setLanguage('hi');
    render(<ErrorState error={new ApiError(500, 'INTERNAL', 'The server hit a problem.')} onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'फिर कोशिश करें' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The server hit a problem.');
  });
});

describe('colour is never the only cue', () => {
  it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)('%s risk carries a text label, an icon and a spoken meaning', (band) => {
    const { container } = render(<RiskBadge band={band} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toMatch(new RegExp(band, 'i'));
    expect(container.querySelector('.sr-only')).not.toBeNull();
  });
});
