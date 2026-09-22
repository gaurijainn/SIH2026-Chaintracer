import type { HopLike } from './types';

/** Prices a hop in USD when known, else falls back to its raw token amount (mirrors B5's `value()`). */
export const hopValue = (h: HopLike): number => (h.usd != null ? Number(h.usd) : Number(h.amount) || 0);
export const hopTs = (h: HopLike): number => (h.ts instanceof Date ? h.ts.getTime() : h.ts);
export const sumValue = (hs: HopLike[]): number => hs.reduce((s, h) => s + hopValue(h), 0);
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Median minutes between receiving and forwarding funds (Appendix B `dwell_median_min`). Pairs the
 * i-th earliest inbound hop with the i-th earliest outbound hop (a FIFO approximation of which
 * inbound funded which outbound) and takes the median of the non-negative gaps.
 */
export function dwellMedianMin(inbound: HopLike[], outbound: HopLike[]): number | null {
  if (inbound.length === 0 || outbound.length === 0) return null;
  const ins = inbound.map(hopTs).sort((a, b) => a - b);
  const outs = outbound.map(hopTs).sort((a, b) => a - b);
  const n = Math.min(ins.length, outs.length);
  const dwells: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = (outs[i] - ins[i]) / 60_000;
    if (d >= 0) dwells.push(d);
  }
  if (dwells.length === 0) return null;
  dwells.sort((a, b) => a - b);
  const mid = Math.floor(dwells.length / 2);
  return round3(dwells.length % 2 ? dwells[mid] : (dwells[mid - 1] + dwells[mid]) / 2);
}

/**
 * Appendix B `fan_out_1h`: the most distinct recipients reached within `windowMinutes` of any single
 * inbound hop (worst case across all inbound events, not just the first).
 */
export function fanOut1h(inbound: HopLike[], outbound: HopLike[], windowMinutes = 60): number {
  let max = 0;
  for (const inHop of inbound) {
    const t0 = hopTs(inHop);
    const windowEnd = t0 + windowMinutes * 60_000;
    const recipients = new Set(outbound.filter((o) => hopTs(o) > t0 && hopTs(o) <= windowEnd).map((o) => o.toAddr));
    if (recipients.size > max) max = recipients.size;
  }
  return max;
}

/** Appendix B `fan_in_unique`: distinct senders in the last `windowDays`. */
export function fanInUnique(inbound: HopLike[], asOfMs: number, windowDays = 30): number {
  const since = asOfMs - windowDays * 86_400_000;
  return new Set(inbound.filter((h) => hopTs(h) >= since && hopTs(h) <= asOfMs).map((h) => h.fromAddr)).size;
}

/** Appendix B `passthrough_ratio`: value out / value in. Null when nothing was received. */
export function passthroughRatio(inbound: HopLike[], outbound: HopLike[]): number | null {
  const totalIn = sumValue(inbound);
  if (totalIn <= 0) return null;
  return round3(sumValue(outbound) / totalIn);
}

/** A transfer amount is "round" when its whole-unit part is a multiple of 10 and at least 10. */
export function isRoundAmount(amount: number): boolean {
  if (amount < 10) return false;
  const whole = Math.round(amount);
  return Math.abs(whole - amount) < 0.01 * amount + 1e-9 && whole % 10 === 0;
}

/** Appendix B `round_amount_ratio`: share of transfers (in + out) that are round amounts. */
export function roundAmountRatio(hops: HopLike[]): number {
  if (hops.length === 0) return 0;
  const roundCount = hops.filter((h) => isRoundAmount(Number(h.amount))).length;
  return round3(roundCount / hops.length);
}

/** Appendix B `burst_tx_per_hour`: peak transaction count in any rolling 1-hour window. */
export function burstTxPerHour(hops: HopLike[]): number {
  const times = hops.map(hopTs).sort((a, b) => a - b);
  let max = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > 3_600_000) left++;
    max = Math.max(max, right - left + 1);
  }
  return max;
}

/** Appendix B `age_at_taint_days`: wallet age (days) when it first received tainted funds. */
export function ageAtTaintDays(createdAtMs: number | null, firstTaintedAtMs: number | null): number | null {
  if (createdAtMs == null || firstTaintedAtMs == null) return null;
  const days = (firstTaintedAtMs - createdAtMs) / 86_400_000;
  return days >= 0 ? round3(days) : null;
}
