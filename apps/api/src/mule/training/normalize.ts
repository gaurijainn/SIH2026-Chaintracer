import { classifyIdentifier, type Chain } from '@ps26183/shared';

const CHAIN_FAMILY: Record<Chain, 'TRON' | 'EVM' | 'BTC'> = { TRON: 'TRON', ETH: 'EVM', BSC: 'EVM', POLYGON: 'EVM', BTC: 'BTC' };

/**
 * Normalizes a raw address for a stated chain using the exact same rules B2 intake uses
 * (packages/shared/src/addressRules.ts's classifyIdentifier) -- one normalization path for the
 * whole platform, never a bespoke one for training data. Returns null (never a best-effort repair)
 * when the address is not a valid, checksummed address for that chain's family.
 */
export function normalizeAddressForChain(chain: Chain, raw: string): string | null {
  const classified = classifyIdentifier(raw);
  if (classified.kind !== 'ADDRESS') return null;
  if (classified.family !== CHAIN_FAMILY[chain]) return null;
  return classified.normalized;
}
