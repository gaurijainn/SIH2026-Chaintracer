import { PrismaClient } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import neo4j from 'neo4j-driver';
import {
  QUEUES,
  TRACE_QUEUE_DEFAULT,
  TRACE_QUEUE_TRON,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
  loadEnv,
} from '@ps26183/shared';
import { RedisCache, createChainLayer } from '../adapters/index';
import { redisEventPublisher } from '../trace/events';
import { runTrace, type TraceJobRow } from '../trace/engine';
import { writeGraphHops } from '../trace/graphWrite';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// One queue per pipeline stage; processors are attached by the steps that own them (B2-B4, B8, B9).
const queues = QUEUES.map((name) => new Queue(name, { connection }));

// `system` queue: proves BullMQ round-trips end to end (used by the smoke test and health).
const system = new Worker('system', async (job) => ({ pong: job.data?.ts ?? null }), { connection });
system.on('error', (e) => console.error('system worker error', e));

// --- B4: multi-hop tracing engine ---
const prisma = new PrismaClient();
const neo4jDriver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
const chainLayer = createChainLayer({ env, cache: new RedisCache(env.REDIS_URL) });
const publish = redisEventPublisher(publisher);

// findUniqueOrThrow narrows Decimal fields to the plain shape TracePrisma expects; the real Prisma
// client already satisfies that interface structurally (see workers/trace/engine.ts).
const tracePrisma = {
  traceJob: {
    findUniqueOrThrow: (args: { where: { id: string } }) => prisma.traceJob.findUniqueOrThrow(args) as unknown as Promise<TraceJobRow>,
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => prisma.traceJob.update(args as never),
  },
  hop: {
    createMany: (args: { data: unknown[]; skipDuplicates: true }) => prisma.hop.createMany(args as never),
    count: (args: { where: { traceId: string } }) => prisma.hop.count(args),
  },
  label: {
    findFirst: (args: { where: { chain: string; addr: string; category: { in: string[] } } }) =>
      prisma.label.findFirst({ where: args.where, select: { category: true, name: true } }),
  },
};

async function processTraceJob(job: Job) {
  await runTrace(job.data.traceId as string, {
    prisma: tracePrisma,
    chainLayer,
    writeGraphHops: (hops) => writeGraphHops(neo4jDriver, hops),
    publish,
    topK: env.TRACE_TOP_K,
    highDegreeCutoff: env.HIGH_DEGREE_CUTOFF,
  }, { attempt: { made: job.attemptsMade, max: job.opts.attempts ?? 1 } });
}

const traceTron = new Worker(TRACE_QUEUE_TRON, processTraceJob, { connection, concurrency: 2 });
const traceOther = new Worker(TRACE_QUEUE_DEFAULT, processTraceJob, { connection, concurrency: 2 });
traceTron.on('error', (e) => console.error('trace-tron worker error', e));
traceOther.on('error', (e) => console.error('trace worker error', e));

const beat = () =>
  connection.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: Date.now(), queues: QUEUES }), 'EX', WORKER_HEARTBEAT_TTL_S);
await beat();
const timer = setInterval(() => void beat().catch((e) => console.error('heartbeat failed', e)), 5000);
console.log(`workers up (DATA_MODE=${env.DATA_MODE}) queues: ${QUEUES.join(', ')}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await system.close();
    await traceTron.close();
    await traceOther.close();
    await Promise.all(queues.map((q) => q.close()));
    await neo4jDriver.close();
    await prisma.$disconnect();
    connection.disconnect();
    publisher.disconnect();
    process.exit(0);
  });
}
