import type { Chain } from '@ps26183/shared';

/** The exact subset of PrismaClient the sanction/blacklist lookup needs. */
export interface SanctionLookupPrisma {
  label: {
    findMany(args: { where: { chain: string; addr: string } }): Promise<{ category: string; name: string }[]>;
  };
}

export interface SanctionEvidence {
  /** `undefined` = no evidence either way ("unknown"); only `true` is ever returned -- never a fabricated `false`. */
  sanctioned?: boolean;
  stablecoinBlacklisted?: boolean;
}

/**
 * Sanctioned (OFAC) / stablecoin-blacklist evidence for one address, from persisted B5 `Label` rows.
 * - `sanctioned: true` when any Label row has `category === 'sanctioned'`.
 * - `stablecoinBlacklisted: true` when a Label row matches exactly the shape
 *   `apps/api/src/attribution/loaders/tronscan.ts`'s `normalizeTronscanMeta` writes for Tether's
 *   stablecoin blacklist flag: `category: 'high_risk'`, `name: 'Tether: stablecoin blacklist'`
 *   (category 'high_risk' alone is not used, since other flags could share it in the future).
 * When no matching label exists, the field is left `undefined` -- per B7.5's override semantics,
 * `None`/absent means "unknown" on the ML side, and only an explicit `true` fires a hard override.
 * Node must never itself decide `false` just because there is no evidence either way.
 */
export async function lookupSanctionEvidence(deps: { prisma: SanctionLookupPrisma }, chain: Chain, addr: string): Promise<SanctionEvidence> {
  const labels = await deps.prisma.label.findMany({ where: { chain, addr } });
  const evidence: SanctionEvidence = {};
  if (labels.some((l) => l.category === 'sanctioned')) evidence.sanctioned = true;
  if (labels.some((l) => l.category === 'high_risk' && l.name === 'Tether: stablecoin blacklist')) evidence.stablecoinBlacklisted = true;
  return evidence;
}
