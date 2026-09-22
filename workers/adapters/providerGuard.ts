import Bottleneck from 'bottleneck';
import { MemoryCache, type Cache } from './cache';
import { ProviderHttpError, ProviderUnavailableError } from './errors';
import { DEFAULT_LIMITS, FALLBACK_LIMIT, type ProviderLimit } from './limits';

export interface RetryPolicy {
  /** total tries per provider per call, including the first (bounded: never retries forever) */
  attempts: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  /** ceiling for honouring a provider's Retry-After header */
  maxRetryAfterMs: number;
}
export interface BreakerPolicy {
  /** consecutive retryable failures before the circuit opens */
  failureThreshold: number;
  cooldownMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 400, factor: 2, maxMs: 8000, maxRetryAfterMs: 10_000 };
export const DEFAULT_BREAKER: BreakerPolicy = { failureThreshold: 8, cooldownMs: 30_000 };

export interface GuardOptions {
  cache?: Cache;
  limits?: Record<string, ProviderLimit>;
  retry?: Partial<RetryPolicy>;
  breaker?: Partial<BreakerPolicy>;
  /** replay mode reads local files, so rate limiting and back-off only add latency */
  unlimited?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ProviderStats {
  calls: number;
  retries: number;
  throttled: number; // 429 / 403 / rate-limit bodies seen
  failures: number; // retryable failures
  failovers: number; // calls that had to move on to the next provider
  circuitOpens: number;
  quotaSkips: number;
}
export interface CacheStats {
  hits: number;
  misses: number;
}

export interface Step<T> {
  provider: string;
  run: () => Promise<T>;
}

type Verdict = { retry: boolean; status?: number; retryAfterMs?: number; throttled: boolean };

/** 429 / 403 / 5xx / timeouts / connection resets are transient; everything else (4xx, bad data, replay miss) is not. */
export function classify(err: unknown): Verdict {
  const e = err as {
    name?: string;
    code?: string;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    response?: { status?: number; headers?: Record<string, unknown> };
  };
  if (e?.name === 'ReplayMissError') return { retry: false, throttled: false };
  const status = e?.status ?? e?.response?.status;
  let retryAfterMs = e?.retryAfterMs;
  const ra = e?.response?.headers?.['retry-after'];
  if (retryAfterMs === undefined && ra !== undefined) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
  }
  const throttled = status === 429 || status === 403;
  if (e?.retryable !== undefined) return { retry: e.retryable, status, retryAfterMs, throttled };
  if (status !== undefined) return { retry: throttled || status === 408 || status >= 500, status, retryAfterMs, throttled };
  const net = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_NETWORK'];
  return { retry: !!e?.code && net.includes(e.code), retryAfterMs, throttled: false };
}

class Breaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trial = false;
  constructor(private policy: BreakerPolicy, private now: () => number) {}

  /** closed: yes; open: no until the cooldown passes; then exactly one half-open trial */
  allow(): boolean {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt < this.policy.cooldownMs) return false;
    if (this.trial) return false;
    this.trial = true;
    return true;
  }
  success() {
    this.failures = 0;
    this.openedAt = null;
    this.trial = false;
  }
  /** returns true when this failure (re)opens the circuit */
  failure(): boolean {
    this.failures++;
    if (this.trial || this.failures >= this.policy.failureThreshold) {
      const wasClosed = this.openedAt === null;
      this.openedAt = this.now();
      this.trial = false;
      return wasClosed;
    }
    return false;
  }
  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.policy.cooldownMs ? 'half-open' : 'open';
  }
}

/**
 * Provider guard (plan B3): one place that makes free-tier providers safe to call.
 *  - token-bucket limiter per provider (bottleneck)
 *  - retries with exponential backoff and full jitter on 429/403/5xx, bounded, honouring Retry-After
 *  - circuit breaker per provider that fails over to the next (backup) provider
 *  - daily call budget per provider (fails over when spent)
 *  - cache: confirmed chain data forever, account metadata one hour (see cache.ts TTLs)
 */
export class ProviderGuard {
  readonly cache: Cache;
  private limits: Record<string, ProviderLimit>;
  private retry: RetryPolicy;
  private breakerPolicy: BreakerPolicy;
  private limiters = new Map<string, Bottleneck>();
  private breakers = new Map<string, Breaker>();
  private stat = new Map<string, ProviderStats>();
  private cacheStat: CacheStats = { hits: 0, misses: 0 };
  private inflight = new Map<string, Promise<unknown>>();
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private now: () => number;
  private unlimited: boolean;

