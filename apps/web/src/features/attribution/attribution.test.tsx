import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '@/features/graph/model';
import { SMALL_GRAPH } from '@/test/graphFixtures';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import type { Role } from '@/stores/auth';
import { destinations, pathBetween } from './derive';
import type { RegistryVasp } from './api';

vi.mock('@/lib/realtime', async () => {
  const { createFakeSocket } = await import('@/test/fakeSocket');
  return { createRealtimeSocket: createFakeSocket };
});
vi.mock('@/features/graph/GraphCanvas', async () => {
  const { GraphCanvas } = await import('@/test/fakeCanvas');
  return { GraphCanvas };
});

const CASE = { id: 'case-1', title: 'NCRP ACK-1', status: 'OPEN', traces: [{ id: 't1', status: 'COMPLETED', seedChain: 'TRON', seedAddr: 'TSEED', createdAt: '2026-09-20T07:00:00.000Z', finishedAt: null }] };
// Confidence arrives as a Prisma Decimal string.
const VASPS = [
  {
    id: 'v1',
    name: 'Demo Exchange',
    type: 'CENTRALISED_EXCHANGE',
    jurisdiction: 'Seychelles',
    fiuStatus: 'NOTICED',
    fiuStatusDate: '2026-01-15T00:00:00.000Z',
    fiuSource: null,
    addresses: [{ id: 'a1', chain: 'TRON', addr: 'TVASP', kind: 'HOT_WALLET', source: 'tronscan-tag', confidence: '0.850' }],
  },
  { id: 'v2', name: 'Unreached OTC', type: 'OTC', jurisdiction: 'UAE', fiuStatus: 'REGISTERED', addresses: [{ chain: 'TRON', addr: 'TNOTINTRACE', source: 'x', confidence: '0.700' }] },
];

function open(o: { vasps?: unknown; vaspsResponse?: () => Response; extra?: FetchHandler } = {}, role: Role = 'INVESTIGATOR') {
  signInAs(role);
  return mountApp('/cases/case-1', (url, init) => {
    const custom = o.extra?.(url, init);
    if (custom) return custom;
    if (url.pathname === '/api/v1/cases/case-1') return json(200, { case: CASE });
    if (url.pathname === '/api/v1/traces/t1/graph') return json(200, SMALL_GRAPH);
    if (url.pathname === '/api/v1/vasps') return o.vaspsResponse ? o.vaspsResponse() : json(200, { vasps: o.vasps ?? VASPS });
    if (url.pathname === '/api/v1/watchlist') return json(200, { items: [] });
    return undefined;
  });
}
const called = (fm: ReturnType<typeof mountApp>['fetchMock'], path: string) => fm.mock.calls.map(([u]) => new URL(String(u), 'http://x')).filter((u) => u.pathname === path);

