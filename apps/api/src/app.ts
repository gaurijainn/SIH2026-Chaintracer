import express from 'express';
import helmet from 'helmet';
import { createAlertRouter, alertErrorHandler } from './alerts/routes';
import { apiRateLimiter, authRateLimiter, corsAllowlist, httpErrorHandler, notFound, type AppSecurity } from './auth/http';
import { authenticate } from './auth/middleware';
import { createAuthRouter } from './auth/routes';
import { createDashboardRouter } from './dashboard/routes';
import type { DashboardService } from './dashboard/service';
import { caseErrorHandler, createCaseRouter } from './cases/routes';
import type { CaseService } from './cases/service';
import { createGraphRouter, graphErrorHandler } from './graph/routes';
import type { TraceGraphService } from './graph/service';
import { createLabelRouter, labelErrorHandler } from './labels/routes';
import type { LabelAdminService } from './labels/service';
import { createVaspRouter } from './vasps/routes';
import type { VaspService } from './vasps/service';
import type { AlertService } from './alerts/service';
import { createFreezeNoticeRouter, freezeNoticeErrorHandler } from './freeze-notices/routes';
import type { FreezeNoticeService } from './freeze-notices/service';
import { runHealth, type HealthDeps } from './health';
import { createIntegrationsRouter, integrationsErrorHandler, type IntegrationServices } from './integrations/routes';
import { createIntakeRouter, intakeErrorHandler } from './intake/routes';
import type { IntakeService } from './intake/service';
import { createMuleRouter, muleErrorHandler } from './mule/routes';
import type { MuleService } from './mule/service';
import { createReportRouter, createVerifyRouter, reportErrorHandler } from './reports/routes';
import type { ReportService } from './reports/service';
import { createRiskRouter, riskErrorHandler } from './risk/routes';
import type { RiskService } from './risk/service';
import { createWatchlistRouter, watchlistErrorHandler } from './watchlist/routes';
import type { WatchlistService } from './watchlist/service';

export interface AppServices {
  intake?: IntakeService;
  mule?: MuleService;
  risk?: RiskService;
  watchlist?: WatchlistService;
  alerts?: AlertService;
  reports?: ReportService;
  freezeNotices?: FreezeNoticeService;
  integrations?: IntegrationServices;
  cases?: CaseService;
  traceGraph?: TraceGraphService;
  labels?: LabelAdminService;
  vasps?: VaspService;
  dashboard?: DashboardService;
}

/**
 * B10: /api/v1 is fail-closed. Order matters -- helmet, CORS allowlist and the JSON body parser come first; the only
 * unauthenticated routes are /auth/* (tightly rate limited) and GET /verify/:hash; then every other /api/v1 route
 * sits behind `authenticate`, with per-route RBAC (`requirePermission`) inside each router.
 */
export function createApp(deps: HealthDeps, services: AppServices, security: AppSecurity) {
  const app = express();
  app.use(helmet());
  app.use(corsAllowlist(security.config.corsOrigins));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    const report = await runHealth(deps);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  app.use('/api/v1', apiRateLimiter(security.config.rateLimit));

  // public: sign in / rotate / sign out, and third-party report verification (QR target)
  app.use('/api/v1', createAuthRouter(security.auth, authRateLimiter(security.config.rateLimit)));
  if (services.reports) app.use('/api/v1', createVerifyRouter(services.reports));

  app.use('/api/v1', authenticate(security.tokens));
  if (services.intake) app.use('/api/v1', createIntakeRouter(services.intake));
  if (services.cases) app.use('/api/v1', createCaseRouter(services.cases));
  if (services.traceGraph) app.use('/api/v1', createGraphRouter(services.traceGraph));
  if (services.mule) app.use('/api/v1', createMuleRouter(services.mule));
  if (services.risk) app.use('/api/v1', createRiskRouter(services.risk));
  if (services.watchlist) app.use('/api/v1', createWatchlistRouter(services.watchlist));
  if (services.alerts) app.use('/api/v1', createAlertRouter(services.alerts));
  if (services.reports) app.use('/api/v1', createReportRouter(services.reports));
  if (services.freezeNotices) app.use('/api/v1', createFreezeNoticeRouter(services.freezeNotices));
  if (services.integrations) app.use('/api/v1', createIntegrationsRouter(services.integrations));
  if (services.labels) app.use('/api/v1', createLabelRouter(services.labels));
  if (services.vasps) app.use('/api/v1', createVaspRouter(services.vasps));
  if (services.dashboard) app.use('/api/v1', createDashboardRouter(services.dashboard));
  app.use('/api/v1', notFound);
  // httpErrorHandler (auth + body-parser errors) is first so 401/403/413 never fall through to a module's generic 500.
  app.use(httpErrorHandler);
  // watchlistErrorHandler/alertErrorHandler/reportErrorHandler/freezeNoticeErrorHandler/
  // integrationsErrorHandler recognise their own error types and call next(err) for anything else, so
  // they must run BEFORE riskErrorHandler: riskErrorHandler (like intake/mule below it) handles *any*
  // unmatched error unconditionally (never calls next() for one it doesn't recognize), so registered
  // first it would swallow a B8/B9-specific error as a generic 500 before those handlers ever saw it.
  app.use(caseErrorHandler);
  app.use(graphErrorHandler);
  app.use(labelErrorHandler);
  app.use(watchlistErrorHandler);
  app.use(alertErrorHandler);
  app.use(reportErrorHandler);
  app.use(freezeNoticeErrorHandler);
  app.use(integrationsErrorHandler);
  app.use(riskErrorHandler);
  app.use(intakeErrorHandler);
  app.use(muleErrorHandler);

  return app;
}
