import { describe, expect, it } from 'vitest';
import { sourcePriorityResolver } from './conflict';
import type { BootstrapLabelRow } from './types';

const entry = (over: Partial<BootstrapLabelRow>): BootstrapLabelRow => ({
  address: 'A',
  chain: 'TRON',
  label: 'high_risk',
  source: 'ofac',
  fetchedAt: '2026-09-01T00:00:00.000Z',
  confidence: 0.9,
  ...over,
});

describe('sourcePriorityResolver', () => {
  it('resolves to the highest-priority source when sources disagree', () => {
    const resolver = sourcePriorityResolver(['ofac', 'manual_negative']);
    const winner = resolver([entry({ source: 'ofac', label: 'high_risk' }), entry({ source: 'manual_negative', label: 'licit' })]);
    expect(winner?.source).toBe('ofac');
  });

  it('refuses when a conflicting source is not in the priority list', () => {
    const resolver = sourcePriorityResolver(['ofac']);
    const winner = resolver([entry({ source: 'ofac', label: 'high_risk' }), entry({ source: 'chainabuse', label: 'licit' })]);
    expect(winner).toBeNull();
  });

  it('refuses when two sources tie for the best rank and still disagree', () => {
    const resolver = sourcePriorityResolver(['ofac', 'usdt_blacklist']); // not present -> both absent from priority anyway
    const winner = resolver([entry({ source: 'chainabuse', label: 'high_risk' }), entry({ source: 'manual_negative', label: 'licit' })]);
    expect(winner).toBeNull();
  });

  it('an empty priority list refuses every conflict', () => {
    const resolver = sourcePriorityResolver([]);
    expect(resolver([entry({ source: 'ofac' }), entry({ source: 'manual_negative', label: 'licit' })])).toBeNull();
  });
});
