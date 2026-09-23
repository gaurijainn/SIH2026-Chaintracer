import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertEventEnvelope, ChainAdapter, GetTransfersOpts, Transfer } from '@ps26183/shared';
import { ALERT_EVENTS_CHANNEL } from '@ps26183/shared';
import { redisAlertPublisher } from '@ps26183/workers/monitor/events';
import { buildRuleContext, buildStateRuleContext } from '@ps26183/workers/monitor/ruleContextPrisma';
import { pollDueTronAddresses } from '@ps26183/workers/monitor/tronPoller';
import { AlertService } from '../alerts/service';
import { createPrisma } from '../db/prisma';
import { WatchlistService } from '../watchlist/service';

/**
 * B8 golden end-to-end replay scenario, against a REAL Postgres (docker compose postgres) and REAL
 * Redis (docker compose redis) -- no external network anywhere (TRON transfers come from a fake
 * ChainAdapter seeded from the B8 fixtures, per the B8 report's documented fixture-format decision).
 * Exercises: watchlist -> simulated transfer -> poller -> rule engine -> Alert row -> alert.new
 * publish -> GET /alerts equivalent (AlertService.list) -> PATCH-equivalent (AlertService.update) ->
 * replaying the same transfer does NOT double-alert. Plus a VASP-landing scenario reaching CRITICAL.
 */

const fixtureDir = fileURLToPath(new URL('../../../../fixtures/monitor', import.meta.url));
const watchedTransferFixture = JSON.parse(readFileSync(`${fixtureDir}/tron-watched-transfer.json`, 'utf8')) as { watchedAddr: string; transfers: Transfer[] };
const vaspLandingFixture = JSON.parse(readFileSync(`${fixtureDir}/tron-vasp-landing.json`, 'utf8')) as { watchedAddr: string; vaspAddr: string; vaspName: string; transfers: Transfer[] };

class FakeTronAdapter implements ChainAdapter {
  constructor(private readonly transfers: Transfer[]) {}
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}) {
    return { items: this.transfers.filter((t) => (dir === 'out' ? t.from === addr : t.to === addr) && t.ts >= (o.since ?? 0)) };
  }
  async getAccountMeta(): Promise<never> {
    throw new Error('not used');
  }
}

const run = `b8${Date.now().toString(36)}`;
let prisma: PrismaClient;
let redisPub: Redis;
let redisSub: Redis;
let watchlistService: WatchlistService;
let alertService: AlertService;
let caseId: string;

// Thin wrapper matching the loose monitor-module prisma interfaces, same idiom as workers/src/index.ts.
function monitorPrismaWrapper(p: PrismaClient) {
  return {
    watchlistItem: { findMany: (args: never) => p.watchlistItem.findMany(args) as never },
    monitorCheckpoint: {
      findMany: (args: never) => p.monitorCheckpoint.findMany(args) as never,
      upsert: (args: never) => p.monitorCheckpoint.upsert(args),
    },
    alert: {
      create: (args: never) => p.alert.create(args).then((a) => ({ ...a, amount: a.amount ? a.amount.toFixed() : null })) as never,
      findFirst: (args: never) => p.alert.findFirst(args) as never,
    },
    label: { findFirst: (args: never) => p.label.findFirst(args) as never },
    sharedMuleFlag: { findUnique: (args: never) => p.sharedMuleFlag.findUnique(args) as never },
    addressProfile: { findUnique: (args: never) => p.addressProfile.findUnique(args) as never },
  };
}

beforeAll(async () => {
  prisma = createPrisma(process.env.DATABASE_URL);
  watchlistService = new WatchlistService({ prisma });
  alertService = new AlertService({ prisma });
  const c = await prisma.case.create({ data: { id: `${run}-case1`, title: 'B8 golden replay test case' } });
  caseId = c.id;
  redisPub = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  redisSub = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  await redisSub.subscribe(ALERT_EVENTS_CHANNEL);
});

afterAll(async () => {
  await prisma.alert.deleteMany({ where: { caseId } });
  await prisma.watchlistItem.deleteMany({ where: { caseId } });
  await prisma.monitorCheckpoint.deleteMany({ where: { addr: { in: [watchedTransferFixture.watchedAddr, vaspLandingFixture.watchedAddr] } } });
  await prisma.label.deleteMany({ where: { addr: vaspLandingFixture.vaspAddr } });
  await prisma.case.delete({ where: { id: caseId } });
  redisPub.disconnect();
  redisSub.disconnect();
  await prisma.$disconnect();
});

