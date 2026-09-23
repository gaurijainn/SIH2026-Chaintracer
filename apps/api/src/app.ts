import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createAlertRouter, alertErrorHandler } from './alerts/routes';
import type { AlertService } from './alerts/service';
import { createFreezeNoticeRouter, freezeNoticeErrorHandler } from './freeze-notices/routes';
import type { FreezeNoticeService } from './freeze-notices/service';
import { runHealth, type HealthDeps } from './health';
import { createIntegrationsRouter, integrationsErrorHandler, type IntegrationServices } from './integrations/routes';
import { createIntakeRouter, intakeErrorHandler } from './intake/routes';
import type { IntakeService } from './intake/service';
import { createMuleRouter, muleErrorHandler } from './mule/routes';
import type { MuleService } from './mule/service';
import { createReportRouter, reportErrorHandler } from './reports/routes';
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
}

export function createApp(deps: HealthDeps, services: AppServices = {}) {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    const report = await runHealth(deps);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  // /api/v1 routes (JWT + RBAC land in B10)
  if (services.intake) app.use('/api/v1', createIntakeRouter(services.intake));
  if (services.mule) app.use('/api/v1', createMuleRouter(services.mule));
  if (services.risk) app.use('/api/v1', createRiskRouter(services.risk));
  if (services.watchlist) app.use('/api/v1', createWatchlistRouter(services.watchlist));
  if (services.alerts) app.use('/api/v1', createAlertRouter(services.alerts));
  if (services.reports) app.use('/api/v1', createReportRouter(services.reports));
  if (services.freezeNotices) app.use('/api/v1', createFreezeNoticeRouter(services.freezeNotices));
  if (services.integrations) app.use('/api/v1', createIntegrationsRouter(services.integrations));
  // watchlistErrorHandler/alertErrorHandler/reportErrorHandler/freezeNoticeErrorHandler/
  // integrationsErrorHandler recognise their own error types and call next(err) for anything else, so
  // they must run BEFORE riskErrorHandler: riskErrorHandler (like intake/mule below it) handles *any*
  // unmatched error unconditionally (never calls next() for one it doesn't recognize), so registered
  // first it would swallow a B8/B9-specific error as a generic 500 before those handlers ever saw it.
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
