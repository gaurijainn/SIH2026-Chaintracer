import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from '../config';
import { hopTs } from '../hopMath';
import type { HopLike, MuleRuleMatch } from '../types';

/**
 * Plan B6, rule B (fan-out): an inbound is followed by `minDistinctOutputs` or more distinct outputs
 * within `windowMinutes`. Each qualifying inbound event fires its own match, evaluated strictly after
 * the inbound hop's timestamp; the caller combines matches (see detect.ts) into one MuleFlag.
 */
export function detectFanOut(inbound: HopLike[], outbound: HopLike[], cfg: MuleRuleConfig['fanOut'] = DEFAULT_MULE_RULE_CONFIG.fanOut): MuleRuleMatch[] {
  const matches: MuleRuleMatch[] = [];
  for (const inHop of inbound) {
    const t0 = hopTs(inHop);
    const windowEnd = t0 + cfg.windowMinutes * 60_000;
    const outs = outbound.filter((o) => hopTs(o) > t0 && hopTs(o) <= windowEnd);
    const recipients = new Set(outs.map((o) => o.toAddr));
    if (recipients.size < cfg.minDistinctOutputs) continue;
    matches.push({
      confidence: 0.85,
      evidence: {
        triggerTxHash: inHop.txHash,
        distinctRecipients: recipients.size,
        minDistinctOutputs: cfg.minDistinctOutputs,
        windowMinutes: cfg.windowMinutes,
        outputTxHashes: [...new Set(outs.map((o) => o.txHash))],
      },
    });
  }
  return matches;
}
