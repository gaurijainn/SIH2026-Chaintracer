import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGraph, type GNode } from '@/features/graph/model';
import { probe } from '@/test/fakeCanvas';
import { sockets } from '@/test/fakeSocket';
import { SMALL_GRAPH, syntheticGraph } from '@/test/graphFixtures';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import type { Role } from '@/stores/auth';
import { riskSchema } from './api';
import { counterparties, dailyActivity, istDay, walletTransfers } from './derive';
import { WalletProfile } from './WalletProfile';

vi.mock('@/lib/realtime', async () => {
  const { createFakeSocket } = await import('@/test/fakeSocket');
  return { createRealtimeSocket: createFakeSocket };
});
vi.mock('@/features/graph/GraphCanvas', async () => {
  const { GraphCanvas } = await import('@/test/fakeCanvas');
  return { GraphCanvas };
});

const CASE = { id: 'case-1', title: 'NCRP ACK-1', status: 'OPEN', traces: [{ id: 't1', status: 'COMPLETED', seedChain: 'TRON', seedAddr: 'TSEED', createdAt: '2026-09-20T07:00:00.000Z', finishedAt: null }] };
const RISK = {
  chain: 'TRON',
  addr: 'TMID',
  score: 72,
  band: 'HIGH',
  factors: [
    { feature: 'dwell_median_min', impact: 0.21, reason: 'Forwards funds a median 4 min after receiving them' },
    { feature: 'fan_out_1h', impact: 0.42, reason: 'Split incoming funds across 7 wallets within an hour' },
  ],
  overrides: [] as string[],
  typology: 'investment_fraud',
  typologyConfidence: 0.83,
  modelVersion: 'tron-xgb-v1',
  traceId: 't1',
  createdAt: '2026-09-25T08:25:51.500Z',
};

const riskCalls = (fm: ReturnType<typeof mountApp>['fetchMock']) => fm.mock.calls.map(([u]) => new URL(String(u), 'http://x')).filter((u) => u.pathname.includes('/risk'));

function open(o: { risk?: unknown; riskResponse?: () => Response | Promise<Response>; graph?: unknown; extra?: FetchHandler } = {}, role: Role = 'INVESTIGATOR') {
  signInAs(role);
  return mountApp('/cases/case-1', (url, init) => {
    const custom = o.extra?.(url, init);
    if (custom) return custom;
    if (url.pathname === '/api/v1/cases/case-1') return json(200, { case: CASE });
    if (url.pathname === '/api/v1/traces/t1/graph') return json(200, o.graph ?? SMALL_GRAPH);
    if (url.pathname === '/api/v1/vasps') return json(200, { vasps: [{ id: 'v1', name: 'Demo Exchange', addresses: [{ chain: 'TRON', addr: 'TVASP' }] }] });
    if (url.pathname === '/api/v1/watchlist') return json(200, { items: [] });
    if (url.pathname.startsWith('/api/v1/addresses/') && url.pathname.endsWith('/risk')) return o.riskResponse ? o.riskResponse() : json(200, o.risk ?? RISK);
    return undefined;
  });
}
const select = async (id: string) => userEvent.click(await screen.findByRole('button', { name: `select ${id}` }, { timeout: 8000 }));
async function openProfile(id = 'TRON:TMID') {
  await select(id);
  await userEvent.click(screen.getByRole('button', { name: 'Wallet profile' }));
  return screen.findByRole('dialog');
}
const withRisk = async (over: Record<string, unknown>, id = 'TRON:TMID') => {
  open({ risk: { ...RISK, ...over } });
  return openProfile(id);
};

beforeEach(() => {
  resetAppState();
  sockets.length = 0;
  probe.reset();
});

