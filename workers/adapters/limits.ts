/**
 * Per-provider rate limits and daily budgets. These are conservative DEFAULTS for the free tiers named in plan
 * Section 3; quotas change, so they live only here and can be overridden with PROVIDER_LIMITS (JSON) without
 * touching business logic. `dailyBudget` is a self-imposed ceiling (the provider's real quota is checked in
 * its console); when reached the provider is skipped and the backup takes over.
 */
export interface ProviderLimit {
  /** requests per second (token bucket; below 1 becomes a spacing of 1/rps seconds) */
  rps: number;
  maxConcurrent: number;
  dailyBudget?: number;
}

export const DEFAULT_LIMITS: Record<string, ProviderLimit> = {
  trongrid: { rps: 10, maxConcurrent: 4, dailyBudget: 90_000 },
  tronscan: { rps: 4, maxConcurrent: 2 },
  etherscan: { rps: 5, maxConcurrent: 3, dailyBudget: 90_000 },
  meganode: { rps: 10, maxConcurrent: 4 },
  blockscout: { rps: 5, maxConcurrent: 3, dailyBudget: 90_000 },
  esplora: { rps: 4, maxConcurrent: 2 },
  mempool: { rps: 4, maxConcurrent: 2 },
  coingecko: { rps: 0.4, maxConcurrent: 1 }, // Demo plan: about 30 calls/minute
  defillama: { rps: 5, maxConcurrent: 3 },
  frankfurter: { rps: 5, maxConcurrent: 3 },
  ankr: { rps: 8, maxConcurrent: 3 },
};
export const FALLBACK_LIMIT: ProviderLimit = { rps: 2, maxConcurrent: 1 };

export function parseLimitOverrides(json: string): Record<string, ProviderLimit> {
  if (!json.trim()) return DEFAULT_LIMITS;
  const over = JSON.parse(json) as Record<string, Partial<ProviderLimit>>;
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] ?? FALLBACK_LIMIT), ...v };
  return out;
}
