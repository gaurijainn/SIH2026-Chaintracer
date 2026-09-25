import { describe, expect, it } from 'vitest';
import type { MuleFeatures } from '../types';
import { MULE_FEATURE_NAMES } from './types';

describe('MULE_FEATURE_NAMES', () => {
  it('matches the plan Appendix-B / B7.1 canonical order exactly', () => {
    expect(MULE_FEATURE_NAMES).toEqual([
      'dwell_median_min',
      'fan_out_1h',
      'fan_in_unique',
      'passthrough_ratio',
      'age_at_taint_days',
      'activator_label',
      'trx_dust_usdt',
      'round_amount_ratio',
      'burst_tx_per_hour',
      'hops_from_victim',
      'hops_to_vasp',
      'sanction_exposure',
      'external_flags',
      'shared_mule_cps',
      'cross_case_count',
    ]);
  });

  it('covers every key of MuleFeatures exactly once (no missing/extra field)', () => {
    const sample: MuleFeatures = {
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
      cross_case_count: 1,
    };
    expect([...MULE_FEATURE_NAMES].sort()).toEqual(Object.keys(sample).sort());
  });
});
