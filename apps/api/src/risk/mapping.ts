import type { RiskBand } from '@prisma/client';
import type { MuleFeatures } from '../mule/types';
import type { RawFeatureVector, RiskBandString } from './mlClient';

/**
 * `MuleFeatures` (apps/api/src/mule/types.ts) -> the ML service's raw `FeatureVector`
 * (services/ml/app/features/schema.py). Both are already snake_case and field-for-field identical
 * (types.ts's own comment: "Field shapes mirror ... MuleFeatures exactly"), so this is an identity
 * mapping, not a re-encoding -- explicitly NOT `apps/api/src/mule/export`'s `encodeCategoricals`,
 * which hashes/encodes categoricals for offline training and would corrupt a live inference request.
 * Kept as an explicit function (rather than a bare cast) so a future field added to one schema but
 * not the other fails to compile here instead of silently passing through.
 */
export function toRawFeatureVector(features: MuleFeatures): RawFeatureVector {
  return {
    dwell_median_min: features.dwell_median_min,
    fan_out_1h: features.fan_out_1h,
    fan_in_unique: features.fan_in_unique,
    passthrough_ratio: features.passthrough_ratio,
    age_at_taint_days: features.age_at_taint_days,
    activator_label: features.activator_label,
    trx_dust_usdt: features.trx_dust_usdt,
    round_amount_ratio: features.round_amount_ratio,
    burst_tx_per_hour: features.burst_tx_per_hour,
    hops_from_victim: features.hops_from_victim,
    hops_to_vasp: features.hops_to_vasp,
    sanction_exposure: features.sanction_exposure,
    external_flags: features.external_flags,
    shared_mule_cps: features.shared_mule_cps,
    cross_case_count: features.cross_case_count,
  };
}

const BAND_MAP: Record<RiskBandString, RiskBand> = {
  Low: 'LOW',
  Medium: 'MEDIUM',
  High: 'HIGH',
  Critical: 'CRITICAL',
};

/** Python `"Low"/"Medium"/"High"/"Critical"` -> Prisma `RiskBand` `LOW/MEDIUM/HIGH/CRITICAL`.
 * Explicit lookup, not `.toUpperCase()`: an unexpected band string throws instead of silently
 * producing a garbage value the Prisma enum column would then reject (or worse, coerce). */
export function mapBand(band: string): RiskBand {
  const mapped = BAND_MAP[band as RiskBandString];
  if (!mapped) throw new Error(`unexpected ML band value: ${JSON.stringify(band)}`);
  return mapped;
}