describe('risk response validation', () => {
  it('accepts the backend shape', () => {
    expect(riskSchema.safeParse(RISK).success).toBe(true);
    expect(riskSchema.safeParse({ ...RISK, typology: null, typologyConfidence: null, factors: [] }).success).toBe(true);
  });
  it.each([
    ['NaN score', { score: Number.NaN }],
    ['score above 100', { score: 101 }],
    ['fractional score', { score: 50.5 }],
    ['missing score', { score: undefined }],
    ['unknown band', { band: 'SEVERE' }],
    ['confidence above 1', { typologyConfidence: 1.4 }],
    ['non-array factors', { factors: 'many' }],
    ['factor without a reason', { factors: [{ feature: 'x', impact: 1 }] }],
    ['non-finite impact', { factors: [{ feature: 'x', impact: Number.POSITIVE_INFINITY, reason: 'r' }] }],
    ['bad timestamp', { createdAt: 'soon' }],
  ])('rejects %s', (_n, over) => {
    expect(riskSchema.safeParse({ ...RISK, ...over }).success).toBe(false);
  });
});

describe('what is derived from the loaded trace', () => {
  const g = buildGraph(SMALL_GRAPH, new Map([['TRON:TVASP', { name: 'Demo Exchange' }]]));
  const mid = g.nodes.find((n) => n.id === 'TRON:TMID')!;

  it('lists a wallet\'s transfers chronologically with direction and counterparty', () => {
    const t = walletTransfers(g, mid);
    expect(t.map((x) => [x.id, x.direction, x.counterparty])).toEqual([['e1', 'in', 'TSEED'], ['e2', 'out', 'TVASP'], ['e3', 'out', '0xabc0000000000000000000000000000000000001']]);
    expect(t[2].crossChain).toBe(true);
  });

  it('aggregates counterparties with counts, values, latest interaction and registry label', () => {
    const c = counterparties(g, mid);
    expect(c.map((x) => x.address)).toEqual(['TSEED', 'TVASP', '0xabc0000000000000000000000000000000000001']);
    expect(c[0]).toMatchObject({ inCount: 1, outCount: 0, inUsd: 1000, transfers: 1 });
    expect(c[1]).toMatchObject({ label: 'Demo Exchange', outUsd: 900 });
  });

  it('buckets activity by IST day', () => {
    const d = dailyActivity(walletTransfers(g, mid));
    expect(d).toEqual([{ day: istDay(Date.parse('2026-09-20T08:00:00Z')), inUsd: 1000, outUsd: 950, inCount: 1, outCount: 2 }]);
    expect(istDay(Date.parse('2026-09-20T19:00:00Z'))).toBe('2026-09-21'); // 00:30 IST next day
  });
});

