import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from '../config';
import { round3 } from '../hopMath';
import type { MuleRuleMatch } from '../types';

/**
 * Plan B6, rule D (fresh wallet): wallet age at first tainted-fund receipt is under the configured
 * threshold. Requires on-chain account creation time (AddressProfile.createdAt); returns no match
 * (rather than guessing) when that metadata is unavailable.
 */
export function detectFreshWallet(
  createdAtMs: number | null,
  firstTaintedAtMs: number | null,
  cfg: MuleRuleConfig['freshWallet'] = DEFAULT_MULE_RULE_CONFIG.freshWallet,
): MuleRuleMatch[] {
  if (createdAtMs == null || firstTaintedAtMs == null) return [];
  const ageDays = (firstTaintedAtMs - createdAtMs) / 86_400_000;
  if (ageDays < 0 || ageDays > cfg.maxAgeDays) return [];
  return [
    {
      confidence: 0.75,
      evidence: {
        ageDays: round3(ageDays),
        maxAgeDays: cfg.maxAgeDays,
        createdAt: new Date(createdAtMs).toISOString(),
        firstTaintedAt: new Date(firstTaintedAtMs).toISOString(),
      },
    },
  ];
}
