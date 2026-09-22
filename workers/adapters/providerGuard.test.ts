import { describe, expect, it } from 'vitest';
import { MemoryCache } from './cache';
import { ProviderHttpError, ProviderUnavailableError } from './errors';
import { ProviderGuard, classify } from './providerGuard';

const httpErr = (status: number, extra: Partial<ProviderHttpError> = {}) => Object.assign(new ProviderHttpError(`http ${status}`, 'p', status), extra);
const axiosLike = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error(`status ${status}`), { response: { status, headers } });

/** guard with recorded (not real) sleeping and a fixed jitter source */
function makeGuard(over: ConstructorParameters<typeof ProviderGuard>[0] = {}) {
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const guard = new ProviderGuard({
    unlimited: true,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1, // full jitter at its ceiling => delays are the exponential ceilings
    now: () => clock,
    ...over,
  });
  return { guard, sleeps, advance: (ms: number) => (clock += ms) };
}

/** a provider function that fails with the given errors in order, then succeeds */
const failing = (errors: unknown[], value = 'ok') => {
  let n = 0;
  return Object.assign(async () => {
    if (n < errors.length) throw errors[n++];
    n++;
    return value;
  }, { calls: () => n });
};

describe('classify: which failures are transient', () => {
  it.each([[429, true], [403, true], [408, true], [500, true], [502, true], [503, true], [400, false], [401, false], [404, false], [422, false]])(
    'HTTP %i -> retry=%s',
    (status, retry) => expect(classify(axiosLike(status)).retry).toBe(retry),
  );
  it('retries connection resets and timeouts, not unknown or replay-miss errors', () => {
    expect(classify(Object.assign(new Error('x'), { code: 'ECONNRESET' })).retry).toBe(true);
    expect(classify(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).retry).toBe(true);
    expect(classify(new Error('parse error')).retry).toBe(false);
    expect(classify(Object.assign(new Error('missing'), { name: 'ReplayMissError' })).retry).toBe(false);
  });
  it('reads Retry-After from headers and honours an explicit retryable flag', () => {
    expect(classify(axiosLike(429, { 'retry-after': '3' })).retryAfterMs).toBe(3000);
    expect(classify(httpErr(200, { retryable: true })).retry).toBe(true); // rate-limit message inside an HTTP 200
  });
});