describe('opening the wallet profile from the graph (F4 -> F5)', () => {
  it('asks for nothing until a wallet is opened, then requests risk for that wallet only, with the trace as context', async () => {
    const { fetchMock } = open();
    await select('TRON:TMID');
    expect(riskCalls(fetchMock)).toHaveLength(0); // selecting a node does not score it
    await userEvent.click(screen.getByRole('button', { name: 'Wallet profile' }));
    await screen.findByRole('dialog');
    await screen.findByRole('img', { name: /Risk score 72/ });
    const calls = riskCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe('/api/v1/addresses/TRON/TMID/risk');
    expect(calls[0].searchParams.get('traceId')).toBe('t1');
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/risk') && (i as RequestInit).headers && ((i as RequestInit).headers as Record<string, string>).Authorization === 'Bearer access-1')).toBe(true);
  });

  it('makes no risk request for a 1,000-node graph until one wallet is opened', async () => {
    const big = syntheticGraph(1000);
    const { fetchMock } = open({ graph: big });
    await screen.findByTestId('fake-canvas');
    expect(screen.getByTestId('fake-canvas').getAttribute('data-nodes')).toBe('1000');
    expect(riskCalls(fetchMock)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: `select ${big.nodes[1].id}` }));
    expect(riskCalls(fetchMock)).toHaveLength(0);
  }, 40_000);

  it('caches: reopening a wallet does not call the model again, another wallet does', async () => {
    const { fetchMock } = open();
    await openProfile('TRON:TMID');
    await screen.findByRole('img', { name: /Risk score 72/ });
    await userEvent.click(screen.getByRole('button', { name: 'Close wallet profile' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Wallet profile' }));
    await screen.findByRole('img', { name: /Risk score 72/ });
    expect(riskCalls(fetchMock)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close wallet profile' }));
    await select('TRON:TVASP');
    await userEvent.click(screen.getByRole('button', { name: 'Wallet profile' }));
    await waitFor(() => expect(riskCalls(fetchMock)).toHaveLength(2));
  });

  it('leaves the F4 side panel and graph in place behind the sheet', async () => {
    open();
    await openProfile();
    expect(screen.getByTestId('fake-canvas')).toBeInTheDocument();
  });
});

describe('score, band and typology', () => {
  it('shows the score, the band as text, and a labelled gauge', async () => {
    const d = await withRisk({});
    const gauge = await within(d).findByRole('img', { name: 'Risk score 72 out of 100, High band' });
    expect(gauge).toBeInTheDocument();
    expect(within(d).getByText('High')).toBeInTheDocument(); // the badge word, not just a colour
    expect(within(d).getByText('High risk')).toBeInTheDocument(); // screen-reader meaning from RiskBadge
    expect(within(gauge.closest('div')!).getAllByText(/LOW|MED|HIGH|CRIT/).length).toBeGreaterThanOrEqual(4); // scale labelled with band names
  });

  it.each([[10, 'LOW', 'Low'], [45, 'MEDIUM', 'Medium'], [85, 'CRITICAL', 'Critical']])('score %s is drawn as the backend band %s', async (score, band, label) => {
    const d = await withRisk({ score, band });
    expect(await within(d).findByRole('img', { name: `Risk score ${score} out of 100, ${label} band` })).toBeInTheDocument();
  });

  it('shows typology and confidence from the API', async () => {
    const d = await withRisk({});
    expect(await within(d).findByTestId('typology')).toHaveTextContent('investment fraud');
    expect(within(d).getByTestId('typology-confidence')).toHaveTextContent('83%');
    expect(within(d).getByText('tron-xgb-v1')).toBeInTheDocument();
    expect(within(d).getByText('25 Sept 2026, 13:55 IST')).toBeInTheDocument(); // createdAt from the response
    expect(within(d).queryByText('Trace context')).not.toBeInTheDocument();
  });

  it('is honest when typology or confidence is missing', async () => {
    const d = await withRisk({ typology: null, typologyConfidence: null });
    expect(await within(d).findByTestId('typology')).toHaveTextContent('Unavailable');
    expect(within(d).getByTestId('typology-confidence')).toHaveTextContent('Not returned');
  });

  it('shows the API\'s own "Unknown" typology with its 0% confidence rather than hiding it', async () => {
    const d = await withRisk({ typology: 'Unknown', typologyConfidence: 0 });
    expect(await within(d).findByTestId('typology')).toHaveTextContent('Unknown');
    expect(within(d).getByTestId('typology-confidence')).toHaveTextContent('0%');
  });
});

describe('model factors', () => {
  it('lists the returned factors, largest first, each with its reason, bar, impact and feature name', async () => {
    const d = await withRisk({});
    expect(await within(d).findByRole('heading', { level: 4, name: 'Model factors' })).toBeInTheDocument();
    const items = await within(d).findAllByTestId('reason');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Split incoming funds across 7 wallets within an hour');
    expect(items[0]).toHaveTextContent('+0.420');
    expect(items[0]).toHaveTextContent('fan_out_1h');
    expect(items[1]).toHaveTextContent('Forwards funds a median 4 min after receiving them');
    // the bars are proportional to contribution (largest = 100%, the other 50%)
    expect(within(items[0]).getByRole('img', { name: /100 percent of the largest reason/ })).toBeInTheDocument();
    expect(within(items[1]).getByRole('img', { name: /50 percent of the largest reason/ })).toBeInTheDocument();
    const fill = (i: number) => (items[i].querySelector('.bg-primary') as HTMLElement).style.width;
    expect(fill(0)).toBe('100%');
    expect(fill(1)).toBe('50%');
  });

  it('shows the actual number of reasons and never pads to three', async () => {
    const d = await withRisk({ factors: [RISK.factors[1]] });
    expect(await within(d).findAllByTestId('reason')).toHaveLength(1);
    expect(within(d).getByText(/1 factor returned by the risk model/)).toBeInTheDocument();
  });

  it('says so when the model returned no reasons', async () => {
    const d = await withRisk({ factors: [], score: 4, band: 'LOW' });
    expect(await within(d).findByTestId('no-reasons')).toBeInTheDocument();
    expect(within(d).queryAllByTestId('reason')).toHaveLength(0);
  });

  it('does not claim the reasons are verified, and invents no feature values or evidence links', async () => {
    const d = await withRisk({});
    expect(await within(d).findByText(/returns no separate feature values and no evidence links/)).toBeInTheDocument();
    expect(within(d).getByText(/not independently verified here/)).toBeInTheDocument();
    for (const r of within(d).getAllByTestId('reason')) expect(within(r).queryAllByRole('link')).toHaveLength(0);
    expect(within(d).queryByText(/Feature value:|Verified on/i)).not.toBeInTheDocument();
  });
});

describe('overrides (only what the backend returned)', () => {
  it('lists a returned override and nothing else', async () => {
    const d = await withRisk({ score: 95, band: 'CRITICAL', overrides: ['SANCTIONED'] });
    const list = await within(d).findByRole('list', { name: 'Overrides' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Sanctioned');
    expect(items[0]).toHaveTextContent('SANCTIONED');
    expect(within(d).queryByTestId('no-flags')).not.toBeInTheDocument();
  });

  it('lists each returned override, including one the app has no friendly name for', async () => {
    const d = await withRisk({ overrides: ['STABLECOIN_BLACKLIST', 'SOMETHING_NEW'] });
    const items = within(await within(d).findByRole('list', { name: 'Overrides' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Stablecoin blacklistSTABLECOIN_BLACKLIST', 'SOMETHING_NEWSOMETHING_NEW']);
  });

  it('says nothing was returned instead of listing checks that were not reported', async () => {
    const d = await withRisk({});
    expect(await within(d).findByTestId('no-flags')).toHaveTextContent('No overrides returned by the risk model.');
    expect(within(d).queryByRole('list', { name: 'Overrides' })).not.toBeInTheDocument();
  });

  it('never presents unsupported sources, checks or fetch times as data', async () => {
    const d = await withRisk({ overrides: ['SANCTIONED'], factors: [...RISK.factors, { feature: 'external_flags', impact: 0.1, reason: 'Flagged 2 time(s) by third-party sources' }] });
    await within(d).findByRole('list', { name: 'Overrides' });
    const text = d.textContent ?? '';
    for (const banned of [/Chainabuse/i, /Tronscan/i, /Not flagged/i, /Source:/i, /checked \d/i, /lookup/i, /All counterparties/i, /Wallet activity/i]) expect(text).not.toMatch(banned);
    // an external_flags factor is just another model factor: shown as returned, never turned into a flag row
    expect(within(d).getAllByTestId('reason')).toHaveLength(3);
    expect(within(d).getAllByRole('list', { name: 'Overrides' })).toHaveLength(1);
  });

  it('explains that overrides are unavailable while the score is', async () => {
    open({ riskResponse: () => new Promise<Response>(() => undefined) });
    const d = await openProfile();
    expect(await within(d).findByText(/Overrides come from the risk model and are unavailable while the risk score is not loaded/)).toBeInTheDocument();
  });
});

describe('activity and counterparties (derived from the trace)', () => {
  it('shows the wallet\'s transfers with direction, value, time, counterparty and tx', async () => {
    open();
    const d = await openProfile();
    const list = within(d).getByRole('list', { name: 'Transfers' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Inbound');
    expect(rows[0]).toHaveTextContent('$1,000');
    expect(rows[0]).toHaveTextContent('from TSEED');
    expect(rows[0]).toHaveTextContent('20 Sept 2026, 13:30 IST');
    expect(rows[1]).toHaveTextContent('Outbound');
    expect(rows[2]).toHaveTextContent('cross-chain');
    expect(within(d).getByRole('img', { name: /Activity by day \(IST\): 2026-09-20 in 1000 out 950 USD/ })).toBeInTheDocument();
  });

  it('shows counterparties in an accessible table with explorer links per chain', async () => {
    open();
    const d = await openProfile();
    const table = within(d).getByRole('table', { name: 'Counterparties of this wallet in this trace' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Sent to this wallet');
    expect(rows[1]).toHaveTextContent('Demo Exchange');
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', 'https://tronscan.org/#/address/TSEED');
    expect(within(rows[2]).getByRole('link')).toHaveAttribute('href', 'https://etherscan.io/address/0xabc0000000000000000000000000000000000001');
    expect(table.parentElement).toHaveClass('table-scroll');
  });

  it('labels both sections as trace-scoped and disclaims wallet-wide history', async () => {
    open();
    const d = await openProfile();
    expect(within(d).getByRole('heading', { level: 3, name: 'Activity in this trace' })).toBeInTheDocument();
    expect(within(d).getByRole('heading', { level: 3, name: 'Counterparties in this trace' })).toBeInTheDocument();
    expect(within(d).getByText(/in the loaded trace only \(IST\)\. The backend provides no wallet-wide history\./)).toBeInTheDocument();
    expect(within(d).getByText(/transfers in the loaded trace only, not from any wider wallet history/)).toBeInTheDocument();
    expect(within(d).queryByRole('heading', { name: /^(Wallet activity|Activity|Counterparties|Wallet history)$/i })).not.toBeInTheDocument();
  });

  it('says so for a wallet with no transfers or counterparties in the trace', async () => {
    open({ graph: { ...SMALL_GRAPH, nodes: [...SMALL_GRAPH.nodes, { id: 'TRON:TISO', chain: 'TRON', addr: 'TISO', inUsd: 0, outUsd: 0 }] } });
    const d = await openProfile('TRON:TISO');
    expect(within(d).getByText('No transfers for this wallet in the loaded trace.')).toBeInTheDocument();
    expect(within(d).getByText('No counterparties for this wallet in the loaded trace.')).toBeInTheDocument();
  });
});

describe('explorer and unsupported chains', () => {
  it('links the wallet to its own chain\'s explorer, opened safely', async () => {
    open();
    const d = await openProfile('TRON:TMID');
    const link = within(d).getByRole('link', { name: /Open in explorer/ });
    expect(link).toHaveAttribute('href', 'https://tronscan.org/#/address/TMID');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not ask the backend to score a chain the v1 model cannot score, and still offers its explorer', async () => {
    const { fetchMock } = open();
    const d = await openProfile('ETH:0xabc0000000000000000000000000000000000001');
    expect(await within(d).findByText('No risk score for ETH')).toBeInTheDocument();
    expect(riskCalls(fetchMock)).toHaveLength(0);
    expect(within(d).getByRole('link', { name: /Open in explorer/ })).toHaveAttribute('href', expect.stringContaining('etherscan.io'));
    expect(within(d).getByText(/Overrides come from the risk model and are unavailable/)).toBeInTheDocument();
  });

  it('disables the explorer action for a chain with no known explorer', () => {
    signInAs('INVESTIGATOR');
    const g = buildGraph(SMALL_GRAPH);
    const node = { ...g.nodes[0], chain: 'SOLANA' } as unknown as GNode;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WalletProfile node={node} graph={g} traceId="t1" onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'No explorer for SOLANA' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /Open in explorer/ })).not.toBeInTheDocument();
  });
});

describe('loading, error and partial states', () => {
  it('shows a loading state for the risk score while trace-derived sections are already there', async () => {
    open({ riskResponse: () => new Promise<Response>(() => undefined) });
    const d = await openProfile();
    expect(await within(d).findByRole('status', { name: 'Loading risk score' })).toBeInTheDocument();
    expect(within(d).getByRole('list', { name: 'Transfers' })).toBeInTheDocument();
    expect(within(d).getByRole('table')).toBeInTheDocument();
  });

  it('shows a risk error with retry without losing the rest of the profile', async () => {
    let fail = true;
    open({ riskResponse: () => (fail ? json(503, { error: 'ML_UNAVAILABLE', message: 'ML service is unreachable' }) : json(200, RISK)) });
    const d = await openProfile();
    expect(await within(d).findByText('Could not load the risk score', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(within(d).getByRole('list', { name: 'Transfers' })).toBeInTheDocument();
    expect(within(d).getByRole('table')).toBeInTheDocument();
    expect(within(d).getByText(/unavailable while the risk score is unavailable/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(d).getByRole('button', { name: 'Try again' }));
    expect(await within(d).findByRole('img', { name: /Risk score 72/ })).toBeInTheDocument();
  });

  it('turns a malformed risk response into an error state, never a score', async () => {
    const d = await withRisk({ score: 'high', band: 'HIGH' });
    expect(await within(d).findByText(/unexpected risk response/, undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(within(d).queryByRole('img', { name: /Risk score/ })).not.toBeInTheDocument();
    expect(within(d).queryByText('NaN')).not.toBeInTheDocument();
    expect(within(d).getByRole('table')).toBeInTheDocument();
  });

  it('reports an unsupported-chain answer from the backend as an error, not a score', async () => {
    open({ riskResponse: () => json(400, { error: 'UNSUPPORTED_CHAIN', message: 'risk scoring is only available for chain=TRON' }) });
    const d = await openProfile();
    expect(await within(d).findByText('Could not load the risk score')).toBeInTheDocument();
  });
});

describe('label feedback and permissions', () => {
  it('keeps Confirm and Dispute disabled with the reason, and can submit nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { fetchMock } = open();
    const d = await openProfile();
    const confirm = within(d).getByRole('button', { name: 'Confirm label' });
    const dispute = within(d).getByRole('button', { name: 'Dispute label' });
    expect(confirm).toBeDisabled();
    expect(dispute).toBeDisabled();
    expect(within(d).getByTestId('label-review-note')).toHaveTextContent('Feedback action unavailable: backend endpoint not provided.');
    await userEvent.click(confirm);
    await userEvent.click(dispute);
    // no request other than reads, no label write of any kind, and nothing persisted locally
    expect(fetchMock.mock.calls.filter(([, i]) => ['POST', 'PATCH', 'DELETE'].includes(String((i as RequestInit)?.method))).map(([u]) => String(u))).toEqual([]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/labels'))).toBe(false);
    expect(setItem.mock.calls.filter(([k]) => /label|confirm|dispute/i.test(String(k)))).toHaveLength(0);
    expect(within(d).queryByText(/saved|thank/i)).not.toBeInTheDocument();
  });

  it.each(['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as Role[])('%s can open the profile (risk:read is in every role) and the feedback controls are disabled for all', async (role) => {
    open({}, role);
    const d = await openProfile();
    expect(await within(d).findByRole('img', { name: /Risk score 72/ })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Confirm label' })).toBeDisabled();
    expect(within(d).getByRole('button', { name: 'Dispute label' })).toBeDisabled();
  });
});

describe('responsive and accessible structure', () => {
  it('is a full-width sheet on small screens capped at 2xl on large ones, with a labelled dialog and headings', async () => {
    open();
    const d = await openProfile();
    expect(d.className).toMatch(/w-full max-w-2xl/);
    expect(d.className).toMatch(/inset-y-0 right-0/);
    expect(d).toHaveAccessibleName(/Wallet profile/);
    expect(within(d).getByRole('heading', { level: 2, name: 'Wallet profile' })).toBeInTheDocument();
    expect(within(d).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Risk', 'Overrides', 'Activity in this trace', 'Counterparties in this trace', 'Label feedback']);
  });

  it('closes with Escape and returns to the graph', async () => {
    open();
    await openProfile();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('fake-canvas')).toBeInTheDocument();
  });
});
