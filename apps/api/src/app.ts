import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { runHealth, type HealthDeps } from './health';

export function createApp(deps: HealthDeps) {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    const report = await runHealth(deps);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  return app;
}
