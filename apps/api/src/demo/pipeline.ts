import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { DEMO_CASE_NOW, DEMO_T0, demoTransfers, loadEnv, type ChainAdapter, type DemoCase, type GetTransfersOpts, type Transfer } from '@ps26183/shared';
import { collectTransfers, createChainLayer, type ChainLayer } from '@ps26183/workers/adapters';
import { runTrace, type TraceJobRow, type TracePrisma } from '@ps26183/workers/trace/engine';
import { writeGraphHops } from '@ps26183/workers/trace/graphWrite';
import { pollDueTronAddresses, type PollResult } from '@ps26183/workers/monitor/tronPoller';
import { buildRuleContext, buildStateRuleContext } from '@ps26183/workers/monitor/ruleContextPrisma';
import type { AlertEventPublisher } from '@ps26183/workers/monitor/events';
import { attributeAddress } from '../attribution/attribute';
import { persistAttribution } from '../attribution/persist';
import type { AttributionCandidate } from '../attribution/types';

/** The repo's fixtures/ directory (from apps/api/src/demo). */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures', import.meta.url));

/**
 * Provider layer in DATA_MODE=replay: every provider call is answered from fixtures/, so nothing here touches the
 * network. The fixed clock matches the one the fixtures were recorded with (scripts/record-demo-fixtures.mts).
 */
export function demoReplayLayer(fixturesDir: string = FIXTURES_DIR): ChainLayer {
  const env = { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: fixturesDir };
  return createChainLayer({ env, now: () => DEMO_CASE_NOW });
}

/** Casts the real PrismaClient to the loose interface the B4 engine declares (same idiom as workers/src/index.ts). */
export function tracePrismaOf(prisma: PrismaClient): TracePrisma {
  return {
    traceJob: {
      findUniqueOrThrow: (args) => prisma.traceJob.findUniqueOrThrow(args) as unknown as Promise<TraceJobRow>,
      update: (args) => prisma.traceJob.update(args as never),
    },
    hop: { createMany: (args) => prisma.hop.createMany(args as never), count: (args) => prisma.hop.count(args) },
    label: { findFirst: (args) => prisma.label.findFirst({ where: args.where, select: { category: true, name: true } }) },
  };
}

/** Same idiom for the B8 monitor modules (see workers/src/index.ts). */
export function monitorPrismaOf(p: PrismaClient) {
  return {
    watchlistItem: { findMany: (args: never) => p.watchlistItem.findMany(args) as never },
    monitorCheckpoint: { findMany: (args: never) => p.monitorCheckpoint.findMany(args) as never, upsert: (args: never) => p.monitorCheckpoint.upsert(args) },
    alert: {
      create: (args: never) => p.alert.create(args).then((a) => ({ ...a, amount: a.amount ? a.amount.toFixed() : null })) as never,
      findFirst: (args: never) => p.alert.findFirst(args) as never,
    },
    label: { findFirst: (args: never) => p.label.findFirst(args) as never },
    sharedMuleFlag: { findUnique: (args: never) => p.sharedMuleFlag.findUnique(args) as never },
    addressProfile: { findUnique: (args: never) => p.addressProfile.findUnique(args) as never },
  };
}

/** In-process stand-in for the live TRON feed the monitor polls: serves the demo case's own transfers. */
export class DemoTronAdapter implements ChainAdapter {
  private readonly all: Transfer[];
  constructor(cases: DemoCase[]) {
    this.all = cases.flatMap(demoTransfers);
  }
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}) {
    return { items: this.all.filter((t) => (dir === 'out' ? t.from === addr : t.to === addr) && t.ts >= (o.since ?? 0)).sort((a, b) => a.ts - b.ts) };
  }
  async getAccountMeta(): Promise<never> {
    throw new Error('not used by the demo pipeline');
  }
}

/** A demo trace is anchored to the incident, not to "now": pins TraceJob.createdAt (the trace window start). */
export async function pinTraceWindow(prisma: PrismaClient, traceId: string): Promise<void> {
  await prisma.traceJob.update({ where: { id: traceId }, data: { createdAt: new Date(DEMO_T0) } });
}

/** B4: the real trace engine over the replay provider layer, writing hops to Postgres and Neo4j. */
export async function runDemoTrace(deps: { prisma: PrismaClient; driver: Driver; layer?: ChainLayer }, traceId: string) {
  await pinTraceWindow(deps.prisma, traceId);
  return runTrace(traceId, {
    prisma: tracePrismaOf(deps.prisma),
    chainLayer: deps.layer ?? demoReplayLayer(),
    writeGraphHops: (hops) => writeGraphHops(deps.driver, hops),
    publish: async () => undefined,
    now: () => DEMO_CASE_NOW,
  });
}

/**
 * B5: H1 deposit-sweep attribution of the case's exchange deposit address, using the deposit's full in/out history read
 * through the replay provider layer and the VASP registry's known hot wallets. Persists to Postgres and Neo4j.
 */
export async function runDemoAttribution(deps: { prisma: PrismaClient; driver: Driver; layer?: ChainLayer }, c: DemoCase): Promise<AttributionCandidate[]> {
  const adapter = (deps.layer ?? demoReplayLayer()).adapter('TRON');
  const inflows = (await collectTransfers(adapter, c.vasp.deposit, 'in')).items;
  const outflows = (await collectTransfers(adapter, c.vasp.deposit, 'out')).items;
  const wallets = await deps.prisma.vaspAddress.findMany({ where: { chain: 'TRON', kind: 'HOT_WALLET' }, include: { vasp: true } });
  const candidates = attributeAddress({
    chain: 'TRON',
    addr: c.vasp.deposit,
    inflows,
    outflows,
    knownHotWallets: wallets.map((w) => ({ addr: w.addr, vaspId: w.vaspId, vaspName: w.vasp.name })),
  });
  for (const cand of candidates) await persistAttribution({ prisma: deps.prisma as never, driver: deps.driver }, cand);
  return candidates;
}

/** B8: one monitor pass over the watchlist against the demo feed; the transfer landing on the exchange raises the alerts. */
export async function runDemoMonitor(deps: { prisma: PrismaClient; publish?: AlertEventPublisher; cases?: DemoCase[] }, cases: DemoCase[]): Promise<PollResult> {
  const mp = monitorPrismaOf(deps.prisma);
  return pollDueTronAddresses({
    prisma: mp,
    tronAdapter: new DemoTronAdapter(cases),
    publish: deps.publish ?? (async () => undefined),
    ruleCtx: buildRuleContext(mp),
    stateCtx: buildStateRuleContext(mp),
    now: () => Date.now(),
  });
}
