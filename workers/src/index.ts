import { PrismaClient } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import neo4j from 'neo4j-driver';
import {
  QUEUES,
  TRACE_QUEUE_DEFAULT,
  TRACE_QUEUE_TRON,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
  loadEnv,
} from '@ps26183/shared';
import { RedisCache, createChainLayer } from '../adapters/index';
import { redisEventPublisher } from '../trace/events';
import { runTrace, type TraceJobRow } from '../trace/engine';
import { writeGraphHops } from '../trace/graphWrite';
import { createBtcSubscriptionClient } from '../monitor/btcSubscriber';
import { redisAlertPublisher } from '../monitor/events';
import { createEvmSubscriptionClient } from '../monitor/evmSubscriber';
import { buildRuleContext, buildStateRuleContext } from '../monitor/ruleContextPrisma';
import { TRON_POLL_JOB_INTERVAL_MS } from '../monitor/config';
import type { SubscriptionClient } from '../monitor/subscriptionClient';
import { pollDueTronAddresses } from '../monitor/tronPoller';
import { upsertWatchlistItem } from '../monitor/watchlist';
import { handlePushMonitorEvent } from '../monitor/pushHandler';
import type { Chain, MonitorEvent } from '@ps26183/shared';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// One queue per pipeline stage; processors are attached by the steps that own them (B2-B4, B8, B9).
const queues = QUEUES.map((name) => new Queue(name, { connection }));

// `system` queue: proves BullMQ round-trips end to end (used by the smoke test and health).
const system = new Worker('system', async (job) => ({ pong: job.data?.ts ?? null }), { connection });
system.on('error', (e) => console.error('system worker error', e));

// --- B4: multi-hop tracing engine ---
const prisma = new PrismaClient();
const neo4jDriver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const chainLayer = createChainLayer({ env, cache: new RedisCache(env.REDIS_URL) });
const publish = redisEventPublisher(publisher);

// findUniqueOrThrow narrows Decimal fields to the plain shape TracePrisma expects; the real Prisma
// client already satisfies that interface structurally (see workers/trace/engine.ts).
const tracePrisma = {
  traceJob: {
    findUniqueOrThrow: (args: { where: { id: string } }) => prisma.traceJob.findUniqueOrThrow(args) as unknown as Promise<TraceJobRow>,
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => prisma.traceJob.update(args as never),
  },
  hop: {
    createMany: (args: { data: unknown[]; skipDuplicates: true }) => prisma.hop.createMany(args as never),
    count: (args: { where: { traceId: string } }) => prisma.hop.count(args),
  },
  label: {
    findFirst: (args: { where: { chain: string; addr: string; category: { in: string[] } } }) =>
      prisma.label.findFirst({ where: args.where, select: { category: true, name: true } }),
  },
};

// B8: the real PrismaClient satisfies every loose monitor-module interface structurally; these thin
// wrappers cast at the call boundary the same way `tracePrisma` above does for B4, rather than
// widening the monitor modules' own interfaces to Prisma's much stricter generated input types.
const monitorPrisma = {
  watchlistItem: {
    findMany: (args: { where: Record<string, unknown> }) => prisma.watchlistItem.findMany(args as never) as never,
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
      prisma.watchlistItem.upsert(args as never),
  },
  monitorCheckpoint: {
    findMany: (args: { where: Record<string, unknown> }) => prisma.monitorCheckpoint.findMany(args as never) as never,
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) =>
      prisma.monitorCheckpoint.upsert(args as never),
  },
  alert: {
    create: (args: { data: Record<string, unknown> }) =>
      prisma.alert.create(args as never).then((a: { amount: { toFixed(): string } | null }) => ({ ...a, amount: a.amount ? a.amount.toFixed() : null })) as never,
    findFirst: (args: { where: Record<string, unknown> }) => prisma.alert.findFirst(args as never) as never,
  },
  label: {
    findFirst: (args: { where: Record<string, unknown> }) => prisma.label.findFirst(args as never) as never,
  },
  sharedMuleFlag: {
    findUnique: (args: { where: Record<string, unknown> }) => prisma.sharedMuleFlag.findUnique(args as never) as never,
  },
  addressProfile: {
    findUnique: (args: { where: Record<string, unknown> }) => prisma.addressProfile.findUnique(args as never) as never,
  },
};