describe('retries with exponential backoff and jitter', () => {
  it('recovers from a burst of 429/403/5xx and waits 400, 800, 1600 ms (ceilings) between tries', async () => {
    const { guard, sleeps } = makeGuard();
    const run = failing([axiosLike(429), axiosLike(403), axiosLike(503)]);
    expect(await guard.call([{ provider: 'p', run }])).toBe('ok');
    expect(run.calls()).toBe(4);
    expect(sleeps).toEqual([400, 800, 1600]);
    expect(guard.stats().providers.p).toMatchObject({ retries: 3, throttled: 2, failures: 3 });
  });

  it('applies full jitter: every delay is between 0 and the exponential ceiling', async () => {
    const { guard, sleeps } = makeGuard({ random: () => 0.5 });
    await guard.call([{ provider: 'p', run: failing([axiosLike(500), axiosLike(500), axiosLike(500), axiosLike(500)]) }]);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
  });

  it('caps the backoff at maxMs', async () => {
    const { guard, sleeps } = makeGuard({ retry: { attempts: 8, baseMs: 1000, maxMs: 3000 } });
    await guard.call([{ provider: 'p', run: failing(Array(6).fill(axiosLike(503))) }]);
    expect(Math.max(...sleeps)).toBe(3000);
  });

  it('honours Retry-After (bounded by maxRetryAfterMs)', async () => {
    const { guard, sleeps } = makeGuard({ random: () => 0 });
    await guard.call([{ provider: 'p', run: failing([axiosLike(429, { 'retry-after': '2' }), axiosLike(429, { 'retry-after': '3600' })]) }]);
    expect(sleeps).toEqual([2000, 10_000]);
  });

  it('is bounded: gives up after `attempts` tries and reports ProviderUnavailableError, never a raw 429', async () => {
    const { guard, sleeps } = makeGuard({ retry: { attempts: 4 } });
    const run = failing(Array(100).fill(axiosLike(429)));
    const err = await guard.call([{ provider: 'p', run }]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).not.toBe('status 429');
    expect(run.calls()).toBe(4);
    expect(sleeps).toHaveLength(3); // no sleep after the final attempt
  });

  it('does not retry definitive failures (404 / 400 / bad data) and surfaces them as-is', async () => {
    const { guard, sleeps } = makeGuard();
    const notFound = axiosLike(404);
    const run = failing([notFound]);
    await expect(guard.call([{ provider: 'p', run }])).rejects.toBe(notFound);
    expect(run.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('circuit breaker and failover to the backup provider', () => {
  it('moves on to the backup as soon as the primary exhausts its retries', async () => {
    const { guard } = makeGuard({ retry: { attempts: 2 } });
    const primary = failing(Array(10).fill(axiosLike(503)));
    const backup = failing([], 'from backup');
    expect(await guard.call([{ provider: 'primary', run: primary }, { provider: 'backup', run: backup }])).toBe('from backup');
    expect(guard.stats().providers.primary.failovers).toBe(1);
  });

  it('opens the circuit after N consecutive failures and then skips the primary without calling it', async () => {
    const { guard } = makeGuard({ retry: { attempts: 2 }, breaker: { failureThreshold: 4, cooldownMs: 30_000 } });
    const primary = failing(Array(100).fill(axiosLike(503)));
    const backup = failing([], 'B');
    const steps = [{ provider: 'primary', run: primary }, { provider: 'backup', run: backup }];
    await guard.call(steps); // 2 failures
    await guard.call(steps); // 2 more -> circuit opens
    expect(guard.stats().providers.primary).toMatchObject({ circuit: 'open', circuitOpens: 1 });
    const before = primary.calls();
    for (let i = 0; i < 5; i++) expect(await guard.call(steps)).toBe('B');
    expect(primary.calls()).toBe(before); // fast-failed: the struggling provider is left alone
  });

  it('half-opens after the cooldown, allows one trial, and closes again on success', async () => {
    const { guard, advance } = makeGuard({ retry: { attempts: 1 }, breaker: { failureThreshold: 2, cooldownMs: 30_000 } });
    let healthy = false;
    const primary = async () => {
      if (!healthy) throw axiosLike(503);
      return 'P';
    };
    const steps = [{ provider: 'primary', run: primary }, { provider: 'backup', run: async () => 'B' }];
    await guard.call(steps);
    await guard.call(steps);
    expect(guard.stats().providers.primary.circuit).toBe('open');
    advance(31_000);
    healthy = true;
    expect(guard.stats().providers.primary.circuit).toBe('half-open');
    expect(await guard.call(steps)).toBe('P'); // the trial goes to the primary and succeeds
    expect(guard.stats().providers.primary.circuit).toBe('closed');
  });

  it('a failed half-open trial reopens the circuit for another cooldown', async () => {
    const { guard, advance } = makeGuard({ retry: { attempts: 1 }, breaker: { failureThreshold: 1, cooldownMs: 1000 } });
    const primary = failing(Array(10).fill(axiosLike(503)));
    const steps = [{ provider: 'primary', run: primary }, { provider: 'backup', run: async () => 'B' }];
    await guard.call(steps);
    advance(1500);
    await guard.call(steps); // trial fails
    expect(guard.stats().providers.primary.circuit).toBe('open');
  });

  it('definitive 4xx answers do not trip the breaker', async () => {
    const { guard } = makeGuard({ breaker: { failureThreshold: 2 } });
    for (let i = 0; i < 6; i++) await guard.call([{ provider: 'p', run: failing([axiosLike(404)]) }, { provider: 'q', run: async () => 'x' }]);
    expect(guard.stats().providers.p.circuit).toBe('closed');
  });

  it('reports every provider when all of them fail', async () => {
    const { guard } = makeGuard({ retry: { attempts: 1 } });
    const err = (await guard.call([{ provider: 'a', run: failing([axiosLike(503)]) }, { provider: 'b', run: failing([axiosLike(500)]) }]).catch((e) => e)) as ProviderUnavailableError;
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.causes.map((c) => c.provider)).toEqual(['a', 'b']);
  });
});

describe('daily quota budget', () => {
  it('skips a provider whose daily budget is spent and uses the backup', async () => {
    const { guard } = makeGuard({ limits: { primary: { rps: 100, maxConcurrent: 5, dailyBudget: 3 } } });
    const steps = [{ provider: 'primary', run: async () => 'P' }, { provider: 'backup', run: async () => 'B' }];
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await guard.call(steps));
    expect(results).toEqual(['P', 'P', 'P', 'B', 'B']);
    expect(guard.stats().providers.primary.quotaSkips).toBe(2);
  });
  it('starts a fresh budget on the next UTC day', async () => {
    const { guard, advance } = makeGuard({ limits: { primary: { rps: 100, maxConcurrent: 5, dailyBudget: 1 } } });
    const steps = [{ provider: 'primary', run: async () => 'P' }, { provider: 'backup', run: async () => 'B' }];
    expect(await guard.call(steps)).toBe('P');
    expect(await guard.call(steps)).toBe('B');
    advance(86_400_000 + 1000);
    expect(await guard.call(steps)).toBe('P');
  });
});

describe('cache: confirmed data forever, metadata for an hour', () => {
  it('serves a repeat from cache without calling the provider', async () => {
    const { guard } = makeGuard();
    let calls = 0;
    const compute = async () => (calls++, { v: 1 });
    expect(await guard.cached('k', null, compute)).toEqual({ v: 1 });
    expect(await guard.cached('k', null, compute)).toEqual({ v: 1 });
    expect(calls).toBe(1);
    expect(guard.stats().cache).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 });
  });

  it('expires ttl entries after their lifetime but keeps forever entries', async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    const { guard } = makeGuard({ cache });
    let meta = 0;
    let tx = 0;
    await guard.cached('meta', 3600, async () => ++meta);
    await guard.cached('tx', null, async () => ++tx);
    now = 3599_000;
    await guard.cached('meta', 3600, async () => ++meta);
    expect(meta).toBe(1);
    now = 3601_000;
    await guard.cached('meta', 3600, async () => ++meta);
    await guard.cached('tx', null, async () => ++tx);
    expect(meta).toBe(2); // one hour later: refetched
    expect(tx).toBe(1); // confirmed data: never refetched
  });

  it('collapses concurrent identical requests into one provider call', async () => {
    const { guard } = makeGuard();
    let calls = 0;
    const slow = async () => (calls++, await new Promise((r) => setTimeout(r, 20)), 'v');
    expect(await Promise.all([1, 2, 3, 4].map(() => guard.cached('same', null, slow)))).toEqual(['v', 'v', 'v', 'v']);
    expect(calls).toBe(1);
  });

  it('does not cache failures', async () => {
    const { guard } = makeGuard();
    let n = 0;
    const flaky = async () => {
      if (n++ === 0) throw new Error('boom');
      return 'ok';
    };
    await expect(guard.cached('f', null, flaky)).rejects.toThrow('boom');
    expect(await guard.cached('f', null, flaky)).toBe('ok');
  });

  it('keeps working when the cache backend is down (fail-open)', async () => {
    const dead = { get: async () => null, set: async () => undefined, incr: async () => 0 };
    const { guard } = makeGuard({ cache: dead });
    expect(await guard.cached('x', null, async () => 7)).toBe(7);
    // an unavailable quota counter (0) must not block calls
    const g2 = makeGuard({ cache: dead, limits: { p: { rps: 10, maxConcurrent: 1, dailyBudget: 1 } } }).guard;
    expect(await g2.call([{ provider: 'p', run: async () => 'ok' }])).toBe('ok');
  });
});

describe('token-bucket limiter (bottleneck)', () => {
  it('never exceeds maxConcurrent in-flight requests to a provider', async () => {
    const guard = new ProviderGuard({ limits: { p: { rps: 1000, maxConcurrent: 2 } } });
    let running = 0;
    let peak = 0;
    const run = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return 1;
    };
    await Promise.all(Array.from({ length: 12 }, () => guard.call([{ provider: 'p', run }])));
    expect(peak).toBe(2);
  });

  it('spreads a burst over time: at most `rps` requests per second, no uncontrolled bursts', async () => {
    const guard = new ProviderGuard({ limits: { p: { rps: 10, maxConcurrent: 10 } } });
    const stamps: number[] = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 15 }, () => guard.call([{ provider: 'p', run: async () => void stamps.push(Date.now() - t0) }])));
    expect(stamps.filter((t) => t < 500)).toHaveLength(10); // the bucket allows 10 straight away
    expect(Math.max(...stamps)).toBeGreaterThanOrEqual(900); // the other 5 wait for the refill
  });
});
