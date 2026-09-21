import { buildSecrets, createHttp, type Env } from '@ps26183/shared';
import type { IngestResult, IntakeService } from './service';
import type { RawComplaint } from './types';

/**
 * NCRP / CFCFRMS complaint feed adapter. No public NCRP API exists, so the feed contract is our own
 * (mocks/openapi/ncrp.yaml) and is served by mocks/mock-server. Pointing NCRP_BASE_URL at an official
 * endpoint later is a configuration change; only `fromNcrpRecord` would need to follow its real field names.
 */
export const NCRP_PAGE_SIZE = 100;

export interface NcrpRecord {
  acknowledgementNumber?: unknown;
  incidentDateTime?: unknown;
  categoryOfComplaint?: unknown;
  amountLost?: unknown;
  paymentNetwork?: unknown;
  walletAddresses?: unknown;
  transactionHashes?: unknown;
  tokenContract?: unknown;
  firNumber?: unknown;
}

export function fromNcrpRecord(r: NcrpRecord): RawComplaint {
  return {
    ackNo: r.acknowledgementNumber,
    reportedAt: r.incidentDateTime,
    category: r.categoryOfComplaint,
    amountInr: r.amountLost,
    network: r.paymentNetwork,
    addresses: r.walletAddresses,
    txHashes: r.transactionHashes,
    tokenContract: r.tokenContract,
    firNumber: r.firNumber,
  };
}

export interface NcrpFeed {
  fetchPage(page: number): Promise<{ records: NcrpRecord[]; hasMore: boolean }>;
}

/**
 * HTTP feed. The URL is templated with {NCRP_BASE_URL} so replay fixtures are keyed the same on every
 * machine (laptop, docker, CI) and the poller works offline in DATA_MODE=replay.
 */
export function createHttpNcrpFeed(env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR'> & Record<string, unknown>): NcrpFeed {
  const http = createHttp({ provider: 'ncrp', mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, secrets: buildSecrets(env), timeoutMs: 8000 });
  return {
    async fetchPage(page) {
      const { data } = await http.get(ncrpFeedUrl(page));
      if (!data || !Array.isArray(data.items)) throw new Error('NCRP feed: unexpected response shape');
      return { records: data.items as NcrpRecord[], hasMore: Boolean(data.hasMore) };
    },
  };
}
export const ncrpFeedUrl = (page: number) => `{NCRP_BASE_URL}/ncrp/v1/complaints?page=${page}&perPage=${NCRP_PAGE_SIZE}`;

export interface PollResult {
  pages: number;
  fetched: number;
  ingest: IngestResult | null;
  error?: string;
}

/**
 * Drains the feed page by page and ingests every record. Safe to run repeatedly: complaints are
 * deduplicated by acknowledgement number, so a second poll of the same feed creates nothing.
 */
export async function pollNcrp(feed: NcrpFeed, service: Pick<IntakeService, 'ingest'>, maxPages = 50): Promise<PollResult> {
  const inputs: { row: number; raw: RawComplaint }[] = [];
  let pages = 0;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { records, hasMore } = await feed.fetchPage(page);
      pages++;
      records.forEach((r, i) => inputs.push({ row: (page - 1) * NCRP_PAGE_SIZE + i + 1, raw: fromNcrpRecord(r) }));
      if (!hasMore) break;
    }
  } catch (e) {
    return { pages, fetched: inputs.length, ingest: null, error: e instanceof Error ? e.message : String(e) };
  }
  return { pages, fetched: inputs.length, ingest: inputs.length ? await service.ingest(inputs) : null };
}

/** Interval poller with an overlap guard. Disabled when intervalMs is 0. */
export class NcrpPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  last: PollResult | null = null;

  constructor(
    private feed: NcrpFeed,
    private service: Pick<IntakeService, 'ingest'>,
    private intervalMs: number,
    private log: (msg: string) => void = console.log,
  ) {}

  async pollOnce(): Promise<PollResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const r = await pollNcrp(this.feed, this.service);
      this.last = r;
      const s = r.ingest?.summary;
      this.log(
        r.error
          ? `ncrp poll failed: ${r.error}`
          : `ncrp poll: ${r.fetched} records, ${s ? `${s.created} created, ${s.duplicates} duplicate, ${s.invalid} invalid` : 'nothing new'}`,
      );
      return r;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.last = { pages: 0, fetched: 0, ingest: null, error };
      this.log(`ncrp poll failed: ${error}`);
      return this.last;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.intervalMs <= 0 || this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
