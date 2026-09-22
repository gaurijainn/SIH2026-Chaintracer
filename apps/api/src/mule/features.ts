import type { Chain } from '@ps26183/shared';
import { ageAtTaintDays, burstTxPerHour, dwellMedianMin, fanInUnique, fanOut1h, passthroughRatio, roundAmountRatio } from './hopMath';
import type { HopLike, MuleFeatures } from './types';

export interface MuleFeatureInputs {
  chain: Chain;
  addr: string;
  inbound: HopLike[];
  outbound: HopLike[];
  /** on-chain account creation, epoch ms (AddressProfile.createdAt); null when unknown. */
  accountCreatedAtMs: number | null;
  /** timestamp of the earliest inbound hop in this trace context; null when the address never received funds here. */
  firstTaintedAtMs: number | null;
  /** label/category of the wallet that activated this account (TRON), if the activator itself carries a label. */
  activatorLabel: string | null;
  /** hop-distance to the nearest sanctioned address touching this trace; null when none was found. */
  sanctionExposure: number | null;
  /** Tronscan/Chainabuse/blacklist flags already on file (AddressProfile.flags, Label rows). */
  externalFlags: string[];
  /** true only when B5's H1-H4 attribution/labels resolved this address (or an ancestor) as USDT-holding TRON dust. */
  trxDustUsdt: boolean;
  hopsFromVictim: number | null;
  hopsToVasp: number | null;
  /** counterparties this address shares with addresses already flagged as mules elsewhere in the case. */
  sharedMuleCps: number;
  /** complaints/cases this address has been seen in (B6 cross-case linkage). */
  crossCaseCount: number;
}

/** Assembles the Appendix B feature vector for one address from already-fetched B1-B5 data. */
export function computeMuleFeatures(input: MuleFeatureInputs): MuleFeatures {
  const allHops = [...input.inbound, ...input.outbound];
  const asOf = input.firstTaintedAtMs ?? Math.max(0, ...allHops.map((h) => (h.ts instanceof Date ? h.ts.getTime() : h.ts)));
  return {
    dwell_median_min: dwellMedianMin(input.inbound, input.outbound),
    fan_out_1h: fanOut1h(input.inbound, input.outbound),
    fan_in_unique: fanInUnique(input.inbound, asOf),
    passthrough_ratio: passthroughRatio(input.inbound, input.outbound),
    age_at_taint_days: ageAtTaintDays(input.accountCreatedAtMs, input.firstTaintedAtMs),
    activator_label: input.activatorLabel,
    trx_dust_usdt: input.trxDustUsdt,
    round_amount_ratio: roundAmountRatio(allHops),
    burst_tx_per_hour: burstTxPerHour(allHops),
    hops_from_victim: input.hopsFromVictim,
    hops_to_vasp: input.hopsToVasp,
    sanction_exposure: input.sanctionExposure,
    external_flags: input.externalFlags,
    shared_mule_cps: input.sharedMuleCps,
    cross_case_count: input.crossCaseCount,
  };
}
