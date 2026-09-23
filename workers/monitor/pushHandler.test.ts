import { describe, expect, it, vi } from 'vitest';
import type { AlertEventEnvelope, MonitorEvent } from '@ps26183/shared';
import type { CreatedAlert } from './alerts';
import { handlePushMonitorEvent, type PushHandlerDeps, type PushHandlerPrisma } from './pushHandler';
import type { RuleContext, StateRuleContext } from './rules';

const baseEvent: MonitorEvent = {
  chain: 'ETH',
  addr: '0xwatched000000000000000000000000000001',
  direction: 'out',
  counterparty: '0xcounterparty00000000000000000000000001',
  txHash: '0xtx1',
  token: '0xusdt',
  amount: '100',
  usd: 100,
  ts: 1_700_000_000_000,
};

function noopRuleCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return { findVasp: vi.fn().mockResolvedValue(null), findObfuscation: vi.fn().mockResolvedValue(null), ...overrides };
}
function noopStateCtx(overrides: Partial<StateRuleContext> = {}): StateRuleContext {
  return {
    getSharedMule: vi.fn().mockResolvedValue(null),
    getBlacklistState: vi.fn().mockResolvedValue(null),
    a5AlreadyFired: vi.fn().mockResolvedValue(false),
    a4AlreadyFired: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function fakeSystem(watchers: { caseId: string; chain: string; addr: string }[]) {
  const alerts: (CreatedAlert & { metadata?: unknown })[] = [];
  let idSeq = 0;
  const prisma: PushHandlerPrisma = {
    watchlistItem: {
      findMany: async ({ where }) => watchers.filter((w) => w.chain === where.chain && w.addr === where.addr).map((w) => ({ caseId: w.caseId })),
    },
    alert: {
      create: async ({ data }) => {
        const created = { id: `alert${++idSeq}`, caseId: data.caseId as string, rule: data.rule as never, severity: data.severity as never, chain: data.chain as string, address: data.address as string, amount: (data.amount as string) ?? null, metadata: data.metadata } as CreatedAlert & { metadata?: unknown };
        alerts.push(created);
        return created;
      },
    },
  };
  const published: AlertEventEnvelope[] = [];
  const publish = vi.fn(async (e: AlertEventEnvelope) => {
    published.push(e);
  });
  return { prisma, alerts, published, publish };
}

/** In-memory stand-in for the Redis SET-NX idempotency guard used in production (workers/src/index.ts). */
function memoryDedup(): (key: string) => Promise<boolean> {
  const seen = new Set<string>();
  return async (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

describe('handlePushMonitorEvent', () => {
  it('does nothing when no case watches this (chain, addr)', async () => {
    const sys = fakeSystem([]);
    await handlePushMonitorEvent({ prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), isNewEvent: memoryDedup() }, baseEvent);
    expect(sys.alerts).toHaveLength(0);
  });

  it('fires A1 for a watched EVM address and fans out to every case watching it', async () => {
    const sys = fakeSystem([
      { caseId: 'case1', chain: 'ETH', addr: baseEvent.addr },
      { caseId: 'case2', chain: 'ETH', addr: baseEvent.addr },
    ]);
    const result = await handlePushMonitorEvent(
      { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), isNewEvent: memoryDedup() },
      { ...baseEvent, usd: 15000 },
    );
    expect(result).toBeUndefined();
    expect(sys.alerts).toHaveLength(2);
    expect(sys.alerts.map((a) => a.caseId).sort()).toEqual(['case1', 'case2']);
    expect(sys.alerts.every((a) => a.rule === 'A1_MOVEMENT')).toBe(true);
  });

  it('A4/A5 (state rules) are chain-independent: an EVM watched address gets A4 linkage just like TRON does', async () => {
    const sys = fakeSystem([{ caseId: 'case1', chain: 'ETH', addr: baseEvent.addr }]);
    const getSharedMule = vi.fn().mockResolvedValue({ caseCount: 2, caseIds: ['case1', 'case9'] });
    await handlePushMonitorEvent(
      { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx({ getSharedMule }), isNewEvent: memoryDedup() },
      { ...baseEvent, usd: 1 }, // too small to fire A1 -- isolates the A4 assertion
    );
    expect(getSharedMule).toHaveBeenCalledWith('ETH', baseEvent.addr);
    expect(sys.alerts).toHaveLength(1);
    expect(sys.alerts[0].rule).toBe('A4_LINKAGE');
  });

  it('A5 blacklist fires for a watched BTC address and invokes onA5Fired with the correct chain', async () => {
    const btcEvent: MonitorEvent = { ...baseEvent, chain: 'BTC', addr: 'bc1qwatched', usd: 1 };
    const sys = fakeSystem([{ caseId: 'case1', chain: 'BTC', addr: btcEvent.addr }]);
    const getBlacklistState = vi.fn().mockResolvedValue({ sanctioned: true, stablecoinBlacklisted: false });
    const onA5Fired = vi.fn();
    await handlePushMonitorEvent(
      { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx({ getBlacklistState }), onA5Fired, isNewEvent: memoryDedup() },
      btcEvent,
    );
    expect(sys.alerts.map((a) => a.rule)).toEqual(['A5_BLACKLIST']);
    expect(onA5Fired).toHaveBeenCalledWith('BTC', btcEvent.addr);
  });

  it('a5AlreadyFired/a4AlreadyFired dedup still applies across repeated pushes (same mechanism as the TRON poller)', async () => {
    const sys = fakeSystem([{ caseId: 'case1', chain: 'ETH', addr: baseEvent.addr }]);
    const getBlacklistState = vi.fn().mockResolvedValue({ sanctioned: true, stablecoinBlacklisted: false });
    const deps: PushHandlerDeps = { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx({ getBlacklistState, a5AlreadyFired: vi.fn().mockResolvedValue(true) }), isNewEvent: memoryDedup() };
    await handlePushMonitorEvent(deps, { ...baseEvent, usd: 1 });
    expect(sys.alerts).toHaveLength(0);
  });

  it('the same event delivered twice (WS redelivery) is only processed once -- isNewEvent blocks the repeat', async () => {
    const sys = fakeSystem([{ caseId: 'case1', chain: 'ETH', addr: baseEvent.addr }]);
    const dedup = memoryDedup();
    const deps: PushHandlerDeps = { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), isNewEvent: dedup };
    const event = { ...baseEvent, usd: 15000 };

    await handlePushMonitorEvent(deps, event);
    await handlePushMonitorEvent(deps, { ...event }); // identical event object shape, e.g. a reconnect replaying the same log

    expect(sys.alerts).toHaveLength(1);
  });

  it('a genuinely different event (different txHash) for the same address is NOT deduped', async () => {
    const sys = fakeSystem([{ caseId: 'case1', chain: 'ETH', addr: baseEvent.addr }]);
    const dedup = memoryDedup();
    const deps: PushHandlerDeps = { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), isNewEvent: dedup };

    await handlePushMonitorEvent(deps, { ...baseEvent, usd: 15000, txHash: '0xtxA' });
    await handlePushMonitorEvent(deps, { ...baseEvent, usd: 15000, txHash: '0xtxB' });

    expect(sys.alerts).toHaveLength(2);
  });

  it('the exact same transfer arriving on two independent watching cases each still gets its own alert (not deduped against each other)', async () => {
    const sys = fakeSystem([
      { caseId: 'caseA', chain: 'ETH', addr: baseEvent.addr },
      { caseId: 'caseB', chain: 'ETH', addr: baseEvent.addr },
    ]);
    const dedup = memoryDedup();
    const deps: PushHandlerDeps = { prisma: sys.prisma, publish: sys.publish, ruleCtx: noopRuleCtx(), stateCtx: noopStateCtx(), isNewEvent: dedup };

    await handlePushMonitorEvent(deps, { ...baseEvent, usd: 15000 });

    expect(sys.alerts).toHaveLength(2);
    expect(sys.alerts.map((a) => a.caseId).sort()).toEqual(['caseA', 'caseB']);
  });
});
