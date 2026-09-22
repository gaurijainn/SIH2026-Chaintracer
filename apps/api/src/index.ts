import { RedisCache, createChainLayer } from '@ps26183/workers/adapters';
import { loadEnv } from '@ps26183/shared';
import { createApp } from './app';
import { buildDeps } from './deps';
import { createPrisma } from './db/prisma';
import { NcrpPoller, createHttpNcrpFeed } from './intake/ncrp';
import { createAdapterProbe } from './intake/probe';
import { BullTraceQueue } from './intake/queue';
import { createIntakeService } from './intake/service';
import { attachTraceSocket } from './realtime/socket';

const env = loadEnv();
const { deps, close } = buildDeps(env);

const prisma = createPrisma();
const queue = new BullTraceQueue(env.REDIS_URL);
const providers = createChainLayer({ env, cache: new RedisCache(env.REDIS_URL), pricing: false });
const intake = createIntakeService({
  prisma,
  queue,
  probe: createAdapterProbe(providers),
  defaults: { maxHops: env.TRACE_MAX_HOPS, minValueUsd: env.TRACE_MIN_USD, windowDays: env.TRACE_WINDOW_DAYS, taintModel: 'HAIRCUT' },
});
const poller = new NcrpPoller(createHttpNcrpFeed(env), intake, env.NCRP_POLL_INTERVAL_S * 1000);

const server = createApp(deps, { intake }).listen(env.API_PORT, () => {
  console.log(`api listening on :${env.API_PORT} (DATA_MODE=${env.DATA_MODE})`);
  poller.start();
});
const trace = attachTraceSocket(server, env.REDIS_URL);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    poller.stop();
    server.close(() => void Promise.all([close(), queue.close(), prisma.$disconnect(), trace.close()]).then(() => process.exit(0)));
  });
}
