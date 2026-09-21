import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USDT_ERC20, USDT_TRC20, loadEnv, type Chain } from '@ps26183/shared';
import { BullTraceQueue, traceJobId, type TraceJobPayload } from './queue';

const prefix = `test-b2-${Date.now()}`;
let q: BullTraceQueue;

const job = (n: number, chain: Chain, token: string | null): TraceJobPayload => ({
  traceId: `t${prefix}-${n}`,
  caseId: 'case-1',
  chain,
  seed: `seed-${n}`,
  token,
  options: { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' },
  source: 'intake',
});

beforeAll(() => {
  q = new BullTraceQueue(loadEnv().REDIS_URL, prefix);
});
afterAll(async () => {
  await Promise.all([q.queues.tron.obliterate({ force: true }), q.queues.other.obliterate({ force: true })]);
  await q.close();
});

describe('BullTraceQueue (real Redis)', () => {
  const jobs = [job(1, 'BTC', null), job(2, 'ETH', USDT_ERC20), job(3, 'TRON', USDT_TRC20), job(4, 'TRON', USDT_TRC20)];

  it('sends TRON seeds to their own trace-tron queue and everything else to trace', async () => {
    expect(await q.enqueue(jobs)).toBe(4);
    expect(q.queues.tron.name).toBe('trace-tron');
    expect(q.queues.other.name).toBe('trace');
    const tron = await q.queues.tron.getJobs(['waiting', 'prioritized'], 0, 10);
    const other = await q.queues.other.getJobs(['waiting', 'prioritized'], 0, 10);
    expect(tron.map((j) => j.data.chain)).toEqual(['TRON', 'TRON']);
    expect(other.map((j) => j.data.chain).sort()).toEqual(['BTC', 'ETH']);
  });

  it('pre-selects the official token and carries the trace options in the payload', async () => {
    const tron = await q.queues.tron.getJobs(['waiting', 'prioritized'], 0, 10);
    expect(tron.every((j) => j.data.token === USDT_TRC20 && j.data.options.maxHops === 6)).toBe(true);
    expect(tron[0].name).toBe('trace.TRON');
  });

  it('gives TRON the highest priority and adds TRON jobs before the others', async () => {
    const tron = await q.queues.tron.getJobs(['waiting', 'prioritized'], 0, 10);
    const other = await q.queues.other.getJobs(['waiting', 'prioritized'], 0, 10);
    expect(tron.every((j) => j.opts.priority === 1)).toBe(true);
    expect(Math.min(...other.map((j) => j.opts.priority ?? 99))).toBeGreaterThan(1);
    expect(Math.max(...tron.map((j) => j.timestamp))).toBeLessThanOrEqual(Math.min(...other.map((j) => j.timestamp)));
  });

  it('is idempotent: enqueueing the same trace jobs again adds nothing', async () => {
    await q.enqueue(jobs);
    await q.enqueue(jobs);
    const counts = async (queue: typeof q.queues.tron) => (await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active')) as Record<string, number>;
    const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    expect(sum(await counts(q.queues.tron))).toBe(2);
    expect(sum(await counts(q.queues.other))).toBe(2);
    expect(await q.queues.tron.getJob(traceJobId(jobs[2].traceId))).toBeTruthy();
  });
});
