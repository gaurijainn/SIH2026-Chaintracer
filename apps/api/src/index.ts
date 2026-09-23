import { RedisCache, createChainLayer } from '@ps26183/workers/adapters';
import { loadEnv } from '@ps26183/shared';
import { AlertService } from './alerts/service';
import { createApp } from './app';
import { AuditService } from './audit/service';
import { buildDeps } from './deps';
import { createPrisma } from './db/prisma';
import { FreezeNoticeService } from './freeze-notices/service';
import { createDriver } from './graph/graph';
import { createNcrpNoticeAdapter } from './integrations/ncrpNoticeAdapter';
import { createSahyogAdapter } from './integrations/sahyogAdapter';
import { NcrpPoller, createHttpNcrpFeed } from './intake/ncrp';
import { createAdapterProbe } from './intake/probe';
import { BullTraceQueue } from './intake/queue';
import { createIntakeService } from './intake/service';
import { MuleService } from './mule/service';
import { attachTraceSocket } from './realtime/socket';
import { ReportService } from './reports/service';
import { HttpMlClient } from './risk/mlClient';
import { RiskService } from './risk/service';
import { WatchlistService } from './watchlist/service';

const env = loadEnv();
const { deps, close } = buildDeps(env);

const prisma = createPrisma();
const muleDriver = createDriver(env);
const queue = new BullTraceQueue(env.REDIS_URL);
const providers = createChainLayer({ env, cache: new RedisCache(env.REDIS_URL), pricing: false });
const intake = createIntakeService({
  prisma,
  queue,
  probe: createAdapterProbe(providers),
  defaults: { maxHops: env.TRACE_MAX_HOPS, minValueUsd: env.TRACE_MIN_USD, windowDays: env.TRACE_WINDOW_DAYS, taintModel: 'HAIRCUT' },
});
const mule = new MuleService({ prisma, driver: muleDriver });
const mlClient = new HttpMlClient(env.ML_URL);
const risk = new RiskService({ prisma, mlClient });
const watchlist = new WatchlistService({ prisma });
const alerts = new AlertService({ prisma });
const poller = new NcrpPoller(createHttpNcrpFeed(env), intake, env.NCRP_POLL_INTERVAL_S * 1000);

// B9: evidence reports, freeze-notice workflow, and outbound SAHYOG/NCRP-notice adapters.
const audit = new AuditService({ prisma });
const reports = new ReportService({ prisma, driver: muleDriver, audit });
const sahyog = createSahyogAdapter(env);
const ncrpNotice = createNcrpNoticeAdapter(env);
const freezeNotices = new FreezeNoticeService({ prisma, audit, sahyog });
const integrations = { sahyog, ncrpNotice };

const server = createApp(deps, { intake, mule, risk, watchlist, alerts, reports, freezeNotices, integrations }).listen(env.API_PORT, () => {
  console.log(`api listening on :${env.API_PORT} (DATA_MODE=${env.DATA_MODE})`);
  poller.start();
});
const trace = attachTraceSocket(server, env.REDIS_URL);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    poller.stop();
    server.close(() => void Promise.all([close(), queue.close(), prisma.$disconnect(), muleDriver.close(), trace.close()]).then(() => process.exit(0)));
  });
}
