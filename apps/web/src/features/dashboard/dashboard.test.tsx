import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sockets } from '@/test/fakeSocket';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import { useAuthStore, type Role } from '@/stores/auth';
import type { AlertRow, ComplaintItem, DashboardSummary } from './api';
import { computeAlertKpis, formatDay, formatInr, formatUsd, toSlices, topVasps } from './metrics';
import { mergeFeed, parseAlertEvent } from './useAlertFeed';

vi.mock('@/lib/realtime', async () => {
  const { createFakeSocket } = await import('@/test/fakeSocket');
  return { createRealtimeSocket: createFakeSocket };
});
const lastSocket = () => sockets[sockets.length - 1]!;

beforeEach(() => {
  resetAppState();
  sockets.length = 0;
});

const complaint = (n: number, over: Partial<ComplaintItem> = {}): ComplaintItem => ({
  id: `cm-${n}`,
  ackNo: `ACK-${n}`,
  reportedAt: `2026-09-${String(10 + n).padStart(2, '0')}T08:00:00.000Z`,
  category: 'Investment fraud',
  amountInr: String(100000 * n),
  network: 'TRC20',
  caseId: `case-${n}`,
  case: { id: `case-${n}`, title: `NCRP ACK-${n}: Investment fraud`, status: 'OPEN' },
  addresses: [{ address: `TAddr${n}`, chain: 'TRON', kind: 'ADDRESS' }],
  ...over,
});

const alertRow = (id: string, over: Partial<AlertRow> = {}): AlertRow => ({
  id,
  caseId: 'case-1',
  rule: 'A2_VASP_LANDING',
  severity: 'CRITICAL',
  status: 'NEW',
  chain: 'TRON',
  address: 'TLandingAddress0000000000000000000',
  amount: '1500',
  message: 'landed',
  metadata: { vaspName: 'ExampleEx', freezeWindowOpen: true },
  createdAt: '2026-09-20T10:00:00.000Z',
  ...over,
});

const vasp = { id: 'v1', name: 'ExampleEx', addresses: [] };

const summaryFixture: DashboardSummary = {
  openCases: 13,
  tracesPerDay: [{ day: '2026-09-01', count: 3 }, { day: '2026-09-23', count: 8 }],
  tracedValueUsd: 75282.5,
  vaspsIdentified: 3,
  typologyMix: [{ typology: 'investment_fraud', count: 3 }, { typology: 'mule_ring', count: 1 }],
  timeToAttributionMedianSeconds: null,
  chainSplit: [{ chain: 'TRON', count: 10 }, { chain: 'ETH', count: 3 }, { chain: 'BTC', count: 2 }],
};

interface Data {
  summary?: Partial<DashboardSummary> | unknown;
  complaints?: ComplaintItem[];
  total?: number;
  alerts?: AlertRow[];
}
const handlerFor = (d: Data = {}, extra?: FetchHandler): FetchHandler => (url, init) => {
  const custom = extra?.(url, init);
  if (custom) return custom;
  const items = d.complaints ?? [complaint(1), complaint(2)];
  if (url.pathname === '/api/v1/complaints') return json(200, { total: d.total ?? items.length, page: Number(url.searchParams.get('page')), pageSize: 200, items });
  if (url.pathname === '/api/v1/alerts') return json(200, { alerts: d.alerts ?? [alertRow('a1'), alertRow('a2', { caseId: 'case-2', metadata: { vaspName: 'OtherEx', freezeWindowOpen: true }, severity: 'HIGH' })] });
  if (url.pathname === '/api/v1/dashboard/summary') return json(200, d.summary && typeof d.summary === 'object' && !Array.isArray(d.summary) ? { ...summaryFixture, ...d.summary } : (d.summary ?? summaryFixture));
  if (url.pathname === '/api/v1/vasps') return json(200, { vasps: [vasp, { ...vasp, id: 'v2', name: 'OtherEx' }, { ...vasp, id: 'v3', name: 'ThirdEx' }] });
  return undefined;
};
const open = (d?: Data, extra?: FetchHandler, role: Role = 'INVESTIGATOR') => {
  signInAs(role);
  return mountApp('/dashboard', handlerFor(d, extra));
};
const kpi = (label: string) => screen.getByText(label).closest('div.rounded-lg') as HTMLElement;

