import { createHash } from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FeedData {
  records: Record<string, unknown>[];
}

export const DEFAULT_DATA = fileURLToPath(new URL('../data/complaints.json', import.meta.url));

/**
 * Mock NCRP/CFCFRMS complaint feed, implementing mocks/openapi/ncrp.yaml, plus (B9) the outbound
 * notice/sync endpoint from mocks/openapi/ncrp-notice.yaml -- a different concern (push vs poll)
 * served from the same mock process since NCRP has no public API either way. Read-only/deterministic
 * for the original feed routes; unchanged from before B9.
 */
export function createMockNcrp(data: FeedData = JSON.parse(readFileSync(DEFAULT_DATA, 'utf8'))) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => void res.json({ status: 'ok', service: 'mock-ncrp', records: data.records.length }));

  app.get('/ncrp/v1/complaints', (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1) | 0);
    const perPage = Math.min(500, Math.max(1, Number(req.query.perPage ?? 100) | 0));
    const items = data.records.slice((page - 1) * perPage, page * perPage);
    res.json({ page, perPage, total: data.records.length, hasMore: page * perPage < data.records.length, items });
  });

  // B9: outbound sync, mocks/openapi/ncrp-notice.yaml.
  app.post('/ncrp/v1/notices/sync', (req, res) => {
    const notice = req.body?.notice;
    if (!notice || typeof notice !== 'object') {
      res.status(400).json({ error: 'INVALID_BODY', message: 'body.notice is required' });
      return;
    }
    const sim = (notice as Record<string, unknown>).__simulate;
    if (sim === 'server_error') {
      res.status(500).json({ error: 'INTERNAL', message: 'simulated server error' });
      return;
    }
    if (sim === 'timeout') {
      // Never responds within any reasonable client timeout -- deliberately not cleaned up; the
      // process-level server teardown in tests kills the socket regardless.
      return;
    }
    res.status(201).json({ syncId: deterministicId(notice as Record<string, unknown>) });
  });

  return app;
}

/** Deterministic id = sha1 of the canonical JSON.stringify of the payload (stable key order not required here: callers send the same object shape every time within one test). */
function deterministicId(payload: Record<string, unknown>): string {
  const { __simulate, ...rest } = payload;
  void __simulate;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

/**
 * Mock SAHYOG freeze-notice submission server, implementing mocks/openapi/sahyog.yaml. `submissionId`
 * is a deterministic hash of the submitted notice, so resubmitting the exact same notice body (e.g.
 * FreezeNoticeService.send's idempotent-resubmission path) yields the same id rather than a fresh one.
 * A notice body may set `__simulate: 'server_error' | 'timeout'` to exercise adapter error handling
 * in tests -- never sent by real callers.
 */
export function createMockSahyog() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => void res.json({ status: 'ok', service: 'mock-sahyog' }));

  app.post('/sahyog/v1/submissions', (req, res) => {
    const notice = req.body?.notice;
    if (!notice || typeof notice !== 'object') {
      res.status(400).json({ error: 'INVALID_BODY', message: 'body.notice is required' });
      return;
    }
    const sim = (notice as Record<string, unknown>).__simulate;
    if (sim === 'server_error') {
      res.status(500).json({ error: 'INTERNAL', message: 'simulated server error' });
      return;
    }
    if (sim === 'timeout') {
      return;
    }
    res.status(201).json({ submissionId: deterministicId(notice as Record<string, unknown>) });
  });

  return app;
}
