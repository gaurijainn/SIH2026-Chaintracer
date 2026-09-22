import { address as btcAddress } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { loadEnv, USDT_TRC20, type TraceEventEnvelope } from '@ps26183/shared';
import { createChainLayer } from '../adapters/index';
import { fakeTransport, hexAddr, tronAddr, type Route } from '../adapters/testing';
import { runTrace, type BridgeResolver, type HopCreateInput, type TraceJobRow, type TracePrisma } from './engine';
import type { GraphHop } from './graphWrite';
import { DEX_ROUTERS, BRIDGE_CONTRACTS } from './serviceContracts';

const NOW = Date.UTC(2026, 8, 20);
const T = NOW + 1000; // just inside the incident window

// ---- fixture routes -------------------------------------------------------------------------

interface RawTrc20 {
  from: string;
  to: string;
  usdt: number; // whole USDT units
  ts: number;
  tx: string;
}
function trc20Route(items: RawTrc20[]): Route {
  return [
    /api\.trongrid\.io\/v1\/accounts\/([^/?]+)\/transactions\/trc20\?/,
    (req, m) => {
      const url = new URL(req.url);
      const addr = decodeURIComponent(m[1]);
      const outgoing = url.searchParams.get('only_from') === 'true';
      const min = Number(url.searchParams.get('min_timestamp') ?? 0);
      const rows = items.filter((it) => (outgoing ? it.from === addr : it.to === addr) && it.ts >= min);
      return {
        data: rows.map((it) => ({
          transaction_id: it.tx,
          token_info: { address: USDT_TRC20, decimals: 6 },
          block_timestamp: it.ts,
          from: it.from,
          to: it.to,
          type: 'Transfer',
          value: String(it.usdt * 1_000_000),
        })),
        success: true,
        meta: {},
      };
    },
  ];
}

interface RawTrx {
  fromHex: string;
  toHex: string;
  trx: number; // whole TRX units
  ts: number;
  tx: string;
}
function trxRoute(items: RawTrx[]): Route {
  return [
    /api\.trongrid\.io\/v1\/accounts\/([^/?]+)\/transactions\?/,
    (req, m) => {
      const url = new URL(req.url);
      const addr = decodeURIComponent(m[1]);
      const outgoing = url.searchParams.get('only_from') === 'true';
      const min = Number(url.searchParams.get('min_timestamp') ?? 0);
      const rows = items.filter((it) => {
        const from = btcAddress.toBase58Check(Buffer.from(it.fromHex.slice(2), 'hex'), 0x41);
        const to = btcAddress.toBase58Check(Buffer.from(it.toHex.slice(2), 'hex'), 0x41);
        return (outgoing ? from === addr : to === addr) && it.ts >= min;
      });
      return {
        data: rows.map((it) => ({
          txID: it.tx,
          blockNumber: 1,
          block_timestamp: it.ts,
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: it.fromHex, to_address: it.toHex, amount: it.trx * 1_000_000 } } }] },
        })),
        success: true,
        meta: {},
      };
    },
  ];
}

const emptyTrxRoute: Route = [/api\.trongrid\.io\/v1\/accounts\/[^/?]+\/transactions\?/, () => ({ data: [], success: true, meta: {} })];
const cgRoute: Route = [/api\.coingecko\.com\/api\/v3\/coins\/[a-z-]+\/history/, () => ({ market_data: { current_price: { usd: 1, inr: 88 } } })];

function layer(t: ReturnType<typeof fakeTransport>) {
  const env = { ...loadEnv({ DATA_MODE: 'live', TRONGRID_KEY: 'k' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: t, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 }, now: () => NOW });
}

/** trc20-stage "out" call order across nodes == the order the tracer expanded them in. */
function outCallOrder(t: ReturnType<typeof fakeTransport>): string[] {
  return t.calls.filter((c) => c.url.includes('/trc20?') && c.url.includes('only_from=true')).map((c) => decodeURIComponent(new URL(c.url).pathname.split('/')[3]));
}

// ---- fake persistence / event capture --------------------------------------------------------

interface LabelRow {
  chain: string;
  addr: string;
  category: string;
  name: string;
}

