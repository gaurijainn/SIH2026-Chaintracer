import { RedisCache, createChainLayer } from '@ps26183/workers/adapters';
import { loadEnv } from '@ps26183/shared';
import { AlertService } from './alerts/service';
import { Redis } from 'ioredis';
import { createApp } from './app';
import { AuditService } from './audit/service';
import { loadSecurityConfig } from './auth/config';
import { PiiCipher } from './auth/pii';
import { RedisRefreshStore } from './auth/refreshStore';
import { AuthService } from './auth/service';
import { TokenService } from './auth/tokens';
import { CaseService } from './cases/service';
import { TraceGraphService } from './graph/service';
import { LabelAdminService } from './labels/service';
import { VaspService } from './vasps/service';
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
import { DashboardService } from './dashboard/service';
import { attachTraceSocket } from './realtime/socket';
import { ReportService } from './reports/service';
import { HttpMlClient } from './risk/mlClient';
import { RiskService } from './risk/service';
import { WatchlistService } from './watchlist/service';

const env = loadEnv();
const securityConfig = loadSecurityConfig(env); // throws on placeholder/weak JWT_SECRET or PII_ENC_KEY
const pii = new PiiCipher(securityConfig.piiKey);
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
  pii,
});
const mule = new MuleService({ prisma, driver: muleDriver });
const mlClient = new HttpMlClient(env.ML_URL);
const risk = new RiskService({ prisma, mlClient });
const watchlist = new WatchlistService({ prisma });
const alerts = new AlertService({ prisma });
const poller = new NcrpPoller(createHttpNcrpFeed(env), intake, env.NCRP_POLL_INTERVAL_S * 1000);

// B9: evidence reports, freeze-notice workflow, and outbound SAHYOG/NCRP-notice adapters.
const audit = new AuditService({ prisma });
const reports = new ReportService({ prisma, driver: muleDriver, audit, pii });
const sahyog = createSahyogAdapter(env);
const ncrpNotice = createNcrpNoticeAdapter(env);
const freezeNotices = new FreezeNoticeService({ prisma, audit, sahyog });
const integrations = { sahyog, ncrpNotice };

// B10: auth (refresh-token state in Redis), audited case view / labels / VASP registry, trace graph.
const authRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
authRedis.on('error', () => undefined);
const tokens = new TokenService({ secret: securityConfig.jwtSecret, accessTtlS: securityConfig.accessTtlS, refreshTtlS: securityConfig.refreshTtlS });
const auth = new AuthService({ prisma, tokens, store: new RedisRefreshStore(authRedis), audit });
const security = { config: securityConfig, tokens, auth };
const cases = new CaseService({ prisma, audit, pii });
const traceGraph = new TraceGraphService({ prisma });
const labels = new LabelAdminService({ prisma, audit });
const vasps = new VaspService({ prisma, audit });
const dashboard = new DashboardService({ prisma });

const server = createApp(deps, { intake, mule, risk, watchlist, alerts, reports, freezeNotices, integrations, cases, traceGraph, labels, vasps, dashboard }, security).listen(env.API_PORT, () => {
  console.log(`api listening on :${env.API_PORT} (DATA_MODE=${env.DATA_MODE})`);
  poller.start();
});
const trace = attachTraceSocket(server, env.REDIS_URL);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    poller.stop();
    server.close(() => void Promise.all([close(), queue.close(), prisma.$disconnect(), muleDriver.close(), authRedis.quit(), trace.close()]).then(() => process.exit(0)));
  });
}
