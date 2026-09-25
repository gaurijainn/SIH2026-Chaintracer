import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { App } from '@/App';
import { createQueryClient } from '@/lib/queryClient';
import { createTestRouter } from '@/router';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '@/test/fakeCanvas';
import { sockets } from '@/test/fakeSocket';
import { SMALL_GRAPH } from '@/test/graphFixtures';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import type { Role } from '@/stores/auth';

vi.mock('@/lib/realtime', async () => {
  const { createFakeSocket } = await import('@/test/fakeSocket');
  return { createRealtimeSocket: createFakeSocket };
});
vi.mock('./GraphCanvas', async () => {
  const { GraphCanvas } = await import('@/test/fakeCanvas');
  return { GraphCanvas };
});

const CASE = { id: 'case-1', title: 'NCRP ACK-1: Investment fraud', status: 'OPEN', traces: [{ id: 't1', status: 'COMPLETED', seedChain: 'TRON', seedAddr: 'TSEEDADDRESS0000000000000000000001', createdAt: '2026-09-20T07:00:00.000Z', finishedAt: '2026-09-20T07:05:00.000Z' }] };
const ETH = 'ETH:0xabc0000000000000000000000000000000000001';

interface Opts {
  graph?: unknown;
  graphResponse?: () => Response | Promise<Response>;
  watchlist?: { id: string; chain: string; addr: string }[];
  post?: FetchHandler;
  extra?: FetchHandler;
}
const graphCalls = (fetchMock: ReturnType<typeof mountApp>['fetchMock']) => fetchMock.mock.calls.map(([u]) => new URL(String(u), 'http://x')).filter((u) => u.pathname === '/api/v1/traces/t1/graph');
const posts = (fetchMock: ReturnType<typeof mountApp>['fetchMock']) => fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith('/watchlist') && (i as RequestInit)?.method === 'POST').map(([, i]) => JSON.parse(String((i as RequestInit).body)));

function open(o: Opts = {}, role: Role = 'INVESTIGATOR') {
  signInAs(role);
  return mountApp('/cases/case-1', (url, init) => {
    const custom = o.extra?.(url, init);
    if (custom) return custom;
    if (url.pathname === '/api/v1/cases/case-1') return json(200, { case: CASE });
    if (url.pathname === '/api/v1/traces/t1/graph') return o.graphResponse ? o.graphResponse() : json(200, o.graph ?? SMALL_GRAPH);
    if (url.pathname === '/api/v1/vasps') return json(200, { vasps: [{ id: 'v1', name: 'Demo Exchange', addresses: [{ chain: 'TRON', addr: 'TVASP' }] }] });
    if (url.pathname === '/api/v1/watchlist') return init.method === 'POST' ? (o.post?.(url, init) ?? json(201, { item: { id: 'w' } })) : json(200, { items: o.watchlist ?? [] });
    return undefined;
  });
}
const ready = async () => screen.findByTestId('fake-canvas');
const canvasAttr = (name: string) => screen.getByTestId('fake-canvas').getAttribute(name);
const summary = () => screen.getByTestId('graph-summary').textContent ?? '';
const click = (name: string) => userEvent.click(screen.getByRole('button', { name }));

const hopEvent = (over: Record<string, unknown> = {}) => ({
  traceId: 't1',
  caseId: 'case-1',
  edge: { chain: 'TRON', from: 'TSIDE', to: 'TNEW', token: 'USDT', amount: '20', usd: 20, txHash: 'txNEW', ts: Date.parse('2026-09-21T00:00:00Z') },
  fromNode: { chain: 'TRON', addr: 'TSIDE', hop: 2 },
  toNode: { chain: 'TRON', addr: 'TNEW', hop: 3 },
  ...over,
});

beforeEach(() => {
  resetAppState();
  sockets.length = 0;
  probe.reset();
});

