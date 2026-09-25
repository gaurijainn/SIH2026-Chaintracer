import type { Chain } from '@ps26183/shared';
import type { ChainabuseClient, ChainabuseReport } from '../../attribution/loaders/chainabuse';

/**
 * B7.4 task 6: Chainabuse must be hard-limited to 10 calls TOTAL, enforced in code -- not just
 * config/comments -- and only ever called for high-risk candidates, never negatives. `ChainabuseBudget`
 * is a plain counter: `consume()` throws the instant a call (including a retry attempt) would push
 * the running total past `max`, so nothing downstream -- not even a retry loop -- can exceed it.
 */
export class ChainabuseBudgetExceededError extends Error {
  constructor(attempted: number, max: number) {
    super(`chainabuse call budget exceeded: attempted call ${attempted}, max ${max}`);
    this.name = 'ChainabuseBudgetExceededError';
  }
}

export class ChainabuseBudget {
  private used = 0;
  constructor(private readonly max: number = 10) {}

  get remaining(): number {
    return this.max - this.used;
  }
  get callsUsed(): number {
    return this.used;
  }

  /** Must be called immediately before every single outbound Chainabuse request attempt, including retries. */
  consume(n = 1): void {
    if (this.used + n > this.max) throw new ChainabuseBudgetExceededError(this.used + n, this.max);
    this.used += n;
  }
}

/**
 * Deterministically selects at most `max` high-risk candidates for Chainabuse enrichment: stable
 * sort by address, then take the first `max`. Same input -> same selection, every run.
 */
export function selectChainabuseCandidates(highRiskAddresses: readonly string[], max = 10): string[] {
  return [...highRiskAddresses].sort((a, b) => a.localeCompare(b)).slice(0, max);
}

export interface ChainabuseEnrichmentRecord {
  address: string;
  reports: ChainabuseReport[];
  attempts: number;
}

/**
 * Calls Chainabuse only for `addresses` (already selected by selectChainabuseCandidates), gating
 * every attempt -- including retries -- through `budget.consume()`, so an 11th attempt of any kind
 * (a new address, or a retry of one already tried) throws before the network call is even made.
 * Persists which addresses were enriched (task 6: "persist which addresses were enriched").
 */
export async function enrichHighRiskWithChainabuse(
  client: ChainabuseClient,
  budget: ChainabuseBudget,
  addresses: readonly string[],
  opts: { maxRetries?: number } = {},
): Promise<ChainabuseEnrichmentRecord[]> {
  const maxRetries = opts.maxRetries ?? 1;
  const out: ChainabuseEnrichmentRecord[] = [];
  for (const address of addresses) {
    let attempts = 0;
    let lastErr: unknown;
    let reports: ChainabuseReport[] | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      budget.consume(1); // gates the retry too -- throws before the (attempts+1)th network call if the budget is exhausted
      attempts++;
      try {
        reports = await client.reportsFor(address);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (reports === null) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    out.push({ address, reports, attempts });
  }
  return out;
}

export function chainAbuseEnrichmentToCsvRows(chain: Chain, records: ChainabuseEnrichmentRecord[], nowIso: string): Record<string, string>[] {
  return records.map((r) => ({
    address: r.address,
    chain,
    reportCount: String(r.reports.length),
    attempts: String(r.attempts),
    enrichedAt: nowIso,
  }));
}
