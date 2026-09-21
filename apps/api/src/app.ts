import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { runHealth, type HealthDeps } from './health';
import { createIntakeRouter, intakeErrorHandler } from './intake/routes';
import type { IntakeService } from './intake/service';

export interface AppServices {
  intake?: IntakeService;
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
  app.use(intakeErrorHandler);

  return app;
}