describe('case page and graph loading', () => {
  it('opens the case once (one audited view) and loads the graph for its trace', async () => {
    const { fetchMock } = open();
    expect(screen.getByRole('heading', { level: 1, name: 'Case' })).toBeInTheDocument();
    await ready();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/v1/cases/case-1')).toHaveLength(1);
    expect(graphCalls(fetchMock)).toHaveLength(1);
    expect(canvasAttr('data-nodes')).toBe('5');
    expect(canvasAttr('data-edges')).toBe('4');
    expect(summary()).toContain('5 nodes, 4 edges');
    expect(screen.getByText('NCRP ACK-1: Investment fraud')).toBeInTheDocument();
  });

  it('uses the shared API client: bearer token on every call', async () => {
    const { fetchMock } = open();
    await ready();
    for (const [, init] of fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1'))) expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer access-1' });
  });

  it('shows a loading state while the graph is in flight', async () => {
    open({ graphResponse: () => new Promise<Response>(() => undefined) });
    expect(await screen.findByRole('status', { name: 'Loading graph' })).toBeInTheDocument();
  });

  it('shows an error state with retry when the graph request fails', async () => {
    let fail = true;
    open({ graphResponse: () => (fail ? json(500, { error: 'BOOM' }) : json(200, SMALL_GRAPH)) });
    expect(await screen.findByText('Could not load the graph', undefined, { timeout: 5000 })).toBeInTheDocument();
    fail = false;
    await click('Try again');
    await ready();
  });

  it('rejects a malformed graph response instead of rendering it', async () => {
    open({ graph: { traceId: 't1', nodes: 'lots', edges: [] } });
    expect(await screen.findByText(/unexpected graph response/, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
  });

  it('shows an empty state for a trace with no transfers', async () => {
    open({ graph: { traceId: 't1', nodes: [], edges: [] } });
    expect(await screen.findByText('No transfers recorded for this trace yet')).toBeInTheDocument();
  });

  it('marks VASP nodes from the registry and leaves others as unclassified wallets', async () => {
    open();
    await ready();
    const roles = Object.fromEntries((probe.props!.graph.nodes).map((n) => [n.id, n.role]));
    expect(roles['TRON:TVASP']).toBe('vasp');
    expect(roles['TRON:TMID']).toBe('wallet');
  });
});

describe('node selection, side panel and explorer', () => {
  it('opens a side panel with what the API knows, and says what it does not', async () => {
    open();
    await ready();
    await click('select TRON:TVASP');
    const panel = screen.getByRole('complementary', { name: 'Node details' });
    expect(within(panel).getByText('VASP · Demo Exchange')).toBeInTheDocument();
    expect(within(panel).getByText('TVASP')).toBeInTheDocument();
    expect(within(panel).getByText(/from the VASP registry/)).toBeInTheDocument();
    expect(within(panel).getByText(/Unknown \(not returned by the graph API\)/)).toBeInTheDocument();
    expect(within(panel).getAllByText('$900').length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Latest transfers/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Node details' })).not.toBeInTheDocument();
  });

  it('copies the address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open();
    await ready();
    await click('select TRON:TMID');
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Node details' })).getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledWith('TMID');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('links to the chain-specific explorer, and the right-click menu offers copy and explorer', async () => {
    open();
    await ready();
    await click('select TRON:TMID');
    expect(within(screen.getByRole('complementary', { name: 'Node details' })).getByRole('link', { name: /Open explorer/ })).toHaveAttribute('href', 'https://tronscan.org/#/address/TMID');
    await click(`menu ${ETH}`);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Copy address/ })).toBeInTheDocument();
    const link = within(menu).getByRole('menuitem', { name: /Open in explorer/ });
    expect(link).toHaveAttribute('href', 'https://etherscan.io/address/0xabc0000000000000000000000000000000000001');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('keeps the panel as an overlay drawer on small screens and a column on large ones', async () => {
    open();
    await ready();
    await click('select TRON:TMID');
    const panel = screen.getByRole('complementary', { name: 'Node details' });
    expect(panel.className).toMatch(/fixed inset-x-0 bottom-0/);
    expect(panel.className).toMatch(/lg:static/);
    expect(screen.getByRole('form', { name: 'Graph filters' }).className).toMatch(/flex-wrap/);
    expect(screen.getByRole('toolbar', { name: 'Graph tools' }).className).toMatch(/flex-wrap/);
  });

  it('offers a keyboard-accessible node list and a text summary of the graph state', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByText(/Node list/));
    await userEvent.click(within(screen.getByRole('list', { name: 'Graph nodes' })).getAllByRole('button')[1]);
    expect(screen.getByRole('complementary', { name: 'Node details' })).toBeInTheDocument();
    expect(summary()).toMatch(/Selected: Wallet TRON/);
    expect(summary()).toMatch(/Filters: none/);
  });
});

