import { describe, expect, it, vi } from 'vitest';
import type { MonitorEvent } from '@ps26183/shared';
import { evaluateStateRules, evaluateTransferRules, type RuleContext, type StateRuleContext } from './rules';

const baseEvent: MonitorEvent = {
  chain: 'TRON',
  addr: 'TWatched111111111111111111111111',
  direction: 'out',
  counterparty: 'TCounterparty22222222222222222222',
  txHash: 'tx1',
  token: 'USDT',
  amount: '100',
  usd: 100,
  ts: 1_700_000_000_000,
};

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    findVasp: vi.fn().mockResolvedValue(null),
    findObfuscation: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('evaluateTransferRules', () => {
  it('does not fire A1 below the MEDIUM threshold', async () => {
    const findings = await evaluateTransferRules({ ...baseEvent, usd: 999 }, ctx());
    expect(findings.find((f) => f.rule === 'A1_MOVEMENT')).toBeUndefined();
  });

  it('fires A1 MEDIUM between the MEDIUM and HIGH thresholds', async () => {
    const findings = await evaluateTransferRules({ ...baseEvent, usd: 5000 }, ctx());
    const a1 = findings.find((f) => f.rule === 'A1_MOVEMENT');
    expect(a1?.severity).toBe('MEDIUM');
  });

  it('fires A1 HIGH at/above the HIGH threshold', async () => {
    const findings = await evaluateTransferRules({ ...baseEvent, usd: 15000 }, ctx());
    const a1 = findings.find((f) => f.rule === 'A1_MOVEMENT');
    expect(a1?.severity).toBe('HIGH');
  });

  it('does not fire A1 on an inbound transfer (the wallet received, did not send)', async () => {
    const findings = await evaluateTransferRules({ ...baseEvent, direction: 'in', usd: 50000 }, ctx());
    expect(findings.find((f) => f.rule === 'A1_MOVEMENT')).toBeUndefined();
  });

  it('fires A2 CRITICAL with freezeWindowOpen metadata when the destination is VASP-attributed', async () => {
    const findVasp = vi.fn().mockResolvedValue({ name: 'Fixture Exchange Ltd' });
    const findings = await evaluateTransferRules(baseEvent, ctx({ findVasp }));
    const a2 = findings.find((f) => f.rule === 'A2_VASP_LANDING');
    expect(a2?.severity).toBe('CRITICAL');
    expect(a2?.metadata?.freezeWindowOpen).toBe(true);
    expect(a2?.metadata?.vaspName).toBe('Fixture Exchange Ltd');
  });

  it('fires both A1 and A2 on one event that is both large and VASP-bound', async () => {
    const findVasp = vi.fn().mockResolvedValue({ name: 'Fixture Exchange Ltd' });
    const findings = await evaluateTransferRules({ ...baseEvent, usd: 25000 }, ctx({ findVasp }));
    expect(findings.map((f) => f.rule).sort()).toEqual(['A1_MOVEMENT', 'A2_VASP_LANDING']);
  });

  it('fires A3 HIGH with continueTraceRecommended when the destination is a mixer/bridge', async () => {
    const findObfuscation = vi.fn().mockResolvedValue({ category: 'mixer', name: 'Fixture Mixer' });
    const findings = await evaluateTransferRules(baseEvent, ctx({ findObfuscation }));
    const a3 = findings.find((f) => f.rule === 'A3_OBFUSCATION');
    expect(a3?.severity).toBe('HIGH');
    expect(a3?.metadata?.continueTraceRecommended).toBe(true);
  });

  it('fires no rules on a small, unremarkable transfer', async () => {
    const findings = await evaluateTransferRules({ ...baseEvent, usd: 10 }, ctx());
    expect(findings).toEqual([]);
  });
});

function stateCtx(overrides: Partial<StateRuleContext> = {}): StateRuleContext {
  return {
    getSharedMule: vi.fn().mockResolvedValue(null),
    getBlacklistState: vi.fn().mockResolvedValue(null),
    a5AlreadyFired: vi.fn().mockResolvedValue(false),
    a4AlreadyFired: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('evaluateStateRules', () => {
  it('fires A4 HIGH when a shared-mule cluster spans more than one case', async () => {
    const getSharedMule = vi.fn().mockResolvedValue({ caseCount: 2, caseIds: ['case-a', 'case-b'] });
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx({ getSharedMule }));
    const a4 = findings.find((f) => f.rule === 'A4_LINKAGE');
    expect(a4?.severity).toBe('HIGH');
    expect(a4?.metadata?.linkedCaseIds).toEqual(['case-a', 'case-b']);
  });

  it('does not refire A4 when a4AlreadyFired is true (coarse dedup)', async () => {
    const getSharedMule = vi.fn().mockResolvedValue({ caseCount: 3, caseIds: ['a', 'b', 'c'] });
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx({ getSharedMule, a4AlreadyFired: vi.fn().mockResolvedValue(true) }));
    expect(findings.find((f) => f.rule === 'A4_LINKAGE')).toBeUndefined();
  });

  it('fires A5 HIGH for a sanctioned (OFAC) address', async () => {
    const getBlacklistState = vi.fn().mockResolvedValue({ sanctioned: true, stablecoinBlacklisted: false });
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx({ getBlacklistState }));
    const a5 = findings.find((f) => f.rule === 'A5_BLACKLIST');
    expect(a5?.severity).toBe('HIGH');
  });

  it('fires A5 INFO for a stablecoin-blacklisted (non-sanctioned) address', async () => {
    const getBlacklistState = vi.fn().mockResolvedValue({ sanctioned: false, stablecoinBlacklisted: true });
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx({ getBlacklistState }));
    const a5 = findings.find((f) => f.rule === 'A5_BLACKLIST');
    expect(a5?.severity).toBe('INFO');
  });

  it('does not refire A5 when a5AlreadyFired is true (coarse "newly observed" dedup)', async () => {
    const getBlacklistState = vi.fn().mockResolvedValue({ sanctioned: true, stablecoinBlacklisted: false });
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx({ getBlacklistState, a5AlreadyFired: vi.fn().mockResolvedValue(true) }));
    expect(findings.find((f) => f.rule === 'A5_BLACKLIST')).toBeUndefined();
  });

  it('fires nothing for a clean address', async () => {
    const findings = await evaluateStateRules('TRON', 'Taddr', stateCtx());
    expect(findings).toEqual([]);
  });
});
