import type { AccountMeta } from '@ps26183/shared';

export interface KnownActivator {
  addr: string;
  vaspId: string;
  vaspName: string;
}

export interface TronActivationMatch {
  vaspId: string;
  vaspName: string;
  confidence: number;
  evidence: { activator: string; createdAt: number | null };
}

/**
 * H2 (plan B5): the account was activated by (first TRX received from) a wallet known to be an
 * exchange's activator/fee-supplier. Weaker signal than a real deposit sweep (H1) — an activator can
 * fund many unrelated accounts — so it gets a lower base confidence.
 */
export function detectTronActivation(meta: AccountMeta, knownActivators: KnownActivator[]): TronActivationMatch[] {
  if (!meta.activator) return [];
  const hit = knownActivators.find((a) => a.addr === meta.activator);
  if (!hit) return [];
  return [{ vaspId: hit.vaspId, vaspName: hit.vaspName, confidence: 0.6, evidence: { activator: meta.activator, createdAt: meta.createdAt } }];
}