describe('filters (server-side, debounced)', () => {
  it('sends the chain filter to the API and does not refetch until it changes', async () => {
    const { fetchMock } = open();
    await ready();
    await userEvent.selectOptions(screen.getByLabelText('Chain'), 'ETH');
    await waitFor(() => expect(graphCalls(fetchMock).at(-1)!.searchParams.get('chain')).toBe('ETH'));
    expect(summary()).toMatch(/Filters: chain ETH/);
  });

  it('sends the minimum value', async () => {
    const { fetchMock } = open();
    await ready();
    await userEvent.type(screen.getByLabelText('Minimum value (USD)'), '250');
    await waitFor(() => expect(graphCalls(fetchMock).at(-1)!.searchParams.get('minValueUsd')).toBe('250'));
    // typing three characters produced ONE filtered request, not one per keystroke
    expect(graphCalls(fetchMock).filter((u) => u.searchParams.get('minValueUsd')).map((u) => u.searchParams.get('minValueUsd'))).toEqual(['250']);
  });

  it('sends the time range as IST day bounds, and reset clears every filter', async () => {
    const { fetchMock } = open();
    await ready();
    fireEvent.change(screen.getByLabelText('From date (IST)'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('To date (IST)'), { target: { value: '2026-09-21' } });
    await waitFor(() => {
      const q = graphCalls(fetchMock).at(-1)!.searchParams;
      expect(q.get('from')).toBe('2026-09-19T18:30:00.000Z');
      expect(q.get('to')).toBe('2026-09-21T18:29:59.999Z');
    });
    await click('Reset filters');
    await waitFor(() => expect(summary()).toMatch(/Filters: none/));
    expect(screen.getByLabelText('From date (IST)')).toHaveValue('');
    expect(screen.getByLabelText('To date (IST)')).toHaveValue('');
    expect(screen.getByLabelText('Chain')).toHaveValue('');
  });

  it('keeps the selected node and the canvas while a filter loads', async () => {
    open();
    await ready();
    await click('select TRON:TMID');
    await userEvent.selectOptions(screen.getByLabelText('Chain'), 'ETH');
    expect(screen.getByTestId('fake-canvas')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Node details' })).toBeInTheDocument();
  });

  it('explains an empty filtered result and offers a reset', async () => {
    open({ extra: (url) => (url.pathname === '/api/v1/traces/t1/graph' && url.searchParams.get('chain') === 'BTC' ? json(200, { traceId: 't1', nodes: [], edges: [] }) : undefined) });
    await ready();
    await userEvent.selectOptions(screen.getByLabelText('Chain'), 'BTC');
    expect(await screen.findByText('No transfers match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Reset filters' })[1]);
    await ready();
  });

  it('changes layout without refetching', async () => {
    const { fetchMock } = open();
    await ready();
    const before = graphCalls(fetchMock).length;
    await userEvent.selectOptions(screen.getByLabelText('Layout'), 'fcose');
    expect(canvasAttr('data-layout')).toBe('fcose');
    expect(graphCalls(fetchMock)).toHaveLength(before);
  });
});

describe('time replay (local)', () => {
  const slider = () => screen.getByRole('slider', { name: 'Replay time' }) as HTMLInputElement;

  it('reveals flow progressively as the slider moves, without a network request', async () => {
    const { fetchMock } = open();
    await ready();
    const before = graphCalls(fetchMock).length;
    fireEvent.change(slider(), { target: { value: String(Number(slider().min) + 3_600_000) } });
    expect(canvasAttr('data-edges')).toBe('2');
    expect(canvasAttr('data-nodes')).toBe('3');
    expect(summary()).toMatch(/2 edges shown of 5 nodes, 4 edges/);
    fireEvent.change(slider(), { target: { value: slider().max } });
    expect(canvasAttr('data-edges')).toBe('4');
    expect(graphCalls(fetchMock)).toHaveLength(before);
  });

  it('plays and pauses', async () => {
    open();
    await ready();
    await click('Play replay');
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
    await waitFor(() => expect(Number(canvasAttr('data-edges'))).toBeLessThan(4));
    await click('Pause replay');
    const frozen = screen.getByTestId('replay-time').textContent;
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.getByTestId('replay-time').textContent).toBe(frozen);
    await click('Show all');
    expect(canvasAttr('data-edges')).toBe('4');
  });
});

