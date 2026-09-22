/** Label categories that make an address a stop condition ("labeled service reached", plan B4). */
export const SERVICE_LABEL_CATEGORIES = ['exchange', 'mixer', 'bridge', 'sanctioned'] as const;
export type ServiceLabelCategory = (typeof SERVICE_LABEL_CATEGORIES)[number];

export interface LabelMatch {
  category: string;
  name: string;
}

export function isServiceLabel(l: LabelMatch | null): l is LabelMatch & { category: ServiceLabelCategory } {
  return !!l && (SERVICE_LABEL_CATEGORIES as readonly string[]).includes(l.category);
}

/** ts is at or after the trace's incident-window start, and no more than windowDays after it. */
export function withinWindow(ts: number, windowStartMs: number, windowDays: number): boolean {
  return ts >= windowStartMs && ts <= windowStartMs + windowDays * 86_400_000;
}

/** usd === null means "unpriceable"; kept rather than dropped (the caller ranks it last, never excludes it here). */
export function meetsMinValue(usd: number | null, minValueUsd: number): boolean {
  return usd === null || usd >= minValueUsd;
}

/** Plan B4: "address with more than 5,000 counterparties is treated as an unlabeled service and flagged for review". */
export function isHighDegree(counterpartyCount: number, cutoff: number): boolean {
  return counterpartyCount > cutoff;
}
