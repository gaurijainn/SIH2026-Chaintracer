import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '@/test/fakeCanvas';
import { sockets } from '@/test/fakeSocket';
import { SMALL_GRAPH } from '@/test/graphFixtures';
import { json, mountApp, resetAppState, signInAs, USERS, type FetchHandler } from '@/test/utils';
import { useToastStore } from '@/stores/toast';
import { useUiStore } from '@/stores/ui';
import type { Role } from '@/stores/auth';
import { playAlertSound, primeAlertSound } from './sound';

vi.mock('@/lib/realtime', async () => {
  const { createFakeSocket } = await import('@/test/fakeSocket');
  return { createRealtimeSocket: createFakeSocket };
});
vi.mock('@/features/graph/GraphCanvas', async () => {
  const { GraphCanvas } = await import('@/test/fakeCanvas');
  return { GraphCanvas };
});
vi.mock('./sound', () => ({ primeAlertSound: vi.fn(() => true), playAlertSound: vi.fn(() => true) }));

interface Row {
  id: string;
  caseId: string;
  rule: string;
  severity: string;
  status: string;
  chain: string;
  address: string;
  amount: string | null;
  message: string;
  metadata: unknown;
  hopId: string | null;
  assigneeId: string | null;
  snoozedUntil: string | null;
  createdAt: string;
}
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  caseId: 'case-1',
  rule: 'A2_VASP_LANDING',
  severity: 'CRITICAL',
  status: 'NEW',
  chain: 'TRON',
  address: 'TMID',
  amount: '1500',
  message: `Funds landed at ExampleEx (${id})`,
  metadata: { vaspName: 'ExampleEx', freezeWindowOpen: true },
  hopId: null,
  assigneeId: null,
  snoozedUntil: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  ...over,
});

const complaint = (n: number) => ({
  id: `cm-${n}`,
  ackNo: `ACK-${n}`,
  reportedAt: '2026-09-15T08:00:00.000Z',
  category: 'Investment fraud',
  amountInr: '100000',
  network: 'TRC20',
  caseId: `case-${n}`,
  case: { id: `case-${n}`, title: `NCRP ACK-${n}: Investment fraud`, status: 'OPEN' },
  addresses: [{ address: `TAddr${n}`, chain: 'TRON', kind: 'ADDRESS' }],
});
const CASE = { id: 'case-1', title: 'NCRP ACK-1: Investment fraud', status: 'OPEN', traces: [{ id: 't1', status: 'COMPLETED', seedChain: 'TRON', seedAddr: 'TSEEDADDRESS0000000000000000000001', createdAt: '2026-09-20T07:00:00.000Z', finishedAt: '2026-09-20T07:05:00.000Z' }] };

interface Server {
  alerts: Row[];
  patch?: FetchHandler;
  list?: FetchHandler;
}
const patches = (fetchMock: ReturnType<typeof mountApp>['fetchMock']) =>
  fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'PATCH').map(([u, i]) => ({ url: String(u), body: JSON.parse(String((i as RequestInit).body)) }));
const listCalls = (fetchMock: ReturnType<typeof mountApp>['fetchMock']) =>
  fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x')).filter((u) => u.pathname === '/api/v1/alerts');

function open(server: Server, role: Role = 'INVESTIGATOR', path = '/alerts') {
  signInAs(role);
  return mountApp(path, (url, init) => {
    if (url.pathname === '/api/v1/complaints') return json(200, { total: 2, page: 1, pageSize: 200, items: [complaint(1), complaint(2)] });
    if (url.pathname === '/api/v1/alerts' && init.method === 'PATCH') return server.patch?.(url, init);
    if (url.pathname.startsWith('/api/v1/alerts/') && init.method === 'PATCH') return server.patch?.(url, init);
    if (url.pathname === '/api/v1/alerts') {
      if (server.list) return server.list(url, init);
      const sev = url.searchParams.get('severity');
      const st = url.searchParams.get('status');
      const cs = url.searchParams.get('caseId');
      return json(200, { alerts: server.alerts.filter((a) => (!sev || a.severity === sev) && (!st || a.status === st) && (!cs || a.caseId === cs)) });
    }
    if (url.pathname === '/api/v1/cases/case-1') return json(200, { case: CASE });
    if (url.pathname === '/api/v1/traces/t1/graph') return json(200, SMALL_GRAPH);
    if (url.pathname === '/api/v1/vasps') return json(200, { vasps: [] });
    if (url.pathname === '/api/v1/watchlist') return json(200, { items: [] });
    return undefined;
  });
}