describe('heaviest path', () => {
  it('highlights the greatest cumulative path (not the largest edge) and can be turned off', async () => {
    open();
    await ready();
    expect(canvasAttr('data-path-edges')).toBe('');
    await click('Heaviest path');
    expect(canvasAttr('data-path-edges')).toBe('e1,e2');
    expect(canvasAttr('data-nodes')).toBe('5'); // the rest of the graph is not hidden
    expect(summary()).toMatch(/Heaviest path: 2 hops, \$1,900/);
    expect(screen.getByRole('button', { name: 'Heaviest path' })).toHaveAttribute('aria-pressed', 'true');
    await click('Heaviest path');
    expect(canvasAttr('data-path-edges')).toBe('');
  });
});

describe('progressive expansion', () => {
  it('reveals hop by hop and expands a node on demand from the loaded data', async () => {
    const { fetchMock } = open();
    await ready();
    const calls = graphCalls(fetchMock).length;
    await userEvent.click(screen.getByLabelText('Reveal hop by hop'));
    expect(canvasAttr('data-edges')).toBe('2'); // e1, e4 leave the source
    await click('select TRON:TMID');
    await click('Expand (2)');
    expect(canvasAttr('data-edges')).toBe('4');
    expect(graphCalls(fetchMock)).toHaveLength(calls); // no new request
  });

  it('disables Expand when everything is already shown', async () => {
    open();
    await ready();
    await click('select TRON:TMID');
    expect(screen.getByRole('button', { name: /Expand/ })).toBeDisabled();
  });
});

