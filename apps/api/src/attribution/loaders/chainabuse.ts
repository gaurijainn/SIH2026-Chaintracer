import type { Chain } from '@ps26183/shared';
import { TTL_ACCOUNT_META_S, type HttpFactory, type ProviderGuard } from '@ps26183/workers/adapters';
import { upsertLabels, type LabelPrisma } from '../labelStore';
import type { NormalizedLabel } from '../types';

/**
 * Chainabuse victim/investigator scam reports (docs.trmlabs.com/guides/chainabuse). Reuses B3's
 * ProviderGuard + record/replay HTTP factory (rate limiting, retries, caching) rather than building a
 * separate client. Response shape confirmed by one live read-only call during B5 development
 * (GET /v0/reports?address=...&page=1&perPage=N -> {count, reports: [...]}); cached forever per
 * address so a rerun never re-queries Chainabuse.
 */
export interface ChainabuseDeps {
  guard: ProviderGuard;
  http: HttpFactory;
}

export interface ChainabuseReport {
  id?: string;
  category?: string;
  isVerified?: boolean;
  createdAt?: string;
}

const CHAINABUSE_URL = 'https://api.chainabuse.com/v0/reports';
const CHAINABUSE_HEADERS = { Authorization: 'Basic {CHAINABUSE_BASIC}' };

export class ChainabuseClient {
  constructor(private d: ChainabuseDeps) {}

  /** One address at a time by design (plan Section 10: never crawl Chainabuse in bulk). */
  async reportsFor(addr: string, perPage = 20): Promise<ChainabuseReport[]> {
    return this.d.guard.cached(`chainabuse:${addr}`, TTL_ACCOUNT_META_S, async () => {
      const data = await this.d.guard.call([
        {
          provider: 'chainabuse',
          run: async () =>
            (
              await this.d.http('chainabuse').get<{ count?: number; reports?: ChainabuseReport[] }>(
                `${CHAINABUSE_URL}?address=${encodeURIComponent(addr)}&page=1&perPage=${perPage}`,
                { headers: CHAINABUSE_HEADERS },
              )
            ).data,
        },
      ]);
      return data.reports ?? [];
    });
  }
}

export function normalizeChainabuseReports(chain: Chain, addr: string, reports: ChainabuseReport[]): NormalizedLabel[] {
  return reports.map((r, i) => ({
    chain,
    addr,
    name: r.category ? `Chainabuse: ${r.category}` : `Chainabuse report ${r.id ?? i}`,
    category: 'reported',
    source: 'chainabuse',
    // moderator-checked ("verified") reports carry more weight than an unverified submission
    confidence: r.isVerified ? 0.75 : 0.4,
    evidence: { reportId: r.id ?? null, category: r.category ?? null, isVerified: r.isVerified ?? false, createdAt: r.createdAt ?? null },
  }));
}

export async function loadChainabuseLabel(prisma: LabelPrisma, client: ChainabuseClient, chain: Chain, addr: string): Promise<number> {
  const reports = await client.reportsFor(addr);
  const labels = normalizeChainabuseReports(chain, addr, reports);
  await upsertLabels(prisma, labels);
  return labels.length;
}
