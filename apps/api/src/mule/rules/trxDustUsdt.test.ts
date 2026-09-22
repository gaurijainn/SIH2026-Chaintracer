import { describe, expect, it } from 'vitest';
import { detectTrxDustUsdt } from './trxDustUsdt';

describe('detectTrxDustUsdt', () => {
  it('fires when USDT is held with almost no TRX and energy is confirmed delegated', () => {
    const [m] = detectTrxDustUsdt({ chain: 'TRON', trxBalance: 0.1, usdtBalance: 500, energyDelegated: true });
    expect(m.confidence).toBe(0.85);
    expect(m.evidence).toMatchObject({ trxBalance: 0.1, usdtBalance: 500, energyDelegated: true, limitations: [] });
  });

  it('still fires but at lower confidence and with a recorded limitation when energy-delegation status is unknown', () => {
    const [m] = detectTrxDustUsdt({ chain: 'TRON', trxBalance: 0.1, usdtBalance: 500, energyDelegated: null });
    expect(m.confidence).toBe(0.6);
    expect(m.evidence).toMatchObject({ energyDelegated: null });
    expect((m.evidence as { limitations: string[] }).limitations.length).toBeGreaterThan(0);
  });

  it('does not fire when TRX balance is unknown (no unsupported claims)', () => {
    expect(detectTrxDustUsdt({ chain: 'TRON', trxBalance: null, usdtBalance: 500, energyDelegated: true })).toEqual([]);
  });

  it('does not fire when USDT balance is unknown', () => {
    expect(detectTrxDustUsdt({ chain: 'TRON', trxBalance: 0.1, usdtBalance: null, energyDelegated: true })).toEqual([]);
  });

  it('does not fire when TRX balance is above the dust threshold', () => {
    expect(detectTrxDustUsdt({ chain: 'TRON', trxBalance: 50, usdtBalance: 500, energyDelegated: true })).toEqual([]);
  });

  it('does not fire when there is no USDT balance', () => {
    expect(detectTrxDustUsdt({ chain: 'TRON', trxBalance: 0.1, usdtBalance: 0, energyDelegated: true })).toEqual([]);
  });

  it('never fires on a non-TRON chain', () => {
    expect(detectTrxDustUsdt({ chain: 'ETH', trxBalance: 0, usdtBalance: 500, energyDelegated: true })).toEqual([]);
  });
});