const event = (over: Record<string, unknown> = {}) => ({ id: 'live-1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case-1', chain: 'TRON', address: 'TLIVEADDRESS0000000000000000000001', amount: '2500', ...over });
const socket = () => sockets[sockets.length - 1]!;
const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
  resetAppState();
  useUiStore.setState({ alertSoundEnabled: false });
  useToastStore.setState({ toasts: [] });
  sockets.length = 0;
  probe.reset();
  vi.mocked(playAlertSound).mockClear();
  vi.mocked(primeAlertSound).mockClear();
});

describe('alerts table', () => {
  it('renders the backend alerts with severity, status and IST time as text', async () => {
    open({ alerts: [row('a1'), row('a2', { severity: 'HIGH', status: 'ACKNOWLEDGED', rule: 'A1_MOVEMENT', message: 'Moved 900 USDT' })] });
    const a1 = await screen.findByTestId('alert-a1');
    expect(within(a1).getByText('CRITICAL')).toBeInTheDocument();
    expect(within(a1).getByText('Landed at a VASP')).toBeInTheDocument();
    expect(within(a1).getByText('Funds landed at ExampleEx (a1)')).toBeInTheDocument();
    expect(within(a1).getByText('New')).toBeInTheDocument();
    expect(within(a1).getByText(/15:30 IST/)).toBeInTheDocument();
    const a2 = screen.getByTestId('alert-a2');
    expect(within(a2).getByText(/HIGH/)).toBeInTheDocument();
    expect(within(a2).getByText('Acknowledged')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Severity');
  });

  it('shows a loading state', async () => {
    open({ alerts: [], list: () => new Promise<Response>(() => undefined) });
    expect(await screen.findByRole('status', { name: 'Loading alerts' })).toBeInTheDocument();
  });

  it('shows an empty state and does not invent rows', async () => {
    open({ alerts: [] });
    expect(await screen.findByText('No alerts yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    let fail = true;
    open({ alerts: [row('a1')], list: () => (fail ? json(500, { error: 'BOOM' }) : json(200, { alerts: [row('a1')] })) });
    expect(await screen.findByText('Could not load alerts', undefined, { timeout: 5000 })).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('alert-a1')).toBeInTheDocument();
  });

  it('rejects a malformed response instead of rendering it', async () => {
    open({ alerts: [], list: () => json(200, { alerts: [{ id: 'x' }] }) });
    expect(await screen.findByText(/unexpected alerts response/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe('filters (server-side query parameters)', () => {
  const rows = [row('a1'), row('a2', { severity: 'HIGH', status: 'ACKNOWLEDGED' }), row('a3', { severity: 'MEDIUM', status: 'SNOOZED', caseId: 'case-2' })];

  it('sends the severity filter to the API and shows only matches', async () => {
    const { fetchMock } = open({ alerts: rows });
    await screen.findByTestId('alert-a1');
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'HIGH');
    await waitFor(() => expect(screen.queryByTestId('alert-a1')).not.toBeInTheDocument());
    expect(screen.getByTestId('alert-a2')).toBeInTheDocument();
    expect(listCalls(fetchMock).some((u) => u.searchParams.get('severity') === 'HIGH')).toBe(true);
  });

  it('sends the status filter to the API', async () => {
    const { fetchMock } = open({ alerts: rows });
    await screen.findByTestId('alert-a1');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'SNOOZED');
    await waitFor(() => expect(screen.queryByTestId('alert-a1')).not.toBeInTheDocument());
    expect(screen.getByTestId('alert-a3')).toBeInTheDocument();
    expect(listCalls(fetchMock).some((u) => u.searchParams.get('status') === 'SNOOZED')).toBe(true);
  });

  it('shows a filtered-empty state with a reset', async () => {
    open({ alerts: [row('a1')] });
    await screen.findByTestId('alert-a1');
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'INFO');
    expect(await screen.findByText('No alerts match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /Reset filters/ })[0]!);
    expect(await screen.findByTestId('alert-a1')).toBeInTheDocument();
  });
});

describe('real-time alert.new', () => {
  it('joins the open cases on connect and does not reconnect when a filter changes', async () => {
    open({ alerts: [row('a1')] });
    await screen.findByTestId('alert-a1');
    await waitFor(() => expect(sockets).toHaveLength(1));
    socket().connect();
    const joins = () => socket().emitted.filter((e) => e[0] === 'join').map((e) => e[1]);
    expect(joins().sort()).toEqual(['case-1', 'case-2']);
    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'HIGH');
    await userEvent.selectOptions(screen.getByLabelText('Case'), 'case-2');
    expect(sockets).toHaveLength(1);
    expect(socket().emitted.filter((e) => e[0] === 'leave').map((e) => e[1])).toEqual(['case-1']);
    expect(screen.getByTestId('live-status')).toHaveTextContent('Live: listening');
  });

  it('shows a new alert by refetching the stored row, and a repeated event does not duplicate it or refetch again', async () => {
    const server: Server = { alerts: [row('a1')] };
    const { fetchMock } = open(server);
    await screen.findByTestId('alert-a1');
    await waitFor(() => expect(sockets).toHaveLength(1));
    socket().connect();
    const before = listCalls(fetchMock).length;
    server.alerts = [row('live-1', { severity: 'HIGH', message: 'stored message for live-1', createdAt: '2026-09-21T10:00:00.000Z' }), row('a1')];
    socket().fire('alert.new', event({ severity: 'HIGH' }));
    expect(await screen.findByTestId('alert-live-1')).toBeInTheDocument();
    expect(screen.getByText('stored message for live-1')).toBeInTheDocument();
    socket().fire('alert.new', event({ severity: 'HIGH' }));
    await act(async () => undefined);
    expect(screen.getAllByTestId('alert-live-1')).toHaveLength(1);
    expect(listCalls(fetchMock).length).toBe(before + 1);
  });

  it('ignores malformed events and events for cases it did not join', async () => {
    const { fetchMock } = open({ alerts: [row('a1')] });
    await screen.findByTestId('alert-a1');
    await waitFor(() => expect(sockets).toHaveLength(1));
    socket().connect();
    const before = listCalls(fetchMock).length;
    socket().fire('alert.new', { id: 'bad' });
    socket().fire('alert.new', event({ id: 'other', caseId: 'case-99' }));
    await act(async () => undefined);
    expect(listCalls(fetchMock).length).toBe(before);
    expect(toasts()).toHaveLength(0);
  });

  it('removes its listeners and closes the socket on unmount', async () => {
    const { unmount } = open({ alerts: [row('a1')] });
    await screen.findByTestId('alert-a1');
    await waitFor(() => expect(sockets).toHaveLength(1));
    socket().connect();
    expect(socket().listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(socket().listenerCount()).toBe(0);
    expect(socket().disconnected).toBe(true);
  });
});

describe('CRITICAL toast and sound', () => {
  const openLive = async (over: Partial<Server> = {}, role: Role = 'INVESTIGATOR') => {
    const r = open({ alerts: [row('a1')], ...over }, role);
    await screen.findByTestId('alert-a1');
    await waitFor(() => expect(sockets).toHaveLength(1));
    socket().connect();
    return r;
  };

  it('does not toast or beep for critical alerts that were already stored', async () => {
    useUiStore.setState({ alertSoundEnabled: true });
    await openLive();
    expect(toasts()).toHaveLength(0);
    expect(playAlertSound).not.toHaveBeenCalled();
  });

  it('toasts a new CRITICAL alert once, with only real payload fields and an Open case action', async () => {
    const { router } = await openLive();
    socket().fire('alert.new', event());
    socket().fire('alert.new', event());
    await waitFor(() => expect(toasts()).toHaveLength(1));
    const t = toasts()[0]!;
    expect(t.title).toBe('CRITICAL alert: Landed at a VASP');
    expect(t.description).toContain('TRON');
    expect(t.description).toContain('2,500');
    expect(t.action?.to).toBe('/cases/case-1?focusChain=TRON&focusAddr=TLIVEADDRESS0000000000000000000001');
    await userEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/cases/case-1'));
  });

  it('does not toast for a non-critical new alert', async () => {
    await openLive();
    socket().fire('alert.new', event({ severity: 'HIGH' }));
    await act(async () => undefined);
    expect(toasts()).toHaveLength(0);
  });

  it('plays the sound only after the user enabled it, and only for new CRITICAL alerts', async () => {
    await openLive();
    socket().fire('alert.new', event({ id: 'live-1' }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(playAlertSound).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Enable alert sound' }));
    expect(primeAlertSound).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Alert sound on' })).toHaveAttribute('aria-pressed', 'true');
    vi.mocked(playAlertSound).mockClear(); // the confirmation beep

    socket().fire('alert.new', event({ id: 'live-2', severity: 'HIGH' }));
    await act(async () => undefined);
    expect(playAlertSound).not.toHaveBeenCalled();
    socket().fire('alert.new', event({ id: 'live-3' }));
    await waitFor(() => expect(playAlertSound).toHaveBeenCalledTimes(1));
  });

  it('says so when the browser cannot start audio, and stays silent', async () => {
    vi.mocked(primeAlertSound).mockReturnValueOnce(false);
    await openLive();
    await userEvent.click(screen.getByRole('button', { name: 'Enable alert sound' }));
    expect(toasts().some((t) => t.title === 'Sound is not available')).toBe(true);
    expect(screen.getByRole('button', { name: 'Enable alert sound' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('acknowledge, assign, snooze (PATCH /alerts/:id)', () => {
  const patched = (over: Partial<Row>) => (url: URL) => json(200, { alert: row(url.pathname.split('/').pop()!, over) });

  it('acknowledges through the API and only then refetches', async () => {
    const { fetchMock } = open({ alerts: [row('a1')], patch: patched({ status: 'ACKNOWLEDGED' }) });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(patches(fetchMock)[0]).toEqual({ url: '/api/v1/alerts/a1', body: { action: 'acknowledge' } });
    await waitFor(() => expect(toasts().some((t) => t.title === 'Alert acknowledged')).toBe(true));
  });

  it('does not fake success when the API rejects the change', async () => {
    open({ alerts: [row('a1')], patch: () => json(500, { error: 'BOOM' }) });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(toasts().some((t) => t.title === 'Could not update the alert')).toBe(true));
    expect(toasts().some((t) => t.kind === 'success')).toBe(false);
    expect(within(screen.getByTestId('alert-a1')).getByText('New')).toBeInTheDocument();
  });

  it('shows the backend permission error on a 403', async () => {
    open({ alerts: [row('a1')], patch: () => json(403, { error: 'FORBIDDEN' }) });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(toasts().find((t) => t.title === 'Could not update the alert')?.description).toBe('Your role does not permit this action.'));
  });

  it('assigns to the signed-in user only (no user list exists)', async () => {
    const { fetchMock } = open({ alerts: [row('a1')], patch: patched({ status: 'ASSIGNED', assigneeId: USERS.INVESTIGATOR.id }) });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('button', { name: /Assign alert .* to me/ }));
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(patches(fetchMock)[0]!.body).toEqual({ action: 'assign', assigneeId: 'u-inv' });
  });

  it('snoozes with a future ISO instant', async () => {
    const { fetchMock } = open({ alerts: [row('a1')], patch: patched({ status: 'SNOOZED' }) });
    const a1 = await screen.findByTestId('alert-a1');
    const t0 = Date.now();
    await userEvent.selectOptions(within(a1).getByLabelText(/Snooze alert/), '3600000');
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    const { action, snoozedUntil } = patches(fetchMock)[0]!.body;
    expect(action).toBe('snooze');
    const until = Date.parse(snoozedUntil);
    expect(until).toBeGreaterThanOrEqual(t0 + 3_600_000);
    expect(until).toBeLessThan(t0 + 3_600_000 + 60_000);
  });

  it('shows assigned and snoozed state from the backend row', async () => {
    open({ alerts: [row('a1', { status: 'ASSIGNED', assigneeId: 'u-inv' }), row('a2', { status: 'SNOOZED', snoozedUntil: '2026-09-25T10:00:00.000Z' })] });
    expect(await within(await screen.findByTestId('alert-a1')).findByText('Assigned to you')).toBeInTheDocument();
    expect(within(screen.getByTestId('alert-a2')).getByText(/Until 25 Sept 2026, 15:30 IST/)).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it.each(['VIEWER', 'ADMIN'] as const)('%s can read alerts but is offered no actions', async (role) => {
    open({ alerts: [row('a1')] }, role);
    const a1 = await screen.findByTestId('alert-a1');
    expect(within(a1).queryByRole('button', { name: /Acknowledge/ })).not.toBeInTheDocument();
    expect(within(a1).queryByRole('button', { name: /Assign/ })).not.toBeInTheDocument();
    expect(within(a1).queryByLabelText(/Snooze/)).not.toBeInTheDocument();
    expect(screen.getByText('Read-only access')).toBeInTheDocument();
  });

  it.each(['INVESTIGATOR', 'SUPERVISOR'] as const)('%s is offered the actions', async (role) => {
    open({ alerts: [row('a1')] }, role);
    const a1 = await screen.findByTestId('alert-a1');
    expect(within(a1).getByRole('button', { name: /Acknowledge/ })).toBeEnabled();
    expect(screen.queryByText('Read-only access')).not.toBeInTheDocument();
  });
});

describe('deep link to the graph', () => {
  it('opens the case graph with the alert address selected', async () => {
    const { router } = open({ alerts: [row('a1', { address: 'TMID' })] });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('link', { name: /in the case graph/ }));
    expect(router.state.location.pathname).toBe('/cases/case-1');
    expect(router.state.location.search).toBe('?focusChain=TRON&focusAddr=TMID');
    const panel = await screen.findByRole('complementary', { name: 'Node details' });
    expect(within(panel).getByText('TMID')).toBeInTheDocument();
  });

  it('says so when the alert address is not in the trace graph', async () => {
    open({ alerts: [row('a1', { address: 'TNOTINGRAPH' })] });
    const a1 = await screen.findByTestId('alert-a1');
    await userEvent.click(within(a1).getByRole('link', { name: /in the case graph/ }));
    expect(await screen.findByText(/is not in this trace's graph/)).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Node details' })).not.toBeInTheDocument();
  });
});
