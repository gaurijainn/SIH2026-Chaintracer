import type { Chain } from '@ps26183/shared';
import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from '../config';
import type { MuleRuleMatch } from '../types';

export interface TrxDustInputs {
  chain: Chain;
  /** native TRX balance, whole units; null when the metadata was not fetched. */
  trxBalance: number | null;
  /** USDT-TRC20 balance, whole units; null when the metadata was not fetched. */
  usdtBalance: number | null;
  /** whether TronGrid/Tronscan resource data shows delegated (rented) energy; null when unknown. */
  energyDelegated: boolean | null;
}

/**
 * Plan B6, rule E (TRX-dust USDT wallet): holds USDT but almost no TRX, and (where the metadata
 * supports it) relies on rented energy delegation rather than its own TRX for fees. TRON-only.
 * Fires only when both balances are actually known — per the plan, we never claim this pattern from
 * missing metadata; when energy-delegation status is unknown that limitation is recorded in evidence
 * and confidence is lowered rather than treated as a positive signal.
 */
export function detectTrxDustUsdt(input: TrxDustInputs, cfg: MuleRuleConfig['trxDustUsdt'] = DEFAULT_MULE_RULE_CONFIG.trxDustUsdt): MuleRuleMatch[] {
  if (input.chain !== 'TRON') return [];
  if (input.trxBalance == null || input.usdtBalance == null) return [];
  if (input.usdtBalance < cfg.minUsdtBalance) return [];
  if (input.trxBalance > cfg.maxTrxBalance) return [];

  const limitations: string[] = [];
  if (input.energyDelegated == null) limitations.push('energy-delegation status unavailable from current account metadata');

  return [
    {
      confidence: input.energyDelegated === true ? 0.85 : 0.6,
      evidence: {
        trxBalance: input.trxBalance,
        usdtBalance: input.usdtBalance,
        maxTrxBalance: cfg.maxTrxBalance,
        minUsdtBalance: cfg.minUsdtBalance,
        energyDelegated: input.energyDelegated,
        limitations,
      },
    },
  ];
}
