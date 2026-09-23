import { describe, expect, it } from 'vitest';
import type { MuleFeatures } from '../mule/types';
import { mapBand, toRawFeatureVector } from './mapping';

describe('toRawFeatureVector', () => {
  it('maps every one of the 15 MuleFeatures fields through unchanged (identical snake_case shapes)', () => {
    const features: MuleFeatures = {
      dwell_median_min: 12.5,
      fan_out_1h: 3,
      fan_in_unique: 5,
      passthrough_ratio: 0.9,
      age_at_taint_days: 1.5,
      activator_label: 'exchange',
      trx_dust_usdt: true,
      round_amount_ratio: 0.25,
      burst_tx_per_hour: 4,
      hops_from_victim: 2,
      hops_to_vasp: 1,
      sanction_exposure: null,
      external_flags: ['reported', 'high_risk'],
      shared_mule_cps: 3,
      cross_case_count: 0, // regression: 0 must pass through, never treated as falsy/missing
    };

    expect(toRawFeatureVector(features)).toEqual(features);
  });

  it('preserves cross_case_count=0 distinctly from null (no >=1 assumption anywhere)', () => {
    const features: MuleFeatures = {
      dwell_median_min: null,
      fan_out_1h: 0,
      fan_in_unique: 0,
      passthrough_ratio: null,
      age_at_taint_days: null,
      activator_label: null,
      trx_dust_usdt: false,
      round_amount_ratio: 0,
      burst_tx_per_hour: 0,
      hops_from_victim: null,
      hops_to_vasp: null,
      sanction_exposure: null,
      external_flags: [],
      shared_mule_cps: 0,
      cross_case_count: 0,
    };
    const raw = toRawFeatureVector(features);
    expect(raw.cross_case_count).toBe(0);
    expect(raw.shared_mule_cps).toBe(0);
    expect(raw.hops_from_victim).toBeNull();
  });
});

describe('mapBand', () => {
  it.each([
    ['Low', 'LOW'],
    ['Medium', 'MEDIUM'],
    ['High', 'HIGH'],
    ['Critical', 'CRITICAL'],
  ] as const)('maps %s -> %s', (input, expected) => {
    expect(mapBand(input)).toBe(expected);
  });

  it('throws loudly on an unexpected band string instead of silently uppercasing it', () => {
    expect(() => mapBand('extreme')).toThrow(/unexpected ML band value/);
    expect(() => mapBand('')).toThrow();
    expect(() => mapBand('low')).toThrow(); // wrong case is not accepted implicitly
  });
});
