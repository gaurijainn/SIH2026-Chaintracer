import type { Chain } from '@ps26183/shared';
import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from './config';
import { detectFanOut } from './rules/fanOut';
import { detectFreshWallet } from './rules/freshWallet';
import { detectPassThrough } from './rules/passThrough';
import { detectTrxDustUsdt, type TrxDustInputs } from './rules/trxDustUsdt';
import type { HopLike, MuleFlagResult, MuleRuleMatch } from './types';

export interface DetectMuleActivityInput {
  chain: Chain;
  addr: string;
  inbound: HopLike[];
  outbound: HopLike[];
  accountCreatedAtMs: number | null;
  firstTaintedAtMs: number | null;
  trxDust?: TrxDustInputs;
  config?: MuleRuleConfig;
}

/** Picks the strongest match when a rule can fire more than once for the same address (e.g. fan-out). */
function strongest(matches: MuleRuleMatch[]): MuleRuleMatch | undefined {
  if (matches.length === 0) return undefined;
  return matches.reduce((best, m) => {
    const bestSize = Number((best.evidence as { distinctRecipients?: number }).distinctRecipients ?? 0);
    const mSize = Number((m.evidence as { distinctRecipients?: number }).distinctRecipients ?? 0);
    return mSize > bestSize ? m : best;
  });
}

/**
 * Runs the per-address B6 rules (pass-through, fan-out, fresh wallet, TRX-dust USDT) against one
 * address. Bitcoin peel chains span multiple addresses and are detected separately over a whole
 * trace's hop set (see rules/peelChain.ts) and merged in by the caller (analyzeCase.ts).
 */
export function detectMuleActivity(input: DetectMuleActivityInput): MuleFlagResult[] {
  const cfg = input.config ?? DEFAULT_MULE_RULE_CONFIG;
  const results: MuleFlagResult[] = [];

  for (const m of detectPassThrough(input.inbound, input.outbound, cfg.passThrough)) {
    results.push({ chain: input.chain, addr: input.addr, rule: 'PASS_THROUGH', confidence: m.confidence, evidence: m.evidence });
  }

  const fanOut = strongest(detectFanOut(input.inbound, input.outbound, cfg.fanOut));
  if (fanOut) results.push({ chain: input.chain, addr: input.addr, rule: 'FAN_OUT', confidence: fanOut.confidence, evidence: fanOut.evidence });

  for (const m of detectFreshWallet(input.accountCreatedAtMs, input.firstTaintedAtMs, cfg.freshWallet)) {
    results.push({ chain: input.chain, addr: input.addr, rule: 'FRESH_WALLET', confidence: m.confidence, evidence: m.evidence });
  }

  if (input.trxDust) {
    for (const m of detectTrxDustUsdt(input.trxDust, cfg.trxDustUsdt)) {
      results.push({ chain: input.chain, addr: input.addr, rule: 'TRX_DUST_USDT', confidence: m.confidence, evidence: m.evidence });
    }
  }

  return results;
}