// B8: frontier terminals (trace stopped only because it ran out of hops) auto-join the watchlist.
async function onTraceTerminal(terminal: { chain: string; addr: string; reason: string }, caseId: string) {
  if (terminal.reason !== 'max_hops') return;
  await upsertWatchlistItem(monitorPrisma, { caseId, chain: terminal.chain as Chain, addr: terminal.addr, reason: 'frontier' });
}

async function processTraceJob(job: Job) {
  await runTrace(job.data.traceId as string, {
    prisma: tracePrisma,
    chainLayer,
    writeGraphHops: (hops) => writeGraphHops(neo4jDriver, hops),
    publish,
    topK: env.TRACE_TOP_K,
    highDegreeCutoff: env.HIGH_DEGREE_CUTOFF,
    onTerminal: onTraceTerminal,
  }, { attempt: { made: job.attemptsMade, max: job.opts.attempts ?? 1 } });
}

const traceTron = new Worker(TRACE_QUEUE_TRON, processTraceJob, { connection, concurrency: 2 });
const traceOther = new Worker(TRACE_QUEUE_DEFAULT, processTraceJob, { connection, concurrency: 2 });
traceTron.on('error', (e) => console.error('trace-tron worker error', e));
traceOther.on('error', (e) => console.error('trace worker error', e));

// --- B8: real-time monitoring and alerts ---
const alertPublisher = redisAlertPublisher(publisher);
const ruleCtx = buildRuleContext(monitorPrisma);
const stateCtx = buildStateRuleContext(monitorPrisma);

// A5 risk recompute: fire-and-forget HTTP call into the API process's existing B7.6 route, which
// constructs and runs the real RiskService -- reused via its own route, not duplicated in this
// process. Never blocks or fails the A5 alert (already persisted before this runs).
function onA5Fired(chain: Chain, addr: string): void {
  const apiUrl = process.env.API_INTERNAL_URL ?? `http://api:${env.API_PORT}`;
  fetch(`${apiUrl}/api/v1/addresses/${chain}/${addr}/risk`).catch((e) => console.error('A5 risk recompute failed (non-blocking)', e));
}

async function processMonitorJob() {
  const result = await pollDueTronAddresses({
    prisma: monitorPrisma,
    tronAdapter: chainLayer.adapter('TRON'),
    publish: alertPublisher,
    ruleCtx,
    stateCtx,
    onA5Fired,
  });
  return result;
}

const monitor = new Worker('monitor', processMonitorJob, { connection, concurrency: 1 });
monitor.on('error', (e) => console.error('monitor worker error', e));

// Repeatable BullMQ job: the finest tier (HOT=30s) drives the tick; tier due-checks inside
// pollDueTronAddresses decide which addresses actually get polled this tick (see checkpoint.ts).
const monitorQueue = queues.find((q) => q.name === 'monitor')!;
await monitorQueue.add('tron-poll', {}, { repeat: { every: TRON_POLL_JOB_INTERVAL_MS }, removeOnComplete: 50, removeOnFail: 50 });