interface FakePrisma extends TracePrisma {
  hops: HopCreateInput[];
  state: TraceJobRow;
}
function fakePrisma(job: TraceJobRow, labels: LabelRow[] = []): FakePrisma {
  const self = {
    hops: [] as HopCreateInput[],
    state: { ...job },
  } as FakePrisma;
  self.traceJob = {
    findUniqueOrThrow: async () => self.state,
    update: async ({ data }) => {
      self.state = { ...self.state, ...(data as Partial<TraceJobRow>) };
    },
  };
  self.hop = {
    createMany: async ({ data }) => {
      self.hops.push(...data);
    },
    count: async () => self.hops.length,
  };
  self.label = {
    findFirst: async ({ where }) => labels.find((l) => l.chain === where.chain && l.addr === where.addr && where.category.in.includes(l.category)) ?? null,
  };
  return self;
}

function fakeGraphWriter() {
  const calls: GraphHop[][] = [];
  const fn = async (hops: GraphHop[]) => {
    calls.push(hops);
  };
  return Object.assign(fn, { calls });
}

function fakePublish() {
  const events: TraceEventEnvelope[] = [];
  const fn = async (e: TraceEventEnvelope) => {
    events.push(e);
  };
  return Object.assign(fn, { events });
}

function job(over: Partial<TraceJobRow> = {}): TraceJobRow {
  return {
    id: 'trace1',
    caseId: 'case1',
    seedChain: 'TRON',
    seedAddr: 'SEED',
    status: 'QUEUED',
    taintModel: 'HAIRCUT',
    maxHops: 6,
    minValueUsd: 10,
    windowDays: 30,
    reportedAmount: null,
    createdAt: new Date(NOW),
    ...over,
  };
}

// ---- tests ------------------------------------------------------------------------------------

describe('runTrace: priority ordering and HAIRCUT taint propagation', () => {
  it('expands the higher-tainted frontier node before the lower one, not breadth-first', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 80, ts: T, tx: 'tx1' },
        { from: 'SEED', to: 'B', usdt: 20, ts: T, tx: 'tx2' },
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const chainLayer = layer(t);
    const prisma = fakePrisma(job({ maxHops: 2 }));
    const writeGraphHops = fakeGraphWriter();
    const publish = fakePublish();

    const result = await runTrace('trace1', { prisma, chainLayer, writeGraphHops, publish });

    expect(outCallOrder(t)).toEqual(['SEED', 'A', 'B']); // A (taint 80) before B (taint 20)
    expect(prisma.hops).toHaveLength(2);
    const byTo = Object.fromEntries(prisma.hops.map((h) => [h.toAddr, h]));
    expect(byTo['A']).toMatchObject({ fromAddr: 'SEED', amount: '80', usd: '80', chain: 'TRON', txHash: 'tx1' });
    expect(byTo['B']).toMatchObject({ fromAddr: 'SEED', amount: '20', usd: '20', chain: 'TRON', txHash: 'tx2' });
    expect(result.terminals).toEqual([]); // A and B were expanded (hop 1 < maxHops 2) but had no further outflows
  });
});

