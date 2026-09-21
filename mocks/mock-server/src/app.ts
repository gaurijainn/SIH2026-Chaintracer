import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FeedData {
  records: Record<string, unknown>[];
}

export const DEFAULT_DATA = fileURLToPath(new URL('../data/complaints.json', import.meta.url));

/** Mock NCRP/CFCFRMS complaint feed, implementing mocks/openapi/ncrp.yaml. Read-only and deterministic. */
export function createMockNcrp(data: FeedData = JSON.parse(readFileSync(DEFAULT_DATA, 'utf8'))) {
  const app = express();

  app.get('/health', (_req, res) => void res.json({ status: 'ok', service: 'mock-ncrp', records: data.records.length }));

  app.get('/ncrp/v1/complaints', (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1) | 0);
    const perPage = Math.min(500, Math.max(1, Number(req.query.perPage ?? 100) | 0));
    const items = data.records.slice((page - 1) * perPage, page * perPage);
    res.json({ page, perPage, total: data.records.length, hasMore: page * perPage < data.records.length, items });
  });

  return app;
}