describe('F6 destination VASP view', () => {
  beforeEach(() => resetAppState());

  it('reads the trace graph and registry for the right trace and renders only registry-backed VASPs', async () => {
    const { fetchMock } = open();
    const region = await screen.findByRole('region', { name: 'Where to send the notice' }, { timeout: 8000 });
    expect(await within(region).findByText('Demo Exchange')).toBeInTheDocument();
    expect(called(fetchMock, '/api/v1/traces/t1/graph').length).toBeGreaterThan(0);
    expect(called(fetchMock, '/api/v1/vasps').length).toBeGreaterThan(0);
    expect(called(fetchMock, '/api/v1/traces/t1/attribution')).toHaveLength(0);
    expect(within(region).queryByText('Unreached OTC')).not.toBeInTheDocument();
    expect(within(region).getByText(/centralised exchange · Seychelles/)).toBeInTheDocument();
    expect(within(region).getByText(/FIU-IND: NOTICED \(2026-01-15\)/)).toBeInTheDocument();
    // amount reached and hop count are the backend's node.inUsd (900) and hopNo (2)
    expect(within(region).getByText('Amount reached').nextElementSibling).toHaveTextContent('$900');
    expect(within(region).getByText('Hop count').nextElementSibling).toHaveTextContent('2');
  });

  it('shows the registry confidence as sent, and says attribution confidence is not provided', async () => {
    open();
    const region = await screen.findByRole('region', { name: 'Where to send the notice' }, { timeout: 8000 });
    expect(await within(region).findByText(/registry confidence: 0\.850/)).toBeInTheDocument();
    expect(within(region).getByText('Attribution confidence').nextElementSibling).toHaveTextContent('Not provided by the API yet');
  });

  it('lists the real incoming transfer as evidence and draws the real seed-to-deposit path', async () => {
    open();
    const region = await screen.findByRole('region', { name: 'Where to send the notice' }, { timeout: 8000 });
    expect(await within(region).findByText('tx2')).toBeInTheDocument();
    const path = within(region).getByRole('list', { name: 'Path from seed address to deposit address' });
    expect(within(path).getAllByRole('listitem')).toHaveLength(3); // TSEED -> TMID -> TVASP
    expect(path).toHaveTextContent('Seed');
    expect(path).toHaveTextContent('Deposit');
    // no per-transaction explorer mapping exists, so the hash is plain text; only the address links out
    expect(within(region).queryByRole('link', { name: /tx2/ })).not.toBeInTheDocument();
    expect(within(region).getByRole('link', { name: /block explorer/ })).toHaveAttribute('href', 'https://tronscan.org/#/address/TVASP');
  });

  it('links the notice action to the F8 builder for this case and VASP, and creates nothing itself', async () => {
    const { fetchMock } = open();
    const region = await screen.findByRole('region', { name: 'Where to send the notice' }, { timeout: 8000 });
    const link = await within(region).findByRole('link', { name: 'Draft freeze notice' });
    expect(link).toHaveAttribute('href', '/reports?caseId=case-1&vaspId=v1');
    expect(fetchMock.mock.calls.filter(([u, i]) => /freeze/.test(String(u)) || (i as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('shows an empty state when no registry hot wallet is in the trace', async () => {
    open({ vasps: [VASPS[1]] });
    expect(await screen.findByText('No destination VASP found in this trace', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText('Demo Exchange')).not.toBeInTheDocument();
  });

  it('shows the API error when the registry request fails', async () => {
    open({ vaspsResponse: () => json(500, { error: 'INTERNAL', message: 'registry down' }) });
    expect(await screen.findByText('Could not load destination VASPs', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText('Demo Exchange')).not.toBeInTheDocument();
  });

  it('is shown to a Viewer (read-only) but never offers an enabled notice action', async () => {
    open({}, 'VIEWER');
    const region = await screen.findByRole('region', { name: 'Where to send the notice' }, { timeout: 8000 });
    expect(await within(region).findByText('Demo Exchange')).toBeInTheDocument();
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Draft freeze notice' })).toBeDisabled());
  });
});

describe('destinations()', () => {
  const graph = buildGraph(SMALL_GRAPH);
  const registry = VASPS.map((v) => ({ fiuSource: null, fiuStatusDate: null, ...v, addresses: v.addresses.map((a) => ({ chain: a.chain, addr: a.addr, source: a.source, confidence: a.confidence })) })) as RegistryVasp[];

  it('joins on chain + address only, never on the name', () => {
    const named = [{ ...registry[1], name: 'TVASP', addresses: [{ chain: 'ETH', addr: 'TVASP', source: 's', confidence: '0.5' }] }];
    expect(destinations(graph, named, { chain: 'TRON', addr: 'TSEED' })).toEqual([]);
    expect(destinations(graph, registry, { chain: 'TRON', addr: 'TSEED' }).map((d) => d.vasp.name)).toEqual(['Demo Exchange']);
  });

  it('has no path (and invents none) when the seed is not connected to the deposit', () => {
    expect(destinations(graph, registry, { chain: 'TRON', addr: 'TSIDE' })[0].deposits[0].path).toBeNull();
    expect(pathBetween(graph, 'TRON:TSEED', 'TRON:NOPE')).toBeNull();
  });
});