describe('runTrace: stop conditions', () => {
  it('stops at a labeled exchange and does not expand its outflows', async () => {
    const t = fakeTransport([trc20Route([{ from: 'SEED', to: 'EXC', usdt: 50, ts: T, tx: 'tx1' }]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job(), [{ chain: 'TRON', addr: 'EXC', category: 'exchange', name: 'Binance' }]);
    const writeGraphHops = fakeGraphWriter();
    const publish = fakePublish();

    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops, publish });

    expect(result.terminals).toEqual([{ chain: 'TRON', addr: 'EXC', reason: 'exchange', label: 'Binance' }]);
    expect(outCallOrder(t)).toEqual(['SEED']); // EXC's own outflows were never fetched
  });

  it('stops at a labeled mixer and marks it a terminal', async () => {
    const t = fakeTransport([trc20Route([{ from: 'SEED', to: 'MIX', usdt: 50, ts: T, tx: 'tx1' }]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job(), [{ chain: 'TRON', addr: 'MIX', category: 'mixer', name: 'Tornado-like' }]);
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(result.terminals).toEqual([{ chain: 'TRON', addr: 'MIX', reason: 'mixer', label: 'Tornado-like' }]);
    expect(outCallOrder(t)).toEqual(['SEED']);
  });

  it('stops expanding once a node reaches maxHops', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 50, ts: T, tx: 'tx1' },
        { from: 'A', to: 'B', usdt: 40, ts: T + 1000, tx: 'tx2' },
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 2 }));
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(outCallOrder(t)).toEqual(['SEED', 'A']); // B (hop 2) is beyond maxHops=2, never fetched
    expect(result.terminals).toEqual([{ chain: 'TRON', addr: 'B', reason: 'max_hops' }]);
  });

  it('excludes an outflow below the minimum value threshold', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 20, ts: T, tx: 'tx1' }, // above 10
        { from: 'SEED', to: 'B', usdt: 5, ts: T, tx: 'tx2' }, // below 10
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1, minValueUsd: 10 }));
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(prisma.hops.map((h) => h.toAddr)).toEqual(['A']);
  });

  it('excludes an outflow that falls outside the incident window', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 20, ts: T, tx: 'tx1' }, // inside the window
        { from: 'SEED', to: 'B', usdt: 20, ts: NOW + 31 * 86_400_000, tx: 'tx2' }, // 31 days later
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1, windowDays: 30 }));
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(prisma.hops.map((h) => h.toAddr)).toEqual(['A']);
  });

  it('caps fan-out at the top-10 outflows by value', async () => {
    const items: RawTrc20[] = Array.from({ length: 12 }, (_, i) => ({ from: 'SEED', to: `N${i}`, usdt: 100 - i, ts: T, tx: `tx${i}` }));
    const t = fakeTransport([trc20Route(items), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1 }));
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(prisma.hops).toHaveLength(10);
    expect(prisma.hops.map((h) => h.toAddr).sort()).toEqual(['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'].sort());
  });

  it('treats a node with more counterparties than the cutoff as an unlabeled service and stops there', async () => {
    const items: RawTrc20[] = Array.from({ length: 6 }, (_, i) => ({ from: 'SEED', to: `N${i}`, usdt: 20, ts: T, tx: `tx${i}` }));
    const t = fakeTransport([trc20Route(items), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 6 }));
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish(), highDegreeCutoff: 5 });

    expect(result.terminals).toEqual([{ chain: 'TRON', addr: 'SEED', reason: 'high_degree_service' }]);
    expect(outCallOrder(t)).toEqual(['SEED']); // none of the 6 recipients were expanded further
  });
});

describe('runTrace: taint model', () => {
  it('HAIRCUT spreads the tainted balance across both outflows, so both get expanded', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 80, ts: T, tx: 'tx1' },
        { from: 'SEED', to: 'B', usdt: 50, ts: T, tx: 'tx2' },
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 3, reportedAmount: 80 })); // parent taint 80, total outflow 130
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(outCallOrder(t)).toEqual(['SEED', 'A', 'B']); // both children got a nonzero share and were expanded
  });

  it('FIFO exhausts the tainted balance on the first outflow, leaving the second unexpanded', async () => {
    const t = fakeTransport([
      trc20Route([
        { from: 'SEED', to: 'A', usdt: 80, ts: T, tx: 'tx1' },
        { from: 'SEED', to: 'B', usdt: 50, ts: T + 1000, tx: 'tx2' },
      ]),
      emptyTrxRoute,
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 3, taintModel: 'FIFO', reportedAmount: 80 })); // exactly exhausted by A
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(outCallOrder(t)).toEqual(['SEED', 'A']); // B got a zero share under FIFO and was never expanded
  });
});

describe('runTrace: idempotency and re-run caching', () => {
  it('does not touch the providers again for an already-COMPLETED trace, and reports its stored hop count', async () => {
    const t = fakeTransport([trc20Route([]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ status: 'COMPLETED' }));
    prisma.hops.push({ traceId: 'trace1', hopNo: 1, chain: 'TRON', txHash: 'x', idx: 1, fromAddr: 'SEED', toAddr: 'A', token: USDT_TRC20, amount: '10', usd: '10', ts: new Date(T) });
    const publish = fakePublish();

    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish });

    expect(t.calls).toHaveLength(0);
    expect(result.hopsWritten).toBe(1);
    expect(publish.events).toEqual([{ event: 'trace.completed', payload: { traceId: 'trace1', caseId: 'case1', terminals: [], durationMs: 0 } }]);
  });
});

