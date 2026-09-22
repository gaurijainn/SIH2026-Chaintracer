import { describe, expect, it } from 'vitest';
import { noisyOr } from './confidence';

describe('noisyOr', () => {
  it('returns 0 for no evidence', () => {
    expect(noisyOr([])).toBe(0);
  });
  it('returns the single confidence when only one heuristic fired', () => {
    expect(noisyOr([0.6])).toBe(0.6);
  });
  it('combines independent confidences to something higher than any single one', () => {
    const combined = noisyOr([0.6, 0.5]);
    expect(combined).toBeCloseTo(1 - 0.4 * 0.5, 3); // 0.8
    expect(combined).toBeGreaterThan(0.6);
  });
  it('never exceeds 1 even with many strong heuristics', () => {
    expect(noisyOr([0.9, 0.9, 0.9, 0.9])).toBeLessThanOrEqual(1);
  });
  it('clamps out-of-range confidences instead of producing a nonsense result', () => {
    expect(noisyOr([1.5])).toBe(1);
    expect(noisyOr([-0.5])).toBe(0);
  });
});
