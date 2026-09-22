import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from '../config';
import { dwellMedianMin, round3, sumValue } from '../hopMath';
import type { HopLike, MuleRuleMatch } from '../types';

/**
 * Plan B6, rule A (pass-through): value out is approximately equal to value in, and the median dwell
 * time is under the configured threshold. Fires at most once per address (it describes the address's
 * overall behaviour, not a single event).
 */
export function detectPassThrough(inbound: HopLike[], outbound: HopLike[], cfg: MuleRuleConfig['passThrough'] = DEFAULT_MULE_RULE_CONFIG.passThrough): MuleRuleMatch[] {
  if (inbound.length === 0 || outbound.length === 0) return [];
  const totalIn = sumValue(inbound);
  if (totalIn <= 0) return [];
  const totalOut = sumValue(outbound);
  const ratio = totalOut / totalIn;
  const dwell = dwellMedianMin(inbound, outbound);
  if (dwell == null) return [];
  if (Math.abs(ratio - 1) > cfg.valueTolerance) return [];
  if (dwell > cfg.maxDwellMinutes) return [];

  return [
    {
      confidence: 0.8,
      evidence: {
        valueIn: round3(totalIn),
        valueOut: round3(totalOut),
        ratio: round3(ratio),
        valueTolerance: cfg.valueTolerance,
        dwellMedianMin: dwell,
        maxDwellMinutes: cfg.maxDwellMinutes,
      },
    },
  ];
}