  constructor(opts: GuardOptions = {}) {
    this.cache = opts.cache ?? new MemoryCache();
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.breakerPolicy = { ...DEFAULT_BREAKER, ...opts.breaker };
    this.unlimited = opts.unlimited ?? false;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  private limiter(provider: string): Bottleneck | null {
    if (this.unlimited) return null;
    let l = this.limiters.get(provider);
    if (!l) {
      const lim = this.limits[provider] ?? FALLBACK_LIMIT;
      l = new Bottleneck(
        lim.rps >= 1
          ? { maxConcurrent: lim.maxConcurrent, reservoir: Math.floor(lim.rps), reservoirRefreshAmount: Math.floor(lim.rps), reservoirRefreshInterval: 1000 }
          : { maxConcurrent: lim.maxConcurrent, minTime: Math.ceil(1000 / lim.rps) },
      );
      this.limiters.set(provider, l);
    }
    return l;
  }
  private breaker(provider: string) {
    let b = this.breakers.get(provider);
    if (!b) this.breakers.set(provider, (b = new Breaker(this.breakerPolicy, this.now)));
    return b;
  }
  private s(provider: string): ProviderStats {
    let s = this.stat.get(provider);
    if (!s) this.stat.set(provider, (s = { calls: 0, retries: 0, throttled: 0, failures: 0, failovers: 0, circuitOpens: 0, quotaSkips: 0 }));
    return s;
  }

  stats(): { providers: Record<string, ProviderStats & { circuit: string }>; cache: CacheStats & { hitRate: number } } {
    const providers: Record<string, ProviderStats & { circuit: string }> = {};
    for (const [k, v] of this.stat) providers[k] = { ...v, circuit: this.breaker(k).state };
    const total = this.cacheStat.hits + this.cacheStat.misses;
    return { providers, cache: { ...this.cacheStat, hitRate: total ? this.cacheStat.hits / total : 0 } };
  }

  /** Waits before retry `attempt` (1-based): full jitter over the exponential ceiling, never shorter than Retry-After. */
  private delay(attempt: number, retryAfterMs?: number): number {
    const ceiling = Math.min(this.retry.maxMs, this.retry.baseMs * this.retry.factor ** (attempt - 1));
    const jittered = this.random() * ceiling;
    return retryAfterMs !== undefined ? Math.max(jittered, Math.min(retryAfterMs, this.retry.maxRetryAfterMs)) : jittered;
  }

  private async withinBudget(provider: string): Promise<boolean> {
    const budget = (this.limits[provider] ?? FALLBACK_LIMIT).dailyBudget;
    if (!budget) return true;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const used = await this.cache.incr(`quota:${provider}:${day}`, 2 * 86400);
    return used === 0 || used <= budget; // 0 = counter unavailable (cache down): do not block on it
  }

  /**
   * Runs the steps in order (primary first, then backups) and returns the first success. Each provider gets
   * bounded retries; a provider whose circuit is open or whose daily budget is spent is skipped.
   * Never throws a raw provider error: exhaustion raises ProviderUnavailableError.
   */
  async call<T>(steps: Step<T>[]): Promise<T> {
    const causes: { provider: string; error: unknown }[] = [];
    for (let i = 0; i < steps.length; i++) {
      const { provider, run } = steps[i];
      const stats = this.s(provider);
      const breaker = this.breaker(provider);
      if (!breaker.allow()) {
        causes.push({ provider, error: new Error('circuit open') });
        stats.failovers++;
        continue;
      }
      if (!(await this.withinBudget(provider))) {
        stats.quotaSkips++;
        stats.failovers++;
        causes.push({ provider, error: new Error('daily budget exhausted') });
        continue;
      }
      for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
        stats.calls++;
        try {
          const limiter = this.limiter(provider);
          const result = await (limiter ? limiter.schedule(run) : run());
          breaker.success();
          return result;
        } catch (error) {
          const v = classify(error);
          if (v.throttled) stats.throttled++;
          if (!v.retry) {
            causes.push({ provider, error }); // a hard failure (4xx, bad data): move on, do not trip the breaker
            stats.failovers++;
            break;
          }
          stats.failures++;
          if (breaker.failure()) stats.circuitOpens++;
          if (attempt === this.retry.attempts) {
            causes.push({ provider, error });
            stats.failovers++;
            break;
          }
          if (breaker.state === 'open') {
            causes.push({ provider, error });
            stats.failovers++;
            break; // the circuit just opened: stop hammering this provider
          }
          stats.retries++;
          await this.sleep(this.delay(attempt, v.retryAfterMs));
        }
      }
    }
    // a single provider that gave a definitive, non-transient answer (e.g. 404) is surfaced as-is
    if (steps.length === 1 && causes.length === 1 && classify(causes[0].error).retry === false && !(causes[0].error as Error)?.message?.match(/^(circuit open|daily budget exhausted)$/)) {
      throw causes[0].error;
    }
    throw new ProviderUnavailableError(
      `all providers failed: ${causes.map((c) => `${c.provider}: ${(c.error as Error)?.message ?? c.error}`).join('; ')}`,
      causes,
    );
  }

  /** Cache read that counts toward the hit rate; undefined on a miss. For callers that cache below the guard. */
  async peek<T>(key: string): Promise<T | undefined> {
    const hit = await this.cache.get(key);
    if (hit !== null) {
      this.cacheStat.hits++;
      return JSON.parse(hit) as T;
    }
    this.cacheStat.misses++;
    return undefined;
  }

  async remember(key: string, value: unknown, ttlSeconds: number | null): Promise<void> {
    await this.cache.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Cache-aside with in-process de-duplication of concurrent identical requests. ttlSeconds null = forever. */
  async cached<T>(key: string, ttlSeconds: number | null, compute: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get(key);
    if (hit !== null) {
      this.cacheStat.hits++;
      return JSON.parse(hit) as T;
    }
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    this.cacheStat.misses++;
    const p = (async () => {
      try {
        const value = await compute();
        await this.cache.set(key, JSON.stringify(value), ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

export { ProviderHttpError };
