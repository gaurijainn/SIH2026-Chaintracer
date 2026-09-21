import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_S, loadEnv } from '@ps26183/shared';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// One queue per pipeline stage; processors are attached by the steps that own them (B2-B4, B8, B9).
const queues = QUEUES.map((name) => new Queue(name, { connection }));

// `system` queue: proves BullMQ round-trips end to end (used by the smoke test and health).
const system = new Worker('system', async (job) => ({ pong: job.data?.ts ?? null }), { connection });
system.on('error', (e) => console.error('system worker error', e));

const beat = () =>
  connection.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: Date.now(), queues: QUEUES }), 'EX', WORKER_HEARTBEAT_TTL_S);
await beat();
const timer = setInterval(() => void beat().catch((e) => console.error('heartbeat failed', e)), 5000);
console.log(`workers up (DATA_MODE=${env.DATA_MODE}) queues: ${QUEUES.join(', ')}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await system.close();
    await Promise.all(queues.map((q) => q.close()));
    connection.disconnect();
    process.exit(0);
  });
}
