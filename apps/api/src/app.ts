import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { runHealth, type HealthDeps } from './health';
import { createIntakeRouter, intakeErrorHandler } from './intake/routes';
import type { IntakeService } from './intake/service';
import { createMuleRouter, muleErrorHandler } from './mule/routes';
import type { MuleService } from './mule/service';
import { createRiskRouter, riskErrorHandler } from './risk/routes';
import type { RiskService } from './risk/service';

export interface AppServices {
  intake?: IntakeService;
  mule?: MuleService;
  risk?: RiskService;
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
  // riskErrorHandler must run before intake/muleErrorHandler: those two handle *any* unmatched
  // error unconditionally (never call next() for an error they don't recognize), so registered
  // after them a risk-specific error would always be swallowed as a generic 500 first.
  app.use(riskErrorHandler);
  app.use(intakeErrorHandler);
  app.use(muleErrorHandler);

  return app;
}
