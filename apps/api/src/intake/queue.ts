import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { TRACE_PRIORITY, TRACE_QUEUE_DEFAULT, TRACE_QUEUE_TRON, type Chain } from '@ps26183/shared';

/** What B4's trace worker will receive. B2 only prepares and enqueues it; nothing here walks the graph. */
export interface TraceJobPayload {
  traceId: string;
  caseId: string;
  chain: Chain;
  seed: string;
  /** Official stablecoin contract pre-selected for the chain (USDT-TRC20 for TRON); null if none is whitelisted. */
  token: string | null;
  options: { maxHops: number; minValueUsd: number; windowDays: number; taintModel: 'HAIRCUT' | 'FIFO' };
  source: 'intake';
}

export interface TraceQueue {
  /** Enqueues jobs, TRON first. Idempotent: the job id is derived from the TraceJob row id. Returns queued count. */
  enqueue(jobs: TraceJobPayload[]): Promise<number>;
  close(): Promise<void>;
}

export const traceJobId = (traceId: string) => `trace_${traceId}`; // BullMQ ids cannot contain ':'

export class BullTraceQueue implements TraceQueue {
  private redis: Redis;
  private tron: Queue;
  private other: Queue;

  constructor(redisUrl: string, prefix?: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.redis.on('error', () => undefined);
    const opts = { connection: this.redis, ...(prefix ? { prefix } : {}) };
    this.tron = new Queue(TRACE_QUEUE_TRON, opts);
    this.other = new Queue(TRACE_QUEUE_DEFAULT, opts);
  }

  private add(q: Queue, jobs: TraceJobPayload[]) {
    return q.addBulk(
      jobs.map((j) => ({
        name: `trace.${j.chain}`,
        data: j,
        opts: {
          jobId: traceJobId(j.traceId),
          priority: TRACE_PRIORITY[j.chain],
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
        },
      })),
    );
  }

  async enqueue(jobs: TraceJobPayload[]): Promise<number> {
    const tron = jobs.filter((j) => j.chain === 'TRON');
    const rest = jobs.filter((j) => j.chain !== 'TRON');
    const deadline = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('trace queue unavailable (redis timeout)')), 5000).unref())]);
    if (tron.length) await deadline(this.add(this.tron, tron)); // TRON fast path is enqueued before anything else
    if (rest.length) await deadline(this.add(this.other, rest));
    return jobs.length;
  }

  /** Test/ops helper. */
  get queues() {
    return { tron: this.tron, other: this.other };
  }

  async close() {
    await Promise.all([this.tron.close(), this.other.close()]);
    this.redis.disconnect();
  }
}
