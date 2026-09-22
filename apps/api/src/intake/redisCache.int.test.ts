import { afterAll, describe, expect, it } from 'vitest';
import { RedisCache } from '@ps26183/workers/adapters';
import { loadEnv } from '@ps26183/shared';

const url = loadEnv().REDIS_URL;
const prefix = `test-b3-${Date.now()}:`;
const opened: RedisCache[] = [];
const open = (u = url) => {
  const c = new RedisCache(u, prefix);
  opened.push(c);
  return c;
};
afterAll(async () => {
  for (const c of opened) await c.close();
});

describe('RedisCache (real Redis)', () => {
  it('many concurrent first calls all succeed: one shared connect, no fail-open window at startup', async () => {
    const c = open();
    await Promise.all(Array.from({ length: 30 }, (_, i) => c.set(`k${i}`, String(i), null)));
    const got = await Promise.all(Array.from({ length: 30 }, (_, i) => c.get(`k${i}`)));
    expect(got).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
  });

  it('honours TTLs: an hour-style entry expires, a forever entry does not', async () => {
    const c = open();
    await c.set('short', 'x', 1);
    await c.set('forever', 'y', null);
    expect(await c.get('short')).toBe('x');
    await new Promise((r) => setTimeout(r, 1300));
    expect(await c.get('short')).toBeNull();
    expect(await c.get('forever')).toBe('y');
  });

  it('counts daily quota atomically', async () => {
    const c = open();
    const counts = await Promise.all(Array.from({ length: 10 }, () => c.incr('quota:test', 60)));
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('fails open when Redis is unreachable: reads miss, writes do not throw, and it does not stall', async () => {
    const c = open('redis://127.0.0.1:1');
    const t0 = Date.now();
    expect(await c.get('x')).toBeNull();
    await expect(c.set('x', 'y', null)).resolves.toBeUndefined();
    expect(await c.incr('q', 60)).toBe(0); // 0 = counter unavailable; the guard treats it as "do not block"
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});