describe('runTrace: persistence', () => {
  it('batches writes to both Postgres (skipDuplicates) and Neo4j with matching hop data', async () => {
    const t = fakeTransport([trc20Route([{ from: 'SEED', to: 'A', usdt: 30, ts: T, tx: 'tx1' }]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1 }));
    const writeGraphHops = fakeGraphWriter();
    await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops, publish: fakePublish() });

    expect(prisma.hops).toEqual([{ traceId: 'trace1', hopNo: 1, chain: 'TRON', txHash: 'tx1', idx: expect.any(Number), fromAddr: 'SEED', toAddr: 'A', token: USDT_TRC20, amount: '30', usd: '30', ts: new Date(T) }]);
    expect(writeGraphHops.calls).toEqual([[{ chain: 'TRON', from: 'SEED', to: 'A', tx: 'tx1', idx: expect.any(Number), token: USDT_TRC20, amount: '30', usd: '30', ts: new Date(T).toISOString() }]]);
    expect(prisma.state.status).toBe('COMPLETED');
  });
});

describe('runTrace: DEX swap pairing', () => {
  it('excludes the router leg and continues tracing with the swapped-out native asset', async () => {
    const seed = tronAddr('dexSeed');
    const seedHex = hexAddr('dexSeed');
    const router = DEX_ROUTERS.TRON![0];
    const routerHex = '41' + btcAddress.fromBase58Check(router).hash.toString('hex');
    const c = tronAddr('dexOut');

    const t = fakeTransport([
      trc20Route([{ from: seed, to: router, usdt: 100, ts: T, tx: 'swaptx' }]),
      trxRoute([
        { fromHex: routerHex, toHex: seedHex, trx: 5, ts: T, tx: 'swaptx' }, // paired output leg (different token, same tx)
        { fromHex: seedHex, toHex: '41' + btcAddress.fromBase58Check(c).hash.toString('hex'), trx: 15, ts: T + 1000, tx: 'onward' }, // the genuine continuation
      ]),
      cgRoute,
    ]);
    const l = layer(t);
    const prisma = fakePrisma(job({ seedAddr: seed, maxHops: 1 }));
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() });

    expect(prisma.hops.map((h) => h.toAddr)).toEqual([c]); // the router leg was never persisted as an edge
    expect(result.terminals).toEqual([{ chain: 'TRON', addr: c, reason: 'max_hops' }]);
  });
});

describe('runTrace: bridge crossings', () => {
  it('creates a cross-chain frontier node when the bridge resolver finds the destination', async () => {
    const bridge = BRIDGE_CONTRACTS.TRON![0];
    const t = fakeTransport([trc20Route([{ from: 'SEED', to: bridge, usdt: 40, ts: T, tx: 'bridgetx' }]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1 }));
    const resolver: BridgeResolver = { resolve: async () => ({ chain: 'ETH', addr: '0xdest', txHash: 'desttx' }) };
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish(), bridgeResolver: resolver });

    expect(prisma.hops.map((h) => h.toAddr)).toEqual([bridge]); // the deposit leg is recorded
    expect(result.terminals).toEqual([{ chain: 'ETH', addr: '0xdest', reason: 'max_hops' }]); // continued on the destination chain
  });

  it('marks the bridge deposit as an unresolved terminal when no destination can be found', async () => {
    const bridge = BRIDGE_CONTRACTS.TRON![0];
    const t = fakeTransport([trc20Route([{ from: 'SEED', to: bridge, usdt: 40, ts: T, tx: 'bridgetx' }]), emptyTrxRoute, cgRoute]);
    const l = layer(t);
    const prisma = fakePrisma(job({ maxHops: 1 }));
    const result = await runTrace('trace1', { prisma, chainLayer: l, writeGraphHops: fakeGraphWriter(), publish: fakePublish() }); // no resolver

    expect(prisma.hops.map((h) => h.toAddr)).toEqual([bridge]);
    expect(result.terminals).toEqual([{ chain: 'TRON', addr: bridge, reason: 'bridge_unresolved' }]);
  });
});
