import type { TronAdapter } from '@ps26183/workers/adapters';

/**
 * B7.4 real-collection gap-filler: there is no free "list random active TRON address" endpoint, so
 * the only real source of addresses with *observed* on-chain activity available to this project's
 * free-tier providers is the transfer counterparties of addresses we already have reason to query
 * (reuses TronAdapter.getTransfers -- no new HTTP client, no invented data). Any address returned
 * here genuinely appeared as a counterparty in a real transfer; whether it ultimately qualifies as
 * a licit negative is still decided entirely by negativeCandidates.ts's evidence requirements --
 * this module only proposes candidates, it never labels them.
 */
export interface CandidateDiscoveryOpts {
  /** how many seed addresses to harvest counterparties from (bounds API calls: 2 calls/seed) */
  maxSeeds?: number;
  /** stop once this many unique candidate addresses have been found */
  maxCandidates?: number;
  /** addresses to never propose as candidates (already-labeled high-risk, OFAC, VASP registry, seeds themselves) */
  excludedAddresses: ReadonlySet<string>;
}

/**
 * Deterministic: seeds are visited in sorted order, and the returned candidate list is sorted.
 * Stops early once `maxCandidates` is reached so callers can bound the total work done.
 */
export async function discoverCandidateAddresses(tron: TronAdapter, seedAddresses: readonly string[], opts: CandidateDiscoveryOpts): Promise<string[]> {
  const maxSeeds = opts.maxSeeds ?? seedAddresses.length;
  const maxCandidates = opts.maxCandidates ?? Infinity;
  // Preserve the caller's ordering when capping to maxSeeds (e.g. a priority-sorted high-risk list) --
  // only the returned candidate set is sorted, not the seed selection itself.
  const seeds = [...new Set(seedAddresses)].slice(0, maxSeeds);
  const seedSet = new Set(seeds);
  const found = new Set<string>();

  for (const seed of seeds) {
    if (found.size >= maxCandidates) break;
    const [inPage, outPage] = await Promise.all([tron.getTransfers(seed, 'in'), tron.getTransfers(seed, 'out')]);
    for (const t of [...inPage.items, ...outPage.items]) {
      const counterparty = t.to === seed ? t.from : t.to;
      if (!counterparty || seedSet.has(counterparty) || opts.excludedAddresses.has(counterparty) || found.has(counterparty)) continue;
      found.add(counterparty);
      if (found.size >= maxCandidates) break;
    }
  }
  return [...found].sort();
}
