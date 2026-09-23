import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEventEnvelope, ChainAdapter, GetTransfersOpts, Transfer } from '@ps26183/shared';
import type { AlertPersistPrisma, CreatedAlert } from './alerts';
import type { MonitorPrisma, WatchTier } from './checkpoint';
import type { RuleContext, StateRuleContext } from './rules';
import { pollDueTronAddresses } from './tronPoller';

const fixtureDir = fileURLToPath(new URL('../../fixtures/monitor', import.meta.url));
const watchedTransferFixture = JSON.parse(readFileSync(`${fixtureDir}/tron-watched-transfer.json`, 'utf8')) as { watchedAddr: string; transfers: Transfer[] };
const vaspLandingFixture = JSON.parse(readFileSync(`${fixtureDir}/tron-vasp-landing.json`, 'utf8')) as { watchedAddr: string; vaspAddr: string; vaspName: string; transfers: Transfer[] };

/** A fake ChainAdapter over a fixed transfer list -- conforms to the exact B3 ChainAdapter interface. */
class FakeTronAdapter implements ChainAdapter {
  calls: { addr: string; dir: 'in' | 'out'; since?: number }[] = [];
  constructor(private readonly transfers: Transfer[]) {}
  async getTransfers(addr: string, dir: 'in' | 'out', o: GetTransfersOpts = {}) {
    this.calls.push({ addr, dir, since: o.since });
    const items = this.transfers.filter((t) => (dir === 'out' ? t.from === addr : t.to === addr) && t.ts >= (o.since ?? 0));
    return { items };
  }
  async getAccountMeta() {
    throw new Error('not used by B8 tests');
  }
}

/** In-memory fake of the exact Prisma subset B8's poller/rules/alert-persistence need. */
function fakeSystem(items: { caseId: string; chain: string; addr: string; tier: WatchTier; reason: string }[]) {
  const checkpoints = new Map<string, { chain: string; addr: string; lastCheckedAt: Date; lastCursor: string | null }>();
  const alerts: (CreatedAlert & { metadata?: unknown })[] = [];
  let idSeq = 0;

  const prisma: MonitorPrisma & AlertPersistPrisma = {
    watchlistItem: { findMany: async ({ where }) => items.filter((i) => i.chain === where.chain).map((i) => ({ id: `${i.caseId}-${i.addr}`, ...i })) },
    monitorCheckpoint: {
      findMany: async ({ where }) => where.addr.in.map((a: string) => checkpoints.get(`${where.chain}:${a}`)).filter((c: unknown): c is NonNullable<typeof c> => !!c),
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        checkpoints.set(`${create.chain}:${create.addr}`, { chain: create.chain as string, addr: create.addr as string, lastCheckedAt: create.lastCheckedAt as Date, lastCursor: (create.lastCursor as string) ?? null });
      },
    },
    alert: {
      create: async ({ data }) => {
        const created = { id: `alert${++idSeq}`, caseId: data.caseId, rule: data.rule, severity: data.severity, chain: data.chain, address: data.address, amount: data.amount ?? null, metadata: data.metadata } as CreatedAlert & { metadata?: unknown };
        alerts.push(created);
        return created;
      },
    },
  };

  const published: AlertEventEnvelope[] = [];
  const publish = vi.fn(async (e: AlertEventEnvelope) => {
    published.push(e);
  });

  return { prisma, alerts, published, publish, checkpoints };
}

function noopRuleCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return { findVasp: vi.fn().mockResolvedValue(null), findObfuscation: vi.fn().mockResolvedValue(null), ...overrides };
}
function noopStateCtx(): StateRuleContext {
  return {
    getSharedMule: vi.fn().mockResolvedValue(null),
    getBlacklistState: vi.fn().mockResolvedValue(null),
    a5AlreadyFired: vi.fn().mockResolvedValue(false),
    a4AlreadyFired: vi.fn().mockResolvedValue(false),
  };
}