describe('B8 golden replay: watched TRON transfer -> alert -> Socket.IO -> GET/PATCH /alerts -> no double-alert', () => {
  it('runs the full pipeline with real measured latencies', async () => {
    // Step 1: watchlist add (via the real WatchlistService, exactly as POST /watchlist would).
    const t0 = Date.now();
    await watchlistService.create({ caseId, chain: 'TRON', addr: watchedTransferFixture.watchedAddr, reason: 'manual', tier: 'HOT' });
    console.log(`B8 golden replay: watchlist add took ${Date.now() - t0}ms`);

    // Step 2/3: simulated transfer (fake adapter over the B8 fixture) -> monitor worker's poller.
    // (redisSub is already subscribed to ALERT_EVENTS_CHANNEL from beforeAll.)
    const socketDelivery: Promise<AlertEventEnvelope> = new Promise((resolve) => {
      redisSub.once('message', (_ch, msg) => resolve(JSON.parse(msg) as AlertEventEnvelope));
    });

    const monitorPrisma = monitorPrismaWrapper(prisma);
    const detectStart = Date.now();
    const result = await pollDueTronAddresses({
      prisma: monitorPrisma,
      tronAdapter: new FakeTronAdapter(watchedTransferFixture.transfers),
      publish: redisAlertPublisher(redisPub),
      ruleCtx: buildRuleContext(monitorPrisma),
      stateCtx: buildStateRuleContext(monitorPrisma),
      now: () => Date.now(),
    });
    console.log(`B8 golden replay: detection (poll -> rule -> persist -> publish) took ${Date.now() - detectStart}ms`);
    expect(result.alertsCreated).toBe(1);

    // Step 4: alert.new arrived over the real Redis channel (the same one apps/api's Socket.IO relay
    // subscribes to -- see realtime/socket.int.test.ts for the full Socket.IO-server delivery test).
    const envelope = await Promise.race([socketDelivery, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('alert.new not published within 5s')), 5000))]);
    expect(envelope.event).toBe('alert.new');
    expect(envelope.payload.caseId).toBe(caseId);
    expect(envelope.payload.rule).toBe('A1_MOVEMENT');
    expect(envelope.payload.severity).toBe('HIGH');

    // Step 5: GET /alerts equivalent.
    const alerts = await alertService.list({ caseId });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('A1_MOVEMENT');
    const alertId = alerts[0].id;

    // Step 6: PATCH /alerts/:id (acknowledge).
    const acked = await alertService.update(alertId, { action: 'acknowledge' });
    expect(acked.status).toBe('ACKNOWLEDGED');

    // Step 7: replaying the SAME transfer (re-poll immediately) does NOT double-alert -- the tier
    // interval hasn't elapsed, so the address isn't even due again.
    const replay = await pollDueTronAddresses({
      prisma: monitorPrisma,
      tronAdapter: new FakeTronAdapter(watchedTransferFixture.transfers),
      publish: redisAlertPublisher(redisPub),
      ruleCtx: buildRuleContext(monitorPrisma),
      stateCtx: buildStateRuleContext(monitorPrisma),
      now: () => Date.now(),
    });
    expect(replay.alertsCreated).toBe(0);
    const alertsAfterReplay = await alertService.list({ caseId });
    expect(alertsAfterReplay).toHaveLength(1); // still just the one
  }, 20_000);
});

describe('B8 VASP-landing scenario reaching CRITICAL', () => {
  it('an outbound transfer landing on an exchange-attributed address fires A2 CRITICAL with freezeWindowOpen metadata', async () => {
    await prisma.label.create({
      data: { chain: 'TRON', addr: vaspLandingFixture.vaspAddr, name: vaspLandingFixture.vaspName, category: 'exchange', source: 'manual', confidence: '0.99' },
    });
    await watchlistService.create({ caseId, chain: 'TRON', addr: vaspLandingFixture.watchedAddr, reason: 'manual', tier: 'HOT' });

    const monitorPrisma = monitorPrismaWrapper(prisma);
    const result = await pollDueTronAddresses({
      prisma: monitorPrisma,
      tronAdapter: new FakeTronAdapter(vaspLandingFixture.transfers),
      publish: redisAlertPublisher(redisPub),
      ruleCtx: buildRuleContext(monitorPrisma),
      stateCtx: buildStateRuleContext(monitorPrisma),
      now: () => Date.now(),
    });
    expect(result.alertsCreated).toBe(2); // A1 (large amount) + A2 (VASP landing)

    const alerts = await alertService.list({ caseId, severity: 'CRITICAL' as never });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].rule).toBe('A2_VASP_LANDING');
    const metadata = alerts[0].metadata as { freezeWindowOpen?: boolean; vaspName?: string } | null;
    expect(metadata?.freezeWindowOpen).toBe(true);
    expect(metadata?.vaspName).toBe(vaspLandingFixture.vaspName);
  }, 20_000);
});