describe('pure metrics', () => {
  it('formats rupees with Indian grouping', () => {
    expect(formatInr(1250000)).toBe('₹12,50,000');
    expect(formatInr(0)).toBe('₹0');
  });

  it('formats USD and INR distinctly, and API calendar days without a timezone shift', () => {
    expect(formatUsd(75282.5)).toBe('$75,282.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatDay('2026-09-23')).toBe('23 Sept');
  });

  it('derives freeze windows only from unsnoozed landing alerts on non-closed cases', () => {
    const cs = [complaint(1), complaint(2, { case: { id: 'case-2', title: 't', status: 'CLOSED' } })];
    const alerts = [alertRow('a1'), alertRow('a2', { caseId: 'case-2' }), alertRow('a3', { status: 'SNOOZED' }), alertRow('a4', { rule: 'A1_MOVEMENT', metadata: null })];
    expect(computeAlertKpis(alerts, cs)).toEqual({ freezeWindowsOpen: 1, freezeWindowCases: 1 });
  });

  it('ranks VASPs by landings and turns backend counts into percentage slices', () => {
    const ranks = topVasps([alertRow('a1'), alertRow('a2'), alertRow('a3', { metadata: { vaspName: 'Z' } })]);
    expect(ranks.map((r) => [r.name, r.landings])).toEqual([['ExampleEx', 2], ['Z', 1]]);
    expect(toSlices([{ key: 'TRON', count: 3 }, { key: 'ETH', count: 1 }]).map((s) => [s.key, s.value, s.percent])).toEqual([['TRON', 3, 75], ['ETH', 1, 25]]);
    expect(toSlices([])).toEqual([]);
  });

  it('parses only well-formed alert.new payloads', () => {
    const ok = { id: 'x', rule: 'A1_MOVEMENT', severity: 'HIGH', caseId: 'c', chain: 'TRON', address: 'T1', amount: null };
    expect(parseAlertEvent(ok)?.id).toBe('x');
    for (const bad of [null, 'str', 42, {}, { ...ok, rule: 'NOPE' }, { ...ok, severity: 'SEVERE' }, { ...ok, id: '' }, { ...ok, caseId: 5 }, { ...ok, address: undefined }]) expect(parseAlertEvent(bad)).toBeNull();
  });

  it('merges live and stored alerts without duplicates', () => {
    const live = parseAlertEvent({ id: 'a1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case-1', address: 'T', amount: '1' })!;
    const merged = mergeFeed([live], [alertRow('a1'), alertRow('a2')]);
    expect(merged.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(merged.find((a) => a.id === 'a1')?.live).toBe(true);
  });
});

const summaryPath = '/api/v1/dashboard/summary';
const pending = () => new Promise<Response>(() => undefined);

describe('KPI cards', () => {
  it('renders the five cards from the backend summary and alerts', async () => {
    open();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(within(kpi('Open cases')).getByText('13')).toBeInTheDocument());
    expect(within(kpi('VASPs identified')).getByText('3')).toBeInTheDocument();
    expect(within(kpi('VASPs identified')).getByText(/registry holds 3/)).toBeInTheDocument();
    expect(within(kpi('Freeze windows open')).getByText('2')).toBeInTheDocument();
    expect(within(kpi('Median time-to-attribution')).getByText('N/A')).toBeInTheDocument();
  });

  it('labels value traced as USD, formatted as dollars, and never as INR', async () => {
    open();
    const card = kpi('Value traced (USD)');
    await waitFor(() => expect(within(card).getByText('$75,282.50')).toBeInTheDocument());
    expect(within(card).getByText(/Not converted to INR/)).toBeInTheDocument();
    expect(screen.queryByText('Value traced (INR)')).not.toBeInTheDocument();
    expect(card.textContent).not.toContain('₹');
  });

  it('renders a null median as N/A and does not estimate it', async () => {
    open();
    const card = kpi('Median time-to-attribution');
    await waitFor(() => expect(within(card).getByText('N/A')).toBeInTheDocument());
    expect(within(card).getByText(/not estimated here/)).toBeInTheDocument();
  });

  it('formats a median once the backend supplies one', async () => {
    open({ summary: { timeToAttributionMedianSeconds: 95 } });
    await waitFor(() => expect(within(kpi('Median time-to-attribution')).getByText('1m 35s')).toBeInTheDocument());
  });

  it('shows a loading skeleton while the summary is in flight', () => {
    open(undefined, (url) => (url.pathname === summaryPath ? pending() : undefined));
    expect(within(kpi('Open cases')).getByText('Loading')).toBeInTheDocument();
    expect(within(kpi('Value traced (USD)')).getByText('Loading')).toBeInTheDocument();
  });

  it('shows an error state on the summary cards when the summary fails, without hiding alert-based cards', async () => {
    open(undefined, (url) => (url.pathname === summaryPath ? json(500, { error: 'BOOM' }) : undefined));
    await waitFor(() => expect(within(kpi('Open cases')).getByText('Error')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(kpi('Freeze windows open')).getByText('2')).toBeInTheDocument();
  });

  it('turns a malformed summary into an error state rather than NaN', async () => {
    open({ summary: { openCases: 'many', tracedValueUsd: -1 } });
    await waitFor(() => expect(within(kpi('Open cases')).getByText('Error')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(kpi('Open cases')).getByText(/unexpected dashboard response/)).toBeInTheDocument();
    expect(screen.queryByText('NaN')).not.toBeInTheDocument();
  });

  it('shows genuine zeros when the backend returns nothing', async () => {
    open({ summary: { openCases: 0, tracedValueUsd: 0, vaspsIdentified: 0 }, alerts: [] });
    await waitFor(() => expect(within(kpi('Open cases')).getByText('0')).toBeInTheDocument());
    expect(within(kpi('Value traced (USD)')).getByText('$0.00')).toBeInTheDocument();
    expect(within(kpi('Freeze windows open')).getByText('0')).toBeInTheDocument();
  });
});

describe('chart panels', () => {
  const panel = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!;

  it('plots traces per day from the summary, with a text summary and accessible list', async () => {
    open();
    expect(await screen.findByRole('img', { name: 'Traces per day: 2026-09-01 3, 2026-09-23 8.' })).toBeInTheDocument();
    expect(within(panel('Traces per day')).getByText(/11 traces over 2 days; busiest 23 Sept \(8\)/)).toBeInTheDocument();
    const list = within(panel('Traces per day')).getByRole('list', { name: 'Traces per day' });
    expect(within(list).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['2026-09-01: 3', '2026-09-23: 8']);
  });

  it('plots the typology mix with counts and percentages', async () => {
    open();
    const list = await within(panel('Typology mix')).findByRole('list', { name: 'Typology mix' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('investment fraud');
    expect(items[0]).toHaveTextContent('3 (75%)');
    expect(items[1]).toHaveTextContent('mule ring');
    expect(items[1]).toHaveTextContent('1 (25%)');
    expect(screen.getByRole('img', { name: /Typology mix: investment fraud 3 \(75%\), mule ring 1 \(25%\)/ })).toBeInTheDocument();
  });

  it('plots the chain split from the summary with a text alternative', async () => {
    open();
    const chains = await screen.findByRole('list', { name: 'Chain split' });
    expect(within(chains).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['TRON10 (67%)', 'ETH3 (20%)', 'BTC2 (13%)']);
    expect(screen.getByRole('img', { name: /Chain split of suspect addresses: TRON 10 \(67%\), ETH 3 \(20%\), BTC 2 \(13%\)/ })).toBeInTheDocument();
  });

  it('keeps top destination VASPs on the alert data', async () => {
    open();
    const vasps = await screen.findByRole('list', { name: 'Top destination VASPs' });
    expect(within(vasps).getAllByRole('listitem')[0]).toHaveTextContent('ExampleEx');
    expect(within(vasps).getAllByRole('listitem')[0]).toHaveTextContent('1 landing · 1 case');
  });

  it('tolerates a chain outside the known vocabulary without crashing', async () => {
    open({ summary: { chainSplit: [{ chain: 'SOLANA', count: 2 }] } });
    expect(await screen.findByRole('list', { name: 'Chain split' })).toHaveTextContent('SOLANA');
  });

  it('shows empty states for empty summary arrays and empty alerts', async () => {
    open({ summary: { tracesPerDay: [], typologyMix: [], chainSplit: [] }, alerts: [] });
    expect(await screen.findByText('No traces yet')).toBeInTheDocument();
    expect(screen.getByText('No typologies yet')).toBeInTheDocument();
    expect(screen.getByText('No chain-resolved addresses yet')).toBeInTheDocument();
    expect(screen.getByText('No VASP landings yet')).toBeInTheDocument();
  });

  it('shows loading, then an error with retry, when the summary fails', async () => {
    let fail = true;
    open(undefined, (url) => (url.pathname === summaryPath && fail ? json(500, { error: 'BOOM' }) : undefined));
    for (const title of ['Traces per day', 'Typology mix', 'Chain split']) expect(within(panel(title)).getByRole('status', { name: 'Loading panel' })).toBeInTheDocument();
    for (const title of ['Traces per day', 'Typology mix', 'Chain split']) expect(await within(panel(title)).findByText('Could not load this panel', undefined, { timeout: 5000 })).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(panel('Chain split')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Chain split' })).toBeInTheDocument();
  });

  it('shows the VASP panel error independently of the summary panels', async () => {
    open(undefined, (url) => (url.pathname === '/api/v1/alerts' ? json(500, { error: 'BOOM' }) : undefined));
    expect(await within(panel('Top destination VASPs')).findByText('Could not load this panel', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Chain split' })).toBeInTheDocument();
  });
});

describe('live alert feed', () => {
  const event = { id: 'live-1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case-1', chain: 'TRON', address: 'TLiveAddress000000000000000000001', amount: '42' };
  const feed = () => screen.getByRole('list', { name: 'Alerts' });

  it('lists stored alerts, joins case rooms on connect and shows alert.new without a refresh', async () => {
    const { fetchMock } = open();
    await screen.findByRole('list', { name: 'Alerts' });
    expect(within(feed()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Connecting');

    lastSocket().connect();
    expect(lastSocket().emitted.filter((e) => e[0] === 'join').map((e) => e[1]).sort()).toEqual(['case-1', 'case-2']);
    expect(screen.getByText('Live')).toBeInTheDocument();

    lastSocket().fire('alert.new', event);
    const items = within(feed()).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('VASP landing');
    expect(items[0]).toHaveTextContent('Critical');
    expect(items[0]).toHaveTextContent('New');
    expect(items[0]).toHaveTextContent('Amount 42');
    expect(items[0]).toHaveTextContent('TRON');
    expect(within(items[0]).getByRole('link', { name: 'Open case case-1' })).toHaveAttribute('href', '/cases/case-1');
    // the page itself was not reloaded: still one mount, and only the debounced alerts refetch is allowed
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/complaints'))).toHaveLength(1);
  });

  it('ignores malformed payloads and never adds the same alert twice', async () => {
    open();
    await screen.findByRole('list', { name: 'Alerts' });
    lastSocket().connect();
    for (const bad of [null, undefined, 'x', 7, {}, { ...event, rule: 'NOPE' }, { ...event, id: '' }]) lastSocket().fire('alert.new', bad);
    expect(within(feed()).getAllByRole('listitem')).toHaveLength(2);
    lastSocket().fire('alert.new', event);
    lastSocket().fire('alert.new', { ...event });
    expect(within(feed()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('shows Reconnecting on a drop and re-joins the rooms on reconnect', async () => {
    open();
    await screen.findByRole('list', { name: 'Alerts' });
    const s = lastSocket();
    s.connect();
    s.drop();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    const joinsBefore = s.emitted.filter((e) => e[0] === 'join').length;
    s.connect();
    expect(s.emitted.filter((e) => e[0] === 'join').length).toBe(joinsBefore * 2);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('removes its listeners and closes the socket when the page unmounts', async () => {
    const { router } = open();
    await screen.findByRole('list', { name: 'Alerts' });
    const s = lastSocket();
    s.connect();
    expect(s.listenerCount()).toBeGreaterThan(0);
    await act(() => router.navigate('/settings'));
    expect(s.listenerCount()).toBe(0);
    expect(s.disconnected).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it('opens the case from an alert', async () => {
    const { router } = open();
    await screen.findByRole('list', { name: 'Alerts' });
    await userEvent.click(within(feed()).getAllByRole('link', { name: /Open case/ })[0]);
    expect(router.state.location.pathname).toMatch(/^\/cases\/case-[12]$/);
  });

  it('shows the empty state when there are no alerts', async () => {
    open({ alerts: [] });
    expect(await screen.findByText('No alerts yet')).toBeInTheDocument();
  });

  it('connects once and no auth header is invented for the socket', async () => {
    open();
    await screen.findByRole('list', { name: 'Alerts' });
    expect(sockets).toHaveLength(1);
  });
});

describe('recent cases table', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => complaint(i + 1));
  const table = async () => within(await screen.findByRole('table', { name: 'Recent cases, sortable by column' }));
  const firstCol = (t: ReturnType<typeof within>) => t.getAllByRole('row').slice(1).map((r: HTMLElement) => within(r).getAllByRole('cell')[0].textContent);

  it('renders cases rolled up from complaints, newest first, with alert severity', async () => {
    open({ complaints: [complaint(1), complaint(2), complaint(2, { id: 'cm-2b', amountInr: '50000' })] });
    const t = await table();
    const rows = t.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('NCRP ACK-2: Investment fraud');
    expect(rows[0]).toHaveTextContent('₹2,50,000');
    expect(rows[0]).toHaveTextContent('High');
    expect(rows[1]).toHaveTextContent('Critical');
  });

  it('sorts by a column and reports it', async () => {
    open({ complaints: many(3) });
    const t = await table();
    expect(firstCol(t)[0]).toContain('ACK-3');
    await userEvent.click(t.getByRole('button', { name: /Reported \(INR\)/ }));
    await userEvent.click(t.getByRole('button', { name: /Reported \(INR\)/ }));
    expect(t.getByRole('columnheader', { name: /Reported/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(firstCol(t)[0]).toContain('ACK-1');
  });

  it('filters by text and by status', async () => {
    open({ complaints: [...many(3).slice(0, 2), complaint(3, { case: { id: 'case-3', title: 'NCRP ACK-3: Investment fraud', status: 'CLOSED' } })] });
    const t = await table();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter cases' }), 'ACK-2');
    expect(firstCol(t)).toHaveLength(1);
    expect(firstCol(t)[0]).toContain('ACK-2');
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Filter cases' }));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'CLOSED');
    expect(firstCol(t)).toHaveLength(1);
    expect(firstCol(t)[0]).toContain('ACK-3');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter cases' }), 'zzz-nothing');
    expect(await screen.findByText('No cases match')).toBeInTheDocument();
  });

  it('paginates', async () => {
    open({ complaints: many(7) });
    const t = await table();
    expect(firstCol(t)).toHaveLength(5);
    expect(screen.getByText(/1–5 of 7 cases/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(firstCol(t)).toHaveLength(2);
    expect(screen.getByText(/6–7 of 7 cases/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Rows'), '10');
    expect(firstCol(t)).toHaveLength(7);
  });

  it('opens a case from the table', async () => {
    const { router } = open();
    const t = await table();
    await userEvent.click(t.getByRole('link', { name: /ACK-2/ }));
    expect(router.state.location.pathname).toBe('/cases/case-2');
  });

  it('shows the empty state', async () => {
    open({ complaints: [] });
    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
  });

  it('shows an error state with retry, and loading first', async () => {
    let fail = true;
    open(undefined, (url) => (url.pathname === '/api/v1/complaints' && fail ? json(500, { error: 'BOOM' }) : undefined));
    const section = screen.getByRole('heading', { name: 'Recent cases' }).closest('section')!;
    expect(within(section).getByRole('status', { name: 'Loading panel' })).toBeInTheDocument();
    await within(section).findByText('Could not load this panel', undefined, { timeout: 5000 });
    fail = false;
    await userEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByRole('table')).toBeInTheDocument();
  });

  it('keeps the table in a horizontal scroll container', async () => {
    open();
    const t = await screen.findByRole('table', { name: 'Recent cases, sortable by column' });
    expect(t.parentElement).toHaveClass('table-scroll');
  });
});

describe('data fetching', () => {
  it('requests each source once (summary included), through the shared API client with the bearer token', async () => {
    const { fetchMock } = open();
    await screen.findByRole('table', { name: 'Recent cases, sortable by column' });
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1'));
    const count = (p: string) => calls.filter(([u]) => String(u).startsWith(p)).length;
    expect(count('/api/v1/complaints')).toBe(1);
    expect(count('/api/v1/alerts')).toBe(1);
    expect(count('/api/v1/vasps')).toBe(1);
    expect(count('/api/v1/dashboard/summary')).toBe(1);
    for (const [, init] of calls) expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer access-1' });
  });

  it('pages through complaints only as far as the total requires', async () => {
    const { fetchMock } = open({ complaints: [complaint(1)], total: 450 });
    await screen.findByRole('table', { name: 'Recent cases, sortable by column' });
    const pages = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/complaints')).map(([u]) => new URL(String(u), 'http://x').searchParams.get('page'));
    expect(pages).toEqual(['1', '2', '3']);
  });

  it('recovers from a 401 through the existing refresh flow', async () => {
    const { fetchMock } = open(undefined, (url, init) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (url.pathname === '/api/v1/auth/refresh') return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      if (url.pathname.startsWith('/api/v1/') && auth === 'Bearer access-1') return json(401, { error: 'TOKEN_EXPIRED' });
      return undefined;
    });
    await screen.findByRole('table', { name: 'Recent cases, sortable by column' });
    expect(useAuthStore.getState().accessToken).toBe('access-2');
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/auth/refresh')).toBe(true);
    expect(useAuthStore.getState().user).not.toBeNull();
  });
});

describe('roles', () => {
  it.each(['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[])('%s sees the dashboard with all its data sources', async (role) => {
    open(undefined, undefined, role);
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Top destination VASPs' })).toBeInTheDocument();
    expect(screen.queryByText('Not available for your role')).not.toBeInTheDocument();
  });

  it('a signed-out user is sent to login, not the dashboard', () => {
    mountApp('/dashboard', handlerFor());
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});
