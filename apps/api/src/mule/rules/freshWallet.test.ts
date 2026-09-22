import { describe, expect, it } from 'vitest';
import { detectFreshWallet } from './freshWallet';

const T0 = Date.UTC(2026, 8, 1);
const days = (n: number) => n * 86_400_000;

describe('detectFreshWallet', () => {
  it('fires when the wallet is under 7 days old at first taint', () => {
    const [m] = detectFreshWallet(T0 - days(2), T0);
    expect(m).toMatchObject({ confidence: 0.75 });
    expect(m.evidence).toMatchObject({ ageDays: 2, maxAgeDays: 7 });
  });

  it('does not fire when the wallet is older than 7 days', () => {
    expect(detectFreshWallet(T0 - days(10), T0)).toEqual([]);
  });

  it('does not fire exactly at the boundary plus one day', () => {
    expect(detectFreshWallet(T0 - days(8), T0)).toEqual([]);
  });

  it('fires exactly at the boundary', () => {
    expect(detectFreshWallet(T0 - days(7), T0)).toHaveLength(1);
  });

  it('does not fire without account-creation metadata', () => {
    expect(detectFreshWallet(null, T0)).toEqual([]);
  });

  it('does not fire without a first-taint timestamp', () => {
    expect(detectFreshWallet(T0 - days(1), null)).toEqual([]);
  });

  it('respects a configured maxAgeDays override', () => {
    expect(detectFreshWallet(T0 - days(20), T0, { maxAgeDays: 30 })).toHaveLength(1);
  });
});