// EVM/BTC push monitoring: real WS clients only in live mode; fixture-replay otherwise (no network,
// safe in tests and CI). Connected once at worker startup, closed on shutdown.
// USDT contracts per EVM chain (public, not secrets -- same convention as USDT_TRC20). BSC/POLYGON are
// the verified mainnet USDT contracts. ETH's value below is UNVERIFIED -- no authoritative source in
// this repo (not the TRON bootstrap docs, not an .env.example entry, not a source-linked constant)
// confirms it against Etherscan, so live ETH monitoring is explicitly disabled below rather than
// trusted on a placeholder. What must happen before it can be re-enabled: fetch the real USDT (Tether
// USD) contract address directly from etherscan.io (or the Etherscan V2 API) for chainid=1, confirm it
// against a second independent source, then set ETH_USDT_CONTRACT_VERIFIED=true (see the guard below)
// with the confirmed checksum address substituted here. Do not flip that flag on an assumption.
const USDT_EVM: Record<'ETH' | 'BSC' | 'POLYGON', string> = {
  ETH: '0xDac17f958d2EE523a2206206994597c13d831Ecc', // UNVERIFIED -- see comment above; do not trust without manual confirmation
  BSC: '0x55d398326f99059fF775485246999027B3197955',
  POLYGON: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
};
const EVM_LIVE_MONITOR_CHAINS: readonly ('ETH' | 'BSC' | 'POLYGON')[] =
  env.ETH_USDT_CONTRACT_VERIFIED === 'true' ? (['ETH', 'BSC', 'POLYGON'] as const) : (['BSC', 'POLYGON'] as const);
if (env.DATA_MODE === 'live' && env.ETH_USDT_CONTRACT_VERIFIED !== 'true') {
  console.warn('B8: ETH USDT contract address is unverified -- live ETH monitoring is disabled (BSC/POLYGON unaffected). See workers/src/index.ts USDT_EVM comment.');
}
const evmClients: SubscriptionClient[] = EVM_LIVE_MONITOR_CHAINS.map((chain) => createEvmSubscriptionClient(env, chain, USDT_EVM[chain]));
const btcClient = createBtcSubscriptionClient(env);
const subscribers: SubscriptionClient[] = [...evmClients, btcClient];

// EVM/BTC push events: routed through the same testable handler as the mock WS protocol tests (see
// workers/monitor/pushHandler.ts) -- A1-A3 transfer rules AND A4/A5 state rules both run per event
// (A4/A5 are chain-independent per the B8 rule table, not TRON-specific), fanned out to every case
// watching this (chain, addr). isNewEvent is a Redis SET-NX idempotency guard so a redelivered WS
// message (reconnect, provider retransmit) never creates a duplicate Alert for the same transfer.
async function isNewEvent(key: string): Promise<boolean> {
  const res = await connection.set(key, '1', 'EX', 600, 'NX');
  return res === 'OK';
}
async function handleMonitorEvent(event: MonitorEvent) {
  try {
    await handlePushMonitorEvent({ prisma: monitorPrisma, publish: alertPublisher, ruleCtx, stateCtx, onA5Fired, isNewEvent }, event);
  } catch (e) {
    console.error('B8 monitor event handling failed', e);
  }
}
for (const client of subscribers) client.on('transfer', handleMonitorEvent);

try {
  const evmWatched = await prisma.watchlistItem.findMany({ where: { chain: { in: ['ETH', 'BSC', 'POLYGON'] } }, select: { addr: true } });
  const btcWatched = await prisma.watchlistItem.findMany({ where: { chain: 'BTC' }, select: { addr: true } });
  await Promise.all(subscribers.map((c) => c.connect()));
  await Promise.all(evmClients.map((c) => c.subscribe(evmWatched.map((w) => w.addr))));
  await btcClient.subscribe(btcWatched.map((w) => w.addr));
} catch (e) {
  console.error('B8 subscriber startup failed (TRON polling still runs)', e);
}

const beat = () =>
  connection.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: Date.now(), queues: QUEUES }), 'EX', WORKER_HEARTBEAT_TTL_S);
await beat();
const timer = setInterval(() => void beat().catch((e) => console.error('heartbeat failed', e)), 5000);
console.log(`workers up (DATA_MODE=${env.DATA_MODE}) queues: ${QUEUES.join(', ')}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await system.close();
    await traceTron.close();
    await traceOther.close();
    await monitor.close();
    await Promise.all(subscribers.map((c) => c.close().catch(() => {})));
    await Promise.all(queues.map((q) => q.close()));
    await neo4jDriver.close();
    await prisma.$disconnect();
    connection.disconnect();
    publisher.disconnect();
    process.exit(0);
  });
}
