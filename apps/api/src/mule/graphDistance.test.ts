import { describe, expect, it } from 'vitest';
import { bfsDepths, hopsToNearest } from './graphDistance';

const edges = [
  { fromAddr: 'victim', toAddr: 'mule1' },
  { fromAddr: 'mule1', toAddr: 'mule2' },
  { fromAddr: 'mule2', toAddr: 'deposit' },
];

describe('bfsDepths', () => {
  it('computes hop distance from the source along directed edges', () => {
    const depths = bfsDepths(edges, 'victim');
    expect(Object.fromEntries(depths)).toEqual({ victim: 0, mule1: 1, mule2: 2, deposit: 3 });
  });

  it('does not reach a node with no directed path from the source', () => {
    const depths = bfsDepths(edges, 'deposit');
    expect(depths.has('victim')).toBe(false);
  });
});

describe('hopsToNearest', () => {
  it('finds the fewest hops from an address to any target', () => {
    expect(hopsToNearest(edges, 'mule1', new Set(['deposit']))).toBe(2);
  });

  it('is 0 when the address is itself a target', () => {
    expect(hopsToNearest(edges, 'deposit', new Set(['deposit']))).toBe(0);
  });

  it('is null when no target is reachable', () => {
    expect(hopsToNearest(edges, 'deposit', new Set(['victim']))).toBeNull();
  });
});
