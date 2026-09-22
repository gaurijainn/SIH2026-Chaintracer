import { describe, expect, it } from 'vitest';
import { allocateTaint } from './taint';

describe('allocateTaint: HAIRCUT (proportional, default)', () => {
  it('gives every outflow its own full value when the parent is fully tainted (Infinity, the seed case)', () => {
    const shares = allocateTaint('HAIRCUT', Infinity, [{ usd: 40 }, { usd: 60 }]);
    expect(shares).toEqual([40, 60]);
  });

  it('splits the tainted balance proportionally to each outflow\'s share of the total outflow value', () => {
    // parent taint 80 of a node whose total outflow is 130 -> 61.54% of every outflow is tainted
    const shares = allocateTaint('HAIRCUT', 80, [{ usd: 80 }, { usd: 50 }]);
    expect(shares[0]).toBeCloseTo(49.23, 1);
    expect(shares[1]).toBeCloseTo(30.77, 1);
    expect(shares[0] + shares[1]).toBeCloseTo(80, 6);
  });

  it('never allocates more than the outflow itself, even if parent taint exceeds total outflow', () => {
    const shares = allocateTaint('HAIRCUT', 1000, [{ usd: 10 }, { usd: 10 }]);
    expect(shares).toEqual([10, 10]); // proportion capped at 1
  });

  it('gives zero to an outflow with no known USD value', () => {
    expect(allocateTaint('HAIRCUT', 100, [{ usd: 50 }, { usd: null }])).toEqual([50, 0]);
  });

  it('returns all zeros when every outflow is worthless', () => {
    expect(allocateTaint('HAIRCUT', 100, [{ usd: 0 }, { usd: 0 }])).toEqual([0, 0]);
  });
});

describe('allocateTaint: FIFO', () => {
  it('consumes the tainted balance oldest-edge-first, in the order given', () => {
    // parent taint 80: edge A (80) exhausts it entirely, edge B (50) gets nothing
    expect(allocateTaint('FIFO', 80, [{ usd: 80 }, { usd: 50 }])).toEqual([80, 0]);
  });

  it('splits across edges when the balance runs out partway through one of them', () => {
    // parent taint 100: edge A (80) takes 80, leaving 20 for edge B (50) -> 20
    expect(allocateTaint('FIFO', 100, [{ usd: 80 }, { usd: 50 }])).toEqual([80, 20]);
  });

  it('gives every edge its own full value when the parent is fully tainted (Infinity)', () => {
    expect(allocateTaint('FIFO', Infinity, [{ usd: 10 }, { usd: 20 }, { usd: 30 }])).toEqual([10, 20, 30]);
  });

  it('gives zero to an outflow with no known USD value without disturbing the remaining balance', () => {
    expect(allocateTaint('FIFO', 100, [{ usd: null }, { usd: 40 }])).toEqual([0, 40]);
  });
});
