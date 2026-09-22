import type { Chain } from '@ps26183/shared';

/** Neutral vocabulary only (plan B6, same rule as B5): never "criminal" — a rule "fires", a wallet is a "candidate". */
export const MULE_RULE_CODES = ['PASS_THROUGH', 'FAN_OUT', 'PEEL_CHAIN', 'FRESH_WALLET', 'TRX_DUST_USDT'] as const;
export type MuleRuleCode = (typeof MULE_RULE_CODES)[number];

/** One Hop row's worth of data a B6 rule needs. Matches apps/api's Hop model structurally. */
export interface HopLike {
  txHash: string;
  idx: number;
  fromAddr: string;
  toAddr: string;
  token: string;
  amount: string | number;
  usd: string | number | null;
  ts: Date | number;
}

/** A single fired rule's confidence and structured evidence explaining why it fired. */
export interface MuleRuleMatch {
  confidence: number;
  evidence: Record<string, unknown>;
}

/** One fired rule against one address, ready to persist as a MuleFlag row. */
export interface MuleFlagResult {
  chain: Chain;
  addr: string;
  rule: MuleRuleCode;
  confidence: number;
  evidence: Record<string, unknown>;
}

/** Appendix B feature vector, computed per address from existing B1-B5 data (no live provider calls). */
export interface MuleFeatures {
  dwell_median_min: number | null;
  fan_out_1h: number;
  fan_in_unique: number;
  passthrough_ratio: number | null;
  age_at_taint_days: number | null;
  activator_label: string | null;
  trx_dust_usdt: boolean;
  round_amount_ratio: number;
  burst_tx_per_hour: number;
  hops_from_victim: number | null;
  hops_to_vasp: number | null;
  sanction_exposure: number | null;
  external_flags: string[];
  shared_mule_cps: number;
  cross_case_count: number;
}