describe('pollDueTronAddresses', () => {
  let clock = 1_758_600_050_000; // just after the fixture transfer's ts

  beforeEach(() => {
    clock = 1_758_600_050_000;
  });

  it('detects a new transfer from a watched TRON wallet and fires A1 (HIGH, $15,000)', async () => {
    const adapter = new FakeTronAdapter(watchedTransferFixture.transfers);
    const sys = fakeSystem([{ caseId: 'case1', chain: 'TRON', addr: watchedTransferFixture.watchedAddr, tier: 'HOT', reason: 'manual' }]);

    const result = await pollDueTronAddresses({
      prisma: sys.prisma,
      tronAdapter: adapter,
      publish: sys.publish,
      ruleCtx: noopRuleCtx(),
      stateCtx: noopStateCtx(),
      now: () => clock,
    });

    expect(result.transfersSeen).toBe(1);
    expect(result.alertsCreated).toBe(1);
    expect(sys.alerts[0].rule).toBe('A1_MOVEMENT');
    expect(sys.alerts[0].severity).toBe('HIGH');
    expect(sys.alerts[0].caseId).toBe('case1');
    expect(sys.published).toHaveLength(1);
    expect(sys.published[0]).toEqual({ event: 'alert.new', payload: expect.objectContaining({ rule: 'A1_MOVEMENT', severity: 'HIGH', caseId: 'case1' }) });
  });

  it('a VASP-landing transfer fires both A1 and A2 (CRITICAL, freeze-window metadata)', async () => {
    const adapter = new FakeTronAdapter(vaspLandingFixture.transfers);
    const sys = fakeSystem([{ caseId: 'case1', chain: 'TRON', addr: vaspLandingFixture.watchedAddr, tier: 'HOT', reason: 'manual' }]);
    const findVasp = vi.fn(async (_chain: string, addr: string) => (addr === vaspLandingFixture.vaspAddr ? { name: vaspLandingFixture.vaspName } : null));

    const result = await pollDueTronAddresses({
      prisma: sys.prisma,
      tronAdapter: adapter,
      publish: sys.publish,
      ruleCtx: noopRuleCtx({ findVasp }),
      stateCtx: noopStateCtx(),
      now: () => clock,
    });

    expect(result.alertsCreated).toBe(2);
    const rules = sys.alerts.map((a) => a.rule).sort();
    expect(rules).toEqual(['A1_MOVEMENT', 'A2_VASP_LANDING']);
    const a2 = sys.alerts.find((a) => a.rule === 'A2_VASP_LANDING')!;
    expect(a2.severity).toBe('CRITICAL');
    expect((a2 as { metadata?: { freezeWindowOpen?: boolean } }).metadata?.freezeWindowOpen).toBe(true);
  });

  it('does not re-poll (or re-alert) a HOT address before its 30s tier interval elapses', async () => {
    const adapter = new FakeTronAdapter(watchedTransferFixture.transfers);
    const sys = fakeSystem([{ caseId: 'case1', chain: 'TRON', addr: watchedTransferFixture.watchedAddr, tier: 'HOT', reason: 'manual' }]);
    const deps = { prisma: sys.prisma, tronAdapter: adapter, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), now: () => clock };

    const first = await pollDueTronAddresses(deps);
    expect(first.addressesDue).toBe(1);

    clock += 5_000; // well under the 30s HOT interval
    const second = await pollDueTronAddresses(deps);
    expect(second.addressesDue).toBe(0);
    expect(second.alertsCreated).toBe(0);
    expect(sys.alerts).toHaveLength(1); // still just the one alert from the first poll
  });

  it('replaying/re-polling the SAME already-seen transfer does not double-alert once the checkpoint has advanced past it (restart-safe)', async () => {
    const adapter = new FakeTronAdapter(watchedTransferFixture.transfers);
    const sys = fakeSystem([{ caseId: 'case1', chain: 'TRON', addr: watchedTransferFixture.watchedAddr, tier: 'HOT', reason: 'manual' }]);
    const deps = { prisma: sys.prisma, tronAdapter: adapter, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), now: () => clock };

    await pollDueTronAddresses(deps); // first poll: sees + alerts on the transfer, advances checkpoint past its ts
    clock += 31_000; // advance past the next HOT window so the address is due again

    // "Worker restart": a brand-new poller invocation reading the same persisted checkpoint/prisma
    // state (fakeSystem's `checkpoints` map stands in for the Postgres MonitorCheckpoint row that
    // would survive a real process restart) must not re-fetch or re-alert the same transfer.
    const secondResult = await pollDueTronAddresses(deps);
    expect(secondResult.transfersSeen).toBe(0);
    expect(secondResult.alertsCreated).toBe(0);
    expect(sys.alerts).toHaveLength(1);
  });

  it('is due immediately for an address with no prior checkpoint (first poll ever)', async () => {
    const adapter = new FakeTronAdapter([]);
    const sys = fakeSystem([{ caseId: 'case1', chain: 'TRON', addr: 'Tunseen', tier: 'HOT', reason: 'manual' }]);
    const result = await pollDueTronAddresses({ prisma: sys.prisma, tronAdapter: adapter, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), now: () => clock });
    expect(result.addressesDue).toBe(1);
  });
});
