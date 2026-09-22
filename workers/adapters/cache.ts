import { Redis } from 'ioredis';

/** Cache lifetime policy from the plan: confirmed chain data forever, account metadata one hour. */
export const TTL_FOREVER = null;
export const TTL_ACCOUNT_META_S = 3600;

export interface Cache {
  get(key: string): Promise<string | null>;
  /** ttlSeconds null = never expires */
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  /** atomic counter used for per-provider daily quota accounting */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export class MemoryCache implements Cache {
  private store = new Map<string, { v: string; exp: number | null }>();
  private counters = new Map<string, { n: number; exp: number }>();
  constructor(private now: () => number = Date.now) {}

  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.exp !== null && e.exp <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, value: string, ttl: number | null) {
    this.store.set(key, { v: value, exp: ttl === null ? null : this.now() + ttl * 1000 });
  }
  async incr(key: string, ttl: number) {
    const c = this.counters.get(key);
    if (!c || c.exp <= this.now()) {
      this.counters.set(key, { n: 1, exp: this.now() + ttl * 1000 });
      return 1;
    }
    return ++c.n;
  }
  get size() {
    return this.store.size;
  }
}

/**
 * Redis-backed cache. It fails open: if Redis is unreachable the provider layer keeps working
 * (uncached), and the outage is not retried on every call (a 10 s back-off keeps calls fast).
 */
export class RedisCache implements Cache {
  private redis: Redis;
  private downUntil = 0;

  constructor(url: string, private prefix = 'prov:', private now: () => number = Date.now) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, lazyConnect: true });
    this.redis.on('error', () => undefined);
  }

  private connecting: Promise<void> | null = null;

  /** One shared connect attempt: concurrent first callers wait for the same 'ready' instead of failing open. */
  private ensureReady(): Promise<void> {
    if (this.redis.status === 'ready') return Promise.resolve();
    this.connecting ??= (async () => {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect().catch(() => undefined);
      if (this.redis.status !== 'ready') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('redis not ready')), 2500);
          this.redis.once('ready', () => (clearTimeout(timer), resolve()));
        });
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async guard<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    if (this.now() < this.downUntil) return fallback;
    try {
      await this.ensureReady();
      return await fn();
    } catch {
      this.downUntil = this.now() + 10_000;
      return fallback;
    }
  }

  get(key: string) {
    return this.guard<string | null>(null, () => this.redis.get(this.prefix + key));
  }
  async set(key: string, value: string, ttl: number | null) {
    await this.guard(undefined, async () => {
      if (ttl === null) await this.redis.set(this.prefix + key, value);
      else await this.redis.set(this.prefix + key, value, 'EX', ttl);
    });
  }
  incr(key: string, ttl: number) {
    return this.guard(0, async () => {
      const k = this.prefix + key;
      const n = await this.redis.incr(k);
      if (n === 1) await this.redis.expire(k, ttl);
      return n;
    });
  }
  async close() {
    this.redis.disconnect();
  }
}
