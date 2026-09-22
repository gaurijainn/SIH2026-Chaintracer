/**
 * B6 rule thresholds. Every comparison the plan describes in prose ("approximately equal", "under 60
 * minutes", "5 or more", "under 7 days") is a named, overridable field here rather than a magic number
 * buried in a rule — construct with overrides (e.g. from env) instead of editing defaults in place.
 */
export interface MuleRuleConfig {
  passThrough: {
    /** |valueOut/valueIn - 1| <= this counts as "approximately equal" (plan: value out ~ value in). */
    valueTolerance: number;
    /** plan: "median dwell time is under 60 minutes". */
    maxDwellMinutes: number;
  };
  fanOut: {
    /** plan: "5 or more distinct outputs". */
    minDistinctOutputs: number;
    /** plan: "within 1 hour". */
    windowMinutes: number;
  };
  peelChain: {
    /** number of consecutive single-input/two-output hand-offs required before calling it a peel chain. */
    minChainLength: number;
    /** a peel-chain transaction has at most this many outputs (typically 2: peel + change). */
    maxOutputsPerTx: number;
  };
  freshWallet: {
    /** plan: "wallet age at first tainted-fund receipt is under 7 days". */
    maxAgeDays: number;
  };
  trxDustUsdt: {
    /** at or below this TRX balance counts as "almost no TRX". */
    maxTrxBalance: number;
    /** at or above this USDT balance counts as "holds USDT". */
    minUsdtBalance: number;
  };
}

export const DEFAULT_MULE_RULE_CONFIG: MuleRuleConfig = {
  passThrough: { valueTolerance: 0.05, maxDwellMinutes: 60 },
  fanOut: { minDistinctOutputs: 5, windowMinutes: 60 },
  peelChain: { minChainLength: 3, maxOutputsPerTx: 3 },
  freshWallet: { maxAgeDays: 7 },
  trxDustUsdt: { maxTrxBalance: 1, minUsdtBalance: 1 },
};