describe('lasso and watchlist', () => {
  const lasso = async (ids: string[]) => {
    probe.lassoResult = ids;
    await click('Lasso select');
    const overlay = screen.getByTestId('lasso-overlay');
    fireEvent.pointerDown(overlay, { clientX: 1, clientY: 1 });
    fireEvent.pointerMove(overlay, { clientX: 50, clientY: 5 });
    fireEvent.pointerMove(overlay, { clientX: 50, clientY: 50 });
    fireEvent.pointerUp(overlay);
  };

  it('selects the lassoed nodes and marks them on the canvas', async () => {
    open();
    await ready();
    await lasso(['TRON:TMID', 'TRON:TVASP']);
    expect(canvasAttr('data-multi')).toBe('TRON:TMID,TRON:TVASP');
    expect(within(screen.getByTestId('selection-bar')).getByText('2 addresses selected')).toBeInTheDocument();
    expect(screen.queryByTestId('lasso-overlay')).not.toBeInTheDocument();
    expect(summary()).toMatch(/2 in selection/);
  });

  it('adds the selected addresses through POST /watchlist with the case id', async () => {
    const { fetchMock } = open();
    await ready();
    await lasso(['TRON:TMID', 'TRON:TVASP']);
    await click('Add selected to watchlist');
    expect(await screen.findByText(/Watchlist: 2 added/)).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([
      { caseId: 'case-1', chain: 'TRON', addr: 'TMID', reason: 'manual' },
      { caseId: 'case-1', chain: 'TRON', addr: 'TVASP', reason: 'manual' },
    ]);
    expect(canvasAttr('data-multi')).toBe('');
  });

  it('reports addresses that are already watched without posting them again', async () => {
    const { fetchMock } = open({ watchlist: [{ id: 'w1', chain: 'TRON', addr: 'TMID' }] });
    await ready();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/v1/watchlist'))).toBe(true));
    await lasso(['TRON:TMID', 'TRON:TVASP']);
    await click('Add selected to watchlist');
    expect(await screen.findByText(/Watchlist: 1 added, 1 already watched/)).toBeInTheDocument();
    expect(posts(fetchMock).map((p) => p.addr)).toEqual(['TVASP']);
  });

  it('reports an API failure per address', async () => {
    open({ post: () => json(400, { error: 'INVALID_ADDRESS', message: 'not a valid address' }) });
    await ready();
    await lasso(['TRON:TMID']);
    await click('Add selected to watchlist');
    expect(await screen.findByText(/Watchlist: 1 failed/)).toBeInTheDocument();
    expect(screen.getByTestId('selection-bar')).toBeInTheDocument(); // selection kept for a retry
  });

  it('adds one node from the side panel, and shows Watched for a watched one', async () => {
    const { fetchMock } = open({ watchlist: [{ id: 'w1', chain: 'TRON', addr: 'TVASP' }] });
    await ready();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/v1/watchlist'))).toBe(true));
    await click('select TRON:TVASP');
    const panel = screen.getByRole('complementary', { name: 'Node details' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Already watched' })).toBeDisabled());
    await click('select TRON:TMID');
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Node details' })).getByRole('button', { name: 'Add to watchlist' }));
    expect(await screen.findByText(/Watchlist: 1 added/)).toBeInTheDocument();
  });

  it.each(['VIEWER', 'ADMIN'] as Role[])('%s cannot see write actions and is told why', async (role) => {
    open({}, role);
    await ready();
    expect(screen.getByText(/Read-only access: adding addresses to the watchlist needs/)).toBeInTheDocument();
    await click('select TRON:TMID');
    expect(screen.queryByRole('button', { name: 'Add to watchlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add selected to watchlist' })).not.toBeInTheDocument();
  });

  it.each(['INVESTIGATOR', 'SUPERVISOR'] as Role[])('%s sees the write action', async (role) => {
    open({}, role);
    await ready();
    await click('select TRON:TMID');
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeInTheDocument();
  });
});

describe('PNG export', () => {
  it('exports the whole graph as a PNG download', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    open();
    await ready();
    await click('Export PNG');
    expect(probe.exportPng).toHaveBeenCalledWith(2);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Exported trace-t1-graph.png')).toBeInTheDocument();
  });

  it('cannot export an empty graph', async () => {
    open({ graph: { traceId: 't1', nodes: [], edges: [] } });
    await screen.findByText('No transfers recorded for this trace yet');
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeDisabled();
  });
});

describe('canvas controls', () => {
  it('has accessible zoom and fit controls', async () => {
    open();
    await ready();
    await click('Zoom in');
    await click('Zoom out');
    await click('Fit graph to view');
    expect(probe.zoomBy).toHaveBeenCalledTimes(2);
    expect(probe.fit).toHaveBeenCalledTimes(1);
  });
});

describe('live trace mode', () => {
  const connected = async () => {
    open();
    await ready();
    const s = sockets[sockets.length - 1];
    s.connect();
    return s;
  };

  it('joins the case room and adds a live hop without a refetch', async () => {
    const { fetchMock } = (() => {
      return open();
    })();
    await ready();
    const s = sockets[sockets.length - 1];
    s.connect();
    expect(s.emitted).toContainEqual(['join', 'case-1']);
    expect(screen.getByText('Live: listening')).toBeInTheDocument();
    const calls = graphCalls(fetchMock).length;
    s.fire('trace.hop', hopEvent());
    expect(canvasAttr('data-nodes')).toBe('6');
    expect(canvasAttr('data-edges')).toBe('5');
    expect(probe.props!.graph.nodes.find((n) => n.id === 'TRON:TNEW')!.live).toBe(true);
    expect(graphCalls(fetchMock)).toHaveLength(calls);
  });

  it('does not duplicate a repeated hop, or a hop the API already returned', async () => {
    const s = await connected();
    s.fire('trace.hop', hopEvent());
    s.fire('trace.hop', hopEvent());
    s.fire('trace.hop', hopEvent({ edge: { chain: 'TRON', from: 'TSEED', to: 'TMID', token: 'USDT', amount: '1000', usd: 1000, txHash: 'tx1', ts: 0 }, fromNode: { chain: 'TRON', addr: 'TSEED', hop: 0 }, toNode: { chain: 'TRON', addr: 'TMID', hop: 1 } }));
    expect(canvasAttr('data-nodes')).toBe('6');
    expect(canvasAttr('data-edges')).toBe('5');
  });

  it('ignores other traces and malformed payloads', async () => {
    const s = await connected();
    s.fire('trace.hop', hopEvent({ traceId: 'other' }));
    for (const bad of [null, undefined, 'x', {}, { traceId: 't1' }]) s.fire('trace.hop', bad);
    expect(canvasAttr('data-nodes')).toBe('5');
  });

  it('applies the active filters to live hops', async () => {
    open();
    await ready();
    await userEvent.selectOptions(screen.getByLabelText('Chain'), 'ETH');
    await waitFor(() => expect(summary()).toMatch(/chain ETH/));
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const s = sockets[sockets.length - 1];
    s.connect();
    s.fire('trace.hop', hopEvent()); // a TRON hop under an ETH filter
    expect(canvasAttr('data-edges')).toBe('4');
  });

  it('shows progress and completion', async () => {
    const s = await connected();
    s.fire('trace.progress', { traceId: 't1', caseId: 'case-1', hopsDone: 3, frontier: 7, apiCalls: 21 });
    expect(screen.getByTestId('live-progress')).toHaveTextContent('3 hops done, frontier 7, 21 provider calls');
    s.fire('trace.completed', { traceId: 't1', caseId: 'case-1', durationMs: 3200, terminals: [{ chain: 'TRON', addr: 'TVASP', reason: 'exchange', label: 'Demo Exchange' }] });
    expect(screen.getByTestId('live-completed')).toHaveTextContent('Trace completed in 3.2 s with 1 terminal point');
    expect(screen.getAllByText('Trace complete').length).toBeGreaterThan(0);
  });

  it('shows reconnecting after a drop and re-joins the room', async () => {
    const s = await connected();
    s.drop();
    expect(screen.getByText('Live: reconnecting')).toBeInTheDocument();
    s.connect();
    expect(s.emitted.filter((e) => e[0] === 'join')).toHaveLength(2);
  });

  it('removes its listeners and closes the socket when the page unmounts', async () => {
    const { router } = (() => open())();
    await ready();
    const s = sockets[sockets.length - 1];
    s.connect();
    expect(s.listenerCount()).toBeGreaterThan(0);
    await act(() => router.navigate('/settings'));
    expect(s.listenerCount()).toBe(0);
    expect(s.disconnected).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});

describe('React StrictMode', () => {
  it('leaves one live socket with one listener set, so a hop is added exactly once', async () => {
    signInAs('INVESTIGATOR');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://x');
      if (u.pathname === '/health') return json(200, { mode: 'live' });
      if (u.pathname === '/api/v1/cases/case-1') return json(200, { case: CASE });
      if (u.pathname === '/api/v1/traces/t1/graph') return json(200, SMALL_GRAPH);
      if (u.pathname === '/api/v1/vasps') return json(200, { vasps: [] });
      if (u.pathname === '/api/v1/watchlist') return json(200, { items: [] });
      return json(404, {});
    }));
    render(
      <StrictMode>
        <App queryClient={createQueryClient()} router={createTestRouter(['/cases/case-1'])} />
      </StrictMode>,
    );
    await ready();
    const live = sockets.filter((s) => !s.disconnected);
    expect(live).toHaveLength(1);
    live[0].connect();
    live[0].fire('trace.hop', hopEvent());
    expect(canvasAttr('data-edges')).toBe('5');
    expect(canvasAttr('data-nodes')).toBe('6');
    for (const gone of sockets.filter((s) => s.disconnected)) expect(gone.listenerCount()).toBe(0);
  });
});

describe('permissions', () => {
  it.each(['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[])('%s can open the case graph (graph:read is in every role)', async (role) => {
    open({}, role);
    expect(await ready()).toBeInTheDocument();
  });
});
