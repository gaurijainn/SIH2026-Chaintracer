import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createAlertRouter, alertErrorHandler } from './alerts/routes';
import type { AlertService } from './alerts/service';
import { runHealth, type HealthDeps } from './health';
import { createIntakeRouter, intakeErrorHandler } from './intake/routes';
import type { IntakeService } from './intake/service';
import { createMuleRouter, muleErrorHandler } from './mule/routes';
import type { MuleService } from './mule/service';
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
  // watchlistErrorHandler/alertErrorHandler recognise their own error types and call next(err) for
  // anything else, so they must run BEFORE riskErrorHandler: riskErrorHandler (like intake/mule below
  // it) handles *any* unmatched error unconditionally (never calls next() for one it doesn't
  // recognize), so registered first it would swallow a B8-specific error as a generic 500 before
  // watchlistErrorHandler/alertErrorHandler ever saw it.
  app.use(watchlistErrorHandler);
  app.use(alertErrorHandler);
  app.use(riskErrorHandler);
  app.use(intakeErrorHandler);
  app.use(muleErrorHandler);

  return app;
}
